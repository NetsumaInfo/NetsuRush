// @ts-check
// Persistance des conversations Chat IA. Repli JSON-file simple sous NR_HOME/chat (une conversation =
// un fichier JSON). Suffisant pour l'historique ; aligné sur le pattern des autres stores core.

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');

/** @param {string} dataDir */
function createChatStore(dataDir) {
  const root = path.join(dataDir, 'chat');

  /// Un dossier par surface. NetsuPilot garde la RACINE — ses conversations
  /// existantes sont deja la, et les deplacer pour faire symetrique perdrait
  /// l'historique de quelqu'un pour une question de gout. NetsuFlow prend un
  /// sous-dossier ; il ne perturbe pas le listing de la racine, qui ne retient
  /// que les fichiers `.json`.
  /** @param {string} [surface] */
  function dirFor(surface) {
    const dir = surface && surface !== 'pilot' ? path.join(root, String(surface).replace(/[^a-z0-9_-]/gi, '')) : root;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
    return dir;
  }

  const file = (/** @type {string} */ id, /** @type {string} */ surface) =>
    path.join(dirFor(surface), `${id.replace(/[^a-z0-9_-]/gi, '')}.json`);
  const now = () => Date.now();

  /** @param {string} [surface] */
  function listConversations(surface) {
    const dir = dirFor(surface);
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const n of names) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
        out.push({ id: c.id, title: c.title || t('conversation'), updatedAt: c.updatedAt || 0 });
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** @param {string} id @param {string} [surface] */
  function loadConversation(id, surface) {
    try { return JSON.parse(fs.readFileSync(file(id, surface), 'utf8')); } catch { return null; }
  }

  /** @param {{id?:string, title?:string, messages:any[], surface?:string}} conv */
  function saveConversation(conv) {
    const id = conv.id || Math.random().toString(36).slice(2, 10);
    const updatedAt = now();
    const data = { id, title: conv.title || t('conversation'), messages: conv.messages || [], updatedAt };
    try { fs.writeFileSync(file(id, conv.surface), JSON.stringify(data)); return { ok: true, id, updatedAt }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }

  /** @param {string} id @param {string} [surface] */
  function deleteConversation(id, surface) {
    try { fs.unlinkSync(file(id, surface)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }

  return { listConversations, loadConversation, saveConversation, deleteConversation };
}

module.exports = { createChatStore };
