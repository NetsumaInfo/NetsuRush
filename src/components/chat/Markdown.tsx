// Rendu Markdown léger pour les réponses de l'agent — zéro dépendance (cohérent avec le reste du
// renderer). Couvre ce que produit un LLM en chat : titres, listes (puces/numéros), citations, blocs
// de code clôturés, et l'inline (gras, italique, `code`, liens). Pas un parseur CommonMark complet :
// volontairement minimal et robuste, suffisant pour des messages courts.
import { Fragment, type ReactNode } from "react";

// --- Inline : **gras**, *italique*/_italique_, `code`, [texte](url) ----------------------------
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Ordre des motifs = priorité. `code` d'abord (n'interprète pas son contenu).
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${keyBase}-t${i}`}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(<code key={`${keyBase}-c${i}`}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("[")) {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      out.push(<a key={`${keyBase}-a${i}`} href={mm[2]} target="_blank" rel="noreferrer">{mm[1]}</a>);
    } else {
      out.push(<em key={`${keyBase}-i${i}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(<Fragment key={`${keyBase}-tEnd`}>{text.slice(last)}</Fragment>);
  return out;
}

// --- Blocs : découpe ligne à ligne en titres / listes / citations / code / paragraphes ----------
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Bloc de code clôturé ```
    if (/^\s*```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // saute le ``` de fin
      blocks.push(
        <pre key={key++}>
          <code>{buf.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Lignes vides → séparateur
    if (!line.trim()) { i++; continue; }

    // Titres # ## ### → vrais éléments hN (typeset les stylise)
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const Tag = (`h${lvl}`) as "h1" | "h2" | "h3";
      blocks.push(<Tag key={key++}>{renderInline(h[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    // Liste à puces - / *
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      blocks.push(
        <ul key={key++}>
          {items.map((it, j) => <li key={`ul-${key}-${it}`}>{renderInline(it, `ul${key}-${j}`)}</li>)}
        </ul>,
      );
      continue;
    }

    // Liste numérotée 1.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      blocks.push(
        <ol key={key++}>
          {items.map((it, j) => <li key={`ol-${key}-${it}`}>{renderInline(it, `ol${key}-${j}`)}</li>)}
        </ol>,
      );
      continue;
    }

    // Citation >
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(
        <blockquote key={key++}>{renderInline(buf.join(" "), `bq${key}`)}</blockquote>,
      );
      continue;
    }

    // Paragraphe : agrège les lignes consécutives non vides / non spéciales
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,3}\s|[-*]\s|\d+\.\s|>\s?)/.test(lines[i])) { buf.push(lines[i]); i++; }
    blocks.push(<p key={key++}>{renderInline(buf.join(" "), `p${key}`)}</p>);
  }

  // `typeset` pilote toute la typographie (flux, titres, listes, code…) via :where().
  return <div className="typeset">{blocks}</div>;
}
