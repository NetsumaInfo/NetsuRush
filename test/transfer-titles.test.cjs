// Titres : lecture chez Premiere, recréation chez Resolve.
// Tout est PUR ici — la seule partie non testable sans hôte est l'insertion elle-même.

const test = require('node:test');
const assert = require('node:assert');
const { docFromAdobeSequence, normalizeDoc, docSummary } = require('../core/transfer/doc');
const { buildTitleComp, compHasText, splitFontName, findTextTool } = require('../core/transfer/fusion/titleText');
const { frameToTimecode } = require('../core/transfer/resolveTitles');

const SKELETON = [
  'Composition {',
  '\tTools = ordered() {',
  '\t\tTemplate = TextPlus {',
  '\t\t\tInputs = {',
  '\t\t\t\tGlobalOut = Input { Value = 119, },',
  '\t\t\t\tStyledText = Input { Value = "Sample", },',
  '\t\t\t\tFont = Input { Value = "Open Sans", },',
  '\t\t\t\tSize = Input { Value = 0.08, },',
  '\t\t\t\tCenter = Input { Value = { 0.5, 0.5 }, },',
  '\t\t\t}',
  '\t\t},',
  '\t\tMediaOut1 = MediaOut {',
  '\t\t\tInputs = { Input = Input { SourceOp = "Template", Source = "Output", }, }',
  '\t\t}',
  '\t}',
  '}',
].join('\n');

const TIMELINE = { width: 1920, height: 1080 };

function graphic(extra = {}) {
  return { track: 1, name: 'Titre', tlStart: 0, tlEnd: 50, text: 'Bonjour', ...extra };
}

function snapshot(clip) {
  return {
    app: 'ppro',
    activeSequence: 'S1',
    sequences: [{
      name: 'S1', fps: 25, w: 1920, h: 1080,
      tracks: [{ kind: 'video', index: 1, clips: [clip] }],
    }],
  };
}

// --- lecture -------------------------------------------------------------------------------------

test('un élément sans média porteur de texte devient un titre, pas une source perdue', () => {
  const doc = normalizeDoc(docFromAdobeSequence(snapshot({
    name: 'Mon titre', path: null, tlStartFrame: 25, tlEndFrame: 75,
    graphic: { text: 'Chapitre 1', font: 'Arial-BoldMT', size: 108, color: { r: 1, g: 0.5, b: 0 } },
  }), 'S1'));
  assert.equal(doc.clips.length, 0);
  assert.deepEqual(doc.mediaLess, []);
  assert.equal(doc.graphics.length, 1);
  assert.deepEqual(doc.graphics[0], {
    track: 1, name: 'Mon titre', tlStart: 25, tlEnd: 75,
    text: 'Chapitre 1', font: 'Arial-BoldMT', size: 108, color: { r: 1, g: 0.5, b: 0 },
    transform: undefined,
  });
  assert.equal(docSummary(doc).graphics, 1);
});

test('un élément sans média NI texte reste un élément que rien ne peut porter', () => {
  const doc = normalizeDoc(docFromAdobeSequence(snapshot({
    name: 'Cache noir', path: null, tlStartFrame: 0, tlEndFrame: 50,
  }), 'S1'));
  assert.deepEqual(doc.graphics, []);
  assert.deepEqual(doc.mediaLess, ['Cache noir']);
});

test('un titre au texte vide ne devient pas un titre vide', () => {
  const doc = normalizeDoc(docFromAdobeSequence(snapshot({
    name: 'Vide', path: null, tlStartFrame: 0, tlEndFrame: 50, graphic: { text: '   ' },
  }), 'S1'));
  assert.deepEqual(doc.graphics, []);
  assert.deepEqual(doc.mediaLess, ['Vide']);
});

test('les titres se rebasent comme les plans sur une timeline qui ne démarre pas à zéro', () => {
  const doc = normalizeDoc({
    ok: true, host: 'resolve', timeline: 'V1', fps: 25, width: 1920, height: 1080,
    startFrame: 90000, endFrame: 0, missing: [], clips: [],
    graphics: [{ track: 1, name: 'T', tlStart: 90025, tlEnd: 90075, text: 'X' }],
  });
  assert.equal(doc.graphics[0].tlStart, 25);
  assert.equal(doc.graphics[0].tlEnd, 75);
  // Un titre compte dans la durée du document : sinon la timeline cible s'arrêterait avant lui.
  assert.equal(doc.endFrame, 75);
});

// --- nom de police -------------------------------------------------------------------------------

test('un nom PostScript se sépare en famille et style, marque de fonderie retirée', () => {
  assert.deepEqual(splitFontName('Arial-BoldMT'), { family: 'Arial', style: 'Bold' });
  assert.deepEqual(splitFontName('Arial-BoldItalicMT'), { family: 'Arial', style: 'Bold Italic' });
  assert.deepEqual(splitFontName('ArialMT'), { family: 'Arial', style: 'Regular' });
  assert.deepEqual(splitFontName('Helvetica-Oblique'), { family: 'Helvetica', style: 'Italic' });
  assert.deepEqual(splitFontName('MyriadPro-Semibold'), { family: 'Myriad', style: 'Semibold' });
  assert.equal(splitFontName(''), null);
});

// --- écriture Fusion -----------------------------------------------------------------------------

test('le texte, la police, le corps et la couleur sont écrits dans le Text+', () => {
  const built = buildTitleComp(SKELETON, graphic({
    text: 'Chapitre 1', font: 'Arial-BoldMT', size: 108, color: { r: 1, g: 0.5, b: 0 },
  }), TIMELINE);
  assert.equal(built.ok, true);
  assert.ok(built.text.includes('StyledText = Input { Value = "Chapitre 1", },'));
  assert.ok(built.text.includes('Font = Input { Value = "Arial", },'));
  assert.ok(built.text.includes('Style = Input { Value = "Bold", },'));
  // Fusion compte le corps en fraction de la hauteur d'image, l'hôte source en pixels.
  assert.ok(built.text.includes('Size = Input { Value = 0.1, },'));
  assert.ok(built.text.includes('Red1 = Input { Value = 1, },'));
  assert.ok(built.text.includes('Green1 = Input { Value = 0.5, },'));
  assert.ok(built.text.includes('Blue1 = Input { Value = 0, },'));
});

test('la position passe des pixels depuis le centre au repère 0..1 de Fusion, Y inversé', () => {
  const built = buildTitleComp(SKELETON, graphic({
    transform: { position: { value: { x: 192, y: -108 } } },
  }), TIMELINE);
  assert.equal(built.ok, true);
  assert.ok(built.text.includes('Center = Input { Value = { 0.6, 0.6 }, },'));
});

test('un guillemet dans le texte ne casse pas la composition', () => {
  const built = buildTitleComp(SKELETON, graphic({ text: 'Il a dit "non"\nà la ligne' }), TIMELINE);
  assert.equal(built.ok, true);
  assert.ok(built.text.includes('StyledText = Input { Value = "Il a dit \\"non\\"\\nà la ligne", },'));
  assert.equal(compHasText(built.text, 'Il a dit "non"\nà la ligne'), true);
});

test('le reste de la composition est laissé intact', () => {
  const built = buildTitleComp(SKELETON, graphic(), TIMELINE);
  assert.equal(built.ok, true);
  assert.ok(built.text.includes('GlobalOut = Input { Value = 119, },'));
  assert.ok(built.text.includes('MediaOut1 = MediaOut {'));
  assert.ok(built.text.includes('SourceOp = "Template"'));
  assert.equal(findTextTool(built.text).name, 'Template');
});

test('une entrée absente du modèle est ajoutée plutôt que perdue', () => {
  const bare = SKELETON.replace(/\n[^\n]*Font = Input[^\n]*/, '');
  const built = buildTitleComp(bare, graphic({ font: 'Impact' }), TIMELINE);
  assert.equal(built.ok, true);
  assert.ok(built.text.includes('Font = Input { Value = "Impact", },'));
  assert.ok(built.applied.includes('Font'));
});

test('une composition sans Text+ est refusée, jamais réécrite au hasard', () => {
  const built = buildTitleComp('Composition { Tools = ordered() { Blur1 = Blur { } } }', graphic(), TIMELINE);
  assert.equal(built.ok, false);
  assert.equal(built.reason, 'fusionTextToolMissing');
});

test('un titre sans texte est refusé : rien à recréer', () => {
  assert.equal(buildTitleComp(SKELETON, graphic({ text: '  ' }), TIMELINE).reason, 'titleTextMissing');
});

test('la relecture distingue le texte demandé de celui du modèle', () => {
  assert.equal(compHasText(SKELETON, 'Bonjour'), false);
  assert.equal(compHasText(SKELETON, 'Sample'), true);
});

// --- timecode ------------------------------------------------------------------------------------

test('la frame de départ devient un timecode que SetCurrentTimecode accepte', () => {
  assert.equal(frameToTimecode(0, 25), '00:00:00:00');
  assert.equal(frameToTimecode(25, 25), '00:00:01:00');
  assert.equal(frameToTimecode(90000, 25), '01:00:00:00');
  assert.equal(frameToTimecode(24, 24), '00:00:01:00');
});

test('une cadence NTSC produit un timecode DROP-FRAME, sinon le titre se pose ailleurs', () => {
  // 1800 frames à 29,97 : en drop-frame les deux images sautées de la première minute décalent le compte.
  assert.equal(frameToTimecode(1800, 29.97), '00:01:00;02');
  assert.equal(frameToTimecode(0, 29.97), '00:00:00;00');
  // 23,976 n'est PAS drop-frame : sa cadence nominale n'est pas un multiple de 30.
  assert.equal(frameToTimecode(24, 23.976), '00:00:01:00');
});

// --- relevé de fidélité --------------------------------------------------------------------------

const { assessTransfer } = require('../core/transfer/equivalence');
const { RESOLVE_FUSION_RUNTIME } = require('../core/transfer/capabilities');

function docWithTitle() {
  return normalizeDoc({
    ok: true, host: 'ppro', timeline: 'S1', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, missing: [],
    clips: [{ kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 }],
    graphics: [graphic()],
  });
}

test("un titre pèse UN axe dans le relevé, jamais autant qu'un plan", () => {
  const plain = assessTransfer(docWithTitle(), 'resolve');
  const titles = plain.items.filter((item) => item.property === 'text');
  assert.equal(titles.length, 1);
  assert.equal(titles[0].clip, null);
});

test('sans Fusion le titre est DIFFÉRÉ, avec Fusion il est APPROCHÉ', () => {
  const withoutFusion = assessTransfer(docWithTitle(), 'resolve');
  assert.equal(withoutFusion.items.find((item) => item.property === 'text').status, 'deferred');

  const withFusion = assessTransfer(docWithTitle(), 'resolve', { runtime: RESOLVE_FUSION_RUNTIME });
  const text = withFusion.items.find((item) => item.property === 'text');
  // Jamais `expected` : police, interlettrage et animation du modèle n'ont pas d'équivalence.
  assert.equal(text.status, 'approximated');
  assert.equal(withFusion.faithful, false);
});

test('un document sans titre ne déclare aucun axe de texte', () => {
  const doc = normalizeDoc({
    ok: true, host: 'ppro', timeline: 'S1', fps: 25, width: 1920, height: 1080,
    startFrame: 0, endFrame: 0, missing: [],
    clips: [{ kind: 'video', track: 1, path: 'C:/a.mov', name: 'a', fps: 25, srcFrames: 0, srcIn: 0, srcOut: 9, tlStart: 0, tlEnd: 10 }],
  });
  assert.equal(assessTransfer(doc, 'resolve').items.some((item) => item.property === 'text'), false);
});

// --- texte illisible -----------------------------------------------------------------------------

test("un texte OPAQUE ne devient pas un titre", () => {
  // Sur un titre NATIF de Premiere, `getValue()` du paramètre « Texte source » ne rend pas la
  // phrase saisie mais une valeur opaque — mesuré : un unique « ļ ». Poser ce caractère chez la
  // cible fabrique un titre FAUX là où l'utilisateur en attendait un vrai.
  for (const text of ['ļ', 'A', '—', '\u0001\u0002', ' ']) {
    const doc = normalizeDoc(docFromAdobeSequence(snapshot({
      name: 'Titre', path: null, tlStartFrame: 0, tlEndFrame: 50, graphic: { text },
    }), 'S1'));
    assert.deepEqual(doc.graphics, [], `« ${text} » ne doit pas devenir un titre`);
    assert.equal(doc.mediaLess.length, 1);
  }
});

test('un vrai texte passe, accents et chiffres compris', () => {
  for (const text of ['Mon titre', 'Chapitre 1', 'Épisode 12', '第一話']) {
    const doc = normalizeDoc(docFromAdobeSequence(snapshot({
      name: 'Titre', path: null, tlStartFrame: 0, tlEndFrame: 50, graphic: { text },
    }), 'S1'));
    assert.equal(doc.graphics.length, 1, `« ${text} » doit devenir un titre`);
    assert.equal(doc.graphics[0].text, text);
  }
});
