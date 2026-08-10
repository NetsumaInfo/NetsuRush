// Vignette d'une scène pour l'écran d'accueil : mini-plan spatial des items, rendu à la volée.
// Lecture SEULE via nr.reference.loadScene (ne touche pas le store du board). Tous les items
// visuels sont posés en % d'une bbox commune (avec marge) → reflète la disposition du board.

import { memo, useEffect, useState } from "react";
import { Film } from "lucide-react";
import { nr } from "@/lib/bridge";
import { type BoardItem, displaySrc, youtubeId } from "./referenceShared";

const MAX_ITEMS = 40;

function ytThumb(ref: string): string | null {
  const id = /^[\w-]{11}$/.test(ref) ? ref : youtubeId(ref);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

function normalizeItems(items: unknown[]): BoardItem[] {
  return (items as BoardItem[])
    .filter((it) => it.w > 0 && it.h > 0)
    .sort((a, b) => a.z - b.z)
    .slice(0, MAX_ITEMS);
}

function BoardThumb({ items }: { items: BoardItem[] | null }) {
  const [videoThumbs, setVideoThumbs] = useState<Record<string, string>>({});

  useEffect(() => {
    setVideoThumbs({});
    if (!items) return undefined;
    let alive = true;
    // Vignettes des vidéos locales (chemin disque) — milieu du clip, cache du process principal.
    for (const it of items) {
      if (it.kind !== "video" || /^(https?:|blob:)/i.test(it.ref)) continue;
      void nr.thumbnail(it.ref).then((r) => {
        if (alive && typeof r === "string") setVideoThumbs((m) => ({ ...m, [it.id]: nr.mediaUrl(r) }));
      });
    }
    return () => { alive = false; };
  }, [items]);

  if (!items || items.length === 0) {
    return (
      <div className="flex size-full items-center justify-center text-muted-foreground">
        <Film className="size-6 opacity-30" />
      </div>
    );
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x); minY = Math.min(minY, it.y);
    maxX = Math.max(maxX, it.x + it.w); maxY = Math.max(maxY, it.y + it.h);
  }
  // Marge autour du contenu → les items « flottent » sur la carte (look mood-board).
  const pad = Math.max(maxX - minX, maxY - minY) * 0.08;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);

  return (
    <div className="flex size-full items-center justify-center p-1">
      <div
        className="relative max-h-full max-w-full"
        style={{ aspectRatio: `${bw} / ${bh}`, width: bw >= bh ? "100%" : "auto", height: bh > bw ? "100%" : "auto" }}
      >
        {items.map((it) => {
          const style: React.CSSProperties = {
            left: `${((it.x - minX) / bw) * 100}%`,
            top: `${((it.y - minY) / bh) * 100}%`,
            width: `${(it.w / bw) * 100}%`,
            height: `${(it.h / bh) * 100}%`,
            opacity: it.opacity ?? 1,
            transform: it.rotation ? `rotate(${it.rotation}deg)` : undefined,
          };

          if (it.kind === "frame") {
            return <div key={it.id} className="absolute rounded-[3px] border border-dashed border-[var(--color-ok)]/50" style={style} />;
          }
          if (it.kind === "text") {
            return (
              <div
                key={it.id}
                className="absolute rounded-[2px]"
                style={{ ...style, backgroundColor: it.bg && it.bg !== "transparent" ? it.bg : "rgba(255,255,255,.08)" }}
              />
            );
          }
          const src =
            it.kind === "youtube" ? ytThumb(it.ref)
            : it.kind === "embed" ? null
            : it.kind === "video" ? (videoThumbs[it.id] ?? null)
            : (it.src || displaySrc(it.kind, it.ref));
          if (!src) {
            return (
              <div key={it.id} className="absolute flex items-center justify-center rounded-[2px] bg-black/40 ring-1 ring-black/30" style={style}>
                <Film className="size-3 text-white/40" />
              </div>
            );
          }
          return (
            <img
              key={it.id}
              src={src}
              alt=""
              loading="lazy"
              draggable={false}
              className="absolute rounded-[2px] object-cover shadow-sm ring-1 ring-black/40"
              style={style}
            />
          );
        })}
      </div>
    </div>
  );
}

function SceneThumbInner({ id }: { id: string }) {
  const [items, setItems] = useState<BoardItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    void nr.reference?.loadScene(id).then((scene) => {
      if (alive) setItems(normalizeItems(scene?.items ?? []));
    });
    return () => { alive = false; };
  }, [id]);
  return <BoardThumb items={items} />;
}

function ProjectThumbInner({ path }: { path: string }) {
  const [items, setItems] = useState<BoardItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    void nr.reference?.previewProject(path).then((result) => {
      if (alive) setItems(normalizeItems(result?.scene?.items ?? []));
    });
    return () => { alive = false; };
  }, [path]);
  return <BoardThumb items={items} />;
}

export const SceneThumb = memo(SceneThumbInner);
export const ProjectThumb = memo(ProjectThumbInner);
