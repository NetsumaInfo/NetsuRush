// @ts-check
// Résolution d'encodeur pour les aperçus NetsuCut. Les capacités reçues viennent de la vraie sonde
// ffmpeg (une frame encodée), pas de la simple présence de l'encodeur dans la liste du binaire.

const { hwVendor } = require('./export/encodeArgs');

/** @param {string} encoder @returns {'nvenc'|'qsv'|'amf'|'cpu'} */
function proxyVendor(encoder) {
  const vendor = hwVendor(encoder);
  return vendor === 'nvenc' || vendor === 'qsv' || vendor === 'amf' ? vendor : 'cpu';
}

/**
 * @typedef {object} ProxyEncoder
 * @property {'hevc'|'h264'|'webp'|'vp8'} requestedCodec
 * @property {'hevc'|'h264'|'webp'|'vp8'} outputCodec
 * @property {string} encoder
 * @property {'nvenc'|'qsv'|'amf'|'cpu'} vendor
 * @property {'mp4'|'webp'|'webm'} container
 * @property {string} extension
 */

/**
 * @param {'hevc'|'h264'|'webp'|'vp8'} requestedCodec
 * @param {{ h264Encoder?: string|null, h265Encoder?: string|null, codecEncoderOptions?: Record<string,string[]> }} caps
 * @param {'auto'|'nvenc'|'qsv'|'amf'|'cpu'} [engine]
 * @returns {ProxyEncoder}
 */
function selectProxyEncoder(requestedCodec, caps, engine = 'auto') {
  if (requestedCodec === 'vp8') {
    return { requestedCodec, outputCodec: 'vp8', encoder: 'libvpx', vendor: 'cpu', container: 'webm', extension: 'webm' };
  }
  if (requestedCodec === 'webp') {
    return { requestedCodec, outputCodec: 'webp', encoder: 'libwebp', vendor: 'cpu', container: 'webp', extension: 'webp' };
  }
  const key = requestedCodec === 'hevc' ? 'h265_main' : 'h264_main';
  const options = Array.isArray(caps.codecEncoderOptions?.[key]) ? caps.codecEncoderOptions[key] : [];
  const preferred = requestedCodec === 'hevc' ? caps.h265Encoder : caps.h264Encoder;
  const encoder = engine === 'cpu'
    ? null
    : engine === 'auto'
      ? (options[0] || preferred)
      : options.find((candidate) => proxyVendor(candidate) === engine) || null;
  if (encoder) {
    const vendor = proxyVendor(encoder);
    return { requestedCodec, outputCodec: requestedCodec, encoder, vendor, container: 'mp4', extension: 'mp4' };
  }

  // Un lecteur qui accepte HEVC accepte aussi H.264. Si aucun HEVC matériel n'est vivant, on tente
  // H.264 matériel avant le repli universel libx264. Pas de libx265 : le CPU reste réservé aux
  // vignettes autant que possible et x265 serait trop lent pour du hover-to-play.
  if (requestedCodec === 'hevc' && engine !== 'cpu') {
    const h264Options = Array.isArray(caps.codecEncoderOptions?.h264_main) ? caps.codecEncoderOptions.h264_main : [];
    const h264 = engine === 'auto'
      ? (h264Options[0] || caps.h264Encoder)
      : h264Options.find((candidate) => proxyVendor(candidate) === engine);
    if (h264) return { requestedCodec, outputCodec: 'h264', encoder: h264, vendor: proxyVendor(h264), container: 'mp4', extension: 'mp4' };
  }
  // Le choix CPU explicite conserve le format demandé. En mode automatique, en revanche, ne jamais
  // déclencher x265 : il est trop lent pour un aperçu interactif et son HEVC peut être indécodable
  // dans le WebView2 packagé. Le repli automatique universel reste libx264.
  if (requestedCodec === 'hevc' && engine === 'cpu') {
    return { requestedCodec, outputCodec: 'hevc', encoder: 'libx265', vendor: 'cpu', container: 'mp4', extension: 'mp4' };
  }
  return { requestedCodec, outputCodec: 'h264', encoder: 'libx264', vendor: 'cpu', container: 'mp4', extension: 'mp4' };
}

/**
 * Sélection rapide pour les previews. La sonde complète des capacités d'export peut lancer de
 * nombreux ffmpeg ; elle ne doit pas bloquer le premier double-clic. L'encodage reste protégé par
 * le repli CPU si le moteur optimiste n'est pas accepté par le pilote.
 * @param {'hevc'|'h264'|'webp'|'vp8'} requestedCodec
 * @param {string[]} vendors
 * @returns {ProxyEncoder}
 */
function selectFastProxyEncoder(requestedCodec, vendors) {
  if (requestedCodec === 'webp' || requestedCodec === 'vp8') return selectProxyEncoder(requestedCodec, {});
  const candidates = requestedCodec === 'hevc'
    ? { nvidia: 'hevc_nvenc', amd: 'hevc_amf', intel: 'hevc_qsv' }
    : { nvidia: 'h264_nvenc', amd: 'h264_amf', intel: 'h264_qsv' };
  const vendor = ['nvidia', 'amd', 'intel'].find((v) => vendors.includes(v));
  const encoder = vendor ? candidates[vendor] : null;
  if (!encoder) return selectProxyEncoder(requestedCodec, {});
  return {
    requestedCodec,
    outputCodec: requestedCodec,
    encoder,
    vendor: proxyVendor(encoder),
    container: 'mp4',
    extension: 'mp4',
  };
}

/** @param {ProxyEncoder} resolved @param {'level1'|'level2'|'level3'} [preset] @returns {string[]} */
function proxyVideoArgs(resolved, preset = 'level1') {
  const level = preset === 'level3' ? 3 : preset === 'level2' ? 2 : 1;
  const q = level === 1 ? '30' : level === 2 ? '27' : '23';
  if (resolved.outputCodec === 'webp') {
    const compression = level === 1 ? '0' : level === 2 ? '3' : '6';
    const quality = level === 1 ? '70' : level === 2 ? '82' : '92';
    return ['-c:v', 'libwebp', '-lossless', '0', '-compression_level', compression, '-quality', quality, '-loop', '0'];
  }
  if (resolved.outputCodec === 'vp8') {
    return ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', level === 1 ? '8' : level === 2 ? '6' : '4', '-crf', level === 1 ? '40' : level === 2 ? '34' : '28', '-b:v', level === 1 ? '900k' : level === 2 ? '1400k' : '2000k', '-lag-in-frames', '0', '-auto-alt-ref', '0', '-g', '48', '-pix_fmt', 'yuv420p'];
  }
  if (resolved.vendor === 'nvenc') {
    return ['-c:v', resolved.encoder, '-profile:v', 'main', '-preset', level === 1 ? 'p1' : level === 2 ? 'p4' : 'p7', '-tune', 'ull', '-rc-lookahead', '0', '-cq', q, '-b:v', '0', '-bf', '0', '-pix_fmt', 'yuv420p'];
  }
  if (resolved.vendor === 'qsv') {
    return ['-c:v', resolved.encoder, '-profile:v', 'main', '-preset', level === 1 ? 'veryfast' : level === 2 ? 'medium' : 'veryslow', '-look_ahead', '0', '-global_quality', q, '-bf', '0', '-pix_fmt', 'nv12'];
  }
  if (resolved.vendor === 'amf') {
    return ['-c:v', resolved.encoder, '-profile:v', 'main', '-usage', 'ultralowlatency', '-quality', level === 1 ? 'speed' : level === 2 ? 'balanced' : 'quality', '-rc', 'cqp', '-qp_i', q, '-qp_p', q, '-bf', '0', '-pix_fmt', 'nv12'];
  }
  return ['-c:v', resolved.encoder === 'libx265' ? 'libx265' : 'libx264', '-profile:v', 'main', '-preset', level === 1 ? 'ultrafast' : level === 2 ? 'veryfast' : 'medium', '-tune', 'zerolatency', '-crf', q, '-bf', '0', '-pix_fmt', 'yuv420p'];
}

/** @param {ProxyEncoder} resolved @returns {string[]} */
function proxyContainerArgs(resolved) {
  return resolved.outputCodec === 'hevc' ? ['-tag:v', 'hvc1'] : [];
}

/** Refus de session matériel transitoire (NVENC, QSV ou AMF). @param {unknown} error */
function isHardwareBusy(error) {
  const e = /** @type {{ stderr?: unknown }} */ (error || {});
  const s = String(e.stderr || error || '').toLowerCase();
  const session = s.includes('openencodesessionex') || s.includes('open encode session')
    || s.includes('encode session') || s.includes('device busy') || s.includes('resource temporarily unavailable');
  const pressure = s.includes('out of memory') || s.includes('(10)') || s.includes('failed')
    || s.includes('busy') || s.includes('temporarily unavailable');
  return session && pressure;
}

module.exports = { selectProxyEncoder, selectFastProxyEncoder, proxyVideoArgs, proxyContainerArgs, isHardwareBusy };
