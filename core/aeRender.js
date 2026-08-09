// @ts-check
const fs = require('fs');
const path = require('path');

// Codec NetsuRush → (format, codec) du moteur de rendu Resolve.
const RESOLVE_CODECS = {
  prores_proxy:  ['mov', 'ProRes422Proxy'],
  prores_lt:     ['mov', 'ProRes422LT'],
  prores_422:    ['mov', 'ProRes422'],
  prores_hq:     ['mov', 'ProRes422HQ'],
  prores_4444:   ['mov', 'ProRes4444'],
  prores_4444xq: ['mov', 'ProRes4444XQ'],
  dnxhr_lb:      ['mov', 'DNxHR_LB'],
  dnxhr_sq:      ['mov', 'DNxHR_SQ'],
  dnxhr_hq:      ['mov', 'DNxHR_HQ'],
  dnxhr_hqx:     ['mov', 'DNxHR_HQX'],
  dnxhr_444:     ['mov', 'DNxHR_444'],
  x264:          ['mp4', 'H264'],
  x265:          ['mp4', 'H265'],
};

// Formats de rendu audio seul Resolve (timeline sans vidéo) → conteneurs importables AE.
const AUDIO_RENDER = {
  wav:  ['wav',  'LinearPCM'],
  aiff: ['aiff', 'LinearPCM'],
  aac:  ['mp4',  'AAC'],
};

const resolveExt = (fmt) => (fmt === 'mp4' ? 'mp4' : 'mov');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve peut suffixer le nom de sortie → prend le plus récent qui commence par `base`.
// `ext` null = n'importe quelle extension (format audio dont l'extension réelle varie).
function findRendered(dir, base, ext) {
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return null; }
  const lb = base.toLowerCase();
  const cands = entries.filter((e) =>
    e.toLowerCase().startsWith(lb) && (!ext || e.toLowerCase().endsWith('.' + ext)));
  if (!cands.length) return null;
  cands.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return path.join(dir, cands[0]);
}

// Rend [markIn, markOut] (frames timeline, markOut inclusif) de `timeline` en un fichier unique.
// Bake fidèle : transitions, effets, grades, transforms keyframés (seul moyen de capturer l'anim,
// l'API ne lit pas les keyframes). Change la timeline courante de Resolve → l'appelant restaure.
async function renderRange(proj, opts) {
  const { timeline, markIn, markOut, outDir, customName, codec, exportAudio, audioOnly, audioFmt, onStatus } = opts;
  let fmt, cdc, ext;
  if (audioOnly) {
    [fmt, cdc] = AUDIO_RENDER[audioFmt] || AUDIO_RENDER.wav;
    ext = null;                                   // extension audio réelle variable → match libre
  } else {
    [fmt, cdc] = RESOLVE_CODECS[codec] || RESOLVE_CODECS.prores_hq;
    ext = resolveExt(fmt);
  }

  await proj.SetCurrentTimeline(timeline);
  try { await proj.SetCurrentRenderFormatAndCodec(fmt, cdc); } catch (_) {}
  try { await proj.DeleteAllRenderJobs(); } catch (_) {}

  const settings = {
    SelectAllFrames: false, MarkIn: markIn, MarkOut: markOut,
    TargetDir: outDir, CustomName: customName,
    ExportVideo: !audioOnly, ExportAudio: audioOnly ? true : !!exportAudio,
  };
  if (audioOnly) settings.AudioCodec = cdc;
  await proj.SetRenderSettings(settings);

  const jobId = await proj.AddRenderJob();
  if (!jobId) throw new Error('Resolve render : AddRenderJob a échoué (réglages invalides).');
  await proj.StartRendering(jobId);

  for (let i = 0; i < 200000; i++) {
    let inProg = false;
    try { inProg = !!(await proj.IsRenderingInProgress()); } catch (_) {}
    if (!inProg) break;
    if (onStatus) { try { onStatus(await proj.GetRenderJobStatus(jobId)); } catch (_) {} }
    await sleep(500);
  }

  let err = null;
  try {
    const st = await proj.GetRenderJobStatus(jobId);
    if (st && st.JobStatus === 'Failed') err = st.Error || 'rendu échoué';
  } catch (_) {}
  try { await proj.DeleteAllRenderJobs(); } catch (_) {}
  if (err) throw new Error('Resolve render : ' + err);

  const file = findRendered(outDir, customName, ext);
  if (!file) throw new Error('Resolve render : fichier de sortie introuvable (' + customName + ').');
  return file;
}

module.exports = { renderRange, RESOLVE_CODECS };