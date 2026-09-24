// Shortcuts must fire on the key the user sees, whatever the keyboard layout: AZERTY types "à" on
// the 0 key and needs Shift for ".", QWERTY needs Shift for "+", QWERTZ for "=".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load() {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'src/lib/shortcuts.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const result = {};
  new Function('exports', 'require', code)(result, () => ({}));
  return result;
}

const ev = (key, code, mods = {}) => ({ key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

test('digits come from the physical key, so Ctrl+0 works on AZERTY', () => {
  const { comboFromEvent } = load();
  assert.equal(comboFromEvent(ev('à', 'Digit0', { ctrlKey: true })), 'Ctrl+0');
  assert.equal(comboFromEvent(ev('0', 'Digit0', { ctrlKey: true })), 'Ctrl+0');
  assert.equal(comboFromEvent(ev('0', 'Numpad0', { ctrlKey: true })), 'Ctrl+0');
});

test('symbols ignore the Shift needed to type them', () => {
  const { comboFromEvent } = load();
  assert.equal(comboFromEvent(ev('.', 'Comma', { shiftKey: true })), '.'); // AZERTY
  assert.equal(comboFromEvent(ev('.', 'Period')), '.'); // QWERTY
  assert.equal(comboFromEvent(ev('+', 'Equal', { ctrlKey: true, shiftKey: true })), 'Ctrl+='); // QWERTY zoom in
  assert.equal(comboFromEvent(ev('+', 'NumpadAdd', { ctrlKey: true })), 'Ctrl+=');
  assert.equal(comboFromEvent(ev('+', 'BracketRight', { ctrlKey: true })), 'Ctrl+='); // QWERTZ has its own + key
});

test('letters keep Shift and follow the layout', () => {
  const { comboFromEvent } = load();
  assert.equal(comboFromEvent(ev('z', 'KeyW', { ctrlKey: true })), 'Ctrl+Z'); // AZERTY Z
  assert.equal(comboFromEvent(ev('Z', 'KeyZ', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+Z');
});

test('combos saved by older versions are brought to the current form', () => {
  const { mergeKeys } = load();
  const out = mergeKeys({ zoomIn: 'Ctrl+=', nextFrame: '.', undo: 'Ctrl+Z' }, { zoomIn: 'Ctrl++', nextFrame: 'Shift+.', undo: 'Ctrl+Shift+Z' });
  assert.deepEqual(out, { zoomIn: 'Ctrl+=', nextFrame: '.', undo: 'Ctrl+Shift+Z' });
});
