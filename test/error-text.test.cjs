// errorText is what stands between a caught error and the screen. These pin the cases it exists
// for: a system cause becomes a sentence in the interface language, a programming error never
// shows its JavaScript message, and a message a person wrote reaches the user unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load() {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'src/lib/errorText.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const logged = [];
  const deps = {
    '@/i18n': { default: { t: (key) => `<${key}>` } },
    '@/lib/appLog': { logError: (source, message) => logged.push(message), describeError: (e) => String(e) },
  };
  const result = {};
  new Function('exports', 'require', code)(result, (id) => deps[id] ?? {});
  return { errorText: result.errorText, logged };
}

test('a system cause becomes a translated sentence, and the raw error is kept in the console', () => {
  const { errorText, logged } = load();
  assert.equal(errorText(new Error("ENOENT: no such file or directory, open 'C:\\a.mp4'")), '<common:error.notFound>');
  assert.equal(errorText(new Error('ENOSPC: no space left on device')), '<common:error.diskFull>');
  assert.equal(errorText(new Error('EPERM: operation not permitted')), '<common:error.permission>');
  assert.equal(errorText(new TypeError('Failed to fetch')), '<common:error.coreUnreachable>');
  assert.equal(logged.length, 4);
});

test('a programming error never reaches the screen as JavaScript', () => {
  const { errorText } = load();
  assert.equal(errorText(new TypeError("Cannot read properties of undefined (reading 'path')")), '<common:error.internal>');
  assert.equal(errorText(new ReferenceError('foo is not defined')), '<common:error.internal>');
  assert.equal(errorText(undefined), '<common:error.internal>');
});

test('a message someone wrote is shown as is, without the "Error:" prefix or the stack', () => {
  const { errorText, logged } = load();
  const e = new Error('Le projet « Montage » est déjà ouvert dans Resolve.');
  assert.equal(errorText(e), 'Le projet « Montage » est déjà ouvert dans Resolve.');
  assert.equal(errorText('Error: Disk quota reached\n    at foo (bar.js:1:1)'), 'Disk quota reached');
  assert.equal(logged.length, 1, 'only the case that hid something is logged');
});

test('a Windows error written in the OS language is still recognised by its code', () => {
  const { errorText } = load();
  assert.equal(errorText(new Error('Le fichier spécifié est introuvable. (os error 2)')), '<common:error.notFound>');
  assert.equal(errorText('指定されたパスが見つかりません。 (os error 3)'), '<common:error.notFound>');
  assert.equal(errorText('アクセスが拒否されました。 (os error 5)'), '<common:error.permission>');
  assert.equal(errorText('另一个程序正在使用此文件，进程无法访问。 (os error 32)'), '<common:error.busy>');
  assert.equal(errorText('Espace insuffisant sur le disque. (os error 112)'), '<common:error.diskFull>');
});
