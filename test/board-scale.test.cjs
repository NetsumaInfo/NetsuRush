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
  assert.match(src, /it\.id === editingId \|\| pinned\.has\(it\.id\)/,
    'an item under an active gesture must never be dropped by the budget');
  // Set, pas `includes` : le test tourne pour chaque item, donc un tableau rendrait le filtrage
  // quadratique — précisément quand tout un mur d'images est sélectionné. Et l'épinglage est
  // PLAFONNÉ : un mur entier sélectionné ne doit pas contourner les budgets (cf. board-culling).
  assert.match(src, /const pinned = new Set\(selectedIds\.length <= FORCED_SELECTION_MAX \? selectedIds : \[\]\)/,
    'the pinned lookup must be O(1) and capped, not a scan of the whole selection per item');
  assert.doesNotMatch(src, /selectedIds\.includes/);
});

// Le pan est impératif depuis toujours ; le zoom, lui, commitait la vue au store à CHAQUE cran de
// molette → un re-render React complet du board par frame de zoom (~mille sélecteurs évalués +
// réconciliation de tous les items visibles), en pleine re-rasterisation GPU. Le zoom doit passer
// par le même chemin vivant que le pan, et ne committer qu'en fin de rafale.
test('wheel zoom goes through the imperative path and commits once per burst', () => {
  const src = read('src/components/reference/ReferenceBoard.tsx');
  const zoomAt = src.slice(src.indexOf('const zoomAt'));
  const body = zoomAt.slice(0, zoomAt.indexOf('\n  );'));
  assert.match(body, /liveView\.current = \{ tx:/, 'zoomAt must write the live view, not the store');
  assert.doesNotMatch(body, /setView\(/, 'no store commit inside the zoom hot path');
  // Le commit unique vit dans le timer de fin de rafale, et un geste qui tient déjà la vue vivante
  // garde la main : le pan, et le pincement à deux doigts qui commite au relâchement.
  assert.match(src, /if \(gesture\.current !== "pan" && gesture\.current !== "pinch" && liveView\.current\) \{/);
  // Une vue explicite (fit, reset, focus) annule la rafale en attente, sinon le commit différé
  // écraserait la vue qu'elle vient de poser.
  assert.match(src, /const commitView = useCallback/);
});

// Une vidéo suspendue (gel, navigation, mode « off ») ne doit pas bufferiser en entier : autoplay
// sans `preload` fait télécharger chaque flux monté — jusqu'à MEDIA_BUDGET connexions en plein geste.
test('a suspended video only preloads its metadata', () => {
  assert.match(read('src/components/reference/BoardItem.tsx'), /preload=\{playing \? "auto" : "metadata"\}/);
});

// Un lasso qui sélectionne un mur d'items ne doit animer AUCUNE ombre : chaque frame d'une
// transition de box-shadow repeint le raster complet de l'item, multiplié par la sélection.
test('selection rings switch instantly, no shadow transition on items', () => {
  const src = read('src/components/reference/BoardItem.tsx');
  // Le wrapper de CHAQUE item (celui qui porte shadow-lg + ring) : jamais de transition dessus.
  // La poignée de rotation, unique et montée seulement en sélection primaire, peut garder la sienne.
  assert.match(src, /"h-full w-full rounded-sm",/);
  assert.doesNotMatch(src, /rounded-sm transition-shadow/);
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

// Un <img> qui vient d'être monté ne peint rien tant que son bitmap n'est pas décodé. Le culling
// remonte les items à chaque dézoom : en asynchrone, toute la planche passe une frame en cases
// blanches, ce qui se voit comme un clignotement général. Une vignette se décode en une
// milliseconde, donc en synchrone sans coût perceptible — une source pleine, elle, bloquerait la
// frame, d'où l'asynchrone conservé pour elle.
test('a thumbnail decodes synchronously so a remount never paints an empty box', () => {
  assert.match(read('src/components/reference/BoardItem.tsx'), /decoding=\{lod\.full \? "async" : "sync"\}/);
});

// Le board est une couche DOM transformée, pas un canvas : l'amplitude de zoom est bornée par le
// compositeur, pas par l'ergonomie. Passé quelques dizaines de fois, la couche `will-change:
// transform` réclame un budget de tuiles que Chromium ne sert plus — il resert alors des tuiles
// PÉRIMÉES, et au retour au dézoom seule la portion déjà rasterisée réapparaît, la fenêtre finissant
// figée. En bas, la limite est le nombre d'items montés d'un coup (cf. ITEM_BUDGET).
test('the zoom range stays inside what the compositor can serve', () => {
  const shared = read('src/components/reference/referenceShared.ts');
  const max = Number(/export const ZOOM_MAX = ([\d.]+)/.exec(shared)[1]);
  const min = Number(/export const ZOOM_MIN = ([\d.]+)/.exec(shared)[1]);
  assert.ok(max <= 64, `ZOOM_MAX ${max} dépasse ce que le compositeur tient`);
  assert.ok(min >= 0.001, `ZOOM_MIN ${min} monterait la planche entière d'un coup`);
  // Large malgré tout : de la vue d'ensemble au détail d'un plan, sans jamais buter en plein geste.
  assert.ok(max / min >= 1000, `amplitude ${Math.round(max / min)}:1 trop étroite pour l'usage`);
});

// Reculer une vidéo en écrivant `currentTime` force un décodage depuis la keyframe précédente. À la
// cadence de l'écran et par item, un board qui porte des dizaines d'aller-retours noie le décodeur.
test('ping-pong playback steps backwards on a budget, not on every frame', () => {
  const src = read('src/components/reference/BoardItem.tsx');
  assert.match(src, /const BACKSTEP_MS = (\d+)/);
  assert.match(src, /if \(back >= BACKSTEP_MS\)/);
});
