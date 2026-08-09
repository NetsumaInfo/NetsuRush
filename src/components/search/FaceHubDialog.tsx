import { useTranslation } from "react-i18next";
import { Users, ScanFace, LayoutGrid } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "@/store";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GalleryPanel } from "@/components/search/hub/GalleryPanel";
import { RosterPanel } from "@/components/search/hub/RosterPanel";

// Hub Visages : grande fenêtre (quasi plein écran) à onglets — « Détectés » (galerie des visages
// indexés) + « Personnages » (roster nommé). Barre d'actions propre à chaque onglet, en haut.
export function FaceHubDialog() {
  const { t } = useTranslation("search");
  const { faceHubOpen, faceHubTab, closeFaceHub, setFaceHubTab } = useApp(useShallow((s) => ({
    faceHubOpen: s.faceHubOpen, faceHubTab: s.faceHubTab, closeFaceHub: s.closeFaceHub, setFaceHubTab: s.setFaceHubTab,
  })));

  return (
    <Dialog open={faceHubOpen} onOpenChange={(o) => { if (!o) closeFaceHub(); }}>
      {/* sm:max-w-[95vw] surcharge le sm:max-w-md du composant Dialog (même variante = tailwind-merge garde la nôtre) */}
      <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-4 sm:max-w-[95vw]">
        <div className="flex items-center gap-3 pr-8">
          <ScanFace className="h-5 w-5 text-primary" />
          <DialogTitle className="text-base">{t("faceHubDialog.title")}</DialogTitle>
          <Tabs value={faceHubTab} onValueChange={(v) => setFaceHubTab(v as "gallery" | "roster")}>
            <TabsList className="h-8">
              <TabsTrigger value="gallery"><LayoutGrid /> {t("faceHubDialog.detected")}</TabsTrigger>
              <TabsTrigger value="roster"><Users /> {t("faceHubDialog.characters")}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="min-h-0 flex-1">
          {faceHubTab === "gallery" ? <GalleryPanel /> : <RosterPanel />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
