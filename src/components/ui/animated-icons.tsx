import {
  motion,
  useAnimationControls,
  type Transition,
} from "framer-motion";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Icônes animées façon gradienty.codes (Lucide + Motion).
 *
 * Icônes DÉDIÉES (RefreshIcon, PlayIcon, PauseIcon, SearchIcon) :
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
