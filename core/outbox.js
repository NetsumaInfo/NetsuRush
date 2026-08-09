// @ts-check
// « Cache projet » : file d'attente des envois vers le montage différés quand l'hôte (Resolve /
// Premiere / After Effects) est FERMÉ. Motivation : on peut fermer Resolve pour libérer le GPU/RAM
// pendant des encodes lourds, continuer à découper dans NetsuRush, puis — à la réouverture détectée
// par le poll de statut — les envois en file s'appliquent AUTOMATIQUEMENT après un court délai.
//
// Chaque entrée = une opération rejouable (buildTimeline) : chemins source + segments frame-accurate
// (les fichiers sont réimportés au build → survit à la fermeture). Persisté dans NR_HOME (survit à un
// redémarrage de l'app). L'application des entrées est déléguée (apply injecté) — ce module ne connaît
// ni Resolve ni Adobe, il gère la file, les réglages, la persistance et le déclenchement.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { t } = require('./i18n');

const DEFAULT_SETTINGS = {
  enabled: true,       // file active (sinon un envoi hors-ligne échoue comme avant)
  delaySec: 6,         // délai après réouverture avant d'appliquer (laisse Resolve finir d'ouvrir)
  target: 'new',       // 'new' = une timeline par entrée ; 'single' = tout dans UNE timeline collectrice
  targetName: 'NetsuRush — cache', // nom de la timeline collectrice (mode 'single')
  keepDone: 20,        // nb d'entrées terminées conservées en historique
};

function uid() { return crypto.randomBytes(6).toString('hex'); }

function createOutbox({ dataDir, apply, broadcast }) {
  const dir = path.join(dataDir, 'outbox');
  const file = path.join(dir, 'outbox.json');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* best-effort */ }

  /** @type {{ entries: any[], settings: any }} */
  let state = { entries: [], settings: { ...DEFAULT_SETTINGS } };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.entries = Array.isArray(raw.entries) ? raw.entries : [];
    state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  } catch (_) { /* premier lancement */ }

  const flushing = { resolve: false, ppro: false, aeft: false };
  const timers = {};

  function save() {
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file); // rename atomique
    } catch (_) { /* best-effort */ }
  }
  function emit() { try { broadcast && broadcast('outbox:changed', snapshot()); } catch (_) {} }

  function snapshot() {
    return { entries: state.entries.slice().sort((a, b) => b.ts - a.ts), settings: state.settings };
  }
  function pendingCount(host) {
    return state.entries.filter((e) => e.status === 'pending' && (!host || e.host === host)).length;
  }

  function enqueue(entry) {
    const e = {
      id: uid(),
      ts: Date.now(),
      host: entry.host || 'resolve',
      kind: entry.kind || 'buildTimeline',
      label: String(entry.label || t('send')),
      opts: entry.opts || {},
      status: 'pending',
    };
    state.entries.push(e);
    trimDone();
    save();
    emit();
    return { ok: true, id: e.id, pending: pendingCount(e.host) };
  }

  function trimDone() {
    const done = state.entries.filter((e) => e.status !== 'pending').sort((a, b) => b.ts - a.ts);
    const keep = new Set(done.slice(0, state.settings.keepDone || 20).map((e) => e.id));
    state.entries = state.entries.filter((e) => e.status === 'pending' || keep.has(e.id));
  }

  function remove(id) {
    state.entries = state.entries.filter((e) => e.id !== id);
    save(); emit();
    return { ok: true };
  }
  function clear(which) {
    // which: 'all' | 'done' | 'pending'
    if (which === 'done') state.entries = state.entries.filter((e) => e.status === 'pending');
    else if (which === 'pending') state.entries = state.entries.filter((e) => e.status !== 'pending');
    else state.entries = [];
    save(); emit();
    return { ok: true };
  }

  function getSettings() { return state.settings; }
  function setSettings(patch) {
    state.settings = { ...state.settings, ...(patch || {}) };
    save(); emit();
    return { ok: true, settings: state.settings };
  }

  // Applique les entrées EN ATTENTE d'un hôte. mode 'single' → première 'new' (timeline collectrice),
  // suivantes 'append' ; mode 'new' → chaque entrée sa propre timeline. Résultats marqués done/error.
  async function flush(host = 'resolve') {
    if (flushing[host]) return { ok: false, error: t('flushRunning') };
    const pending = state.entries.filter((e) => e.status === 'pending' && e.host === host).sort((a, b) => a.ts - b.ts);
    if (!pending.length) return { ok: true, applied: 0 };
    flushing[host] = true;
    let applied = 0, failed = 0;
    try {
      const single = state.settings.target === 'single';
      for (let i = 0; i < pending.length; i++) {
        const e = pending[i];
        const opts = { ...e.opts };
        if (single) { opts.mode = i === 0 ? 'new' : 'append'; opts.name = state.settings.targetName || 'NetsuRush — cache'; }
        else if (!opts.mode) opts.mode = 'new';
        try {
          const r = await apply({ ...e, opts });
          if (r && r.ok) { e.status = 'done'; e.result = r.timeline || null; e.appliedAt = Date.now(); applied++; }
          else { e.status = 'error'; e.error = (r && r.error) || t('failed'); e.appliedAt = Date.now(); failed++; }
        } catch (err) {
          e.status = 'error'; e.error = String(err); e.appliedAt = Date.now(); failed++;
        }
        emit();
      }
      trimDone(); save(); emit();
      return { ok: true, applied, failed };
    } finally {
      flushing[host] = false;
    }
  }

  // Appelé par le watch quand un hôte repasse EN LIGNE : planifie un flush après le délai réglé (si
  // activé et s'il y a des entrées en attente). Débounce : un seul timer par hôte.
  function onHostOnline(host = 'resolve') {
    if (!state.settings.enabled || !pendingCount(host)) return;
    if (timers[host]) clearTimeout(timers[host]);
    const t = setTimeout(() => { timers[host] = null; void flush(host); }, Math.max(0, (state.settings.delaySec || 0) * 1000));
    if (t.unref) t.unref();
    timers[host] = t;
  }

  return { enqueue, remove, clear, list: snapshot, getSettings, setSettings, flush, onHostOnline, pendingCount };
}

module.exports = { createOutbox };
