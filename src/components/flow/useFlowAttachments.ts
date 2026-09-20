// Les pièces jointes du panneau NetsuFlow : images et fichiers texte.
//
// Elles sont lues DANS le navigateur et voyagent avec le message — une image en
// base64, un fichier texte inséré dans le corps. Le chemin seul ne servirait à
// rien : un fournisseur BYOK n'a jamais eu accès au disque, et depuis que
// l'agent CLI tourne dans un dossier confiné il ne peut plus lire un fichier
// arbitraire non plus. Envoyer un chemin rendrait le modèle aveugle à ce qu'on
// croit lui montrer.
import { useCallback, useState } from "react";

import type { ChatImage } from "@/lib/bridge";

export type Attachment =
  | { kind: "image"; name: string; mediaType: string; data: string }
  | { kind: "text"; name: string; text: string };

/// Plafond par image. L'API plafonne autour de 5 Mo ; on garde une marge pour
/// le gonflement du base64 (≈ +33 %).
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
/// Plafond par fichier texte : au-delà ce n'est plus une pièce jointe, c'est un
/// corpus, et il chasserait la composition du contexte.
const MAX_TEXT_BYTES = 128 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif",
};

const TEXT_EXTENSIONS = [
  "md", "markdown", "mdx", "txt", "json", "csv", "tsv", "yaml", "yml",
  "html", "htm", "css", "js", "ts", "jsx", "tsx", "svg", "xml", "log",
];

const extensionOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

/** Les octets d'un fichier en base64, sans le préfixe `data:`. */
async function toBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // Par tranches : `String.fromCharCode(...buffer)` dépasse la taille maximale
  // d'appel sur un fichier de quelques centaines de kilo-octets.
  for (let i = 0; i < buffer.length; i += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function useFlowAttachments() {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [error, setError] = useState("");

  const add = useCallback(async (incoming: File[]) => {
    setError("");
    const accepted: Attachment[] = [];
    for (const file of incoming) {
      const ext = extensionOf(file.name);
      const mediaType = IMAGE_TYPES[ext];
      try {
        if (mediaType) {
          if (file.size > MAX_IMAGE_BYTES) {
            setError(`${file.name} : image trop lourde (${Math.round(file.size / 1024)} Ko)`);
            continue;
          }
          accepted.push({ kind: "image", name: file.name, mediaType, data: await toBase64(file) });
        } else if (TEXT_EXTENSIONS.includes(ext)) {
          if (file.size > MAX_TEXT_BYTES) {
            setError(`${file.name} : fichier trop gros (${Math.round(file.size / 1024)} Ko)`);
            continue;
          }
          accepted.push({ kind: "text", name: file.name, text: await file.text() });
        } else {
          // Un refus dit lequel et pourquoi : une pièce jointe qui disparaît en
          // silence laisse croire qu'elle est partie avec le message.
          setError(`${file.name} : format non pris en charge`);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    if (accepted.length) setFiles((list) => [...list, ...accepted]);
  }, []);

  const remove = useCallback((name: string) => {
    setFiles((list) => list.filter((f) => f.name !== name));
  }, []);

  const clear = useCallback(() => { setFiles([]); setError(""); }, []);

  /// Ce qui part avec le message : les images en pièces, le texte dans le corps.
  const payload = useCallback((): { images: ChatImage[]; text: string } => {
    const images = files
      .filter((f): f is Extract<Attachment, { kind: "image" }> => f.kind === "image")
      .map((f) => ({ mediaType: f.mediaType, data: f.data }));
    const text = files
      .filter((f): f is Extract<Attachment, { kind: "text" }> => f.kind === "text")
      // Encadré et nommé : le modèle doit pouvoir distinguer le fichier de la
      // demande, et savoir de quel fichier il parle en répondant.
      .map((f) => `\n\n<<<FICHIER ${f.name}\n${f.text}\nFICHIER>>>`)
      .join("");
    return { images, text };
  }, [files]);

  return { files, error, add, remove, clear, payload };
}
