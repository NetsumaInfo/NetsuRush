const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

// host-ppro.jsx est de l'ES3 sans dépendance (ExtendScript) : on peut l'évaluer tel quel dans un
// contexte stubé et exercer sa frame-math pour de vrai, plutôt que de la relire en regex.
function loadPproHost(onDisk) {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  const sandbox = {
    app: undefined, NRJSON: { stringify: JSON.stringify }, $: {},
    // ExtendScript expose `File` : le résolveur s'en sert pour ne JAMAIS envoyer un fichier absent
    // à l'import (Premiere y répond par une boîte modale qui gèle le panneau).
    File: function (p) { this.exists = onDisk ? onDisk.indexOf(String(p)) >= 0 : true; },
    Time: function () {
      this.seconds = 0;
      this.ticks = '0';
      this.setSecondsAsFraction = (numerator, denominator) => {
        this.seconds = Number(numerator) / Number(denominator);
        this.ticks = String(Math.round(this.seconds * 254016000000));
      };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

// Projet Premiere factice : bins imbriqués et chemins en antislash. `findItemsMatchingMediaPath`
// répond VIDE — comportement observé sur un vrai projet, et cause du « clip introuvable ou import
// échoué » alors que le rush était bien dans le projet.
function fakePproProject(paths) {
  const bin = (items) => ({ type: 2, children: { numItems: items.length } });
  const clips = paths.map((p) => ({ type: 1, name: p, getMediaPath: () => p }));
  const inner = bin(clips);
  clips.forEach((clip, i) => { inner.children[i] = clip; });
  const root = bin([inner]);
  root.children[0] = inner;
  const imported = [];
  return {
    imported,
    rootItem: root,
    findItemsMatchingMediaPath: () => [],
    importFiles: (list) => { imported.push(list[0]); return true; },
  };
}

const TICKS_PER_SEC = 254016000000;
const FPS_23_976 = 24000 / 1001;
const TICKS_PER_FRAME_23_976 = (TICKS_PER_SEC / 24000) * 1001; // 10 594 584 000, entier exact

test('Premiere ticks convert to exact source frames on non-integer frame rates', () => {
  const { nrPproFrame } = loadPproHost();

  // Le tick est un multiple exact de la durée d'une frame → la conversion doit être sans dérive,
  // y compris loin dans le média (une heure de 23,976 = 86 314 frames).
  for (const frame of [0, 1, 100, 1001, 24000, 86314]) {
    const time = { ticks: String(frame * TICKS_PER_FRAME_23_976) };
    assert.equal(nrPproFrame(time, FPS_23_976), frame, `frame ${frame}`);
  }

  // Repli secondes : un Time sans .ticks reste exploitable.
  assert.equal(nrPproFrame({ seconds: 10 }, 25), 250);
  // Pas de fps connue → aucune frame inventée.
  assert.equal(nrPproFrame({ ticks: '0' }, 0), null);
  assert.equal(nrPproFrame(null, 25), null);
});

test('Premiere track clips carry inclusive source frames for Timeline Live', () => {
  const { nrPproTracks } = loadPproHost();
  const at = (frame) => ({ ticks: String(frame * TICKS_PER_FRAME_23_976) });
  // TrackItem minimal : in/out SOURCE, start/end TIMELINE. outPoint est exclusif chez Premiere.
  const item = {
    name: 'plan',
    projectItem: { getMediaPath: () => 'C:/rush.mov', getFootageInterpretation: () => ({ frameRate: FPS_23_976 }) },
    start: at(0), end: at(50), inPoint: at(100), outPoint: at(150),
  };
  const seq = {
    videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: item } } },
    audioTracks: { numTracks: 0 },
  };

  const tracks = nrPproTracks({ sequences: { numSequences: 0 } }, seq, FPS_23_976);
  const clip = tracks[0].clips[0];
  assert.equal(tracks[0].kind, 'video');
  assert.equal(clip.path, 'C:/rush.mov');
  assert.equal(clip.srcInFrame, 100);
  // 50 frames de média : borne INCLUSIVE = 149, comme la convention Resolve de NetsuRush.
  assert.equal(clip.srcOutFrame, 149);
  assert.equal(clip.srcOutFrame - clip.srcInFrame + 1, 50);
  assert.equal(clip.tlStartFrame, 0);
  assert.equal(clip.srcFps, FPS_23_976);
});

function loadAeftHost() {
  const source = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-aeft.jsx'), 'utf8');
  const sandbox = {
    app: undefined, NRJSON: { stringify: JSON.stringify },
    CompItem: function () {}, FootageItem: function () {}, ImportOptions: function () {}, File: function () {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

// AE trime en temps de COMP, pas en temps source : toute la difficulté est de retrouver la plage
// SOURCE réelle. Chaque cas ci-dessous décrit le même plan — 50 frames à partir de la frame 10 —
// posé différemment dans la comp ; tous doivent redonner exactement 10 → 59.
const AE_FPS = 25;
const AE_FD = 1 / AE_FPS;
const AE_COMP = { frameRate: AE_FPS, frameDuration: AE_FD };
const aeFootage = (p) => ({ mainSource: { file: { fsName: p } }, frameRate: AE_FPS, duration: 100 * AE_FD });

function assertSourceRange(clip, expectedPath) {
  assert.equal(clip.path, expectedPath);
  assert.equal(clip.srcInFrame, 10);
  assert.equal(clip.srcOutFrame, 59);
  assert.equal(clip.srcOutFrame - clip.srcInFrame + 1, 50);
}

test('After Effects reads the true source range of a plain layer', () => {
  const { nrAeftLayerClip } = loadAeftHost();
  const clip = nrAeftLayerClip({
    name: 'A', source: aeFootage('C:/a.mov'), stretch: 100,
    startTime: 2 - 10 * AE_FD, inPoint: 2, outPoint: 2 + 50 * AE_FD,
  }, AE_COMP);
  assertSourceRange(clip, 'C:/a.mov');
  assert.equal(clip.tlStartFrame, 50);
  // AE expose la durée du métrage, contrairement à Premiere → srcFrames est connu de ce côté.
  assert.equal(clip.srcFrames, 100);
});

test('After Effects undoes time stretch instead of reporting comp duration as source duration', () => {
  const { nrAeftLayerClip } = loadAeftHost();
  // Étirement ×2 : le calque occupe 100 frames de comp pour 50 frames de média. C'est exactement ce
  // que NR_aeft_build écrit en insertion « fit » (stretch = scale × 100, startTime = compIn − srcIn × scale) :
  // lire `inPoint − startTime` sans défaire l'étirement renvoyait 20 → 119, soit le double.
  const clip = nrAeftLayerClip({
    name: 'B', source: aeFootage('C:/b.mov'), stretch: 200,
    startTime: 2 - 10 * AE_FD * 2, inPoint: 2, outPoint: 2 + 50 * AE_FD * 2,
  }, AE_COMP);
  assertSourceRange(clip, 'C:/b.mov');
});

test('After Effects follows the time remap curve when it is enabled', () => {
  const { nrAeftLayerClip } = loadAeftHost();
  // Remappage : aucune relation linéaire entre temps de comp et temps source ; seule la courbe sait.
  const remap = { valueAtTime: (t) => (t === 2 ? 10 * AE_FD : 60 * AE_FD) };
  const clip = nrAeftLayerClip({
    name: 'R', source: aeFootage('C:/r.mov'), timeRemapEnabled: true, timeRemap: remap,
    stretch: 100, startTime: 0, inPoint: 2, outPoint: 2 + 50 * AE_FD,
  }, AE_COMP);
  assertSourceRange(clip, 'C:/r.mov');
});

test('After Effects orders the bounds of a reversed layer', () => {
  const { nrAeftLayerClip } = loadAeftHost();
  // stretch négatif = calque lu à l'envers → les bornes sortent décroissantes.
  const clip = nrAeftLayerClip({
    name: 'V', source: aeFootage('C:/v.mov'), stretch: -100,
    startTime: 2 + 60 * AE_FD, inPoint: 2, outPoint: 2 + 50 * AE_FD,
  }, AE_COMP);
  assertSourceRange(clip, 'C:/v.mov');
});

test('After Effects resolves a precomposed layer down to the rush', () => {
  const { nrAeftLayerClip } = loadAeftHost();
  // Une précomp n'a pas de fichier : sans descente, le plan sortait avec path null et DISPARAISSAIT
  // de Timeline Live. Le temps source du calque est le temps interne de la précomp.
  const inner = {
    name: 'inner', source: aeFootage('C:/rush.mov'), stretch: 100,
    startTime: 0, inPoint: 0, outPoint: 100 * AE_FD, hasVideo: true, activeAtTime: () => true,
  };
  const precomp = { numLayers: 1, frameRate: AE_FPS, duration: 100 * AE_FD, layer: () => inner };
  const clip = nrAeftLayerClip({
    name: 'PRE', source: precomp, stretch: 100,
    startTime: 2 - 10 * AE_FD, inPoint: 2, outPoint: 2 + 50 * AE_FD,
  }, AE_COMP);
  assertSourceRange(clip, 'C:/rush.mov');
});

test('After Effects keeps layers without media out of the grid', () => {
  const { nrAeftLayerClip } = loadAeftHost();
  // Texte, solide, calque d'effet : pas de fichier et rien à descendre → hostTimelineCuts l'écarte.
  const synthetic = nrAeftLayerClip({ name: 'titre', source: {}, startTime: 0, inPoint: 0, outPoint: 1 }, AE_COMP);
  assert.equal(synthetic.path, null);
});

function pproParam(matchName, displayName, value, keys = []) {
  return {
    matchName, displayName,
    getValue: () => {
      if (keys.length) throw new Error('getValue est statique seulement');
      return value;
    },
    areKeyframesSupported: () => true,
    isTimeVarying: () => keys.length > 0,
    getKeys: () => keys.map((key) => key.time),
    getValueAtKey: (time) => keys.find((key) => key.time === time).value,
  };
}

function pproComponent(matchName, displayName, params) {
  return { matchName, displayName, properties: Object.assign({ numItems: params.length }, params) };
}

test('Premiere lit Motion et ses images clés par matchName, indépendamment de la langue', () => {
  const { nrPproReadProperties } = loadPproHost();
  const fps = 25;
  const t0 = { seconds: 2 };
  const t1 = { seconds: 3 };
  // Premiere rend sa trajectoire en FRACTION de l'image, jamais en pixels : 0,5 est le centre.
  // Ici 1060/1920 et 490/1080, soit +100 px et −50 px depuis le centre d'une image 1080p.
  const motion = pproComponent('AE.ADBE Motion', 'Trajectoire', [
    pproParam('Position', 'Position', [1060 / 1920, 490 / 1080],
      [{ time: t0, value: [1060 / 1920, 490 / 1080] }, { time: t1, value: [1160 / 1920, 540 / 1080] }]),
    pproParam('Scale', 'Échelle', 150),
    pproParam('Rotation', 'Rotation', 12),
    // L'ancre est normalisée sur la taille de la SOURCE ; sans dimensions lisibles, la séquence sert
    // de repli — 320/1920 et 240/1080 y redonnent donc 320 et 240 pixels.
    pproParam('Anchor Point', "Point d’ancrage", [320 / 1920, 240 / 1080]),
  ]);
  const opacity = pproComponent('AE.ADBE Opacity', 'Opacité', [pproParam('Opacity', 'Opacité', 50)]);
  // Les clés d'un plan Premiere se comptent depuis son point d'ENTRÉE SOURCE, pas depuis sa place
  // sur la timeline : ici le plan est posé à 5 s et entre à 2 s dans sa source, et ses deux clés
  // (2 s et 3 s) sont donc les images 0 et 25 du plan. Relu tel quel sur Premiere 26.3.
  const item = {
    start: { seconds: 5 }, inPoint: { seconds: 2 },
    components: Object.assign({ numItems: 2 }, [opacity, motion]), nodeId: 'clip-1',
  };
  const out = nrPproReadProperties(item, { frameSizeHorizontal: 1920, frameSizeVertical: 1080 }, fps, 'video');

  // Tolérance : la conversion fraction → pixels passe par un flottant, et une position sub-pixel
  // est parfaitement légitime — arrondir dans le code perdrait de la précision pour rien.
  const nearly = (actual, expected, label) =>
    assert.ok(Math.abs(actual - expected) < 1e-6, `${label} : ${actual} ≠ ${expected}`);
  nearly(out.video.transform.position.value.x, 100, 'position.x');
  nearly(out.video.transform.position.value.y, -50, 'position.y');
  nearly(out.video.transform.anchor.value.x, 320, 'anchor.x');
  nearly(out.video.transform.anchor.value.y, 240, 'anchor.y');
  assert.deepEqual({ ...out.video.transform.scale.value }, { x: 1.5, y: 1.5 });
  assert.equal(out.video.transform.rotation.value, 12);
  assert.equal(out.video.transform.opacity.value, 50);
  assert.deepEqual(Array.from(out.video.transform.position.keyframes, (key) => key.frame), [0, 25]);
  assert.equal(out.nodeId, 'clip-1');
});

test('Premiere fusionne les courbes Scale et Scale Width aux mêmes instants', () => {
  const { nrPproReadProperties } = loadPproHost();
  const fps = 25;
  const t0 = { seconds: 0 };
  const t1 = { seconds: 1 };
  const scale = pproParam('Scale', 'Échelle', 100, [{ time: t0, value: 100 }]);
  scale.getValueAtTime = (time) => time.seconds >= 1 ? 150 : 100;
  const width = pproParam('Scale Width', "Largeur d’échelle", 100, [{ time: t1, value: 200 }]);
  width.getValueAtTime = (time) => time.seconds >= 1 ? 200 : 100;
  const motion = pproComponent('AE.ADBE Motion', 'Trajectoire', [scale, width]);
  const item = { start: t0, components: Object.assign({ numItems: 1 }, [motion]) };

  const out = nrPproReadProperties(item, {}, fps, 'video');
  const keys = Array.from(out.video.transform.scale.keyframes, (key) => ({
    frame: key.frame,
    value: { ...key.value },
  }));
  assert.deepEqual(keys, [
    { frame: 0, value: { x: 1, y: 1 } },
    { frame: 25, value: { x: 2, y: 1.5 } },
  ]);
});

test('Premiere lit le mix audio seulement quand les paramètres existent', () => {
  const { nrPproReadProperties } = loadPproHost();
  // Le paramètre « Niveau » de Premiere est un flottant 0..1 décalé de 15 dB, jamais des décibels :
  // −6 dB s'y écrit 10^((−6−15)/20). Le lire comme des dB donnait un gain absurde chez la cible.
  const levels = pproComponent('ADBE Audio Levels', 'Niveaux audio',
    [pproParam('Level', 'Niveau', Math.pow(10, (-6 - 15) / 20))]);
  const panner = pproComponent('AE.ADBE Panner', 'Panoramique', [pproParam('Balance', 'Panoramique', 0.25)]);
  const item = { start: { seconds: 0 }, components: Object.assign({ numItems: 2 }, [levels, panner]) };
  const out = nrPproReadProperties(item, {}, 25, 'audio');
  assert.ok(Math.abs(out.audio.gainDb.value - -6) < 1e-6, `gain lu ${out.audio.gainDb.value} ≠ −6 dB`);
  assert.equal(out.audio.pan.value, 0.25);
  assert.equal(out.audio.mute, undefined);
});

test('Premiere source bounds survive a clip speed change', () => {
  const { nrPproTracks } = loadPproHost();
  const at = (frame) => ({ ticks: String(frame * TICKS_PER_FRAME_23_976) });
  // Vitesse ×2 : 25 frames de timeline pour 50 frames de média. Ce test fixe le CONTRAT sur lequel
  // le lecteur repose — `inPoint`/`outPoint` d'un TrackItem sont en temps SOURCE, contrairement à
  // AE qui trime en temps de comp. Il vérifie que le code ne réintroduit pas de calcul depuis
  // `end - start` ; il ne peut pas prouver le comportement de Premiere lui-même (pas d'hôte ici).
  const item = {
    name: 'rapide',
    projectItem: { getMediaPath: () => 'C:/fast.mov', getFootageInterpretation: () => ({ frameRate: FPS_23_976 }) },
    start: at(0), end: at(25), inPoint: at(100), outPoint: at(150),
  };
  const seq = { videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: item } } }, audioTracks: { numTracks: 0 } };
  const clip = nrPproTracks({ sequences: { numSequences: 0 } }, seq, FPS_23_976)[0].clips[0];
  assert.equal(clip.srcInFrame, 100);
  assert.equal(clip.srcOutFrame, 149);
  assert.equal(clip.srcOutFrame - clip.srcInFrame + 1, 50);
});

test('Premiere resolves a nested sequence down to the rush', () => {
  const { nrPproTracks } = loadPproHost();
  const fps = 25;
  const ticksPerFrame = TICKS_PER_SEC / fps;
  const at = (frame) => ({ ticks: String(frame * ticksPerFrame) });
  const interp = { getFootageInterpretation: () => ({ frameRate: fps }) };
  const track = (...clips) => ({ clips: Object.assign({ numItems: clips.length }, clips) });

  // Séquence imbriquée : elle démarre sur la frame source 200 du rush.
  const innerItem = {
    name: 'inner',
    projectItem: Object.assign({ getMediaPath: () => 'C:/rush.mov', nodeId: 'n2' }, interp),
    start: at(0), end: at(200), inPoint: at(200), outPoint: at(400),
  };
  const nestedSeq = {
    name: 'NEST', projectItem: { nodeId: 'nest' },
    videoTracks: Object.assign({ numTracks: 1 }, [track(innerItem)]), audioTracks: { numTracks: 0 },
  };
  // Posée sur la timeline maître et tranchée sur SES frames 10 → 60.
  const nestItem = {
    name: 'NEST', projectItem: { getMediaPath: () => '', nodeId: 'nest' },
    start: at(60), end: at(110), inPoint: at(10), outPoint: at(60),
  };
  // Titre : pas de média, pas de séquence à descendre → doit rester hors de la grille.
  const title = {
    name: 'titre', projectItem: { getMediaPath: () => '', nodeId: 't1' },
    start: at(0), end: at(10), inPoint: at(0), outPoint: at(10),
  };
  const proj = { sequences: Object.assign({ numSequences: 1 }, [nestedSeq]) };
  const master = { videoTracks: Object.assign({ numTracks: 1 }, [track(nestItem, title)]), audioTracks: { numTracks: 0 } };

  const clips = nrPproTracks(proj, master, fps)[0].clips;
  // Sans la descente, getMediaPath() vide laissait `path` falsy → le plan DISPARAISSAIT de la vue.
  assert.equal(clips[0].path, 'C:/rush.mov');
  // 200 (début de l'imbriquée dans le rush) + 10 (coupe dans l'imbriquée) = 210, sur 50 frames.
  assert.equal(clips[0].srcInFrame, 210);
  assert.equal(clips[0].srcOutFrame, 259);
  assert.equal(clips[1].path, null);
});

test('Premiere sources resolve from the project tree when findItemsMatchingMediaPath comes back empty', () => {
  const { nrPproResolver } = loadPproHost();
  const proj = fakePproProject(['S:\\rush\\Projet\\MEP gest\\v2.mov']);
  const sources = nrPproResolver(proj);

  // Chemin tel que Premiere le rend : trouvé sans réimport.
  assert.equal(sources.get('S:\\rush\\Projet\\MEP gest\\v2.mov'), proj.rootItem.children[0].children[0]);
  // Même source vue par NetsuRush (barres obliques, casse différente) : même item.
  assert.equal(sources.get('s:/RUSH/Projet/MEP gest/v2.MOV'), proj.rootItem.children[0].children[0]);
  assert.deepEqual(proj.imported, []);
  assert.equal(sources.missing.length, 0);
});

test('Premiere never sends a missing file to import (modal dialog would freeze the panel)', () => {
  const { nrPproResolver } = loadPproHost([]); // rien sur le disque
  const proj = fakePproProject([]);
  const sources = nrPproResolver(proj);

  assert.equal(sources.get('S:\\rush\\absent.mov'), null);
  assert.deepEqual(proj.imported, []);
  assert.equal(sources.missing.length, 1);
  assert.equal(sources.missing[0], 'S:\\rush\\absent.mov');
});

test('Premiere imports a source absent from the project, then finds it again', () => {
  const onDisk = ['S:\\rush\\neuf.mov'];
  const { nrPproResolver } = loadPproHost(onDisk);
  const proj = fakePproProject([]);
  // L'import peuple le projet : l'index doit être reconstruit après coup, sinon la source reste
  // introuvable alors qu'elle vient d'entrer dans le projet.
  const added = { type: 1, name: 'neuf.mov', getMediaPath: () => 'S:\\rush\\neuf.mov' };
  proj.importFiles = (list) => {
    proj.imported.push(list[0]);
    const inner = proj.rootItem.children[0];
    inner.children[inner.children.numItems++] = added;
    return true;
  };

  const sources = nrPproResolver(proj);
  assert.equal(sources.get('S:\\rush\\neuf.mov'), added);
  assert.deepEqual(proj.imported, ['S:\\rush\\neuf.mov']);
  // Deuxième demande = cache, pas de second import.
  assert.equal(sources.get('S:/rush/neuf.mov'), added);
  assert.equal(proj.imported.length, 1);
});

test('the multi-source build path resolves one project item per segment', () => {
  const ppro = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  const aeft = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-aeft.jsx'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'src', 'lib', 'bridge.ts'), 'utf8');

  // Une timeline enchaîne des plans de sources DIFFÉRENTES : sans `path` par segment, tout le
  // montage retomberait sur `input` et poserait le mauvais média.
  assert.match(bridge, /inFrame\?: number; outFrame\?: number; path\?: string/);
  assert.match(ppro, /rs\.path \? sources\.get\(rs\.path\) : pitem/);
  assert.match(aeft, /s\.path \? footageFor\(s\.path\) : f/);
  // Le trim écrase les In/Out du ProjectItem : chaque source touchée doit être restaurée.
  assert.match(ppro, /nrPproRemember\(touched, sourceItem, rangeMediaType\)/);
  assert.match(ppro, /nrPproRestore\(touched\)/);
});

test('Timeline Live reads Adobe cuts from the CEP snapshot instead of the Resolve bridge', () => {
  const host = fs.readFileSync(path.join(root, 'src', 'lib', 'host.ts'), 'utf8');
  const view = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'TimelineLiveView.tsx'), 'utf8');

  assert.match(host, /export function hostTimelineCuts/);
  assert.match(host, /export function hostTimelineNames/);
  // Pistes vidéo seulement, et pas d'item synthétique (titre, solide) : rien à prévisualiser.
  assert.match(host, /track\.kind !== "video"/);
  assert.match(host, /if \(!clip\.path\) return/);

  // L'ancien écran « Timeline Live est propre à Resolve » ne doit pas revenir.
  assert.doesNotMatch(view, /resolveOnly/);
  assert.match(view, /useAdobeTimelines/);
  assert.match(view, /adobe\.active \? adobe\.timelines : target\.timelines/);
  // Le montage retour d'une timeline Adobe transporte le chemin de chaque plan.
  assert.match(view, /path: c\.path/);
});

test('the timeline destination follows the ACTIVE host, not Resolve', () => {
  const list = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'useTimelineList.ts'), 'utf8');
  const target = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'useTimelineTarget.ts'), 'utf8');
  const host = fs.readFileSync(path.join(root, 'src', 'lib', 'host.ts'), 'utf8');
  const ppro = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-ppro.jsx'), 'utf8');
  const aeft = fs.readFileSync(path.join(root, 'adobe-cep', 'jsx', 'host-aeft.jsx'), 'utf8');

  // Sur hôte Adobe, `nr.listTimelines` listait les timelines RESOLVE : le sélecteur proposait
  // « V0 (ouverte) » alors qu'on montait dans Premiere.
  assert.match(list, /useAdobeTimelines/);
  assert.match(list, /if \(adobe\.active\)/);
  assert.match(list, /enabled && !adobe\.active/);
  // Le monteur natif Resolve (blocs) ne parle pas à Adobe : Collections doit passer par le job panneau.
  assert.match(target, /isAdobeHost\(activeHost\)/);
  assert.match(target, /hostBuildTimeline\(activeHost/);

  // La séquence/comp VISÉE doit voyager jusqu'au jsx, sinon tout tombe dans celle qui est ouverte.
  assert.match(host, /export function hostCurrentTimeline/);
  assert.match(host, /timelineName: opts\.timelineName/);
  assert.match(ppro, /nrPproSequenceByName\(proj, p\.timelineName\)/);
  assert.match(aeft, /nrAeftCompByName\(p\.timelineName\)/);
  // Séquence Premiere / comp AE ouverte = « timeline courante » côté NetsuRush.
  assert.match(ppro, /activeSequence: activeSequence/);
  assert.match(aeft, /activeSequence: activeSequence/);
});

test('cutting a whole timeline works on an Adobe host too', () => {
  const cut = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'hostCutTimeline.ts'), 'utf8');
  const view = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'CutTimelineView.tsx'), 'utf8');
  const editor = fs.readFileSync(path.join(root, 'src', 'components', 'rushes', 'CutEditor.tsx'), 'utf8');

  // Côté Adobe il n'y a AUCUN canal core : les plans montés viennent du snapshot, la détection
  // travaille sur des fichiers, le montage repart par le job du panneau.
  assert.match(cut, /export async function analyzeHostTimelineCut/);
  assert.match(cut, /export async function buildHostCutTimeline/);
  assert.match(cut, /hostBuildTimeline\(host/);
  assert.doesNotMatch(cut, /nr\.(cutTimeline|analyzeTimelineCut|buildCutTimeline)\(/);
  // Borne de sortie INCLUSIVE (convention NetsuRush) et mode « nouvelle » seulement.
  assert.match(cut, /outFrame: shot\.startFrame \+ shot\.frames - 1/);
  assert.match(cut, /mode: "new"/);

  // La vue route l'analyse ET le montage, et l'éditeur de coupes accepte le monteur de l'hôte.
  assert.match(view, /adobe\.active\s*\n?\s*\? await cutOnAdobe|adobe\.active\s*$/m);
  assert.match(view, /analyzeHostTimelineCut\(\{/);
  assert.match(view, /buildHostCutTimeline\(activeHost/);
  assert.match(editor, /onBuild\?: \(clips: CutClip\[\], name\?: string\)/);
  assert.match(editor, /onBuild\s*\n?\s*\? await onBuild\(clips/);
});

test('Adobe project snapshots survive a core restart', () => {
  const adobe = fs.readFileSync(path.join(root, 'core', 'adobe.js'), 'utf8');
  // Cache disque : sans lui, Timeline Live et le Derush repartent vides à chaque relance du core
  // (ou hôte fermé), alors que la donnée n'a pas bougé.
  assert.match(adobe, /adobe-snapshots/);
  assert.match(adobe, /readSnapshotFile\('ppro'\), aeft: readSnapshotFile\('aeft'\)/);
  assert.match(adobe, /writeSnapshotFile\(snap\.app, snap\)/);
  // Écriture atomique : un core tué en plein vol ne doit pas laisser un JSON tronqué.
  assert.match(adobe, /fs\.renameSync\(tmp, target\)/);
});
