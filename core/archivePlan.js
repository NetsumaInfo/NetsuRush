// @ts-check
// core/archivePlan.js
// Décide, plan par plan, ce que l'archivage doit FAIRE : rien, copier, ou produire.
//
// Couche de DÉCISION pure (aucun encodage, aucune écriture) : elle ne fait que comparer des
// empreintes et l'existence de fichiers. C'est elle qui garantit qu'un plan n'est jamais produit
// deux fois — un upscale coûte des minutes de GPU, et l'archivage automatique repasse sur toute la
// collection à chaque ajout.
//
// Trois issues par plan :
//   `skip`   — le fichier attendu est déjà là, à jour, au bon endroit ;
//   `copy`   — le même contenu existe ailleurs (autre dossier, autre collection) → recopie ;
//   `render` — il faut vraiment produire le fichier.

const path = require('node:path');
const fs = require('node:fs');

/** Nom déterministe du fichier d'un plan dans le dossier de stockage. */
const nameAt = (base, i, ext) => `${base}_${String(i + 1).padStart(3, '0')}.${ext}`;

const normPath = (p) => path.resolve(String(p || '')).toLowerCase();
const sameFile = (a, b) => normPath(a) === normPath(b);

/**
 * Identité stable d'un plan dans l'archive. `shot.id` est la vérité (les plans rangés en ont un) ;
 * le repli source+entrée couvre les collections d'avant ce suivi. Surtout PAS l'index : supprimer un
 * plan décalerait tous les suivants et l'archive croirait devoir tout refaire.
 * @param {any} shot
 */
function shotIdentity(shot) {
  if (shot && shot.id) return String(shot.id);
  return `${normPath(shot && shot.path)}|${Math.round(Number((shot && shot.in) || 0) * 1000)}`;
}

/**
 * Upscale à appliquer à CE plan. Une source qui est elle-même une sortie d'upscale NetsuRush, à une
 * échelle au moins égale, n'est pas ré-agrandie : on n'y gagnerait aucun détail, on paierait la
 * génération une seconde fois et on empilerait les artefacts du premier passage.
 * @param {any} upscale @param {any} shot @param {any} ledger
 */
function upscaleForShot(upscale, shot, ledger) {
  if (!upscale || !upscale.enabled) return null;
  const already = ledger.describe(shot.path);
  if (already && Number(already.scale || 0) >= Number(upscale.scale || 0)) return null;
  return upscale;
}

/**
 * @param {object} args
 * @param {any[]} args.shots            plans de la collection, dans l'ordre
 * @param {string} args.dir             dossier de stockage visé
 * @param {string} args.base            base du nom de fichier (nom de la collection assaini)
 * @param {string} args.ext             extension du conteneur
 * @param {any} args.encode             réglages d'encodage effectifs (profil d'archive)
 * @param {any} args.upscale            réglages d'upscale ({enabled, engine, model, scale, denoise})
 * @param {Record<string, any>} args.entries  état d'archivage précédent, par identité de plan
 * @param {any} args.ledger             registre des sorties déjà produites
 * @param {(p: string) => boolean} [args.exists]
 */
function planArchive({ shots, dir, base, ext, encode, upscale, entries, ledger, exists = fs.existsSync }) {
  const prev = entries || {};
  const items = shots.map((shot, index) => {
    const id = shotIdentity(shot);
    const out = path.join(dir, nameAt(base, index, ext));
    const effUpscale = upscaleForShot(upscale, shot, ledger);
    const stat = ledger.statSource(shot.path);
    const key = ledger.fingerprint({
      src: shot.path, mtimeMs: stat.mtimeMs, size: stat.size,
      in: shot.in, out: shot.out, encode, upscale: effUpscale,
    });
    /** @type {{ shot: any, index: number, id: string, out: string, key: string, upscale: any, from: string|null }} */
    const base_ = { shot, index, id, out, key, upscale: effUpscale, from: null };

    // 1. Ce plan a déjà été archivé avec ces réglages exacts, et son fichier est toujours là.
    const known = prev[id];
    if (known && known.key === key && known.file && exists(known.file)) {
      return sameFile(known.file, out)
        ? { ...base_, action: 'skip', file: known.file }
        : { ...base_, action: 'copy', file: out, from: known.file };
    }

    // 2. Le même contenu a déjà été produit ailleurs (autre collection, ancien dossier) : recopier
    //    coûte une lecture disque, le régénérer coûte le GPU.
    const hit = ledger.lookup(key);
    if (hit && hit.file) {
      if (sameFile(hit.file, out) && exists(out)) return { ...base_, action: 'skip', file: out };
      return { ...base_, action: 'copy', file: out, from: hit.file };
    }

    return { ...base_, action: 'render', file: out };
  });

  const counts = { skip: 0, copy: 0, render: 0 };
  for (const it of items) counts[it.action]++;
  return { items, counts };
}

module.exports = { planArchive, shotIdentity, upscaleForShot, nameAt };
