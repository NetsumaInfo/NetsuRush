// Codecs, conteneurs et codecs audio d'un transfert — SOUS-ENSEMBLE des profils d'export limité à ce
// que Premiere Pro, After Effects et Resolve importent tous les trois. Le catalogue complet sert la
// livraison (web, archivage) ; ici tout fichier produit repart dans un logiciel de montage, donc un
// codec que la cible n'ouvre pas n'est pas un choix mais un transfert raté.
//
// Écartés, et pourquoi :
//  - MKV : ni Premiere ni After Effects n'importent le conteneur Matroska ;
//  - H.264 Baseline (legacy mobile), 10 bits, 4:2:2 et 4:4:4, H.265 12 bits et 4:4:4 : hors du
//    décodage des NLE — au-delà du 8 bits, la voie ouverte partout est H.265 Main 10 ;
//  - AC-3, MP3 : l'AC-3 est un format de LIVRAISON (matriçage 5.1), pas de transfert ; MP3 traîne
//    un délai d'encodeur qui décale le son.
import {
  type ExportAudioMode,
  type ExportCodec,
  type ExportContainer,
} from "@/features/export/profiles";

export const NLE_CODECS: ReadonlySet<ExportCodec> = new Set<ExportCodec>([
  "h264_main", "h264_high",
  "h265_main", "h265_main10", "h265_main422_10",
  "prores_422_lt", "prores_422", "prores_422_hq", "prores_4444", "prores_4444_xq",
  "dnxhr_lb", "dnxhr_sq", "dnxhr_hq", "dnxhr_hqx", "dnxhr_444",
]);

export const NLE_CONTAINERS: ReadonlySet<ExportContainer> = new Set<ExportContainer>(["mov", "mp4"]);

export const NLE_AUDIO: ReadonlySet<ExportAudioMode> = new Set<ExportAudioMode>([
  "copy", "aac_128", "aac", "aac_256", "aac_320", "pcm16", "pcm24",
]);

type Option<T> = { value: T; label: string };
type Group<T> = { options: Option<T>[] };

/** Retire d'une liste groupée ce que les logiciels de montage n'ouvrent pas (groupes vides compris). */
export function keepAllowed<T, G extends Group<T>>(groups: G[], allowed: ReadonlySet<T>): G[] {
  return groups
    .map((group) => ({ ...group, options: group.options.filter((o) => allowed.has(o.value)) }))
    .filter((group) => group.options.length > 0);
}
