// @ts-check
// core/netsu/project.js
// Le .netsu comme DOCUMENT DE TRAVAIL : « Enregistrer sous », puis Ctrl+S dans ce fichier-là.
//
// Différence avec core/netsu/board.js#writeBoardDoc, qui reste la voie du PARTAGE : celui-ci fabrique
// un fichier autonome, écrit d'un bloc, médias réencodés dedans. Un projet ne veut ni de l'un ni de
// l'autre — il veut un fichier qu'on réenregistre cent fois par séance :
//
//   1. Écriture INCRÉMENTALE. Une ligne par item (cf. core/netsu/schema.js) : déplacer une note
//      touche une ligne. Le comparatif se fait sur le JSON de l'item, donc un board de mille items
//      dont un seul a bougé écrit un seul UPDATE. Sans ça, chaque enregistrement réécrirait tout.
//   2. AUCUN réencodage. `writeBoardDoc` appelle embedItem, qui lance ffmpeg par média — quelques
//      dizaines de secondes par Ctrl+S sur un board fourni. Ici les rushs restent où ils sont,
//      désignés par leur identité de contenu (`ref:`), et l'identité déjà connue n'est pas
//      recalculée (cache de session).
//   3. Ce qui n'a pas de place à soi va dans le dossier COMPAGNON (core/netsu/sidecar.js) : image
//      collée, média récupéré d'un lien. Chemin relatif ⇒ le projet se déplace avec ses médias. Ce
//      dossier s'ouvre dans l'explorateur : il est rangé par type, une séquence par dossier, et
//      chaque fichier porte le nom de son item. C'est d'ici que viennent ces noms — le module
//      sidecar ne sait rien du board.
//
// Les liens durables (page web, YouTube) restent des LIENS : les figer produirait un fichier lourd
// pour recopier ce qui se retélécharge tout seul. Le figeage reste une option du partage.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { t } = require('../i18n');
const sidecar = require('./sidecar');
const blobs = require('./blobs');
const { describeSource, recordMedia } = require('./embed');
const { readBoardDoc, stripTransient, isRemoteRef, DOC_TYPE, MEDIA_KINDS } = require('./board');

/**
 * Identité de contenu d'un média local, sans la recalculer si on la connaît déjà. Le cache de
 * session évite de relire les premiers Mo de chaque rush à chaque enregistrement ; la table `media`
 * évite de le faire une deuxième fois après un redémarrage. Taille ET date doivent concorder — un
 * fichier réencodé sur place garde son chemin mais n'est plus le même média.
 * @param {any} session @param {string} absPath @param {{ size: number, mtime: number }} stat
 * @returns {string|null}
 */
function knownMediaId(session, absPath, stat) {
  const key = absPath.toLowerCase();
  const cached = session.mediaIds.get(key);
  if (cached && cached.size === stat.size && cached.mtime === stat.mtime) return cached.id;

  const row = session.handle.db.prepare('SELECT id, size, mtime FROM media WHERE path = ?').get(absPath);
  if (!row || Number(row.size) !== stat.size || Number(row.mtime) !== stat.mtime) return null;
  session.mediaIds.set(key, { id: String(row.id), size: stat.size, mtime: stat.mtime });
  return String(row.id);
}

/** @param {string} absPath @returns {{ size: number, mtime: number }|null} */
function statOf(absPath) {
  try {
    const stat = fs.statSync(absPath);
    return stat.isFile() ? { size: stat.size, mtime: Math.round(stat.mtimeMs) } : null;
  } catch (_) {
    return null; // média déplacé ou disque absent → placeholder relocalisable, jamais un échec global
  }
}

/**
 * Range un média auprès du fichier et rend son token. Le rangement (dossier, nom lisible) est décidé
 * par core/netsu/sidecar.js à partir de `place` ; l'index de session lui évite de recopier ou de
 * déplacer un contenu déjà en place.
 */
async function adoptInto(ctx, absPath, place) {
  const adopted = await sidecar.adoptAsync(ctx.netsuPath, absPath, { place, index: ctx.index });
  if (!adopted.ok || !adopted.token || !adopted.relative) return null;
  ctx.keep.add(adopted.relative);
  return adopted;
}

/**
 * Une référence de média → le token qui l'écrira dans le projet.
 * `place` porte de quoi NOMMER le fichier rangé : titre de l'item, dossier de séquence, rang de la
 * frame. Sans lui le dossier compagnon redeviendrait une liste d'empreintes.
 * @param {any} ctx @param {string} rawRef @param {string} kindHint
 * @param {{ title?: string, group?: string, index?: number }} [place]
 * @returns {Promise<{ token: string, adopted?: boolean, referenced?: boolean,
 *                     missing?: { name: string, size: number, kind: string,
 *                       locator?: string, frameLocators?: (string|null)[] } }>}
 */
async function tokenizeProjectRef(ctx, rawRef, kindHint, place) {
  const ref = String(rawRef || '');
  if (!ref) return { token: '' };
  // Lien distant, image en ligne, données inline : rien à ranger, le token EST la référence.
  if (isRemoteRef(ref)) return { token: ref };
  const spot = { ...(place || {}), kind: kindHint };

  if (sidecar.isSidecarToken(ref)) {
    // Déjà un token. On le repasse par l'adoption : c'est ce qui range les projets écrits avant que
    // le dossier compagnon n'ait des sous-dossiers, sans recopier un seul octet (le fichier est
    // DÉPLACÉ). Introuvable, le token est gardé tel quel plutôt que remplacé par un item mort.
    const abs = sidecar.resolveSidecar(ctx.netsuPath, ref);
    const adopted = abs && statOf(abs) ? await adoptInto(ctx, abs, spot) : null;
    if (adopted) return { token: adopted.token, adopted: true };
    ctx.keep.add(ref.slice(sidecar.TOKEN.length).split('/').join(path.sep));
    return {
      token: ref,
      adopted: true,
      missing: { name: path.basename(ref.slice(sidecar.TOKEN.length)), size: 0, kind: kindHint, locator: ref },
    };
  }

  const abs = path.resolve(ref);
  const stat = statOf(abs);
  if (!stat) {
    return { token: '', missing: { name: path.basename(abs), size: 0, kind: kindHint } };
  }

  // Média déjà dans le dossier compagnon (projet rouvert), asset POSSÉDÉ par l'app (image collée,
  // média récupéré d'un lien), ou média du dossier compagnon d'un AUTRE projet (« Enregistrer
  // sous… ») : sa place est auprès de CE fichier, pas dans un magasin global ni chez le voisin.
  if (sidecar.isInAnySidecar(abs) || ctx.refStore.isAppAsset(abs)) {
    const adopted = await adoptInto(ctx, abs, spot);
    if (adopted) return { token: adopted.token, adopted: true };
    return { token: '', missing: { name: path.basename(abs), size: stat.size, kind: kindHint } };
  }

  // Rush de l'utilisateur : il reste chez lui. On n'enregistre que son identité, pour le retrouver
  // même s'il a bougé entre deux séances.
  const known = knownMediaId(ctx.session, abs, stat);
  if (known) return { token: `ref:${known}`, referenced: true };

  const source = await describeSource(abs);
  if (!source.ok) return { token: '', missing: { name: path.basename(abs), size: stat.size, kind: kindHint } };
  const id = ctx.session.handle.tx((db) => recordMedia(db, source)).result;
  ctx.session.mediaIds.set(abs.toLowerCase(), { id, size: stat.size, mtime: stat.mtime });
  return { token: `ref:${id}`, referenced: true };
}

/**
 * Nom du dossier d'une séquence : son titre, rendu unique. Deux séquences homonymes mélangeraient
 * leurs frames dans un même dossier — et le ménage de l'une emporterait les frames de l'autre.
 * @param {any} ctx @param {any} item @returns {string}
 */
function sequenceGroup(ctx, item) {
  const id = String(item.id || '');
  const known = ctx.groups.get(id);
  if (known) return known;

  const base = sidecar.slugify(item.title || 'sequence');
  let name = base;
  for (let n = 2; ctx.groupNames.has(name); n += 1) name = `${base}-${n}`;
  ctx.groupNames.add(name);
  ctx.groups.set(id, name);
  return name;
}

/**
 * Le média d'AVANT (upscale annulable) est un média du projet à part entière : il est rangé et
 * gardé comme les autres. Sans ça, son fichier n'entrait dans aucun `keep` et le ménage de fin
 * d'enregistrement l'effaçait — le bouton « revenir en arrière » restait affiché en pointant sur
 * un fichier que l'app venait elle-même de supprimer.
 * @param {any} ctx @param {any} item
 */
async function tokenizeProjectPrev(ctx, item) {
  const prev = item.prevMedia;
  if (!prev || typeof prev !== 'object') return;
  const ref = String(prev.ref || '');
  if (!ref) return;
  const out = await tokenizeProjectRef(ctx, ref, String(prev.kind || item.kind || ''), {
    title: `${item.title || 'media'}-original`,
  });
  // Le `src` d'affichage est recalculé au chargement : le garder figerait une URL de service morte.
  if (out.token) item.prevMedia = { ...prev, ref: out.token, src: '' };
  else if (prev.sourceUrl) item.prevMedia = { sourceUrl: prev.sourceUrl };
  else delete item.prevMedia;
}

/** Un item de la scène, prêt à être écrit : tokens posés, champs transitoires retirés. */
async function tokenizeProjectItem(ctx, raw) {
  const item = stripTransient(raw);
  await tokenizeProjectPrev(ctx, item);
  const kind = String(item.kind || '');
  if (!MEDIA_KINDS.has(kind)) return { item, unresolved: false };

  if (kind === 'sequence') {
    const group = sequenceGroup(ctx, item);
    const tokens = [];
    const frames = Array.isArray(item.frames) ? item.frames : [];
    const retained = item.missing && Array.isArray(item.missing.frameLocators)
      ? item.missing.frameLocators
      : [];
    const frameLocators = [];
    let unresolved = 0;
    for (let i = 0; i < frames.length; i += 1) {
      const durableFrame = frames[i] || retained[i] || '';
      const out = await tokenizeProjectRef(ctx, durableFrame, 'image', { group, index: i });
      tokens.push(out.token);
      if (out.missing) {
        unresolved += 1;
        frameLocators.push(out.missing.locator || durableFrame || null);
      } else {
        frameLocators.push(null);
      }
    }
    item.frames = tokens;
    item.ref = tokens.find(Boolean) || '';
    if (unresolved) {
      item.missing = {
        name: `Séquence — ${unresolved}/${tokens.length} image(s) manquante(s)`,
        size: Number(item.missing && item.missing.size) || 0,
        kind: 'sequence',
        frameLocators,
      };
    } else {
      delete item.missing;
    }
    return { item, unresolved: unresolved > 0 };
  }

  const durableRef = item.ref || (item.missing && item.missing.locator) || '';
  const out = await tokenizeProjectRef(ctx, durableRef, kind, { title: item.title });
  item.ref = out.token;
  if (out.missing) item.missing = out.missing;
  else delete item.missing;
  return { item, unresolved: !!out.missing };
}

/**
 * Met à l'abri du ménage les médias que le board garde sous le coude : historique d'annulation,
 * fichier mémorisé derrière un embed. Ce sont des chemins ou des tokens déjà rangés — on ne les
 * adopte pas (rien à recopier), on empêche seulement de les effacer.
 * @param {any} ctx @param {unknown} retain
 */
function retainHistory(ctx, retain) {
  if (!Array.isArray(retain)) return;
  const dir = sidecar.sidecarDirFor(ctx.netsuPath);
  for (const entry of retain) {
    const value = String(entry || '');
    if (!value) continue;
    const abs = sidecar.isSidecarToken(value)
      ? sidecar.resolveSidecar(ctx.netsuPath, value)
      : path.resolve(value);
    if (!abs || !sidecar.isInSidecar(ctx.netsuPath, abs)) continue; // hors du dossier : rien à protéger
    ctx.keep.add(path.relative(dir, abs));
  }
}

/** Le document board du conteneur, créé au premier enregistrement. */
function ensureDoc(session, title, view) {
  const existing = session.handle.db
    .prepare('SELECT id FROM docs WHERE type = ? ORDER BY is_primary DESC LIMIT 1')
    .get(DOC_TYPE);
  const docId = existing ? String(existing.id) : crypto.randomUUID();
  session.handle.tx((db) => {
    db.prepare(
      `INSERT INTO docs (id, type, title, is_primary, data, updated_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, data = excluded.data, updated_at = excluded.updated_at`,
    ).run(docId, DOC_TYPE, String(title || ''), JSON.stringify({ view: view || null }), Date.now());
  });
  return docId;
}

/**
 * Écrit les items modifiés et retire ceux qui ont disparu. Le compteur `changed` est ce qui rend
 * l'opération vérifiable : un enregistrement qui ne change rien doit écrire zéro ligne.
 * @returns {{ changed: number, removed: number }}
 */
function commitItems(session, docId, prepared) {
  // Le cache de session porte le dernier JSON écrit : tant qu'il est chaud, un enregistrement ne
  // relit rien. Il n'est reconstruit qu'après une ouverture (ou un changement de document).
  const stored = session.itemJson.get(docId) || new Map(
    session.handle.db
      .prepare('SELECT id, data FROM board_items WHERE doc_id = ?')
      .all(docId)
      .map((row) => [String(row.id), String(row.data)]),
  );
  session.itemJson.set(docId, stored);

  const now = Date.now();
  let changed = 0;
  const seen = new Set();
  for (const { id, json, z } of prepared) {
    seen.add(id);
    if (stored.get(id) === json) continue;
    session.handle.tx((db) => {
      db.prepare(
        `INSERT INTO board_items (doc_id, id, data, z, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(doc_id, id) DO UPDATE SET data = excluded.data, z = excluded.z, updated_at = excluded.updated_at`,
      ).run(docId, id, json, z, now);
    });
    stored.set(id, json);
    changed += 1;
  }

  const gone = [...stored.keys()].filter((id) => !seen.has(id));
  if (gone.length) {
    session.handle.tx((db) => {
      for (const id of gone) {
        db.prepare('DELETE FROM board_items WHERE doc_id = ? AND id = ?').run(docId, id);
        db.prepare('DELETE FROM item_media WHERE doc_id = ? AND item_id = ?').run(docId, id);
      }
    });
    for (const id of gone) stored.delete(id);
  }
  return { changed, removed: gone.length };
}

/**
 * Retire ce que plus aucun item ne réclame — sinon un projet ne fait que grossir.
 *
 * Trois magasins à tenir, et un seul arbitre : les tokens des items.
 *   `media`   → la fiche d'un rush resté chez l'utilisateur ;
 *   `blobs`   → des octets DANS le fichier. Un projet n'en fabrique pas : il n'en hérite que d'un
 *               partage ouvert puis enregistré, dont les médias viennent d'être recopiés dans le
 *               dossier compagnon. Les garder ferait payer deux fois le même plan, pour toujours ;
 *   compagnon → les fichiers rangés à côté (cf. core/netsu/sidecar.js).
 * @returns {{ removed: number, bytes: number, blobs: number, blobBytes: number }}
 */
function sweepUnused(session, docId, keep, keepMediaIds, keepShas) {
  const rows = session.handle.db.prepare('SELECT id FROM media').all();
  const orphans = rows.map((r) => String(r.id)).filter((id) => !keepMediaIds.has(id));
  if (orphans.length) {
    session.handle.tx((db) => {
      for (const id of orphans) db.prepare('DELETE FROM media WHERE id = ?').run(id);
    });
  }
  // Les lignes d'embarquement d'un partage précédent décrivent des octets qu'on s'apprête à rendre :
  // les laisser derrière ferait pointer le document sur des blobs supprimés.
  const stale = session.handle.db
    .prepare('SELECT item_id, poster_sha, clip_sha FROM item_media WHERE doc_id = ?')
    .all(docId)
    .filter((row) => ![row.poster_sha, row.clip_sha].filter(Boolean).every((sha) => keepShas.has(String(sha))));
  if (stale.length) {
    session.handle.tx((db) => {
      for (const row of stale) {
        db.prepare('DELETE FROM item_media WHERE doc_id = ? AND item_id = ?').run(docId, String(row.item_id));
      }
    });
  }
  const freedBlobs = blobs.sweepBlobs(session.handle, keepShas);
  const swept = sidecar.sweep(session.path, keep);
  return { ...swept, blobs: freedBlobs.removed, blobBytes: freedBlobs.bytes };
}

/**
 * Enregistre la scène dans le document ouvert. C'est l'opération de Ctrl+S.
 * @param {{ session: any, refStore: any, scene: any }} args
 */
async function saveBoardProject({ session, refStore, scene }) {
  if (!scene || !Array.isArray(scene.items)) return { ok: false, error: t('sceneInvalid') };

  const ctx = {
    session,
    refStore,
    netsuPath: session.path,
    // Ce que le dossier compagnon doit garder, en chemins RELATIFS : c'est la liste du ménage final.
    keep: new Set(),
    // État du dossier avant l'enregistrement : évite de recopier, et déplace ce qui n'est pas rangé.
    index: sidecar.indexSidecar(session.path),
    /** @type {Map<string, string>} id d'item ⇒ dossier de séquence */
    groups: new Map(),
    /** @type {Set<string>} dossiers de séquence déjà attribués */
    groupNames: new Set(),
  };
  const prepared = [];
  const keepMediaIds = new Set();
  const keepShas = new Set();
  let missing = 0;
  let unresolved = 0;
  let adopted = 0;

  for (const raw of scene.items) {
    const preparedItem = await tokenizeProjectItem(ctx, raw);
    const item = preparedItem.item;
    if (preparedItem.unresolved) unresolved += 1;
    if (item.missing) missing += 1;
    const refs = item.kind === 'sequence' ? item.frames || [] : [item.ref];
    if (item.prevMedia && item.prevMedia.ref) refs.push(item.prevMedia.ref);
    for (const token of refs) {
      const value = String(token || '');
      if (value.startsWith('ref:')) keepMediaIds.add(value.slice(4));
      else if (value.startsWith('asset:')) keepShas.add(value.slice(6));
      else if (sidecar.isSidecarToken(value)) adopted += 1;
    }
    prepared.push({
      id: String(item.id || crypto.randomUUID()),
      json: JSON.stringify(item),
      z: Number(item.z) || 0,
    });
  }

  // Ce que le board peut encore réclamer sans que le fichier le sache : les médias retenus par
  // l'historique d'annulation. Supprimer une image lance un autosave une demi-seconde plus tard ;
  // sans cette liste, le ménage emporte ses octets et le Ctrl+Z d'après rend un item vide.
  retainHistory(ctx, scene.retain);

  const docId = ensureDoc(session, scene.name, scene.view);
  const { changed, removed } = commitItems(session, docId, prepared);
  // Un enregistrement qui vide le document d'un coup est presque toujours un board pas encore
  // chargé, pas une suppression voulue : les lignes partent (elles se réécrivent), mais les OCTETS
  // du dossier compagnon restent. Le ménage se fera au prochain enregistrement non vide.
  const unsafeSweep = unresolved > 0 || (prepared.length === 0 && removed > 0);
  const swept = unsafeSweep
    ? { removed: 0, bytes: 0, blobs: 0, blobBytes: 0 }
    : sweepUnused(session, docId, ctx.keep, keepMediaIds, keepShas);

  return {
    ok: true,
    path: session.path,
    rev: session.handle.rev(),
    docId,
    counts: {
      items: prepared.length, changed, removed, adopted, missing, unresolved,
      freed: swept.bytes + swept.blobBytes, freedBlobs: swept.blobs,
    },
    bytes: fs.existsSync(session.path) ? fs.statSync(session.path).size : 0,
  };
}

/** Lit le board d'un document ouvert. Même forme que l'import : le renderer ne voit qu'une scène. */
function readBoardProject({ session, refStore }) {
  return readBoardDoc({ handle: session.handle, refStore });
}

module.exports = { saveBoardProject, readBoardProject, tokenizeProjectRef };
