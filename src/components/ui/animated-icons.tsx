import {
  motion,
  useAnimationControls,
  type Transition,
  type Variants,
} from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Icônes animées façon gradienty.codes (Lucide + Motion).
 *
 * Deux niveaux :
 *  1. `MotionIcon` — pop spring au survol pour n'importe quelle icône lucide
 *     (micro-feedback léger). Le zoom global au survol/clic vit déjà en CSS
 *     (index.css) ; ceci sert quand on veut un effet ciblé plus marqué.
 *  2. Icônes DÉDIÉES (RefreshIcon, PlayIcon, DownloadIcon, CheckIcon, …) —
 *     vraie animation path-level qui se JOUE au clic (one-shot) et au survol,
 *     pas un simple zoom. Drop-in : remplacent l'icône lucide correspondante.
 *
 * Règle projet (CLAUDE.md) : OK sur le chrome (boutons, barres, lecteur).
 * JAMAIS sur les grilles de cartes vidéo (concurrence le décodage).
 */

const SPRING: Transition = { type: "spring", stiffness: 320, damping: 18 };
const EASE: Transition = { duration: 0.5, ease: [0.22, 1, 0.36, 1] };

/* ─── base SVG : attrs lucide communs + déclencheurs hover/clic ─────────────
   `play(target)` lance une animation one-shot au pointerdown. Le wrapper gère
   survol (`whileHover`) et tap. Les enfants sont des <motion.path/> etc. avec
   leurs propres `variants` { rest, hover, tap }. */

type IconBaseProps = {
  size?: number;
  className?: string;
  children: ReactNode;
};

const SvgBase = forwardRef<
  SVGSVGElement,
  Omit<ComponentPropsWithoutRef<typeof motion.svg>, "children"> & IconBaseProps
>(({ size = 16, className, children, ...rest }, ref) => (
  <motion.svg
    ref={ref}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    initial="rest"
    animate="rest"
    whileHover="hover"
    style={{ transformOrigin: "center", ...(rest.style as object) }}
    className={cn(className)}
    {...rest}
  >
    {children}
  </motion.svg>
));
SvgBase.displayName = "SvgBase";

/* ─── MotionIcon : pop spring générique ────────────────────────────────────*/

type MotionIconProps = {
  icon: LucideIcon;
  effect?: "pop" | "wiggle" | "spin" | "lift";
  size?: number;
  className?: string;
} & Omit<ComponentPropsWithoutRef<"svg">, "ref">;

const EFFECTS: Record<NonNullable<MotionIconProps["effect"]>, Variants> = {
  pop: { rest: { scale: 1 }, hover: { scale: 1.18 } },
  wiggle: { rest: { rotate: 0 }, hover: { rotate: [0, -12, 10, -6, 0] } },
  spin: { rest: { rotate: 0 }, hover: { rotate: 90 } },
  lift: { rest: { y: 0 }, hover: { y: -2, scale: 1.1 } },
};

export const MotionIcon = forwardRef<SVGSVGElement, MotionIconProps>(
  ({ icon: Icon, effect = "pop", size = 16, className, ...props }, ref) => (
    <motion.span
      className="inline-flex"
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap={{ scale: 0.9 }}
    >
      <motion.span variants={EFFECTS[effect]} transition={SPRING}>
        <Icon ref={ref as never} size={size} className={className} {...props} />
      </motion.span>
    </motion.span>
  )
);
MotionIcon.displayName = "MotionIcon";

/* ─── RefreshIcon : tour complet au clic, boucle si `spinning` ──────────────*/

export function RefreshIcon({
  size = 16,
  className,
  spinning = false,
}: {
  size?: number;
  className?: string;
  spinning?: boolean;
}) {
  const controls = useAnimationControls();
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ transformOrigin: "center" }}
      animate={
        spinning
          ? { rotate: 360, transition: { repeat: Infinity, duration: 0.9, ease: "linear" } }
          : controls
      }
      whileHover={spinning ? undefined : { rotate: -30 }}
      transition={SPRING}
      onPointerDown={() => {
        if (spinning) return;
        controls.set({ rotate: 0 });
        controls.start({ rotate: 360, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } });
      }}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </motion.svg>
  );
}

/* ─── PlayIcon / PauseIcon : impulsion au clic ─────────────────────────────*/

export function PlayIcon({ size = 16, className }: { size?: number; className?: string }) {
  const controls = useAnimationControls();
  return (
    <SvgBase
      size={size}
      className={className}
      fill="currentColor"
      stroke="none"
      animate={controls}
      onPointerDown={() => {
        controls.set({ scale: 1, x: 0 });
        controls.start({ scale: [1, 0.8, 1.12, 1], x: [0, -1, 1, 0], transition: { duration: 0.4 } });
      }}
    >
      <motion.polygon points="6 3 20 12 6 21 6 3" variants={{ rest: { scale: 1 }, hover: { scale: 1.12 } }} transition={SPRING} />
    </SvgBase>
  );
}

export function PauseIcon({ size = 16, className }: { size?: number; className?: string }) {
  const controls = useAnimationControls();
  return (
    <SvgBase
      size={size}
      className={className}
      fill="currentColor"
      stroke="none"
      animate={controls}
      onPointerDown={() => {
        controls.set({ scaleY: 1 });
        controls.start({ scaleY: [1, 0.78, 1], transition: { duration: 0.32 } });
      }}
    >
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </SvgBase>
  );
}

/* ─── DownloadIcon : la flèche plonge au clic ──────────────────────────────*/

export function DownloadIcon({ size = 16, className }: { size?: number; className?: string }) {
  const controls = useAnimationControls();
  return (
    <SvgBase
      size={size}
      className={className}
      onPointerDown={() => {
        controls.set({ y: 0 });
        controls.start({ y: [0, 3.5, 0], transition: { duration: 0.45, ease: [0.5, 0, 0.5, 1] } });
      }}
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <motion.g animate={controls} variants={{ rest: { y: 0 }, hover: { y: 1.5 } }} transition={SPRING}>
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" x2="12" y1="15" y2="3" />
      </motion.g>
    </SvgBase>
  );
}

/* ─── CheckIcon : tracé du coche au clic ───────────────────────────────────*/

export function CheckIcon({ size = 16, className }: { size?: number; className?: string }) {
  const controls = useAnimationControls();
  return (
    <SvgBase
      size={size}
      className={className}
      onPointerDown={() => {
        controls.set({ pathLength: 0, opacity: 0.4 });
        controls.start({ pathLength: 1, opacity: 1, transition: { duration: 0.4, ease: "easeOut" } });
      }}
    >
      <motion.path d="M20 6 9 17l-5-5" animate={controls} variants={{ rest: { pathLength: 1, opacity: 1 }, hover: { pathLength: [1, 0, 1] } }} transition={{ duration: 0.5 }} />
    </SvgBase>
  );
}

/* ─── CloseIcon : rotation de la croix au clic ─────────────────────────────*/

export function CloseIcon({ size = 16, className }: { size?: number; className?: string }) {
  const controls = useAnimationControls();
  return (
    <SvgBase
      size={size}
      className={className}
      animate={controls}
      whileHover={{ rotate: 90 }}
      transition={SPRING}
      onPointerDown={() => {
        controls.start({ rotate: [0, 90, 180], transition: { duration: 0.35 } }).then(() => controls.set({ rotate: 0 }));
      }}
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </SvgBase>
  );
}

/* ─── ScissorsIcon : les lames se referment au clic ────────────────────────*/

export function ScissorsIcon({ size = 16, className }: { size?: number; className?: string }) {
  const controls = useAnimationControls();
  return (
    <SvgBase
      size={size}
      className={className}
      onPointerDown={() => {
        controls.start({ rotate: [0, -14, 0], transition: { duration: 0.4 } });
      }}
    >
      <line x1="20" x2="8.12" y1="4" y2="15.88" />
      <line x1="14.47" x2="20" y1="14.48" y2="20" />
      <line x1="8.12" x2="12" y1="8.12" y2="12" />
      {/* lame + anneau du haut : pivot autour du croisement (≈ 8,12 / 12) */}
      <motion.g animate={controls} style={{ transformOrigin: "8.12px 12px" }} variants={{ rest: { rotate: 0 }, hover: { rotate: -10 } }} transition={SPRING}>
        <circle cx="6" cy="6" r="3" />
      </motion.g>
      <circle cx="6" cy="18" r="3" />
    </SvgBase>
  );
}

/* ─── PlusIcon : quart de tour au clic ─────────────────────────────────────*/

export function PlusIcon({ size = 16, className }: { size?: number; className?: string }) {
  const controls = useAnimationControls();
  return (
    <SvgBase
      size={size}
      className={className}
      animate={controls}
      whileHover={{ rotate: 90, scale: 1.1 }}
      transition={SPRING}
      onPointerDown={() => {
        controls.start({ rotate: [0, 90, 180], scale: [1, 0.85, 1], transition: { duration: 0.4 } }).then(() => controls.set({ rotate: 0 }));
      }}
    >
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </SvgBase>
  );
}

/* ─── SearchIcon : loupe qui scanne ; boucle si `loading` ──────────────────*/

const LOADING_T: Transition = { duration: 1.1, repeat: Infinity, ease: "easeInOut" };

export function SearchIcon({
  loading = false,
  size = 16,
  className,
}: {
  loading?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      initial="rest"
      animate={loading ? "loading" : "rest"}
      whileHover={loading ? undefined : "hover"}
    >
      <motion.circle
        cx="11"
        cy="11"
        r="8"
        style={{ transformOrigin: "11px 11px" }}
        variants={{
          rest: { scale: 1, opacity: 1 },
          hover: { scale: [1, 0.9, 1] },
          loading: { scale: [1, 0.82, 1], opacity: [1, 0.6, 1] },
        }}
        transition={loading ? LOADING_T : EASE}
      />
      <motion.path
        d="m21 21-4.3-4.3"
        variants={{
          rest: { x: 0, y: 0 },
          hover: { x: [0, 1.5, 0], y: [0, 1.5, 0] },
          loading: { x: [0, 1.5, 0], y: [0, 1.5, 0] },
        }}
        transition={loading ? LOADING_T : EASE}
      />
    </motion.svg>
  );
}
