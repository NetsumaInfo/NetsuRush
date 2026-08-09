// @ts-check
// Helpers partagés du core (sans dépendance Electron/Resolve).

const fs = require('fs');

// Un dossier de poids « présent » = existant ET non vide. Un dossier créé puis abandonné (download
// annulé, modèle supprimé) ne doit jamais être passé à un moteur : il échouerait au chargement.
const hasFiles = (dir) => {
  try { return !!dir && fs.readdirSync(dir).length > 0; } catch (_) { return false; }
};

// Extension de conteneur : H.264/HEVC CPU ou matériel multi-vendeur → mp4 ; montage → mov.
const codecExt = (codec) => /^(x26[45]|h264_(?:nvenc|qsv|amf|gpu)|hevc_(?:nvenc|qsv|amf|gpu))$/.test(String(codec)) ? 'mp4' : 'mov';

// Nettoie un nom pour un système de fichiers (retire les caractères interdits Windows).
const sanitizeName = (s) => String(s || 'clip').replace(/[\\/:*?"<>|]+/g, '_');

// Extensions d'un RUSH = « ce qu'un NLE sait ingérer » (caméra/montage inclus : R3D, BRAW, DPX…).
// À NE PAS confondre avec les listes plus étroites de reference.js / extract.js, qui répondent à
// « ce qu'une balise <video> sait lire » — un .braw posé sur le board ne se lirait pas. Sémantiques
// distinctes malgré des données qui se ressemblent : ne pas fusionner.
const RUSH_EXTS = new Set([
  'mp4', 'mov', 'mxf', 'avi', 'mkv', 'm4v', 'mts', 'm2ts', 'ts',
  'wmv', 'flv', 'webm', 'ogv', '3gp', '3g2',
  'r3d', 'braw', 'ari', 'arx', 'dpx', 'movi',
  'dng', 'cine', 'cin',
]);

// Extensions audio acceptées par les bibliothèques de médias. Elles restent séparées des rushs
// vidéo : les vues de dérush continuent ainsi de pouvoir demander uniquement `RUSH_EXTS`.
const AUDIO_EXTS = new Set([
  'wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aif', 'aiff', 'wma',
]);
const MEDIA_EXTS = new Set([...RUSH_EXTS, ...AUDIO_EXTS]);

// `p` → true si l'extension est celle d'un rush.
const isRushPath = (p) => RUSH_EXTS.has(String(p || '').split('.').pop().toLowerCase());
const isMediaPath = (p) => MEDIA_EXTS.has(String(p || '').split('.').pop().toLowerCase());

module.exports = { codecExt, hasFiles, sanitizeName, RUSH_EXTS, AUDIO_EXTS, MEDIA_EXTS, isRushPath, isMediaPath };
