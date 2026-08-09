import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// Bouton flottant « remonter en haut » : localise l'ancêtre scrollable (le <main> de l'app),
// apparaît après `threshold` px de scroll, remonte en douceur. CSS pur — aucune anim JS
// (interdit perf sur les grilles), listener passif.
export function ScrollTopButton({ threshold = 600 }: { threshold?: number }) {
  const { t } = useTranslation("shell");
  const anchorRef = useRef<HTMLSpanElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let el: HTMLElement | null = anchorRef.current?.parentElement ?? null;
    while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement;
    if (!el) return;
    const sc = el;
    scrollerRef.current = sc;
    const onScroll = () => setVisible(sc.scrollTop > threshold);
    onScroll();
    sc.addEventListener("scroll", onScroll, { passive: true });
    return () => sc.removeEventListener("scroll", onScroll);
  }, [threshold]);

  return (
    <>
      <span ref={anchorRef} className="hidden" />
      {visible && (
        <Tooltip>
          <TooltipTrigger render={<button
            type="button"
            aria-label={t("scrollTop")}
            onClick={() => scrollerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            className="fixed bottom-6 right-6 z-40 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-card/90 text-muted-foreground shadow-lg backdrop-blur transition-colors hover:bg-accent hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary animate-in fade-in-0 zoom-in-98 duration-200" />}>
            <ArrowUp className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>{t("scrollTop")}</TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
