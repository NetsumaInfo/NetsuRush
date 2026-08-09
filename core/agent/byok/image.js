// @ts-check
// Pièce jointe image pour la boucle BYOK : quand un outil renvoie un fichier image (grab_still,
// make_thumbnail…), on encode le fichier en base64 pour que le modèle VOIE réellement l'image —
// sinon il ne reçoit que le chemin (aveugle ; seuls les CLI agents ont un outil de lecture natif).
// Plafond de taille (limite API ~5 Mo par image, marge base64) : au-delà on n'attache rien.

const fs = require('fs');
const path = require('path');

const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_BYTES = 3.5 * 1024 * 1024;

/** @param {any} r résultat d'outil @returns {{mediaType:string, data:string}|null} */
function imageAttachment(r) {
  if (!r || r.ok === false || typeof r.file !== 'string') return null;
  const mediaType = MEDIA[path.extname(r.file).toLowerCase()];
  if (!mediaType) return null;
  try {
    const st = fs.statSync(r.file);
    if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return null;
    return { mediaType, data: fs.readFileSync(r.file).toString('base64') };
  } catch {
    return null;
  }
}

module.exports = { imageAttachment };
