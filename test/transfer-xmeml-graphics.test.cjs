// Titres d'un export FCP7 XML : lecture du texte, et retrait du document avant import.
//
// Pourquoi ce module existe, mesuré sur Resolve Studio 21.0.3 : un titre Premiere est un média
// synthétique dont le `<file>` ne porte AUCUN `<pathurl>`, et `ImportTimelineFromFile` refuse alors
// le fichier ENTIER — sans exception ni message — pendant que Fichier ▸ Importer ▸ Timeline accepte
// le même document. Un seul titre condamnait tout le transfert, plans et images clés compris.
//
// Le blob ci-dessous est un VRAI paramètre « Texte source » exporté par Premiere Pro : le texte
// saisi était « test beta » + retour chariot + « yes », en Tahoma.

const test = require('node:test');
const assert = require('node:assert');
const { extractGraphics, flatStrings, titleContent } = require('../core/transfer/xmeml/graphics');

const REAL_BLOB = 'PAEAAAAAAABEMyIRDAAAAAAABgAKAAQABgAAAGQAAAAAAF4AGAAQAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAABcABwBeAAAAAAAAARAAAAAcA'
  + 'AAALAAAAAAAAQBY////XP///2D///9k////AQAAAAQAAAAGAAAAVGFob21hAAABAAAADAAAAAgADAAEAAgACAAAAAgAAABMA'
  + 'AAADQAAAHRlc3QgYmV0YQ15ZXMANgAUAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAIA'
  + 'AQANgAAAAIAAAAMAAAADAAAAAAAgED0////+P////z///8EAAQABAAAAA==';

const RATE = '<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>';

function videoClip(id, fileId, pathurl) {
  return `<clipitem id="${id}"><name>${id}</name><start>0</start><end>29</end><in>0</in><out>29</out>${RATE}`
    + `<file id="${fileId}"><name>${fileId}</name><pathurl>${pathurl}</pathurl>${RATE}</file></clipitem>`;
}

function titleClip(id, start, end, effectName, blob) {
  return `<clipitem id="${id}"><name>Image</name><start>${start}</start><end>${end}</end><in>0</in><out>90</out>${RATE}`
    + `<file id="file-title"><name>Image</name><mediaSource>GraphicAndType</mediaSource>${RATE}</file>`
    + '<filter><effect>'
    + `<name>${effectName}</name><effectid>GraphicAndType</effectid><effectcategory>graphic</effectcategory>`
    + `<parameter><parameterid>1</parameterid><name>Texte source</name><value>${blob}</value></parameter>`
    + '</effect></filter></clipitem>';
}

function document(body) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">'
    + `<sequence id="seq-1"><name>1</name>${RATE}<media><video>${body}</video></media></sequence></xmeml>`;
}

test('le blob de Premiere rend la police et le texte saisi', () => {
  const strings = flatStrings(REAL_BLOB);
  assert.ok(strings.includes('Tahoma'), `police absente : ${JSON.stringify(strings)}`);
  assert.ok(strings.includes('test beta\ryes'), `texte absent : ${JSON.stringify(strings)}`);
});

test('le nom de l’effet désigne laquelle des chaînes est le texte', () => {
  const { text, font } = titleContent(REAL_BLOB, 'test beta\ryes');
  assert.strictEqual(text, 'test beta\nyes');
  assert.strictEqual(font, 'Tahoma');
});

test('un graphique renommé garde son texte, pas son nom', () => {
  // L'utilisateur a renommé le calque : le nom ne désigne plus rien, seule la forme départage.
  const { text, font } = titleContent(REAL_BLOB, 'Titre du chapitre');
  assert.strictEqual(text, 'test beta\nyes');
  assert.strictEqual(font, 'Tahoma');
});

test('le nom de l’effet ne tient jamais lieu de texte', () => {
  // Mesuré : un graphique porte aussi des calques qui ne sont pas du texte — « Vector Motion » —
  // dont le nom se retrouvait collé dans le titre. Un titre perdu se voit, un mot inventé non.
  assert.deepStrictEqual(flatStrings('pas du base64 !!!'), []);
  assert.strictEqual(titleContent('', 'Mon titre').text, '');
  assert.strictEqual(titleContent('', 'Vector Motion').text, '');
});

test('le titre devient un générateur de texte, à sa place exacte', () => {
  const source = document(
    `<track>${videoClip('ci-1', 'file-1', 'file://localhost/S%3a/test/1.mov')}</track>`
    + `<track>${titleClip('ci-t', 120, 210, 'test beta&#13;yes', REAL_BLOB)}</track>`);
  const { text, graphics, titles, dropped } = extractGraphics(source);

  assert.strictEqual(titles, 1);
  assert.strictEqual(dropped, 0);
  assert.ok(!text.includes('<clipitem id="ci-t"'), 'le clip de titre est resté dans le document');
  assert.ok(text.includes('ci-1'), 'le plan vidéo a été emporté avec le titre');
  assert.strictEqual(graphics.length, 1);
  assert.deepStrictEqual(graphics[0], {
    track: 2, name: 'Image', tlStart: 120, tlEnd: 210, text: 'test beta\nyes', font: 'Tahoma', size: 100,
  });

  // Le générateur prend la PLACE du clip retiré : même piste, mêmes images, même durée.
  const generator = /<generatoritem[\s\S]*?<\/generatoritem>/.exec(text);
  assert.ok(generator, 'aucun générateur écrit');
  assert.match(generator[0], /<effectid>Text<\/effectid>/);
  assert.match(generator[0], /<start>120<\/start><end>210<\/end>/);
  assert.match(generator[0], /<out>90<\/out>/);
  assert.match(generator[0], /<parameterid>str<\/parameterid><name>Text<\/name><value>test beta&#13;yes<\/value>/);
  assert.match(generator[0], /<parameterid>fontname<\/parameterid><name>Font<\/name><value>Tahoma<\/value>/);
  assert.match(generator[0], /<parameterid>fontsize<\/parameterid><name>Size<\/name><value>100<\/value>/);
  // Le générateur est resté sur la piste du titre, pas remonté avec le premier plan.
  assert.ok(text.indexOf('<generatoritem') > text.indexOf('ci-1'), 'le titre a changé de piste');
});

test('la piste du titre est celle du document, pas la première venue', () => {
  const source = document(
    `<track>${videoClip('ci-1', 'file-1', 'file://localhost/S%3a/test/1.mov')}</track>`
    + '<track></track>'
    + `<track>${titleClip('ci-t', 0, 50, 'Chapitre 1', REAL_BLOB)}</track>`);
  const { graphics } = extractGraphics(source);
  assert.strictEqual(graphics.length, 1);
  assert.strictEqual(graphics[0].track, 3);
});

test('une référence <file id="…"/> reste un vrai média', () => {
  // Le second plan renvoie au fichier déjà défini : sans chemin PROPRE, il n'en est pas moins réel.
  const reused = `<clipitem id="ci-2"><name>2</name><start>30</start><end>60</end><in>0</in><out>30</out>${RATE}`
    + '<file id="file-1"/></clipitem>';
  const source = document(`<track>${videoClip('ci-1', 'file-1', 'file://localhost/S%3a/test/1.mov')}${reused}</track>`);
  const { text, graphics, titles, dropped } = extractGraphics(source);
  assert.strictEqual(titles + dropped, 0);
  assert.strictEqual(graphics.length, 0);
  assert.ok(text.includes('ci-2'), 'la référence de fichier a été prise pour un élément sans média');
});

test('un élément sans média et sans texte sort quand même du document', () => {
  // Cache de couleur, calque d'effet : rien à recréer, mais l'import échouerait pareil.
  const opaque = `<clipitem id="ci-x"><name>Cache</name><start>0</start><end>25</end><in>0</in><out>25</out>${RATE}`
    + '<file id="file-x"><name>Cache</name></file></clipitem>';
  const { text, graphics, titles, dropped } = extractGraphics(document(`<track>${opaque}</track>`));
  assert.strictEqual(dropped, 1);
  assert.strictEqual(titles, 0);
  assert.strictEqual(graphics.length, 0);
  assert.ok(!text.includes('ci-x'));
  assert.ok(!text.includes('<generatoritem'), 'un titre a été fabriqué sans texte');
});

test('un document sans titre traverse inchangé', () => {
  const source = document(`<track>${videoClip('ci-1', 'file-1', 'file://localhost/S%3a/test/1.mov')}</track>`);
  const { text, graphics, titles, dropped } = extractGraphics(source);
  assert.strictEqual(titles + dropped, 0);
  assert.strictEqual(graphics.length, 0);
  assert.strictEqual(text, source);
});

// Un graphique Premiere porte un calque par élément (texte, forme, image), chacun sorti en effet
// distinct. Mesuré : dès qu'un second calque est ajouté, ne lire que le PREMIER tombait sur celui
// sans texte et le titre disparaissait du transfert — `strings: []`, `effectName: ""`.
function layerlessEffect() {
  return '<filter><effect><name></name><effectid>GraphicAndType</effectid>'
    + '<effectcategory>graphic</effectcategory>'
    + '<parameter><parameterid>1</parameterid><name>Texte source</name>'
    // Blob RÉEL d'un calque sans texte, relevé en production : aucune chaîne dedans.
    + '<value>mAAAAAAAAABEMyIRDAAAAAAABgAKAAQABgAAAGQAAAAAAF4AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAA8ABwBeAAAAAAAAAQgA'
    + 'AAAAAAEA9P////j////8////BAAEAAQAAAA=</value></parameter>'
    + '</effect></filter>';
}

function twoLayerTitle(id, start, end) {
  const withText = `<filter><effect><name>test beta&#13;yes</name><effectid>GraphicAndType</effectid>`
    + '<effectcategory>graphic</effectcategory>'
    + `<parameter><parameterid>1</parameterid><name>Texte source</name><value>${REAL_BLOB}</value></parameter>`
    + '</effect></filter>';
  return `<clipitem id="${id}"><name>Image</name><start>${start}</start><end>${end}</end><in>0</in><out>90</out>${RATE}`
    + `<file id="file-title"><name>Image</name><mediaSource>GraphicAndType</mediaSource>${RATE}</file>`
    + layerlessEffect() + withText + '</clipitem>';
}

test('le calque sans texte ne masque plus celui qui en porte', () => {
  const source = document(`<track>${twoLayerTitle('ci-t', 5, 130)}</track>`);
  const { graphics, titles } = extractGraphics(source);
  assert.strictEqual(titles, 1, 'le titre a été jeté alors qu’un calque portait du texte');
  assert.strictEqual(graphics[0].text, 'test beta\nyes');
  assert.strictEqual(graphics[0].font, 'Tahoma');
});

test('deux calques de texte sont empilés, jamais perdus', () => {
  const second = '<filter><effect><name>Chapitre 1</name><effectid>GraphicAndType</effectid>'
    + '<effectcategory>graphic</effectcategory>'
    + `<parameter><parameterid>1</parameterid><name>Texte source</name><value>${REAL_BLOB}</value></parameter>`
    + '</effect></filter>';
  const clip = twoLayerTitle('ci-t', 5, 130).replace('</clipitem>', `${second}</clipitem>`);
  const { graphics } = extractGraphics(document(`<track>${clip}</track>`));
  assert.strictEqual(graphics.length, 1, 'un graphique reste UN titre chez la cible');
  assert.strictEqual(graphics[0].text, 'test beta\nyes\ntest beta\nyes');
});

test('un graphique dont AUCUN calque ne porte de texte est écarté', () => {
  const clip = `<clipitem id="ci-x"><name>Forme</name><start>0</start><end>25</end><in>0</in><out>25</out>${RATE}`
    + `<file id="file-s"><name>Forme</name><mediaSource>GraphicAndType</mediaSource>${RATE}</file>`
    + layerlessEffect() + '</clipitem>';
  const { text, titles, dropped } = extractGraphics(document(`<track>${clip}</track>`));
  assert.strictEqual(titles, 0);
  assert.strictEqual(dropped, 1);
  assert.ok(!text.includes('<clipitem id="ci-x"'), 'un élément sans média est resté dans l’import');
});

// Corps de la police. Les deux blobs ci-dessous sont le MÊME titre exporté par Premiere à 100 puis
// à 200 : le second fait 4 octets de plus et porte `00 00 48 43`, soit le flottant 200.0. À 100 ce
// champ est ABSENT — sémantique FlatBuffers, un champ égal à son défaut n'est pas écrit — d'où le
// repli sur 100, confirmé par la taille que Premiere affichait.
const BLOB_200 = 'QAEAAAAAAABEMyIRDAAAAAAABgAKAAQABgAAAGQAAAAAAF4AGAAQAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  + 'AAAAAAAAAAAAAAAAAAAAAAAAAFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAABcABwBeAAAAAAAAARAAAAAcAA'
  + 'AALAAAAAAAAQBU////WP///1z///9g////AQAAAAQAAAAGAAAAVGFob21hAAABAAAADAAAAAgADAAEAAgACAAAAAgAAABMA'
  + 'AAADQAAAHRlc3QgYmV0YQ15ZXMANgAYAAAAFAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAI'
  + 'AAQANgAAAAIAAAAQAAAAEAAAAAAAgEAAAEhD9P////j////8////BAAEAAQAAAA==';

test('le corps absent du blob vaut le défaut de Premiere', () => {
  assert.strictEqual(titleContent(REAL_BLOB, 'test beta\ryes').size, 100);
});

test('le corps écrit dans le blob est lu tel quel', () => {
  assert.strictEqual(titleContent(BLOB_200, 'test beta\ryes').size, 200);
});

test('le corps voyage jusqu’au générateur', () => {
  const source = document(`<track>${titleClip('ci-t', 5, 130, 'test beta&#13;yes', BLOB_200)}</track>`);
  const { text, graphics } = extractGraphics(source);
  assert.strictEqual(graphics[0].size, 200);
  assert.match(text, /<parameterid>fontsize<\/parameterid><name>Size<\/name><value>200<\/value>/);
});

test('un blob illisible ne fabrique pas un corps aberrant', () => {
  assert.strictEqual(titleContent('pas du base64 !!!', 'Mon titre').size, 100);
});

// L'échelle du calque MULTIPLIE le corps de la police : agrandir un titre en tirant sur sa boîte
// change l'échelle, pas le corps. Mesuré sur un export réel — 200 points à 298,26 % s'affichent
// comme du 596, et n'écrire que 200 rendait le titre trois fois trop petit chez la cible.
function scaledTitle(id, blob, scale) {
  return `<clipitem id="${id}"><name>Image</name><start>5</start><end>130</end><in>0</in><out>125</out>${RATE}`
    + `<file id="file-title"><name>Image</name><mediaSource>GraphicAndType</mediaSource>${RATE}</file>`
    + '<filter><effect><name>test beta&#13;yes</name><effectid>GraphicAndType</effectid>'
    + '<effectcategory>graphic</effectcategory>'
    + `<parameter><parameterid>1</parameterid><name>Texte source</name><value>${blob}</value></parameter>`
    + '<parameter><parameterid>4</parameterid><name>Echelle</name>'
    + `<value>-91445760000000000,${scale},0,0,0,0,0,0</value></parameter>`
    + '</effect></filter></clipitem>';
}

test('le corps est multiplié par l’échelle du calque', () => {
  const source = document(`<track>${scaledTitle('ci-t', BLOB_200, '298.257690429688')}</track>`);
  const { text, graphics } = extractGraphics(source);
  assert.strictEqual(graphics[0].size, 597);
  assert.match(text, /<parameterid>fontsize<\/parameterid><name>Size<\/name><value>597<\/value>/);
});

test('une échelle à 100 % laisse le corps intact', () => {
  const { graphics } = extractGraphics(document(`<track>${scaledTitle('ci-t', BLOB_200, '100.')}</track>`));
  assert.strictEqual(graphics[0].size, 200);
});

test('une échelle illisible ne déforme pas le corps', () => {
  // Mieux vaut le corps nu qu'un titre à une taille tirée d'une valeur qu'on n'a pas su lire.
  const { graphics } = extractGraphics(document(`<track>${scaledTitle('ci-t', BLOB_200, 'nimporte quoi')}</track>`));
  assert.strictEqual(graphics[0].size, 200);
});

// Calque de MOUVEMENT à côté du calque de texte. Mesuré en production : son nom, « Vector Motion »,
// se retrouvait collé en tête du titre (« Vector Motion\ntest beta\nyes ») et son blob servait à
// lire le corps — 197 au lieu de 597. Il ne porte aucune chaîne : il ne doit rien apporter.
function motionLayer() {
  return '<filter><effect><name>Vector Motion</name><effectid>GraphicAndType</effectid>'
    + '<effectcategory>graphic</effectcategory>'
    + '<parameter><parameterid>1</parameterid><name>Texte source</name>'
    + '<value>mAAAAAAAAABEMyIRDAAAAAAABgAKAAQABgAAAGQAAAAAAF4AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAA8ABwBeAAAAAAAAAQgA'
    + 'AAAAAAEA9P////j////8////BAAEAAQAAAA=</value></parameter>'
    + '<parameter><parameterid>4</parameterid><name>Echelle</name>'
    + '<value>-91445760000000000,100.,0,0,0,0,0,0</value></parameter>'
    + '</effect></filter>';
}

test('un calque de mouvement n’ajoute pas son nom au titre', () => {
  const clip = `<clipitem id="ci-t"><name>Image</name><start>5</start><end>130</end><in>0</in><out>125</out>${RATE}`
    + `<file id="file-title"><name>Image</name><mediaSource>GraphicAndType</mediaSource>${RATE}</file>`
    + motionLayer()
    + '<filter><effect><name>test beta&#13;yes</name><effectid>GraphicAndType</effectid>'
    + '<effectcategory>graphic</effectcategory>'
    + `<parameter><parameterid>1</parameterid><name>Texte source</name><value>${BLOB_200}</value></parameter>`
    + '<parameter><parameterid>4</parameterid><name>Echelle</name>'
    + '<value>-91445760000000000,298.257690429688,0,0,0,0,0,0</value></parameter>'
    + '</effect></filter></clipitem>';
  const { graphics, titles } = extractGraphics(document(`<track>${clip}</track>`));

  assert.strictEqual(titles, 1);
  assert.strictEqual(graphics[0].text, 'test beta\nyes');
  // Le corps vient du calque de TEXTE, pas du premier calque venu.
  assert.strictEqual(graphics[0].size, 597);
  assert.strictEqual(graphics[0].font, 'Tahoma');
});

// --- Titres RESOLVE : `<generatoritem>`, pas un clip graphique Premiere ------------------------
// Resolve exporte un Text+ comme générateur FCP7 (texte, police et corps en clair). L'API de script
// ne rend rien de tout cela : sans cette lecture, un titre quittait Resolve sans laisser de trace.

const { parseXmeml } = require('../core/transfer/xmeml');

const RESOLVE_TITLE = `<generatoritem id="Text 0"><name>Text</name><duration>250</duration>${RATE}`
  + '<in>0</in><out>125</out><start>165</start><end>290</end><enabled>TRUE</enabled>'
  + '<effect><name>Text</name><effectid>Text</effectid><effecttype>generator</effecttype>'
  + '<mediatype>video</mediatype><effectcategory>Text</effectcategory>'
  + '<parameter><name>Text</name><parameterid>str</parameterid><value>test beta&#xd;yes</value></parameter>'
  + '<parameter><name>Font</name><parameterid>fontname</parameterid><value>Tahoma</value></parameter>'
  + '<parameter><name>Size</name><parameterid>fontsize</parameterid><value>298</value></parameter>'
  + `${RATE}<duration>125</duration></effect></generatoritem>`;

function resolveSequence(videoTracks) {
  return '<xmeml version="5"><sequence><name>2</name><duration>290</duration>' + RATE
    + '<media><video><format><samplecharacteristics><width>1920</width><height>1080</height>'
    + `${RATE}</samplecharacteristics></format>${videoTracks}</video></media></sequence></xmeml>`;
}

test('Resolve : un générateur de texte devient un titre du document, sur SA piste', () => {
  const clip = `<clipitem id="c1"><name>2.mov</name><start>35</start><end>194</end><in>0</in><out>159</out>${RATE}`
    + `<file id="f1"><name>2.mov</name><pathurl>file://localhost/C:/rush/2.mov</pathurl>${RATE}</file></clipitem>`;
  const read = parseXmeml(resolveSequence(`<track>${clip}</track><track></track><track>${RESOLVE_TITLE}</track>`), { host: 'resolve' });

  assert.strictEqual(read.ok, true);
  assert.strictEqual(read.clips.length, 1, 'un générateur n’est pas un plan : il n’a ni fichier ni bornes source');
  assert.strictEqual(read.graphics.length, 1);
  assert.deepStrictEqual(read.graphics[0], {
    track: 3, name: 'Text', tlStart: 165, tlEnd: 290, text: 'test beta\nyes', font: 'Tahoma', size: 298,
  });
});

test('Resolve : un générateur sans texte n’invente pas un titre vide', () => {
  const clip = `<clipitem id="c1"><name>2.mov</name><start>0</start><end>50</end><in>0</in><out>50</out>${RATE}`
    + `<file id="f1"><name>2.mov</name><pathurl>file://localhost/C:/rush/2.mov</pathurl>${RATE}</file></clipitem>`;
  const solid = '<generatoritem id="Solid 0"><name>Solid Color</name><start>0</start><end>50</end>'
    + '<effect><name>Solid</name><effectid>Solid</effectid><effecttype>generator</effecttype>'
    + '<parameter><name>Color</name><parameterid>color</parameterid><value>0</value></parameter>'
    + '</effect></generatoritem>';
  const read = parseXmeml(resolveSequence(`<track>${clip}${solid}</track>`), { host: 'resolve' });

  assert.strictEqual(read.ok, true);
  assert.strictEqual(read.graphics.length, 0);
});
