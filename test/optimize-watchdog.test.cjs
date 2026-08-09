// Surveillance mémoire + classement des processus.
//
// Deux invariants valent un test : (1) on ne propose JAMAIS d'arrêter l'application qui tient le
// montage — c'est le bug que la liste recopiée à la main avait créé pour Premiere et After Effects ;
// (2) une purge ne peut pas se rejouer à chaque tick — sans hystérésis ni repos, un seuil frôlé
// déclenche une libération toutes les 10 s et la machine ralentit au lieu d'accélérer.
const test = require("node:test");
const assert = require("node:assert");

const { protectedHostBases } = require("../core/hostImages.js");
const { createClassifier } = require("../core/optimize/noise.js");
const procScan = require("../core/optimize/procScan.js");
const watchdog = require("../core/optimize/watchdog.js");

const classifier = createClassifier({ hostBases: protectedHostBases() });

test("les hôtes de montage et leurs satellites sont protégés", () => {
  for (const image of [
    "Resolve.exe",
    "Adobe Premiere Pro.exe",
    "AfterFX.exe",
    "dynamiclinkmanager.exe",
    "Adobe QT32 Server.exe",
    "CEPHtmlEngine.exe",
    "nvcontainer.exe", // pilote NVIDIA : sa mort coupe l'encodage matériel
  ]) {
    const v = classifier.classify(image);
    assert.strictEqual(v.critical, true, `${image} devrait être protégé`);
    assert.strictEqual(v.kind, "host");
  }
});

test("le noyau Windows reste intouchable, le bruit est classé", () => {
  assert.strictEqual(classifier.classify("lsass.exe").kind, "system");
  assert.strictEqual(classifier.classify("audiodg.exe").critical, true);

  const overlay = classifier.classify("NVIDIA Share.exe");
  assert.strictEqual(overlay.kind, "noise");
  assert.strictEqual(overlay.critical, false);
  assert.strictEqual(overlay.family, "overlays");

  assert.strictEqual(classifier.classify("OneDrive.exe").family, "sync");
  assert.strictEqual(classifier.classify("GoogleUpdate.exe").family, "updaters");
  // Un outil quelconque n'est pas du bruit : inconnu ⇒ jamais proposé à l'arrêt.
  assert.strictEqual(classifier.classify("MonOutilPerso.exe").kind, "unknown");
});

test("une application VISIBLE n'est jamais proposée à l'arrêt, même classée bruit", () => {
  const rows = procScan.classifyRows(
    [
      { pid: 11, name: "OneDrive", ram: 300e6, cpuMs: 0, windowed: false, path: "" },
      { pid: 12, name: "Discord", ram: 900e6, cpuMs: 0, windowed: true, path: "" }, // fenêtre ouverte
      { pid: 13, name: "Resolve", ram: 9e9, cpuMs: 0, windowed: true, path: "" },
    ],
    classifier,
  );
  const killable = procScan.killableNoise(rows);
  assert.deepStrictEqual(
    killable.map((p) => p.pid),
    [11],
  );
});

test("un seul process renvoyé par PowerShell est un objet, pas un tableau", () => {
  const one = procScan.parseScan('{"Id":42,"Name":"OneDrive","ws":100,"cpuMs":5,"win":0,"path":""}');
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].pid, 42);
  assert.deepStrictEqual(procScan.parseScan("pas du json"), []);
});

test("la charge CPU vient d'un DELTA, pas du cumul depuis le démarrage", () => {
  const first = [{ pid: 1, name: "a", ram: 0, cpuMs: 10_000, windowed: false, path: "" }];
  const second = [{ pid: 1, name: "a", ram: 0, cpuMs: 10_500, windowed: false, path: "" }];
  const cores = require("os").cpus().length || 1;
  const delta = procScan.cpuDelta(first, second, 1000);
  assert.strictEqual(delta.get(1), Math.round((500 / (1000 * cores)) * 100));
  // Un processus apparu entre les deux échantillons n'a pas de base : il est ignoré, pas compté à 100 %.
  assert.strictEqual(procScan.cpuDelta([], second, 1000).size, 0);
});

test("la pression combine RAM et VRAM", () => {
  const prefs = watchdog.sanitizePrefs({});
  const calm = watchdog.evaluatePressure({ ram: { free: 8e9, total: 32e9 }, gpu: null }, prefs);
  assert.strictEqual(calm.under, false);

  const tight = watchdog.evaluatePressure({ ram: { free: 2e9, total: 32e9 }, gpu: null }, prefs);
  assert.deepStrictEqual(tight.reasons, ["ram"]);

  const vram = watchdog.evaluatePressure(
    { ram: { free: 20e9, total: 32e9 }, gpu: { usedMB: 7800, totalMB: 8192 } },
    prefs,
  );
  assert.deepStrictEqual(vram.reasons, ["vram"]);
});

test("une purge exige deux mesures consécutives puis respecte le repos", () => {
  const under = { under: true, ramPct: 5, vramPct: null, reasons: ["ram"] };
  let state = { over: 0, cooldownUntil: 0 };

  // Premier passage sous le seuil : on arme, on n'agit pas (un pic isolé n'est pas une pression).
  let step = watchdog.nextState(state, { now: 1000, heavy: true, pressure: under });
  assert.strictEqual(step.purge, false);
  state = step.state;

  step = watchdog.nextState(state, { now: 2000, heavy: true, pressure: under });
  assert.strictEqual(step.purge, true);
  state = step.state;
  assert.ok(state.cooldownUntil > 2000);

  // Toujours sous le seuil juste après : le repos interdit de rejouer la purge à chaque tick.
  state = watchdog.nextState(state, { now: 12_000, heavy: true, pressure: under }).state;
  const during = watchdog.nextState(state, { now: 22_000, heavy: true, pressure: under });
  assert.strictEqual(during.purge, false);

  // Repos écoulé : la pression persiste, on ré-agit.
  const after = watchdog.nextState(during.state, {
    now: state.cooldownUntil + 1,
    heavy: true,
    pressure: under,
  });
  assert.strictEqual(after.purge, true);
});

test("hors tâche lourde, la surveillance n'arme rien", () => {
  const under = { under: true, ramPct: 3, vramPct: null, reasons: ["ram"] };
  let state = { over: 5, cooldownUntil: 0 };
  const step = watchdog.nextState(state, { now: 1000, heavy: false, pressure: under });
  assert.strictEqual(step.purge, false);
  assert.strictEqual(step.state.over, 0);
});

test("des réglages aberrants sont ramenés dans des bornes utilisables", () => {
  const p = watchdog.sanitizePrefs({ enabled: false, ramLowPct: 0, vramHighPct: 500 });
  assert.strictEqual(p.enabled, false);
  assert.strictEqual(p.ramLowPct, 5);
  assert.strictEqual(p.vramHighPct, 99);
  assert.deepStrictEqual(watchdog.sanitizePrefs(null), watchdog.DEFAULT_PREFS);
});
