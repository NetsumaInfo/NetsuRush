// @ts-check
// Encodage des variantes de fond d'écran. Aucune I/O de store ici : ce module ne sait que produire
// un fichier à partir d'un autre.
//
// Le flou cuit ici ne sert plus la COUCHE PRINCIPALE — elle le fait en CSS, en continu, pour que le
// curseur réponde à la frappe. Il sert les PANNEAUX qui repeignent le fond (tiroir latéral) : un
// `filter` posé sur un panneau flouterait son texte, et un flou posé sur son image de fond aspire du
// transparent hors des bords, ce qui lui dessine un liseré sombre. Seule une image DÉJÀ floutée
// donne un raccord propre — d'où ces variantes, une par marche.
//
// Une image floutée n'a plus de haute fréquence : elle se COMPRESSE donc énormément. C'est de là que
// vient la légèreté de l'échelle — pas d'une réduction des dimensions. Réduire puis laisser le
// navigateur réagrandir donnait un flou « brouillé », le défaut le plus visible du fond.
//
// Un GIF n'est JAMAIS resservi en GIF : le pipeline d'images animées de Chromium le décode sur le
// CPU et rien ne permet de le mettre en pause. Il devient une vidéo (décodage matériel, pausable).

const path = require('path');
const { fsp } = require('../config');
const { run } = require('../ffmpeg');
const { getCapabilities } = require('../export/capabilities');
const { selectProxyEncoder, proxyVideoArgs } = require('../proxyEncoder');

/** Largeur de référence des rayons de flou : un rayon vaut ce qu'il vaut À CETTE ÉCHELLE. */
const BASE_WIDTH = 1920;
// Le flou ne réduit PLUS les dimensions : à l'écran, un agrandissement par le navigateur transforme
// un flou gaussien propre en bouillie (banding, aplats pâteux). Le poids reste bas parce qu'une image
// sans détail se compresse, pas parce qu'on l'a rétrécie.
// Marches d'APPROXIMATION du rayon demandé, pour la seule image des panneaux. Le curseur, lui, est
// continu : c'est la couche principale qui rend le rayon exact, en CSS. Pas de 4 px jusqu'à 32 (là
// où l'œil voit la différence), puis plus large (au-delà, deux rayons voisins rendent la même
// bouillie). Chaque marche n'est encodée que si elle est demandée, donc allonger la liste ne coûte
// rien tant qu'on ne s'en sert pas. Miroir : WALLPAPER_SURFACE_BLUR_STEPS (src/lib/wallpaper.ts).
const BLUR_STEPS = [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80, 90, 100];
const MAX_LOOP_HEIGHT = 1080;
const MAX_LOOP_FPS = 30;
const STILL_QUALITY = 82;
/** Au-delà, ce n'est plus un fond mais un film : on borne pour ne pas remplir NR_HOME. */
const MAX_LOOP_SECONDS = 60;
// Un encodage qui n'aboutit pas doit ÉCHOUER, pas rester en vol : sans borne, une source pathologique
// (très longue, corrompue, sur un disque réseau) laisse l'import tourner sans fin et l'utilisateur
// devant un bouton qui ne rend jamais la main.
const STILL_TIMEOUT_MS = 30_000;
const LOOP_TIMEOUT_MS = 180_000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Rayon (échelle 1920) d'une marche. Hors bornes → la marche la plus proche, jamais une erreur. */
function blurRadius(step) {
  return BLUR_STEPS[clamp(Math.round(step), 0, BLUR_STEPS.length - 1)];
}

/** Largeur d'encodage : la pleine résolution de l'entrée, quel que soit le flou. */
function blurWidth(_radius, baseWidth = BASE_WIDTH) {
  return baseWidth;
}

/**
 * Sigma gaussien. Égal au rayon affiché, comme le `blur()` de CSS dont l'écart-type EST la valeur en
 * px : « 32 px » dans l'interface doit rendre ce que rend `blur(32px)`, sinon le chiffre ne veut rien
 * dire. Mis à l'échelle de la largeur d'encodage quand la source est plus petite que la référence.
 */
function blurSigma(radius, width, baseWidth = BASE_WIDTH) {
  if (radius <= 0) return 0;
  return Math.max(0.6, radius * (width / baseWidth));
}

/** Chaîne de filtres commune : réduction lanczos puis flou. `-2` garde le ratio en dimension paire. */
function scaleAndBlur(width, sigma, evenHeight) {
  const scale = `scale=${width}:${evenHeight ? -2 : -1}:flags=lanczos`;
  // `steps=3` : trois passes approchent une vraie gaussienne. En une seule passe, gblur reste proche
  // d'un flou de boîte, dont les bords carrés se voient sur les aplats.
  // Le flou tire des pixels de l'extérieur du cadre : sans `edge` en miroir, les bords s'assombrissent
  // et le fond gagne un liseré sombre visible sur toute la fenêtre.
  return sigma > 0 ? `${scale},gblur=sigma=${sigma.toFixed(2)}:steps=3` : scale;
}

// Écriture atomique : le fichier n'apparaît sous son nom définitif qu'une fois complet, sinon un
// rendu concurrent servirait un fichier à moitié écrit. `-f` est OBLIGATOIRE puisque l'extension
// `.tmp` empêche ffmpeg de deviner le muxer (même piège que core/proxy.js).
async function writeAtomic(dest, format, args, timeout) {
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    await run('ffmpeg', [...args, '-f', format, tmp], { timeout });
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    // `killed` = la borne a expiré : le dire explicitement, sinon le message ffmpeg tronqué ne
    // renseigne sur rien et l'utilisateur ne sait pas s'il doit réessayer ou changer de fichier.
    const reason = err.killed ? `dépassé ${Math.round(timeout / 1000)} s` : err.message;
    throw new Error(`encodage du fond échoué (${path.basename(dest)}) : ${reason}`);
  }
  return dest;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = typeof value === 'string' ? parseFloat(value) : value;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** `24/1` → 24. Une cadence inconnue vaut 0 (le repli ne doit pas inventer une animation). */
function parseFps(raw) {
  const [num, den] = String(raw || '').split('/');
  const n = parseFloat(num);
  const d = den === undefined ? 1 : parseFloat(den);
  return Number.isFinite(n) && Number.isFinite(d) && d > 0 ? n / d : 0;
}

/**
 * Sonde une source candidate. Le caractère ANIMÉ se lit au nombre de frames, jamais à l'extension :
 * un `.webp` peut être animé et un `.gif` peut ne porter qu'une image.
 */
async function probeSource(file) {
  const raw = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,codec_name,avg_frame_rate:format=duration',
    '-of', 'json', file,
  ]);
  const meta = JSON.parse(raw.toString());
  const stream = meta?.streams?.[0];
  if (!stream || !stream.width) throw new Error(`aucun flux image dans ${path.basename(file)}`);
  const duration = firstNumber(meta?.format?.duration);
  const fps = parseFps(stream.avg_frame_rate);
  const frames = firstNumber(stream.nb_frames) || Math.round(duration * fps);
  return {
    width: stream.width,
    height: stream.height,
    codec: String(stream.codec_name || ''),
    duration,
    fps,
    frames,
    animated: frames > 1,
  };
}

/**
 * Encode une variante fixe (webp). Sert AUSSI de poster d'une source animée : `-frames:v 1` prend la
 * première image, donc l'affichage figé n'a besoin d'aucun décodeur vidéo vivant.
 */
async function encodeStill(src, dest, { step = 0, baseWidth = BASE_WIDTH } = {}) {
  const radius = blurRadius(step);
  const width = blurWidth(radius, baseWidth);
  return writeAtomic(dest, 'webp', [
    '-y', '-i', src,
    '-frames:v', '1',
    '-vf', scaleAndBlur(width, blurSigma(radius, width, baseWidth), false),
    '-c:v', 'libwebp', '-lossless', '0', '-quality', String(STILL_QUALITY),
  ], STILL_TIMEOUT_MS);
}

/**
 * Encode la boucle animée. L'encodeur matériel est celui déjà choisi pour les proxies
 * (`selectProxyEncoder`) : une seule table de vérité pour NVENC/QSV/AMF et le repli CPU.
 */
async function encodeLoop(src, dest, { step = 0, baseWidth = BASE_WIDTH, duration = 0 } = {}) {
  const radius = blurRadius(step);
  const width = blurWidth(radius, baseWidth);
  const resolved = selectProxyEncoder('h264', await getCapabilities(), 'auto');
  const limit = duration > MAX_LOOP_SECONDS ? ['-t', String(MAX_LOOP_SECONDS)] : [];
  const filters = `fps=${MAX_LOOP_FPS},${scaleAndBlur(width, blurSigma(radius, width, baseWidth), true)}`
    + `,scale='min(iw,${width})':'min(ih,${MAX_LOOP_HEIGHT})':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  return writeAtomic(dest, 'mp4', [
    '-y', ...limit, '-i', src,
    '-an',
    '-vf', filters,
    ...proxyVideoArgs(resolved, 'level2'),
    '-movflags', '+faststart',
  ], LOOP_TIMEOUT_MS);
}

module.exports = {
  BLUR_STEPS, BASE_WIDTH, MAX_LOOP_HEIGHT, MAX_LOOP_FPS, MAX_LOOP_SECONDS,
  blurRadius, blurWidth, blurSigma, probeSource, encodeStill, encodeLoop,
};
