// Le diff ligne à ligne d'une composition.
//
// `source.replace` est la seule opération qui ne se résume pas à « avant → après » :
// c'est un document entier. Annoncer « source réécrite, 4 120 caractères » ne dit
// rien de ce qui a bougé, et c'est très exactement la raison pour laquelle
// l'utilisateur voyait l'agent répondre sans jamais voir de modification.
//
// LCS classique, borné. Une composition fait quelques centaines de lignes ; au-delà
// du plafond on rend un résumé plutôt que de faire ramer le fil de rendu sur une
// matrice de plusieurs millions de cases.

export type DiffLine = {
  kind: "same" | "add" | "del" | "gap";
  text: string;
  /// Numéro de ligne côté avant / après, quand la ligne en a un.
  before?: number;
  after?: number;
};

export type SourceDiff = {
  lines: DiffLine[];
  added: number;
  removed: number;
  /// Vrai quand le document dépasse le plafond : `lines` est alors vide et seuls
  /// les compteurs sont exploitables.
  tooLarge: boolean;
};

/// Au-delà, la matrice LCS coûte plus que ce que le panneau rapporte.
const MAX_LINES = 1200;

/// Lignes inchangées gardées de part et d'autre d'un changement. Le reste est
/// replié en une ligne « … » : on lit ce qui a bougé, pas le document.
const CONTEXT = 2;

/**
 * Table LCS des longueurs. Reconstruite en arrière pour produire la séquence
 * d'opérations, ce qui évite de garder les chemins en mémoire.
 */
function lcsLengths(a: string[], b: string[]): Uint32Array {
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + (j + 1)] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  return table;
}

/** Replie les longues suites de lignes identiques, en gardant `CONTEXT` de chaque côté. */
function collapse(lines: DiffLine[]): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "same") continue;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) {
      keep[j] = true;
    }
  }
  const out: DiffLine[] = [];
  let hidden = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (hidden) {
        out.push({ kind: "gap", text: String(hidden) });
        hidden = 0;
      }
      out.push(lines[i]);
    } else {
      hidden += 1;
    }
  }
  if (hidden) out.push({ kind: "gap", text: String(hidden) });
  return out;
}

export function sourceDiff(before: string, after: string): SourceDiff {
  const a = before.split("\n");
  const b = after.split("\n");

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return { lines: [], added: b.length, removed: a.length, tooLarge: true };
  }

  const width = b.length + 1;
  const table = lcsLengths(a, b);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i], before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      lines.push({ kind: "del", text: a[i], before: i + 1 });
      removed += 1;
      i += 1;
    } else {
      lines.push({ kind: "add", text: b[j], after: j + 1 });
      added += 1;
      j += 1;
    }
  }
  for (; i < a.length; i++) {
    lines.push({ kind: "del", text: a[i], before: i + 1 });
    removed += 1;
  }
  for (; j < b.length; j++) {
    lines.push({ kind: "add", text: b[j], after: j + 1 });
    added += 1;
  }

  return { lines: collapse(lines), added, removed, tooLarge: false };
}
