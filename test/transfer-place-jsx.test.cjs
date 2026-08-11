// Pose ABSOLUE des plans dans Premiere Pro et After Effects. Les deux scripts hôtes sont de l'ES3
// sans dépendance : on les évalue dans un contexte stubé et on exerce leur frame-math POUR DE VRAI
// (même approche que test/adobe-timeline-live.test.cjs), plutôt que de la relire en regex.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const TICKS_PER_SEC = 254016000000;

// ---- Premiere Pro --------------------------------------------------------------------------------

let trackItemId = 0;

function fakeTrack() {
  const clips = { numItems: 0 };
  const track = {
    clips,
    placed: [],
    overwriteClip(item, ticks) {
      const start = Number(ticks) / TICKS_PER_SEC;
      const inPoint = Number(item.lastIn ?? item.getInPoint().seconds);
      const outPoint = Number(item.lastOut ?? item.getOutPoint().seconds);
      const placed = {
        nodeId: `track-${++trackItemId}`,
        projectItem: item,
        start: { seconds: start },
        end: { seconds: start + outPoint - inPoint },
        inPoint: { seconds: inPoint },
        outPoint: { seconds: outPoint },
        components: item.components || { numItems: 0 },
      };
      track.placed.push({ item, ticks: String(ticks), trackItem: placed });
      clips[clips.numItems] = placed;
      clips.numItems += 1;
      return true;
    },
  };
  return track;
}

function trackCollection(count) {
  const list = [];
  for (let i = 0; i < count; i++) list.push(fakeTrack());
  list.numTracks = count;
  return list;
}

function fakeSequence(name, fps, videoTracks, audioTracks) {
  const seq = {
    name,
    sequenceID: name,
    timebase: String(TICKS_PER_SEC / fps),
    videoTracks: trackCollection(videoTracks),
    audioTracks: trackCollection(audioTracks),
    settings: { videoFrameRate: TICKS_PER_SEC / fps, videoFrameWidth: 1920, videoFrameHeight: 1080 },
  };
  // Premiere 15+ : getSettings/setSettings est la seule voie publique pour la cadence de séquence.
  seq.getSettings = () => ({ ...seq.settings });
  seq.setSettings = (s) => { seq.settings = { ...s }; seq.timebase = String(s.videoFrameRate); };
  return seq;
}

/** Plan déjà présent sur une piste (celui que `createNewSequenceFromClips` dépose comme gabarit). */
function seedClip(track) {
  const clips = track.clips;
  const item = {
    start: { seconds: 0 }, end: { seconds: 1 },
    remove() {
      for (let i = 0; i < clips.numItems; i++) {
        if (clips[i] !== item) continue;
        for (let j = i; j < clips.numItems - 1; j++) clips[j] = clips[j + 1];
        delete clips[clips.numItems - 1];
        clips.numItems -= 1;
        return true;
      }
      return false;
    },
  };
  clips[clips.numItems] = item;
  clips.numItems += 1;
  return item;
}

/** ProjectItem minimal : mémorise les In/Out posés pour vérifier qu'ils sont bien rendus. */
function fakeProjectItem(mediaPath, inSec = 0, outSec = 0) {
  return {
    name: mediaPath,
    getMediaPath: () => mediaPath,
    getInPoint: () => ({ seconds: inSec }),
    getOutPoint: () => ({ seconds: outSec }),
    setInPoint(v) { this.lastIn = v; },
    setOutPoint(v) { this.lastOut = v; },
    restored: [],
  };
}

function loadPpro({ paths = [], onDisk = null, sequences = [], active = null, video = 2, audio = 2, itemFactory = null, fromClips = true } = {}) {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  const items = new Map(paths.map((p) => [p, itemFactory ? itemFactory(p) : fakeProjectItem(p)]));
  const created = [];
  const fromClipsCalls = [];
  const imported = [];
  const project = {
    rootItem: { children: { numItems: 0 } },
    sequences: Object.assign(sequences.slice(0), { numSequences: sequences.length }),
    activeSequence: active,
    findItemsMatchingMediaPath: (p) => (items.has(p) ? [items.get(p)] : []),
    importFiles: (list) => { imported.push(list[0]); return true; },
    openSequence: () => {},
    // Dans Premiere récent, cet appel OUVRE la boîte « Nouvelle séquence » et ignore le nom : il ne
    // doit servir que de dernier recours.
    createNewSequence: (name) => fakeSequence(name, 25, video, audio),
  };
  // Premiere ajoute la séquence créée à la collection du projet ; le script y REPREND son objet,
  // celui rendu par la création n'étant pas rafraîchi après une suppression ou un réglage.
  const publish = (seq) => {
    project.sequences[project.sequences.numSequences] = seq;
    project.sequences.numSequences += 1;
    created.push(seq);
    return seq;
  };
  const plainCreate = project.createNewSequence;
  project.createNewSequence = (name) => publish(plainCreate(name));
  if (fromClips) {
    project.createNewSequenceFromClips = (name, clipsArray, bin) => {
      const seq = fakeSequence(name, 25, video, audio);
      seedClip(seq.videoTracks[0]); // le gabarit atterrit sur V1
      fromClipsCalls.push({ name, clips: clipsArray, bin });
      return publish(seq);
    };
  }
  const sandbox = {
    app: { project, enableQE: () => { throw new Error('QE indisponible'); } },
    NRJSON: { stringify: JSON.stringify },
    $: {},
    File: function (p) { this.exists = onDisk ? onDisk.indexOf(String(p)) >= 0 : true; },
    Time: function () {
      this.seconds = 0;
      this.ticks = '0';
      this.setSecondsAsFraction = (numerator, denominator) => {
        this.seconds = Number(numerator) / Number(denominator);
        this.ticks = String(Math.round(this.seconds * TICKS_PER_SEC));
      };
    },
    qe: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, project, items, created, imported, fromClipsCalls };
}

const clip = (over = {}) => ({
  path: 'C:/a.mov', name: 'plan', kind: 'video', track: 1, fps: 25,
  inFrame: 0, outFrame: 24, tlStart: 0, ...over,
});

test('Premiere : le script hôte évite les virgules finales rejetées par ExtendScript', () => {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  assert.equal(/,\s*\)/m.test(source), false);
});

test('Premiere : les plans sont posés à leur position absolue, trous compris', () => {
  const { sandbox, created } = loadPpro({ paths: ['C:/a.mov'] });
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'Transfert', clips: [clip({ tlStart: 0 }), clip({ tlStart: 4 })],
  }));

  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  assert.equal(out.created, true);
  const placed = created[0].videoTracks[0].placed;
  // Les ticks sont un multiple exact de la durée d'une frame : 4 s à 25 i/s = 100 frames.
  assert.deepEqual(placed.map((p) => p.ticks), ['0', String(4 * TICKS_PER_SEC)]);
});

test('Premiere : la séquence neuve est créée SANS boîte de dialogue et porte le nom demandé', () => {
  const { sandbox, created, fromClipsCalls, items } = loadPpro({ paths: ['C:/a.mov'] });
  const out = JSON.parse(sandbox.NR_ppro_place({ name: 'test', clips: [clip()] }));

  assert.equal(out.ok, true);
  // createNewSequence ouvre « Nouvelle séquence » et rebaptise la séquence : il ne doit pas être appelé.
  assert.equal(fromClipsCalls.length, 1);
  assert.equal(fromClipsCalls[0].name, 'test');
  assert.equal(fromClipsCalls[0].clips[0], items.get('C:/a.mov'), 'le gabarit est le premier plan vidéo');
  assert.equal(out.timeline, 'test');
  // Le plan gabarit déposé par Premiere est retiré : il ne reste que le plan posé par le transfert.
  assert.equal(created[0].videoTracks[0].clips.numItems, 1);
  assert.equal(created[0].videoTracks[0].placed.length, 1);
});

test('Premiere : la pose passe par l’objet séquence du PROJET, pas par celui rendu à la création', () => {
  const { sandbox, project, created } = loadPpro({ paths: ['C:/a.mov'] });
  // Objet périmé : ses pistes acceptent l'appel et n'écrivent rien — exactement ce que Premiere rend
  // après une suppression de plans (timeline vide alors que la pose se déclarait réussie).
  const live = created;
  const base = project.createNewSequenceFromClips;
  project.createNewSequenceFromClips = (name, clipsArray, bin) => {
    const real = base(name, clipsArray, bin);
    const stale = { ...real, videoTracks: trackCollection(2), audioTracks: trackCollection(2) };
    for (let t = 0; t < stale.videoTracks.numTracks; t++) stale.videoTracks[t].overwriteClip = () => true;
    for (let t = 0; t < stale.audioTracks.numTracks; t++) stale.audioTracks[t].overwriteClip = () => true;
    return stale;
  };
  const out = JSON.parse(sandbox.NR_ppro_place({ name: 'test', clips: [clip()] }));

  assert.equal(out.ok, true);
  assert.equal(live[0].videoTracks[0].placed.length, 1, 'le plan atterrit dans la séquence vivante');
});

test('Premiere : une pose qui n’écrit rien est comptée comme un échec, pas comme un succès', () => {
  const { sandbox, project } = loadPpro({ paths: ['C:/a.mov'] });
  const base = project.createNewSequenceFromClips;
  project.createNewSequenceFromClips = (name, clipsArray, bin) => {
    const seq = base(name, clipsArray, bin);
    // overwriteClip dit oui et ne touche à rien : le cas qui déclarait 7 plans posés sur une
    // timeline restée vide.
    for (let t = 0; t < seq.videoTracks.numTracks; t++) seq.videoTracks[t].overwriteClip = () => true;
    return seq;
  };
  const out = JSON.parse(sandbox.NR_ppro_place({ name: 'test', clips: [clip()] }));

  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'NO_SHOTS_INSERTED');
  assert.equal(out.failed, 1);
  const media = out.report.items.filter((i) => i.property === 'clip.media');
  assert.equal(media[0].reason, 'overwriteNoOp');
});

test('Premiere : sans createNewSequenceFromClips, on retombe sur createNewSequence', () => {
  const { sandbox, created, project } = loadPpro({ paths: ['C:/a.mov'], fromClips: false });
  assert.equal(project.createNewSequenceFromClips, undefined);
  const out = JSON.parse(sandbox.NR_ppro_place({ name: 'test', clips: [clip()] }));
  assert.equal(out.ok, true);
  assert.equal(created.length, 1);
});

test('Premiere : la séquence neuve prend la CADENCE du document, pas celle du gabarit', () => {
  const { sandbox, created } = loadPpro({ paths: ['C:/a.mov'] });
  // Document à 30 i/s, gabarit à 25 : sans réglage, 1,5 s tomberait sur la grille 25 de la séquence.
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'test', fps: 30, width: 3840, height: 2160,
    clips: [clip({ fps: 30, outFrame: 29, tlStart: 1.5 })],
  }));

  assert.equal(out.sequenceFpsApplied, true);
  assert.equal(out.sequenceFpsMismatch, undefined);
  assert.equal(Math.round(out.sequenceFps), 30);
  assert.equal(created[0].settings.videoFrameWidth, 3840);
  const ticks = Number(created[0].videoTracks[0].placed[0].ticks);
  assert.equal(ticks, Math.round(1.5 * TICKS_PER_SEC), '1,5 s = 45 images pile à 30 i/s');
});

test('Premiere : une cadence de séquence imposable signale le décalage', () => {
  const { sandbox } = loadPpro({ paths: ['C:/a.mov'] });
  // Séquence figée à 25 (setSettings absent sur les vieilles versions) alors que le document est à 30.
  const project = sandbox.app.project;
  const base = project.createNewSequenceFromClips;
  project.createNewSequenceFromClips = (name, clipsArray, bin) => {
    const seq = base(name, clipsArray, bin);
    delete seq.getSettings;
    delete seq.setSettings;
    return seq;
  };
  const out = JSON.parse(sandbox.NR_ppro_place({ name: 'test', fps: 30, clips: [clip({ fps: 30 })] }));

  assert.equal(out.sequenceFpsApplied, undefined);
  assert.equal(out.sequenceFpsMismatch, true);
});

test('Premiere : chaque plan atterrit sur sa piste, vidéo comme audio', () => {
  const { sandbox, created } = loadPpro({ paths: ['C:/a.mov', 'C:/m.wav'], video: 3, audio: 3 });
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T',
    clips: [
      clip({ track: 2 }),
      clip({ path: 'C:/m.wav', kind: 'audio', track: 3, outFrame: 99 }),
    ],
  }));

  assert.equal(out.count, 2);
  const seq = created[0];
  assert.equal(seq.videoTracks[1].placed.length, 1, 'la piste V2 porte le plan vidéo');
  assert.equal(seq.videoTracks[0].placed.length, 0);
  assert.equal(seq.audioTracks[2].placed.length, 1, 'la piste A3 porte le plan audio');
});

test('Premiere : une piste inexistante est rabattue et signalée', () => {
  // QE échoue dans le bac à sable (comme sur un hôte qui refuse d'ajouter des pistes) : le plan doit
  // atterrir sur la dernière piste plutôt que disparaître, et le rapport doit le dire.
  const { sandbox, created } = loadPpro({ paths: ['C:/a.mov'], video: 2 });
  const out = JSON.parse(sandbox.NR_ppro_place({ name: 'T', clips: [clip({ track: 5 })] }));

  assert.equal(out.ok, true);
  assert.equal(out.tracksClamped, true);
  assert.equal(created[0].videoTracks[1].placed.length, 1);
  const track = out.report.items.find((item) => item.property === 'clip.track');
  assert.equal(track.status, 'approximated');
  assert.equal(track.reason, 'trackClamped');
  assert.equal(track.expected, 5);
  assert.equal(track.actual, 2);
});

test('Premiere : les In/Out des sources touchées sont rendus au projet', () => {
  // Poser un trim écrase les bornes du ProjectItem : sans restitution, le rush reste tronqué dans
  // le Media Pool après un transfert.
  const { sandbox, items } = loadPpro({ paths: ['C:/a.mov'] });
  const source = items.get('C:/a.mov');
  source.setInPoint(2);
  source.setOutPoint(9);
  source.getInPoint = () => ({ seconds: 2 });
  source.getOutPoint = () => ({ seconds: 9 });

  sandbox.NR_ppro_place({ name: 'T', clips: [clip({ inFrame: 100, outFrame: 199 })] });

  assert.equal(source.lastIn, 2, 'In d’origine rendu');
  assert.equal(source.lastOut, 9, 'Out d’origine rendu');
});

test('Premiere : une même source restaure séparément ses marques vidéo et audio', () => {
  const marks = {
    1: { in: 2, out: 9 },
    2: { in: 4, out: 11 },
  };
  const { sandbox, items } = loadPpro({ paths: ['C:/a.mov'], itemFactory: (path) => {
    const item = fakeProjectItem(path);
    item.getInPoint = (mediaType) => ({ seconds: marks[mediaType].in });
    item.getOutPoint = (mediaType) => ({ seconds: marks[mediaType].out });
    item.setInPoint = (value, mediaType) => { marks[mediaType].in = value; };
    item.setOutPoint = (value, mediaType) => { marks[mediaType].out = value; };
    return item;
  } });

  sandbox.NR_ppro_place({ name: 'T', clips: [
    clip({ kind: 'video' }),
    clip({ kind: 'audio' }),
  ] });

  assert.deepEqual(marks, { 1: { in: 2, out: 9 }, 2: { in: 4, out: 11 } });
  assert.ok(items.get('C:/a.mov'));
});

test('Premiere : append tient compte des pistes audio seules', () => {
  const existing = fakeSequence('Montage audio', 25, 2, 2);
  existing.audioTracks[0].clips.numItems = 1;
  existing.audioTracks[0].clips[0] = { end: { seconds: 12 } };
  const { sandbox } = loadPpro({ paths: ['C:/a.mov'], sequences: [existing], active: existing });

  sandbox.NR_ppro_place({ name: 'T', mode: 'append', timelineName: 'Montage audio', clips: [clip()] });

  assert.equal(existing.videoTracks[0].placed[0].ticks, String(12 * TICKS_PER_SEC));
});

test('Premiere : un fichier absent du disque ne part jamais à l’import', () => {
  // Importer un fichier manquant ouvre une modale Premiere qui gèle ExtendScript jusqu'au timeout.
  const { sandbox, imported } = loadPpro({ paths: [], onDisk: [] });
  const out = JSON.parse(sandbox.NR_ppro_place({ name: 'T', clips: [clip({ path: 'C:/perdu.mov' })] }));

  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'MEDIA_MISSING');
  assert.deepEqual(imported, []);
});

test('Premiere : un ajout à une séquence existante se pose après le contenu', () => {
  const existing = fakeSequence('Montage', 25, 2, 2);
  existing.videoTracks[0].clips.numItems = 1;
  existing.videoTracks[0].clips[0] = { end: { seconds: 10 } };
  const { sandbox } = loadPpro({ paths: ['C:/a.mov'], sequences: [existing], active: existing });

  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', mode: 'append', timelineName: 'Montage', clips: [clip({ tlStart: 0 })],
  }));

  assert.equal(out.created, false);
  assert.equal(out.timeline, 'Montage');
  assert.equal(existing.videoTracks[0].placed[0].ticks, String(10 * TICKS_PER_SEC));
});

const timeOf = (seconds) => ({ seconds, ticks: String(Math.round(seconds * TICKS_PER_SEC)) });
/** Premiere ÉCRIT ses clés en secondes (nombre) et les REND en objets `Time` : le faux fait pareil. */
const secOf = (time) => {
  if (typeof time === 'number') return time;
  if (time && typeof time.seconds === 'number') return time.seconds;
  return Number(time && time.ticks) / TICKS_PER_SEC;
};

function fakeParam(displayName, initial, initialKeys = []) {
  let value = initial;
  let varying = initialKeys.length > 0;
  const keys = initialKeys.map(secOf);
  const keyValues = new Map(keys.map((seconds) => [seconds, initial]));
  const param = {
    displayName,
    areKeyframesSupported: () => true,
    isTimeVarying: () => varying,
    setTimeVarying: (next) => { varying = next; return true; },
    setValue: (next) => { value = next; return true; },
    getValue: () => value,
    getKeys: () => keys.map(timeOf),
    addKey: (time) => { keys.push(secOf(time)); return true; },
    removeKey: (time) => {
      const index = keys.indexOf(secOf(time));
      if (index >= 0) keys.splice(index, 1);
      keyValues.delete(secOf(time));
      return true;
    },
    setValueAtKey: (time, next) => { keyValues.set(secOf(time), next); value = next; return true; },
    getValueAtKey: (time) => keyValues.has(secOf(time)) ? keyValues.get(secOf(time)) : value,
    getValueAtTime: (time) => keyValues.has(secOf(time)) ? keyValues.get(secOf(time)) : value,
  };
  Object.defineProperty(param, 'keys', { get: () => keys.map(timeOf) });
  return param;
}

function richProjectItem(mediaPath) {
  const item = fakeProjectItem(mediaPath);
  const stale = { seconds: 9, ticks: String(9 * TICKS_PER_SEC) };
  const position = fakeParam('Position', [960, 540], [stale]);
  const scale = fakeParam('Scale', 100);
  const scaleWidth = fakeParam('Scale Width', 100);
  const uniformScale = fakeParam('Uniform Scale', true);
  const opacity = fakeParam('Opacity', 100);
  item.components = Object.assign([
    { matchName: 'AE.ADBE Motion', properties: Object.assign(
      [position, scale, scaleWidth, uniformScale], { numItems: 4 },
    ) },
    { matchName: 'AE.ADBE Opacity', properties: Object.assign([opacity], { numItems: 1 }) },
  ], { numItems: 2 });
  item.params = { position, scale, scaleWidth, uniformScale, opacity };
  return item;
}

test('Premiere : transform, opacité et keyframes sont appliqués puis relus sur le TrackItem créé', () => {
  const { sandbox, items } = loadPpro({ paths: ['C:/a.mov'], itemFactory: richProjectItem });
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25, clips: [clip({
      video: { transform: {
        position: { value: { x: 100, y: -50 }, keyframes: [
          { frame: 0, value: { x: 100, y: -50 } },
          { frame: 25, value: { x: 300, y: 50 } },
        ] },
        scale: { value: { x: 1.5, y: 1.5 } },
        opacity: { value: 50 },
      } },
    })],
  }));

  const params = items.get('C:/a.mov').params;
  assert.equal(out.ok, true);
  assert.deepEqual(params.scale.getValue(), 150);
  assert.equal(params.opacity.getValue(), 50);
  assert.deepEqual(params.position.keys.map((key) => key.seconds), [0, 1]);
  assert.equal(out.report.items.some((item) => item.property === 'video.position' && item.status === 'applied'), true);
  assert.equal(out.report.items.some((item) => item.property === 'video.position.keyframes' && item.status === 'applied'), true);
});

test('Premiere : les clés partent du point d’entrée SOURCE, en secondes, pas d’un objet Time', () => {
  const { sandbox, items } = loadPpro({ paths: ['C:/a.mov'], itemFactory: richProjectItem });
  const seen = [];
  const param = items.get('C:/a.mov').params.position;
  const addKey = param.addKey;
  param.addKey = (time) => { seen.push(time); return addKey(time); };
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25, clips: [clip({
      inFrame: 10, outFrame: 60, tlStart: 4, // posé à 4 s, entrant à 0,4 s dans sa source
      video: { transform: { position: {
        value: { x: 0, y: 0 },
        keyframes: [{ frame: 0, value: { x: 0, y: 0 } }, { frame: 25, value: { x: 100, y: 0 } }],
      } } },
    })],
  }));

  assert.equal(out.ok, true);
  // Un objet `Time` passé à addKey ne lève rien et empile TOUTES les clés au temps 0 : le type est
  // donc aussi important que la valeur.
  assert.deepEqual(seen.map((time) => typeof time), ['number', 'number']);
  assert.deepEqual(param.keys.map((key) => key.seconds), [0.4, 1.4]);
  assert.equal(out.report.items.some((i) => i.property === 'video.position.keyframes' && i.status === 'applied'), true);
});

test('Premiere : les keyframes gardent le temps source quand la cadence cible diffère', () => {
  const { sandbox, items } = loadPpro({ paths: ['C:/a.mov'], itemFactory: richProjectItem });
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 30, clips: [clip({
      timelineFps: 24,
      video: { transform: { position: {
        value: { x: 0, y: 0 },
        keyframes: [{ frame: 24, value: { x: 100, y: 0 } }],
      } } },
    })],
  }));

  assert.equal(out.ok, true);
  assert.deepEqual(items.get('C:/a.mov').params.position.keys.map((key) => key.seconds), [1]);
});

test('Premiere : overwrite undefined avec compte stable reste réconcilié', () => {
  const { sandbox } = loadPpro();
  const source = fakeProjectItem('C:/a.mov');
  const existing = {
    nodeId: 'stable', projectItem: source,
    start: { seconds: 5 }, end: { seconds: 6 },
    inPoint: { seconds: 0 }, outPoint: { seconds: 1 },
  };
  const clips = { 0: existing, numItems: 1 };
  const track = {
    clips,
    overwriteClip() {
      existing.start.seconds = 0;
      existing.end.seconds = 1;
      return undefined;
    },
  };
  const seq = fakeSequence('T', 25, 1, 1);
  seq.videoTracks[0] = track;
  const placed = sandbox.nrPproOverwriteLocated(seq, 'video', 0, source, 0, { inSec: 0, outSec: 1 });

  assert.equal(placed.ok, true);
  assert.equal(placed.item, existing);
  assert.equal(placed.locate.method, 'reconciled');
});

test('Premiere : une pose sans bornes lisibles ne prétend pas vérifier le trim', () => {
  const { sandbox } = loadPpro();
  const source = fakeProjectItem('C:/a.mov');
  const existing = {
    nodeId: 'stable', projectItem: source,
    start: { seconds: 0 }, end: { seconds: 1 },
    inPoint: null, outPoint: null,
  };
  const track = { clips: { 0: existing, numItems: 1 }, overwriteClip: () => undefined };
  const seq = fakeSequence('T', 25, 1, 1);
  seq.videoTracks[0] = track;
  const placed = sandbox.nrPproOverwriteLocated(seq, 'video', 0, source, 0, { inSec: 0, outSec: 1 });

  assert.equal(placed.ok, true);
  assert.equal(placed.locate.trimReadback, false);
});

test('Premiere : le subclip vidéo désactive bien la prise audio', () => {
  const { sandbox } = loadPpro();
  let args;
  const item = {
    name: 'rush',
    createSubClip(...values) { args = values; return {}; },
  };
  assert.ok(sandbox.nrPproVideoOnlySubclip(item, 1, 2, '1'));
  assert.deepEqual(Array.from(args.slice(3)), [0, 1, 0]);
});

test('Premiere : QE ne modifie pas une autre séquence active', () => {
  const target = fakeSequence('Cible', 25, 1, 1);
  const active = fakeSequence('Autre', 25, 1, 1);
  let calls = 0;
  const { sandbox, project } = loadPpro({ active });
  sandbox.app.enableQE = () => {};
  sandbox.qe = { project: { getActiveSequence: () => ({ name: 'Autre', addTracks: () => { calls += 1; } }) } };
  project.activeSequence = active;

  assert.equal(sandbox.nrPproAddTracks(target, 'video', 2), false);
  assert.equal(calls, 0);
});

test('Premiere : les pistes manquantes sont créées EN FIN de séquence, avant la première pose', () => {
  const { sandbox, project, created } = loadPpro({ paths: ['C:/a.mov'], video: 2, audio: 1 });
  const calls = [];
  sandbox.app.enableQE = () => {};
  // QE fait grandir la collection ; on note l'index d'insertion demandé et l'état de la séquence.
  const grow = (seq, kind, count) => {
    const list = seq[kind === 'audio' ? 'audioTracks' : 'videoTracks'];
    for (let i = 0; i < count; i++) { list[list.numTracks] = fakeTrack(); list.numTracks += 1; }
  };
  sandbox.qe = { project: { getActiveSequence: () => ({
    name: created[0] ? created[0].name : '',
    addTracks: (numV, afterV, numA, afterA) => {
      const seq = created[0];
      const placedSoFar = seq.videoTracks.reduce((n, t) => n + t.placed.length, 0);
      if (numV) calls.push({ kind: 'video', need: numV, at: afterV, have: seq.videoTracks.numTracks, placedSoFar });
      if (numA) calls.push({ kind: 'audio', need: numA, at: afterA, have: seq.audioTracks.numTracks, placedSoFar });
      if (numV) grow(seq, 'video', numV);
      if (numA) grow(seq, 'audio', numA);
    },
  }) } };
  // QE ne travaille que sur la séquence ACTIVE : l'ouverture doit donc la désigner, comme Premiere.
  project.openSequence = (id) => {
    project.activeSequence = created.find((seq) => String(seq.sequenceID) === String(id)) || null;
  };
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25,
    clips: [clip({ track: 1 }), clip({ track: 4, tlStart: 4 }), clip({ path: 'C:/a.mov', kind: 'audio', track: 2 })],
  }));

  assert.equal(out.ok, true);
  assert.equal(out.count, 3);
  // Une seule vague d'ajouts par type, AVANT toute pose : ajouter une piste en cours de montage
  // pousse le contenu déjà posé d'un cran (V3 vidé, son plan retrouvé sur V4).
  assert.deepEqual(calls.map((c) => c.placedSoFar), [0, 0]);
  const video = calls.find((c) => c.kind === 'video');
  assert.deepEqual({ need: video.need, at: video.at }, { need: 2, at: video.have },
    'les pistes s’ajoutent APRÈS la dernière, pas avant');
});

test('Premiere : la vitesse passe par QE et est vérifiée sur la durée obtenue', () => {
  const { sandbox, project, created } = loadPpro({ paths: ['C:/a.mov'] });
  const speeds = [];
  sandbox.app.enableQE = () => {};
  // Un plan retimé occupe sa longueur SOURCE tant que la vitesse n'est pas posée : le faux QE
  // raccourcit le plan comme Premiere le ferait, ce qui rend la relecture significative.
  const qeItem = (placed) => ({
    start: { seconds: placed.trackItem.start.seconds },
    setSpeed: (ratio, duration, reverse) => {
      speeds.push({ ratio, reverse });
      const span = placed.trackItem.outPoint.seconds - placed.trackItem.inPoint.seconds;
      placed.trackItem.end = { seconds: placed.trackItem.start.seconds + span / ratio };
    },
  });
  sandbox.qe = { project: { getActiveSequence: () => ({
    name: created[0] ? created[0].name : '',
    getVideoTrackAt: (index) => ({
      numItems: created[0].videoTracks[index].placed.length,
      getItemAt: (i) => qeItem(created[0].videoTracks[index].placed[i]),
    }),
  }) } };
  project.openSequence = (id) => {
    project.activeSequence = created.find((seq) => String(seq.sequenceID) === String(id)) || null;
  };
  // 35 images de source tenues sur 29 images de timeline : accélération ×1,2069.
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25,
    clips: [clip({
      inFrame: 0, outFrame: 34, tlStart: 0, tlEnd: 29 / 25,
      timing: { speed: { numerator: 35, denominator: 29 }, reverse: false, freeze: false },
    })],
  }));

  assert.equal(out.ok, true);
  assert.equal(speeds.length, 1);
  assert.ok(Math.abs(speeds[0].ratio - 35 / 29) < 1e-9);
  const speed = out.report.items.find((item) => item.property === 'timing.speed');
  assert.equal(speed.status, 'applied', speed.reason);
  assert.equal(speed.readback, true);
});

test('Premiere : sans QE, la vitesse ET l’inversion sont déclarées perdues', () => {
  const { sandbox } = loadPpro({ paths: ['C:/a.mov'] });
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25,
    clips: [clip({ timing: { speed: { numerator: 2, denominator: 1 }, reverse: true, freeze: false } })],
  }));

  const lost = out.report.items.filter((item) => item.status === 'unsupported');
  assert.deepEqual(lost.map((item) => item.property).sort(), ['timing.reverse', 'timing.speed']);
  assert.equal(lost[0].reason, 'premiereQeUnavailable');
});

// --- Titres : `importMGT` est la SEULE voie qui crée un vrai graphique essentiel ----------------
// Aucune API n'écrit un titre à partir de rien, et l'import du générateur FCP7 hérité rend un objet
// dont ni le corps ni le multi-ligne ne suivent (mesuré sur Premiere 26.3). Le modèle porte le
// style, le document ne fournit que les mots.
function mgtSequence(seq, imports) {
  seq.importMGT = (mogrt, ticks, videoTrack, audioTrack) => {
    const text = { value: '', setValue(next) { this.value = next; return true; }, getValue() { return this.value; } };
    const opacity = { setValue: () => true, getValue: () => 100 }; // contrôle NON textuel
    const item = {
      start: { seconds: Number(ticks) / TICKS_PER_SEC },
      end: { seconds: Number(ticks) / TICKS_PER_SEC + 5 }, // durée du modèle
      getMGTComponent: () => ({ properties: Object.assign([text, opacity], { numItems: 2 }) }),
    };
    imports.push({ mogrt, ticks, videoTrack, audioTrack, item, text });
    return item;
  };
}

test('Premiere : un titre est posé par le modèle .mogrt, texte remplacé et durée réglée', () => {
  const { sandbox, created } = loadPpro({ paths: ['C:/a.mov'], video: 3 });
  const imports = [];
  const base = sandbox.app.project.createNewSequenceFromClips;
  sandbox.app.project.createNewSequenceFromClips = (name, clips, bin) => {
    const seq = base(name, clips, bin);
    mgtSequence(seq, imports);
    return seq;
  };
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25, mogrt: 'C:/panneau/assets/netsurush-title.mogrt',
    clips: [clip()],
    graphics: [{ track: 3, text: 'test beta\ryes', tlStart: 6.6, tlEnd: 11.6 }],
  }));

  assert.equal(out.ok, true);
  assert.equal(out.titles, 1);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].mogrt, 'C:/panneau/assets/netsurush-title.mogrt');
  assert.equal(imports[0].videoTrack, 2, 'piste 3 du document = index 2 côté Premiere');
  assert.equal(Number(imports[0].ticks), Math.round(6.6 * TICKS_PER_SEC));
  // Seul le contrôle TEXTUEL est réécrit : les autres paramètres du modèle font son style.
  assert.equal(imports[0].text.value, 'test beta\ryes');
  assert.equal(imports[0].item.end.seconds, 11.6, 'la durée du modèle ne déborde pas sur la suite');
  const text = out.report.items.find((i) => i.property === 'text');
  assert.equal(text.status, 'approximated', 'le style vient du modèle, jamais du document');
  const duration = out.report.items.find((i) => i.property === 'text.duration');
  assert.equal(duration.status, 'applied');
});

test('Premiere : sans modèle livré, le titre est déclaré perdu, pas fabriqué de travers', () => {
  const { sandbox } = loadPpro({ paths: ['C:/a.mov'], video: 3 });
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25,
    clips: [clip()],
    graphics: [{ track: 3, text: 'test beta', tlStart: 0, tlEnd: 2 }],
  }));

  assert.equal(out.titles, undefined);
  const text = out.report.items.find((i) => i.property === 'text');
  assert.equal(text.status, 'unsupported');
  assert.equal(text.reason, 'premiereTitleTemplateMissing');
});

test('Premiere : retime natif absent est signalé sans annuler la pose', () => {
  const { sandbox } = loadPpro({ paths: ['C:/a.mov'] });
  const out = JSON.parse(sandbox.NR_ppro_place({
    name: 'T', fps: 25, clips: [clip({
      timing: { speed: { numerator: 2, denominator: 1 }, reverse: true, freeze: true },
    })],
  }));

  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.deepEqual(
    out.report.items.filter((item) => item.status === 'unsupported').map((item) => item.property).sort(),
    ['timing.freeze', 'timing.reverse', 'timing.speed'],
  );
});

// ---- After Effects -------------------------------------------------------------------------------

function fakeLayer(footage) {
  return { source: footage, startTime: 0, inPoint: 0, outPoint: 0, enabled: true, audioEnabled: true };
}

function fakeComp(name, w, h, dur, fps) {
  const layers = [];
  return {
    name, width: w, height: h, duration: dur, frameRate: fps,
    frameDuration: 1 / fps, displayStartTime: 0,
    get numLayers() { return layers.length; },
    layer: (i) => layers[i - 1],
    layers: { add: (footage) => { const l = fakeLayer(footage); layers.unshift(l); return l; } },
    stack: layers,
    openInViewer: () => {},
  };
}

function loadAeft({ onDisk = null, existing = null } = {}) {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-aeft.jsx'), 'utf8');
  function FootageItem(file) { this.file = file; this.frameRate = 25; this.width = 1920; this.height = 1080; this.duration = 60; }
  function CompItem() {}
  const projectItems = [];
  const created = [];
  const project = {
    get numItems() { return projectItems.length; },
    item: (k) => projectItems[k - 1],
    activeItem: existing,
    items: {
      addComp: (name, w, h, par, dur, fps) => {
        const comp = fakeComp(name, w, h, dur, fps);
        created.push(comp);
        return comp;
      },
    },
    importFile: (io) => { const f = new FootageItem(io.file); projectItems.push(f); return f; },
  };
  const sandbox = {
    app: { project, beginUndoGroup: () => {}, endUndoGroup: () => {} },
    NRJSON: { stringify: JSON.stringify },
    $: { evalFile: () => {} },
    CompItem, FootageItem,
    ImportOptions: function () { this.file = null; },
    File: function (p) {
      this.fsName = String(p);
      this.exists = onDisk ? onDisk.indexOf(String(p)) >= 0 : true;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, created, projectItems };
}

test('After Effects : les calques gardent leur position absolue et leur trim source', () => {
  const { sandbox, created } = loadAeft();
  const out = JSON.parse(sandbox.NR_aeft_place({
    name: 'Transfert', fps: 25, width: 1920, height: 1080, duration: 8,
    clips: [
      { path: 'C:/a.mov', kind: 'video', track: 1, fps: 25, inFrame: 25, outFrame: 49, tlStart: 0, tlEnd: 1 },
      { path: 'C:/a.mov', kind: 'video', track: 1, fps: 25, inFrame: 100, outFrame: 149, tlStart: 4, tlEnd: 6 },
    ],
  }));

  assert.equal(out.ok, true);
  assert.equal(out.count, 2);
  const comp = created[0];
  const second = comp.stack[0]; // le dernier ajouté est en tête de pile
  assert.equal(second.inPoint, 4, 'le trou de 3 s avant le second plan est conservé');
  assert.equal(second.outPoint, 6);
  // startTime = position timeline − temps source : la frame 100 à 25 i/s tombe à 4 s.
  assert.equal(second.startTime, 0);
});

test('After Effects : la pile de calques suit les pistes de la timeline source', () => {
  // add() insère en index 1 : la piste la plus haute doit finir au sommet, comme à la source.
  const { sandbox, created } = loadAeft();
  sandbox.NR_aeft_place({
    name: 'T', fps: 25, width: 1920, height: 1080, duration: 4,
    clips: [
      { path: 'C:/haut.mov', kind: 'video', track: 2, fps: 25, inFrame: 0, outFrame: 24, tlStart: 0, tlEnd: 1 },
      { path: 'C:/bas.mov', kind: 'video', track: 1, fps: 25, inFrame: 0, outFrame: 24, tlStart: 0, tlEnd: 1 },
      { path: 'C:/son.wav', kind: 'audio', track: 1, fps: 25, inFrame: 0, outFrame: 24, tlStart: 0, tlEnd: 1 },
    ],
  });

  const comp = created[0];
  assert.deepEqual(comp.stack.map((l) => l.source.file.fsName), ['C:/haut.mov', 'C:/bas.mov', 'C:/son.wav']);
  // AE n'a pas de pistes audio : un plan audio devient un calque au son seul.
  assert.equal(comp.stack[2].enabled, false);
});

test('After Effects : un métrage absent du disque ne casse pas le reste du montage', () => {
  const { sandbox, created } = loadAeft({ onDisk: ['C:/a.mov'] });
  const out = JSON.parse(sandbox.NR_aeft_place({
    name: 'T', fps: 25, width: 1920, height: 1080, duration: 4,
    clips: [
      { path: 'C:/perdu.mov', kind: 'video', track: 1, fps: 25, inFrame: 0, outFrame: 24, tlStart: 0, tlEnd: 1 },
      { path: 'C:/a.mov', kind: 'video', track: 1, fps: 25, inFrame: 0, outFrame: 24, tlStart: 1, tlEnd: 2 },
    ],
  }));

  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.equal(out.skipped, 1);
  assert.equal(created[0].stack.length, 1);
});

test('After Effects : le script d’export est refusé quand le fichier n’existe pas', () => {
  const { sandbox } = loadAeft({ onDisk: [] });
  const out = JSON.parse(sandbox.NR_aeft_runScript({ path: 'C:/absent.jsx' }));
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'SCRIPT_MISSING');
});

test('After Effects : le script d’export est déroulé dans le projet ouvert', () => {
  const { sandbox } = loadAeft({ onDisk: ['C:/export.jsx'] });
  const ran = [];
  sandbox.$.evalFile = (file) => ran.push(file.fsName);
  const out = JSON.parse(sandbox.NR_aeft_runScript({ path: 'C:/export.jsx' }));
  assert.equal(out.ok, true);
  assert.deepEqual(ran, ['C:/export.jsx']);
});
