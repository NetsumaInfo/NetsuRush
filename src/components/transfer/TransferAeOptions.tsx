// Options avancées du couple Resolve → After Effects. Le hook d'export AE vit ICI et non dans la
// page : monté seulement quand ce couple est choisi, il n'interroge Resolve que dans ce cas.
import { useEffect } from "react";
import { useAeExport } from "@/components/ae/useAeExport";
import { AeOptionsForm } from "@/components/ae/AeOptionsForm";
import type { AeExportOpts } from "@/lib/bridge";

export function TransferAeOptions({ onChange }: { onChange: (opts: AeExportOpts) => void }) {
  const ae = useAeExport();
  // La timeline source est choisie par NetsuBridge : le core la réinjecte au moment de lancer.
  useEffect(() => { onChange(ae.options); }, [ae.options, onChange]);
  return <AeOptionsForm ae={ae} hideTimeline />;
}
