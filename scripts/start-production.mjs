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
 * Heap ceilings: off unless asked for.
 *
 * The theory was that V8 sizes its default from the host's memory rather than
 * the cgroup — it reports a ~2GB ceiling on this 512MB instance — and so felt
 * no pressure to collect until the container was already thrashing. Bounding
 * it looked free.
 *
 * It was not. A 192MB worker ceiling turned a survivable stall into a fatal
 * one: preparation alone wants more heap than that, and V8 spent 79% of its
 * time collecting (average mu 0.213) before aborting outright with SIGABRT.
 * Because the two halves are wired to die together, that took the web server
 * with it, and the restart wiped the ephemeral disk holding the uploads the
 * requeued job then could not find.
 *
 * A hard exit is worse than slow GC. The default stands unless a measurement
 * justifies a number, and the levers stay here for when one does.
 */
const heapFlags = (mb) => (mb ? [`--max-old-space-size=${mb}`] : []);

run('worker', 'node', [
  ...heapFlags(process.env.WORKER_HEAP_MB),
  '--import',
  'tsx',
  'workers/assessment.worker.ts',
]);
run('web', 'node', [
  ...heapFlags(process.env.WEB_HEAP_MB),
  'node_modules/next/dist/bin/next',
  'start',
]);
