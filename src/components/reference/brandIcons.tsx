// Icônes de marque des liens posés sur le board (réseaux sociaux + plateformes vidéo). lucide ne
// fournit pas (ou pas tous) ces logos → on dérive un glyphe uniforme depuis les tracés OFFICIELS de
// `simple-icons` (un seul <path>, rempli en currentColor). `iconForLink(url)` déduit le réseau à
// partir du DOMAINE de l'URL (couvre sous-domaines : m.youtube.com, player.vimeo.com, open.spotify…)
// → une icône dédiée par réseau, jamais d'icône d'un autre réseau. `Globe` = dernier recours pour un
// domaine vraiment inconnu. Corrige l'ancienne icône YouTube codée en dur sur « Ouvrir le lien ».

import type { ReactElement } from "react";
import { Globe, type LucideIcon } from "lucide-react";
import {
  siYoutube, siX, siInstagram, siFacebook, siTiktok, siReddit, siVimeo, siDailymotion,
  siTwitch, siBluesky, siThreads, siSnapchat, siPinterest, siTumblr, siMastodon,
  siDiscord, siTelegram, siWhatsapp, siSpotify, siSoundcloud, siGithub, siBehance,
  siDribbble, siArtstation, siDeviantart, siFlickr, siPixiv, siSinaweibo, siBilibili,
  siVk, siKuaishou, siNiconico, siOdysee, siRumble, siPatreon, siLine, siWechat,
} from "simple-icons";
import type { BoardItem } from "./referenceShared";

type SimplePath = { title: string; path: string };
type IconProps = { className?: string; size?: number };
export type AnyIcon = LucideIcon | ((p: IconProps) => ReactElement);

// Composant icône à partir d'un tracé simple-icons. La largeur de l'attribut est surchargée par une
// classe `size-*` éventuelle (le CSS prime sur l'attribut SVG), donc s'intègre aux menus shadcn.
function glyph(si: SimplePath): AnyIcon {
  const Icon = ({ className, size = 24 }: IconProps) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      role="img"
      aria-label={si.title}
    >
      <path d={si.path} />
    </svg>
  );
  Icon.displayName = si.title;
  return Icon;
}

// LinkedIn et Streamable ont été retirés de simple-icons (raisons légales / absence) → tracés maison.
const LinkedInIcon = glyph({
  title: "LinkedIn",
  path: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z",
});
const StreamableIcon = glyph({
  title: "Streamable",
  path: "M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-1.2 6.6 6 5.4-6 5.4z",
});

// Logos uniformes (glyphes pleins) — exportés au cas où d'autres vues veulent l'icône directe.
export const YouTubeIcon = glyph(siYoutube);
export const XIcon = glyph(siX);
export const InstagramIcon = glyph(siInstagram);
export const FacebookIcon = glyph(siFacebook);
export const TikTokIcon = glyph(siTiktok);
export const RedditIcon = glyph(siReddit);
export const VimeoIcon = glyph(siVimeo);
export const DailymotionIcon = glyph(siDailymotion);
export const TwitchIcon = glyph(siTwitch);
export const BlueskyIcon = glyph(siBluesky);
export const ThreadsIcon = glyph(siThreads);
export const SnapchatIcon = glyph(siSnapchat);
export const PinterestIcon = glyph(siPinterest);
export const TumblrIcon = glyph(siTumblr);
export const MastodonIcon = glyph(siMastodon);
export const DiscordIcon = glyph(siDiscord);
export const TelegramIcon = glyph(siTelegram);
export const WhatsAppIcon = glyph(siWhatsapp);
export const SpotifyIcon = glyph(siSpotify);
export const SoundCloudIcon = glyph(siSoundcloud);
export const GitHubIcon = glyph(siGithub);
export const BehanceIcon = glyph(siBehance);
export const DribbbleIcon = glyph(siDribbble);
export const ArtStationIcon = glyph(siArtstation);
export const DeviantArtIcon = glyph(siDeviantart);
export const FlickrIcon = glyph(siFlickr);
export const PixivIcon = glyph(siPixiv);
export const WeiboIcon = glyph(siSinaweibo);
export const BilibiliIcon = glyph(siBilibili);
export const VkIcon = glyph(siVk);
export const KuaishouIcon = glyph(siKuaishou);
export const NiconicoIcon = glyph(siNiconico);
export const OdyseeIcon = glyph(siOdysee);
export const RumbleIcon = glyph(siRumble);
export const PatreonIcon = glyph(siPatreon);
export const LineIcon = glyph(siLine);
export const WeChatIcon = glyph(siWechat);

// Domaine enregistrable (ou hôte complet) → icône du réseau. Les sous-domaines sont gérés par
// `endsWith` côté lookup, donc on ne liste que le domaine racine.
const BY_HOST: Record<string, AnyIcon> = {
  "youtube.com": YouTubeIcon, "youtu.be": YouTubeIcon, "youtube-nocookie.com": YouTubeIcon,
  "x.com": XIcon, "twitter.com": XIcon, "t.co": XIcon,
  "instagram.com": InstagramIcon, "instagr.am": InstagramIcon,
  "facebook.com": FacebookIcon, "fb.watch": FacebookIcon, "fb.com": FacebookIcon, "fb.me": FacebookIcon,
  "tiktok.com": TikTokIcon,
  "reddit.com": RedditIcon, "redd.it": RedditIcon,
  "vimeo.com": VimeoIcon,
  "dailymotion.com": DailymotionIcon, "dai.ly": DailymotionIcon,
  "twitch.tv": TwitchIcon,
  "bsky.app": BlueskyIcon,
  "threads.net": ThreadsIcon, "threads.com": ThreadsIcon,
  "snapchat.com": SnapchatIcon,
  "pinterest.com": PinterestIcon, "pin.it": PinterestIcon,
  "linkedin.com": LinkedInIcon, "lnkd.in": LinkedInIcon,
  "tumblr.com": TumblrIcon,
  "discord.com": DiscordIcon, "discord.gg": DiscordIcon, "discordapp.com": DiscordIcon,
  "t.me": TelegramIcon, "telegram.org": TelegramIcon, "telegram.me": TelegramIcon,
  "whatsapp.com": WhatsAppIcon, "wa.me": WhatsAppIcon,
  "spotify.com": SpotifyIcon,
  "soundcloud.com": SoundCloudIcon,
  "github.com": GitHubIcon,
  "behance.net": BehanceIcon,
  "dribbble.com": DribbbleIcon,
  "artstation.com": ArtStationIcon,
  "deviantart.com": DeviantArtIcon,
  "flickr.com": FlickrIcon, "flic.kr": FlickrIcon,
  "pixiv.net": PixivIcon,
  "weibo.com": WeiboIcon, "weibo.cn": WeiboIcon,
  "bilibili.com": BilibiliIcon, "b23.tv": BilibiliIcon,
  "vk.com": VkIcon,
  "kuaishou.com": KuaishouIcon,
  "nicovideo.jp": NiconicoIcon, "nico.ms": NiconicoIcon,
  "odysee.com": OdyseeIcon,
  "rumble.com": RumbleIcon,
  "patreon.com": PatreonIcon,
  "line.me": LineIcon,
  "wechat.com": WeChatIcon, "weixin.qq.com": WeChatIcon,
  "streamable.com": StreamableIcon,
};

// Icône de marque déduite d'une URL. Domaine reconnu → icône du réseau ; Mastodon = fédéré (hôtes
// multiples) → heuristique sur le nom ; domaine inconnu → `Globe`.
export function iconForLink(url: string): AnyIcon {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return Globe;
  }
  if (!host) return Globe;
  if (host === "mastodon.social" || host.includes("mastodon") || host.startsWith("mstdn.")) return MastodonIcon;
  for (const key in BY_HOST) {
    if (host === key || host.endsWith(`.${key}`)) return BY_HOST[key];
  }
  return Globe;
}

// Icône d'une plateforme d'embed reconnue (`EmbedProvider`) — pour les listes de réglages, où l'on
// n'a que l'identifiant de la plateforme, jamais une URL. `generic` (site quelconque) → `Globe`.
const BY_PROVIDER: Record<string, AnyIcon> = {
  twitter: XIcon, tiktok: TikTokIcon, instagram: InstagramIcon, facebook: FacebookIcon,
  reddit: RedditIcon, bluesky: BlueskyIcon, vimeo: VimeoIcon, dailymotion: DailymotionIcon,
  twitch: TwitchIcon, streamable: StreamableIcon,
};
export function iconForProvider(provider: string): AnyIcon {
  return BY_PROVIDER[provider] ?? Globe;
}

// Icône d'un item lié. YouTube est un kind à part (ref = id vidéo, pas une URL) → icône directe ;
// sinon (embed) on déduit du domaine de `ref` (= URL de la page d'origine).
export function providerIcon(item: Pick<BoardItem, "kind" | "ref">): AnyIcon {
  if (item.kind === "youtube") return YouTubeIcon;
  return iconForLink(item.ref);
}
