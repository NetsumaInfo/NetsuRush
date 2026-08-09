// @ts-check
// core/archiveQueue.js
// File d'attente des archivages, pour DIFFÉRER les gros travaux.
//
// Archiver avec upscale prend le GPU pour des minutes par plan. Lancé au moment où l'on range un
// rush — c'est-à-dire pendant qu'on travaille — ça ralentit tout : lecture des aperçus, détection de
// plans, et le montage dans Resolve/Premiere. La file permet de dire « oui, mais pas maintenant » :
// l'entrée attend que la machine soit au repos (aucun encodage en vol) avant de partir.
//
// Un seul archivage à la fois, quoi qu'il arrive : deux collections upscalées en parallèle se
// disputeraient la VRAM et finiraient plus lentement qu'en série. Persisté dans NR_HOME → fermer
// l'app ne perd pas le travail annoncé (même principe que core/outbox.js).

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Rythme d'observation de la machine quand une entrée attend le repos. Assez lent pour ne rien
// coûter, assez rapide pour partir dans la minute qui suit la fin d'un rendu.
const POLL_MS = 20_000;
// Entrées terminées gardées en historique (l'utilisateur doit pouvoir lire ce qui s'est passé).
const KEEP_DONE = 20;

const uid = () => crypto.randomBytes(6).toString('hex');

/**
 * @param {object} deps
 * @param {string} deps.dataDir
 * @param {(collId: string, opts: any) => Promise<any>} deps.runArchive  archivage réel d'une collection
 * @param {(channel: string, payload: any) => void} [deps.broadcast]
 * @param {() => boolean} [deps.isIdle]  machine au repos ? (aucun encodage en vol)
 */
function createArchiveQueue({ dataDir, runArchive, broadcast, isIdle }) {
  const file = path.join(dataDir, 'archive-queue.json');
  const idle = isIdle || (() => true);

  /** @type {{ entries: any[] }} */
  let state = { entries: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Une entrée « en cours » au chargement vient d'un core tué en plein travail : elle repart en
    // attente, sinon la file resterait bloquée sur un job qui n'existe plus.
    state.entries = (Array.isArray(raw.entries) ? raw.entries : [])
      .map((e) => (e.status === 'running' ? { ...e, status: 'pending' } : e));
  } catch (_) { /* premier lancement */ }

  let running = false;
  /** @type {NodeJS.Timeout|null} */
  let timer = null;

  function save() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (_) { /* best-effort */ }
  }

  function snapshot() {
    return { entries: state.entries.slice(), running };
  }
  function emit() {
    save();
    try { if (broadcast) broadcast('collections:queue', snapshot()); } catch (_) { /* SSE facultatif */ }
  }

  /** Ne garde que les N dernières entrées terminées (les en-attente restent toutes). */
  function trimHistory() {
    const finished = state.entries.filter((e) => e.status === 'done' || e.status === 'error');
    if (finished.length <= KEEP_DONE) return;
    const drop = new Set(finished.slice(0, finished.length - KEEP_DONE).map((e) => e.id));
    state.entries = state.entries.filter((e) => !drop.has(e.id));
  }

  /**
   * Met une collection en file. Une collection déjà en attente n'est pas empilée deux fois : la
   * demande la plus récente met simplement l'entrée à jour (archiver deux fois de suite le même
   * dossier ne produirait rien la seconde fois, mais réserverait le GPU pour rien).
   * @param {string} collId
   * @param {{ name?: string, mode?: 'now'|'idle', opts?: any }} [req]
   */
  function enqueue(collId, req) {
    if (!collId) return { ok: false, error: 'collection manquante' };
    const mode = (req && req.mode) === 'idle' ? 'idle' : 'now';
    const existing = state.entries.find((e) => e.collId === collId && e.status === 'pending');
    if (existing) {
      existing.mode = mode;
      existing.name = (req && req.name) || existing.name;
      existing.opts = (req && req.opts) || existing.opts;
      emit();
      pump();
      return { ok: true, id: existing.id, queued: true };
    }
    const entry = {
      id: uid(), collId, name: (req && req.name) || '', mode,
      opts: (req && req.opts) || null, status: 'pending', at: Date.now(),
    };
    state.entries.push(entry);
    trimHistory();
    emit();
    pump();
    return { ok: true, id: entry.id, queued: true };
  }

  /** Retire une entrée en attente. Une entrée en cours n'est pas interrompue (l'encode l'est par ffmpeg). */
  function cancel(entryId) {
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => !(e.id === entryId && e.status === 'pending'));
    if (state.entries.length === before) return { ok: false, error: 'entrée introuvable ou déjà lancée' };
    emit();
    return { ok: true };
  }

  function scheduleRetry() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; pump(); }, POLL_MS);
    if (timer.unref) timer.unref();
  }

  /** Fait avancer la file : au plus un archivage en vol, l'attente du repos ne bloque pas les urgents. */
  async function pump() {
    if (running) return;
    const next = state.entries.find((e) => e.status === 'pending' && (e.mode === 'now' || idle()));
    if (!next) {
      if (state.entries.some((e) => e.status === 'pending')) scheduleRetry();
      return;
    }
    running = true;
    next.status = 'running';
    next.startedAt = Date.now();
    emit();
    let result;
    try {
      result = await runArchive(next.collId, next.opts || {});
    } catch (e) {
      result = { ok: false, error: String((e && e.message) || e) };
    }
    next.status = result && result.ok ? 'done' : 'error';
    next.endedAt = Date.now();
    next.error = result && result.ok ? undefined : (result && result.error) || 'échec';
    next.result = result && result.ok
      ? { skipped: result.skipped || 0, copied: result.copied || 0, rendered: result.rendered || 0, failed: result.failed || 0 }
      : undefined;
    running = false;
    trimHistory();
    emit();
    pump();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  // Une file restaurée au démarrage doit repartir seule, sinon relancer l'app perdrait le travail annoncé.
  if (state.entries.some((e) => e.status === 'pending')) scheduleRetry();

  return { enqueue, cancel, state: snapshot, stop, pump };
}

module.exports = { createArchiveQueue, POLL_MS, KEEP_DONE };
