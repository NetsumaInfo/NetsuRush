const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadMicOptions() {
  const filename = path.join(__dirname, '..', 'src', 'components', 'settings', 'micOptions.ts');
  if (!fs.existsSync(filename)) return {};
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', output)(module.exports, module, require);
  return module.exports;
}

const { buildMicOptions, selectedMicLabel } = loadMicOptions();

test('the microphone trigger uses the device name instead of its technical id', () => {
  assert.equal(typeof buildMicOptions, 'function');
  assert.equal(typeof selectedMicLabel, 'function');

  const options = buildMicOptions([
    { deviceId: 'opaque-123', label: 'Microphone studio' },
  ], 'Micro par défaut', (n) => `Micro ${n}`);

  assert.equal(selectedMicLabel(options, 'opaque-123', 'Micro par défaut'), 'Microphone studio');
});

test('an unavailable saved microphone displays the actual default fallback', () => {
  assert.equal(typeof buildMicOptions, 'function');
  assert.equal(typeof selectedMicLabel, 'function');

  const options = buildMicOptions([], 'Micro par défaut', (n) => `Micro ${n}`);
  const label = selectedMicLabel(options, 'stale-opaque-id', 'Micro par défaut');

  assert.equal(label, 'Micro par défaut');
  assert.doesNotMatch(label, /device:|stale-opaque-id/);
});
