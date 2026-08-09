const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// NR_HOME doit être posé AVANT le require de core/config (il le lit au chargement).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-wallpaper-'));
process.env.NR_HOME = HOME;
const encode = require('../core/wallpaper/encode');
const wallpaper = require('../core/wallpaper');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('le flou garde la pleine résolution et se distingue marche à marche', () => {
  // Réduire l'image avant de flouter donnait un flou « brouillé » une fois réagrandi par le
  // navigateur — le défaut le plus visible du fond. La légèreté vient de la COMPRESSION d'une image
  // sans détail, pas de ses dimensions.
  for (let step = 0; step < encode.BLUR_STEPS.length; step++) {
    assert.equal(encode.blurWidth(encode.blurRadius(step)), encode.BASE_WIDTH, `marche ${step} réduite`);
  }
  // Chaque marche doit flouter strictement plus que la précédente, sinon deux crans font la même chose.
  for (let i = 1; i < encode.BLUR_STEPS.length; i++) {
    const previous = encode.blurSigma(encode.blurRadius(i - 1), encode.BASE_WIDTH);
    const current = encode.blurSigma(encode.blurRadius(i), encode.BASE_WIDTH);
    assert.ok(current > previous, `marche ${i} : flou identique à la précédente`);
  }
  // Sigma = rayon affiché, comme l'écart-type de `blur()` en CSS : « 32 px » doit vouloir dire 32 px.
  assert.equal(encode.blurSigma(32, encode.BASE_WIDTH), 32);
});

test('la source n\'est jamais agrandie par le flou', () => {
  // Un fond de 900 px reste un fond de 900 px : la largeur d'encodage ne dépasse jamais la base.
  const small = 900;
  for (let step = 0; step < encode.BLUR_STEPS.length; step++) {
    const width = encode.blurWidth(encode.blurRadius(step), small);
    assert.ok(width <= small, `marche ${step} : ${width} > ${small}`);
    assert.ok(width > 0);
  }
});

test('une marche hors bornes retombe sur la plus proche au lieu de casser', () => {
  assert.equal(encode.blurRadius(-5), encode.BLUR_STEPS[0]);
  assert.equal(encode.blurRadius(99), encode.BLUR_STEPS[encode.BLUR_STEPS.length - 1]);
  // Rayon nul = aucun flou : la chaîne de filtres ne doit pas poser un gblur inutile.
  assert.equal(encode.blurSigma(0, 1920), 0);
  assert.ok(encode.blurSigma(64, 480) > 0);
});

test('la suppression refuse tout chemin hors de la bibliothèque', async () => {
  assert.equal(wallpaper.isOwned(path.join(HOME, 'wallpapers', 'abc123')), true);
  // Un identifiant qui remonte l'arborescence ne doit jamais faire supprimer autre chose.
  assert.equal(wallpaper.isOwned(path.join(HOME, 'wallpapers')), false);
  assert.equal(wallpaper.isOwned(path.join(HOME, 'weights')), false);

  const victim = path.join(HOME, 'ne-pas-supprimer.txt');
  fs.writeFileSync(victim, 'x');
  const res = await wallpaper.removeWallpaper(path.join('..', '..', 'ne-pas-supprimer.txt'));
  assert.equal(res.ok, true);
  assert.equal(res.removed, false);
  assert.ok(fs.existsSync(victim), 'un fichier hors bibliothèque a été supprimé');
});

test('une entrée inconnue échoue proprement, sans exception', async () => {
  const res = await wallpaper.variant('inexistant', { blur: 2 });
  assert.equal(res.ok, false);
  assert.ok(res.error);
  const list = await wallpaper.listWallpapers();
  assert.equal(list.ok, true);
  assert.deepEqual(list.entries, []);
});

test('l\'échelle de flou des panneaux est le miroir de celle du core', () => {
  // Ces marches ne servent QUE l'image que les panneaux repeignent. Deux échelles qui divergent =
  // une marche demandée que le core n'encode pas.
  const lib = read('src', 'lib', 'wallpaper.ts');
  const declared = /WALLPAPER_SURFACE_BLUR_STEPS = \[([^\]]+)\]/.exec(lib);
  assert.ok(declared, 'WALLPAPER_SURFACE_BLUR_STEPS introuvable');
  const steps = declared[1].split(',').map((n) => Number(n.trim()));
  assert.deepEqual(steps, encode.BLUR_STEPS);
});

test('le flou est continu, rendu par le compositeur', () => {
  const css = read('src', 'index.css');
  const layer = read('src', 'components', 'theme', 'WallpaperLayer.tsx');
  const lib = read('src', 'lib', 'wallpaper.ts');

  // Le rayon est un PIXEL, pas un indice : une échelle de fichiers encodés impose des paliers et une
  // attente d'encodage à chaque cran, ce qui se lit comme un curseur qui ne répond pas.
  assert.match(lib, /export const MAX_BLUR_PX = \d+/);
  assert.match(lib, /style\.setProperty\("--nr-wp-blur", `\$\{value\}px`\)/);
  assert.match(css, /\.nr-wallpaper-media \{[^}]*filter:[^;]*blur\(var\(--nr-wp-blur/s);

  // La couche principale demande la marche 0 : son média est NET, le flou vient du compositeur.
  // Lui servir une variante déjà floutée reviendrait à flouter deux fois.
  assert.match(layer, /useWallpaperMedia\(active \? config\.id : null, 0, animating\)/);
  assert.match(layer, /surfaceBlurStep\(config\.blur\)/);

  // Un flou aspire du transparent au-delà des bords : sans débord, le fond gagne un liseré sombre.
  assert.match(css, /\.nr-wallpaper \{[^}]*inset: calc\(var\(--nr-wp-blur, 0px\) \* -2\)/s);

  // `backdrop-filter` refloute tout ce qui passe derrière, à chaque frame : jamais.
  assert.ok(!/backdrop-filter/.test(css.split('.nr-wallpaper')[1] || ''), 'backdrop-filter sur la couche de fond');
});

test('le fond ne coûte rien en régime établi', () => {
  const css = read('src', 'index.css');
  const layer = read('src', 'components', 'theme', 'WallpaperLayer.tsx');

  // Couche composite dédiée : sans `contain`/`will-change`, le fond se re-rasterise au scroll.
  assert.match(css, /\.nr-wallpaper \{[^}]*contain: strict/s);
  assert.match(css, /\.nr-wallpaper \{[^}]*will-change: transform/s);

  // Figer = DÉMONTER le <video> (un `pause()` laisserait décodeur et texture vivants).
  assert.match(layer, /media\.loop \?[\s\S]*<video/);
  assert.match(layer, /visibilitychange/);
  assert.match(layer, /prefers-reduced-motion/);

  // Le type d'élément se lit sur la RÉPONSE du core, jamais sur l'intention d'animer : vouloir animer
  // un fond FIXE renvoie un poster .webp, qu'un <video> refuse (MEDIA_ERR_SRC_NOT_SUPPORTED).
  assert.match(layer, /loop: Boolean\(res\.animated\)/);
  // Une variante pas encore encodée ne doit pas vider l'affichage : sinon le fond disparaît à chaque
  // cran du curseur de flou et toute l'interface clignote.
  assert.match(layer, /if \(cancelled \|\| !res\?\.ok \|\| !res\.path\) return;/);
});

test('les teintes sont définies là où le thème les définit', () => {
  const css = read('src', 'index.css');
  // `.dark` est posé sur <html> LUI-MÊME : un sélecteur descendant (`html.nr-wallpaper-on .dark`) ne
  // matche jamais, et rien de ce bloc ne s'applique — le fond restait invisible partout.
  assert.match(css, /html\.nr-wallpaper-on\.dark \{/);
  assert.ok(!/html\.nr-wallpaper-on \.dark \{/.test(css), 'sélecteur descendant : ne matchera jamais');
  // Le body doit céder son aplat, sinon il masque toute la couche du fond.
  assert.match(css, /html\.nr-wallpaper-on body \{\s*background: transparent/);
});

test('un panneau qui survole le contenu repeint le fond au lieu d\'être translucide', () => {
  const css = read('src', 'index.css');
  const sidebar = read('src', 'components', 'Sidebar.tsx');
  // Translucide, ce panneau laisserait voir les BOUTONS du module situé dessous, pas le fond.
  assert.match(sidebar, /nr-wp-surface/);
  // Commentaires retirés : ils citent la règle interdite pour l'expliquer, et fausseraient la lecture.
  const surface = css.split('html.nr-wallpaper-on :is(')[1].split('}')[0].replace(/\/\*[\s\S]*?\*\//g, '');
  // Aplat OPAQUE sous tout le reste : c'est LUI qui garantit qu'aucune interface située dessous ne
  // traverse jamais un panneau. Des tokens semi-transparents faisaient l'inverse.
  assert.match(surface, /background-color: var\(--color-bg\)/);
  // Le fond est repeint dans le panneau, cadré sur la FENÊTRE (donc raccord avec la couche
  // principale) et rogné par la boîte du panneau.
  assert.ok(surface.includes('var(--nr-wp-surface-image'), 'image de surface absente');
  assert.match(surface, /background-attachment: scroll, scroll, fixed/);
  // Tout passe par `background-*` : aucun pseudo-élément, aucune `position`, donc aucun risque de
  // conflit avec un composant qui utilise déjà ::before, et aucun changement de mise en page.
  assert.ok(!/(?<!background-)position:/.test(surface), 'la surface ne doit pas toucher au positionnement');
});

test('la barre de titre est une surface comme les autres', () => {
  const css = read('src', 'index.css');
  const app = read('src', 'App.tsx');
  const surface = css.split('html.nr-wallpaper-on :is(')[1].split('{')[0];

  // Exclue, la barre restait un aplat noir au-dessus d'un fond visible partout ailleurs.
  assert.ok(!/\bheader\b/.test(surface), 'la barre de titre est exclue du fond');

  // Le défaut qui avait motivé son exclusion vient d'un ancêtre TRANSFORMÉ : il devient le bloc
  // conteneur d'un `background-attachment: fixed`, et le fond se retrouve cadré sur le groupe de
  // boutons au lieu de la fenêtre. La sous-nav se centre donc en `flex`.
  // Commentaires retirés : ils citent la classe interdite pour l'expliquer.
  const markup = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/-translate-x-1\/2/.test(markup), 'centrage par transform : le fond sera recadré dessous');
  assert.match(markup, /pointer-events-none absolute inset-x-0 flex justify-center/);
});

test("une seule fonction décide si le fond est actif, fenêtre détachée comprise", () => {
  const lib = read('src', 'lib', 'wallpaper.ts');
  const layer = read('src', 'components', 'theme', 'WallpaperLayer.tsx');
  // Board et carnet détachés servent à travailler PAR-DESSUS un autre logiciel : le fond y est un
  // choix, pas un acquis.
  assert.match(read('src', 'lib', 'windowKind.ts'), /export const IS_DETACHED_WINDOW/);
  // Porté seulement par la couche, le cas de la fenêtre détachée laissait la classe posée sur une
  // fenêtre SANS fond : ses panneaux gardaient le voile (`--nr-wp-dim`) au-dessus de rien.
  assert.match(lib, /return !IS_DETACHED_WINDOW \|\| config\.onDetached;/);
  assert.ok(!/IS_DETACHED_WINDOW/.test(layer), 'condition dupliquée dans la couche');
  assert.match(layer, /const active = wallpaperActive\(config, theme\);/);
});

test('l\'opacité ne dose QUE le fond, jamais l\'interface', () => {
  const css = read('src', 'index.css');
  // Rendre les tokens eux-mêmes semi-transparents laisse voir l'interface située DESSOUS (le tiroir
  // montrait la nav des Paramètres à travers lui). Ces surcharges ne doivent pas revenir.
  for (const token of ['--card:', '--sidebar:', '--secondary:']) {
    const block = css.split('html.nr-wallpaper-on.dark {')[1].split('}')[0];
    assert.ok(!block.includes(token), `${token} translucide : l'interface transparaîtrait`);
  }
  // Le réglage n'agit que sur la teinte posée PAR-DESSUS le fond repeint.
  assert.match(css, /--nr-surface-tint: color-mix\(in srgb, var\(--color-surface\) var\(--nr-ui-mix\)/);
});

test('les curseurs suivent le doigt, chiffre compris', () => {
  const controls = read('src', 'components', 'settings', 'appearance', 'WallpaperControls.tsx');
  // Contrôlé par le store, un curseur qui ne commite qu'au relâchement voit sa poignée rester
  // immobile pendant tout le glissement : l'état local est ce qui la rend fluide.
  assert.match(controls, /const \[local, setLocal\] = useState\(value\)/);
  assert.match(controls, /onValueChange=\{\(next\) => preview\(readSlider\(next\)\)\}/);
  assert.match(controls, /onValueCommitted=\{\(next\) => onCommit\(readSlider\(next\)\)\}/);
  // Le CHAMP lit le même local que la poignée : câblé sur la valeur enregistrée, il restait figé
  // pendant tout le geste — la poignée bougeait, le chiffre non.
  assert.match(controls, /<NumberSpin\s+value=\{local\}/);
});

test('un réglage pose TOUTES ses variables, pas seulement la première', () => {
  const lib = read('src', 'lib', 'wallpaper.ts');
  const controls = read('src', 'components', 'settings', 'appearance', 'WallpaperControls.tsx');
  // L'opacité en pilote deux : la couche l'applique en `opacity`, les panneaux repeignent le fond à
  // partir de l'image brute et ont besoin qu'on leur rejoue le voile. N'en poser qu'une donnait un
  // fond qui suivait le curseur et des panneaux qui ne bougeaient qu'au relâchement.
  const preview = lib.split('export function previewWallpaperSetting')[1].split('\n}')[0];
  assert.ok(preview.includes('--nr-wp-opacity'), 'opacité de la couche absente');
  assert.ok(preview.includes('--nr-wp-dim'), 'voile des panneaux absent');
  // Les noms de variables vivent dans le module, jamais dans le composant du curseur : dupliqués
  // là-bas, ils divergent au premier réglage qui en pilote deux.
  assert.ok(!/--nr-(wp|ui)-/.test(controls), 'nom de variable CSS dupliqué dans les contrôles');
  assert.match(controls, /previewWallpaperSetting\(setting, next\)/);
});

test('le cadrage se règle sur l\'image, et une seule fonction le traduit en CSS', () => {
  const dialog = read('src', 'components', 'settings', 'appearance', 'WallpaperFramingDialog.tsx');
  const layer = read('src', 'components', 'theme', 'WallpaperLayer.tsx');
  // Le rectangle est tracé SUR l'image (poignées aux coins), pas deviné avec des curseurs.
  assert.match(dialog, /resizeCrop\(start\.origin, start\.mode, dx, dy, lockedRatio\)/);
  assert.match(dialog, /HANDLES\.map/);
  // `fitStyle` reste la SEULE traduction du modèle vers l'écran.
  assert.match(layer, /fitStyle\(/);
  assert.match(read('src', 'lib', 'wallpaper.ts'), /export function fitStyle/);
  // Brouillon jusqu'à « Appliquer » : recadrer en direct ferait clignoter tout le fond derrière la
  // fenêtre à chaque pixel de glissement.
  assert.match(dialog, /const apply = \(\) => \{/);
  assert.match(dialog, /if \(open\) setDraft\(config\);/);

  // Le rectangle a TOUJOURS le format de la fenêtre : un fond remplit l'écran, donc une région d'un
  // autre format serait re-rognée à l'affichage et le cadrage montrerait autre chose que le résultat.
  assert.match(dialog, /const lockedRatio = \(quarter \? 1 \/ windowRatio : windowRatio\) \/ imageRatio;/);
  assert.ok(!/CROP_RATIOS/.test(dialog), 'les formats libres mentaient sur le résultat');
});

test('la géométrie du rognage tient dans l\'image', () => {
  const crop = read('src', 'lib', 'cropRect.ts');
  // Un rectangle qui sort de l'image donnerait une plage vide, donc un fond noir sans explication.
  assert.match(crop, /export function moveCrop/);
  assert.match(crop, /export function resizeCrop/);
  assert.match(crop, /const MIN_SIZE = /);
  // Module PUR : vérifiable sans DOM ni store.
  assert.ok(!/from "@\/store/.test(crop), 'cropRect doit rester pur');
  assert.ok(!/document\./.test(crop), 'cropRect ne doit pas toucher au DOM');
});

test('les retouches de couleur restent lisibles et réversibles', () => {
  const colors = read('src', 'lib', 'themeColors.ts');
  const card = read('src', 'components', 'settings', 'appearance', 'ThemeColorsCard.tsx');
  // Le texte posé SUR l'accent est calculé : un accent clair avec un blanc figé rend les boutons
  // primaires illisibles.
  assert.match(colors, /export function foregroundFor/);
  assert.match(colors, /--color-primary-fg/);
  // Retirer une retouche rend la main au thème (variable supprimée, pas réécrite).
  assert.match(colors, /style\.removeProperty\(VAR_NAME\[key\]\)/);
  // Le sélecteur de couleur du projet est la source unique : pas de second sélecteur maison.
  assert.match(card, /from "@\/components\/ui\/color-picker"/);
});

test('un contrôle ne repeint jamais le fond dans sa propre boîte', () => {
  const css = read('src', 'index.css');
  // `Button variant="outline"` porte `bg-background` : sans exclusion, un bouton affichait le fond
  // d'écran à l'intérieur de lui-même (vu sur « Annuler »).
  const selector = css.split('html.nr-wallpaper-on :is(')[1].split('{')[0];
  for (const control of ['button', 'input', '[data-slot="button"]', '[data-slot="toggle-group-item"]']) {
    assert.ok(selector.includes(control), `contrôle non exclu : ${control}`);
  }
  // Le CONTENEUR d'un contrôle segmenté est lui aussi un contrôle : il porte la bordure et les
  // séparateurs du groupe, et un fond d'écran repeint dedans le fait lire comme une surface.
  for (const container of ['[data-slot="toggle-group"]', '[data-slot="tabs-list"]']) {
    assert.ok(selector.includes(container), `conteneur non exclu : ${container}`);
  }
  // `:not(:where(…))` garde la spécificité de la liste à zéro.
  assert.match(selector, /:not\(:where\(/);
});

test('les thèmes personnalisés sont une clé de réglages à part entière', () => {
  const lib = read('src', 'lib', 'customThemes.ts');
  const store = read('src', 'store', 'settings.ts');
  const appearance = read('src', 'components', 'settings', 'AppearanceSettings.tsx');

  // Un thème perso s'appuie sur une palette LIVRÉE : pas de bloc CSS généré au runtime, donc les
  // dix variables dérivées gardent le contraste éprouvé de leur socle.
  assert.match(lib, /base: ThemeId;/);
  assert.match(lib, /export const CUSTOM_THEME_PREFIX/);
  // Fond et couleurs sont indexés sur la CLÉ (palette ou thème perso), sinon créer un thème
  // écraserait les réglages de sa palette de socle.
  assert.match(store, /themeKey: \(\) => \{/);
  assert.match(store, /const key = get\(\)\.themeKey\(\);/);
  // Choisir une palette livrée quitte le thème perso, et une seule carte reste cochée.
  assert.match(store, /localStorage\.removeItem\(CUSTOM_THEME_KEY\)/);
  assert.match(appearance, /s\.theme === id && !s\.customThemeId/);

  // Les LECTURES de COULEURS doivent viser la même clé que les écritures : keyées sur `s.theme`,
  // elles affichaient les retouches de la palette de socle pendant qu'on modifiait le thème perso —
  // rien ne bougeait à l'écran (vu en vrai).
  const colors = read('src', 'components', 'settings', 'appearance', 'ThemeColorsCard.tsx');
  assert.match(colors, /appearanceKey\(s\.theme, s\.customThemeId\)/);
});

test("le fond ne dépend pas du thème choisi", () => {
  const lib = read('src', 'lib', 'wallpaper.ts');
  const store = read('src', 'store', 'settings.ts');
  const card = read('src', 'components', 'settings', 'appearance', 'WallpaperCard.tsx');
  const layer = read('src', 'components', 'theme', 'WallpaperLayer.tsx');

  // Indexé par thème, le fond disparaissait dès qu'on essayait une autre palette — le contraire de
  // ce qu'on attend d'un fond d'écran. C'est UN réglage, lu et écrit sans clé.
  assert.match(lib, /export function readWallpaperConfig\(\): WallpaperConfig/);
  assert.ok(!/WallpaperConfigs|wallpaperConfigFor/.test(store), 'table de fonds par thème dans le store');
  assert.match(card, /useApp\(\(s\) => s\.wallpaper\)/);
  assert.match(layer, /useApp\(\(s\) => s\.wallpaper\)/);
  // Changer de palette ne touche donc PAS au fond.
  assert.match(store, /applyAppearance\(theme, theme, get\(\)\.wallpaper/);

  // Un thème PERSONNALISÉ, lui, enregistre une apparence complète : le rappeler restaure son fond.
  assert.match(store, /writeWallpaperConfig\(custom\.wallpaper\)/);
  assert.match(read('src', 'lib', 'customThemes.ts'), /wallpaper: WallpaperConfig;/);
});

test('un thème enregistré se met à jour au lieu de se recréer', () => {
  const store = read('src', 'store', 'settings.ts');
  const card = read('src', 'components', 'settings', 'appearance', 'CustomThemesCard.tsx');
  const lib = read('src', 'lib', 'customThemes.ts');
  // Sans mise à jour, retoucher un thème rappelé perdait les modifications au changement suivant :
  // il fallait le supprimer et le recréer pour changer une seule couleur.
  assert.match(store, /updateCustomTheme: \(id\) => \{/);
  assert.match(store, /currentAppearance: \(\) => \{/);
  // Le bouton n'apparaît QUE s'il y a quelque chose à enregistrer — sinon il n'apprend rien.
  assert.match(lib, /export function appearanceMatches/);
  assert.match(card, /!appearanceMatches\(active as CustomTheme, currentAppearance\(\)\)/);
  assert.match(card, /dirty \? \([\s\S]{0,200}updateCustomTheme\(active\.id\)/);
});

test("l'opacité du fond va jusqu'au thème nu", () => {
  const lib = read('src', 'lib', 'wallpaper.ts');
  // À 0, il ne reste RIEN à montrer : garder la classe posée laissait les panneaux translucides
  // au-dessus de rien, donc l'interface n'était jamais exactement le thème choisi.
  assert.match(lib, /if \(config\.opacity <= 0\) return false;/);
  // Le voile des panneaux est de la couleur du FOND DE L'APP, jamais du noir : la couche principale
  // pose son média PAR-DESSUS ce fond, un voile noir rendait donc les panneaux plus sombres que le
  // thème dès qu'on baissait l'opacité — l'inverse de ce que le curseur promet.
  const preview = lib.split('export function previewWallpaperSetting')[1].split('\n}')[0];
  assert.ok(!/rgb\(0 0 0/.test(preview), 'voile noir : les panneaux virent au noir');
  assert.match(preview, /--nr-wp-dim[\s\S]{0,120}var\(--color-bg\)/);
});

test('choisir une couleur reste fluide', () => {
  const card = read('src', 'components', 'settings', 'appearance', 'ThemeColorsCard.tsx');
  // `ColorPicker` n'a qu'un `onChange`, appelé à chaque frame du glissement : passer par le store à
  // chaque appel réécrivait localStorage et re-rendait les cinq pastilles.
  assert.match(card, /applyThemeColorVar\(color, value\)/);
  assert.match(card, /setTimeout\(\(\) => \{[\s\S]*?setThemeColor\(color, value\)/);
  // `getComputedStyle` force un recalcul de style : une seule lecture par thème, pas une par rendu.
  assert.match(card, /const themeDefaults = useMemo\(/);
});

test('aucun sélecteur de store ne fabrique son repli', () => {
  // `useApp((s) => x ?? {})` rend un objet NEUF à chaque appel : le store se croit modifié à chaque
  // rendu et la page boucle jusqu'au « Maximum update depth exceeded » (vu en vrai sur les couleurs).
  // Le repli doit être une constante, posée HORS du sélecteur.
  const files = [
    ['src', 'components', 'settings', 'appearance', 'ThemeColorsCard.tsx'],
    ['src', 'components', 'settings', 'appearance', 'WallpaperCard.tsx'],
    ['src', 'components', 'theme', 'WallpaperLayer.tsx'],
  ];
  for (const parts of files) {
    const source = read(...parts);
    assert.ok(!/use(App|Board)\(\(s\) =>[^)]*\?\?\s*(\{\}|\[\])/.test(source), `repli instable dans ${parts.at(-1)}`);
  }
  assert.match(read(...files[0]), /const NO_OVERRIDES: ThemeColorOverrides = \{\};/);
});

test('chaque réglage se vise au chiffre près', () => {
  const controls = read('src', 'components', 'settings', 'appearance', 'WallpaperControls.tsx');
  const lib = read('src', 'lib', 'wallpaper.ts');
  const inspector = read('src', 'components', 'reference', 'inspectorControls.tsx');

  // Un curseur seul ne permet pas de viser une valeur : chaque rangée porte un champ saisissable.
  assert.match(controls, /<NumberSpin/);
  // Saisie promue dans la couche UI partagée plutôt que dupliquée : le board la ré-exporte.
  assert.match(inspector, /export \{ NumberSpin \} from "@\/components\/ui\/number-spin"/);
  // Le pas est de 1 sur TOUS les réglages : à 4 ou 5, viser une valeur au clavier ou à la molette
  // devient impossible et le champ ne sert plus à rien.
  assert.ok(!/step=\{[2-9]/.test(controls), 'un réglage avance par paliers trop gros');
  assert.match(controls, /step=\{1\}/);
  // Le champ du flou porte le RAYON en px, comme le curseur : « 24 » veut dire quelque chose,
  // « marche 6 » non.
  assert.match(controls, /setting="blur"[\s\S]{0,120}max=\{MAX_BLUR_PX\}/);
  assert.match(lib, /export const MAX_BLUR_PX/);
});

test('une bulle d\'aide ne déborde pas sur un mot sans espace', () => {
  // Un nom de fichier ou une URL n'offre aucune occasion de césure : `max-w-*` borne la largeur mais
  // le mot sort quand même de la bulle (vu sur un nom de GIF exporté).
  assert.match(read('src', 'components', 'ui', 'tooltip.tsx'), /max-w-52 break-words/);
});

test('le curseur d\'opacité des panneaux ne ment pas sur son sens', () => {
  const lib = read('src', 'lib', 'wallpaper.ts');
  const fr = JSON.parse(read('src', 'locales', 'fr', 'settings.json'));
  // La valeur stockée est une OPACITÉ : un libellé « transparence » se lit à l'envers et pousse à
  // monter le curseur pour effacer les panneaux — ce qui les rend pleins (défaut vu à l'usage).
  assert.match(fr.appearance.wallpaper.uiOpacity, /[Oo]pacité/);
  // Les valeurs enregistrées sous l'ancien libellé sont reprises une fois, pas à chaque démarrage.
  assert.match(lib, /const LEGACY_MAP_KEYS = \["nr-wallpaper\.v3", "nr-wallpaper\.v2", "nr-wallpaper\.v1"\]/);
  assert.match(lib, /writeWallpaperConfig\(config\); \/\/ reprise faite/);
});

test('un flou enregistré comme INDICE de marche redevient un rayon', () => {
  // La v2 stockait `blur` en indice (0..12). Relu tel quel, un « 12 » devient un flou de 12 px là
  // où l'utilisateur avait demandé 64 : son fond redevient net du jour au lendemain.
  const lib = read('src', 'lib', 'wallpaper.ts');
  const table = /const V2_BLUR_STEPS = \[([^\]]+)\]/.exec(lib);
  assert.ok(table, 'table de reprise v2 absente');
  const steps = table[1].split(',').map((n) => Number(n.trim()));
  assert.equal(steps[12], 64);
  assert.match(lib, /V2_BLUR_STEPS\[Math\.round\(stepIndex\)\]/);
});

test('un fond animé se cadre EN MOUVEMENT', () => {
  const dialog = read('src', 'components', 'settings', 'appearance', 'WallpaperFramingDialog.tsx');
  const card = read('src', 'components', 'settings', 'appearance', 'WallpaperCard.tsx');
  // Sur une première frame arrêtée, rien ne dit si le sujet reste dans le cadre une seconde plus
  // tard : la fenêtre reçoit la variante de BASE (boucle mp4 si animé), pas l'affiche.
  assert.match(dialog, /if \(media\.animated\) \{[\s\S]{0,200}<video/);
  assert.match(card, /path: selected\.base/);
  assert.match(card, /animated: selected\.kind === "animated"/);
});

test('retoucher une couleur ne déplace rien', () => {
  const card = read('src', 'components', 'settings', 'appearance', 'ThemeColorsCard.tsx');
  // La rangée « tout rendre au thème » apparaissait au premier choix de couleur : la carte
  // s'allongeait et tout ce qui suit sautait, au moment précis où l'on glisse dans le sélecteur.
  assert.ok(!/\{touched \? \(/.test(card), 'rangée montée conditionnellement : la page saute');
  assert.match(card, /disabled=\{!touched\}/);
  // La ligne d'état de chaque pastille garde une hauteur réservée, pour la même raison.
  assert.match(card, /block h-4 truncate/);
});

test('le fond rend la main aux traitements lourds', () => {
  const bus = read('src', 'lib', 'busyBus.ts');
  const jobs = read('src', 'lib', 'heavyJobs.ts');
  const client = read('src', 'lib', 'coreClient.ts');
  const layer = read('src', 'components', 'theme', 'WallpaperLayer.tsx');

  // Le gel arrive AVANT le travail : au départ de l'appel, pas au retour de la première progression
  // (le démarrage d'un job — chargement de modèle, spawn ffmpeg — est justement le moment chargé).
  assert.match(client, /isHeavyChannel\(channel\) \? beginHeavyCall\(\) : null/);
  assert.match(client, /finally \{\s*\n\s*releaseBusy\?\.\(\);/);

  // Le signal se répare seul : un job annulé n'émet plus rien, donc l'occupation DOIT expirer,
  // sinon le fond resterait figé pour toujours après une annulation.
  assert.match(bus, /setTimeout\(\(\) => \{/);
  assert.match(bus, /if \(inFlight > 0\) return scheduleIdleCheck\(\);/);

  // `wallpaper:variant` doit rester HORS de la liste : la couche le demande PARCE QUE l'occupation a
  // changé — l'inclure ferait osciller le fond entre figé et animé indéfiniment.
  assert.ok(!/"wallpaper:variant"/.test(bus.split('HEAVY_CHANNELS')[1].split('])')[0]), 'wallpaper:variant est bouclant');

  // Les canaux qui font vraiment chauffer la machine sont couverts, au départ comme en cours de route.
  for (const channel of ['upscale:run', 'process:interpolate', 'roto:propagate', 'export:clips', 'ffmpeg:detectScenes']) {
    assert.ok(bus.includes(`"${channel}"`), channel);
  }
  for (const channel of ['onUpscaleProgress', 'onProcessProgress', 'onRotoProgress', 'onExportProgress', 'onScenesProgress']) {
    assert.match(jobs, new RegExp(`nr\\.${channel}\\(hit\\)`), channel);
  }
  // Et l'animation en dépend réellement.
  assert.match(layer, /focused && !busy/);
});

test('le canal wallpaper est aligné aux 3 endroits', () => {
  // Un canal ajouté à un seul endroit est une dette immédiate (cf. AGENTS.md).
  assert.match(read('core', 'rpc.js'), /"wallpaper:import": \(\[srcPath, opts\]\)/);
  const bridge = read('src', 'lib', 'bridge.ts');
  assert.match(bridge, /export interface WallpaperApi/);
  assert.match(bridge, /wallpaper\?: WallpaperApi;/);
  assert.match(bridge, /wallpaper: \{\s*\n\s*import: async \(\) => \(\{ ok: false/);
  assert.match(read('src', 'lib', 'coreClient.ts'), /import: \(srcPath, opts\) => call\("wallpaper:import"/);
});
