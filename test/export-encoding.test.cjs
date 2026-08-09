const test = require('node:test');
const assert = require('node:assert/strict');

const { videoEncodeArgs, audioEncodeArgs, hwCandidates, listCodecs } = require('../core/export/encodeArgs');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

test('maps export speed profiles to NVENC presets', () => {
  assert.equal(valueAfter(videoEncodeArgs('h264_high', 'h264_nvenc', 'fast'), '-preset'), 'p2');
  assert.equal(valueAfter(videoEncodeArgs('h265_main10', 'hevc_nvenc', 'max'), '-preset'), 'p7');
});

test('maps export speed profiles to CPU codec-specific controls', () => {
  assert.equal(valueAfter(videoEncodeArgs('h264_high', null, 'fast'), '-preset'), 'veryfast');
  assert.equal(valueAfter(videoEncodeArgs('h265_main10', null, 'max'), '-preset'), 'veryslow');
  assert.equal(valueAfter(videoEncodeArgs('av1_main', null, 'quality'), '-preset'), '4');
  assert.equal(valueAfter(videoEncodeArgs('vp9', null, 'balanced'), '-cpu-used'), '3');
});

test('keeps fixed editing codecs free of irrelevant speed flags', () => {
  const args = videoEncodeArgs('prores_422_hq', null, 'fast');
  assert.equal(args.includes('-preset'), false);
  assert.equal(args.includes('-cpu-used'), false);
});

test('probes every detailed NVENC profile instead of excluding chroma formats', () => {
  assert.equal(hwCandidates('h264_high444').includes('h264_nvenc'), true);
  assert.equal(hwCandidates('h265_main444_10').includes('hevc_nvenc'), true);
  assert.equal(valueAfter(videoEncodeArgs('h265_main12', 'hevc_nvenc'), '-profile:v'), 'rext');
  assert.equal(valueAfter(videoEncodeArgs('h265_main12', 'hevc_nvenc'), '-pix_fmt'), 'p016le');
});

test('includes the missing baseline and HEVC 4:4:4 8-bit profiles', () => {
  assert.equal(listCodecs().includes('h264_baseline'), true);
  assert.equal(listCodecs().includes('h265_main444'), true);
});

test('offers each kept audio codec at several bitrates', () => {
  assert.deepEqual(audioEncodeArgs('aac_256'), ['-c:a', 'aac', '-b:a', '256k', '-ar', '48000']);
  assert.equal(valueAfter(audioEncodeArgs('opus_128'), '-b:a'), '128k');
  assert.equal(valueAfter(audioEncodeArgs('opus_192'), '-b:a'), '192k');
  assert.equal(valueAfter(audioEncodeArgs('mp3_192'), '-b:a'), '192k');
  assert.equal(valueAfter(audioEncodeArgs('pcm24'), '-c:a'), 'pcm_s24le');
});

test('falls back to AAC on an audio mode the core does not know', () => {
  // Profil enregistré par une version qui proposait AC-3/Vorbis/MP2 : il doit rester exportable.
  assert.deepEqual(audioEncodeArgs('vorbis'), audioEncodeArgs('aac'));
});
