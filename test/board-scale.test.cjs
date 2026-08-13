// Tenue du board de référence à GRANDE échelle : plusieurs centaines de médias, dont beaucoup
// d'éléments animés (GIF, séquences, vidéos en boucle). Chaque règle ici a un coût mesurable en
// O(items) ou en lecteurs média, et se casse en retouchant une seule ligne.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// La frame d'une séquence en lecture est de l'état de VUE, pas du document. Tant qu'elle vivait dans
// `items`, chaque image recréait le tableau entier : le culling refiltrait tout, la barre d'outils et
// le panneau se réveillaient, et dix séquences à 12 images/s re-rendaient le board 120 fois par
// seconde. Le coût était en O(items × séquences × cadence).
test('a playing sequence does not rewrite the whole item list on every frame', () => {
  const store = read('src/components/reference/useReferenceBoard.ts');
  const setSeq = store.slice(store.indexOf('setSeqFrame: (id, frame)'));
  const body = setSeq.slice(0, setSeq.indexOf('\n\n'));
  assert.doesNotMatch(body, /items:/,
    'setSeqFrame must write the live frame only, never rebuild `items`');
  assert.match(body, /seqFrames/);
  // La position doit tout de même rejoindre le document, sinon une scène rouvre toujours au début.
  assert.match(store, /commitSeqFrame: \(id, frame\)/);
  assert.match(read('src/components/reference/BoardItem.tsx'), /commitSeqFrame\(item\.id, live\)/,
    'the last position must be committed when playback stops');
});

// Le board doit borner ce qui consomme un lecteur média : Chromium cesse d'en créer au-delà d'environ
// 75 par frame, sans erreur, et la zone de culling couvre 6,25 fois l'aire du viewport.
test('the board caps how many media items can be mounted at once', () => {
  const src = read('src/components/reference/useBoardCulling.ts');
  const budget = Number(/const MEDIA_BUDGET = (\d+)/.exec(src)[1]);
  assert.ok(budget > 0 && budget <= 60, `media budget ${budget} must stay well under the browser limit`);
  assert.match(src, /MEDIA_KINDS\.has\(it\.kind\)/);
  assert.match(src, /it\.id === editingId \|\| selectedIds\.includes\(it\.id\)/,
    'an item under an active gesture must never be dropped by the budget');
});

// « Tout figer » doit vraiment tout figer. Un <img> animé (GIF, WebP) ne se met pas en pause : sans
// bascule vers une frame peinte, le bouton de gel ne change rien pour eux — et l'ingestion Giphy en
// pose beaucoup.
test('freezing the board also stops animated images', () => {
  const src = read('src/components/reference/BoardItem.tsx');
  assert.match(src, /const ANIMATED_IMAGE_RE = .*gif/);
  assert.match(src, /drawImage\(img, 0, 0\)/,
    'a frozen animated image must be painted once into a canvas');
  const comp = src.slice(src.indexOf('function ImageContent'));
  assert.match(comp.slice(0, comp.indexOf('\n}\n')), /useBoard\(\(s\) => s\.frozen\)/,
    'the swap must follow the explicit freeze, not the transient navigation pause');
});

// Les médias LOCAUX du board sortent par le protocole asset. Le serveur HTTP du core partage son
// origine avec /rpc et le flux d'événements, et un webview n'ouvre que 6 connexions par origine.
test('board media are served by the shell, not by the core HTTP server', () => {
  const shared = read('src/components/reference/referenceShared.ts');
  assert.match(shared, /return nr\.assetUrl\(ref\)/);
  assert.match(shared, /nr\.streamUrl\(ref, 0, "copy"\)/,
    'the live remux has no file on disk: it must stay on the HTTP server');
  assert.match(read('src/components/reference/BoardItem.tsx'), /setProxUrl\(nr\.assetUrl\(r\.path\)\)/);
});

// Reculer une vidéo en écrivant `currentTime` force un décodage depuis la keyframe précédente. À la
// cadence de l'écran et par item, un board qui porte des dizaines d'aller-retours noie le décodeur.
test('ping-pong playback steps backwards on a budget, not on every frame', () => {
  const src = read('src/components/reference/BoardItem.tsx');
  assert.match(src, /const BACKSTEP_MS = (\d+)/);
  assert.match(src, /if \(back >= BACKSTEP_MS\)/);
});
