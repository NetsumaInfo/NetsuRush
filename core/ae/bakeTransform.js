// @ts-check
// Cuisson du transform d'un plan DANS le fichier (mode « Réencodé »). Le pendant ffmpeg de ce que
// `applyXf` pose sur un calque After Effects : même modèle, même repère, mais rendu dans le pixel.
//
// Modèle repris à l'identique de la pose AE — le contredire ferait diverger les deux modes :
//   comp = P + R·S·(p − A)
// avec p un point de la SOURCE, A l'ancrage (pixels source, origine coin haut-gauche), S l'échelle
// (ajustement à l'image de la timeline × zoom Resolve), R la rotation, P la position du plan dans la
// comp. Resolve AJUSTE la source à l'image avant d'appliquer son zoom : d'où le facteur `fit`.
//
// Ce que ffmpeg sait faire, lui, c'est : recadrer, miroiter, redimensionner, tourner autour du
// CENTRE de l'image, puis incruster à un décalage. L'écart entre les deux — pivot au centre contre
// pivot à l'ancrage — se résorbe dans le décalage d'incrustation, calculé ici.

/** Arrondi PAIR : le 4:2:0 (H.264/HEVC) refuse une dimension impaire. */
const even = (value) => Math.max(2, 2 * Math.round(value / 2));

const isIdentity = (xf) => !xf
  || (near(xf.zoomX, 1) && near(xf.zoomY, 1) && near(xf.pan, 0) && near(xf.tilt, 0)
    && near(xf.rot, 0) && near(xf.anchorX, 0) && near(xf.anchorY, 0)
    && near(xf.cropL, 0) && near(xf.cropR, 0) && near(xf.cropT, 0) && near(xf.cropB, 0)
    && !xf.flipX && !xf.flipY);

function near(value, target) {
  return Math.abs((Number(value) || 0) - target) < 1e-6;
}

/** Rotation HORAIRE de `deg` degrés, dans un repère écran (Y vers le bas) — celui d'AE. */
function rotate(deg, x, y) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Graphe ffmpeg qui rend le plan transformé sur une image de la taille de la TIMELINE.
 *
 * @param {{ srcW:number, srcH:number, compW:number, compH:number, xf:any, alpha?:boolean,
 *           setpts?:string|null }} spec
 * @returns {{ inputs:string[], filter:string[], map:string[] }|null} `null` = rien à cuire
 *          (transform identité, ou dimensions source inconnues : on ne devine pas un cadrage).
 */
function bakeGraph(spec) {
  const { srcW, srcH, compW, compH, xf, alpha, setpts } = spec;
  if (!(srcW > 0) || !(srcH > 0) || !(compW > 0) || !(compH > 0)) return null;
  if (isIdentity(xf) && !setpts) return null;

  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const cropL = Math.max(0, Math.round(num(xf && xf.cropL, 0)));
  const cropR = Math.max(0, Math.round(num(xf && xf.cropR, 0)));
  const cropT = Math.max(0, Math.round(num(xf && xf.cropT, 0)));
  const cropB = Math.max(0, Math.round(num(xf && xf.cropB, 0)));
  const cw = Math.max(2, srcW - cropL - cropR);
  const ch = Math.max(2, srcH - cropT - cropB);

  // Resolve ajuste la SOURCE ENTIÈRE à l'image de la timeline ; le recadrage joue ensuite, dans le
  // repère de la source. Prendre le recadrage dans le facteur d'ajustement regonflerait le plan.
  const fit = Math.min(compW / srcW, compH / srcH);
  const sx = fit * num(xf && xf.zoomX, 1);
  const sy = fit * num(xf && xf.zoomY, 1);
  const sw = even(cw * sx);
  const sh = even(ch * sy);

  // Ancrage en pixels de la source, origine coin haut-gauche (convention du document), puis ramené
  // dans le repère de l'image RECADRÉE, et miroité avec elle.
  let ax = srcW / 2 + num(xf && xf.anchorX, 0) - cropL;
  let ay = srcH / 2 - num(xf && xf.anchorY, 0) - cropT;
  if (xf && xf.flipX) ax = cw - ax;
  if (xf && xf.flipY) ay = ch - ay;

  const rot = num(xf && xf.rot, 0);
  const rad = (rot * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // Image tournée : ffmpeg agrandit le cadre pour ne rien couper, exactement comme rotw/roth. La
  // tolérance absorbe le cosinus de 90° qui vaut 6e-17 et non 0 — sans elle, un quart de tour
  // gagnait un pixel, donc un cadre impair que le 4:2:0 refuse.
  const rw = near(rot, 0) ? sw : Math.ceil(sw * cos + sh * sin - 1e-6);
  const rh = near(rot, 0) ? sh : Math.ceil(sw * sin + sh * cos - 1e-6);

  // Tilt positif monte : l'axe Y de la comp décroît (même signe que dans applyXf).
  const px = compW / 2 + num(xf && xf.pan, 0);
  const py = compH / 2 - num(xf && xf.tilt, 0);
  // (X,Y) = P − R·S·A + R·c − (rw/2, rh/2) : le pivot passe de l'ancrage au centre de l'image.
  const [rax, ray] = rotate(rot, ax * sx, ay * sy);
  const [rcx, rcy] = rotate(rot, sw / 2, sh / 2);
  const x = Math.round(px - rax + rcx - rw / 2);
  const y = Math.round(py - ray + rcy - rh / 2);

  const steps = [];
  if (setpts) steps.push(`setpts=${setpts}`);
  if (cropL || cropR || cropT || cropB) steps.push(`crop=${cw}:${ch}:${cropL}:${cropT}`);
  if (xf && xf.flipX) steps.push('hflip');
  if (xf && xf.flipY) steps.push('vflip');
  steps.push(`scale=${sw}:${sh}`);
  if (!near(rot, 0)) {
    // Le remplissage des coins doit être TRANSPARENT quand le codec porte l'alpha, noir sinon —
    // un coin noir sur un plan tourné se verrait par-dessus les pistes du dessous.
    steps.push(`rotate=${rad.toFixed(9)}:ow=${rw}:oh=${rh}:fillcolor=${alpha ? 'none' : 'black'}`);
  }
  // Fond de la taille de la timeline : sans lui, un plan réduit ou décalé n'aurait pas de cadre où
  // se poser, et AE recevrait un fichier aux dimensions du plan au lieu de celles du montage.
  const canvas = alpha ? `color=c=black@0.0:s=${compW}x${compH}` : `color=c=black:s=${compW}x${compH}`;
  const chain = `[0:v]${steps.join(',')}[fg];[1:v][fg]overlay=${x}:${y}:shortest=1${alpha ? ',format=yuva444p10le' : ''}[v]`;

  return {
    inputs: ['-f', 'lavfi', '-i', canvas],
    filter: ['-filter_complex', chain],
    map: ['-map', '[v]', '-map', '0:a?'],
  };
}

/** Codecs qui portent un canal alpha : seuls eux gardent la transparence hors du cadre. */
const ALPHA_CODECS = /^prores_4444/;
const carriesAlpha = (codec) => ALPHA_CODECS.test(String(codec || ''));

module.exports = { bakeGraph, carriesAlpha, isIdentity };
