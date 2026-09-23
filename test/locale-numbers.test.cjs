// Numbers a user reads or types must follow the interface language, not the OS nor French: these run
// the real renderer helpers under several interface languages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(rel, deps) {
  // Vite's `import.meta.glob` has no meaning outside the bundler: no catalogue is needed here.
  const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/import\.meta\.glob[^(]*\(/g, '(() => ({}))(');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const result = {};
  new Function('exports', 'require', code)(result, (id) => (id in deps ? deps[id] : require(id)));
  return result;
}

const i18n = { language: 'fr' };
const utils = load('src/lib/utils.ts', { '@/i18n': { default: i18n } });

test('typed numbers parse with either decimal mark, in any interface language', () => {
  for (const lang of ['fr', 'en', 'de', 'ja']) {
    i18n.language = lang;
    assert.equal(utils.parseDecimal('1,5'), 1.5, lang);
    assert.equal(utils.parseDecimal('1.5'), 1.5, lang);
    assert.equal(utils.parseDecimal(' 0,05 '), 0.05, lang);
    assert.equal(utils.parseDecimal('１．５'), 1.5, lang);
    assert.equal(utils.parseDecimal('−2'), -2, lang);
    assert.equal(utils.parseDecimal('1.234,5'), 1234.5, lang);
    assert.equal(utils.parseDecimal('1,234.5'), 1234.5, lang);
    assert.ok(Number.isNaN(utils.parseDecimal('abc')), lang);
    assert.ok(Number.isNaN(utils.parseDecimal('')), lang);
  }
  i18n.language = 'en';
  assert.equal(utils.parseDecimal('1,500'), 1500);
  i18n.language = 'de';
  assert.equal(utils.parseDecimal('1.500'), 1500);
  i18n.language = 'fr';
  assert.equal(utils.parseDecimal('1,500'), 1.5);
});

test('displayed numbers and units follow the interface language', () => {
  i18n.language = 'fr';
  assert.match(utils.fmtSeconds(1.5), /^1,5\s?s$/);
  assert.equal(utils.fmtInputNumber(0.25), '0,25');
  i18n.language = 'en';
  assert.equal(utils.fmtFixed(0.5, 2), '0.50');
  assert.equal(utils.fmtPercent(0.42), '42%');
  assert.equal(utils.fmtFps(23.976), '23.976 fps');
  assert.equal(utils.fmtInputNumber(1234.5), '1234.5');
});

test('startup language: best supported entry of the preference list, else English', () => {
  const store = { getItem: () => null };
  global.localStorage = store;
  const mod = load('src/i18n/index.ts', {
    i18next: { default: { use() { return this; }, init() {}, addResourceBundle() {}, changeLanguage: async () => {} } },
    'react-i18next': { initReactI18next: {} },
  });
  delete global.localStorage;
  assert.equal(mod.pickSupportedLang(['it-IT', 'de-CH', 'en-US']), 'de');
  assert.equal(mod.pickSupportedLang(['it-IT']), 'en');
  assert.equal(mod.pickSupportedLang(['zh-TW']), 'zh');
  assert.equal(mod.pickSupportedLang([]), 'en');
});
