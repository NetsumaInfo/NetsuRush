// Measures whether the engine's own createFileServer meets NetsuFlow's trust
// boundary: loopback-only bind, and no escape from the served root.
// Defensive evaluation of a dependency we are considering adopting.
import { createFileServer } from '@hyperframes/engine';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'nf-probe-'));
const projectDir = join(root, 'project');
mkdirSync(projectDir);
writeFileSync(join(projectDir, 'index.html'), '<html><body>inside</body></html>');
// A file that lives OUTSIDE the served root. Nothing should ever return it.
writeFileSync(join(root, 'SECRET.txt'), 'ESCAPED-THE-ROOT');

const server = await createFileServer({ projectDir });
console.log('url:', server.url, 'port:', server.port);

// What address did it actually bind?
const { execSync } = await import('node:child_process');
try {
  const out = execSync(`netstat -ano -p TCP | findstr :${server.port}`, { encoding: 'utf8' });
  console.log('listening sockets:');
  for (const line of out.trim().split(/\r?\n/)) console.log('  ' + line.trim());
} catch {
  console.log('listening sockets: (netstat query failed)');
}

const attempts = [
  ['/', 'baseline, should serve index.html'],
  ['/index.html', 'baseline'],
  ['/../SECRET.txt', 'literal dot-dot'],
  ['/..%2fSECRET.txt', 'encoded slash'],
  ['/%2e%2e/SECRET.txt', 'encoded dots'],
  ['/....//SECRET.txt', 'doubled dots'],
  ['/..\\SECRET.txt', 'windows separator'],
  ['/%2e%2e%5cSECRET.txt', 'encoded windows separator'],
];

for (const [path, label] of attempts) {
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
    const body = await res.text();
    const escaped = body.includes('ESCAPED-THE-ROOT');
    console.log(
      `${escaped ? 'ESCAPE' : 'ok    '}  ${res.status}  ${path}  (${label})` +
        (escaped ? '  <-- served a file outside the root' : ''),
    );
  } catch (err) {
    console.log(`err     ${path}  ${err.message}`);
  }
}

// Can something that is not loopback reach it? Ask the OS for a non-loopback
// address of this machine and try that.
const { networkInterfaces } = await import('node:os');
const external = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal);
if (external) {
  try {
    const res = await fetch(`http://${external.address}:${server.port}/index.html`, {
      signal: AbortSignal.timeout(3000),
    });
    console.log(`non-loopback ${external.address}: reachable, status ${res.status}  <-- bound beyond loopback`);
  } catch (err) {
    console.log(`non-loopback ${external.address}: refused (${err.message})`);
  }
} else {
  console.log('non-loopback: no external IPv4 interface to test');
}

server.close();
