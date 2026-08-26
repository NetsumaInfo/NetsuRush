// Voyant d'export, en PASTILLE. Monté une seule fois (cf. App) : il suit l'état d'export du store et
// le rend dans la colonne du coin bas-droit, avec les autres pastilles.
//
// Ce voyant vivait AU BAS de chaque panneau — une barre de progression sous le bouton, une ligne
// « ça exporte », une ligne d'erreur, répétées dans le Découpage, Timeline Live et Collections. Trois
// copies à tenir, et un retour qui apparaissait là où l'on ne regarde pas (le panneau peut même être
// fermé). Ici, un seul endroit affiche « ça travaille », au même endroit que le message de fin.
import { useEffect, useRef } from "react";
import { useApp } from "@/store";
import { toast, type TaskToast } from "@/components/ui/toast";

export function ExportStatusToast() {
  const busy = useApp((s) => s.exportBusy);
  const progress = useApp((s) => s.exportProgress);
  const error = useApp((s) => s.exportError);
  const setExportError = useApp((s) => s.setExportError);
  const taskRef = useRef<TaskToast | null>(null);

  // Une SEULE pastille pour tout l'export en cours : elle naît au premier libellé, suit les phases
  // (extraction, fusion, montage) et disparaît à la fin. Le message de réussite est poussé par le flux
  // lui-même — la pastille de tâche n'a pas à deviner ce qu'il faut annoncer.
  useEffect(() => {
    if (busy) {
      if (taskRef.current) taskRef.current.update(busy, progress);
      else taskRef.current = toast.task(busy, progress);
      return;
    }
    taskRef.current?.close();
    taskRef.current = null;
  }, [busy, progress]);

  // Démontage (fermeture de fenêtre, changement d'onglet dans le panneau CEP) : pas de pastille
  // orpheline sans rien pour la mettre à jour.
  useEffect(() => () => { taskRef.current?.close(); taskRef.current = null; }, []);

  // L'erreur d'export est un ÉVÉNEMENT : elle est annoncée puis levée du store. La laisser en place
  // la ferait ré-annoncer à chaque remontage de la vue.
  useEffect(() => {
    if (!error) return;
    toast.error(error);
    setExportError(null);
  }, [error, setExportError]);

  return null;
}
