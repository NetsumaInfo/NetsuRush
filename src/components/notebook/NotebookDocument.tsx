// Document ouvert : en-tête (couverture/icône/titre) + éditeur + rétroliens.
//
// Extrait du panneau pour ISOLER l'abonnement à `nbPage` : l'éditeur pousse ses blocs au store à
// chaque frappe, donc `nbPage` change à chaque touche. Tant que le panneau entier s'y abonnait, une
// frappe re-rendait la sidebar et l'arbre de pages ; ici, seul ce composant re-rend.
import { useApp } from "@/store";
import { PageHeader } from "./PageHeader";
import { NoteEditor } from "./NoteEditor";
import { Backlinks } from "./Backlinks";
import { PAGE_WIDTH_CLASS } from "./notebookPrefs";

export function NotebookDocument() {
  const page = useApp((s) => s.nbPage);
  const pageWidth = useApp((s) => s.nbPrefs.pageWidth);
  const fontScale = useApp((s) => s.nbPrefs.fontScale);
  if (!page) return null;
  return (
    <div
      className={`nb-doc px-16 pt-4 pb-24 ${PAGE_WIDTH_CLASS[pageWidth]}`}
      style={{ ["--nb-font-scale" as string]: fontScale }}
    >
      <PageHeader page={page} />
      <NoteEditor key={page.id} page={page} />
      <Backlinks />
    </div>
  );
}
