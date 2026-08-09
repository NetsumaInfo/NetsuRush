const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function readBackendConfig(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'netsurush-config-test-'));
  try {
    fs.writeFileSync(path.join(home, 'nr.config.json'), JSON.stringify(config));
    const script = "const c=require('./core/config');console.log(JSON.stringify({"
      + "ml:c.ML_BACKEND,onnx:c.ONNX_BACKEND,transcribe:c.TRANSCRIBE_BACKEND,"
      + "envMl:c.DETECT_ENV.NETSURUSH_ML_BACKEND,envOnnx:c.DETECT_ENV.NETSURUSH_ONNX_BACKEND,"
      + "cudaLoading:c.DETECT_ENV.CUDA_MODULE_LOADING||null}))";
    const run = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NR_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout.trim());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('routes ROCm torch, DirectML ONNX and Vulkan native inference without CUDA tuning', () => {
  assert.deepEqual(readBackendConfig({ mlBackend: 'rocm', onnxBackend: 'directml' }), {
    ml: 'rocm', onnx: 'directml', transcribe: 'vulkan',
    envMl: 'rocm', envOnnx: 'directml', cudaLoading: null,
  });
});

test('keeps NVIDIA-specific runtime tuning on the CUDA profile', () => {
  assert.deepEqual(readBackendConfig({ mlBackend: 'cuda', onnxBackend: 'cuda' }), {
    ml: 'cuda', onnx: 'cuda', transcribe: 'cuda',
    envMl: 'cuda', envOnnx: 'cuda', cudaLoading: 'LAZY',
  });
});

test('uses Vulkan for a generic AMD profile even when PyTorch stays on CPU', () => {
  const config = readBackendConfig({
    mlBackend: 'cpu', onnxBackend: 'directml', hardware: { vendors: ['amd'] },
  });
  assert.equal(config.transcribe, 'vulkan');
  assert.equal(config.cudaLoading, null);
});
