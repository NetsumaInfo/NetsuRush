import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import releases from "@/data/releases.json";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Nouveautés de la version INSTALLÉE, affichées une fois après une mise à jour. La recherche d'une
// version plus récente ne vit PAS ici : elle appartient à `UpdateButton` (cf. le store), présent
// aussi sur les écrans d'installation où ce dialogue n'existe pas.
export function UpdateBootstrap() {
  const { t, i18n } = useTranslation("settings");
  const language = i18n.language.startsWith("fr") ? "fr" : "en";
  const latest = useMemo(() => releases[0], []);
  const [open, setOpen] = useState(() => {
    try { return !!latest && localStorage.getItem("nr.release.seen") !== latest.id; } catch { return false; }
  });

  function close() {
    try { localStorage.setItem("nr.release.seen", latest.id); } catch { /* noop */ }
    setOpen(false);
  }

  if (!latest) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(true); }}>
      {/* Une version chargée peut aligner une dizaine de nouveautés : la fenêtre est plus large, et
          bornée à la hauteur de l'écran avec la LISTE pour seule zone qui défile. En laissant la
          boîte grandir, le bouton finissait sous le bord de la fenêtre — sans issue au clavier non
          plus, puisqu'il n'y a rien d'autre à atteindre. */}
      <DialogContent className="max-h-[calc(100vh-3rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("updates.whatsNew", { version: latest.version })}</DialogTitle>
          <DialogDescription>{latest.title[language]}</DialogDescription>
        </DialogHeader>
        <ul className="min-h-0 list-disc space-y-2 overflow-y-auto pr-1 pl-5 text-sm text-muted-foreground">
          {latest.highlights[language].map((highlight) => <li key={highlight}>{highlight}</li>)}
        </ul>
        <DialogFooter><Button onClick={close}>{t("updates.gotIt")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

