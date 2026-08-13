import { memo, useEffect, useRef, useState } from "react";
import { Film } from "lucide-react";
import { nr } from "@/lib/bridge";
import { getThumb, setThumb as cacheThumb } from "@/lib/thumbCache";
import { cn, thumbTime, THUMB_AUTO } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { observeViewport } from "@/lib/viewportObserver";

// Vignette LAZY partagée (Découpe de timeline + éditeur de coupes) : chargée seulement quand elle
// approche l'écran (observateur de viewport PARTAGÉ, un par marge et non un par vignette) puis mise
// en cache par chemin+temps (resservie sync au remontage). `at` = seconde de la frame à extraire.
// `rootMargin` est en PIXELS. Repli icône film si pas de source ou échec ffmpeg.
export const LazyThumb = memo(function LazyThumb({
  path, at = 0, out, className, rootMargin = 900,
}: { path?: string | null; at?: number; out?: number; className?: string; rootMargin?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const time = at === THUMB_AUTO ? THUMB_AUTO : thumbTime(at, out);
  const [src, setSrc] = useState<string | null>(() => (path ? getThumb(path, time) : null));
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeViewport(el, rootMargin, setNear);
  }, [rootMargin]);

  useEffect(() => {
    if (!near || !path || src) return;
    const cached = getThumb(path, time);
    if (cached) { setSrc(cached); return; }
    let alive = true;
    nr.thumbnail(path, time)
      .then((r) => { if (alive && typeof r === "string") { const u = nr.assetUrl(r); cacheThumb(path, u, time); setSrc(u); } })
      .catch(() => {});
    return () => { alive = false; };
  }, [near, path, src, time]);

  return (
    <div ref={ref} className={cn("relative overflow-hidden bg-muted", className)}>
      {src ? (
        <img src={src} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
      ) : path ? (
        <Skeleton className="absolute inset-0 rounded-none" />
      ) : (
        <span className="absolute left-1/2 top-1/2 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg bg-primary/12 text-primary"><Film className="size-4" /></span>
      )}
    </div>
  );
});
