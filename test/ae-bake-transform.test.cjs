// Mode « Réencodé » : le cadrage doit arriver DANS le fichier, pas sur le calque After Effects.
// Le graphe ffmpeg reproduit le même modèle que la pose AE (comp = P + R·S·(p − A)) ; s'ils
// divergent, le même plan ne se cadre pas pareil selon le mode, et rien ne le dit.
const test = require('node:test');
const assert = require('node:assert/strict');

const { bakeGraph, carriesAlpha, isIdentity } = require('../core/ae/bakeTransform');
const { adoptRenderedClip } = require('../core/ae/timelineRead');

const XF = {
  zoomX: 1, zoomY: 1, pan: 0, tilt: 0, rot: 0, anchorX: 0, anchorY: 0, opacity: 100,
  cropL: 0, cropR: 0, cropT: 0, cropB: 0, flipX: 0, flipY: 0,
};
const HD = { srcW: 1920, srcH: 1080, compW: 1920, compH: 1080 };
const overlayOf = (graph) => {
  const m = /overlay=(-?\d+):(-?\d+)/.exec(graph.filter[1]);
  assert.ok(m, 'incrustation introuvable dans ' + graph.filter[1]);
  return [Number(m[1]), Number(m[2])];
};

test('rien à cuire sur un transform identité', () => {
  assert.equal(isIdentity(XF), true);
  assert.equal(bakeGraph({ ...HD, xf: XF }), null);
  // …mais une vitesse seule reste un graphe à produire.
  assert.ok(bakeGraph({ ...HD, xf: XF, setpts: '2.000000*PTS' }));
});

test('dimensions source inconnues : on ne devine pas un cadrage', () => {
  assert.equal(bakeGraph({ ...HD, srcW: 0, srcH: 0, xf: { ...XF, zoomX: 2, zoomY: 2 } }), null);
});

test('un zoom centré reste centré, à la taille de la timeline', () => {
  const graph = bakeGraph({ ...HD, xf: { ...XF, zoomX: 0.5, zoomY: 0.5 } });
  assert.match(graph.filter[1], /scale=960:540/);
  assert.deepEqual(overlayOf(graph), [480, 270]);
  assert.match(graph.inputs.join(' '), /color=c=black:s=1920x1080/);
});

test('la source est AJUSTÉE à l image de la timeline avant le zoom', () => {
  // Un rush 4K dans une comp 1080p : Resolve l'ajuste (facteur 0,5) puis applique le zoom. Sans cet
  // ajustement, le plan sortirait quatre fois trop grand.
  const graph = bakeGraph({ srcW: 3840, srcH: 2160, compW: 1920, compH: 1080, xf: XF, setpts: '1*PTS' });
  assert.match(graph.filter[1], /scale=1920:1080/);
  assert.deepEqual(overlayOf(graph), [0, 0]);
});

test('pan va vers la droite, tilt vers le haut', () => {
  // Tilt positif MONTE : l'axe Y de la comp décroît — même signe que la pose AE.
  const graph = bakeGraph({ ...HD, xf: { ...XF, zoomX: 0.5, zoomY: 0.5, pan: 100, tilt: 60 } });
  assert.deepEqual(overlayOf(graph), [580, 210]);
});

test('le recadrage se prend dans le repère de la source, pas dans le facteur d ajustement', () => {
  const graph = bakeGraph({ ...HD, xf: { ...XF, cropL: 100, cropR: 100, cropT: 40, cropB: 40 } });
  assert.match(graph.filter[1], /crop=1720:1000:100:40/);
  // Ajustement inchangé (1) : l'image recadrée garde sa place, elle ne se regonfle pas.
  assert.match(graph.filter[1], /scale=1720:1000/);
  assert.deepEqual(overlayOf(graph), [100, 40]);
});

test('le miroir passe par hflip/vflip', () => {
  const graph = bakeGraph({ ...HD, xf: { ...XF, flipX: 1, flipY: 1 } });
  assert.match(graph.filter[1], /hflip/);
  assert.match(graph.filter[1], /vflip/);
});

test('une rotation agrandit le cadre et garde le plan centré', () => {
  const graph = bakeGraph({ ...HD, xf: { ...XF, zoomX: 0.5, zoomY: 0.5, rot: 90 } });
  assert.match(graph.filter[1], /rotate=[\d.]+:ow=540:oh=960/);
  assert.deepEqual(overlayOf(graph), [690, 60]);   // 540×960 recentré dans 1920×1080
});

test('les coins d une rotation sont transparents quand le codec porte l alpha', () => {
  assert.equal(carriesAlpha('prores_4444'), true);
  assert.equal(carriesAlpha('prores_422_hq'), false);
  const opaque = bakeGraph({ ...HD, xf: { ...XF, rot: 12 } });
  const alpha = bakeGraph({ ...HD, xf: { ...XF, rot: 12 }, alpha: true });
  assert.match(opaque.filter[1], /fillcolor=black/);
  assert.match(alpha.filter[1], /fillcolor=none/);
  assert.match(alpha.inputs.join(' '), /color=c=black@0\.0/);
});

test('un cadrage ANIMÉ cuit par Resolve ne traverse plus rien', () => {
  // ffmpeg n'a pas de transformation affine variable dans le temps : Resolve rend le plan tel qu'il
  // l'affiche, images clés comprises. Le fichier porte alors TOUT — le repasser dans un réencode,
  // un transform de calque ou un time-remap appliquerait deux fois le même mouvement.
  const clip = {
    kind: 'video', track: 2, path: 'C:/rush/2.mov', name: '2', fpsClip: 30, srcFrames: 900,
    srcIn: 120, srcOut: 167, tlStart: 300, tlEnd: 348, retimed: true, reverse: true, freeze: true,
    xf: { ...XF, zoomX: 2 }, anim: { scale: { value: 1, keyframes: [{ frame: 0, value: 1 }] } },
  };
  adoptRenderedClip(clip, 'C:/out/2_bake_300.mov', 24);
  assert.equal(clip.path, 'C:/out/2_bake_300.mov');
  assert.equal(clip.rendered, true);
  assert.equal(clip.xf, null);
  assert.equal(clip.anim, undefined);
  // Bornes repartant de zéro, à la cadence de la TIMELINE : la longueur du rush ne s'applique plus.
  assert.deepEqual(
    { fps: clip.fpsClip, srcIn: clip.srcIn, srcOut: clip.srcOut, frames: clip.srcFrames },
    { fps: 24, srcIn: 0, srcOut: 47, frames: 0 },
  );
  assert.deepEqual([clip.retimed, clip.reverse, clip.freeze], [false, false, false]);
});

test('la vidéo cuite remplace le flux source dans le mappage', () => {
  const graph = bakeGraph({ ...HD, xf: { ...XF, zoomX: 2, zoomY: 2 } });
  assert.deepEqual(graph.map, ['-map', '[v]', '-map', '0:a?']);
});
