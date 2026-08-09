// Section « Bibliothèque » de l'accueil Derush, au-dessus des 3 cartes d'action.
// Ne rend RIEN si la bibliothèque est vide : la carte « Importer des vidéos » EST l'état vide, donc
// le premier lancement reste exactement l'écran d'avant. Pas d'état vide inventé.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, Folder } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { useApp } from "@/store";
import { ClipCard } from "./ClipCard";
import { folderPath, itemsToClips } from "./libraryShared";

// Plafond de la bande. Horizontale ET plafonnée par choix : une grille qui wrappe repousserait les
// 3 cartes hors de l'écran dès quelques dizaines de rushs.
const RECENTS = 12;

export function LibraryStrip() {
  const { t } = useTranslation("derush");
  const { items, folders, enterMediaPool, setLibraryFocus } = useApp(
    useShallow((s) => ({
      items: s.libraryItems, folders: s.libraryFolders,
      enterMediaPool: s.enterMediaPool, setLibraryFocus: s.setLibraryFocus,
    })),
  );

  const recents = useMemo(
    () => itemsToClips([...items].sort((a, b) => b.addedAt - a.addedAt).slice(0, RECENTS), folders),
    [items, folders],
  );
  // Une puce par dossier, avec son compte (sous-dossiers inclus : c'est ce qu'on attend d'un compteur
  // de dossier). Les rushs restés à la racine n'ont pas de puce — ils sont dans la bande.
  const chips = useMemo(() => {
    const count = (id: string): number => {
      const kids = folders.filter((f) => f.parentId === id).map((f) => f.id);
      return items.filter((i) => i.folderId === id).length + kids.reduce((n, k) => n + count(k), 0);
    };
    return folders.filter((f) => f.parentId === null).map((f) => ({ id: f.id, name: f.name, path: folderPath(folders, f.id), n: count(f.id) }));
  }, [items, folders]);

  if (!items.length) return null;

  const goTo = (path: string | null) => { setLibraryFocus(path); void enterMediaPool(); };

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{t("library.title")}</h2>
        <span className="text-xs text-muted-foreground">{items.length}</span>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => goTo(null)}>
          {t("library.seeAll")} <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Puces, PAS des cartes : les 3 cartes d'action juste en dessous en sont déjà, et une carte
          dans une carte est toujours une erreur. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {chips.map((c) => (
            <Button key={c.id} variant="outline" size="sm" onClick={() => goTo(c.path)}>
              <Folder className="h-3.5 w-3.5 text-muted-foreground" />
              {c.name}
              <span className="text-xs text-muted-foreground">{c.n}</span>
            </Button>
          ))}
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto pb-1">
        {recents.map((c) => (
          <div key={c.path} className="w-44 shrink-0 [contain-intrinsic-size:auto_120px] [content-visibility:auto]">
            <ClipCard clip={c} />
          </div>
        ))}
      </div>
    </section>
  );
}
