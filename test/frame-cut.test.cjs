// planPreciseCopy : le plan « copie exacte » n'est rendu QUE quand la copie peut être prouvée
// frame-exacte sur les paquets source (keyframe au début, aucune frame d'avance ni de dépassement
// dans la fenêtre gardée). Tout le reste doit rendre null → l'appelant ré-encode.
const test = require('node:test');
const assert = require('node:assert');
const { planPreciseCopy, copyArgs } = require('../core/export/frameCut');

const FPS = 24;
const t = (frame) => frame / FPS;

// GOP en ordre de DÉCODAGE : keyframe, puis ancres P toutes les 3 frames avec leurs B réordonnés
// (pattern I P B B P B B…), comme un flux h264/h265 réel.
function gop(startFrame, frames) {
  const out = [{ pts: t(startFrame), key: true }];
  for (let anchor = startFrame + 3; anchor < startFrame + frames + 3; anchor += 3) {
    out.push({ pts: t(Math.min(anchor, startFrame + frames - 1)), key: false });
    for (let b = anchor - 2; b <= anchor - 1 && b < startFrame + frames; b++) {
      out.push({ pts: t(b), key: false });
    }
  }
  // dédoublonne la dernière ancre clampée
  const seen = new Set();
  return out.filter((p) => !seen.has(p.pts) && seen.add(p.pts));
}

test('copie exacte quand début sur keyframe et fin sur frontière de GOP', () => {
  const packets = [...gop(0, 48), ...gop(48, 48)];
  const plan = planPreciseCopy(packets, t(0), t(48), FPS);
  assert.ok(plan, 'un plan doit exister');
  assert.strictEqual(plan.snapStart, t(0));
  assert.strictEqual(plan.frames, 48);
});

test('début hors keyframe → null (le ré-encode est la seule coupe exacte)', () => {
  const packets = gop(0, 96);
  assert.strictEqual(planPreciseCopy(packets, t(10), t(58), FPS), null);
});

test('fin en plein GOP avec ancre au-delà → null (elle s\'afficherait en trop)', () => {
  // décodage : [0k, 3, 1, 2, 6, 4, 5, …] — couper à la frame 5 garde l'ancre pts=6 dans la fenêtre.
  const packets = gop(0, 96);
  assert.strictEqual(planPreciseCopy(packets, t(0), t(5), FPS), null);
});

test('fin en plein GOP mais fenêtre propre (frontière d\'ancre) → copie exacte', () => {
  // décodage : [0k, 3, 1, 2, 6, 4, 5, 9, 7, 8, …] — couper à la frame 7 garde exactement 0..6.
  const packets = gop(0, 96);
  const plan = planPreciseCopy(packets, t(0), t(7), FPS);
  assert.ok(plan);
  assert.strictEqual(plan.frames, 7);
});

test('pts arrondis à la milliseconde (timebase mkv 1/1000) → copie exacte quand même', () => {
  const ms = (frame) => Math.round(t(frame) * 1000) / 1000;
  const packets = [...gop(0, 48), ...gop(48, 48)].map((p) => ({ ...p, pts: ms(Math.round(p.pts * FPS)) }));
  const plan = planPreciseCopy(packets, t(0), t(48), FPS);
  assert.ok(plan);
  assert.strictEqual(plan.frames, 48);
});

test('leading pictures d\'un GOP ouvert (pts avant la keyframe) → null', () => {
  // décodage : keyframe pts=48, puis deux frames d'avance pts 46-47 (RASL) qui s'afficheraient AVANT.
  const packets = [
    { pts: t(48), key: true }, { pts: t(46), key: false }, { pts: t(47), key: false },
    ...gop(48, 48).slice(1),
  ];
  assert.strictEqual(planPreciseCopy(packets, t(48), t(96), FPS), null);
});

test('keyframe trop loin du début (> ½ frame) → null', () => {
  const packets = gop(0, 96);
  assert.strictEqual(planPreciseCopy(packets, t(0) + 1.2 / FPS, t(48), FPS), null);
});

test('compte de frames incohérent (VFR, trous) → null', () => {
  const packets = gop(0, 48).filter((p) => p.pts !== t(20)); // une frame manque
  assert.strictEqual(planPreciseCopy(packets, t(0), t(48), FPS), null);
});

test('entrées invalides → null', () => {
  assert.strictEqual(planPreciseCopy([], 0, 2, FPS), null);
  assert.strictEqual(planPreciseCopy(gop(0, 48), 2, 1, FPS), null);
  assert.strictEqual(planPreciseCopy(gop(0, 48), 0, 2, 0), null);
});

test('copyArgs : vidéo bornée en paquets (-frames:v), audio en durée (-t)', () => {
  const args = copyArgs('in.mkv', { snapStart: 2, frames: 48, duration: 2 }, ['-map', '0:v:0'], 'out.mp4');
  assert.deepStrictEqual(args, [
    '-y', '-ss', '2', '-i', 'in.mkv', '-map', '0:v:0',
    '-c', 'copy', '-frames:v', '48', '-t', '2',
    '-avoid_negative_ts', 'make_zero', 'out.mp4',
  ]);
});
