// CHAÎNE COMPLÈTE Resolve → Adobe, telle qu'elle tourne en vrai :
//   Timeline.Export(EXPORT_FCP_7_XML) → parseXmeml → mergeAnimation → adobePayload → script de l'hôte.
// Le XML ne construit RIEN : il ne sert que de porteur d'images clés, et c'est l'ExtendScript qui
// écrit le montage. Ce test exécute POUR DE VRAI les deux scripts hôtes dans un contexte stubé, avec
// un modèle de propriétés complet — la pose seule est déjà couverte par transfer-place-jsx.test.cjs,
// ici on vérifie que l'ANIMATION arrive jusqu'aux paramètres de Premiere et d'After Effects.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { parseXmeml } = require('../core/transfer/xmeml');
const { mergeAnimation } = require('../core/transfer/mergeAnimation');
const { adobePayload } = require('../core/transfer/index');
const { normalizeDoc } = require('../core/transfer/doc');

const root = path.resolve(__dirname, '..');
const TICKS_PER_SEC = 254016000000;

/** Les tableaux fabriqués DANS le contexte `vm` ont leur propre prototype Array : `deepEqual` strict
 *  les refuse alors que la structure est identique. On les ramène côté test avant de comparer. */
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- ce que Resolve exporte -----------------------------------------------------------------

/** Timeline 1920×1080 à 25 i/s : un plan qui traverse l'image de gauche à droite en 2 s, avec son. */
const RESOLVE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5"><project><name>P</name><children><sequence id="s1">
  <name>Montage</name><duration>50</duration>
  <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
  <media>
    <video>
      <format><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></format>
      <track>
        <clipitem id="c1">
          <name>plan A</name><start>0</start><end>50</end><in>10</in><out>60</out>
          <rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>
          <file id="f1"><name>A.mov</name><pathurl>file://localhost/C:/rush/A.mov</pathurl><duration>500</duration>
            <media><video><samplecharacteristics><width>1920</width><height>1080</height></samplecharacteristics></video></media>
          </file>
          <filter><effect>
            <name>Basic Motion</name><effectid>basic</effectid>
            <effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
            <parameter><parameterid>center</parameterid><name>Center</name>
              <keyframe><when>10</when><value><horiz>-0.25</horiz><vert>0</vert></value><interpolation><name>Linear</name></interpolation></keyframe>
              <keyframe><when>60</when><value><horiz>0.25</horiz><vert>0</vert></value><interpolation><name>Linear</name></interpolation></keyframe>
            </parameter>
          </effect></filter>
          <filter><effect>
            <name>Opacity</name><effectid>opacity</effectid>
            <effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
            <parameter><parameterid>opacity</parameterid><name>opacity</name>
              <keyframe><when>10</when><value>0</value></keyframe>
              <keyframe><when>35</when><value>100</value></keyframe>
            </parameter>
          </effect></filter>
        </clipitem>
      </track>
    </video>
    <audio>
      <track>
        <clipitem id="c2">
          <name>plan A son</name><start>0</start><end>50</end><in>10</in><out>60</out>
          <file id="f1"/>
          <sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>
          <filter><effect>
            <name>Audio Levels</name><effectid>audiolevels</effectid>
            <effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype>
            <parameter><parameterid>level</parameterid><name>Level</name><value>0.5</value></parameter>
          </effect></filter>
        </clipitem>
      </track>
    </audio>
  </media>
</sequence></children></project></xmeml>`;

/** Document que l'API de script produit : bornes exactes, aucune animation (elle n'est pas lisible). */
function apiDoc() {
  const common = {
    path: 'C:\\rush\\A.mov', name: 'plan A', fps: 25, srcFrames: 500,
    srcWidth: 1920, srcHeight: 1080, srcIn: 10, srcOut: 59, tlStart: 0, tlEnd: 50,
    identity: { sourceHost: 'resolve' },
  };
  return normalizeDoc({
    ok: true, host: 'resolve', timeline: 'Montage', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 50, missing: [],
    clips: [
      { ...common, kind: 'video', track: 1, video: { transform: { position: { value: { x: 0, y: 0 } } } } },
      { ...common, kind: 'audio', track: 1 },
    ],
  });
}

/** Le document réellement envoyé au panneau après la chaîne complète. */
function transferPayload() {
  const overlay = parseXmeml(RESOLVE_XML, { host: 'resolve' });
  assert.equal(overlay.ok, true, 'le XML exporté par Resolve doit être lisible');
  const merged = mergeAnimation(apiDoc(), overlay);
  assert.equal(merged.animatedClips, 2, 'la vidéo ET le son doivent recevoir leurs métadonnées');
  return { payload: adobePayload(merged.doc, {}), doc: merged.doc };
}

test('la charge utile du panneau porte les images clés, pas seulement les bornes', () => {
  const { payload, doc } = transferPayload();
  assert.equal(payload.fps, 25);
  const video = payload.clips.find((c) => c.kind === 'video');
  // Les bornes source restent celles de l'API ; seule l'animation vient du XML.
  assert.equal(video.inFrame, 10);
  assert.equal(video.outFrame, 59);
  assert.equal(video.tlStart, 0);
  assert.equal(video.tlEnd, 2);
  assert.deepEqual(video.video.transform.position.keyframes.map((k) => k.frame), [0, 50]);
  assert.equal(Math.round(video.video.transform.position.keyframes[1].value.x), 480);
  assert.deepEqual(video.video.transform.opacity.keyframes.map((k) => [k.frame, k.value]), [[0, 0], [25, 100]]);
  // Les dimensions source voyagent : l'ancrage et l'ajustement d'échelle en dépendent.
  assert.equal(video.srcWidth, 1920);
  assert.equal(doc.clips[0].identity.sourceHost, 'resolve');
  const audio = payload.clips.find((c) => c.kind === 'audio');
  assert.ok(Math.abs(audio.audio.gainDb.value + 6.02) < 0.05, 'le niveau linéaire du XML devient des dB');
});

// ---- Premiere Pro ------------------------------------------------------------------------------

/** Premiere écrit ses clés en SECONDES (nombre) et les rend en objets `Time` : le faux fait pareil. */
const paramSeconds = (time) => {
  if (typeof time === 'number') return time;
  if (time && typeof time.seconds === 'number') return time.seconds;
  return Number(time && time.ticks) / TICKS_PER_SEC;
};

function fakeParam(displayName, initial) {
  let value = initial;
  let varying = false;
  const keys = [];
  const keyValues = new Map();
  return {
    displayName,
    areKeyframesSupported: () => true,
    isTimeVarying: () => varying,
    setTimeVarying: (next) => { varying = next; return true; },
    setValue: (next) => { value = next; return true; },
    getValue: () => value,
    getKeys: () => keys.map((seconds) => ({ seconds, ticks: String(Math.round(seconds * TICKS_PER_SEC)) })),
    addKey: (time) => { keys.push(paramSeconds(time)); return true; },
    removeKey: (time) => {
      const index = keys.indexOf(paramSeconds(time));
      if (index >= 0) keys.splice(index, 1);
      keyValues.delete(paramSeconds(time));
      return true;
    },
    setValueAtKey: (time, next) => { keyValues.set(paramSeconds(time), next); value = next; return true; },
    getValueAtKey: (time) => (keyValues.has(paramSeconds(time)) ? keyValues.get(paramSeconds(time)) : value),
    getValueAtTime: (time) => (keyValues.has(paramSeconds(time)) ? keyValues.get(paramSeconds(time)) : value),
    keys,
    keyValues,
  };
}

function fakeTrack() {
  const clips = { numItems: 0 };
  const track = {
    clips,
    placed: [],
    overwriteClip(item, ticks) {
      const start = Number(ticks) / TICKS_PER_SEC;
      const inPoint = Number(item.lastIn ?? 0);
      const outPoint = Number(item.lastOut ?? 0);
      const placed = {
        nodeId: `ti-${track.placed.length + 1}`,
        projectItem: item,
        start: { seconds: start },
        end: { seconds: start + outPoint - inPoint },
        inPoint: { seconds: inPoint },
        outPoint: { seconds: outPoint },
        components: item.components,
      };
      track.placed.push(placed);
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

/** ProjectItem portant les composants Trajectoire / Opacité / Niveaux audio de Premiere. */
function richProjectItem(mediaPath) {
  const params = {
    position: fakeParam('Position', [960, 540]),
    scale: fakeParam('Scale', 100),
    scaleWidth: fakeParam('Scale Width', 100),
    uniformScale: fakeParam('Uniform Scale', true),
    opacity: fakeParam('Opacity', 100),
    level: fakeParam('Level', 0),
  };
  return {
    name: mediaPath,
    params,
    getMediaPath: () => mediaPath,
    getInPoint: () => ({ seconds: 0 }),
    getOutPoint: () => ({ seconds: 0 }),
    setInPoint(v) { this.lastIn = v; },
    setOutPoint(v) { this.lastOut = v; },
    components: Object.assign([
      { matchName: 'AE.ADBE Motion', properties: Object.assign(
        [params.position, params.scale, params.scaleWidth, params.uniformScale], { numItems: 4 },
      ) },
      { matchName: 'AE.ADBE Opacity', properties: Object.assign([params.opacity], { numItems: 1 }) },
      { matchName: 'AE.ADBE Audio Levels', properties: Object.assign([params.level], { numItems: 1 }) },
    ], { numItems: 3 }),
  };
}

function loadPpro() {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  const items = new Map();
  const created = [];
  const project = {
    rootItem: { children: { numItems: 0 } },
    sequences: Object.assign([], { numSequences: 0 }),
    activeSequence: null,
    findItemsMatchingMediaPath: (p) => {
      if (!items.has(p)) items.set(p, richProjectItem(p));
      return [items.get(p)];
    },
    importFiles: () => true,
    openSequence: () => {},
    createNewSequence: (name) => {
      const seq = {
        name, sequenceID: name, timebase: String(TICKS_PER_SEC / 25),
        frameSizeHorizontal: 1920, frameSizeVertical: 1080,
        videoTracks: trackCollection(2), audioTracks: trackCollection(2),
      };
      created.push(seq);
      return seq;
    },
  };
  const sandbox = {
    app: { project, enableQE: () => {} },
    NRJSON: { stringify: JSON.stringify },
    qe: undefined,
    File: function (p) { this.fsName = String(p); this.exists = true; },
    Time: function () {
      this.ticks = '0';
      this.seconds = 0;
      this.setSecondsAsFraction = (numerator) => { this.ticks = String(numerator); this.seconds = numerator / TICKS_PER_SEC; };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, created, items };
}

test('Premiere reçoit le mouvement en images clés, aux bons instants et aux bonnes valeurs', () => {
  const { payload } = transferPayload();
  const { sandbox, items } = loadPpro();
  const out = JSON.parse(sandbox.NR_ppro_place(payload));

  assert.equal(out.ok, true, out.error);
  assert.equal(out.count, 2);
  const params = items.get('C:\\rush\\A.mov').params;
  // Premiere compte sa trajectoire en FRACTION de l'image depuis le coin haut-gauche : sur une
  // image 1920×1080, −480 px depuis le centre valent 480/1920 = 0,25, et le centre vertical 0,5.
  const positions = [...params.position.keyValues.entries()]
    .map(([seconds, value]) => [seconds, plain(value)])
    .sort((a, b) => a[0] - b[0]);
  // Les instants se comptent depuis le point d'ENTRÉE SOURCE du plan (image 10 à 25 i/s = 0,4 s),
  // jamais depuis sa place sur la timeline : c'est l'axe dans lequel Premiere range ses clés.
  assert.deepEqual(positions, [[0.4, [0.25, 0.5]], [2.4, [0.75, 0.5]]]);
  assert.equal(params.position.isTimeVarying(), true);
  // Opacité : 0 → 100 % sur la première seconde du plan.
  const opacities = [...params.opacity.keyValues.entries()]
    .map(([seconds, value]) => [seconds, value])
    .sort((a, b) => a[0] - b[0]);
  assert.deepEqual(opacities, [[0.4, 0], [1.4, 100]]);
  // Le rapport doit CONFIRMER la pose par relecture, pas la supposer.
  const keyReport = out.report.items.find((i) => i.property === 'video.position.keyframes');
  assert.equal(keyReport.status, 'applied');
  assert.equal(keyReport.readback, true);
  assert.equal(out.report.items.some((i) => i.status === 'readbackMismatch'), false);
});

test('Premiere reçoit le niveau audio du plan', () => {
  const { payload } = transferPayload();
  const { sandbox, items } = loadPpro();
  JSON.parse(sandbox.NR_ppro_place(payload));
  // Le XML porte un niveau linéaire 0,5, soit −6,02 dB. Premiere ne stocke NI l'un NI l'autre :
  // son paramètre « Niveau » est un flottant 0..1 décalé de 15 dB, donc 10^((−6,02−15)/20).
  const expected = Math.pow(10, (-6.02 - 15) / 20);
  assert.ok(Math.abs(items.get('C:\\rush\\A.mov').params.level.getValue() - expected) < 1e-3,
    `niveau posé ${items.get('C:\\rush\\A.mov').params.level.getValue()} ≠ ${expected}`);
});

// ---- After Effects -----------------------------------------------------------------------------

function fakeProperty(initial) {
  const keys = [];
  return {
    value: initial,
    keys,
    setValue(next) { this.value = next; },
    setValueAtTime(time, next) {
      const existing = keys.find((k) => Math.abs(k.time - time) < 1e-9);
      if (existing) existing.value = next;
      else keys.push({ time, value: next, interpolation: null });
      keys.sort((a, b) => a.time - b.time);
      this.value = next;
    },
    valueAtTime(time) {
      if (!keys.length) return this.value;
      const hit = keys.find((k) => Math.abs(k.time - time) < 1e-9);
      return hit ? hit.value : keys[0].value;
    },
    get numKeys() { return keys.length; },
    keyTime: (index) => keys[index - 1].time,
    nearestKeyIndex(time) {
      let best = 1;
      keys.forEach((k, i) => { if (Math.abs(k.time - time) < Math.abs(keys[best - 1].time - time)) best = i + 1; });
      return best;
    },
    removeKey(index) { keys.splice(index - 1, 1); },
    setInterpolationTypeAtKey(index, type) { keys[index - 1].interpolation = type; },
  };
}

function fakeLayer(footage) {
  const transform = {
    position: fakeProperty([0, 0]),
    scale: fakeProperty([100, 100]),
    anchorPoint: fakeProperty([0, 0]),
    rotation: fakeProperty(0),
    opacity: fakeProperty(100),
  };
  const audioLevels = fakeProperty([0, 0]);
  const timeRemap = fakeProperty(0);
  return {
    source: footage, startTime: 0, inPoint: 0, outPoint: 0,
    enabled: true, audioEnabled: true, timeRemapEnabled: false,
    transform, audioLevels, timeRemap,
    property(name) {
      if (name === 'ADBE Audio Group') return { property: (inner) => (inner === 'ADBE Audio Levels' ? audioLevels : null) };
      if (name === 'ADBE Time Remapping') return timeRemap;
      return null;
    },
  };
}

function loadAeft() {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-aeft.jsx'), 'utf8');
  function FootageItem(file) { this.file = file; this.frameRate = 25; this.width = 1920; this.height = 1080; this.duration = 60; }
  function CompItem() {}
  const projectItems = [];
  const created = [];
  const project = {
    get numItems() { return projectItems.length; },
    item: (k) => projectItems[k - 1],
    activeItem: null,
    items: {
      addComp: (name, w, h, par, dur, fps) => {
        const layers = [];
        const comp = {
          name, width: w, height: h, duration: dur, frameRate: fps, frameDuration: 1 / fps,
          displayStartTime: 0,
          get numLayers() { return layers.length; },
          layer: (i) => layers[i - 1],
          layers: { add: (footage) => { const l = fakeLayer(footage); layers.unshift(l); return l; } },
          stack: layers,
          openInViewer: () => {},
        };
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
    KeyframeInterpolationType: { LINEAR: 'linear', BEZIER: 'bezier', HOLD: 'hold' },
    ImportOptions: function () { this.file = null; },
    File: function (p) { this.fsName = String(p); this.exists = true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { sandbox, created };
}

test('After Effects reçoit le même mouvement, converti dans son repère', () => {
  const { payload } = transferPayload();
  const { sandbox, created } = loadAeft();
  const out = JSON.parse(sandbox.NR_aeft_place(payload));

  assert.equal(out.ok, true, out.error);
  assert.equal(out.count, 2);
  const video = created[0].stack.find((l) => l.enabled);
  // AE compte la position depuis le coin haut-gauche de la comp, comme Premiere.
  assert.deepEqual(plain(video.transform.position.keys.map((k) => [k.time, k.value])), [[0, [480, 540]], [2, [1440, 540]]]);
  assert.deepEqual(plain(video.transform.position.keys.map((k) => k.interpolation)), ['linear', 'linear']);
  assert.deepEqual(plain(video.transform.opacity.keys.map((k) => [k.time, k.value])), [[0, 0], [1, 100]]);
  const keyReport = out.report.items.find((i) => i.property === 'video.position.keyframes');
  assert.equal(keyReport.status, 'applied');
  assert.equal(keyReport.readback, true);
});

test('After Effects ajuste l’échelle d’une source Resolve, jamais celle d’une source Premiere', () => {
  // Resolve AJUSTE la source à la timeline (Zoom 1 = plein cadre) ; Premiere la pose à sa taille
  // native. Appliquer le facteur au mauvais hôte redimensionnerait tout le montage.
  const base = {
    kind: 'video', track: 1, path: 'C:/rush/4k.mov', name: '4k', fps: 25,
    inFrame: 0, outFrame: 24, tlStart: 0, tlEnd: 1, srcWidth: 3840, srcHeight: 2160,
    video: { transform: { scale: { value: { x: 1, y: 1 } } } },
  };
  const place = (identity) => {
    const { sandbox, created } = loadAeft();
    sandbox.NR_aeft_place({
      name: 'T', fps: 25, width: 1920, height: 1080, duration: 4,
      clips: [{ ...base, identity }],
    });
    return plain(created[0].stack[0].transform.scale.value);
  };
  assert.deepEqual(place({ sourceHost: 'resolve' }), [50, 50], '3840 → 1920 = moitié');
  assert.deepEqual(place({ sourceHost: 'ppro' }), [100, 100], 'taille native conservée');
});

test('After Effects rejoue la vitesse et l’inversion par remise en temps', () => {
  const { sandbox, created } = loadAeft();
  const out = JSON.parse(sandbox.NR_aeft_place({
    name: 'T', fps: 25, width: 1920, height: 1080, duration: 4,
    clips: [{
      kind: 'video', track: 1, path: 'C:/rush/A.mov', name: 'A', fps: 25,
      inFrame: 0, outFrame: 49, tlStart: 0, tlEnd: 1,
      identity: { sourceHost: 'resolve' },
      timing: { speed: { numerator: 2, denominator: 1 }, reverse: true, freeze: false },
    }],
  }));

  const layer = created[0].stack[0];
  assert.equal(layer.timeRemapEnabled, true);
  // Inversé : la remise en temps descend de la fin vers le début de la portion source.
  assert.deepEqual(plain(layer.timeRemap.keys.map((k) => [k.time, k.value])), [[0, 2], [1, 0]]);
  const speeds = out.report.items.filter((i) => i.property.indexOf('timing.') === 0);
  assert.deepEqual(speeds.map((i) => [i.property, i.status]).sort(),
    [['timing.reverse', 'applied'], ['timing.speed', 'applied']]);
});
