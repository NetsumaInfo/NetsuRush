const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAdaptiveCodec } = require('../core/adaptiveCodec');
const { videoCodecArgs: aeVideoCodecArgs } = require('../core/ae/codecs');

const caps = {
  codecEncoders: {
    h264_main: 'h264_amf', h264_high: 'h264_amf',
    h265_main: 'hevc_qsv', h265_main10: 'hevc_qsv',
  },
  h264Encoder: 'h264_amf', h265Encoder: 'hevc_qsv',
};

test('legacy NVENC choice resolves to the working AMD encoder', () => {
  const r = resolveAdaptiveCodec('h264_nvenc', 'high', 8, caps);
  assert.equal(r.codec, 'h264_amf');
  assert.equal(r.vendor, 'amf');
  assert.equal(r.hardware, true);
});

test('HEVC GPU intent resolves to Intel QSV including main10', () => {
  const r = resolveAdaptiveCodec('hevc_gpu', 'main10', 10, caps);
  assert.equal(r.codec, 'hevc_qsv');
  assert.equal(r.capabilityKey, 'h265_main10');
});

test('unsupported 4:4:4 hardware profile preserves quality on CPU', () => {
  const r = resolveAdaptiveCodec('hevc_nvenc', 'rext444-10', 10, caps);
  assert.equal(r.codec, 'x265');
  assert.equal(r.profile, 'main444-10');
  assert.equal(r.hardware, false);
});

test('missing hardware always falls back to a matching CPU family', () => {
  const r = resolveAdaptiveCodec('h264_gpu', 'main', 8, {});
  assert.equal(r.codec, 'x264');
  assert.equal(r.profile, 'main');
});

test('an exact failed main10 probe is not replaced by a generic HEVC encoder', () => {
  const r = resolveAdaptiveCodec('hevc_gpu', 'main10', 10, {
    codecEncoders: { h265_main10: null }, h265Encoder: 'hevc_nvenc',
  });
  assert.equal(r.codec, 'x265');
  assert.equal(r.profile, 'main10');
});

test('fixed editing codecs are not rewritten', () => {
  const r = resolveAdaptiveCodec('prores_hq', null, 10, caps);
  assert.equal(r.codec, 'prores_hq');
  assert.equal(r.hardware, false);
});

test('After Effects media preparation accepts AMD and Intel hardware encoders', () => {
  assert.deepEqual(aeVideoCodecArgs('h264_amf').slice(0, 2), ['-c:v', 'h264_amf']);
  const hevc = aeVideoCodecArgs('hevc_qsv');
  assert.deepEqual(hevc.slice(0, 2), ['-c:v', 'hevc_qsv']);
  assert.deepEqual(hevc.slice(-2), ['-tag:v', 'hvc1']);
});
