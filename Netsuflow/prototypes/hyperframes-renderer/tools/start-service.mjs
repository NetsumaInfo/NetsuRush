// Starts the renderer service detached from the shell that launched it, then
// exits.
//
// `detached` here is about lifetime, not windows: without it libuv leaves the
// service in the launching shell's process group and it dies with that shell —
// measured, the service was gone before its first log line. Windows are the
// browser binary's business, and that is settled in server.mjs by launching the
// GUI-subsystem chrome.exe instead of the console-subsystem
// chrome-headless-shell.exe.
//
// Output goes to a log file, which is where anyone diagnosing this would look.
//
//   node tools/start-service.mjs [--log <path>] [...service arguments]

import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

function readArg(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  return args[index + 1];
}

const logPath = resolve(
  readArg('--log', join(process.env.LOCALAPPDATA ?? HERE, 'NetsuRush', 'netsuflow', 'service.log')),
);
mkdirSync(dirname(logPath), { recursive: true });
const log = openSync(logPath, 'a');

// Everything except this launcher's own --log pair is forwarded verbatim.
const forwarded = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--log') {
    i += 1;
    continue;
  }
  forwarded.push(args[i]);
}

const child = spawn(process.execPath, [join(HERE, 'server.mjs'), ...forwarded], {
  cwd: HERE,
  detached: true,
  windowsHide: true,
  stdio: ['ignore', log, log],
});
child.unref();

const pidPath = join(dirname(logPath), 'service.pid');
try {
  writeFileSync(pidPath, String(child.pid));
} catch {
  // A convenience for whoever has to kill this later, not a startup condition.
}

process.stdout.write(`service pid ${child.pid}, log ${logPath}\n`);
