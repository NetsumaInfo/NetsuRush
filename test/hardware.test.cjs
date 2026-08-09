const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyGpu, normalizeGpuInventory, supportsRocmWindows, supportsIntelXpuWindows, buildHardwareProfile,
} = require('../core/hardware');
const { selectProxyEncoder, proxyVideoArgs, proxyContainerArgs, isHardwareBusy } = require('../core/proxyEncoder');
const { mlEngineName, videoEngineName } = require('../core/setup');
const { resolveAdaptiveCodec } = require('../core/adaptiveCodec');

test('classifies Windows GPUs from PCI vendor IDs before display names', () => {
  assert.equal(classifyGpu('Generic adapter', 'PCI\\VEN_10DE&DEV_24A0'), 'nvidia');
  assert.equal(classifyGpu('Generic adapter', 'PCI\\VEN_1002&DEV_1681'), 'amd');
  assert.equal(classifyGpu('Generic adapter', 'PCI\\VEN_8086&DEV_46A8'), 'intel');
});

test('normalizes a single CIM object and picks CUDA for a hybrid NVIDIA machine', () => {
  const gpus = normalizeGpuInventory({ Name: 'GeForce RTX', PNPDeviceID: 'PCI\\VEN_10DE', DriverVersion: '1.2.3' });
  const profile = buildHardwareProfile(gpus, { windowsBuild: 26200 });
  assert.equal(profile.primaryVendor, 'nvidia');
  assert.equal(profile.initialMlBackend, 'cuda');
  assert.deepEqual(profile.vendors, ['nvidia']);
});

test('keeps CPU as the safe first-install ML backend without NVIDIA', () => {
  const gpus = normalizeGpuInventory([
    { Name: 'AMD Radeon Graphics', PNPDeviceID: 'PCI\\VEN_1002' },
    { Name: 'Intel UHD Graphics', PNPDeviceID: 'PCI\\VEN_8086' },
  ]);
  const profile = buildHardwareProfile(gpus, { windowsBuild: 26200 });
  assert.equal(profile.primaryVendor, 'amd');
  assert.equal(profile.initialMlBackend, 'cpu');
  assert.equal(profile.initialOnnxBackend, 'directml');
});

test('enables ROCm and XPU only for officially targeted Windows hardware', () => {
  assert.equal(supportsRocmWindows('AMD Radeon RX 7900 XTX'), true);
  assert.equal(supportsRocmWindows('AMD Radeon(TM) Graphics'), false);
  assert.equal(supportsIntelXpuWindows('Intel(R) Arc(TM) Graphics'), true);
  const rocm = buildHardwareProfile(normalizeGpuInventory({ Name: 'AMD Radeon RX 7900 XTX' }), { windowsBuild: 26200 });
  assert.equal(rocm.initialMlBackend, 'rocm');
  assert.equal(supportsRocmWindows('AMD Radeon RX 7700 XT'), false);
  const ryzen = buildHardwareProfile(normalizeGpuInventory({ Name: 'AMD Radeon(TM) Graphics' }), {
    windowsBuild: 26200,
    cpuNames: ['AMD Ryzen AI 9 HX 370 w/ Radeon 890M Graphics'],
  });
  assert.equal(ryzen.initialMlBackend, 'rocm');
  const xpu = buildHardwareProfile(normalizeGpuInventory({ Name: 'Intel(R) Arc(TM) Graphics' }), { windowsBuild: 26200 });
  assert.equal(xpu.initialMlBackend, 'xpu');
  const oldWindows = buildHardwareProfile(normalizeGpuInventory({ Name: 'AMD Radeon RX 7900 XTX' }), { windowsBuild: 19045 });
  assert.equal(oldWindows.initialMlBackend, 'cpu');
});

test('selects one exact first-install runtime for each detected configuration', () => {
  const nvidia = buildHardwareProfile(normalizeGpuInventory({ Name: 'NVIDIA GeForce RTX 4070', PNPDeviceID: 'PCI\\VEN_10DE' }), { windowsBuild: 26200 });
  const amd = buildHardwareProfile(normalizeGpuInventory({ Name: 'AMD Radeon RX 7900 XTX', PNPDeviceID: 'PCI\\VEN_1002' }), { windowsBuild: 26200 });
  const intel = buildHardwareProfile(normalizeGpuInventory({ Name: 'Intel Arc A770', PNPDeviceID: 'PCI\\VEN_8086' }), { windowsBuild: 26200 });
  const cpu = buildHardwareProfile([], { windowsBuild: 26200, cpuNames: ['Generic CPU'] });

  assert.deepEqual([nvidia.initialMlBackend, nvidia.initialOnnxBackend], ['cuda', 'cuda']);
  assert.deepEqual([amd.initialMlBackend, amd.initialOnnxBackend], ['rocm', 'directml']);
  assert.deepEqual([intel.initialMlBackend, intel.initialOnnxBackend], ['xpu', 'directml']);
  assert.deepEqual([cpu.initialMlBackend, cpu.initialOnnxBackend], ['cpu', 'cpu']);
});

test('names only the engine selected for the detected vendor', () => {
  assert.equal(mlEngineName('cuda'), 'NVIDIA CUDA');
  assert.equal(mlEngineName('rocm'), 'AMD ROCm');
  assert.equal(mlEngineName('xpu'), 'Intel XPU');
  assert.equal(videoEngineName('nvidia'), 'NVIDIA NVENC');
  assert.equal(videoEngineName('amd'), 'AMD AMF');
  assert.equal(videoEngineName('intel'), 'Intel Quick Sync');
});

test('selects AMD AMF for HEVC and emits low-latency AMF arguments', () => {
  const resolved = selectProxyEncoder('hevc', { h265Encoder: 'hevc_amf', h264Encoder: 'h264_amf' });
  assert.equal(resolved.vendor, 'amf');
  assert.equal(resolved.encoder, 'hevc_amf');
  assert.ok(proxyVideoArgs(resolved).includes('ultralowlatency'));
  assert.deepEqual(proxyContainerArgs(resolved), ['-tag:v', 'hvc1']);
});

test('falls back from unavailable HEVC to Intel H.264 then universal libx264', () => {
  assert.equal(selectProxyEncoder('hevc', { h265Encoder: null, h264Encoder: 'h264_qsv' }).encoder, 'h264_qsv');
  const cpu = selectProxyEncoder('h264', { h264Encoder: null, h265Encoder: null });
  assert.equal(cpu.encoder, 'libx264');
  assert.ok(proxyVideoArgs(cpu).includes('ultrafast'));
});

test('recognizes transient hardware session pressure without masking permanent errors', () => {
  assert.equal(isHardwareBusy({ stderr: 'OpenEncodeSessionEx failed: out of memory (10)' }), true);
  assert.equal(isHardwareBusy({ stderr: 'Unknown encoder hevc_amf' }), false);
});

test('keeps the exact hardware encoder selected on a hybrid GPU machine', () => {
  const caps = {
    codecEncoderOptions: { h265_main: ['hevc_nvenc', 'hevc_amf'] },
    codecEncoders: { h265_main: 'hevc_nvenc' },
    h265Encoder: 'hevc_nvenc',
  };
  const amd = resolveAdaptiveCodec('hevc_amf', 'main', 8, caps);
  assert.equal(amd.codec, 'hevc_amf');
  assert.equal(amd.vendor, 'amf');
  const nvidia = resolveAdaptiveCodec('hevc_nvenc', 'main', 8, caps);
  assert.equal(nvidia.codec, 'hevc_nvenc');
  assert.equal(nvidia.vendor, 'nvenc');
});

test('falls back to CPU when the explicitly selected GPU encoder is unavailable', () => {
  const caps = {
    codecEncoderOptions: { h264_high: ['h264_nvenc'] },
    codecEncoders: { h264_high: 'h264_nvenc' },
    h264Encoder: 'h264_nvenc',
  };
  const resolved = resolveAdaptiveCodec('h264_amf', 'high', 8, caps);
  assert.equal(resolved.codec, 'x264');
  assert.equal(resolved.hardware, false);
});

test('ignores an encoder probe when its physical GPU vendor is absent', () => {
  const caps = {
    vendors: ['nvidia'],
    codecEncoderOptions: { h265_main: ['hevc_nvenc', 'hevc_amf'] },
    h265Encoder: 'hevc_nvenc',
  };
  assert.equal(resolveAdaptiveCodec('hevc_amf', 'main', 8, caps).codec, 'x265');
  assert.equal(resolveAdaptiveCodec('hevc_gpu', 'main', 8, caps).codec, 'hevc_nvenc');
});

test('keeps a probed HEVC RExt 4:4:4 profile on NVENC', () => {
  const caps = {
    vendors: ['nvidia'],
    upscaleProfileEncoderOptions: { h265_rext444_10: ['hevc_nvenc'] },
    h265Encoder: 'hevc_nvenc',
  };
  const resolved = resolveAdaptiveCodec('hevc_gpu', 'rext444-10', 10, caps);
  assert.equal(resolved.codec, 'hevc_nvenc');
  assert.equal(resolved.profile, 'rext444-10');
  assert.equal(resolved.hardware, true);
});
