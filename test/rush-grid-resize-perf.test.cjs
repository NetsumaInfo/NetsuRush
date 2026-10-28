const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const CARDS = ['src/components/rushes/SceneCard.tsx', 'src/components/rushes/ShotCard.tsx'];
const GRIDS = [
  'src/components/rushes/CutStudio.tsx',
  'src/components/rushes/TimelineLiveView.tsx',
  'src/components/collections/CollectionDetail.tsx',
];

// Changer la densité (+/-) ne doit toucher QUE le conteneur de grille. Une géométrie passée en prop
// à chaque carte rerendait des centaines de composants et réabonnait leurs observateurs par cran.
test('changing thumbnail density does not rerender every scene card', () => {
  for (const file of CARDS) {
    const src = read(file);
    assert.doesNotMatch(src, /\bcellH\b|\bcols\b/,
      `${file} must not take grid geometry as a prop: it would rerender on every density step`);
  }
  assert.doesNotMatch(read('src/components/rushes/useSceneCardMedia.ts'), /\bcols\b/,
    'viewport observers must stay subscribed while thumbnail density changes');
});

// content-visibility est ce qui garde une grille de plusieurs centaines de plans défilable : sans
// lui, chaque carte hors écran fait toujours sa mise en page et sa peinture.
test('preview cards keep content-visibility with an exact offscreen height', () => {
  for (const file of CARDS) {
    assert.match(read(file), /\bnr-grid-card\b/,
      `${file} must use the shared preview-card class (content-visibility + --nr-cell-h)`);
    assert.doesNotMatch(read(file), /containIntrinsicSize/,
      `${file} must not carry a per-card intrinsic size`);
  }
  const css = read('src/index.css');
  assert.match(css, /\.nr-grid-card\s*\{[^}]*content-visibility:\s*auto/,
    'the shared card class must skip offscreen rendering');
  assert.match(css, /\.nr-grid-card\s*\{[^}]*contain-intrinsic-size:\s*var\(--nr-cell-h/,
    'the offscreen height must come from the grid container variable');
  assert.doesNotMatch(css, /\.nr-grid-card\s*\{[^}]*contain-intrinsic-size:\s*auto\s/,
    'the `auto` keyword remembers the previous density and would desynchronise the scrollbar');
});

// L'habillage de survol (racines Base UI : infobulle, popover, menu contextuel) ne doit pas suivre
// la bande d'anticipation : traîner le curseur de la barre le montait/démontait pour des dizaines de
// cartes à la fois, sur le thread qui fait justement avancer un défilement traîné à la souris.
test('hover chrome mounts for the pointed card, not for the whole prefetch band', () => {
  for (const file of [...CARDS, 'src/components/search/ResultCard.tsx']) {
    const src = read(file);
    assert.match(src, /\binteractive\b/,
      `${file} must gate its hover chrome on pointer/keyboard presence`);
    assert.doesNotMatch(src, /\{near && \(|\(near \|\| selected\)/,
      `${file} must not mount Base UI roots for every card of the thumbnail band`);
  }
  assert.match(read('src/lib/useCardMedia.ts'), /interactive:\s*pointerOn \|\| focusOn/,
    'the hook must expose pointer/keyboard presence separately from the prefetch band');
});

// La hauteur de rangée réelle est publiée une seule fois, par le conteneur : la barre de défilement
// mesure alors exactement ce qui sera rendu, à toutes les densités.
test('every preview grid publishes the real row height', () => {
  assert.match(read('src/components/rushes/cutStudioShared.ts'), /--nr-cell-h/,
    'gridContainerStyle must publish the row height');
  for (const file of GRIDS) {
    assert.match(read(file), /gridContainerStyle\(/,
      `${file} must style its grid through gridContainerStyle`);
  }
});

test('all preview cards share strict visibility and paced starts', () => {
  const activity = read('src/lib/usePreviewActivity.ts');
  assert.match(activity, /observeViewport\(el, 0, setVisible\)/);
  assert.match(activity, /play && visible/);
  assert.match(activity, /visible && \(hovered \|\| started\)/);
  assert.match(read('src/lib/useCardMedia.ts'), /usePreviewActivity\(/);
  assert.doesNotMatch(read('src/lib/useCardMedia.ts'), /acquirePlaySlot|requestPreloadMount|retainPausedVideo/);
  // Shot cards and search results share ONE media hook: two copies had drifted apart.
  assert.match(read('src/components/rushes/useSceneCardMedia.ts'), /useCardMedia\(/);
  assert.match(read('src/components/search/ResultCard.tsx'), /useCardMedia\(/);
  assert.ok(!fs.existsSync(path.join(root, 'src/components/search/useResultPreview.ts')));
  assert.doesNotMatch(read('src/components/rushes/cutStudioShared.ts'), /MAX_PLAYING_HARD|playingActive/);
});

// Une carte dont l'URL de proxy est déjà résolue ne doit RIEN attendre : la lecture du cache est
// synchrone, dans le rendu. Repasser par la promesse coûtait un rendu de plus après le créneau.
test('cards read the resolved proxy URL synchronously while rendering', () => {
  assert.match(read('src/lib/useCardMedia.ts'),
    /const url = fetchedUrl \?\? peekProxy\?\.\(\) \?\? null/);
  for (const file of GRIDS) {
    assert.match(read(file), /peekProxy=\{/, `${file} must hand its cards the resolved-proxy lookup`);
  }
});

// Le pool de <video> en pause démonte l'élément le plus ancien quand il déborde. Si le rendu pouvait
// remonter cet élément au titre de la seule PRÉCHARGE, les deux se relanceraient sans fin : montage,
// éviction, montage. Seule une carte qui doit vraiment jouer reprend sa place.
test('an evicted preview is not remounted by the preload path alone', () => {
  const media = read('src/lib/usePreviewActivity.ts');
  assert.match(media, /retainPausedVideo\(\(\) => \{ setHeld\(false\); setPreloadEvicted\(true\); \}\)/);
  assert.match(media, /const preloadWanted = nearVideo && play && !preloadEvicted/);
  assert.match(media, /if \(preloadEvicted && !nearVideo\) setPreloadEvicted\(false\)/,
    'the veto must be lifted when the card leaves the band, or it never preloads again');
  // La préchauffe est RYTHMÉE (créer un WebMediaPlayer bloque le thread principal), mais une carte
  // qui doit jouer ne fait jamais la queue : elle se figerait alors qu'elle a déjà son créneau.
  assert.match(media, /requestPreloadMount\(index, \(\) => setHeld\(true\)\)/);
  assert.match(media, /if \(!preloadWanted \|\| wantVideo \|\| held\) return;/,
    'a card that must play now must bypass the mount pacer');
});

// L'empreinte des réglages entre dans la clé de cache proxy, donc dans le rendu de CHAQUE carte.
// Recalculée depuis localStorage à chaque appel, elle transformait un défilement en centaines
// d'accès stockage synchrones sur le thread qui fait justement avancer ce défilement.
test('the preview-settings fingerprint is cached, not re-read from storage per call', () => {
  const src = read('src/lib/previewSettings.ts');
  assert.match(src, /fingerprintCache \?\?= buildFingerprint\(readPreviewSettings\(\)\)/);
  assert.match(src, /addEventListener\(PREVIEW_SETTINGS_EVENT, invalidateFingerprint\)/,
    'a cached fingerprint that never invalidates would keep serving stale cache keys');
  assert.match(src, /fingerprintCache = null;\s*\n\s*if \(typeof window !== "undefined"\) window\.dispatchEvent/,
    'the cache must be cleared before the event, or a listener reads the old value');
});

// Un aperçu monté en avance est en pause : l'attribut autoPlay le ferait démarrer pour rien, juste
// avant que l'effet ne le remette en pause — du décodage gaspillé par carte préchauffée.
test('a preloaded preview loads without starting playback', () => {
  const src = read('src/components/player/PreviewVideo.tsx');
  assert.match(src, /autoPlay=\{!paused\}/);
  assert.match(src, /preload="auto"/, 'the element must still load and prime its decoder while paused');
});

test('card media retries a failed thumbnail and bounds video error retries', () => {
  const src = read('src/lib/useCardMedia.ts');
  assert.match(src, /if \(!settled\) nr\.proxyCancel\(token\)/);
  assert.match(src, /\.catch\(retry\)/, 'a rejected thumbnail request must retry, not leave a skeleton forever');
  assert.match(src, /else setThumbFailed\(true\)/);
  assert.match(src, /tries > PROXY_RETRIES\) return/, 'a <video> the decoder refuses must not loop forever');
  assert.match(src, /setTimeout\(\(\) => \{\s*timer\.current = null;[\s\S]*?HOVER_DELAY_MS\)/,
    'hover playback waits a beat, so a wheel scroll under the pointer does not start every card');
});

// Les deux vues résolvent leurs proxies en UN appel. Sans ça, chaque carte réclame le sien au core
// en entrant dans la bande, puis se fait annuler en ressortant.
test('every preview grid resolves its cached proxies in one call', () => {
  for (const file of [...GRIDS, 'src/components/search/SearchResults.tsx']) {
    assert.match(read(file), /proxyResolve\(|warmProxies\(/,
      `${file} must prime its proxy-URL cache in bulk`);
    assert.match(read(file), /peekProxy=\{/, `${file} must hand its cards the resolved-proxy lookup`);
  }
});
