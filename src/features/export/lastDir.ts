// Dernier dossier de sortie choisi à l'export. Le dialogue s'y rouvre : un montage sort ses plans
// par vagues, et repartir de la racine du disque à chaque clic est une navigation à refaire pour
// rien. Simple valeur locale à la machine — rien à synchroniser, rien à sauvegarder dans un projet.

const STORAGE_KEY = "nr.export.lastDir";

export function lastExportDir(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberExportDir(dir: string): void {
  if (!dir || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, dir);
  } catch { /* stockage plein ou refusé : le dialogue rouvrira à son emplacement par défaut */ }
}
