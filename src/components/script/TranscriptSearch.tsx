// Recherche par PAROLES dans les transcriptions EN CACHE
// (voice:searchTranscripts) et attache le plan avec l'in-point AU MOT EXACT. La cadence réelle du
// fichier est lue via nr.playInfo au moment de l'attache (sec → frames fiable, repli 24).

import { useEffect, useState } from "react";
import { nr, type TranscriptHit } from "@/lib/bridge";
import { basename } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { fmtClock, secToFrame } from "./scriptShared";
import { scriptEditorApi } from "./editor/editorApi";
import type { MediaSpec } from "./useScript";

// Marge de sortie après le dernier mot trouvé (le monteur affine dans l'éditeur in/out).
const OUT_PAD_SEC = 1;

// Attache un hit au bloc : fps réel via playInfo (les frames dépendent de la cadence source).
export async function attachTranscriptHit(blockId: string, hit: Pick<TranscriptHit, "file" | "start" | "end">): Promise<void> {
  let fps = 24;
  try {
    const info = await nr.playInfo(hit.file);
    if (info?.fps) fps = info.fps;
  } catch { /* repli 24 — ajustable dans l'éditeur in/out */ }
  const spec: MediaSpec = {
    kind: "video",
    filePath: hit.file,
    label: basename(hit.file),
    fps,
    inFrame: secToFrame(hit.start, fps),
    outFrame: Math.max(secToFrame(hit.start, fps), secToFrame(hit.end + OUT_PAD_SEC, fps) - 1),
  };
  scriptEditorApi.attachMedia(blockId, spec);
}

export function useTranscriptHits(query: string) {
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); setError(null); return; }
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await nr.searchTranscripts({ query: q });
        setHits(r?.hits ?? []);
        setError(r?.ok ? null : r?.error ?? null);
      } catch (e) {
        setHits([]);
        setError(String(e));
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  return { hits, busy, error };
}

// Snippet avec les mots trouvés en surbrillance.
export function HitSnippet({ hit }: { hit: TranscriptHit }) {
  const words = hit.snippet.split(/\s+/);
  return (
    <span className="hit-snippet">
      {words.map((w, i) => (
        <span key={i} className={i >= hit.matchStart && i < hit.matchStart + hit.matchLen ? "hit-match" : ""}>{w} </span>
      ))}
    </span>
  );
}

export function TranscriptHitRow({ hit, onPick, draggable, onDragStart }: {
  hit: TranscriptHit;
  onPick: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <button type="button" className="transcript-hit" onClick={onPick} draggable={draggable} onDragStart={onDragStart}>
          <span className="hit-time">{fmtClock(hit.start)}</span>
          <span className="hit-body">
            <span className="hit-file">{basename(hit.file)}</span>
            <HitSnippet hit={hit} />
          </span>
        </button>
      } />
      <TooltipContent>{hit.file}</TooltipContent>
    </Tooltip>
  );
}
