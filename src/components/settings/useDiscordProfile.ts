import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/lib/convexApi";

export type DiscordProfile = {
  /** Snowflake Discord : identifie l'auteur d'un rapport de bug sans qu'il ait à se nommer. */
  id: string | null;
  avatarUrl: string | null;
  decorationUrl: string | null;
  accentColor: string | null;
  username: string | null;
};

// Cache module : le profil Discord change rarement → un seul fetch par session, partagé.
let cache: DiscordProfile | null | undefined;
let inflight: Promise<DiscordProfile | null> | null = null;

// Profil Discord (avatar + décoration + accentColor) via l'action Convex. `null` tant que non chargé
// ou indisponible (pas de token OAuth). Sert surtout la décoration d'avatar Nitro.
export function useDiscordProfile(): DiscordProfile | null {
  const getProfile = useAction(api.discord.getCurrentDiscordProfile);
  const [profile, setProfile] = useState<DiscordProfile | null>(cache ?? null);

  useEffect(() => {
    if (cache !== undefined) {
      setProfile(cache);
      return;
    }
    let cancelled = false;
    inflight ??= (getProfile() as Promise<DiscordProfile | null>).catch(() => null);
    void inflight.then((p) => {
      cache = p ?? null;
      if (!cancelled) setProfile(cache);
    });
    return () => {
      cancelled = true;
    };
  }, [getProfile]);

  return profile;
}

/**
 * Profil DÉJÀ chargé cette session, sans hook ni appel réseau : le rapport d'erreur en un clic part
 * depuis des écrans (installation, mise à jour) qui ne sont pas forcément sous le provider Convex.
 * `null` = auteur anonyme, jamais une attente.
 */
export function loadedDiscordProfile(): DiscordProfile | null {
  return cache ?? null;
}
