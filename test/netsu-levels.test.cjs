const test = require('node:test');
const assert = require('node:assert/strict');

const levels = require('../core/netsu/levels');

const video = (extra) => ({ kind: 'video', ref: 'C:/rush/A001.mov', ...extra });

test('la marge ne sort jamais des bornes du média', () => {
  // Un plan qui commence à 0,5 s ne peut pas reculer de 2 s : ffmpeg rendrait un fichier vide.
  const head = levels.clampRange({ in: 0.5, out: 4, duration: 60, marginSec: 2 });
  assert.equal(head.start, 0);
  assert.equal(head.end, 6);

  // Un plan qui finit sur la dernière image ne peut pas déborder après la fin.
  const tail = levels.clampRange({ in: 55, out: 60, duration: 60, marginSec: 5 });
  assert.equal(tail.start, 50);
  assert.equal(tail.end, 60);

  // Bornes croisées (item abîmé) : plage vide, jamais inversée — sinon `-t` serait négatif.
  const crossed = levels.clampRange({ in: 10, out: 4, duration: 60, marginSec: 0 });
  assert.ok(crossed.end >= crossed.start);
});

test('une durée inconnue laisse la fin libre au lieu de tout tronquer', () => {
  const range = levels.clampRange({ in: 2, out: 8, duration: 0, marginSec: 1 });
  assert.equal(range.start, 1);
  assert.equal(range.end, 9);
});

test('planEmbed rend le bon descripteur pour chacun des 4 niveaux', () => {
  const item = video({ trimIn: 10, trimOut: 16, dur: 120 });

  const link = levels.planEmbed(item, { level: 'link' });
  assert.equal(link.mode, 'link');
  assert.equal(link.poster, true);
  assert.equal(link.clip, null);

  const preview = levels.planEmbed(item, { level: 'preview' });
  assert.equal(preview.mode, 'clip');
  assert.deepEqual([preview.clip.start, preview.clip.end], [10, 16]);

  const margin = levels.planEmbed(item, { level: 'margin', marginSec: 3 });
  assert.equal(margin.mode, 'clip');
  assert.deepEqual([margin.clip.start, margin.clip.end], [7, 19]);

  const full = levels.planEmbed(item, { level: 'full' });
  assert.equal(full.mode, 'file');
  assert.equal(full.wholeFile, true);
});

test("'margin' couvre strictement plus que 'preview' à réglages égaux", () => {
  const item = video({ trimIn: 30, trimOut: 36, dur: 300 });
  const preview = levels.planEmbed(item, { level: 'preview' });
  const margin = levels.planEmbed(item, { level: 'margin' });
  assert.ok(margin.clip.start < preview.clip.start);
  assert.ok(margin.clip.end > preview.clip.end);
});

test('un niveau ou une qualité inconnus retombent sur les défauts au lieu de casser', () => {
  const item = video({ trimIn: 0, trimOut: 5, dur: 10 });
  const plan = levels.planEmbed(item, { level: 'n_importe_quoi', quality: 'ultra' });
  assert.equal(plan.level, levels.DEFAULT_LEVEL);
  assert.equal(plan.quality, levels.DEFAULT_QUALITY);
  assert.equal(levels.normalizeMargin(-5), levels.DEFAULT_MARGIN_SEC);
  assert.equal(levels.normalizeMargin(9999), levels.MAX_MARGIN_SEC);
});

test('les items sans média local ne produisent rien à embarquer', () => {
  for (const kind of ['youtube', 'embed', 'text', 'frame', 'draw']) {
    const plan = levels.planEmbed({ kind, ref: 'x' }, { level: 'full' });
    assert.equal(plan.mode, 'none', kind);
    assert.equal(levels.estimateBytes(plan, {}), 0, kind);
  }
});

test('une image est recopiée telle quelle dès qu’on embarque', () => {
  const plan = levels.planEmbed({ kind: 'image', ref: 'C:/ref/a.png' }, { level: 'preview' });
  assert.equal(plan.mode, 'file');
  assert.equal(plan.clip, null);
});

test('le poids estimé croît avec la durée et avec la qualité', () => {
  const short = levels.planEmbed(video({ trimIn: 0, trimOut: 4, dur: 60 }), { level: 'preview' });
  const long = levels.planEmbed(video({ trimIn: 0, trimOut: 40, dur: 60 }), { level: 'preview' });
  assert.ok(levels.estimateBytes(long, {}) > levels.estimateBytes(short, {}));

  const eco = levels.planEmbed(video({ trimIn: 0, trimOut: 10, dur: 60 }), { level: 'preview', quality: 'eco' });
  const high = levels.planEmbed(video({ trimIn: 0, trimOut: 10, dur: 60 }), { level: 'preview', quality: 'high' });
  assert.ok(levels.estimateBytes(high, {}) > levels.estimateBytes(eco, {}));

  // Niveau Original : le poids EST celui de la source, aucune estimation à inventer.
  const full = levels.planEmbed(video({ trimIn: 0, trimOut: 4, dur: 60 }), { level: 'full' });
  assert.equal(levels.estimateBytes(full, { sourceSize: 2_000_000_000 }), 2_000_000_000);
});

test('une plage anormalement longue est SIGNALÉE, jamais rognée en douce', () => {
  const item = video({ trimIn: 0, trimOut: levels.LONG_CLIP_SEC + 60, dur: 4000 });
  const plan = levels.planEmbed(item, { level: 'preview' });
  assert.equal(plan.long, true);
  // La plage reste entière : rogner ferait croire à un board complet alors qu'il manquerait la fin.
  assert.equal(plan.clip.end, levels.LONG_CLIP_SEC + 60);
});
