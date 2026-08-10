// Moteur d'embeds en ligne du board (parsing + reconstruction d'URL). Séparé du MODÈLE
// (referenceShared.ts) : ici vit tout ce qui RECONNAÎT un lien (YouTube, plateformes vidéo,
// réseaux sociaux, GIF host) et reconstruit l'URL d'iframe à afficher. referenceShared réexporte
// ces symboles pour ne casser aucun import existant (tous les consommateurs importent depuis
// "./referenceShared").

import { IMAGE_RE, VIDEO_RE } from "./referenceShared";

// Extrait l'id d'une vidéo YouTube depuis n'importe quelle forme d'URL (watch, youtu.be, embed, shorts).
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/,
  );
  return m ? m[1] : null;
}

// Giphy : la page (giphy.com/gifs/NOM-ID, /clips/, /stickers/, /embed|media/ID) bloque le scraping
// HTML (403 Cloudflare) → on construit directement l'URL du GIF sur le CDN média i.giphy.com, qui
// se télécharge sans souci. Renvoie l'URL .gif directe, ou null si ce n'est pas un lien giphy connu.
export function giphyGifUrl(input: string): string | null {
  const s = input.trim();
  const m = s.match(/giphy\.com\/(?:gifs|clips|stickers|gp|embed|media)\/([^/?#]+)/i);
  if (!m) return null;
  const seg = m[1];
  const id = seg.includes("-") ? seg.split("-").pop()! : seg;
  return /^[A-Za-z0-9]{6,}$/.test(id) ? `https://i.giphy.com/media/${id}/giphy.gif` : null;
}

// --- Embeds en ligne (multi-provider : vidéo + réseaux sociaux) ------------------------------
// YouTube reste un kind à part (boucle via IFrame Player API). TOUTES les autres plateformes —
// vidéo (Vimeo, Dailymotion, Twitch, Streamable) ET réseaux sociaux (Twitter/X, TikTok, Instagram,
// Facebook, Reddit, Bluesky) — deviennent un kind "embed" : iframe nue dont le src est reconstruit
// depuis `ref` (= URL de la page, persistée) à chaque chargement. Pour les socials on s'appuie sur
// les endpoints iframe que chargent les widgets officiels (best-effort : un mur de login ou une
// politique X-Frame-Options peut laisser l'embed vide). Le POST entier est embarqué (avec son média).
export type EmbedProvider =
  | "vimeo" | "dailymotion" | "twitch" | "streamable"
  | "twitter" | "tiktok" | "instagram" | "facebook" | "reddit" | "bluesky"
  | "threads" | "snapchat" | "pinterest" | "linkedin" | "tumblr" | "flickr"
  | "bilibili" | "vk" | "kuaishou" | "niconico" | "odysee" | "rumble"
  | "generic";

export interface EmbedInfo {
  provider: EmbedProvider;
  embedUrl: string;            // src de l'iframe (params autoplay/mute/loop ou thème selon provider)
  pageUrl: string;             // lien d'origine (ouvert via « Ouvrir le lien »)
  size?: { w: number; h: number }; // taille initiale conseillée (les posts sociaux sont portrait/hauts)
}

// Hôte courant — Twitch EXIGE un param `parent` = domaine hôte exact, sinon refuse l'embed.
function embedHost(): string {
  return typeof window !== "undefined" ? window.location.hostname || "localhost" : "localhost";
}

// Reconnaît une plateforme (hors YouTube). `allowGeneric` → tout lien http(s) restant devient un
// embed iframe générique (best-effort : marche si le site autorise l'embed). Renvoie null sinon.
export function parseVideoEmbed(input: string, allowGeneric = false): EmbedInfo | null {
  const s = input.trim();
  if (!/^https?:\/\//i.test(s)) return null;

  let m: RegExpMatchArray | null;

  // --- Plateformes vidéo ---------------------------------------------------------------------
  // Vimeo : vimeo.com/ID ou player.vimeo.com/video/ID
  if ((m = s.match(/vimeo\.com\/(?:video\/)?(\d+)/i))) {
    return { provider: "vimeo", pageUrl: s, embedUrl: `https://player.vimeo.com/video/${m[1]}?autoplay=1&muted=1&loop=1&background=1` };
  }
  // Dailymotion : dailymotion.com/video/ID ou dai.ly/ID
  if ((m = s.match(/(?:dailymotion\.com\/video|dai\.ly)\/([a-z0-9]+)/i))) {
    return { provider: "dailymotion", pageUrl: s, embedUrl: `https://www.dailymotion.com/embed/video/${m[1]}?autoplay=1&mute=1` };
  }
  // Twitch : VOD (/videos/ID), clip (clips.twitch.tv/SLUG ou /clip/SLUG) ou chaîne live.
  if ((m = s.match(/twitch\.tv\/videos\/(\d+)/i))) {
    return { provider: "twitch", pageUrl: s, embedUrl: `https://player.twitch.tv/?video=${m[1]}&parent=${embedHost()}&autoplay=true&muted=true` };
  }
  if ((m = s.match(/(?:clips\.twitch\.tv\/|twitch\.tv\/\w+\/clip\/)([\w-]+)/i))) {
    return { provider: "twitch", pageUrl: s, embedUrl: `https://clips.twitch.tv/embed?clip=${m[1]}&parent=${embedHost()}&autoplay=true&muted=true` };
  }
  if ((m = s.match(/twitch\.tv\/([a-z0-9_]+)$/i))) {
    return { provider: "twitch", pageUrl: s, embedUrl: `https://player.twitch.tv/?channel=${m[1]}&parent=${embedHost()}&autoplay=true&muted=true` };
  }
  // Streamable : streamable.com/ID
  if ((m = s.match(/streamable\.com\/(?:e\/)?(\w+)/i))) {
    return { provider: "streamable", pageUrl: s, embedUrl: `https://streamable.com/e/${m[1]}?autoplay=1&muted=1&loop=1` };
  }

  // --- Réseaux sociaux (post entier embarqué, média inclus) ----------------------------------
  // Twitter / X : .../status/ID → endpoint iframe officiel des widgets (thème sombre, dnt).
  if ((m = s.match(/(?:twitter\.com|x\.com)\/[^/]+\/status(?:es)?\/(\d+)/i))) {
    return { provider: "twitter", pageUrl: s, size: { w: 480, h: 620 },
      embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&theme=dark&dnt=true` };
  }
  // TikTok : /@user/video/ID ou /v/ID (les liens courts vm.tiktok.com redirigent → repli générique).
  if ((m = s.match(/tiktok\.com\/(?:@[^/]+\/video|v|embed\/v2)\/(\d+)/i))) {
    return { provider: "tiktok", pageUrl: s, size: { w: 340, h: 600 },
      embedUrl: `https://www.tiktok.com/player/v1/${m[1]}?autoplay=0&music_info=1&description=1` };
  }
  // Instagram : /p|reel|tv/CODE → suffixe /embed/captioned (iframe public).
  if ((m = s.match(/instagram\.com\/(?:p|reel|tv)\/([\w-]+)/i))) {
    return { provider: "instagram", pageUrl: s, size: { w: 400, h: 560 },
      embedUrl: `https://www.instagram.com/p/${m[1]}/embed/captioned` };
  }
  // Facebook : vidéo (plugin video.php) puis post (plugin post.php) — href percent-encodé.
  if (/(?:facebook\.com\/(?:[\w.]+\/videos\/|watch\/?\?v=|reel\/)|fb\.watch\/)/i.test(s)) {
    return { provider: "facebook", pageUrl: s, size: { w: 500, h: 340 },
      embedUrl: `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(s)}&show_text=false` };
  }
  if (/facebook\.com\//i.test(s)) {
    return { provider: "facebook", pageUrl: s, size: { w: 500, h: 620 },
      embedUrl: `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(s)}&show_text=true` };
  }
  // Reddit : /r/sub/comments/ID[/slug] → hôte redditmedia (iframe officielle des widgets).
  if ((m = s.match(/reddit\.com(\/r\/[^/]+\/comments\/\w+(?:\/[\w-]+)?)/i))) {
    return { provider: "reddit", pageUrl: s, size: { w: 500, h: 600 },
      embedUrl: `https://www.redditmedia.com${m[1]}/?ref_source=embed&ref=share&embed=true&theme=dark` };
  }
  // Bluesky : bsky.app/profile/AUTORITÉ/post/RKEY (autorité = handle ou did, best-effort).
  if ((m = s.match(/bsky\.app\/profile\/([^/]+)\/post\/(\w+)/i))) {
    return { provider: "bluesky", pageUrl: s, size: { w: 480, h: 520 },
      embedUrl: `https://embed.bsky.app/embed/${m[1]}/app.bsky.feed.post/${m[2]}` };
  }
  // Download-first platforms supported by yt-dlp. Their page URL is kept as a last-resort embed;
  // normal operation extracts the actual media file.
  const downloadFirst: [EmbedProvider, RegExp, { w: number; h: number }][] = [
    ["threads", /threads\.(?:net|com)\//i, { w: 480, h: 600 }],
    ["snapchat", /snapchat\.com\//i, { w: 400, h: 620 }],
    ["pinterest", /(?:pinterest\.[^/]+|pin\.it)\//i, { w: 480, h: 600 }],
    ["linkedin", /(?:linkedin\.com|lnkd\.in)\//i, { w: 500, h: 500 }],
    ["tumblr", /tumblr\.com\//i, { w: 500, h: 600 }],
    ["flickr", /(?:flickr\.com|flic\.kr)\//i, { w: 500, h: 420 }],
    ["bilibili", /(?:bilibili\.com|b23\.tv)\//i, { w: 500, h: 360 }],
    ["vk", /vk\.com\//i, { w: 500, h: 420 }],
    ["kuaishou", /kuaishou\.com\//i, { w: 400, h: 620 }],
    ["niconico", /(?:nicovideo\.jp|nico\.ms)\//i, { w: 500, h: 360 }],
    ["odysee", /odysee\.com\//i, { w: 500, h: 360 }],
    ["rumble", /rumble\.com\//i, { w: 500, h: 360 }],
  ];
  for (const [provider, pattern, size] of downloadFirst) {
    if (pattern.test(s)) return { provider, pageUrl: s, embedUrl: s, size };
  }

  if (allowGeneric) return { provider: "generic", pageUrl: s, embedUrl: s };
  return null;
}

// Reconstruit le src iframe d'un item embed depuis sa `ref` (URL page persistée). Provider connu →
// URL d'embed paramétrée ; sinon (générique) → la ref telle quelle.
export function embedSrc(ref: string): string {
  return parseVideoEmbed(ref, true)?.embedUrl ?? ref;
}

// Providers à LECTEUR propre (iframe jouable, boucle) → on garde l'embed plutôt que d'extraire le
// fichier. Les AUTRES (réseaux sociaux : twitter/tiktok/instagram/facebook/reddit/bluesky) → on
// extrait le vrai média par défaut (yt-dlp/gallery-dl). `generic` → extraction tentée puis repli embed.
export const EMBED_PLAYER_PROVIDERS = new Set<EmbedProvider>(["vimeo", "dailymotion", "twitch", "streamable"]);

// Providers dont l'embed est peu fiable (mur de login / X-Frame / iframe noire) → candidats au
// téléchargement automatique du vrai média. Source unique : la liste réglable des Paramètres
// (« Télécharger les vidéos en ligne ») et le balayage post-import lisent CETTE liste.
export const DOWNLOADABLE_EMBED_PROVIDERS: EmbedProvider[] =
  [
    "twitter", "tiktok", "instagram", "facebook", "reddit", "bluesky",
    "threads", "snapchat", "pinterest", "linkedin", "tumblr", "flickr",
    "bilibili", "vk", "kuaishou", "niconico", "odysee", "rumble", "generic",
  ];

// Une URL pointe-t-elle directement un fichier vidéo / image ? Extension prise du dernier segment
// du chemin, sinon du paramètre de requête (CDN type pbs.twimg.com/...?format=jpg, ?fm=webp).
function urlExt(u: string): string {
  try {
    const url = new URL(u);
    const last = url.pathname.split("/").pop() || "";
    if (last.includes(".")) return last.split(".").pop()!.toLowerCase();
    const q = url.searchParams;
    return (q.get("format") || q.get("fm") || q.get("ext") || "").toLowerCase();
  } catch {
    return u.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase() ?? "";
  }
}
export function isVideoUrl(u: string): boolean {
  return VIDEO_RE.test(`.${urlExt(u)}`);
}
export function isImageUrl(u: string): boolean {
  return IMAGE_RE.test(`.${urlExt(u)}`);
}
