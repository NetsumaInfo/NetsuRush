const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every message the core sends to the screen exists in the six interface languages, with the
// same placeholders, and every key the core asks for exists.
const ROOT = path.join(__dirname, '..');
const I18N = path.join(ROOT, 'core', 'i18n.js');
const LANGS = ['fr', 'en', 'es', 'de', 'ja', 'zh'];

function loadWith(lang) {
  const config = require(path.join(ROOT, 'core', 'config.js'));
  const before = config.CONFIG.lang;
  config.CONFIG.lang = lang;
  delete require.cache[require.resolve(I18N)];
  const mod = require(I18N);
  return { mod, restore: () => { config.CONFIG.lang = before; } };
}

function coreFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') coreFiles(full, out); }
    else if (/\.(c?js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join('|');

test('every core message exists in the six languages with the same placeholders', () => {
  const texts = {};
  for (const lang of LANGS) {
    const { mod, restore } = loadWith(lang);
    try { texts[lang] = mod; } finally { restore(); }
  }
  const source = fs.readFileSync(I18N, 'utf8');
  const keys = new Set([...source.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\[/gm)].map((m) => m[1]));
  for (const key of keys) {
    const values = LANGS.map((lang) => {
      const { mod, restore } = loadWith(lang);
      try { return mod.t(key); } finally { restore(); }
    });
    for (const [i, value] of values.entries()) {
      assert.ok(value && value !== key, `${key} is empty in ${LANGS[i]}`);
      assert.equal(placeholders(value), placeholders(values[0]), `${key}: ${LANGS[i]} placeholders differ from fr`);
    }
  }
});

test('every key the core asks for is defined', () => {
  const { mod, restore } = loadWith('en');
  try {
    const missing = [];
    for (const file of coreFiles(path.join(ROOT, 'core'))) {
      if (file === I18N) continue;
      const code = fs.readFileSync(file, 'utf8');
      if (!/require\(['"][./]*i18n['"]\)/.test(code)) continue;
      for (const m of code.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
        if (mod.t(m[1]) === m[1]) missing.push(`${path.relative(ROOT, file)}: ${m[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  } finally { restore(); }
});
