// Journal + rapport de bug : les deux endroits où une erreur de forme se paie par une perte
// d'information silencieuse (message tronqué, traceback éparpillée, rapport refusé par Discord).
const test = require('node:test');
const assert = require('node:assert');

const logbus = require('../core/logbus');
const { buildEmbed } = require('../core/bugreport');
const { formatBugContext } = require('../core/bugContext');

function reset() { logbus.clear(); }

test('logbus : un chunk coupé au milieu d’une ligne ne tronque pas le message', () => {
  reset();
  logbus.py('detect', 'ModuleNotFound');
  logbus.py('detect', 'Error: torch introuvable\n');
  const logs = logbus.snapshot();
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].message, 'ModuleNotFoundError: torch introuvable');
  assert.strictEqual(logs[0].level, 'error');
});

test('logbus : une traceback python fait UNE entrée, pas une par ligne', () => {
  reset();
  logbus.py('upscale', [
    'Traceback (most recent call last):',
    '  File "upscale.py", line 12, in run',
    '    model.load()',
    'RuntimeError: CUDA out of memory',
    '',
  ].join('\n'));
  logbus.pyFlush('upscale'); // la fermeture du bloc est différée d'une ligne (tracebacks chaînées)
  const logs = logbus.snapshot();
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].level, 'error');
  assert.match(logs[0].message, /^Traceback/);
  assert.match(logs[0].message, /CUDA out of memory$/);
});

test('logbus : une traceback chaînée reste dans le même bloc', () => {
  reset();
  logbus.py('roto', [
    'Traceback (most recent call last):',
    '  File "a.py", line 1, in <module>',
    'ValueError: première',
    '',
    'During handling of the above exception, another exception occurred:',
    '',
    'Traceback (most recent call last):',
    '  File "b.py", line 2, in <module>',
    'RuntimeError: seconde',
    '',
  ].join('\n'));
  logbus.pyFlush('roto');
  const logs = logbus.snapshot();
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0].message, /ValueError: première/);
  assert.match(logs[0].message, /RuntimeError: seconde/);
});

test('logbus : un fragment sans retour à la ligne finit par sortir', () => {
  reset();
  logbus.py('search', 'index prêt');
  assert.strictEqual(logbus.snapshot().length, 0, 'rien tant que la ligne est incomplète');
  logbus.pyFlush('search');
  assert.deepStrictEqual(logbus.snapshot().map((e) => e.message), ['index prêt']);
});

test('logbus : les répétitions consécutives comptent au lieu d’empiler', () => {
  reset();
  for (let i = 0; i < 40; i++) logbus.emit('core', 'error', 'proxy: échec de rendu');
  const logs = logbus.snapshot();
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0].repeat, 40);
});

test('logbus : niveau deviné — exceptions python en erreur, avertissements en warn', () => {
  assert.strictEqual(logbus.guessLevel('ModuleNotFoundError: no module named torch'), 'error');
  assert.strictEqual(logbus.guessLevel('RuntimeError: CUDA out of memory'), 'error');
  assert.strictEqual(logbus.guessLevel('ffmpeg exited with code 1'), 'error');
  assert.strictEqual(logbus.guessLevel('UserWarning: torchvision is deprecated'), 'warn');
  assert.strictEqual(logbus.guessLevel('index chargé en 2.1 s'), 'log');
});

test('logbus : les marqueurs de progression restent hors du journal', () => {
  reset();
  logbus.py('detect', 'PROGRESS:42\nSTAGE:infer\nmodèle chargé\n');
  assert.deepStrictEqual(logbus.snapshot().map((e) => e.message), ['modèle chargé']);
});

// --- Rapport Discord ---------------------------------------------------------------------------

const CONTEXT = {
  ok: true,
  app: { version: '3.1.2', lang: 'fr' },
  os: { label: 'Windows 11 (build 26200)', arch: 'x64' },
  cpu: { name: 'Ryzen 5600X', threads: 12 },
  memory: { totalMB: 32768, freeMB: 12000 },
  gpu: { label: 'RTX 3060', devices: [{ name: 'RTX 3060', vendor: 'nvidia', role: 'dgpu', driverVersion: '560.1' }], vram: null },
  runtime: { node: 'v22.0.0', python: 'python.exe', backends: { ml: 'cuda', onnx: 'cuda', transcribe: 'faster-whisper' }, ffmpeg: 'ffmpeg version 7.1' },
  encoding: { h264: 'h264_nvenc', h265: 'hevc_nvenc', av1: null, hardware: ['nvenc'] },
  storage: { home: 'C:/home', disk: { totalGB: 900, freeGB: 120 } },
  setup: { completedAt: null, modules: [], models: [], pythonFound: true, ffmpegFound: true },
};

function baseRequest(over = {}) {
  return {
    category: 'crash', categoryLabel: 'Plantage', severity: 'major', severityLabel: 'Majeur',
    frequency: 'always', frequencyLabel: 'À chaque fois', module: 'derush', moduleLabel: 'NetsuCut',
    issueText: 'L’app se ferme au lancement de la détection.',
    consoleLogCount: 12, errorCount: 3, warnCount: 1, redactionApplied: true,
    locale: 'fr', activeHost: 'resolve', hostConnected: true,
    ...over,
  };
}

test('embed : respecte les plafonds Discord même avec des textes démesurés', () => {
  const embed = buildEmbed(baseRequest({
    issueText: 'x'.repeat(10000),
    stepsText: 'y'.repeat(5000),
    expectedText: 'z'.repeat(5000),
  }), CONTEXT, 'NR-TEST');
  assert.ok(embed.description.length <= 3800, 'description tronquée');
  assert.ok(embed.fields.length <= 25);
  assert.ok(embed.title.length <= 256);
  for (const f of embed.fields) {
    assert.ok(f.value.length <= 1024, `champ ${f.name} trop long (${f.value.length})`);
    assert.ok(f.value.trim().length > 0, `champ ${f.name} vide`);
  }
});

test('embed : aucun champ vide quand le formulaire est minimal', () => {
  const embed = buildEmbed(
    { category: 'other', severity: 'minor', frequency: 'once', issueText: '', consoleLogCount: 0 },
    CONTEXT,
    'NR-MIN',
  );
  assert.strictEqual(embed.description, '(aucune description)');
  assert.ok(embed.fields.every((f) => f.value.trim().length > 0));
});

test('embed : la couleur suit la sévérité', () => {
  const blocker = buildEmbed(baseRequest({ severity: 'blocker' }), CONTEXT, 'NR-1');
  const minor = buildEmbed(baseRequest({ severity: 'minor' }), CONTEXT, 'NR-2');
  assert.notStrictEqual(blocker.color, minor.color);
});

test('embed : la mention du testeur ne ping personne', () => {
  const embed = buildEmbed(baseRequest({ contact: { discordId: '123', discordName: 'haim' } }), CONTEXT, 'NR-3');
  const tester = embed.fields.find((f) => f.name === 'Testeur');
  assert.strictEqual(tester.value, '<@123> (haim)');
});

test('contexte : formaté sans lever, même partiel', () => {
  assert.match(formatBugContext(CONTEXT), /RTX 3060/);
  assert.match(formatBugContext({ ok: true }), /non sondé/);
  assert.match(formatBugContext(null), /indisponible/);
});
