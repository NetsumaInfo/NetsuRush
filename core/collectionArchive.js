// @ts-check
// core/collectionArchive.js
// Archivage d'une collection : export de tous ses plans vers un dossier de stockage, indépendant des
// rushs source. Trois opérations : archiver (produire ce qui manque), changer de dossier (migrer
// l'existant) et, en option, TRAITER les plans au passage (upscale, interpolation, depth map — une
// passe ou deux, comme dans un profil d'export).
//
// L'archivage est RÉPÉTITIF par nature : la synchro automatique le relance à chaque plan rangé. Il ne
// refait donc que le strict nécessaire — `core/archivePlan.js` décide plan par plan entre « déjà là »,
// « recopier depuis ailleurs » et « produire ». Sans ce tri, activer un traitement rendait la synchro
// automatique inutilisable : chaque ajout aurait relancé le GPU sur toute la collection.
//
// Le dossier de stockage n'est PAS figé : `relocate()` déplace les fichiers déjà écrits vers la
// nouvelle cible (rename si même volume, copie + suppression sinon) et ré-exporte depuis la source
// ceux qui manquent (supprimés, disque absent, jamais archivés) ou dont le conteneur a changé en même
// temps que le dossier — la nouvelle cible est donc toujours complète, et l'ancienne ne garde rien de
// ce que NetsuRush y avait écrit.
//
// La vérité des fichiers produits est `archive.entries` : { identité de plan → {file, key} }. Les
// anciennes archives n'ont que `archive.files` (tableau ALIGNÉ sur `shots`), qu'on continue d'écrire
// pour ne rien perdre — mais l'index seul est fragile, supprimer un plan décale tous les suivants.

const fs = require('fs');
const path = require('path');
const { sanitizeName } = require('./utils');
const { t } = require('./i18n');
const { planArchive, shotIdentity, nameAt } = require('./archivePlan');
const { fingerprint, statSource } = require('./upscaleLedger');
const processRun = require('./processRun');

// Registre inerte : sans lui injecté, l'archivage se comporte comme avant (il produit tout).
const NO_LEDGER = {
  fingerprint, statSource,
  describe: () => null,
  lookup: () => null,
  record: () => null,
};

/**
 * Déplace un fichier : rename d'abord (instantané sur le même volume), copie + suppression sinon.
 * Source absente mais destination présente = déjà migré → true. false = rien à migrer.
 * @param {string} src @param {string} dst @returns {boolean}
 */
function moveFile(src, dst) {
  try {
    if (!fs.existsSync(src)) return fs.existsSync(dst);
    if (fs.existsSync(dst)) fs.rmSync(dst, { force: true }); // rename n'écrase pas sous Windows
    try { fs.renameSync(src, dst); }
    catch (_) { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }); }
    return true;
  } catch (_) { return false; }
}

/** Recopie un fichier déjà produit ailleurs. Échec = on retombera sur une vraie production. */
function copyFile(src, dst) {
  try {
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (_) { return false; }
}

/**
 * Supprime les fichiers que NOUS avions écrits dans ce dossier et qui ne correspondent plus à aucun
 * plan. Retirer un plan d'une collection décale toute la numérotation : sans ce ménage, le dossier
 * de stockage garderait un doublon du contenu sous l'ancien numéro. Ne touche QU'aux chemins déjà
 * enregistrés par l'archivage, et seulement dans le dossier visé — jamais un fichier que
 * l'utilisateur aurait déposé là.
 * @param {Record<string, any>} prevEntries @param {(string|null)[]} outs @param {string} dir
 */
function pruneOrphans(prevEntries, outs, dir) {
  const kept = new Set(outs.filter(Boolean).map((f) => path.resolve(String(f)).toLowerCase()));
  const root = path.resolve(dir).toLowerCase();
  let pruned = 0;
  for (const entry of Object.values(prevEntries || {})) {
    const file = entry && entry.file;
    if (!file) continue;
    const abs = path.resolve(file).toLowerCase();
    if (kept.has(abs) || path.dirname(abs) !== root) continue;
    try { fs.rmSync(file, { force: true }); pruned++; } catch (_) { /* fichier verrouillé : on réessaiera */ }
  }
  return pruned;
}

/** Exécute `fn` sur chaque élément avec au plus `limit` en vol. */
async function mapWithLimit(items, limit, fn) {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit | 0), items.length || 1) }, worker));
}

/**
 * @param {{ collectionStore: any, exportMod: any,
 *           detectLang?: (input: string, track: number) => Promise<string|null>,
 *           sidecars?: any, turbo?: any, ledger?: any, encodeGate?: any }} deps
 */
function createCollectionArchive({ collectionStore, exportMod, detectLang, sidecars, turbo, ledger, encodeGate }) {
  const reg = ledger || NO_LEDGER;
  const clipOf = (s) => ({ input: s.path, start: s.in, end: s.out });

  const check = (c, opts) => {
    if (!c) return { ok: false, error: t('collectionMissing') };
    if (!c.shots.length) return { ok: false, error: t('collectionEmpty') };
    if (!opts || !opts.profile) return { ok: false, error: t('exportProfileMissing') };
    return null;
  };

  /**
   * Passes de traitement normalisées, ou null si l'option est éteinte / inexploitable. Ce sont les
   * réglages de NetsuLab tels quels : `core/processRun.js` en dérive moteur, modèle et arguments,
   * pour que l'archivage, l'export et le panneau Traitements produisent le même résultat.
   */
  const normalizeProcess = (p) => (sidecars ? processRun.normalizeProcessSettings(p) : null);

  /**
   * Traiter impose un ré-encodage : la copie de flux ne peut pas changer les pixels.
   *
   * Le traitement porté par le PROFIL d'export est retiré : ici c'est le volet d'archivage qui en
   * décide, et le tri de `archivePlan` (ledger, plans déjà agrandis) ne vaut que pour lui. Le
   * laisser passer traiterait une seconde fois, hors registre, les plans confiés à l'export.
   */
  const effectiveProfile = (profile, proc) =>
    ({ ...profile, process: undefined, ...(proc ? { workflow: 'video_encode' } : null) });

  /** État d'archivage précédent, indexé par identité de plan (avec reprise des archives par index). */
  function readEntries(c) {
    const prev = (c.archive && c.archive.entries) || null;
    if (prev && typeof prev === 'object') return prev;
    const files = (c.archive && Array.isArray(c.archive.files)) ? c.archive.files : [];
    // Migration : sans clé d'empreinte, ces entrées ne feront jamais « déjà à jour » — elles servent
    // seulement à retrouver quel fichier appartient à quel plan lors d'un changement de dossier.
    const out = {};
    c.shots.forEach((shot, i) => { if (files[i]) out[shotIdentity(shot)] = { file: files[i], key: null }; });
    return out;
  }

  const progress = (event, jobId, file, done, total, phase) => {
    if (!event || !event.sender) return;
    event.sender.send('export:progress', {
      jobId, file: path.basename(file || ''), done, total,
      pct: total ? Math.round((done / total) * 100) : 0, phase,
    });
  };

  /**
   * Enregistre l'état d'archivage : `entries` (vérité, par plan) + `files` (aligné, compat).
   * @param {string} id @param {string} dir @param {any} opts
   * @param {any[]} items @param {(string|null)[]} outs
   */
  function commit(id, dir, opts, items, outs) {
    const entries = {};
    for (const it of items) {
      const file = outs[it.index];
      if (file) entries[it.id] = { file, key: it.key, at: Date.now() };
    }
    return collectionStore.markArchived(id, {
      dir, profileId: opts.profile.id, autoSync: !!opts.autoSync, files: outs, entries,
    });
  }

  /**
   * Produit les plans à traiter. Chaque encode passe par le PORTAIL GLOBAL : un archivage lancé
   * pendant un rendu ne double pas le nombre de sessions d'encodage de la machine.
   */
  async function runProcesses(event, items, ctx, onDone) {
    if (!items.length) return;
    const limit = processRun.processConcurrency(ctx.process);
    const slot = encodeGate ? encodeGate.register(limit) : null;
    // Une plage source → un fichier, au nom EXACT attendu par l'archive.
    const job = (item) => processRun.runProcess(event, {
      process: ctx.process, profile: ctx.profile, input: item.shot.path, out: item.file,
      start: item.shot.in, end: item.shot.out, baseName: ctx.base,
    }, { sidecars, turbo });
    try {
      await mapWithLimit(items, limit, async (item) => {
        const r = encodeGate ? await encodeGate.withSlot(() => job(item)) : await job(item);
        onDone(item, r.file, r.file ? null : r.error || t('failed'));
      });
    } finally {
      if (slot) slot.release();
    }
  }

  /**
   * Exporte TOUS les plans de la collection vers son dossier de stockage. Les plans déjà à jour ne
   * sont pas retouchés ; ceux dont le contenu existe ailleurs sont recopiés.
   * @param {any} event @param {string} id
   * @param {{ dir?: string, profile: any, autoSync?: boolean, process?: any }} opts
   */
  async function archive(event, id, opts) {
    const c = collectionStore.loadCollection(id);
    const err = check(c, opts);
    if (err) return err;
    const dir = opts.dir || (c.archive && c.archive.dir);
    if (!dir) return { ok: false, error: t('storageFolderMissing') };
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: String(e) }; }

    const proc = normalizeProcess(opts.process);
    const profile = effectiveProfile(opts.profile, proc);
    const ext = String(profile.container || 'mp4').toLowerCase();
    const base = sanitizeName(c.name || 'export') || 'export';
    const prevEntries = readEntries(c);
    const { items } = planArchive({
      shots: c.shots, dir, base, ext, encode: profile, process: proc, entries: prevEntries, ledger: reg,
    });

    const total = c.shots.length;
    /** @type {(string|null)[]} */
    const outs = new Array(total).fill(null);
    const errors = [];
    let done = 0;
    let skipped = 0;
    let copied = 0;
    const tick = (file, phase) => progress(event, `archive:${id}`, file, ++done, total, phase);

    /** @type {any[]} */
    const renders = [];
    for (const item of items) {
      if (item.action === 'skip') { outs[item.index] = item.file; skipped++; tick(item.file, 'Archive'); continue; }
      if (item.action === 'copy' && copyFile(item.from, item.file)) {
        outs[item.index] = item.file;
        reg.record(item.key, item.file, processRun.upscaleStep(item.process));
        copied++;
        tick(item.file, 'Copy');
        continue;
      }
      renders.push(item); // jamais produit, ou recopie impossible → il faut vraiment l'encoder
    }

    // Plans à traiter d'un côté, plans à simplement découper de l'autre : une source déjà upscalée
    // n'est pas ré-agrandie (cf. archivePlan.processForShot) et repart par l'export normal.
    const toProcess = renders.filter((it) => it.process);
    const toExport = renders.filter((it) => !it.process);

    if (toExport.length) {
      const r = await exportMod.exportClips(event, {
        clips: toExport.map((it) => clipOf(it.shot)), profile,
        savePaths: toExport.map((it) => it.file), merge: false, detectLang,
      });
      const produced = (r && r.outs) || [];
      toExport.forEach((it, k) => {
        if (produced[k]) { outs[it.index] = produced[k]; reg.record(it.key, produced[k], null); }
        else errors.push(t('shotError', { n: it.index + 1, detail: (r && r.error) || t('failed') }));
        tick(it.file, 'Archive');
      });
    }

    await runProcesses(event, toProcess, { profile, process: proc, dir, base }, (item, file, error) => {
      if (file) { outs[item.index] = file; reg.record(item.key, file, processRun.upscaleStep(proc)); }
      else errors.push(t('shotError', { n: item.index + 1, detail: String(error) }));
      tick(item.file, 'Processing');
    });

    const files = outs.filter((f) => f != null);
    const rendered = files.length - skipped - copied;
    if (!files.length) return { ok: false, files: [], skipped, copied, rendered: 0, failed: total, error: errors[0] || t('failed') };
    commit(id, dir, opts, items, outs);
    const pruned = pruneOrphans(prevEntries, outs, dir);
    return { ok: true, files, outs, skipped, copied, rendered, pruned, failed: total - files.length, error: errors[0] };
  }

  /**
   * Change le dossier de stockage : migre l'archive existante vers `dir`, ré-exporte les manquants.
   * @param {any} event @param {string} id
   * @param {{ dir: string, profile: any, autoSync?: boolean, process?: any }} opts
   */
  async function relocate(event, id, opts) {
    const c = collectionStore.loadCollection(id);
    const err = check(c, opts);
    if (err) return err;
    const dir = String((opts && opts.dir) || '');
    if (!dir) return { ok: false, error: t('storageFolderMissing') };
    const prev = c.archive || {};
    const from = prev.dir || '';
    // Jamais archivée, ou même cible → rien à migrer : archivage normal.
    if (!prev.lastAt || !from || path.resolve(from) === path.resolve(dir)) return archive(event, id, { ...opts, dir });
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, error: String(e) }; }

    const proc = normalizeProcess(opts.process);
    const profile = effectiveProfile(opts.profile, proc);
    const ext = String(profile.container || 'mp4').toLowerCase();
    const base = sanitizeName(c.name || 'export') || 'export';
    const entries = readEntries(c);
    const known = Array.isArray(prev.files) ? prev.files : [];
    const total = c.shots.length;
    /** @type {(string|null)[]} */
    const outs = new Array(total).fill(null);
    /** @type {number[]} */
    const missing = [];
    /** @type {Record<string, any>} */
    const moved = {};
    let movedCount = 0;
    let done = 0;

    for (let i = 0; i < total; i++) {
      const id_ = shotIdentity(c.shots[i]);
      const src = (entries[id_] && entries[id_].file) || known[i] || path.join(from, nameAt(base, i, ext));
      const dst = path.join(dir, nameAt(base, i, ext));
      // Conteneur changé en même temps que le dossier → le fichier existant n'est plus au bon format :
      // on le jette et on le ré-exporte plutôt que de migrer un format périmé.
      if (path.extname(src).toLowerCase() !== `.${ext}`) {
        try { fs.rmSync(src, { force: true }); } catch (_) {}
        missing.push(i);
        continue;
      }
      if (moveFile(src, dst)) {
        outs[i] = dst;
        movedCount++;
        // Le fichier a déménagé, son contenu n'a pas changé : le registre doit suivre, sinon la
        // prochaine archive croirait la sortie perdue et la régénérerait.
        const key = entries[id_] && entries[id_].key;
        if (key) { moved[id_] = { file: dst, key, at: Date.now() }; reg.record(key, dst, processRun.upscaleStep(proc)); }
        progress(event, `archive:${id}`, dst, ++done, total, 'Migration');
      } else missing.push(i);
    }

    // Manquants (fichier supprimé, disque absent, plan ajouté hors archivage, format périmé) :
    // UN SEUL appel d'export pour tout le lot, avec la destination imposée par plan (`savePaths`) →
    // le pool parallèle et le portail d'encodage d'exportClips s'appliquent (les encodes GPU partent
    // à plusieurs). Un appel par plan les aurait sérialisés : chacun déclare une limite de 1 au
    // portail, et la limite effective est la PLUS BASSE des jobs en cours.
    let failed = 0;
    if (missing.length) {
      const savePaths = missing.map((i) => path.join(dir, nameAt(base, i, ext)));
      const r = await exportMod.exportClips(event, {
        clips: missing.map((i) => clipOf(c.shots[i])), profile, savePaths, merge: false, detectLang,
      });
      const produced = (r && r.outs) || [];
      missing.forEach((shotIndex, k) => {
        if (produced[k]) outs[shotIndex] = produced[k]; else failed++;
        progress(event, `archive:${id}`, savePaths[k], ++done, total, 'Migration');
      });
    }

    const files = outs.filter((f) => f != null);
    if (!files.length) return { ok: false, files: [], moved: 0, exported: 0, failed, error: t('noFileMigrated') };
    const nextEntries = {};
    c.shots.forEach((shot, i) => {
      const id_ = shotIdentity(shot);
      if (moved[id_]) nextEntries[id_] = moved[id_];
      else if (outs[i]) nextEntries[id_] = { file: outs[i], key: (entries[id_] && entries[id_].key) || null, at: Date.now() };
    });
    collectionStore.markArchived(id, {
      dir, profileId: opts.profile.id, autoSync: !!opts.autoSync, files: outs, entries: nextEntries,
    });
    return { ok: true, files, moved: movedCount, exported: missing.length - failed, failed };
  }

  return { archive, relocate };
}

module.exports = { createCollectionArchive };
