// NetsuBoost côté Adobe : les fonctions PURES qui portent la sécurité (ce qu'on accepte de
// supprimer) et la validité (ce qu'on accepte d'écrire dans l'hôte). Tout le reste du module
// traverse le panneau CEP ou le disque et n'est pas vérifiable sans Adobe installé.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const cache = require('../core/adobeCache.js');
const prefs = require('../core/adobePrefs.js');

const DAY = 86_400_000;

// --- Sécurité de la purge : ce qui tombe DANS une racine connue, et rien d'autre ----------------

test('insideAdobeRoots accepte la racine elle-même et ses enfants', () => {
  const roots = [{ dir: 'C:\\Users\\x\\AppData\\Roaming\\Adobe\\Common\\Media Cache Files' }];
  assert.strictEqual(cache.insideAdobeRoots(roots[0].dir, roots), true);
  assert.strictEqual(cache.insideAdobeRoots(path.join(roots[0].dir, 'sub', 'a.cfa'), roots), true);
});

test('insideAdobeRoots refuse un dossier qui PARTAGE le préfixe', () => {
  // Le piège que le séparateur final corrige : « …Media Cache Files-perso » n'est pas un cache Adobe.
  const roots = [{ dir: 'C:\\Adobe\\Common\\Media Cache Files' }];
  assert.strictEqual(cache.insideAdobeRoots('C:\\Adobe\\Common\\Media Cache Files-perso', roots), false);
});

test('insideAdobeRoots neutralise les remontées de chemin', () => {
  const roots = [{ dir: 'C:\\Adobe\\Common\\Media Cache Files' }];
  assert.strictEqual(cache.insideAdobeRoots('C:\\Adobe\\Common\\Media Cache Files\\..\\..\\..\\Windows', roots), false);
});

test('insideAdobeRoots refuse tout quand la liste de racines est vide', () => {
  assert.strictEqual(cache.insideAdobeRoots('C:\\Adobe\\Common\\Media Cache Files', []), false);
  assert.strictEqual(cache.insideAdobeRoots('', []), false);
});

// --- Filtre d'ancienneté -------------------------------------------------------------------------

test('olderThan borne strictement au seuil', () => {
  const now = 1_000 * DAY;
  const entries = [
    { path: 'vieux', size: 10, mtime: now - 8 * DAY },
    { path: 'pile', size: 20, mtime: now - 7 * DAY },
    { path: 'recent', size: 30, mtime: now - 6 * DAY },
  ];
  const kept = cache.olderThan(entries, 7, now).map((e) => e.path);
  // Exactement 7 jours n'est PAS « plus vieux que 7 jours ».
  assert.deepStrictEqual(kept, ['vieux']);
});

test('olderThan rend les entrées entières, pas seulement leur date', () => {
  // Verrouille le correctif de l'annotation générique : `emptyRoot` a besoin de `path` pour supprimer
  // et de `size` pour compter les octets libérés. Un filtre qui ne rendrait que `mtime` casserait
  // silencieusement la purge.
  const now = 100 * DAY;
  const [entry] = cache.olderThan([{ path: 'a', size: 42, mtime: now - 30 * DAY }], 7, now);
  assert.strictEqual(entry.path, 'a');
  assert.strictEqual(entry.size, 42);
});

// --- Découverte des racines -----------------------------------------------------------------------

test('commonRoots rend les trois caches partagés sous APPDATA', () => {
  const roots = cache.commonRoots({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' });
  assert.deepStrictEqual(roots.map((r) => r.id), ['mediaCacheFiles', 'mediaCacheDb', 'peakFiles']);
  // Partagés par Premiere, After Effects, Media Encoder et Audition : les purger profite aux quatre.
  assert.ok(roots.every((r) => r.shared === true));
  assert.ok(roots.every((r) => r.regenerable === true));
});

test('commonRoots ne devine rien sans APPDATA', () => {
  assert.deepStrictEqual(cache.commonRoots({}), []);
});

test('previewRoots exige le chemin du projet', () => {
  // Les fichiers de prévisualisation vivent À CÔTÉ du projet : sans son chemin, ils sont introuvables
  // et il ne faut surtout pas proposer un dossier deviné à la suppression.
  assert.deepStrictEqual(cache.previewRoots('ppro', null), []);
});

test('previewRoots distingue les prévisualisations Premiere des sauvegardes AE', () => {
  const ppro = cache.previewRoots('ppro', 'D:\\projets\\film\\film.prproj');
  assert.deepStrictEqual(ppro.map((r) => r.id), ['videoPreviews', 'audioPreviews']);
  assert.ok(ppro.every((r) => r.regenerable === true));

  const aeft = cache.previewRoots('aeft', 'D:\\projets\\film\\film.aep');
  assert.deepStrictEqual(aeft.map((r) => r.id), ['aeProjectAutoSave']);
  // Une sauvegarde automatique est une version du travail, pas un cache : jamais purgée d'office.
  assert.strictEqual(aeft[0].regenerable, false);
});

// --- Validation des réglages ----------------------------------------------------------------------

test('validate refuse une clé hors catalogue', () => {
  const { error, entries } = prefs.validate('aeft', { inventedKey: 1 });
  assert.strictEqual(error, 'unknownPref:inventedKey');
  assert.strictEqual(entries, undefined);
});

test('validate refuse un pourcentage hors bornes', () => {
  assert.strictEqual(prefs.validate('aeft', { maxMemPct: 5 }).error, 'outOfRange:maxMemPct');
  assert.strictEqual(prefs.validate('aeft', { maxMemPct: 140 }).error, 'outOfRange:maxMemPct');
  assert.strictEqual(prefs.validate('aeft', { maxMemPct: 'beaucoup' }).error, 'outOfRange:maxMemPct');
});

test('validate refuse une valeur absente de la liste', () => {
  assert.strictEqual(prefs.validate('aeft', { gpuAccelType: 'VULKAN' }).error, 'invalidValue:gpuAccelType');
});

test('validate refuse un lot vide', () => {
  assert.strictEqual(prefs.validate('aeft', {}).error, 'noChanges');
});

test('validate refuse le lot ENTIER dès qu\'une entrée est mauvaise', () => {
  // Un lot à moitié appliqué laisserait l'utilisateur devant un état qu'il n'a pas demandé.
  const { error, entries } = prefs.validate('aeft', { maxMemPct: 80, gpuAccelType: 'VULKAN' });
  assert.strictEqual(error, 'invalidValue:gpuAccelType');
  assert.strictEqual(entries, undefined);
});

test('validate accepte un lot valide et type les valeurs', () => {
  const { entries, error } = prefs.validate('aeft', { maxMemPct: '80', gpuAccelType: 'CUDA', mfrEnabled: true });
  assert.strictEqual(error, undefined);
  const byId = new Map(entries.map((e) => [e.def.id, e.value]));
  assert.strictEqual(byId.get('maxMemPct'), 80);
  assert.strictEqual(byId.get('gpuAccelType'), 'CUDA');
  assert.strictEqual(byId.get('mfrEnabled'), true);
});

test('validate refuse un chemin vide sur un disque de travail', () => {
  assert.strictEqual(prefs.validate('ppro', { scratchVideoPreviews: '' }).error, 'invalidValue:scratchVideoPreviews');
});

test('validate cloisonne les catalogues par application', () => {
  // gpuAccelType est un réglage After Effects : le proposer à Premiere est une erreur d'appel.
  assert.strictEqual(prefs.validate('ppro', { gpuAccelType: 'CUDA' }).error, 'unknownPref:gpuAccelType');
  assert.strictEqual(prefs.validate('inconnu', { maxMemPct: 50 }).error, 'unknownApp');
});

// --- Mise en forme de la lecture ------------------------------------------------------------------

test('mergeRead omet les réglages absents de la réponse de l\'hôte', () => {
  // Clé inconnue de cette version d'AE : la ligne disparaît plutôt que d'inventer un état.
  const rows = prefs.mergeRead('aeft', { ok: true, bitsPerChannel: 8 });
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('bitsPerChannel'));
  assert.ok(!ids.includes('gpuAccelType'));
});

test('mergeRead garde les réglages en écriture seule, valeur nulle', () => {
  // After Effects n'expose aucun accesseur en lecture pour ses limites mémoire : la ligne doit
  // exister (pour être réglable) tout en disant qu'on ne connaît pas sa valeur.
  const row = prefs.mergeRead('aeft', { ok: true }).find((r) => r.id === 'maxMemPct');
  assert.ok(row);
  assert.strictEqual(row.value, null);
  assert.strictEqual(row.writeOnly, true);
});

test('mergeRead marque le rendu logiciel SEULEMENT si un GPU est disponible', () => {
  const withGpu = prefs.mergeRead('aeft', { ok: true, gpuAccelType: 'SOFTWARE', gpuAvailable: ['SOFTWARE', 'CUDA'] });
  assert.strictEqual(withGpu.find((r) => r.id === 'gpuAccelType').warn, true);

  // Machine sans accélération possible : SOFTWARE est le seul choix, ce n'est pas une erreur.
  const without = prefs.mergeRead('aeft', { ok: true, gpuAccelType: 'SOFTWARE', gpuAvailable: ['SOFTWARE'] });
  assert.strictEqual(without.find((r) => r.id === 'gpuAccelType').warn, false);
});

test('mergeRead préfère les options RÉELLES de la machine à la liste par défaut', () => {
  const row = prefs
    .mergeRead('aeft', { ok: true, gpuAccelType: 'CUDA', gpuAvailable: ['SOFTWARE', 'CUDA'] })
    .find((r) => r.id === 'gpuAccelType');
  assert.deepStrictEqual(row.options, ['SOFTWARE', 'CUDA']);
});

test('mergeRead normalise les booléens venus du jsx', () => {
  const row = prefs.mergeRead('ppro', { ok: true, enableProxies: 1 }).find((r) => r.id === 'enableProxies');
  assert.strictEqual(row.value, true);
});

test('mergeRead lit les chemins pointés des disques de travail', () => {
  const rows = prefs.mergeRead('ppro', { ok: true, scratch: { videoPreviews: 'D:\\cache\\video' } });
  const row = rows.find((r) => r.id === 'scratchVideoPreviews');
  assert.strictEqual(row.value, 'D:\\cache\\video');
  assert.strictEqual(row.kind, 'path');
});

test('toPayload reporte le type de disque de travail attendu par l\'hôte', () => {
  const { entries } = prefs.validate('ppro', { scratchAutoSave: 'D:\\saves' });
  const [payload] = prefs.toPayload(entries);
  assert.strictEqual(payload.id, 'scratchAutoSave');
  assert.strictEqual(payload.kind, 'path');
  assert.strictEqual(payload.scratchType, 'FirstAutoSaveFolder');
  assert.strictEqual(payload.value, 'D:\\saves');
});

test('toPayload laisse scratchType nul hors des chemins', () => {
  const { entries } = prefs.validate('aeft', { maxMemPct: 70 });
  assert.strictEqual(prefs.toPayload(entries)[0].scratchType, null);
});
