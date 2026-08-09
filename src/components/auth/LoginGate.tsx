import { useEffect, useState, type ReactNode } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/convexApi";
import { convexConfigured } from "@/lib/convexEnv";
import { stampAuth, offlineGraceValid } from "@/lib/offlineAuth";
import { authWasSkipped, persistAuthSkip } from "@/lib/authBypass";
import { LoginScreen } from "./LoginScreen";
import { NoAccessScreen } from "./NoAccessScreen";
import { GateFrame } from "./GateFrame";

type AccessResult = {
  authenticated: boolean;
  hasAccess: boolean;
  role: string | null;
  userId?: string;
};

// Convex injoignable (réseau coupé) : useConvexAuth reste bloqué en isLoading → au-delà de ce délai
// on bascule sur la grâce offline plutôt que de spinner à l'infini.
const UNREACHABLE_MS = 8000;

function Checking() {
  return (
    <GateFrame>
      <div className="grid min-h-48 place-items-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    </GateFrame>
  );
}

/**
 * Gate de connexion Discord facultative. Le choix « Passer » est persisté localement ; une session
 * valide garde en plus sa grâce offline de 7 j. Si Convex n'est pas configuré
 * (dev/navigateur/mock, env absent) → rend les enfants directement.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const [skipped, setSkipped] = useState(authWasSkipped);
  if (!convexConfigured || skipped) return <>{children}</>;
  const skip = () => {
    persistAuthSkip();
    setSkipped(true);
  };
  return <LoginGateInner onSkip={skip}>{children}</LoginGateInner>;
}

function LoginGateInner({ children, onSkip }: { children: ReactNode; onSkip: () => void }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const access = useQuery(api.access.getAccess) as AccessResult | undefined;
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Résolution Convex qui traîne → considère le réseau injoignable.
  useEffect(() => {
    if (!isLoading) {
      setTimedOut(false);
      return;
    }
    const t = setTimeout(() => setTimedOut(true), UNREACHABLE_MS);
    return () => clearTimeout(t);
  }, [isLoading]);

  // Tampon de grâce à chaque session valide (authentifié + accès).
  useEffect(() => {
    if (isAuthenticated && access?.hasAccess) stampAuth();
  }, [isAuthenticated, access?.hasAccess]);

  const unreachable = !online || timedOut;

  // 1) Hors ligne + login récent (< 7 j) → app utilisable (mode dégradé).
  if (unreachable && !isAuthenticated && offlineGraceValid()) return <>{children}</>;

  // 2) En ligne, résolution en cours → vérification.
  if (isLoading && !unreachable) return <Checking />;

  // 3) Session active.
  if (isAuthenticated) {
    if (access?.hasAccess) return <>{children}</>;
    if (access === undefined) {
      // Accès pas encore résolu : hors ligne on fait confiance à la grâce, sinon on attend.
      if (unreachable && offlineGraceValid()) return <>{children}</>;
      return <Checking />;
    }
    return <NoAccessScreen role={access.role} onSkip={onSkip} />;
  }

  // 4) Hors ligne, grâce expirée → login requis (échouera hors ligne, message dédié).
  if (unreachable) return <LoginScreen offline onSkip={onSkip} />;

  // 5) En ligne, pas de session → login.
  return <LoginScreen onSkip={onSkip} />;
}
