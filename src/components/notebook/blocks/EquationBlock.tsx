// Bloc custom « Équation » (KaTeX) : rendu LaTeX en mode bloc, clic = édition
// (textarea + aperçu live + palette de modèles), Ctrl+Entrée / blur = valider, Échap = annuler.
// `tex` persisté en prop. L'extension mhchem est chargée → formules chimiques via \ce{...}.
import { useEffect, useMemo, useRef, useState } from "react";
import i18n from "@/i18n";
import { createReactBlockSpec } from "@blocknote/react";
import { Sigma, SquareFunction, ChevronDown } from "lucide-react";
import { renderTex, useKatex } from "./katexEngine";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuGroup, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

// Modèles insérables à la position du curseur (palette). `caret` = offset du curseur
// APRÈS insertion, relatif au début du snippet (pour tomber dans le 1er argument à remplir).
type TexTemplate = { label: string; tex: string; caret?: number };
const templateGroups = (): { label: string; items: TexTemplate[] }[] => [
  {
    label: i18n.t("notebook:equation.group.structures"),
    items: [
      { label: i18n.t("notebook:equation.template.fraction"), tex: "\\frac{a}{b}", caret: 6 },
      { label: i18n.t("notebook:equation.template.squareRoot"), tex: "\\sqrt{x}", caret: 6 },
      { label: i18n.t("notebook:equation.template.nthRoot"), tex: "\\sqrt[n]{x}", caret: 6 },
      { label: i18n.t("notebook:equation.template.exponent"), tex: "x^{n}", caret: 3 },
      { label: i18n.t("notebook:equation.template.subscript"), tex: "x_{i}", caret: 3 },
      { label: i18n.t("notebook:equation.template.binomial"), tex: "\\binom{n}{k}", caret: 7 },
    ],
  },
  {
    label: i18n.t("notebook:equation.group.calculus"),
    items: [
      { label: i18n.t("notebook:equation.template.sum"), tex: "\\sum_{i=1}^{n} x_i" },
      { label: i18n.t("notebook:equation.template.product"), tex: "\\prod_{i=1}^{n} x_i" },
      { label: i18n.t("notebook:equation.template.integral"), tex: "\\int_{a}^{b} f(x)\\,dx" },
      { label: i18n.t("notebook:equation.template.limit"), tex: "\\lim_{x \\to \\infty} f(x)" },
      { label: i18n.t("notebook:equation.template.derivative"), tex: "\\frac{d}{dx} f(x)" },
      { label: i18n.t("notebook:equation.template.partialDerivative"), tex: "\\frac{\\partial f}{\\partial x}" },
    ],
  },
  {
    label: i18n.t("notebook:equation.group.matrices"),
    items: [
      { label: i18n.t("notebook:equation.template.matrix"), tex: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}" },
      { label: i18n.t("notebook:equation.template.determinant"), tex: "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}" },
      { label: i18n.t("notebook:equation.template.system"), tex: "\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}" },
      { label: i18n.t("notebook:equation.template.vector"), tex: "\\vec{v}" },
    ],
  },
  {
    label: i18n.t("notebook:equation.group.chemistry"),
    items: [
      { label: i18n.t("notebook:equation.template.molecule"), tex: "\\ce{H2O}" },
      { label: i18n.t("notebook:equation.template.reaction"), tex: "\\ce{2H2 + O2 -> 2H2O}" },
      { label: i18n.t("notebook:equation.template.equilibrium"), tex: "\\ce{CO2 + H2O <=> H2CO3}" },
      { label: i18n.t("notebook:equation.template.ion"), tex: "\\ce{SO4^2-}" },
    ],
  },
];

// Symboles d'accès rapide (insérés tels quels au curseur).
const QUICK_SYMBOLS = ["\\pi", "\\theta", "\\alpha", "\\beta", "\\lambda", "\\infty", "\\pm", "\\times", "\\cdot", "\\leq", "\\geq", "\\neq", "\\approx", "\\rightarrow", "\\in"];

function Equation({ tex, onCommit }: { tex: string; onCommit: (tex: string) => void }) {
  const katex = useKatex();
  const [editing, setEditing] = useState(!tex);
  const [draft, setDraft] = useState(tex);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) { setDraft(tex); box.current?.focus(); } }, [editing, tex]);
  // Le moteur arrive de façon asynchrone : d'ici là on montre la source LaTeX telle quelle plutôt
  // qu'un trou — l'équation se substitue d'elle-même au rendu suivant.
  const preview = useMemo(
    () => (katex ? renderTex(katex, editing ? draft : tex) : { html: "", error: null }),
    [katex, editing, draft, tex],
  );
  const rawTex = editing ? draft : tex;
  const previewNode = katex
    ? <span dangerouslySetInnerHTML={{ __html: preview.html }} />
    : <code className="font-mono text-sm text-muted-foreground">{rawTex}</code>;

  // Insère un snippet à la position du curseur de la textarea (remplace la sélection), puis refocus.
  const insert = (t: TexTemplate) => {
    const el = box.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + t.tex + draft.slice(end);
    setDraft(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + (t.caret ?? t.tex.length);
      el.setSelectionRange(pos, pos);
    });
  };

  if (!editing) {
    if (!tex.trim()) {
      return (
        <button type="button" onClick={() => setEditing(true)} className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground hover:border-primary hover:text-foreground">
          <Sigma className="h-4 w-4" /> {i18n.t("notebook:equation.empty")}
        </button>
      );
    }
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={i18n.t("notebook:equation.edit")}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
        className="w-full cursor-pointer overflow-x-auto rounded-lg px-2 py-2 text-center transition-colors hover:bg-muted/40"
      >
        {previewNode}
      </div>
    );
  }

  const commit = () => { onCommit(draft.trim()); setEditing(false); };
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card/60 p-2">
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger render={
            <button type="button" onMouseDown={(e) => e.preventDefault()} className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground hover:bg-accent">
              <SquareFunction className="h-3.5 w-3.5" /> {i18n.t("notebook:equation.templates")} <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          } />
          <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
            {templateGroups().map((g, i) => (
              <DropdownMenuGroup key={g.label}>
                {i > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
                {g.items.map((t) => (
                  <DropdownMenuItem key={t.label} onClick={() => insert(t)}>
                    <span className="min-w-0 flex-1 truncate">{t.label}</span>
                    <code className="ml-2 max-w-32 truncate text-[10px] text-muted-foreground">{t.tex}</code>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {QUICK_SYMBOLS.map((s) => (
            <Tooltip key={s}>
              <TooltipTrigger render={
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert({ label: s, tex: s })}
                  className="flex h-6 min-w-6 shrink-0 items-center justify-center rounded px-0.5 text-sm hover:bg-accent"
                >
                  {katex
                    ? <span dangerouslySetInnerHTML={{ __html: katex.renderToString(s, { throwOnError: false }) }} />
                    : <span className="font-mono text-xs text-muted-foreground">{s}</span>}
                </button>
              } />
              <TooltipContent><code>{s}</code></TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
      <textarea
        aria-label={i18n.t("notebook:equation.input")}
        ref={box}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          // Ne pas valider/fermer si le focus part vers la palette (symboles du bloc, ou le menu
          // « Modèles » — porté hors du bloc par le portal Base UI, d'où le test role="menu").
          const to = e.relatedTarget as HTMLElement | null;
          if (to && to.closest('[data-equation-tools], [role="menu"]')) return;
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); setDraft(tex); setEditing(false); }
        }}
        rows={3}
        placeholder={"c = \\sqrt{a^2 + b^2}   ·   \\ce{2H2 + O2 -> 2H2O}"}
        spellCheck={false}
        className="w-full resize-y rounded bg-muted/60 px-2 py-1.5 font-mono text-sm outline-none placeholder:text-muted-foreground/50"
      />
      {draft.trim() && (
        <div className={`overflow-x-auto px-1 text-center ${preview.error ? "opacity-70" : ""}`}>{previewNode}</div>
      )}
      {preview.error && draft.trim() && (
        <span className="px-1 text-[11px] text-destructive">{i18n.t("notebook:equation.error", { error: preview.error })}</span>
      )}
      <span className="px-1 text-[11px] text-muted-foreground">{i18n.t("notebook:equation.hint")}</span>
    </div>
  );
}

export const equationSpec = createReactBlockSpec(
  {
    type: "equation",
    propSchema: { tex: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <div contentEditable={false} data-equation-tools className="my-1 w-full">
        <Equation
          tex={String(block.props.tex)}
          onCommit={(tex) => editor.updateBlock(block, { type: "equation", props: { tex } } as never)}
        />
      </div>
    ),
  },
)();
