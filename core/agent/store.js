// @ts-check
// Persistance des conversations Chat IA. Repli JSON-file simple sous NR_HOME/chat (une conversation =
// un fichier JSON). Suffisant pour l'historique ; aligné sur le pattern des autres stores core.

const fs = require('fs');
const path = require('path');
const { t } = require('../i18n');

/** @param {string} dataDir */
function createChatStore(dataDir) {
  const dir = path.join(dataDir, 'chat');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
  const file = (/** @type {string} */ id) => path.join(dir, `${id.replace(/[^a-z0-9_-]/gi, '')}.json`);
  const now = () => Date.now();

  function listConversations() {
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

  /** @param {string} id */
  function loadConversation(id) {
    try { return JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch { return null; }
  }

  /** @param {{id?:string, title?:string, messages:any[]}} conv */
  function saveConversation(conv) {
    const id = conv.id || Math.random().toString(36).slice(2, 10);
    const updatedAt = now();
    const data = { id, title: conv.title || t('conversation'), messages: conv.messages || [], updatedAt };
    try { fs.writeFileSync(file(id), JSON.stringify(data)); return { ok: true, id, updatedAt }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }

  /** @param {string} id */
  function deleteConversation(id) {
    try { fs.unlinkSync(file(id)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e) }; }
  }

  return { listConversations, loadConversation, saveConversation, deleteConversation };
}

module.exports = { createChatStore };
