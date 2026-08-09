// Frame-math et mappeurs du transfert de timeline entre hôtes. Ces fonctions sont PURES : elles
// s'exercent sans Resolve, sans Adobe et sans panneau CEP — c'est justement pourquoi elles portent
// la partie du transfert qui n'a pas le droit de se tromper.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  docFromResolveEdit, docFromAdobeSequence, dedupLinkedAudio,
  normalizeDoc, docSummary, resolvePlacement, trackCounts,
  frameRateRational, upgradeTransferDoc,
  MEDIA_TYPE_VIDEO, MEDIA_TYPE_AUDIO,
} = require('../core/transfer/doc');
const { adobePayload, transferSummary } = require('../core/transfer');

const FPS_23_976 = 24000 / 1001;

function resolveEdit(items, extra = {}) {
  return {
    ok: true, timeline: 'V1', fps: 24, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, items, missing: [], groups: [], ...extra,
  };
}

function resolveItem(over = {}) {
  return {
    kind: 'video', track: 1, path: 'C:/rush.mov', name: 'plan', fpsClip: 24, srcFrames: 1000,
    srcIn: 10, srcOut: 33, tlStart: 0, tlEnd: 24, xf: null, ...over,
  };
}

test('une timeline Resolve devient un document aux bornes source inclusives', () => {
  const doc = docFromResolveEdit(resolveEdit([resolveItem()]));
  assert.equal(doc.host, 'resolve');
  assert.equal(doc.version, 2);
  assert.equal(doc.clips.length, 1);
  assert.deepEqual(
    { srcIn: doc.clips[0].srcIn, srcOut: doc.clips[0].srcOut, tlStart: doc.clips[0].tlStart, tlEnd: doc.clips[0].tlEnd },
    { srcIn: 10, srcOut: 33, tlStart: 0, tlEnd: 24 },
  );
  // 24 frames occupées pour des bornes 10..33 : la borne de sortie est bien INCLUSIVE.
  assert.equal(doc.clips[0].srcOut - doc.clips[0].srcIn + 1, doc.clips[0].tlEnd - doc.clips[0].tlStart);
});

test('les propriétés Resolve deviennent des primitives canoniques sans perdre la forme AE', () => {
  const xf = {
    zoomX: 1.5, zoomY: 0.75, pan: 120, tilt: -40, rot: 15,
    anchorX: 12, anchorY: -8, opacity: 50, cropL: 2, cropR: 3,
    cropT: 4, cropB: 5, flipX: 1, flipY: 0,
  };
  const doc = docFromResolveEdit(resolveEdit([
    resolveItem({ xf, srcIn: 0, srcOut: 47, tlStart: 0, tlEnd: 24, retimed: true, reverse: true }),
  ]));
  const clip = doc.clips[0];
  assert.deepEqual(clip.xf, xf, 'forme brute gardée pour le pipeline AE existant');
  assert.deepEqual(clip.video.transform.position.value, { x: 120, y: 40 });
  assert.deepEqual(clip.video.transform.scale.value, { x: 1.5, y: 0.75 });
  assert.equal(clip.video.transform.opacity.value, 50);
  assert.deepEqual(clip.timing.speed, { numerator: 2, denominator: 1 });
  assert.equal(clip.timing.reverse, true);
});

test('la cadence 23,976 reste rationnelle et un document v1 est mis à niveau', () => {
  assert.deepEqual(frameRateRational(24000 / 1001), { numerator: 24000, denominator: 1001 });
  const upgraded = upgradeTransferDoc({
    ok: true, host: 'ppro', timeline: 'S', fps: 24000 / 1001, width: 1920, height: 1080,
    startFrame: 0, endFrame: 24, missing: [], clips: [resolveItem({ fpsClip: undefined, fps: 24 })],
  });
  assert.equal(upgraded.version, 2);
  assert.deepEqual(upgraded.fpsRational, { numerator: 24000, denominator: 1001 });
  assert.equal(upgraded.clips[0].identity.sourceHost, 'ppro');
  assert.deepEqual(upgraded.clips[0].timing.speed, { numerator: 1000, denominator: 1001 });
});

test('un plan sans fichier est écarté du document Resolve', () => {
  const doc = docFromResolveEdit(resolveEdit([resolveItem(), resolveItem({ path: null, name: 'titre' })]));
  assert.equal(doc.clips.length, 1);
});

test('le timecode de départ de la timeline est rebasé sur zéro', () => {
  // Une timeline Resolve démarre couramment à 01:00:00:00 (86 400 frames à 24 i/s). Sans rebase,
  // le montage cible partirait une heure plus loin.
  const doc = normalizeDoc(docFromResolveEdit(resolveEdit(
    [resolveItem({ tlStart: 86400, tlEnd: 86424 }), resolveItem({ tlStart: 86500, tlEnd: 86520 })],
    { startFrame: 86400, endFrame: 86520 },
  )));
  assert.equal(doc.startFrame, 0);
  assert.deepEqual(doc.clips.map((c) => c.tlStart), [0, 100]);
  assert.equal(doc.endFrame, 120);
});

test('les trous de la timeline survivent au document', () => {
  const doc = normalizeDoc(docFromResolveEdit(resolveEdit([
    resolveItem({ tlStart: 0, tlEnd: 24 }),
    resolveItem({ tlStart: 100, tlEnd: 124 }), // 76 frames de trou volontaire
  ])));
  assert.deepEqual(doc.clips.map((c) => [c.tlStart, c.tlEnd]), [[0, 24], [100, 124]]);
});

// ---- Snapshot Adobe -----------------------------------------------------------------------------

function adobeSnapshot(clips, over = {}) {
  return {
    ok: true, app: 'ppro', project: 'projet', at: 0, rushes: [],
    sequences: [{ name: 'Séquence 01', fps: FPS_23_976, w: 1920, h: 1080, tracks: [
      { kind: 'video', index: 1, clips },
    ] }],
    ...over,
  };
}

test('les frames calculées par Premiere priment sur les secondes', () => {
  // Les ticks sont exacts, les secondes non : sur 23,976 le repli secondes×fps dériverait.
  const snap = adobeSnapshot([{
    name: 'plan', path: 'C:/a.mov',
    tlStart: 0, tlEnd: 4.171, srcIn: 41.7, srcOut: 45.87,
    srcFps: FPS_23_976, srcInFrame: 1000, srcOutFrame: 1099, tlStartFrame: 0, tlEndFrame: 100,
  }]);
  const doc = docFromAdobeSequence(snap, 'Séquence 01');
  assert.equal(doc.ok, true);
  assert.deepEqual(
    { srcIn: doc.clips[0].srcIn, srcOut: doc.clips[0].srcOut, tlStart: doc.clips[0].tlStart, tlEnd: doc.clips[0].tlEnd },
    { srcIn: 1000, srcOut: 1099, tlStart: 0, tlEnd: 100 },
  );
});

test('le payload Adobe conserve propriétés, animations et timing', () => {
  const position = { value: { x: 10, y: 20 }, keyframes: [{ frame: 0, value: { x: 10, y: 20 } }] };
  const volume = { value: 0.5, keyframes: [{ frame: 4, value: 0.25 }] };
  const doc = upgradeTransferDoc({
    ok: true, host: 'resolve', timeline: 'T', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 25, missing: [], clips: [{
      kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 100,
      srcIn: 0, srcOut: 24, tlStart: 0, tlEnd: 25,
      identity: { nativeId: 'resolve-1', sourceHost: 'resolve' },
      hostTicks: { start: '0', end: '25' },
      video: { transform: { position } }, audio: { volume },
      timing: { speed: { numerator: 2, denominator: 1 }, reverse: true, freeze: false },
      deferred: ['transition'],
    }],
  });
  const payload = adobePayload(doc, {});
  assert.deepEqual(payload.clips[0].video.transform.position, position);
  assert.equal(payload.clips[0].timelineFps, 25);
  assert.deepEqual(payload.clips[0].audio.volume, volume);
  assert.deepEqual(payload.clips[0].timing.speed, { numerator: 2, denominator: 1 });
  assert.equal(payload.clips[0].identity.nativeId, 'resolve-1');
  assert.deepEqual(payload.clips[0].deferred, ['transition']);
});

test('une séquence imbriquée marque ses bornes source comme approximatives', () => {
  const snap = adobeSnapshot([{
    name: 'nested', path: 'C:/a.mov', direct: false,
    srcFps: 25, srcInFrame: 0, srcOutFrame: 24, tlStartFrame: 0, tlEndFrame: 25,
  }]);
  const doc = docFromAdobeSequence(snap, 'Séquence 01');
  const assessment = transferSummary(normalizeDoc(doc), 'resolve').fidelity;
  assert.equal(doc.clips[0].trimExactness, 'approx');
  assert.equal(assessment.items.find((item) => item.property === 'clip.trim').status, 'approximated');
});

test('un snapshot sans champs frames retombe sur les secondes', () => {
  // Panneau CEP antérieur à srcInFrame/tlEndFrame : le document doit rester exploitable.
  const snap = adobeSnapshot([{
    name: 'plan', path: 'C:/a.mov', tlStart: 0, tlEnd: 2, srcIn: 1, srcOut: 3, srcFps: 25,
  }], { sequences: [{ name: 'S', fps: 25, w: 1920, h: 1080, tracks: [{ kind: 'video', index: 1, clips: [{
    name: 'plan', path: 'C:/a.mov', tlStart: 0, tlEnd: 2, srcIn: 1, srcOut: 3, srcFps: 25,
  }] }] }] });
  const doc = docFromAdobeSequence(snap, 'S');
  assert.equal(doc.clips[0].srcIn, 25);
  assert.equal(doc.clips[0].srcOut, 74);  // 3 s exclusif → frame 74 inclusive
  assert.equal(doc.clips[0].tlEnd, 50);
});

test('sans champ de fin, la durée timeline vient de la durée source reconformée', () => {
  const snap = { ok: true, app: 'ppro', project: 'p', at: 0, rushes: [], sequences: [{
    name: 'S', fps: 50, w: 1920, h: 1080,
    tracks: [{ kind: 'video', index: 1, clips: [{
      name: 'plan', path: 'C:/a.mov', tlStart: null, tlEnd: null, srcIn: null, srcOut: null,
      srcFps: 25, srcInFrame: 0, srcOutFrame: 24, tlStartFrame: 0,
    }] }],
  }] };
  const doc = docFromAdobeSequence(snap, 'S');
  // 25 frames de source à 25 i/s = 1 s = 50 frames de timeline à 50 i/s.
  assert.equal(doc.clips[0].tlEnd, 50);
});

test('un snapshot absent ou une séquence inconnue rendent une clé de message', () => {
  assert.deepEqual(docFromAdobeSequence(null, 'S'), { ok: false, error: 'snapshotMissing' });
  assert.deepEqual(docFromAdobeSequence(adobeSnapshot([]), 'Absente'), { ok: false, error: 'timelineMissing' });
});

test('un item sans média n’est pas un fichier PERDU : les deux listes sont distinctes', () => {
  // « Source introuvable » désigne un fichier absent du disque. Un titre, un cache de couleur ou un
  // calque d'effet n'a simplement aucun média : les confondre faisait lire « projet cassé » sur un
  // projet sain.
  const doc = docFromAdobeSequence(adobeSnapshot([
    { name: 'Titre', path: null, tlStart: 0, tlEnd: 1, srcIn: 0, srcOut: 1 },
  ]), 'Séquence 01');
  assert.equal(doc.clips.length, 0);
  assert.deepEqual(doc.mediaLess, ['Titre']);
  assert.deepEqual(doc.missing, []);
});

// ---- Audio lié ----------------------------------------------------------------------------------

test("l'audio lié reste explicite car les writers posent la vidéo sans son", () => {
  const clips = [
    { kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 24, tlStart: 0, tlEnd: 25 },
    { kind: 'audio', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 24, tlStart: 0, tlEnd: 25 },
    { kind: 'audio', track: 2, path: 'C:/musique.wav', name: 'musique', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 99, tlStart: 0, tlEnd: 100 },
  ];
  const kept = dedupLinkedAudio(clips);
  assert.deepEqual(kept.map((c) => c.kind), ['video', 'audio', 'audio']);
});

test("l'audio lié avec un mix propre n'est pas supprimé", () => {
  const clips = [
    { kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 24, tlStart: 0, tlEnd: 25 },
    { kind: 'audio', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 24, tlStart: 0, tlEnd: 25,
      audio: { gainDb: { value: -6 }, pan: { value: 0.25 }, mute: { value: false } } },
  ];
  assert.equal(dedupLinkedAudio(clips).length, 2);
});

test("un son détaché du même fichier reste un plan à part entière", () => {
  const clips = [
    { kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 24, tlStart: 0, tlEnd: 25 },
    { kind: 'audio', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 24, tlStart: 50, tlEnd: 75 },
  ];
  assert.equal(dedupLinkedAudio(clips).length, 2);
});

// ---- Normalisation et pose Resolve ---------------------------------------------------------------

test('la normalisation borne les plans à la longueur de leur source', () => {
  const doc = normalizeDoc({
    ok: true, host: 'ppro', timeline: 'S', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, missing: [],
    clips: [{ kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 100, srcIn: -5, srcOut: 500, tlStart: 0, tlEnd: 25 }],
  });
  assert.equal(doc.clips[0].srcIn, 0);
  assert.equal(doc.clips[0].srcOut, 99);
});

test('la normalisation écarte un plan de durée nulle', () => {
  const doc = normalizeDoc({
    ok: true, host: 'ppro', timeline: 'S', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, missing: [],
    clips: [{ kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 0, tlStart: 10, tlEnd: 10 }],
  });
  assert.equal(doc.clips.length, 0);
});

test("l'ordre de lecture est vidéo, puis piste, puis chronologie", () => {
  const doc = normalizeDoc({
    ok: true, host: 'resolve', timeline: 'V1', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, missing: [],
    clips: [
      { kind: 'audio', track: 1, path: 'C:/m.wav', name: 'm', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 },
      { kind: 'video', track: 2, path: 'C:/b.mov', name: 'b', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 },
      { kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 30, tlEnd: 40 },
      { kind: 'video', track: 1, path: 'C:/c.mov', name: 'c', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 },
    ],
  });
  assert.deepEqual(doc.clips.map((c) => c.name), ['c', 'a', 'b', 'm']);
});

test('la pose Resolve est absolue et porte le type de média', () => {
  const video = { kind: 'video', track: 2, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 10, srcOut: 33, tlStart: 100, tlEnd: 124 };
  const audio = { ...video, kind: 'audio', track: 1 };
  // recordFrame = début de la timeline cible + position du plan : le trou de 100 frames est conservé.
  assert.deepEqual(resolvePlacement(video, 86400), {
    startFrame: 10, endFrame: 33, recordFrame: 86500, trackIndex: 2, mediaType: MEDIA_TYPE_VIDEO,
  });
  // mediaType audio : sans lui, le son lié du plan vidéo serait posé une seconde fois.
  assert.equal(resolvePlacement(audio, 0).mediaType, MEDIA_TYPE_AUDIO);
});

test('le nombre de pistes à garantir se lit sur le document', () => {
  const clip = (kind, track) => ({ kind, track, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 });
  assert.deepEqual(trackCounts({ clips: [clip('video', 3), clip('video', 1), clip('audio', 2)] }), { video: 3, audio: 2 });
  assert.deepEqual(trackCounts({ clips: [] }), { video: 0, audio: 0 });
});

test("l'aperçu compte les plans, les pistes et la durée", () => {
  const doc = normalizeDoc({
    ok: true, host: 'resolve', timeline: 'V1', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, missing: ['C:/perdu.mov'],
    clips: [
      { kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 },
      { kind: 'video', track: 2, path: 'C:/b.mov', name: 'b', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 40, tlEnd: 50 },
      { kind: 'audio', track: 1, path: 'C:/m.wav', name: 'm', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 49, tlStart: 0, tlEnd: 50 },
    ],
  });
  assert.deepEqual(docSummary(doc), {
    clips: 3, video: 2, audio: 1, videoTracks: 2, audioTracks: 1, durationFrames: 50, missing: 1,
    mediaLess: 0, graphics: 0, animated: 0, transformed: 0, mixedAudio: 0, retimed: 0,
  });
});

test("l'aperçu garde la liste des sources absentes et ajoute le préflight cible", () => {
  const doc = normalizeDoc({
    ok: true, host: 'resolve', timeline: 'V1', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, missing: ['C:/perdu.mov'],
    clips: [
      { kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0,
        srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 },
    ],
  });
  const summary = transferSummary(doc, 'ppro');
  assert.deepEqual(summary.missing, ['C:/perdu.mov']);
  assert.equal(summary.fidelity.target, 'ppro');
  assert.equal(summary.fidelity.exact, 4);
});

// --- bornes source illisibles ---------------------------------------------------------------

/** Snapshot d'un plan audio dont Premiere ne rend NI les bornes source NI leur version en frames. */
function snapshotWithoutSourceBounds() {
  return {
    app: 'ppro',
    activeSequence: 'Montage',
    sequences: [{
      name: 'Montage', fps: 25, w: 1920, h: 1080,
      tracks: [{
        kind: 'audio', index: 1,
        clips: [{
          name: 'Balance Arme A (3).wav', path: 'C:/son/balance.wav',
          srcFps: null, srcIn: null, srcOut: null, srcInFrame: null, srcOutFrame: null,
          tlStart: 0, tlEnd: 0.6, tlStartFrame: 0, tlEndFrame: 15,
        }],
      }],
    }],
  };
}

test('des bornes source illisibles donnent la DURÉE du plan, jamais une seule frame', () => {
  // Constaté en vrai : deux .wav sortaient en startFrame 0 / endFrame 0, et Resolve refusait de les
  // poser en silence. Écraser la sortie sur l'entrée est toujours faux — l'occupation du plan sur la
  // timeline reste connue, et c'est la meilleure information disponible.
  const doc = docFromAdobeSequence(snapshotWithoutSourceBounds(), 'Montage');
  assert.equal(doc.ok, true);
  const clip = doc.clips[0];
  assert.equal(clip.srcIn, 0);
  assert.equal(clip.srcOut, 14, '15 frames de timeline = 15 frames de source à vitesse normale');
  assert.equal(resolvePlacement(clip, 0).endFrame, 14);
});

test('la déduction tient compte d’une cadence source différente de la timeline', () => {
  const snapshot = snapshotWithoutSourceBounds();
  snapshot.sequences[0].tracks[0].clips[0].srcFps = 50;
  const clip = docFromAdobeSequence(snapshot, 'Montage').clips[0];
  assert.equal(clip.srcOut, 29, '15 frames à 25 i/s = 30 frames à 50 i/s');
});

test('des bornes source lisibles restent prioritaires sur la déduction', () => {
  const snapshot = snapshotWithoutSourceBounds();
  Object.assign(snapshot.sequences[0].tracks[0].clips[0], { srcInFrame: 100, srcOutFrame: 137 });
  const clip = docFromAdobeSequence(snapshot, 'Montage').clips[0];
  assert.equal(clip.srcIn, 100);
  assert.equal(clip.srcOut, 137);
});

test('une cadence aberrante ne contamine jamais la frame-math', () => {
  // Mesuré en vrai : Premiere rend frameRate = 2,754e-8 sur un .wav. Propagée, cette valeur ramenait
  // toute conversion à zéro — les bornes sortaient en 0/0 et Resolve refusait le plan d'une frame
  // ainsi obtenu, ce qui faisait disparaître l'audio du transfert sans un mot.
  const snapshot = snapshotWithoutSourceBounds();
  Object.assign(snapshot.sequences[0].tracks[0].clips[0], { srcFps: 2.75404699046078e-8 });
  const clip = docFromAdobeSequence(snapshot, 'Montage').clips[0];
  assert.equal(clip.fps, 25, 'la cadence de la séquence reprend la main');
  assert.equal(clip.srcOut, 14);
});

test('une borne de sortie SOUS l’entrée est traitée comme illisible', () => {
  const snapshot = snapshotWithoutSourceBounds();
  Object.assign(snapshot.sequences[0].tracks[0].clips[0], { srcInFrame: 0, srcOutFrame: -1 });
  const clip = docFromAdobeSequence(snapshot, 'Montage').clips[0];
  assert.equal(clip.srcOut, 14, 'la durée timeline reprend la main');
});
