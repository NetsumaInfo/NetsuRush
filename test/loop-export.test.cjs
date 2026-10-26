// A looping export is one ffmpeg command: what it asks of ffmpeg is checked here without running it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loopArgs, loopFilters, exportLoop, MAX_LOOP_SEC } = require('../core/loopExport.js');

test('filters follow the board: crop, mirror, cadence, then a width that never enlarges', () => {
  const chain = loopFilters({ crop: { x: 0.25, y: 0, w: 0.5, h: 1 }, flipH: true, fps: 24, width: 720 });
  assert.deepEqual(chain, [
    'crop=iw*0.500000:ih*1.000000:iw*0.250000:ih*0.000000',
    'hflip',
    'fps=24.000',
    "scale='min(720,iw)':-2:flags=lanczos",
  ]);
  assert.deepEqual(loopFilters({}), []);
});

test('WebP is animated, lossy at the asked quality, and loops forever', () => {
  const args = loopArgs({ input: 'a.mp4', out: 'b.webp.part', format: 'webp', start: 2, duration: 3, filters: ['hflip'], quality: 90 });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('-c:v'), 'libwebp_anim');
  assert.equal(at('-q:v'), '90');
  assert.equal(at('-loop'), '0');
  assert.equal(at('-f'), 'webp'); // the temporary name carries no usable extension
  assert.equal(at('-vf'), 'hflip');
  assert.ok(args.indexOf('-ss') < args.indexOf('-i')); // seek before the input
  assert.equal(at('-t'), '3');
  assert.ok(args.includes('-an'));
});

test('lossless WebP hands RGB frames over and ignores the quality setting', () => {
  const args = loopArgs({ input: 'a.mp4', out: 'b.webp.part', format: 'webp', quality: 40, lossless: true });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at('-lossless'), '1');
  assert.equal(at('-pix_fmt'), 'bgra');
  assert.equal(at('-q:v'), '75');
  // GIF has no lossless mode: the flag changes nothing there.
  assert.deepEqual(
    loopArgs({ input: 'a.mp4', out: 'b.gif.part', format: 'gif', lossless: true }),
    loopArgs({ input: 'a.mp4', out: 'b.gif.part', format: 'gif' }),
  );
});

test('GIF goes through a palette built from the clip itself', () => {
  const args = loopArgs({ input: 'a.mp4', out: 'b.gif.part', format: 'gif', filters: ['fps=15.000'] });
  const graph = args[args.indexOf('-filter_complex') + 1];
  // Default: a palette per frame, every frame written whole.
  assert.equal(graph, '[0:v:0]fps=15.000,split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=new=1:dither=bayer:bayer_scale=5');
  // Light: one palette, changed areas only. The two never mix — it corrupts the untouched pixels.
  const light = loopArgs({ input: 'a.mp4', out: 'b.gif.part', format: 'gif', gifPalette: 'global' });
  assert.match(light[light.indexOf('-filter_complex') + 1], /palettegen=stats_mode=diff\[p\];\[b\]\[p\]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle$/);
  assert.doesNotMatch(graph, /diff_mode/);
  assert.equal(args[args.indexOf('-f') + 1], 'gif');
  assert.equal(args.includes('-ss'), false); // no `-ss 0`
  const bare = loopArgs({ input: 'a.mp4', out: 'b.gif.part', format: 'gif' });
  assert.match(bare[bare.indexOf('-filter_complex') + 1], /^\[0:v:0\]split\[a\]\[b\];/);
});

test('refusals are decided before ffmpeg is started', async () => {
  assert.equal(MAX_LOOP_SEC, 60);
  assert.equal((await exportLoop(null, {})).ok, false);
  assert.equal((await exportLoop(null, { path: 'https://example.com/a.mp4', out: 'x.webp' })).ok, false);
  const unknown = await exportLoop(null, { path: 'a.mp4', out: 'x.apng', format: 'apng' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /apng/);
});

test('a whole board is stacked in z order, clips looping until the export ends', () => {
  const { boardLoopArgs } = require('../core/loopExport.js');
  const args = boardLoopArgs({
    format: 'webp', out: 'b.webp.part', fps: 15, duration: 4, quality: 80,
    stack: [
      { type: 'image', file: 'l0.png' },
      { type: 'video', file: 'a.mp4', start: 1, len: 2, x: 250, y: 270, w: 400, h: 225 },
      { type: 'video', file: 'b.mp4', start: 0, len: 4, x: 700, y: 270, w: 300, h: 300, rotation: 90, opacity: 0.5, flipH: true },
      { type: 'image', file: 'l3.png' },
    ],
  });
  const graph = args[args.indexOf('-filter_complex') + 1].split(';');
  assert.equal(graph[0], '[0:v]format=rgba[c0]');
  // Shorter than the export: buffered at its placed size, before the RGBA conversion, and replayed.
  assert.equal(graph[1], '[1:v]fps=15.000,scale=400:225:force_original_aspect_ratio=increase:flags=lanczos,crop=400:225,loop=loop=-1:size=30:start=0,setpts=N/(15.000*TB),format=rgba[v1]');
  assert.equal(graph[2], '[c0][v1]overlay=x=250-w/2:y=270-h/2:format=rgb[c1]');
  // As long as the export: no loop. Mirror, opacity, then rotation around the item's centre.
  assert.match(graph[3], /^\[2:v\]fps=15\.000,scale=300:300:force_original_aspect_ratio=increase:flags=lanczos,crop=300:300,format=rgba,hflip,colorchannelmixer=aa=0\.500,rotate=1\.570796:/);
  assert.equal(graph[5], '[3:v]format=rgba[l3]');
  // Layers and looped clips never end: the cut is inside the graph, not an output option.
  assert.equal(graph[graph.length - 1], '[c3]trim=duration=4[cut]');
  assert.equal(args.filter((a) => a === '-t').length, 2); // one per clip input, none on the output
  assert.equal(args[args.indexOf('-map') + 1], '[cut]');

  const gif = boardLoopArgs({ format: 'gif', out: 'b.gif.part', fps: 15, duration: 4, stack: [{ type: 'image', file: 'l0.png' }] });
  assert.match(gif[gif.indexOf('-filter_complex') + 1], /\[c0\]trim=duration=4\[cut\];\[cut\]split\[a\]\[b\];\[a\]palettegen/);
});

test('clips of different lengths are bent to wrap together, within a tolerance', () => {
  const { loopSpeed, boardLoopArgs } = require('../core/loopExport.js');
  assert.equal(loopSpeed(2, 4), 1);      // already a whole number of loops
  assert.equal(loopSpeed(4, 4), 1);
  assert.equal(loopSpeed(3.7, 4), 0.925); // one loop, slowed by 7.5 %
  assert.ok(Math.abs(loopSpeed(1.9, 10) - 0.95) < 1e-9); // five loops
  assert.equal(loopSpeed(2.6, 4), 1);    // would need 30 %: left as it is, and cut at the wrap
  assert.equal(loopSpeed(0, 4), 1);

  // A bent clip is retimed before the cadence is fixed, and its loop holds the retimed frames.
  const args = boardLoopArgs({ format: 'webp', out: 'b.part', fps: 10, duration: 4,
    stack: [{ type: 'image', file: 'l0.png' }, { type: 'video', file: 'a.mp4', start: 0, len: 1.9, speed: 0.95, x: 0, y: 0, w: 10, h: 10 }] });
  const chain = args[args.indexOf('-filter_complex') + 1].split(';')[1];
  assert.match(chain, /^\[1:v\]setpts=PTS\/0\.950000,fps=10\.000,/);
  assert.match(chain, /loop=loop=-1:size=20:start=0/); // 1.9 s / 0.95 = 2 s = 20 frames
});

test('a sequence travels as a frame list, a card keeps its video whole, only the own relay is a URL', () => {
  const { boardLoopArgs, clipSource, concatList } = require('../core/loopExport.js');
  const args = boardLoopArgs({ format: 'webp', out: 'b.part', fps: 12, duration: 2,
    stack: [{ type: 'image', file: 'l0.png' }, { type: 'video', file: 'frames.txt', concat: true, start: 0, len: 2, contain: true, x: 0, y: 0, w: 320, h: 180 }] });
  const at = args.indexOf('frames.txt');
  assert.deepEqual(args.slice(at - 7, at), ['-f', 'concat', '-safe', '0', '-t', '2', '-i']);
  assert.match(args[args.indexOf('-filter_complex') + 1], /scale=320:180:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba/);

  assert.equal(concatList(['C:\\a\\1.jpg', "it's.jpg"], 10),
    "ffconcat version 1.0\nfile 'C:/a/1.jpg'\nduration 0.100000\nfile 'it'\\''s.jpg'\nduration 0.100000\nfile 'it'\\''s.jpg'\n");

  assert.equal(clipSource('C:/rush/a.mp4'), 'C:/rush/a.mp4');
  assert.equal(clipSource('http://127.0.0.1:5123/ytstream?id=abc'), 'http://127.0.0.1:5123/ytstream?id=abc');
  assert.equal(clipSource('https://example.com/a.mp4'), '');
  assert.equal(clipSource('http://127.0.0.1:5123/media?p=C:/secret'), '');
});

test('a GIF is encoded at a cadence it can store, so it plays at the speed asked', () => {
  const { playableFps } = require('../core/loopExport.js');
  // Delays are whole hundredths of a second: 24 fps would be written as 4 cs and play at 25.
  assert.equal(playableFps('gif', 24), 25);
  assert.equal(playableFps('gif', 12), 12.5);
  assert.equal(playableFps('gif', 10), 10);
  assert.equal(playableFps('gif', 60), 50);
  assert.equal(playableFps('webp', 24), 24);
  assert.equal(playableFps('webp', 120), 60);
});
