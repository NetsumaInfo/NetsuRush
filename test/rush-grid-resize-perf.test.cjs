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
  for (const file of CARDS) {
    const src = read(file);
    assert.match(src, /\binteractive\b/,
      `${file} must gate its hover chrome on pointer/keyboard presence`);
    assert.doesNotMatch(src, /\{near && \(|\(near \|\| selected\)/,
      `${file} must not mount Base UI roots for every card of the thumbnail band`);
  }
  assert.match(read('src/components/rushes/useSceneCardMedia.ts'), /interactive:\s*pointerOn \|\| focusOn/,
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

// Les budgets d'aperçu se lisent dans DEUX fichiers. Chromium cesse de créer un lecteur média
// au-delà d'environ 75 par frame, et le fait SANS erreur : les dernières cartes d'un écran dense
// restent alors figées sur leur vignette pour toujours. La somme des deux plafonds doit donc rester
// sous cette borne — c'est le genre de règle qui se casse en retouchant un seul des deux nombres.
test('play and preload video budgets stay under the browser media-player limit', () => {
  const playing = Number(/const MAX_PLAYING_HARD = (\d+)/.exec(read('src/components/rushes/cutStudioShared.ts'))[1]);
  const paused = Number(/const MAX_PAUSED = (\d+)/.exec(read('src/lib/previewVideoPool.ts'))[1]);
  assert.ok(playing >= 40, `autoplay ceiling too low (${playing}): a dense grid strands its bottom rows`);
  assert.ok(playing + paused <= 72, `budget ${playing}+${paused} leaves no headroom under Chromium's ~75 players`);
});

// La bande de PRÉCHARGE doit couvrir celle de la LECTURE : une carte à qui l'on accorde son créneau
// alors que sa <video> n'est pas encore montée repart pour un chargement plus une init de décodeur,
// c'est-à-dire exactement la vignette figée qu'on cherche à supprimer.
test('the preload band covers the play band', () => {
  const media = read('src/components/rushes/useSceneCardMedia.ts');
  assert.match(media, /const VIDEO_MIN_MARGIN_PX = PLAY_LEAD_PX \+ (\d+)/,
    'the preload band must be derived from PLAY_LEAD_PX, never restated as its own number');
  assert.match(read('src/components/rushes/cutStudioShared.ts'), /Math\.ceil\(PLAY_LEAD_PX \/ rowH\)/,
    'the autoplay ceiling must count the lead rows from the same constant the observer uses');
});

// Le créneau de lecture se rythme sur la FRAME : un minuteur travaille ENTRE les frames, donc en
// concurrence avec le défilement, et son premier tick est un retard pur sur la carte qu'on regarde.
test('play slots are granted on animation frames, not on a timer', () => {
  const shared = read('src/components/rushes/cutStudioShared.ts');
  assert.match(shared, /requestAnimationFrame/);
  assert.doesNotMatch(shared, /setInterval\(/);
});

// Une carte dont l'URL de proxy est déjà résolue ne doit RIEN attendre : la lecture du cache est
// synchrone, dans le rendu. Repasser par la promesse coûtait un rendu de plus après le créneau.
test('cards read the resolved proxy URL synchronously while rendering', () => {
  assert.match(read('src/components/rushes/useSceneCardMedia.ts'),
    /const url = fetchedUrl \?\? peekProxy\?\.\(\) \?\? null/);
  for (const file of GRIDS) {
    assert.match(read(file), /peekProxy=\{/, `${file} must hand its cards the resolved-proxy lookup`);
  }
});

// Le pool de <video> en pause démonte l'élément le plus ancien quand il déborde. Si le rendu pouvait
// remonter cet élément au titre de la seule PRÉCHARGE, les deux se relanceraient sans fin : montage,
// éviction, montage. Seule une carte qui doit vraiment jouer reprend sa place.
test('an evicted preview is not remounted by the preload path alone', () => {
  const media = read('src/components/rushes/useSceneCardMedia.ts');
  assert.match(media, /retainPausedVideo\(\(\) => \{ setHeld\(false\); setPreloadEvicted\(true\); \}\)/);
  assert.match(media, /const preloadWanted = nearVideo && \(play \|\| hovered\) && !preloadEvicted/);
  assert.match(media, /if \(!nearVideo\) setPreloadEvicted\(false\)/,
    'the veto must be lifted when the card leaves the band, or it never preloads again');
  // La préchauffe est RYTHMÉE (créer un WebMediaPlayer bloque le thread principal), mais une carte
  // qui doit jouer ne fait jamais la queue : elle se figerait alors qu'elle a déjà son créneau.
  assert.match(media, /requestPreloadMount\(index, \(\) => setPreloadReady\(true\)\)/);
  assert.match(media, /if \(!preloadWanted \|\| wantVideo\) \{ setPreloadReady\(false\); return; \}/,
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

// La boucle de créneaux ne doit pas se réarmer quand elle n'a rien pu accorder : le plafond atteint,
// elle trierait la file à chaque frame, sans fin, pendant que la grille est ouverte.
test('the play-slot pump stops instead of spinning once the ceiling is reached', () => {
  const shared = read('src/components/rushes/cutStudioShared.ts');
  assert.match(shared, /if \(granted && slotQueue\.length\) pumpSlots\(\)/);
  assert.match(shared, /if \(!slotQueue\.length \|\| playingActive >= maxPlaying\) return/);
});

// Un aperçu monté en avance est en pause : l'attribut autoPlay le ferait démarrer pour rien, juste
// avant que l'effet ne le remette en pause — du décodage gaspillé par carte préchauffée.
test('a preloaded preview loads without starting playback', () => {
  const src = read('src/components/player/PreviewVideo.tsx');
  assert.match(src, /autoPlay=\{!paused\}/);
  assert.match(src, /preload="auto"/, 'the element must still load and prime its decoder while paused');
});

// La grille de RECHERCHE a son propre hook d'aperçu. Il doit suivre exactement la même mécanique que
// celui des plans, sinon les deux dérivent et le module Recherche retombe, seul, sur les vignettes
// figées au défilement. Ces règles sont celles qui coûtaient cher à trouver.
test('the search preview hook follows the same playback mechanics as the shot grid', () => {
  const src = read('src/components/search/useResultPreview.ts');
  assert.match(src, /import \{ acquirePlaySlot, PLAY_LEAD_PX \}/,
    'the play lead must come from the shared constant, not be restated here');
  assert.match(src, /const VIDEO_MARGIN_PX = PLAY_LEAD_PX \+ (\d+)/,
    'the preload band must be derived from the play band so it always covers it');
  assert.match(src, /const url = fetchedUrl \?\? peekProxy\?\.\(\) \?\? null/,
    'a resolved proxy URL must be read synchronously while rendering');
  assert.match(src, /const preload = nearVideo && \(play \|\| hovered\) && !preloadEvicted/,
    'the <video> must mount on the preload band, with the anti-loop veto');
  assert.match(src, /if \(!\(play && visible\)\) \{ setStaggerReady\(false\); return; \}/,
    'hover must not make the card drop and re-queue its play slot');
  assert.match(src, /if \(!settled\) nr\.proxyCancel\(token\)/,
    'a request that already resolved has nothing left to cancel');
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
