// L'export After Effects ne posait que des valeurs FIXES : l'API de Resolve n'expose aucune image
// clé, seul son export FCP7 XML les porte. La greffe ci-dessous est le seul chemin des courbes vers
// AE, et le script généré la seule écriture — les deux sont tenus ici.
const test = require('node:test');
const assert = require('node:assert/strict');

const { graftAnimation } = require('../core/ae/animation');
const { genAeScript } = require('../core/ae/jsx');

const keys = (frames) => ({
  value: { x: 1, y: 1 },
  keyframes: frames.map((frame) => ({ frame, value: { x: 1 + frame / 100, y: 1 }, interpolation: 'linear' })),
});

const item = (over = {}) => ({
  kind: 'video', track: 1, path: 'C:/rush/a.mov', name: 'a', fpsClip: 24, srcFrames: 100,
  srcIn: 0, srcOut: 47, tlStart: 0, tlEnd: 48, xf: null, ...over,
});

const overlayClip = (over = {}) => ({
  kind: 'video', track: 1, path: 'C:/rush/a.mov', tlStart: 0, tlEnd: 48,
  video: { transform: { scale: keys([0, 24]) } }, ...over,
});

test('les propriétés animées du XML se greffent sur les plans lus par l API', () => {
  const items = [item()];
  assert.equal(graftAnimation({ ok: true, clips: [overlayClip()] }, items).animated, 1);
  assert.equal(items[0].anim.scale.keyframes.length, 2);
});

test('une valeur FIXE du XML ne remplace jamais celle lue sur l objet Resolve', () => {
  const items = [item()];
  const overlay = { ok: true, clips: [overlayClip({ video: { transform: { scale: { value: { x: 3, y: 3 } } } } })] };
  assert.equal(graftAnimation(overlay, items).animated, 0);
  assert.equal(items[0].anim, undefined);
});

test('une image clé hors des bornes du plan fait refuser la greffe', () => {
  const items = [item()];
  // 400 dépasse largement l'occupation (48 frames) : l'appariement est douteux, poser l'animation
  // reviendrait à la mettre sur le plan du voisin.
  const overlay = { ok: true, clips: [overlayClip({ video: { transform: { scale: keys([0, 400]) } } })] };
  assert.equal(graftAnimation(overlay, items).animated, 0);
});

test('les plans issus d une timeline imbriquée restent hors de l appariement', () => {
  // L'API aplatit la timeline imbriquée, le XML la garde entière : les compter ensemble ferait
  // glisser tout l'appariement de la piste.
  const items = [item({ nested: true }), item({ rendered: true, tlStart: 48, tlEnd: 96 })];
  assert.equal(graftAnimation({ ok: true, clips: [overlayClip()] }, items).animated, 0);
});

test('une piste dont les deux lectures ne comptent pas le même nombre de plans n est pas appariée', () => {
  const items = [item(), item({ tlStart: 48, tlEnd: 96 })];
  assert.equal(graftAnimation({ ok: true, clips: [overlayClip()] }, items).animated, 0);
});

test('le script AE pose les images clés et précompose EN EMPORTANT les attributs', () => {
  const script = genAeScript({
    comp: { name: 'T', w: 1920, h: 1080, fps: 24, dur: 5 },
    layers: [{
      file: 'C:/rush/a.mov', kind: 'video', occSec: 2, inPoint: 0, outPoint: 2, startTime: 0,
      xf: { zoomX: 1, zoomY: 1, pan: 0, tilt: 0, rot: 0, opacity: 100, anchorX: 0, anchorY: 0, flipX: 0, flipY: 0 },
      anim: { scale: keys([0, 24]) }, keyStart: 0, keyFps: 24,
    }],
    groups: [], precomp: true, precompTarget: 'video', precompNaming: 'file', folders: false, transforms: true,
  }, 'C:/tmp/x.log');

  new Function(script);   // le .jsx part tel quel dans After Effects : une faute de syntaxe = export perdu
  assert.match(script, /prop\.setValueAtTime\(tk, conv\(/);
  assert.match(script, /setInterpolationTypeAtKey/);
  // moveAllAttributes = true : transforms et images clés vont DANS la précompo, sur le rush.
  assert.match(script, /comp\.layers\.precompose\(\[li\], pn, true\)/);
  // …et le calque de précompo retrouve les bornes du plan, sinon il couvre toute la timeline.
  assert.match(script, /outer\.inPoint = wasIn/);
});

test('le son est rangé sous les images, après les insertions de précompos', () => {
  const script = genAeScript({
    comp: { name: 'T', w: 1920, h: 1080, fps: 24, dur: 5 },
    layers: [
      { file: 'C:/rush/a.mov', kind: 'video', occSec: 2, inPoint: 0, outPoint: 2, startTime: 0, xf: null },
      { file: 'C:/rush/a.wav', kind: 'audio', occSec: 2, inPoint: 0, outPoint: 2, startTime: 0, xf: null },
    ],
    groups: [], precomp: false, precompTarget: 'video', precompNaming: 'file', folders: false, transforms: false,
  }, 'C:/tmp/x.log');

  new Function(script);
  assert.match(script, /audioLayers\[a\]\.moveToEnd\(\)/);
  // Le rangement doit venir APRÈS le bloc de précomposition : precompose réinsère un calque et
  // remonterait le son au-dessus.
  assert.ok(script.indexOf('moveToEnd') > script.indexOf('layers.precompose'), 'son rangé trop tôt');
});
