const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { parseHostFloat, parseHostInt } = require(path.join(ROOT, 'core', 'hostNumber.js'));

test('host decimals read the same with a dot or a comma', () => {
  for (const raw of ['23.976', '29.97', '24', '59.94 fps', ' 25 ', '-1.5']) {
    assert.equal(parseHostFloat(raw), parseFloat(raw), raw);
  }
  assert.equal(parseHostFloat('23,976'), 23.976);
  assert.equal(parseHostFloat('29,97 fps'), 29.97);
  assert.ok(Number.isNaN(parseHostFloat('')));
  assert.ok(Number.isNaN(parseHostFloat(undefined)));
  assert.equal(parseHostFloat(23.976), 23.976);
});

test('host frame counts accept thousands separators', () => {
  for (const raw of ['12345', '240', '0', '7']) assert.equal(parseHostInt(raw), parseInt(raw, 10), raw);
  assert.equal(parseHostInt('12,345'), 12345);
  assert.equal(parseHostInt('12 345'), 12345);
  assert.equal(parseHostInt('12 345'), 12345);
  assert.equal(parseHostInt('1.234.567'), 1234567);
  assert.ok(Number.isNaN(parseHostInt('')));
});

test('an unknown or unsupported interface language reads English, never French', () => {
  const config = require(path.join(ROOT, 'core', 'config.js'));
  const I18N = path.join(ROOT, 'core', 'i18n.js');
  const before = config.CONFIG.lang;
  try {
    const { language, supportedLanguage } = require(I18N);
    config.CONFIG.lang = 'it';
    assert.equal(language(), 'en');
    config.CONFIG.lang = 'ja-JP';
    assert.equal(language(), 'ja');
    config.CONFIG.lang = 'zh_CN';
    assert.equal(language(), 'zh');
    assert.equal(supportedLanguage('pt-BR'), null);
    config.CONFIG.lang = undefined;
    assert.ok(['fr', 'en', 'es', 'de', 'ja', 'zh'].includes(language()));
  } finally {
    config.CONFIG.lang = before;
  }
});
