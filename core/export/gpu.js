// @ts-check
// Capacités d'encodage GPU du moteur d'export. Délègue à la sonde RÉELLE (core/export/capabilities) :
// `ffmpeg -encoders` ne prouve rien (une RTX 30xx annonce av1_nvenc sans savoir encoder l'AV1, un
// ffmpeg Windows annonce qsv/amf sans le matériel) → seul un vrai encodage d'une frame fait foi.
// Multi-vendeurs : NVENC (NVIDIA), QSV (Intel), AMF (AMD) — un PC non-NVIDIA encode donc au GPU.
// Best-effort, jamais bloquant : sans encodeur matériel validé, core/export.js reste en CPU.

const capabilities = require('./capabilities');

/**
 * @typedef {object} GpuEncoderCapabilities
 * @property {boolean} hasGpuEncoder
 * @property {string|null} h264Encoder
 * @property {string|null} h265Encoder
 * @property {string|null} av1Encoder
 * @property {Record<string, string|null>} [codecEncoders] codec → encodeur matériel SONDÉ (null = CPU)
 * @property {Record<string, string[]>} [codecEncoderOptions] codec → tous les moteurs matériels sondés
 */

/** @returns {Promise<GpuEncoderCapabilities>} */
async function detectGpuCaps() {
  try {
    const caps = await capabilities.getCapabilities();
    return {
      hasGpuEncoder: caps.hasGpuEncoder,
      h264Encoder: caps.h264Encoder,
      h265Encoder: caps.h265Encoder,
      av1Encoder: caps.av1Encoder,
      codecEncoders: caps.codecEncoders,
      codecEncoderOptions: caps.codecEncoderOptions,
    };
  } catch (_) {
    return { hasGpuEncoder: false, h264Encoder: null, h265Encoder: null, av1Encoder: null, codecEncoders: {}, codecEncoderOptions: {} };
  }
}

module.exports = { detectGpuCaps };
