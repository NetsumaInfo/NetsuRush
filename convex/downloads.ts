"use node";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { v } from "convex/values";

// Téléchargement gardé de la beta (le repo GitHub est privé).
// Le site web appelle cette action (client authentifié) → vérif accès beta (même règle que
// l'app : OPEN_BETA ou betaGrant) → on résout l'asset de la dernière release via l'API GitHub
// (jeton GITHUB_TOKEN en env Convex, jamais côté client) → on renvoie l'URL S3 signée
// (courte durée) que GitHub fournit derrière le 302. Rien n'est streamé par Convex.
//
// Env requis sur le déploiement : GITHUB_TOKEN (PAT lecture contents du repo),
// GITHUB_REPO (optionnel, défaut "NetsumaInfo/NetsuRush").

const GH_API = "https://api.github.com";

// Suffixes d'assets Tauri par plateforme.
const MATCHERS: Record<string, (name: string) => boolean> = {
  windows: (n) => n.endsWith(".msi") || n.endsWith("-setup.exe"),
  mac: (n) => n.endsWith(".dmg"),
  linux: (n) => n.endsWith(".AppImage") || n.endsWith(".deb"),
};

export const getDownloadUrl = action({
  args: { platform: v.union(v.literal("windows"), v.literal("mac"), v.literal("linux")) },
  handler: async (ctx, { platform }) => {
    const access = await ctx.runQuery(api.access.getAccess, {});
    if (!access.authenticated) throw new Error("NOT_AUTHENTICATED");
    if (!access.hasAccess) throw new Error("NO_BETA_ACCESS");

    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("DOWNLOADS_NOT_CONFIGURED");
    const repo = process.env.GITHUB_REPO ?? "NetsumaInfo/NetsuRush";
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "netsurush-site",
    };

    const releaseRes = await fetch(`${GH_API}/repos/${repo}/releases/latest`, {
      headers: { ...headers, Accept: "application/vnd.github+json" },
    });
    if (releaseRes.status === 404) throw new Error("NO_RELEASE");
    if (!releaseRes.ok) throw new Error(`GITHUB_ERROR_${releaseRes.status}`);
    const release = (await releaseRes.json()) as {
      tag_name: string;
      assets: Array<{ id: number; name: string; size: number; url: string }>;
    };

    const match = MATCHERS[platform];
    const asset = release.assets.find((a) => match(a.name));
    if (!asset) throw new Error("NO_ASSET_FOR_PLATFORM");

    // L'URL API de l'asset répond 302 → Location = URL S3 signée (valide quelques minutes).
    const assetRes = await fetch(asset.url, {
      headers: { ...headers, Accept: "application/octet-stream" },
      redirect: "manual",
    });
    const location = assetRes.headers.get("location");
    if (!location) throw new Error("NO_SIGNED_URL");

    return {
      url: location,
      name: asset.name,
      size: asset.size,
      version: release.tag_name,
    };
  },
});
