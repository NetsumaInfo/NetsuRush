// Guards on the fixture itself.
//
// The fixture is the measuring instrument for H02 and H03. If it drifts —
// picks up a wall-clock read, loses a data attribute, gains a network fetch —
// then every determinism and alpha result measured with it becomes unreadable,
// and the failure would look like an engine problem rather than a fixture
// problem. These tests exist so that drift fails here first.
//
// They parse the fixture as data. They do not run a browser; the engine tests
// do that once a browser is provisioned.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, '..', 'fixture');
const brokenDir = join(here, '..', 'fixture-broken');

const html = readFileSync(join(fixtureDir, 'index.html'), 'utf8');
const css = readFileSync(join(fixtureDir, 'styles.css'), 'utf8');
const frameCode = readFileSync(join(fixtureDir, 'frame-code.js'), 'utf8');

/// Minimal attribute reader. A real HTML parser would be a dependency the
/// prototype does not need, and the fixture is authored here, so its shape is
/// known.
function attr(source, name) {
  const match = source.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

test('the composition declares finite metadata', () => {
  assert.equal(attr(html, 'data-composition-id'), 'netsuflow-fixture');

  for (const [name, expected] of [
    ['data-width', 1920],
    ['data-height', 1080],
    ['data-composition-duration', 10],
    ['data-netsuflow-fps', 30],
  ]) {
    const raw = attr(html, name);
    assert.notEqual(raw, null, `${name} is missing`);
    const value = Number(raw);
    assert.ok(Number.isFinite(value) && value > 0, `${name} must be finite and positive, got ${raw}`);
    assert.equal(value, expected);
  }
});

test('fps is namespaced, because HyperFrames does not define an fps attribute', () => {
  // The engine takes fps from the caller's capture options. Naming ours
  // data-fps would invent an upstream contract that does not exist.
  assert.ok(html.includes('data-netsuflow-fps'));
  assert.ok(!/\sdata-fps=/.test(html), 'data-fps would look like an upstream attribute');
});

test('clips use the canonical authored timing attributes and tile the timeline', () => {
  const clips = [...html.matchAll(/<div\b[^>]*class="[^"]*\bclip\b[^"]*"[^>]*>/g)].map((m) => m[0]);
  assert.equal(clips.length, 3);

  const timings = clips.map((clip) => {
    for (const name of ['data-start', 'data-duration', 'data-track-index']) {
      assert.notEqual(attr(clip, name), null, `a clip is missing ${name}`);
    }
    // data-end and data-layer are legacy input the writers never emit.
    assert.equal(attr(clip, 'data-end'), null, 'data-end is legacy and must not be authored');
    assert.equal(attr(clip, 'data-layer'), null, 'data-layer is legacy and must not be authored');
    return { start: Number(attr(clip, 'data-start')), duration: Number(attr(clip, 'data-duration')) };
  });

  timings.sort((a, b) => a.start - b.start);
  assert.equal(timings[0].start, 0);
  for (let i = 1; i < timings.length; i += 1) {
    // No gap and no overlap: exactly one clip is visible at any time, so a
    // frame is never ambiguous about which clip should be on screen.
    assert.equal(
      timings[i].start,
      timings[i - 1].start + timings[i - 1].duration,
      'clips must tile the timeline without gaps or overlaps',
    );
  }
  const end = timings.at(-1).start + timings.at(-1).duration;
  assert.equal(end, Number(attr(html, 'data-composition-duration')));
});

test('the page implements the engine seek contract', () => {
  // The engine polls for exactly this before it will capture:
  //   window.__hf && typeof window.__hf.seek === "function" && window.__hf.duration > 0
  assert.match(frameCode, /window\.__hf\s*=\s*\{/);
  assert.match(frameCode, /duration:\s*DURATION/);
  assert.match(frameCode, /\bseek\b/);
  // Awaited by the engine after every seek. Without it, capture can race the
  // paint, which matters here because Windows never gets BeginFrame mode.
  assert.match(frameCode, /window\.__hfWaitForSeekCompletion\s*=/);
});

/// Removes comments so the bans below apply to code and not to prose. Without
/// this, a comment saying "no Date.now() here" trips the very guard it
/// documents — which is exactly what happened the first time this ran.
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('nothing in the fixture can vary between two captures of one frame', () => {
  const code = codeOnly(frameCode);
  const banned = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bnew\s+Date\s*\(/, 'new Date()'],
    [/\bperformance\.now\s*\(/, 'performance.now()'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\bsetTimeout\s*\(/, 'setTimeout()'],
    [/\bsetInterval\s*\(/, 'setInterval()'],
    [/\bfetch\s*\(/, 'fetch()'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
  ];
  for (const [pattern, label] of banned) {
    assert.ok(!pattern.test(code), `${label} would make a frame depend on something other than the seeked time`);
  }

  // requestAnimationFrame is allowed only inside the seek-completion hook,
  // where it settles a paint. A rAF loop would animate on wall-clock time.
  const rafUses = code.match(/requestAnimationFrame/g) ?? [];
  assert.equal(rafUses.length, 2, 'requestAnimationFrame belongs only to the paint-settling hook');
  assert.match(code, /__hfWaitForSeekCompletion[\s\S]{0,200}requestAnimationFrame/);
});

test('every resource is local to the fixture root', () => {
  for (const source of [html, css, frameCode]) {
    assert.ok(!/https?:\/\//.test(source.replace(/xmlns="[^"]*"/g, '')), 'no absolute URL may appear');
    assert.ok(!/\/\/fonts\.googleapis|\/\/cdn\./.test(source));
  }
  for (const ref of ['assets/inter-latin-wght-normal.woff2', 'assets/swatch.png']) {
    assert.ok(existsSync(join(fixtureDir, ref)), `${ref} must be served from the fixture root`);
  }
  // The font licence travels with the font.
  assert.ok(existsSync(join(fixtureDir, 'assets', 'inter-LICENSE.txt')));
});

test('the font cannot silently fall back to a system face', () => {
  // font-display: block holds the paint rather than showing a fallback. A
  // fallback face would change pixels without changing anything we control.
  assert.match(css, /font-display:\s*block/);
});

test('the background stays transparent so alpha loss is visible', () => {
  assert.match(css, /html,\s*\n?body\s*\{[^}]*background:\s*transparent/);
  assert.match(css, /#composition\s*\{[^}]*background:\s*transparent/);
});

test('the local image asset is byte-for-byte the one the references were made with', () => {
  const digest = createHash('sha256')
    .update(readFileSync(join(fixtureDir, 'assets', 'swatch.png')))
    .digest('hex');
  assert.equal(
    digest,
    'c65689e321949ba49f8722d3b5280abb5c920daed69c9774fd168bea721847b1',
    'regenerate with tools/make-swatch-png.mjs and re-record the reference frames deliberately',
  );
});

test('the machine band mirrors the bridge diagnostic-frame convention', async () => {
  // The same reader must work on a captured PNG and on a bridge frame, so the
  // constants have to agree with the existing implementation rather than merely
  // look similar.
  const { makeDiagnosticFrame, frameMarker } = await import(
    '../../fake-renderer/diagnosticFrame.mjs'
  );

  assert.match(frameCode, /COUNTER_CELLS\s*=\s*16/);
  assert.match(frameCode, /Math\.max\(Math\.floor\(HEIGHT \/ 10\), 8\)/);
  assert.match(frameCode, /\? 255 : 16/);

  // The marker the fixture paints is the marker the bridge reader recovers.
  const frame = 1234;
  const reference = makeDiagnosticFrame({ width: 1920, height: 1080, frame });
  assert.equal(frameMarker(reference, { width: 1920, height: 1080 }), frame);
});

test('the fixture does not opt out of the timeline wait by hand', () => {
  // It used to, and that hid the problem instead of solving it. A user's
  // composition will not carry data-no-timeline, so a fixture that does is not
  // measuring what the product actually faces: without the attribute the engine
  // polls for a GSAP timeline this composition never registers, and session
  // init took 45,179 ms against 129 ms.
  //
  // Handling that belongs to the timeline shim, which the project server
  // injects, so the user's file on disk is never modified. The fixture stays
  // realistic and the shim is exercised for real.
  const rootTag = html.match(/<div\b[^>]*data-composition-id="netsuflow-fixture"[^>]*>/)[0];
  assert.ok(
    !rootTag.includes('data-no-timeline'),
    'the shim must be what handles this, not a hand-edited fixture',
  );
});

test('the GSAP-side fixture registers a timeline and is not opted out', () => {
  const gsap = readFileSync(join(here, '..', 'fixture-gsap', 'index.html'), 'utf8');
  assert.match(gsap, /window\.__timelines\['netsuflow-fixture-gsap'\]/);
  assert.match(gsap, /getChildren\(\)/);
  assert.match(gsap, /window\.__hf = \{ duration: DURATION, seek \}/);

  // The attribute on the host, not the string anywhere in the file: a comment
  // explaining why the opt-out is absent must not read as the opt-out itself.
  const rootTag = gsap.match(/<div\b[^>]*data-composition-id="netsuflow-fixture-gsap"[^>]*>/)[0];
  assert.ok(
    !rootTag.includes('data-no-timeline'),
    'this fixture exists to be waited for; opting it out would defeat its purpose',
  );
  // GSAP itself is not vendored: GreenSock's no-charge licence does not cover
  // redistribution, and the engine needs the registration, not the library.
  assert.ok(!gsap.includes('gsap.min.js') && !gsap.includes('greensock'));
});

test('antialiased edges are confined to the probe region', () => {
  // The first capture run found the only unstable pixels in a region that mixed
  // an animating rect with an antialiased polygon. Diagonals and curves now
  // live in one region that is compared with a tolerance; every other region is
  // required to be byte-exact, which only holds if they stay hard-edged.
  const probe = html.match(/<div id="antialias-region"[\s\S]*?<\/div>/);
  assert.ok(probe, 'the antialias probe region must exist');
  assert.match(probe[0], /<polygon/);
  assert.match(probe[0], /<circle/);
  // It must animate, or the layer is cached and the probe stops probing.
  assert.match(probe[0], /id="aa-tick"/);
  assert.match(frameCode, /aaTick\.setAttribute/);

  const hardEdged = html.match(/<div id="svg-region"[\s\S]*?<\/div>/)[0];
  for (const primitive of ['polygon', 'circle', 'ellipse', 'path']) {
    assert.ok(!hardEdged.includes(`<${primitive}`), `<${primitive}> in the hard-edged SVG region would make it unstable`);
  }
  assert.match(hardEdged, /shape-rendering="crispEdges"/);
});

test('the transform region can distinguish a half turn from no turn', () => {
  // A bare square looks identical at 0 and 180 degrees, so rotation went
  // unmeasured until the marker was added.
  assert.match(html, /<div id="spinner"><div id="spinner-marker"><\/div><\/div>/);
  assert.match(css, /#spinner-marker\s*\{[^}]*background:/);
});

test('text is rendered against a known backdrop', () => {
  // Glyph antialiasing blends with what is behind it. Over transparency that
  // blend depends on compositor behaviour, which is a different question from
  // the one the text region is meant to answer.
  assert.match(css, /#text-region\s*\{[^}]*background:\s*#102027/);
});

test('the stored references were captured from this exact fixture', () => {
  const referencePath = join(here, '..', 'reference', 'references.json');
  if (!existsSync(referencePath)) {
    // Capturing references needs a provisioned browser, which not every
    // checkout will have. Absent references are not a failure; stale ones are.
    return;
  }
  const references = JSON.parse(readFileSync(referencePath, 'utf8'));
  const hash = createHash('sha256');
  for (const part of ['index.html', 'styles.css', 'frame-code.js', 'assets/swatch.png']) {
    hash.update(part);
    hash.update(readFileSync(join(fixtureDir, part)));
  }
  assert.equal(
    references.fixtureDigest,
    hash.digest('hex'),
    'the fixture changed after the references were captured; re-run tools/reference-capture.mjs',
  );
});

test('the broken fixture fails the way a real broken project does', () => {
  const broken = readFileSync(join(brokenDir, 'index.html'), 'utf8');
  // It must throw before __hf is usable, so the engine's readiness poll times
  // out instead of the page seeking wrongly.
  assert.match(broken, /missing\.duration/);
  assert.equal(attr(broken, 'data-composition-id'), 'netsuflow-fixture-broken');
  assert.notEqual(
    attr(broken, 'data-composition-id'),
    attr(html, 'data-composition-id'),
    'the broken fixture must not share the good one\'s id, or a cache could confuse them',
  );
});
