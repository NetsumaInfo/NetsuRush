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

// The per-release anchor has one hole: an installation nobody updates for months stops refreshing
// the very thing that rots fastest. Settings › Updates reads the version and upgrades on demand.
const MANUAL = `
  const cp = require('node:child_process');
  const calls = [];
  let upgraded = false;
  cp.execFile = (bin, args, opts, cb) => {
    calls.push({ bin, args });
    if (args.includes('--version')) return cb(null, upgraded ? '2026.09.02' : '2026.01.01', '');
    upgraded = true;
    cb(null, 'Successfully installed yt-dlp-2026.09.02', '');
  };
  const { ytDlpStatus, updateYtDlpNow } = require('./core/ytdlpUpdate');
  (async () => {
    const status = await ytDlpStatus({ remote: false });
    const update = await updateYtDlpNow();
    console.log(JSON.stringify({ status, update, calls }));
  })();
`;

test('the panel reads the installed version without touching the network', () => {
  const { result } = runScenario(MANUAL, { ytDlpCheckedFor: version });
  assert.equal(result.status.available, true);
  assert.equal(result.status.version, '2026.01.01');
  assert.equal(result.status.manager, 'pip');
  assert.equal(result.status.owned, true);
  // `remote: false` skips the PyPI probe, so nothing can be claimed about being outdated.
  assert.equal(result.status.latest, null);
  assert.equal(result.status.outdated, false);
});

// The whole point of the manual door: the marker of the current release must NOT skip it.
test('a manual update ignores the per-release marker and reports what changed', () => {
  const { result, saved } = runScenario(MANUAL, { ytDlpCheckedFor: version });
  assert.equal(result.update.ok, true);
  assert.equal(result.update.previous, '2026.01.01');
  assert.equal(result.update.version, '2026.09.02');
  assert.equal(result.update.changed, true);
  const upgrades = result.calls.filter((c) => c.args.includes('--upgrade'));
  assert.equal(upgrades.length, 1);
  assert.deepEqual(upgrades[0].args, ['-m', 'pip', 'install', '--upgrade', 'yt-dlp[default,curl-cffi]']);
  // An upgrade that just ran satisfies this release too: the next boot must not redo it.
  assert.equal(saved.ytDlpCheckedFor, version);
  assert.equal(typeof saved.ytDlpCheckedAt, 'number');
});

// PyPI normalises a date version to 2026.8.19 while yt-dlp prints 2026.08.19. The panel compared the
// raw strings and announced "2026.8.19 disponible" against the build already installed.
const SPELLING = `
  const cp = require('node:child_process');
  cp.execFile = (bin, args, opts, cb) => cb(null, '2026.8.19', '');
  const { ytDlpStatus } = require('./core/ytdlpUpdate');
  ytDlpStatus({ remote: false }).then((status) => console.log(JSON.stringify({ status })));
`;

test('a date version is canonicalised, whatever spelling it arrives in', () => {
  const { result } = runScenario(SPELLING);
  assert.equal(result.status.version, '2026.08.19');
});

// A nightly carries a fourth timestamp segment and is NEWER than the latest stable. Comparing by
// inequality read that as "an update is available" and offered to downgrade the tool.
test('the version order, not a string inequality, decides what is outdated', () => {
  const { isOlder } = require(path.join(root, 'core', 'ytdlpUpdate.js'));
  assert.equal(isOlder('2026.08.30.232658', '2026.08.19'), false); // nightly ahead of stable
  assert.equal(isOlder('2026.08.19', '2026.08.30.232658'), true);
  assert.equal(isOlder('2026.08.19', '2026.08.19'), false);
  assert.equal(isOlder('2026.08.19', '2026.09.02'), true);
  assert.equal(isOlder('2026.09.02', '2026.08.19'), false);
  // Same release, two spellings: canonicalised on the way in, and equal either way here.
  assert.equal(isOlder('2026.08.19', '2026.8.19'), false);
  // A version this cannot read never produces a claim.
  assert.equal(isOlder('nightly', '2026.08.19'), false);
});
