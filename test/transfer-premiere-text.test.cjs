// Retours à la ligne d'un titre, à l'aller Resolve → Premiere.
//
// Resolve écrit les sauts de ligne d'un Text+ en RÉFÉRENCE DE CARACTÈRE (`&#xd;`) : du XML légal,
// que l'importeur de Premiere ne décode pas. Vu à l'écran : « test beta&#xd;yes » écrit tel quel
// dans le titre, l'échappement affiché comme du texte.
const test = require('node:test');
const assert = require('node:assert/strict');

const { prepareForPremiere } = require('../core/transfer/xmeml/premiereText');

const generator = (value) => '<generatoritem id="Text 0"><name>Text</name><effect><name>Text</name>'
  + '<effecttype>generator</effecttype>'
  + `<parameter><name>Text</name><parameterid>str</parameterid><value>${value}</value></parameter>`
  + '<parameter><name>Font</name><parameterid>fontname</parameterid><value>Tahoma</value></parameter>'
  + '</effect></generatoritem>';

test('un saut de ligne échappé devient un vrai saut de ligne', () => {
  const out = prepareForPremiere(generator('test beta&#xd;yes'));
  assert.equal(out.newlines, 1);
  assert.match(out.text, /<value>test beta\nyes<\/value>/);
});

test('les formes décimale et majuscule sont couvertes', () => {
  assert.equal(prepareForPremiere(generator('a&#13;b')).newlines, 1);
  assert.equal(prepareForPremiere(generator('a&#XA;b')).newlines, 1);
  assert.equal(prepareForPremiere(generator('a&#10;b')).newlines, 1);
});

test('un CRLF écrit en deux références ne fait qu’UN saut de ligne', () => {
  const out = prepareForPremiere(generator('a&#xd;&#xa;b'));
  assert.equal(out.newlines, 1);
  assert.match(out.text, /<value>a\nb<\/value>/);
});

test('hors du texte d’un générateur, rien n’est touché', () => {
  // Un chemin de média ou un nom de plan n'a rien à voir avec un saut de ligne : y substituer
  // aveuglément abîmerait le document.
  const source = '<clipitem><name>a&#xd;b.mov</name><file><pathurl>file://localhost/C:/a&#xd;b.mov</pathurl></file></clipitem>';
  const out = prepareForPremiere(source);
  assert.equal(out.newlines, 0);
  assert.equal(out.text, source);
});

test('un document sans titre traverse inchangé', () => {
  const source = '<xmeml><sequence><name>2</name></sequence></xmeml>';
  assert.deepEqual(prepareForPremiere(source), { text: source, newlines: 0 });
});
