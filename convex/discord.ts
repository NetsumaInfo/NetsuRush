import { action } from "./_generated/server";
import { authComponent, createAuth } from "./auth";

export interface DiscordProfile {
  /** Identifiant Discord (snowflake) : sert à mentionner l'auteur d'un rapport de bug. */
  id: string | null;
  avatarUrl: string | null;
  /** Décoration d'avatar (cadre Nitro, centre transparent) ou null. */
  decorationUrl: string | null;
  accentColor: string | null;
  username: string | null;
}

// Profil Discord de l'utilisateur connecté via `GET /users/@me` (token OAuth stocké par Better Auth).
// Sert la DÉCORATION d'avatar (avatar_decoration_data), absente du user Better Auth de base.
export const getCurrentDiscordProfile = action({
  args: {},
  handler: async (ctx): Promise<DiscordProfile | null> => {
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx);

    let accessToken: string | undefined;
    try {
      const res = await auth.api.getAccessToken({ body: { providerId: "discord" }, headers });
      accessToken = res.accessToken;
    } catch {
      return null;
    }
    if (!accessToken) return null;

    const response = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;

    const u = (await response.json()) as {
      id: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
      accent_color?: number | null;
      avatar_decoration_data?: { asset: string; sku_id: string } | null;
    };

    const avatarUrl = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.${u.avatar.startsWith("a_") ? "gif" : "png"}?size=256`
      : null;
    const decorationUrl = u.avatar_decoration_data
      ? `https://cdn.discordapp.com/avatar-decoration-presets/${u.avatar_decoration_data.asset}.png?size=256&passthrough=true`
      : null;
    const accentColor =
      typeof u.accent_color === "number" ? `#${u.accent_color.toString(16).padStart(6, "0")}` : null;

    return { id: u.id ?? null, avatarUrl, decorationUrl, accentColor, username: u.global_name ?? u.username ?? null };
  },
});
