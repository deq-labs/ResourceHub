// Free-tier entrypoint: runs the API and the worker in ONE container, because free hosts
// (Render's free web service) don't offer background workers. Azure runs them as two apps.
//
// - Forwards SIGTERM/SIGINT to both, so each drains (the worker finishes its jobs).
// - If either process exits, stops the other and exits non-zero, so the host restarts us.
import { spawn } from 'node:child_process';

const heap = process.env.CHILD_MAX_OLD_SPACE_MB ?? '200'; // two processes share 512 MB on the free plan
const services = [
  { name: 'api', cwd: '/app/api' },
  { name: 'worker', cwd: '/app/worker' },
];

let stopping = false;
const children = services.map(({ name, cwd }) => {
  const child = spawn(
    process.execPath,
    [
      `--max-old-space-size=${heap}`,
      '--enable-source-maps',
      '--import',
      './dist/instrumentation.js',
      'dist/main.js',
    ],
    { cwd, stdio: 'inherit', env: process.env },
  );
  child.on('exit', (code, signal) => {
    console.log(
      JSON.stringify({ level: 'info', svc: 'start', msg: `${name} exited`, code, signal }),
    );
    if (!stopping) shutdown('SIGTERM', 1);
  });
  return child;
});

function shutdown(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill(signal);
  // Give both a chance to drain, then leave regardless.
  setTimeout(() => process.exit(exitCode), 25_000).unref();
  Promise.all(
    children.map((c) => (c.exitCode === null ? new Promise((r) => c.on('exit', r)) : null)),
  ).then(() => process.exit(exitCode));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
