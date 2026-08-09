// Codecs, conteneurs et codecs audio d'un transfert — SOUS-ENSEMBLE des profils d'export limité à ce
// que Premiere Pro, After Effects et Resolve importent tous les trois. Le catalogue complet sert la
// livraison (web, archivage) ; ici tout fichier produit repart dans un logiciel de montage, donc un
// codec que la cible n'ouvre pas n'est pas un choix mais un transfert raté.
//
// Écartés, et pourquoi :
//  - AV1 / VP9 / FFV1 · WebM : aucune de ces familles n'est un format de montage (AV1 et VP9 sont des
//    codecs de diffusion, FFV1 un format d'archivage) ;
//  - MKV : ni Premiere ni After Effects n'importent le conteneur Matroska ;
//  - H.264 Baseline (legacy mobile), 10 bits, 4:2:2 et 4:4:4, H.265 12 bits et 4:4:4 : hors du
//    décodage des NLE — au-delà du 8 bits, la voie ouverte partout est H.265 Main 10 ;
//  - Opus, MP3, FLAC, ALAC : Opus n'est pas muxé en MOV et aucun des trois logiciels ne le lit ;
//    MP3 traîne un délai d'encodeur qui décale le son ; FLAC et ALAC ne sont pas importés par Premiere.
import {
  EXPORT_AUDIO_OPTIONS,
  EXPORT_CONTAINER_OPTIONS,
  type ExportAudioMode,
  type ExportCodec,
  type ExportContainer,
} from "@/features/export/profiles";

export const NLE_CODECS: ReadonlySet<ExportCodec> = new Set<ExportCodec>([
  "h264_main", "h264_high",
  "h265_main", "h265_main10", "h265_main422_10",
  "prores_422_lt", "prores_422", "prores_422_hq", "prores_4444", "prores_4444_xq",
  "dnxhr_lb", "dnxhr_sq", "dnxhr_hq", "dnxhr_hqx", "dnxhr_444",
  "cineform", "cineform_hq",
]);

export const NLE_CONTAINERS: ReadonlySet<ExportContainer> = new Set<ExportContainer>(["mov", "mp4"]);

export const NLE_AUDIO: ReadonlySet<ExportAudioMode> = new Set<ExportAudioMode>([
  "copy", "aac_128", "aac", "aac_256", "aac_320", "pcm16", "pcm24",
]);

export const NLE_CONTAINER_OPTIONS = EXPORT_CONTAINER_OPTIONS.filter((o) => NLE_CONTAINERS.has(o.value));
export const NLE_AUDIO_OPTIONS = EXPORT_AUDIO_OPTIONS.filter((o) => NLE_AUDIO.has(o.value));

type Option<T> = { value: T; label: string };
type Group<T> = { options: Option<T>[] };

/** Retire d'une liste groupée ce que les logiciels de montage n'ouvrent pas (groupes vides compris). */
export function keepAllowed<T, G extends Group<T>>(groups: G[], allowed: ReadonlySet<T>): G[] {
  return groups
    .map((group) => ({ ...group, options: group.options.filter((o) => allowed.has(o.value)) }))
    .filter((group) => group.options.length > 0);
}
