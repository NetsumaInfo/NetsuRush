// Le cahier de design joint à l'agent NetsuFlow — un `frame.md`.
//
// C'est la traduction d'un `design.md` pour la vidéo : palette, bordures,
// ombres, rampes typographiques en `cqw`, espacements, composants. Sans lui,
// l'agent invente une esthétique à chaque demande ; avec, il écrit dans la
// charte qu'on lui a donnée.
//
// Le fichier reste sur le disque de l'utilisateur : on n'en garde que le texte,
// dans le stockage local, pour que le choix survive à un redémarrage.
import { useCallback, useEffect, useState } from "react";

export type FrameSpec = { name: string; text: string; at: number };

const KEY = "nr.flow.frameSpec";

/// Plafond de lecture. Un `frame.md` fait quelques kilo-octets ; refuser au-delà
/// vaut mieux que remplir le stockage local — et que joindre au prompt un
/// document dont il ne resterait qu'un début tronqué.
export const MAX_SPEC_BYTES = 128 * 1024;

/// Ce qu'on accepte de lire. La liste est là pour éviter qu'un glisser-déposer
/// distrait n'envoie une vidéo de 4 Go dans un `FileReader`.
const EXTENSIONS = [".md", ".markdown", ".txt", ".yaml", ".yml", ".mdx"];

export const looksLikeSpec = (name: string) =>
  EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

function read(): FrameSpec | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== "string") return null;
    return { name: String(parsed.name || "frame.md"), text: parsed.text, at: Number(parsed.at) || 0 };
  } catch {
    return null;
  }
}

export function useFrameSpec() {
  const [spec, setSpec] = useState<FrameSpec | null>(read);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      if (spec) localStorage.setItem(KEY, JSON.stringify(spec));
      else localStorage.removeItem(KEY);
    } catch {
      // Quota dépassé : le cahier reste actif pour la session, il ne sera
      // simplement pas retrouvé au prochain démarrage. Le dire serait du bruit
      // pour une conséquence qui n'arrive qu'au redémarrage suivant.
    }
  }, [spec]);

  /// Charge un fichier choisi ou déposé. Les refus sont EXPLICITES : un cahier
  /// qui ne se charge pas en silence laisserait croire qu'il est pris en compte.
  const load = useCallback(async (file: File) => {
    setError("");
    if (!looksLikeSpec(file.name)) {
      setError(`format non lu : ${file.name}`);
      return false;
    }
    if (file.size > MAX_SPEC_BYTES) {
      setError(`fichier trop gros (${Math.round(file.size / 1024)} Ko, maximum ${MAX_SPEC_BYTES / 1024} Ko)`);
      return false;
    }
    try {
      const text = await file.text();
      if (!text.trim()) { setError("fichier vide"); return false; }
      setSpec({ name: file.name, text, at: Date.now() });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  const clear = useCallback(() => { setSpec(null); setError(""); }, []);

  return { spec, error, load, clear };
}
