import { cn } from "@/lib/utils";

// Une touche affichée (badge clavier).
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd className={cn("rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground", className)}>
      {children}
    </kbd>
  );
}

// Un combo canonique (« Ctrl+Shift+Z ») rendu en badges séparés par des « + ».
export function ComboKeys({ combo }: { combo: string }) {
  return (
    <>
      {(combo || "—").split("+").map((part, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-[10px] text-muted-foreground">+</span>}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </>
  );
}
