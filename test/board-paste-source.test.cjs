// Lien d'origine d'un média collé ou glissé depuis un navigateur. « Copier l'image » ne transporte
// que des octets réencodés : l'adresse exacte n'existe que dans la saveur `text/html` du même
// presse-papier. La perdre au collage rend l'item irréparable et le post introuvable — d'où ces cas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const Module = require('node:module');

const root = path.join(__dirname, '..');
const rel = 'src/components/reference/useBoardIngest.ts';
// Le module tire React, le store et le pont : on ne garde que les fonctions pures du haut de fichier.
const src = fs.readFileSync(path.join(root, rel), 'utf8')
  .replace(/^import[\s\S]*?from "[^"]*";$/gm, '')
  .replace(/^export function useBoardIngest[\s\S]*$/m, '');
const js = esbuild.transformSync(src, { loader: 'ts', format: 'cjs' }).code;
const mod = new Module(rel, null);
mod._compile(js, path.join(root, rel));
const { pastedSourceUrl } = mod.exports;

// DataTransfer réduit à ce que la fonction lit : une saveur → une chaîne.
const clipboard = (flavors) => ({ getData: (type) => flavors[type] ?? '' });

test('the exact media address is read from the HTML flavour', () => {
  const url = 'https://i.redd.it/abc123.jpg';
  assert.equal(
    pastedSourceUrl(clipboard({ 'text/html': `<meta charset="utf-8"><img src="${url}" alt="x">` })),
    url,
  );
});

test('entities of a signed CDN query string are decoded', () => {
  const html = '<img src="https://cdn.example.com/a.jpg?ex=68f&amp;is=68e&amp;hm=9c">';
  assert.equal(pastedSourceUrl(clipboard({ 'text/html': html })), 'https://cdn.example.com/a.jpg?ex=68f&is=68e&hm=9c');
});

test('a video or a source tag counts as much as an image', () => {
  assert.equal(
    pastedSourceUrl(clipboard({ 'text/html': '<video><source src="https://v.example.com/clip.mp4" type="video/mp4"></video>' })),
    'https://v.example.com/clip.mp4',
  );
});

test('a relative or data source is not a durable link', () => {
  assert.equal(pastedSourceUrl(clipboard({ 'text/html': '<img src="/static/a.png">' })), '');
  assert.equal(pastedSourceUrl(clipboard({ 'text/html': '<img src="data:image/png;base64,iVBOR">' })), '');
});

test('without HTML, the URI list then the plain text answer', () => {
  assert.equal(
    pastedSourceUrl(clipboard({ 'text/uri-list': 'https://x.com/user/status/1  ' })),
    'https://x.com/user/status/1',
  );
  assert.equal(
    pastedSourceUrl(clipboard({ 'text/plain': 'https://www.instagram.com/p/Dc1/' })),
    'https://www.instagram.com/p/Dc1/',
  );
});

test('plain prose is never mistaken for a link', () => {
  assert.equal(pastedSourceUrl(clipboard({ 'text/plain': 'regarde https://x.com/a et dis-moi' })), '');
  assert.equal(pastedSourceUrl(clipboard({})), '');
});
