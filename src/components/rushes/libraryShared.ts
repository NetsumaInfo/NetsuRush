// Helpers PURS de la bibliothèque de rushs (zéro import du store → aucun cycle).
// La bibliothèque persiste des entrées à plat avec un `folderId` ; l'arbre du navigateur, lui, se
// construit à partir de `Clip.bin` (chemin « A/B/C » splité par buildTree dans MediaTree). C'est ici
// qu'on fait le pont entre les deux — d'où des sous-dossiers gratuits sans toucher au type Clip.
import type { Clip, LibraryItem, LibraryFolder } from "@/lib/bridge";

// Nom de la racine de la bibliothèque dans l'arbre. Doit rester synchro avec la clé i18n
// `library.rootName` (l'arbre est bâti sur des chaînes de chemin, pas sur des ids).
export const LIB_ROOT = "Importés";

// Arbre de dossiers d'une liste de clips, bâti sur `Clip.bin` (« A/B/C »). Source UNIQUE du
// regroupement par dossier : le navigateur du Derush (MediaTree) et la liste de NetsuTalk lisent le
// même arbre, donc un rush est rangé au même endroit partout.
export interface ClipTreeNode {
  name: string;
  clips: Clip[];
  children: Map<string, ClipTreeNode>;
}

function walk(root: ClipTreeNode, parts: string[]): ClipTreeNode {
  let cur = root;
  for (const part of parts) {
    let next = cur.children.get(part);
    if (!next) { next = { name: part, clips: [], children: new Map() }; cur.children.set(part, next); }
    cur = next;
  }
  return cur;
}

// `seed` = chemins à faire exister MÊME sans clip dedans. Indispensable pour la bibliothèque : un
// dossier fraîchement créé est vide par définition, et sans nœud il n'apparaîtrait pas — donc
// « Nouveau dossier » semblerait sans effet et le glisser-déposer n'aurait aucune cible. Les bins
// Resolve, eux, n'ont pas ce besoin (ils viennent avec leurs clips).
export function buildClipTree(clips: Clip[], seed: string[] = []): ClipTreeNode {
  const root: ClipTreeNode = { name: "", clips: [], children: new Map() };
  for (const p of seed) walk(root, p.split("/").filter(Boolean));
  for (const c of clips) walk(root, (c.bin || "").split("/").filter(Boolean)).clips.push(c);
  return root;
}

export function countTreeClips(node: ClipTreeNode): number {
  let n = node.clips.length;
  for (const child of node.children.values()) n += countTreeClips(child);
  return n;
}

// Tous les clips d'un nœud et de sa descendance (sélection « tout le dossier »).
export function treeClips(node: ClipTreeNode): Clip[] {
  const out = [...node.clips];
  for (const child of node.children.values()) out.push(...treeClips(child));
  return out;
}

// Chaîne des dossiers ancêtres (racine → feuille). Calque de collectionShared.folderTrail.
export function folderTrail(folders: LibraryFolder[], folderId: string | null): LibraryFolder[] {
  const out: LibraryFolder[] = [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cur = folderId ? byId.get(folderId) : undefined;
  const seen = new Set<string>();
  // `seen` : un folders.json corrompu (cycle de parents) ferait boucler à l'infini sinon.
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

// Chemin d'arbre d'un dossier : « Importés/Anime/OP ». folderId null = la racine seule.
export function folderPath(folders: LibraryFolder[], folderId: string | null): string {
  const trail = folderTrail(folders, folderId).map((f) => f.name);
  return [LIB_ROOT, ...trail].join("/");
}

// Entrées de bibliothèque → Clip[] du derush. `bin` porte le chemin d'arbre, `source:"local"` garde
// la sémantique existante (badge, pas d'envoi timeline direct, etc.).
export function itemsToClips(items: LibraryItem[], folders: LibraryFolder[]): Clip[] {
  return items.map((it) => ({
    name: it.name,
    path: it.path,
    duration: it.duration,
    fps: it.fps,
    resolution: it.resolution,
    format: it.format,
    bin: folderPath(folders, it.folderId),
    source: "local" as const,
  }));
}
