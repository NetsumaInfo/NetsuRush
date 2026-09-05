// The page is a template literal that ships a whole script inside another
// script. That makes escaping a real hazard rather than a theoretical one, and
// it has bitten twice: a backtick in a CSS comment terminated the literal, and
// a `\n` inside a string became a real newline in the served page. Both shipped
// a page whose script never ran at all, and neither was visible from the
// server, which happily returned 200 and the right byte count.
//
// Compiling the served script is the check that catches the whole class.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { PAGE } from '../editorPage.mjs';

function servedScript() {
  const open = PAGE.indexOf('<script>');
  const close = PAGE.lastIndexOf('</script>');
  assert.ok(open >= 0 && close > open, 'the page must carry a script');
  return PAGE.slice(open + '<script>'.length, close);
}

test('the script the page serves actually compiles', () => {
  // Compiles without running: this is about syntax, and running it would need
  // a DOM.
  assert.doesNotThrow(() => new vm.Script(servedScript(), { filename: 'editorPage' }));
});

test('every element the script reaches for exists in the markup', () => {
  // A renamed id is a TypeError at load, which looks exactly like the escaping
  // bugs above from the outside: a blank panel and a 200.
  const script = servedScript();
  const markup = PAGE.slice(0, PAGE.indexOf('<script>'));
  const ids = new Set([...script.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  const missing = [...ids].filter((id) => !markup.includes('id="' + id + '"'));
  assert.deepEqual(missing, [], 'ids used by the script but absent from the markup');
});
