// @ts-check
// core/collectionSharing.js
// What a shared collection actually sends: its ARCHIVE.
//
// Sharing and archiving asked the same thing of the machine — turn every shot of a collection into a
// standalone file that no longer depends on the source rush. Doing both meant encoding everything
// twice, with two sets of settings, and left the shared copies in a hidden folder nobody could point
// at. So sharing does not encode anything of its own any more: it runs the collection's archive
// (`core/collectionArchive.js`), which produces only what is missing, and publishes the files it
// wrote. Turning sharing on therefore turns archiving on — the app says so, and this is why.
//
// Consequence worth knowing: peers receive the collection in the format its owner archives in. The
// archive settings are the sharing settings, there is no second, quieter profile behind them.

const fs = require('fs');
const path = require('path');
const { shotIdentity } = require('./archivePlan');

/** A shot that came from someone else's contribution: it is already published, never re-published. */
const isRemote = (shot) => String((shot && shot.id) || '').startsWith('ci_');

/**
 * @param {{ collectionStore: any, collectionArchive: any }} deps
 */
function createCollectionSharing({ collectionStore, collectionArchive }) {
  /** @type {Map<string, Promise<any>>} */
  const pending = new Map();

  /**
   * Archives the collection, then names the file that carries each shot.
   * @param {any} event @param {string} id
   * @param {{ dir?: string, profile: any, autoSync?: boolean, process?: any }} opts
   */
  async function prepare(event, id, opts) {
    // Ranging a shot into a shared collection publishes it, and a range can land while the previous
    // one is still encoding. One archive at a time per collection: two would fight over the files.
    const active = pending.get(id);
    if (active) return active;
    const job = run(event, id, opts).catch((error) => ({ ok: false, error: String(error) }));
    pending.set(id, job);
    try { return await job; } finally { pending.delete(id); }
  }

  async function run(event, id, opts) {
    const collection = collectionStore.loadCollection(id);
    if (!collection) return { ok: false, error: 'Collection not found' };
    if (!opts || !opts.profile) return { ok: false, error: 'Sharing needs the collection archive settings' };
    if (!['video_encode', 'video_remux'].includes(opts.profile.workflow)) return { ok: false, error: 'Sharing requires re-encode or remux' };
    const dir = opts.dir || (collection.archive && collection.archive.dir);
    if (!dir) return { ok: false, error: 'Sharing needs the collection archive folder' };
    if (!collection.shots.some((shot) => !isRemote(shot))) return { ok: true, prepared: [] };

    const archived = await collectionArchive.archive(event, id, {
      dir, profile: opts.profile, autoSync: opts.autoSync, process: opts.process,
    });
    if (!archived || !archived.ok) return { ok: false, error: (archived && archived.error) || 'Archiving failed' };

    // The archive rewrote the collection (its `entries` map is the truth about which file holds
    // which shot), so read it back rather than trusting the copy captured before the encode.
    const latest = collectionStore.loadCollection(id);
    if (!latest) return { ok: false, error: 'Collection removed during preparation' };
    const entries = (latest.archive && latest.archive.entries) || {};
    const prepared = [];
    for (const shot of latest.shots) {
      if (isRemote(shot)) continue;
      const entry = entries[shotIdentity(shot)];
      const file = entry && entry.file;
      if (!file) return { ok: false, error: `Not archived: ${shot.name}` };
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || !stat.isFile() || stat.size === 0) return { ok: false, error: `Archived file is missing: ${shot.name}` };
      // The archive always writes its own files; a settings mistake that made one resolve to the
      // source rush would share the whole untrimmed video instead of the shot.
      if (path.resolve(file).toLowerCase() === path.resolve(shot.path).toLowerCase()) {
        return { ok: false, error: 'Source cannot be shared directly' };
      }
      prepared.push({ shotId: shot.id, path: file, name: shot.name, duration: shot.out - shot.in });
    }
    // Native import grants read this local allowlist, never the source shots. Keep it in sync with
    // the archive pipeline before the renderer asks native code to import any prepared file.
    const current = collectionStore.loadCollection(id);
    if (!current) return { ok: false, error: 'Collection removed during preparation' };
    const saved = collectionStore.saveCollection({ id, name: current.name, collaboration: {
      ...current.collaboration, preparedPaths: prepared.map((item) => item.path),
    } });
    if (!saved.ok) return { ok: false, error: saved.error || 'Could not authorize archived media' };
    return { ok: true, prepared };
  }

  return { prepare };
}

module.exports = { createCollectionSharing };
