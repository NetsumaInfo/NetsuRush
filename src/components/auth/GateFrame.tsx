import type { ReactNode } from "react";
import { BrandIcon } from "@/components/BrandIcon";
import { BetaBadge } from "@/components/BetaBadge";
import { WindowControls } from "@/components/WindowControls";
import { TooltipProvider } from "@/components/ui/tooltip";

// Cadre des écrans de gate (login / accès) : barre de titre draggable + contrôles fenêtre
// (réduire/agrandir/fermer/épingler). La fenêtre est frameless → sans ça, impossible de la
// déplacer ou fermer tant que le Shell n'est pas rendu.
export function GateFrame({ children, contentClassName = "max-w-sm" }: { children: ReactNode; contentClassName?: string }) {
  return (
    <TooltipProvider delay={600}>
      <div className="flex h-screen flex-col overflow-hidden">
        <header
          data-tauri-drag-region
          className="relative flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3 select-none"
        >
          <BrandIcon className="size-6" />
          <span className="text-xs font-semibold tracking-tight">NetsuRush</span>
          <BetaBadge />
          <WindowControls />
        </header>
        <div className="flex flex-1 items-center justify-center overflow-auto bg-background p-8">
          <div className={`w-full ${contentClassName}`}>{children}</div>
        </div>
      </div>
    </TooltipProvider>
  );
}
