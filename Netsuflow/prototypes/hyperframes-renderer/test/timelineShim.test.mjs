// Guards on the timeline shim's generated source.
//
// The shim runs inside the browser, so these tests check what it says rather
// than what it does; timelineShim.integration.test.mjs runs it for real.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_GRACE_MS, TIMELINE_MODES, buildTimelineShim } from '../timelineShim.mjs';

test('gsap mode injects nothing', () => {
  // A composition that registers timelines needs the engine's real wait. The
  // shim exists to end a wait that will never finish, not to shorten one that
  // will.
  assert.equal(buildTimelineShim({ mode: 'gsap' }), null);
});

test('auto and none produce a script', () => {
  for (const mode of ['auto', 'none']) {
    const shim = buildTimelineShim({ mode });
    assert.match(shim, /^<script>/);
    assert.match(shim, /<\/script>$/);
    assert.match(shim, /data-no-timeline/);
    assert.match(shim, /data-composition-id/);
  }
});

test('none waits for nothing, auto allows a grace period', () => {
  assert.match(buildTimelineShim({ mode: 'none' }), /GRACE_MS\s*=\s*0/);
  assert.match(buildTimelineShim({ mode: 'auto', graceMs: 1500 }), /GRACE_MS\s*=\s*1500/);
});

test('the default grace covers a realistically slow setup', () => {
  // Measured: a fixture registering its timeline at 2500 ms is captured before
  // its animation exists under a 500 ms grace, and correctly under the default.
  assert.equal(DEFAULT_GRACE_MS, 3000);
  assert.match(buildTimelineShim({ mode: 'auto' }), /GRACE_MS\s*=\s*3000/);
});

test('the grace period is bounded', () => {
  // An unbounded grace would reintroduce the stall it exists to prevent, and a
  // negative one would race the composition's own setup.
  assert.throws(() => buildTimelineShim({ mode: 'auto', graceMs: -1 }), /grace/i);
  assert.throws(() => buildTimelineShim({ mode: 'auto', graceMs: 60_000 }), /grace/i);
  assert.throws(() => buildTimelineShim({ mode: 'auto', graceMs: Number.NaN }), /grace/i);
});

test('an unknown mode is refused rather than defaulted', () => {
  // Silently falling back to auto would let a typo in a binding turn a GSAP
  // project into one whose timelines are never waited for.
  assert.throws(() => buildTimelineShim({ mode: 'gsapp' }), /mode/i);
  assert.throws(() => buildTimelineShim({}), /mode/i);
  assert.deepEqual([...TIMELINE_MODES].sort(), ['auto', 'gsap', 'none']);
});

test('the shim reports what it did', () => {
  // Marking a host is a decision about someone else's project. It has to be
  // visible in diagnostics, not silent.
  const shim = buildTimelineShim({ mode: 'auto' });
  assert.match(shim, /__netsuflowTimelineShim/);
  assert.match(shim, /marked/);
});

test('the shim never rewrites a host that already opted out', () => {
  assert.match(buildTimelineShim({ mode: 'auto' }), /hasAttribute\(['"]data-no-timeline['"]\)/);
});

test('the generated script cannot break out of its tag', () => {
  const shim = buildTimelineShim({ mode: 'auto', graceMs: 1234 });
  const inner = shim.slice('<script>'.length, -'</script>'.length);
  assert.ok(!inner.includes('</script'), 'a nested closing tag would end the script early');
});
