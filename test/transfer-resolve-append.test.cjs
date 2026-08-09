// Pose d'un document dans Resolve par l'API. Ces règles ont chacune corrigé une perte SILENCIEUSE :
// des plans comptés comme posés alors que Resolve les refusait, et un ajout qui écrasait le montage
// existant au lieu de se poser après lui.
const test = require('node:test');
const assert = require('node:assert/strict');

const { appendSingle, appendWithFallbacks, clampToSource } = require('../core/transfer/writeResolveAppend');
const { ensureTracks, contentEndFrame, splitMissingMedia } = require('../core/transfer/writeResolveShared');

test('AppendToTimeline qui rend une liste VIDE est un refus, pas une pose', async () => {
  // `[]` est truthy en JS : le tester tel quel comptait chaque refus comme une réussite, et l'audio
  // disparaissait sans qu'aucun compteur ne bouge.
  const mediaPool = { AppendToTimeline: async () => [] };
  assert.deepEqual(await appendSingle(mediaPool, {}, 'plan'), { ok: false, item: null });
});

test('une pose acceptée rend l’item créé', async () => {
  const item = { id: 1 };
  const mediaPool = { AppendToTimeline: async () => [item] };
  assert.deepEqual(await appendSingle(mediaPool, {}, 'plan'), { ok: true, item });
});

test('un refus est retenté en relâchant piste puis type de média, et le dit', async () => {
  const seen = [];
  const mediaPool = {
    AppendToTimeline: async (infos) => {
      seen.push(infos[0]);
      // Refuse tant que la piste est imposée : c'est le comportement des Resolve d'avant 20.2.2 sur
      // une pose « audio seul » dont l'index de piste dépasse le nombre de pistes VIDÉO.
      return Object.prototype.hasOwnProperty.call(infos[0], 'trackIndex') ? [] : [{ id: 9 }];
    },
  };
  const placement = { startFrame: 0, endFrame: 10, recordFrame: 100, trackIndex: 3, mediaType: 2 };
  const result = await appendWithFallbacks(mediaPool, { source: true }, placement, 'son');
  assert.equal(result.ok, true);
  assert.equal(result.relaxed, 'trackIgnored');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].trackIndex, 3);
  assert.equal(seen[1].mediaType, 2, 'seule la piste est relâchée au premier repli');
});

test('un refus total reste un échec, jamais une pose supposée', async () => {
  const mediaPool = { AppendToTimeline: async () => [] };
  const placement = { startFrame: 0, endFrame: 10, recordFrame: 0, trackIndex: 1, mediaType: 1 };
  assert.deepEqual(await appendWithFallbacks(mediaPool, {}, placement, 'plan'), { ok: false, item: null, relaxed: null });
});

test('une piste audio est demandée avec son sous-type avant le repli sans sous-type', async () => {
  const calls = [];
  let count = 1;
  const timeline = {
    GetTrackCount: async () => count,
    AddTrack: async (type, subType) => { calls.push([type, subType]); count += 1; return true; },
  };
  assert.equal(await ensureTracks(timeline, 'audio', 3), 3);
  assert.deepEqual(calls, [['audio', 'stereo'], ['audio', 'stereo']]);
});

test('une version sans sous-type audio reste servie par le repli', async () => {
  const calls = [];
  let count = 1;
  const timeline = {
    GetTrackCount: async () => count,
    AddTrack: async (type, subType) => {
      calls.push([type, subType]);
      if (subType) return false;
      count += 1;
      return true;
    },
  };
  assert.equal(await ensureTracks(timeline, 'audio', 2), 2);
  assert.deepEqual(calls, [['audio', 'stereo'], ['audio', undefined]]);
});

test('l’ajout part APRÈS le contenu existant, pas à la position absolue du document', async () => {
  const items = { video: { 1: [{ GetEnd: async () => 420 }, { GetEnd: async () => 610 }] }, audio: { 1: [{ GetEnd: async () => 500 }] } };
  const timeline = { GetItemListInTrack: async (kind, track) => items[kind][track] || [] };
  assert.equal(await contentEndFrame(timeline, { video: 1, audio: 1 }, 86400), 86400);
  assert.equal(await contentEndFrame(timeline, { video: 1, audio: 1 }, 0), 610);
});

test('un fichier absent du disque est écarté avant tout envoi à un hôte', () => {
  const { usable, missing } = splitMissingMedia([
    { path: __filename }, { path: 'C:/nulle/part/absent.mov' }, { path: 'C:/nulle/part/absent.mov' },
  ]);
  assert.equal(usable.length, 1);
  assert.deepEqual(missing, ['C:/nulle/part/absent.mov']);
});

test('les bornes source sont ramenées dans la longueur que Resolve connaît', () => {
  // Premiere n'expose PAS la longueur de ses sources (`srcFrames` vaut 0) et compte l'audio dans sa
  // propre base de temps : une borne au-delà de la fin est refusée EN SILENCE par AppendToTimeline.
  const placement = { startFrame: 0, endFrame: 400, recordFrame: 0, trackIndex: 1, mediaType: 2 };
  const bounded = clampToSource(placement, 120);
  assert.equal(bounded.clamped, true);
  assert.equal(bounded.placement.endFrame, 119);
  assert.equal(bounded.placement.startFrame, 0);
});

test('une borne d’entrée au-delà de la fin est ramenée avec elle, jamais inversée', () => {
  const bounded = clampToSource({ startFrame: 300, endFrame: 400, recordFrame: 0, trackIndex: 1, mediaType: 2 }, 120);
  assert.equal(bounded.placement.startFrame, 119);
  assert.equal(bounded.placement.endFrame, 119);
});

test('une longueur inconnue ne touche à rien', () => {
  const placement = { startFrame: 5, endFrame: 400, recordFrame: 0, trackIndex: 1, mediaType: 2 };
  assert.deepEqual(clampToSource(placement, 0), { placement, clamped: false });
});

test('un plan posé est retrouvé par son IDENTITÉ, pas par l’objet rendu', () => {
  // Le proxy du pont Python fabrique un objet NEUF à chaque décodage : comparer l'objet rendu par
  // AppendToTimeline à celui relu sur la timeline ne matchait jamais, donc aucune propriété
  // (zoom, rotation, opacité) n'était appliquée à un plan pourtant bien posé.
  const { locateResolveClip } = require('../core/transfer/resolveLocate');
  const placed = { marker: 'proxy-a' };
  const snapshots = [{
    item: placed, id: 'ti-42', kind: 'video', track: 1, path: 'c:/a.mov',
    start: 999, end: 1234, sourceStart: 77, sourceEnd: 88,
  }];
  const clip = { kind: 'video', track: 1, path: 'C:/A.mov', srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 };
  const placement = { startFrame: 0, endFrame: 9, recordFrame: 0, trackIndex: 1, mediaType: 1 };
  // Ni la position ni les bornes source ne correspondent : seule l'identité peut trancher.
  const found = locateResolveClip(snapshots, clip, placement, 'ti-42');
  assert.equal(found.ok, true);
  assert.equal(found.item, placed);
  assert.equal(found.via, 'appendReturn');
});

test('des bornes source relues autrement n’empêchent pas de retrouver le plan', () => {
  // GetSourceStartFrame peut être ancré sur le Start TC du média : l'empreinte stricte échoue alors
  // que le plan est bien le bon. Média, piste et position suffisent quand il n'y a qu'un candidat.
  const { locateResolveClip } = require('../core/transfer/resolveLocate');
  const item = { marker: 'proxy-b' };
  const snapshots = [{
    item, id: '', kind: 'video', track: 1, path: 'c:/a.mov',
    start: 100, end: 110, sourceStart: 86400, sourceEnd: 86410,
  }];
  const clip = { kind: 'video', track: 1, path: 'C:/a.mov', srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 };
  const found = locateResolveClip(snapshots, clip, { startFrame: 0, endFrame: 9, recordFrame: 100, trackIndex: 1, mediaType: 1 });
  assert.equal(found.ok, true);
  assert.equal(found.via, 'position');
});

test('deux candidats à la même position restent ambigus', () => {
  const { locateResolveClip } = require('../core/transfer/resolveLocate');
  const base = { kind: 'video', track: 1, path: 'c:/a.mov', start: 100, end: 110, sourceStart: NaN, sourceEnd: NaN, id: '' };
  const clip = { kind: 'video', track: 1, path: 'C:/a.mov', srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 };
  const found = locateResolveClip([{ ...base, item: {} }, { ...base, item: {} }], clip,
    { startFrame: 0, endFrame: 9, recordFrame: 100, trackIndex: 1, mediaType: 1 });
  assert.equal(found.ok, false);
  assert.equal(found.reason, 'ambiguousTimelineItem');
});

test('une longueur de 1 image rendue par Resolve n’est pas une longueur', () => {
  // Resolve ne compte pas un média audio en images et rend couramment 0 ou 1 : la croire ramenait
  // le plan à une seule frame, que AppendToTimeline refuse ensuite.
  const placement = { startFrame: 0, endFrame: 8, recordFrame: 0, trackIndex: 1, mediaType: 2 };
  assert.deepEqual(clampToSource(placement, 1), { placement, clamped: false });
  assert.deepEqual(clampToSource(placement, 0), { placement, clamped: false });
});
