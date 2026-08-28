/**
 * Production entrypoint: the web server and the queue worker, in one process
 * tree.
 *
 * They are separate concerns and would normally be separate services, but they
 * share one thing that decides the topology — the prepared page bitmaps. The
 * worker writes them during PREPARING and the web server reads them back to
 * serve `/documents/:id/pages/:n`, which is what the highlight overlay is drawn
 * on top of. Split across two containers, each gets its own disk and every page
 * image 404s.
 *
 * Object storage would let them separate again. Until that exists, one
 * container with one volume is the honest arrangement, and this is what starts
 * both halves of it.
 *
 * If either half exits, so does the other: a web server with no worker accepts
 * uploads it will never process, and a worker with no web server has nobody to
 * accept them. Failing together is what makes the platform's restart correct.
 *
 *   npm run start:all
 */
import { spawn } from 'node:child_process';

const children = [];
let shuttingDown = false;

function run(name, command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    console.error(`[start-production] ${name} exited (code=${code}, signal=${signal ?? 'none'})`);
    stop(code ?? 1);
  });

  child.on('error', (error) => {
    console.error(`[start-production] ${name} failed to start:`, error.message);
    stop(1);
  });

  children.push({ name, child });
  return child;
}

function stop(code) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  // Give each side a moment to close its Redis connection and finish the job
  // it holds, rather than dropping it back onto the queue as stalled.
  setTimeout(() => process.exit(code), 5_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(0));
}

/*
 * Heap ceilings, because V8 will not infer them.
 *
 * `--max-old-space-size` defaults to a figure derived from the *host's*
 * memory, not the container's cgroup limit — on this 512MB instance V8 reports
 * a ~2GB ceiling and therefore feels no pressure to collect until long after
 * the cgroup has started thrashing. Measured, that is exactly what happened:
 * resident memory climbed to 534MB during answer extraction and stayed pinned
 * there, the event loop stalled, and the queue declared the job lost.
 *
 * Giving each half an explicit ceiling makes V8 collect while there is still
 * room to. These are guards, not targets: a ceiling only does work as the heap
 * approaches it, so if the real cost turns out to be native rather than heap
 * these numbers will change nothing and the per-chunk loading is what earns
 * the saving. Buffers, libvips and onnxruntime all allocate outside this bound.
 *
 * The web server gets the larger share despite doing the lighter work. It is
 * the half a visitor talks to, and the two die together by design — so a hard
 * heap exit there takes the site down, while the worker's would only lose the
 * job it holds. The worker's own heap demand is modest anyway: base64 strings
 * and one request body. Its expensive tenants are native and unbounded by this.
 */
const workerHeapMb = process.env.WORKER_HEAP_MB ?? '192';
const webHeapMb = process.env.WEB_HEAP_MB ?? '160';

run('worker', 'node', [
  `--max-old-space-size=${workerHeapMb}`,
  '--import',
  'tsx',
  'workers/assessment.worker.ts',
]);
run('web', 'node', [
  `--max-old-space-size=${webHeapMb}`,
  'node_modules/next/dist/bin/next',
  'start',
]);
