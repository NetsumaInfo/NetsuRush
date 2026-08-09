// Vignette d'un fichier à un instant donné, avec cache + retry. nr.thumbnail peut renvoyer {error}
// sous charge (file ffmpeg pleine au 1er chargement) → on re-tente quelques fois au lieu d'abandonner
// (sinon la case reste noire à vie). Sert le CHEMIN cache (à passer à nr.mediaUrl).

import { useEffect, useState } from "react";
import { nr } from "@/lib/bridge";
import { getThumb, setThumb } from "@/lib/thumbCache";

export function useThumb(filePath: string, time = 0.05): string | null {
  const [url, setUrl] = useState<string | null>(() => (filePath ? getThumb(filePath, time) : null));
  useEffect(() => {
    if (url || !filePath) return;
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      void nr.thumbnail(filePath, time).then((r) => {
        if (!alive) return;
        if (typeof r === "string") { setThumb(filePath, r, time); setUrl(r); }
        else if (tries++ < 8) timer = setTimeout(attempt, 1500); // {error} transitoire → re-tente
      }).catch(() => { if (alive && tries++ < 8) timer = setTimeout(attempt, 1500); });
    };
    attempt();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [filePath, time, url]);
  return url;
}
