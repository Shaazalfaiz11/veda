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

run('worker', 'node', ['--import', 'tsx', 'workers/assessment.worker.ts']);
run('web', 'node', ['node_modules/next/dist/bin/next', 'start']);
