// Canaux audio éclatés d'un export Premiere.
//
// Avec `explodedTracks="true"`, un fichier STÉRÉO posé sur UNE piste sort du XML en DEUX clipitems
// mono qui ne diffèrent que par leur `<sourcetrack><trackindex>`. Mesuré : Resolve les prend au mot
// et pose deux fois le même son, sur deux pistes — le doublon visible après un transfert.

const test = require('node:test');
const assert = require('node:assert');
const { redundantChannelIds, tracksAreExploded } = require('../core/transfer/xmeml/audioChannels');
const { prepareForImport } = require('../core/transfer/xmeml/prepare');

const RATE = '<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate>';

function audioClip(id, fileId, start, end, channel, pathurl) {
  return `<clipitem id="${id}"><name>son.wav</name><start>${start}</start><end>${end}</end>`
    + `<in>0</in><out>${end - start}</out>${RATE}`
    + `<file id="${fileId}">${pathurl ? `<name>son.wav</name><pathurl>${pathurl}</pathurl>${RATE}` : ''}</file>`
    + `<sourcetrack><mediatype>audio</mediatype><trackindex>${channel}</trackindex></sourcetrack></clipitem>`;
}

function document(audioBody, exploded = true) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="4">'
    + `<sequence id="seq-1"${exploded ? ' explodedTracks="true"' : ''}><name>1</name>${RATE}`
    + `<media><video><track></track></video><audio>${audioBody}</audio></media></sequence></xmeml>`;
}

const PATH = 'file://localhost/S%3a/test/son.wav';

test('les deux canaux d’un stéréo se réduisent à un seul clip', () => {
  const source = document(
    `<track>${audioClip('a1', 'f-1', 0, 10, 1, PATH)}</track>`
    + `<track>${audioClip('a2', 'f-1', 0, 10, 2)}</track>`);
  const dropped = redundantChannelIds(source);
  assert.deepStrictEqual([...dropped], ['a2']);

  const { text, channels } = prepareForImport(source);
  assert.strictEqual(channels, 1);
  assert.ok(text.includes('<clipitem id="a1"'), 'le canal gauche a disparu');
  assert.ok(!text.includes('<clipitem id="a2"'), 'le canal droit est resté');
});

test('le canal de plus petit rang est celui qui reste', () => {
  // L'ordre du document n'est pas garanti : c'est le rang qui départage, pas la position.
  const source = document(
    `<track>${audioClip('a2', 'f-1', 0, 10, 2, PATH)}</track>`
    + `<track>${audioClip('a1', 'f-1', 0, 10, 1)}</track>`);
  assert.deepStrictEqual([...redundantChannelIds(source)], ['a2']);
});

test('deux sons à des POSITIONS différentes ne sont pas des canaux', () => {
  const source = document(
    `<track>${audioClip('a1', 'f-1', 0, 10, 1, PATH)}</track>`
    + `<track>${audioClip('a2', 'f-1', 40, 50, 2)}</track>`);
  assert.strictEqual(redundantChannelIds(source).size, 0);
});

test('un même son délibérément posé deux fois garde son rang de canal', () => {
  // Deux clips au même endroit sur deux pistes portent le MÊME trackindex : rien à recoller.
  const source = document(
    `<track>${audioClip('a1', 'f-1', 0, 10, 1, PATH)}</track>`
    + `<track>${audioClip('a3', 'f-1', 0, 10, 1)}</track>`);
  assert.strictEqual(redundantChannelIds(source).size, 0);
});

test('sans le drapeau explodedTracks, rien n’est touché', () => {
  const source = document(
    `<track>${audioClip('a1', 'f-1', 0, 10, 1, PATH)}</track>`
    + `<track>${audioClip('a2', 'f-1', 0, 10, 2)}</track>`, false);
  assert.strictEqual(tracksAreExploded(require('../core/transfer/xmeml/xmlText').parseXml(source)), false);
  assert.strictEqual(redundantChannelIds(source).size, 0);
});

test('un mono sans sourcetrack traverse intact', () => {
  const bare = `<clipitem id="a1"><name>son.wav</name><start>0</start><end>10</end><in>0</in><out>10</out>${RATE}`
    + `<file id="f-1"><name>son.wav</name><pathurl>${PATH}</pathurl>${RATE}</file></clipitem>`;
  const source = document(`<track>${bare}</track>`);
  assert.strictEqual(redundantChannelIds(source).size, 0);
  assert.ok(prepareForImport(source).text.includes('<clipitem id="a1"'));
});

test('les pistes VIDÉO ne sont jamais recollées', () => {
  // Un plan vidéo n'a pas de canaux : deux clips identiques y sont deux clips.
  const clip = `<clipitem id="v1"><name>1.mov</name><start>0</start><end>10</end><in>0</in><out>10</out>${RATE}`
    + `<file id="f-v"><name>1.mov</name><pathurl>file://localhost/S%3a/test/1.mov</pathurl>${RATE}</file>`
    + '<sourcetrack><mediatype>video</mediatype><trackindex>2</trackindex></sourcetrack></clipitem>';
  const source = '<?xml version="1.0" encoding="UTF-8"?>\n<xmeml version="4">'
    + `<sequence id="seq-1" explodedTracks="true"><name>1</name>${RATE}`
    + `<media><video><track>${clip}</track></video></media></sequence></xmeml>`;
  assert.strictEqual(redundantChannelIds(source).size, 0);
  assert.ok(prepareForImport(source).text.includes('<clipitem id="v1"'));
});

test('la piste qui ne portait qu’un canal disparaît avec lui', () => {
  // Sans ce retrait, chaque stéréo laisse une piste VIDE : Premiere en montrait deux, la cible
  // en recevrait quatre.
  const { collapseAudioChannels } = require('../core/transfer/xmeml/audioChannels');
  const source = document(
    `<track>${audioClip('a1', 'f-1', 0, 10, 1, PATH)}</track>`
    + `<track>${audioClip('a2', 'f-1', 0, 10, 2)}</track>`
    + `<track>${audioClip('b1', 'f-2', 20, 30, 1, PATH)}</track>`
    + `<track>${audioClip('b2', 'f-2', 20, 30, 2)}</track>`);
  const { text, channels } = collapseAudioChannels(source);
  assert.strictEqual(channels, 2);
  assert.strictEqual((text.match(/<track>/g) || []).length, 3, 'pistes restantes (1 vidéo + 2 audio)');
  assert.ok(text.includes('<clipitem id="a1"') && text.includes('<clipitem id="b1"'));
});

test('une piste qui porte AUSSI un clip gardé survit', () => {
  const { collapseAudioChannels } = require('../core/transfer/xmeml/audioChannels');
  const source = document(
    `<track>${audioClip('a1', 'f-1', 0, 10, 1, PATH)}</track>`
    + `<track>${audioClip('a2', 'f-1', 0, 10, 2)}${audioClip('c1', 'f-3', 60, 70, 1, PATH)}</track>`);
  const { text, channels } = collapseAudioChannels(source);
  assert.strictEqual(channels, 1);
  assert.ok(!text.includes('<clipitem id="a2"'), 'le canal est resté');
  assert.ok(text.includes('<clipitem id="c1"'), 'un clip gardé est parti avec sa piste');
});

test('une piste vidéo n’est jamais emportée', () => {
  const { collapseAudioChannels } = require('../core/transfer/xmeml/audioChannels');
  const source = document(
    `<track>${audioClip('a1', 'f-1', 0, 10, 1, PATH)}</track>`
    + `<track>${audioClip('a2', 'f-1', 0, 10, 2)}</track>`);
  const { text } = collapseAudioChannels(source);
  assert.ok(text.includes('<video><track></track></video>'), 'la piste vidéo vide a bougé');
});
