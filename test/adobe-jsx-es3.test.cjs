// Les scripts hôtes tournent dans ExtendScript, qui est de l'ES3 — pas du JavaScript moderne.
//
// Pourquoi ce test existe : un `in:` non quoté dans un littéral d'objet rend le fichier ENTIER
// illisible pour ExtendScript. Il ne se plaint nulle part que l'utilisateur puisse voir : Adobe
// garde en mémoire la dernière version qui s'était chargée, si bien qu'un fichier corrigé sur le
// disque n'a plus aucun effet dans Premiere. Le symptôme est un `NR_ppro_* is not a function` ou,
// pire, des lectures silencieusement vides — et rien ne pointe vers la syntaxe. Ça a coûté
// plusieurs sessions de diagnostic. Node, lui, accepte tout : seul un test peut l'attraper ici.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const JSX_DIR = path.join(__dirname, '..', 'adobe-cep', 'jsx');

/** Mots réservés ES3 (ECMA-262 3e édition §7.5), mots-clés ET réservés pour usage futur. */
const RESERVED = [
  'break', 'case', 'catch', 'continue', 'default', 'delete', 'do', 'else', 'finally', 'for',
  'function', 'if', 'in', 'instanceof', 'new', 'return', 'switch', 'this', 'throw', 'try',
  'typeof', 'var', 'void', 'while', 'with',
  'abstract', 'boolean', 'byte', 'char', 'class', 'const', 'debugger', 'double', 'enum', 'export',
  'extends', 'final', 'float', 'goto', 'implements', 'import', 'int', 'interface', 'long',
  'native', 'package', 'private', 'protected', 'public', 'short', 'static', 'super',
  'synchronized', 'throws', 'transient', 'volatile',
];

/** Constructions postérieures à ES3 : le moteur d'ExtendScript ne les connaît pas. */
const MODERN = [
  { pattern: /=>/, label: 'fonction fléchée' },
  { pattern: /`/, label: 'gabarit de chaîne' },
  { pattern: /\?\./, label: 'chaînage optionnel' },
  { pattern: /\?\?/, label: 'coalescence nulle' },
  { pattern: /\.\.\./, label: 'décomposition' },
  { pattern: /\b(const|let)\s+[A-Za-z_$]/, label: 'const/let' },
  { pattern: /\bJSON\.(parse|stringify)\b/, label: 'JSON natif (utiliser NRJSON)' },
  // `indexOf` est volontairement absent : il est ES1 sur une chaîne et ES5 sur un tableau, et rien
  // ici ne distingue les deux. L'interdire noierait le test sous des faux positifs légitimes.
  { pattern: /\.(forEach|trim|map|filter|reduce|some|every)\s*\(/, label: 'méthode ES5' },
];

function jsxFiles() {
  return fs.readdirSync(JSX_DIR).filter((name) => name.endsWith('.jsx'));
}

/**
 * Lignes de CODE seulement. Une regex de mot réservé matcherait « pour définir : in » dans un
 * commentaire français, ce qui rendrait le test inutilisable — les commentaires du projet en sont
 * pleins. Les chaînes sont neutralisées pour la même raison.
 */
function codeLines(source) {
  const out = [];
  let inBlockComment = false;
  source.split(/\r?\n/).forEach((raw, index) => {
    let line = raw;
    if (inBlockComment) {
      const close = line.indexOf('*/');
      if (close < 0) return;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    for (;;) {
      const open = line.indexOf('/*');
      if (open < 0) break;
      const close = line.indexOf('*/', open + 2);
      if (close < 0) { line = line.slice(0, open); inBlockComment = true; break; }
      line = line.slice(0, open) + ' ' + line.slice(close + 2);
    }
    const comment = line.indexOf('//');
    if (comment >= 0) line = line.slice(0, comment);
    // Les littéraux de chaîne portent des noms de propriété légitimes ("in" quoté, notamment).
    line = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    if (line.trim()) out.push({ number: index + 1, text: line });
  });
  return out;
}

test('aucun mot réservé ES3 ne sert de nom de propriété dans les scripts hôtes', () => {
  const offenders = [];
  for (const file of jsxFiles()) {
    const lines = codeLines(fs.readFileSync(path.join(JSX_DIR, file), 'utf8'));
    for (const word of RESERVED) {
      // Clé d'objet non quotée (`{ in: … }`) et accès pointé (`obj.in`) : les deux sont refusés
      // par la 3e édition, et le second l'est par certains moteurs seulement — on interdit les deux.
      // `^\\s*` et non `^` : une clé d'objet vit presque toujours en début de ligne INDENTÉE —
      // c'était le cas du `in:` réel, que la première version de ce test laissait passer.
      const asKey = new RegExp('(^\\s*|[{,(]\\s*)' + word + '\\s*:');
      const asMember = new RegExp('\\.' + word + '\\b');
      for (const line of lines) {
        if (asKey.test(line.text)) offenders.push(`${file}:${line.number} clé « ${word} » non quotée`);
        else if (asMember.test(line.text)) offenders.push(`${file}:${line.number} accès « .${word} »`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Mots réservés ES3 (quoter la clé, accéder par ["${'nom'}"]) :\n${offenders.join('\n')}`);
});

test('aucune construction postérieure à ES3 dans les scripts hôtes', () => {
  const offenders = [];
  for (const file of jsxFiles()) {
    const lines = codeLines(fs.readFileSync(path.join(JSX_DIR, file), 'utf8'));
    for (const line of lines) {
      for (const { pattern, label } of MODERN) {
        if (pattern.test(line.text)) offenders.push(`${file}:${line.number} ${label}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Constructions hors ES3 :\n${offenders.join('\n')}`);
});

test('le détecteur voit réellement les cas qu\'il prétend attraper', () => {
  // Sans cette vérification, une regex cassée rendrait le test vert pour toujours.
  const bad = codeLines('var t = { in: 1 };\nvar u = obj.in;\nvar v = () => 1;');
  assert.equal(bad.length, 3);
  assert.ok(/(^|[{,(]\s*)in\s*:/.test(bad[0].text));
  assert.ok(/\.in\b/.test(bad[1].text));
  assert.ok(/=>/.test(bad[2].text));
  // …et qu'il ne se déclenche ni sur un commentaire ni sur une chaîne.
  const good = codeLines('// la clé in: est interdite\nvar t = { "in": 1 };\nvar s = "a => b";');
  assert.equal(good.some((line) => /(^|[{,(]\s*)in\s*:/.test(line.text)), false);
  assert.equal(good.some((line) => /=>/.test(line.text)), false);
});
