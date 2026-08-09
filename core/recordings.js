// @ts-check
// core/recordings.js
// Dossier d'enregistrements voix off du module Script : liste les fichiers audio d'un dossier
// configuré côté renderer (les plus récents d'abord). Le parcours est récursif afin de conserver
// l'organisation réelle du dossier dans NetsuDraft. Aucun watcher — le panneau re-liste
// périodiquement (poll léger), ce qui suffit pour « je viens d'enregistrer, ça apparaît ».

const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const AUDIO_EXTS = new Set(['wav', 'mp3', 'aac', 'm4a', 'flac', 'ogg', 'aif', 'aiff', 'opus', 'wma']);

/**
 * @param {string} dir
 * @returns {{ ok: boolean, error?: string, files: { path: string, name: string, folder: string, mtime: number, size: number }[] }}
 */
function listRecordings(dir) {
  if (!dir) return { ok: false, error: t('folderNotConfigured'), files: [] };
  try {
    const files = [];
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) { stack.push(full); continue; }
        if (!entry.isFile() || !AUDIO_EXTS.has(path.extname(entry.name).slice(1).toLowerCase())) continue;
        const st = fs.statSync(full);
        const rel = path.relative(dir, path.dirname(full));
        files.push({ path: full, name: entry.name, folder: rel === '.' ? '' : rel.split(path.sep).join('/'), mtime: st.mtimeMs, size: st.size });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { ok: true, files };
  } catch (e) {
    return { ok: false, error: String(e), files: [] };
  }
}

module.exports = { listRecordings };
