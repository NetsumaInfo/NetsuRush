// Vertical YouTube (Shorts) on the reference board: the card must be posed 9:16 instead of the
// 16:9 default, and any YouTube card must be reshaped to the ratio the relayed stream reports —
// that is the only signal for a Short shared as a plain `watch?v=` link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const dir = path.join(__dirname, '..', 'src', 'components', 'reference');
const ingest = fs.readFileSync(path.join(dir, 'useBoardIngest.ts'), 'utf8');
const boardItem = fs.readFileSync(path.join(dir, 'BoardItem.tsx'), 'utf8');

// embeds.ts only pulls two regexes out of referenceShared, whose own import graph reaches the Tauri
// bridge — stub that single module rather than dragging the renderer into a Node test.
function loadEmbeds() {
  const file = path.join(dir, 'embeds.ts');
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = module.paths;
  const load = Module._load;
  Module._load = (request, parent, isMain) =>
    request.endsWith('referenceShared')
      ? { IMAGE_RE: /\.(png|jpe?g|gif|webp)$/i, VIDEO_RE: /\.(mp4|mov|webm|mkv)$/i }
      : load(request, parent, isMain);
  try {
    mod._compile(compiled, file);
  } finally {
    Module._load = load;
  }
  return mod.exports;
}

const embeds = loadEmbeds();

test('a /shorts/ link is recognised as vertical, other YouTube forms are not', () => {
  assert.equal(embeds.isYoutubeShorts('https://www.youtube.com/shorts/dQw4w9WgXcQ'), true);
  assert.equal(embeds.isYoutubeShorts('https://youtube.com/shorts/dQw4w9WgXcQ?feature=share'), true);
  assert.equal(embeds.isYoutubeShorts('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false);
  assert.equal(embeds.isYoutubeShorts('https://youtu.be/dQw4w9WgXcQ'), false);
});

test('a Shorts link still yields its 11-character video id', () => {
  assert.equal(embeds.youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(embeds.youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share'), 'dQw4w9WgXcQ');
});

test('the posing size of a Short is portrait, a regular video stays landscape', () => {
  const short = embeds.youtubeNatSize('https://www.youtube.com/shorts/dQw4w9WgXcQ');
  assert.ok(short.h > short.w);
  assert.equal(short.w / short.h, 9 / 16);
  const wide = embeds.youtubeNatSize('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.ok(wide.w > wide.h);
  assert.equal(wide.w / wide.h, 16 / 9);
});

test('ingestion poses a YouTube card at the ratio the link announces', () => {
  // No 16:9 constant left on the YouTube branch: the size comes from the announced native ratio.
  assert.match(ingest, /kind === "youtube" \? fitSize\(nat\.w \|\| 1920, nat\.h \|\| 1080, YT_MAX\)/);
  assert.doesNotMatch(ingest, /place\("youtube",[^)]*\{ w: 480, h: 270 \}/);
  const calls = ingest.match(/place\("youtube",[^)]*\)/g) ?? [];
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.match(call, /youtubeNatSize\(/);
});

test('the relayed stream reshapes the card to its true ratio, once and without an undo step', () => {
  assert.match(boardItem, /onNatSize\?\.\(e\.currentTarget\.videoWidth, e\.currentTarget\.videoHeight\)/);
  // A proxy is a re-encoded excerpt — its dimensions must never be taken for the source's.
  assert.match(boardItem, /if \(!useProxy && e\.currentTarget\.videoWidth && e\.currentTarget\.videoHeight\)/);
  assert.match(boardItem, /onNatSize=\{fitNatSize\}/);
  // Constant area around the item centre, cropped items left alone, measurement not recorded.
  assert.match(boardItem, /Math\.sqrt\(it\.w \* it\.h \* ratio\)/);
  assert.match(boardItem, /!it\.crop && it\.w > 0 && it\.h > 0 && Math\.abs\(it\.w \/ it\.h - ratio\) > 0\.01/);
  assert.match(boardItem, /patchItem\(item\.id, patch, false\)/);
});
