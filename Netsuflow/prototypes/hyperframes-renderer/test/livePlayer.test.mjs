// The player injected into the Live iframe.
//
// It is a `<script>` written inside a JS template literal, which is the exact
// shape that has silently broken this project twice: a backtick in a comment
// and a `\n` inside a string each shipped a page whose script never ran, while
// the server returned 200 with a plausible byte count. `editorPage.test.mjs`
// guards the editor's own script; this guards the one served into the iframe.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'editorServer.mjs'), 'utf8');

function playerScript() {
  const match = /const PLAYER_SCRIPT = \/\* html \*\/ `([\s\S]*?)`;/.exec(source);
  assert.ok(match, 'PLAYER_SCRIPT is no longer a plain template literal');
  return match[1].replace(/<\/?script>/g, '');
}

test('the injected player is syntactically valid JavaScript', () => {
  // Not "looks right": compiled. A template literal that ended early produces
  // a page that returns 200 and does nothing at all.
  new Script(playerScript());
});

test('the injected player carries no backslash', () => {
  // A backslash inside the template literal is interpreted by the *literal*
  // before it ever reaches the browser, so `\n` becomes a real newline and
  // `\d` becomes `d`. Character classes and escapes have to be written without
  // one — `[(]` rather than an escaped paren.
  const found = [...playerScript().matchAll(/.{0,24}\\.{0,24}/g)].map((m) => m[0]);
  assert.deepEqual(found, [], 'backslash in the injected player');
});

test('a seek that throws cannot stop playback', () => {
  // The defect this guards: `requestAnimationFrame(frame)` sits after the
  // seek, so one throw skipped the rescheduling and froze the Live tab for
  // good, with nothing said. Engine 0.8.21 began reporting runtime delivery
  // errors instead of swallowing them, which is what made it worth fixing.
  const script = playerScript();
  const seekCall = script.indexOf('window.__hf.seek(at)');
  const tryStart = script.lastIndexOf('try {', seekCall);
  const catchStart = script.indexOf('} catch', seekCall);
  assert.ok(tryStart !== -1 && catchStart !== -1, 'the playback seek is unguarded');

  // And the reschedule must be outside that guard, or a caught error still
  // ends the loop.
  const reschedule = script.indexOf('requestAnimationFrame(frame);', catchStart);
  assert.ok(reschedule > catchStart, 'the loop does not continue after a failed seek');
});

test('the player reports a failed seek once, not once per frame', () => {
  const script = playerScript();
  assert.match(script, /seekFailed/, 'no latch on the failure report');
  // 60 postMessage a second would drown the note the user actually reads.
  const guard = /if \(!seekFailed\) \{/.exec(script);
  assert.ok(guard, 'the error report is not latched');
});
