import { useCallback, useEffect, useState } from "react";
import { nr, type CompatibilityStatus } from "@/lib/bridge";

let cached: CompatibilityStatus | null = null;
let inflight: Promise<CompatibilityStatus> | null = null;

export function loadCompatibility(force = false): Promise<CompatibilityStatus> {
  if (!force && cached) return Promise.resolve(cached);
  if (!force && inflight) return inflight;
  inflight = nr.compatibilityStatus({ force }).then((status) => {
    cached = status;
    return status;
  }).finally(() => { inflight = null; });
  return inflight;
}

export function useCompatibility() {
  const [status, setStatus] = useState<CompatibilityStatus | null>(cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    let active = true;
    void loadCompatibility().then((next) => { if (active) setStatus(next); }).catch(() => {}).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadCompatibility(true);
      setStatus(next);
      return next;
    } finally {
      setLoading(false);
    }
  }, []);

  return { status, loading, refresh };
}

// RTX VSR passe par le RTX Video SDK : hors GPU NVIDIA il n'a aucun repli, contrairement aux autres
// modèles déclarés par l'app qui retombent sur le CPU ou sur ONNX et restent donc visibles partout.
export function isModelCompatible(id: string, status: CompatibilityStatus | null) {
  if (id === "rtx_vsr" || id === "rtx-video") return status?.hardware.primaryVendor === "nvidia";
  return true;
}
