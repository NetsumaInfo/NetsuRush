// Reprise d'un média LOCAL qui ne s'affiche pas.
//
// La panne visée : l'adresse d'affichage d'un item est calculée UNE fois, à l'ouverture du board, et
// gelée pour la session. Si la voie de service n'est pas encore établie à cet instant — port pas
// encore annoncé, protocole asset pas encore sondé — l'adresse part morte et le reste, alors que le
// fichier est intact sur le disque. Résultat vu par l'utilisateur : une icône d'image cassée, muette,
// qui ne se répare qu'en rouvrant le projet.
//
// Ce que ces cas verrouillent tient en une phrase : la reprise doit RECALCULER l'adresse, pas
// seulement redemander l'ancienne — c'est l'ancienne qui était morte, pas le fichier.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/components/reference/BoardItem.tsx'), 'utf8');
// Corps de la reprise seul : les autres composants du fichier appellent aussi `displaySrc`, une
// recherche sur tout le fichier passerait donc au vert sans que la reprise recalcule quoi que ce soit.
// Bornes en ASCII pur : une borne contenant une apostrophe typographique se serait tue en cas de
// non-correspondance (indexOf → -1) et aurait rendu un bloc quasi complet, donc des cas toujours verts.
const START = 'function useLocalMediaRetry';
const END = 'const PRELOAD_BLOCK';
const from = source.indexOf(START);
const to = source.indexOf(END, from);
const retry = from >= 0 && to > from ? source.slice(from, to) : '';

test('la reprise existe et se laisse isoler du reste du fichier', () => {
  assert.ok(from >= 0, `${START} introuvable dans BoardItem.tsx`);
  assert.ok(to > from, `${END} introuvable après la reprise — bornes du bloc à revoir`);
  // Un bloc qui déborderait sur le reste du composant rendrait tous les cas suivants complaisants.
  assert.ok(retry.length < 3000, `bloc de reprise anormalement large (${retry.length} caractères)`);
});

test('la reprise recalcule l’adresse depuis la ref vivante du store', () => {
  // Depuis le STORE, pas depuis l'item capturé au rendu : entre l'échec et la reprise, une
  // relocalisation ou une récupération a pu remplacer la source.
  assert.match(retry, /useBoard\.getState\(\)/);
  assert.match(retry, /displaySrc\(live\.kind, live\.ref\)/);
  assert.match(retry, /patchItem\(live\.id, \{ src: fresh \}/);
});

test('la reprise n’écrit jamais dans l’historique du document', () => {
  // Troisième argument `false` : une réparation d'affichage n'est pas une modification du board.
  // Sans ça, ouvrir un projet le marquerait modifié et l'autosave réécrirait le fichier pour rien.
  // On compte les DEUX écritures (adresse rafraîchie, item déclaré manquant) : une seule qui
  // oublierait le drapeau suffirait à salir le document à la simple ouverture d'un projet.
  assert.equal((retry.match(/patchItem\(/g) || []).length, 2);
  assert.equal((retry.match(/, false\);/g) || []).length, 2);
});

test('un média n’est déclaré manquant qu’au SECOND échec', () => {
  // La première fois on retente ; déclarer manquant tout de suite renverrait l'utilisateur chercher
  // un fichier qui n'a jamais bougé.
  assert.match(retry, /if \(attempt === 0\) \{/);
  assert.match(retry, /if \(absent && !item\.missing\) \{/);
});

test('une source LUE mais sans image n’est jamais déclarée manquante', () => {
  // `absent = false` : le fichier a répondu, c'est son codec que le webview ne décode pas.
  // Il est là — l'annoncer manquant serait un mensonge, et le bouton « Relocaliser » un piège.
  assert.match(source, /retry\.onFailure\(false\)/);
});

test('un lien distant est laissé à la récupération en ligne', () => {
  // Une URL morte ne se répare pas en la redemandant : c'est `recoverMedia` qui la retélécharge.
  assert.match(retry, /if \(!item\.ref \|\| isRemoteRef\(item\.ref\)\) return false;/);
});

test('image, vidéo et séquence passent toutes par la reprise', () => {
  // Trois montages distincts, trois `key` sur le compteur de tentative : sans ça, l'élément n'est
  // pas remonté et le navigateur ne redemande rien.
  assert.equal((source.match(/key=\{retry\.attempt\}/g) || []).length, 3);
  // La séquence ne déclare jamais l'item manquant : une frame illisible sur trois cents ne doit pas
  // condamner les deux cent quatre-vingt-dix-neuf autres.
  assert.match(source, /onError=\{\(\) => \{ if \(!retry\.onFailure\(false\)\) triggerRecover\(item\); \}\}/);
});

test('le minuteur de reprise est annulé au démontage', () => {
  // Un board qu'on dézoome démonte des dizaines d'items : un minuteur laissé derrière écrirait dans
  // le store pour des cases qui n'existent plus.
  assert.match(retry, /useEffect\(\(\) => \(\) => \{ if \(timer\.current\) clearTimeout\(timer\.current\); \}, \[\]\);/);
});
