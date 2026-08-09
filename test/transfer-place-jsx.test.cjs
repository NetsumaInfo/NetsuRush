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
  return {
    name,
    sequenceID: name,
    timebase: String(TICKS_PER_SEC / fps),
    videoTracks: trackCollection(videoTracks),
    audioTracks: trackCollection(audioTracks),
  };
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

function loadPpro({ paths = [], onDisk = null, sequences = [], active = null, video = 2, audio = 2, itemFactory = null } = {}) {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  const items = new Map(paths.map((p) => [p, itemFactory ? itemFactory(p) : fakeProjectItem(p)]));
  const created = [];
  const imported = [];
  const project = {
    rootItem: { children: { numItems: 0 } },
    sequences: Object.assign(sequences.slice(0), { numSequences: sequences.length }),
    activeSequence: active,
    findItemsMatchingMediaPath: (p) => (items.has(p) ? [items.get(p)] : []),
    importFiles: (list) => { imported.push(list[0]); return true; },
    openSequence: () => {},
    createNewSequence: (name) => {
      const seq = fakeSequence(name, 25, video, audio);
      created.push(seq);
      return seq;
    },
  };
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
  return { sandbox, project, items, created, imported };
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

function fakeParam(displayName, initial, initialKeys = []) {
  let value = initial;
  let varying = initialKeys.length > 0;
  const keys = initialKeys.slice();
  const keyValues = new Map(initialKeys.map((time) => [time.ticks, initial]));
  return {
    displayName,
    areKeyframesSupported: () => true,
    isTimeVarying: () => varying,
    setTimeVarying: (next) => { varying = next; return true; },
    setValue: (next) => { value = next; return true; },
    getValue: () => value,
    getKeys: () => keys.slice(),
    addKey: (time) => { keys.push(time); return true; },
    removeKey: (time) => {
      const index = keys.findIndex((key) => key.ticks === time.ticks);
      if (index >= 0) keys.splice(index, 1);
      keyValues.delete(time.ticks);
      return true;
    },
    setValueAtKey: (time, next) => { keyValues.set(time.ticks, next); value = next; return true; },
    getValueAtKey: (time) => keyValues.has(time.ticks) ? keyValues.get(time.ticks) : value,
    getValueAtTime: (time) => keyValues.has(time.ticks) ? keyValues.get(time.ticks) : value,
    keys,
  };
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
