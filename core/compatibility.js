// @ts-check
// Rapport unifié des backends réellement utilisables : inventaire Windows, exécution Python et
// encodeurs ffmpeg sondés. Lecture seule, sans charger de modèle ni télécharger de poids.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { detectHardware } = require('./hardware');
const { getCapabilities } = require('./export/capabilities');
const { PYTHON, DETECT_ENV, ML_BACKEND, ONNX_BACKEND, TRANSCRIBE_BACKEND } = require('./config');

const PY_DIR = process.env.NETSURUSH_PY_DIR || path.join(__dirname, '..', 'python');
const PROBE_SCRIPT = path.join(PY_DIR, 'device_probe.py');

/** @returns {Promise<any>} */
function probePython() {
  return new Promise((resolve) => {
    const cp = spawn(PYTHON, [PROBE_SCRIPT], { env: DETECT_ENV, windowsHide: true });
    let out = '', err = '', settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { cp.kill(); } catch (_) {}
      finish({ torch: null, onnx: null, errors: ['diagnostic Python expiré'] });
    }, 30000);
    cp.stdout.on('data', (b) => { out += b.toString(); });
    cp.stderr.on('data', (b) => { err = (err + b.toString()).slice(-1000); });
    cp.on('error', (e) => finish({ torch: null, onnx: null, errors: [String(e.message || e)] }));
    cp.on('close', (code) => {
      if (code !== 0) return finish({ torch: null, onnx: null, errors: [err.trim() || `python code ${code}`] });
      try { finish(JSON.parse(out.trim())); }
      catch (_) { finish({ torch: null, onnx: null, errors: ['réponse Python invalide'] }); }
    });
  });
}

let memo = null;
let memoAt = 0;

/** @param {{ force?: boolean }} [opts] */
async function status(opts = {}) {
  if (!opts.force && memo && Date.now() - memoAt < 30000) return memo;
  const [hardware, encoding, python] = await Promise.all([
    detectHardware({ force: !!opts.force }),
    getCapabilities({ force: !!opts.force }).catch((e) => ({ codecs: [], codecEncoders: {}, codecEncoderOptions: {}, upscaleProfileEncoderOptions: {}, hwEncoders: [], hasGpuEncoder: false, h264Encoder: null, h265Encoder: null, av1Encoder: null, webp: false, error: String(e) })),
    probePython(),
  ]);
  memo = {
    ok: true,
    hardware,
    configured: { torch: ML_BACKEND, onnx: ONNX_BACKEND, transcribe: TRANSCRIBE_BACKEND },
    runtime: python,
    encoding: {
      h264: encoding.h264Encoder || null,
      h265: encoding.h265Encoder || null,
      av1: encoding.av1Encoder || null,
      webp: !!encoding.webp,
      hardwareEncoders: encoding.hwEncoders || [],
      codecEncoders: encoding.codecEncoders || {},
      codecEncoderOptions: encoding.codecEncoderOptions || {},
      upscaleProfileEncoderOptions: encoding.upscaleProfileEncoderOptions || {},
      codecs: encoding.codecs || [],
      error: /** @type {any} */ (encoding).error || null,
    },
  };
  memoAt = Date.now();
  return memo;
}

module.exports = { probePython, status };
