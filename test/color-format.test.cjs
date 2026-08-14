// Notations d'une couleur de palette (hex, rgb, hsl, hsb, oklch). Une conversion fausse ne se voit
// pas à l'œil sur une pastille — elle se voit une fois la valeur collée dans l'autre logiciel — donc
// on la vérifie sur des couleurs de référence, en exécutant vraiment le module.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const rel = 'src/components/reference/colorFormat.ts';
const js = esbuild.transformSync(fs.readFileSync(path.join(root, rel), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const mod = new Module(rel, null);
mod._compile(js, path.join(root, rel));
const { formatColor, COLOR_FORMATS } = mod.exports;

test('hex round-trips and is normalised upper case', () => {
  assert.equal(formatColor('#ee4063', 'hex'), '#EE4063');
  assert.equal(formatColor('ee4063', 'hex'), '#EE4063');
  // Forme courte : #abc vaut #aabbcc.
  assert.equal(formatColor('#abc', 'hex'), '#AABBCC');
});

test('rgb gives the three channels as CSS expects them', () => {
  assert.equal(formatColor('#EE4063', 'rgb'), 'rgb(238, 64, 99)');
  assert.equal(formatColor('#000000', 'rgb'), 'rgb(0, 0, 0)');
  assert.equal(formatColor('#FFFFFF', 'rgb'), 'rgb(255, 255, 255)');
});

test('hsl matches the primaries and the greys', () => {
  assert.equal(formatColor('#FF0000', 'hsl'), 'hsl(0, 100%, 50%)');
  assert.equal(formatColor('#00FF00', 'hsl'), 'hsl(120, 100%, 50%)');
  assert.equal(formatColor('#0000FF', 'hsl'), 'hsl(240, 100%, 50%)');
  // Un gris n'a pas de teinte et pas de saturation, quelle que soit sa clarté.
  assert.equal(formatColor('#808080', 'hsl'), 'hsl(0, 0%, 50%)');
  assert.equal(formatColor('#FFFFFF', 'hsl'), 'hsl(0, 0%, 100%)');
});

test('hsb keeps the max channel as brightness, unlike hsl', () => {
  // Rouge pur : HSL le dit à 50 % de clarté, HSB à 100 % de luminosité — c'est toute la différence
  // entre les deux notations, et la raison d'offrir les deux.
  assert.equal(formatColor('#FF0000', 'hsb'), 'hsb(0, 100%, 100%)');
  assert.equal(formatColor('#800000', 'hsb'), 'hsb(0, 100%, 50%)');
  assert.equal(formatColor('#FFFFFF', 'hsb'), 'hsb(0, 0%, 100%)');
});

test('oklch places the reference colours where the spec says', () => {
  // Valeurs de référence d'Ottosson : le rouge sRGB est L≈0,628 C≈0,258 H≈29.
  const red = formatColor('#FF0000', 'oklch');
  const m = /^oklch\((\d+)% ([\d.]+) (\d+)\)$/.exec(red);
  assert.ok(m, `format inattendu : ${red}`);
  assert.ok(Math.abs(Number(m[1]) - 63) <= 1, `L ${m[1]}%`);
  assert.ok(Math.abs(Number(m[2]) - 0.258) <= 0.005, `C ${m[2]}`);
  assert.ok(Math.abs(Number(m[3]) - 29) <= 1, `H ${m[3]}`);
  // Le blanc est à clarté pleine et sans chroma.
  assert.match(formatColor('#FFFFFF', 'oklch'), /^oklch\(100% 0\.000 \d+\)$/);
});

test('an unreadable value is returned untouched in every format', () => {
  for (const f of COLOR_FORMATS) assert.equal(formatColor('pas une couleur', f), 'pas une couleur');
});
