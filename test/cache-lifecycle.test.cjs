const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');

function runIsolated(source) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-cache-life-'));
  const temp = path.join(sandbox, 'temp');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      TEMP: temp,
      TMP: temp,
      NR_HOME: home,
    },
  });
  fs.rmSync(sandbox, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('session cache removes legacy data at boot and all current work at shutdown', () => {
  const output = runIsolated(String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const config = require('./core/config');
    const session = require('./core/sessionCache');
    const legacy = path.join(config.NR_HOME, 'roto-cache');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'old-mask.png'), 'legacy');
    session.resetSync();
    if (fs.existsSync(legacy)) throw new Error('legacy roto cache survived boot');
    for (const dir of session.SESSION_DIRS) fs.writeFileSync(path.join(dir, 'work.bin'), 'session');
    session.cleanup().then(() => {
      if (fs.existsSync(config.SESSION_CACHE_ROOT)) throw new Error('session root survived shutdown');
      process.stdout.write('ok');
    });
  `);
  assert.equal(output, 'ok');
});

test('default policy bounds quick previews but preserves expensive analysis caches', () => {
  const output = runIsolated(String.raw`
    const { defaults } = require('./core/cachePolicy');
    const value = defaults();
    if (!value.kinds.thumb.auto || value.kinds.thumb.maxGb !== 4 || value.kinds.thumb.maxDays !== 30) process.exit(2);
    if (!value.kinds.proxy.auto || value.kinds.proxy.maxGb !== 8 || value.kinds.proxy.maxDays !== 7) process.exit(3);
    for (const kind of ['voice', 'upscaleTest', 'roto']) if (!value.kinds[kind].auto) process.exit(4);
    for (const kind of ['scenes', 'transcripts', 'embeddings']) if (value.kinds[kind].auto) process.exit(5);
    if (value.session.roto !== 'operation' || value.session.upscaleTest !== 'operation' || value.session.voice !== 'page') process.exit(6);
    process.stdout.write(String(value.policyVersion));
  `);
  assert.equal(output, '3');
});

test('Tauri requests cooperative core shutdown before the force-kill fallback', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(source, /stdin\.write_all\(b"shutdown\\n"\)/);
  assert.match(source, /stdin\(Stdio::piped\(\)\)/);
  assert.match(source, /remove_dir_all\(std::env::temp_dir\(\)\.join\("netsurush-session"\)\)/);
});

test('core shutdown command removes its live session workspace', { timeout: 20_000 }, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-core-shutdown-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const temp = path.join(sandbox, 'temp');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.equal(typeof address, 'object');
  const port = address.port;
  probe.close();
  await once(probe, 'close');

  const child = require('node:child_process').spawn(process.execPath, ['core/server.js'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEMP: temp, TMP: temp, NR_HOME: home, NR_CORE_PORT: String(port) },
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`core startup timeout: ${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!output.includes('NetsuRush core:')) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (!output.includes('NetsuRush core:')) reject(new Error(`core exited ${code}: ${output}`));
    });
  });

  await ready;
  const sessionRoot = path.join(temp, 'netsurush-session');
  const rpc = async (channel, args = []) => {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    const envelope = await response.json();
    assert.equal(envelope.ok, true, JSON.stringify(envelope));
    return envelope.result;
  };
  const voiceFile = path.join(sessionRoot, 'voice', 'analysis.wav');
  const rotoDir = path.join(sessionRoot, 'roto', 'active-shot');
  fs.mkdirSync(rotoDir, { recursive: true });
  fs.writeFileSync(voiceFile, 'voice');
  fs.writeFileSync(path.join(rotoDir, 'mask.png'), 'roto');
  await rpc('cache:setSettings', [{ session: { voice: 'page', roto: 'app' } }]);
  const cleaned = await rpc('cache:sessionEvent', [{ trigger: 'page', kinds: ['voice', 'roto'] }]);
  assert.equal(cleaned.ok, true);
  assert.equal(fs.existsSync(voiceFile), false, 'page policy did not remove extracted audio');
  assert.equal(fs.existsSync(rotoDir), true, 'app-only Roto cache was removed too early');

  await rpc('cache:setSettings', [{ session: { roto: 'operation' } }]);
  await rpc('cache:sessionEvent', [{ trigger: 'page', kinds: ['roto'] }]);
  assert.equal(fs.existsSync(rotoDir), false, 'an earlier operation policy did not use page exit as fallback');

  fs.writeFileSync(path.join(sessionRoot, 'processing-tests', 'live.bin'), 'session');
  child.stdin.write('shutdown\n');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  assert.equal(fs.existsSync(sessionRoot), false);
});

test('NetsuLab wires operation and page cleanup triggers without touching user exports', () => {
  const rpc = fs.readFileSync(path.join(ROOT, 'core', 'rpc.js'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'components', 'netsulab', 'NetsuLabPanel.tsx'), 'utf8');
  const voice = fs.readFileSync(path.join(ROOT, 'src', 'components', 'voice', 'VoicePanel.tsx'), 'utf8');
  assert.match(rpc, /const \{ model: _model, \.\.\.shared \} = opts \|\| \{\}/);
  assert.match(rpc, /lastTestFrameKey !== key/);
  assert.match(rpc, /await prepareTestFrame\(opts\)/);
  assert.match(rpc, /lastRotoSourceKey !== sourceKey/);
  assert.match(rpc, /sessionCleanup\('operation', \['roto'\]\)/);
  assert.match(panel, /sessionEvent\(\{ trigger: "page", kinds: \["roto"\] \}\)/);
  assert.match(panel, /sessionEvent\(\{ trigger: "page", kinds: \["upscaleTest"\] \}\)/);
  assert.match(voice, /sessionEvent\(\{ trigger: "page", kinds: \["voice"\] \}\)/);
});
