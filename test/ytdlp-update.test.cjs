const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

// The refresh is run in a child process with its own NR_HOME: `core/config` resolves the writable
// home once, at require time, and the marker this module writes must land in a throwaway file
// rather than in the home of the application installed on the machine running the tests.
function runScenario(script, config = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'netsurush-ytdlp-test-'));
  fs.writeFileSync(path.join(home, 'nr.config.json'), JSON.stringify({ python: path.join(home, 'python.exe'), ...config }));
  try {
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: root,
      env: { ...process.env, NR_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    return {
      result: JSON.parse(run.stdout.trim().split(/\r?\n/).pop() || '{}'),
      saved: JSON.parse(fs.readFileSync(path.join(home, 'nr.config.json'), 'utf8')),
    };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// `execFile` is destructured when core/ytdlpUpdate loads, so the stub has to be installed before
// the require — which is also the only way to keep this suite off the network and off pip.
const STUB = (body) => `
  const cp = require('node:child_process');
  const calls = [];
  cp.execFile = ${body};
  const { refreshYtDlpForAppVersion } = require('./core/ytdlpUpdate');
  (async () => {
    const first = await refreshYtDlpForAppVersion();
    const second = await refreshYtDlpForAppVersion();
    console.log(JSON.stringify({ first, second, calls }));
  })();
`;

const SUCCESS = STUB(`(bin, args, opts, cb) => { calls.push({ bin, args }); cb(null, 'Successfully installed yt-dlp-2026.7.4', ''); }`);
const FAILURE = STUB(`(bin, args, opts, cb) => { calls.push({ bin, args }); cb(new Error('getaddrinfo ENOTFOUND pypi.org'), '', ''); }`);

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// yt-dlp is the one runtime dependency that rots: its extractors are broken by the platforms every
// few weeks, and the pin in requirements-reference.txt froze the venv on the day of the install.
test('a new application version upgrades yt-dlp exactly once', () => {
  const { result, saved } = runScenario(SUCCESS);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(result.calls[0].args, ['-m', 'pip', 'install', '--upgrade', 'yt-dlp[default,curl-cffi]']);
  assert.match(result.calls[0].bin, /python(\.exe)?$/i);
  assert.equal(result.first.updated, true);
  // Second call, same version: the marker short-circuits it, so a plain restart costs nothing.
  assert.equal(result.second.updated, false);
  assert.equal(saved.ytDlpCheckedFor, version);
});

// Being offline the day the application updates must not consume the one refresh that version gets.
test('a failed upgrade leaves the marker unwritten so the next boot retries', () => {
  const { result, saved } = runScenario(FAILURE);
  assert.equal(result.first.updated, false);
  assert.equal(saved.ytDlpCheckedFor, undefined);
  assert.equal(result.calls.length, 2);
});

// Already checked for this version: no spawn at all, including the very first boot of the session.
test('a boot of an already-checked version never launches pip', () => {
  const { result } = runScenario(SUCCESS, { ytDlpCheckedFor: version });
  assert.deepEqual(result.calls, []);
  assert.equal(result.first.updated, false);
});
