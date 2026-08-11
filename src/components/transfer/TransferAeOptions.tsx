// Options avancées du couple Resolve → After Effects. Le hook d'export AE vit ICI et non dans la
// page : monté seulement quand ce couple est choisi, il n'interroge Resolve que dans ce cas.
import { useEffect } from "react";
import { useAeExport } from "@/components/ae/useAeExport";
import { AeOptionsForm } from "@/components/ae/AeOptionsForm";
import type { AeExportOpts } from "@/lib/bridge";

// La timeline source ET le nom de la composition sont choisis par NetsuBridge : le core réinjecte
// la timeline au lancement, et la destination de la page EST le nom de la comp. Les redemander ici
// posait deux fois la même question, avec deux réponses possibles.
export function TransferAeOptions({ onChange }: { onChange: (opts: AeExportOpts) => void }) {
  const ae = useAeExport();
  useEffect(() => { onChange(ae.options); }, [ae.options, onChange]);
  return <AeOptionsForm ae={ae} hideTimeline hideCompName />;
}
