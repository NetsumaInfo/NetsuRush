// Import par glisser-déposer depuis l'Explorateur, pour TOUTES les cibles du navigateur de rushs
// (page entière, rangée de dossier). `dragDropEnabled` est à false côté Tauri : les fichiers lâchés
// arrivent en DnD HTML5 ordinaire, jamais en événement Tauri — mais l'objet `File` ne porte pas son
// chemin disque, qui se résout par le pont WebView2 (`nr.pathsForFiles`). Les octets ne sont JAMAIS
// lus : un rush reste où il est, la bibliothèque n'indexe que des chemins.
import { nr } from "@/lib/bridge";
import { useApp } from "@/store";

// Un drag interne (carte de rush, cf. CLIP_DND) ne porte pas de fichiers : il ne doit pas déclencher
// d'import — d'où ce garde, à appeler AUSSI sur dragOver pour ne pas voler le survol aux rangées.
export function hasOsFiles(dt: DataTransfer | null): boolean {
  return !!dt && dt.types.includes("Files");
}

// `folderId` : dossier de bibliothèque d'accueil, null = racine « Importés ».
// Les `File` doivent être lus par l'appelant AVANT tout await (dataTransfer est vidé à la fin de
// l'événement de drop).
export async function importDroppedFiles(files: File[], folderId: string | null = null): Promise<void> {
  if (!files.length) return;
  const paths = (await nr.pathsForFiles(files)).filter(Boolean);
  if (paths.length) { await useApp.getState().importFiles(paths, folderId); return; }
  // WebView2 trop ancien ou pont non attaché : plutôt que d'échouer en silence, on ouvre le
  // sélecteur natif — même destination, même résultat.
  const picked = await nr.chooseMediaFiles();
  if (picked?.length) await useApp.getState().importFiles(picked, folderId);
}
