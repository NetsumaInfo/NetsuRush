// Modèle de données + helpers du module Carnet (Notebook). SOURCE UNIQUE des types métier, importés
// à la fois par le store, les composants et le bridge. Un carnet = un espace ; il contient un ARBRE de
// pages ; chaque page = un document par blocs (BlockNote) + d'éventuelles databases (bloc /database).
import i18n from "@/i18n";

// Bloc BlockNote sérialisé — on ne type pas l'intérieur (dépend de la lib) : c'est du JSON opaque.
export type NoteBlock = Record<string, unknown>;

export type NotebookKind = "notes" | "project" | "script" | "research" | "journal";
export type NotebookLanguage = "fr" | "en" | "es" | "de" | "ja" | "zh";

// Méta d'un carnet (liste sidebar). `scriptId` = lien optionnel vers un document du module Script.
export interface NotebookMeta {
  id: string;
  title: string;
  icon: string | null;      // emoji
  scriptId: string | null;
  kind: NotebookKind;
  language: NotebookLanguage;
  updatedAt: number;
}

// Méta d'une page (nœud d'arbre, SANS le doc de blocs → sidebar légère).
export interface PageMeta {
  id: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  icon: string | null;      // emoji
  cover: string | null;     // chemin/URL d'image de couverture
  orderIdx: number;
  updatedAt: number;
}

// Page complète (méta + document de blocs).
export interface NotebookPage extends PageMeta {
  blocks: NoteBlock[];
}

// Nœud d'arbre pour le rendu récursif de la sidebar.
export interface PageTreeNode extends PageMeta {
  children: PageTreeNode[];
  depth: number;
}

// ---- Database (bloc /database d'une page) -------------------------------------------------
// Types de champ : createdTime/lastEditedTime = horodatage AUTO de la
// ligne (lecture seule), pas une cellule éditable.
export type FieldType =
  | "text" | "number" | "select" | "multiSelect" | "date" | "checkbox" | "url" | "checklist"
  | "createdTime" | "lastEditedTime";

export interface SelectOption {
  id: string;
  label: string;
  color: string;   // clé de DB_COLORS
}

// ---- Formats de nombre (sous-ensemble utile) ------------------------------------------------
export type NumberFormat = "plain" | "integer" | "percent" | "euro" | "dollar";
export const NUMBER_FORMAT_LABELS: Record<NumberFormat, string> = {
  get plain() { return i18n.t("notebook:numberLabels.number"); },
  get integer() { return i18n.t("notebook:numberLabels.integer"); },
  get percent() { return i18n.t("notebook:numberLabels.percent"); },
  get euro() { return i18n.t("notebook:numberLabels.euro"); },
  get dollar() { return i18n.t("notebook:numberLabels.dollar"); },
};
export function formatNumber(value: unknown, fmt: NumberFormat | undefined): string {
  const n = typeof value === "number" ? value : value === "" || value == null ? NaN : Number(value);
  if (isNaN(n)) return "";
  switch (fmt) {
    case "integer": return String(Math.round(n));
    case "percent": return `${+n.toFixed(2)} %`;
    case "euro": return new Intl.NumberFormat(i18n.language, { style: "currency", currency: "EUR" }).format(n);
    case "dollar": return new Intl.NumberFormat(i18n.language, { style: "currency", currency: "USD" }).format(n);
    default: return Number.isInteger(n) ? String(n) : String(+n.toFixed(4));
  }
}

// ---- Formats de date + heure optionnelle ---------------------------------------------------
export type DateFormat = "friendly" | "iso" | "us" | "dmy";
export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  friendly: "12 mars 2024", iso: "2024-03-12", us: "03/12/2024", dmy: "12/03/2024",
};
export function formatDate(value: unknown, fmt: DateFormat = "friendly", includeTime = false): string {
  const s = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return "";
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  let out: string;
  switch (fmt) {
    case "iso": out = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; break;
    case "us": out = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`; break;
    case "dmy": out = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; break;
    default: out = d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
  }
  if (includeTime && s.length > 10) out += ` ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return out;
}

// Horodatage (ms) → date+heure FR (CreatedTime / LastEditedTime).
export function formatTimestamp(ms: unknown): string {
  const n = typeof ms === "number" ? ms : Number(ms);
  if (!n || isNaN(n)) return "";
  return new Date(n).toLocaleString("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Élément d'une cellule « Liste de tâches » (checklist) : cases cochables + progression.
export interface ChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

// Calcul de colonne (pied de table) : agrégat affiché sous chaque champ.
export type CalcType = "none" | "count" | "empty" | "filled" | "sum" | "avg" | "median" | "min" | "max";

export const CALC_LABELS: Record<CalcType, string> = {
  get none() { return i18n.t("notebook:dbUi.calc.none"); }, get count() { return i18n.t("notebook:dbUi.calc.count"); }, get empty() { return i18n.t("notebook:dbUi.calc.empty"); }, get filled() { return i18n.t("notebook:dbUi.calc.filled"); },
  get sum() { return i18n.t("notebook:dbUi.calc.sum"); }, get avg() { return i18n.t("notebook:dbUi.calc.avg"); }, get median() { return i18n.t("notebook:dbUi.calc.median"); }, get min() { return i18n.t("notebook:dbUi.calc.min"); }, get max() { return i18n.t("notebook:dbUi.calc.max"); },
};

// Calculs disponibles selon le type de champ :
// Count partout ; Vides/Remplies sauf types non-vidables (URL, checkbox, timestamps) ; Somme/Moyenne/Médiane/Min/Max pour Nombre.
export function calcsForField(type: FieldType): CalcType[] {
  const out: CalcType[] = ["none", "count"];
  if (!["url", "checkbox", "createdTime", "lastEditedTime"].includes(type)) out.push("empty", "filled");
  if (type === "number") out.push("sum", "avg", "median", "min", "max");
  return out;
}

export interface DbField {
  id: string;
  name: string;
  type: FieldType;
  isPrimary?: boolean;       // champ titre (1re colonne) : type verrouillé, indélébile
  options?: SelectOption[];  // select / multiSelect
  width?: number;            // largeur de colonne (table)
  numberFormat?: NumberFormat; // TypeOption nombre
  dateFormat?: DateFormat;     // TypeOption date
  includeTime?: boolean;       // date avec heure
}

// Une ligne : cells[fieldId] = valeur (type selon le champ). select→optionId, multiSelect→optionId[],
// checkbox→bool, date→ISO string, number→number, text/url→string. createdAt/updatedAt = métadonnées
// (ms epoch) alimentant les champs CreatedTime / LastEditedTime.
export interface DbRow {
  id: string;
  cells: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

// Valeur d'affichage d'une cellule pour un champ : les horodatages viennent des métadonnées de ligne,
// pas des cells. Utilisé par toutes les vues (table/kanban/galerie/liste/détail).
export function cellValueFor(field: DbField, row: DbRow): unknown {
  if (field.type === "createdTime") return row.createdAt ?? null;
  if (field.type === "lastEditedTime") return row.updatedAt ?? null;
  return row.cells[field.id];
}

export type FilterOp =
  | "is" | "isNot" | "contains" | "notContains" | "isEmpty" | "notEmpty"
  | "gt" | "gte" | "lt" | "lte" | "checked" | "unchecked";

export interface FilterCond {
  id: string;
  fieldId: string;
  op: FilterOp;
  value: unknown;
}

export interface SortRule {
  fieldId: string;
  dir: "asc" | "desc";
}

export type ViewType = "table" | "kanban" | "gallery" | "calendar" | "list";

// Libellés + type par défaut à la création d'une vue.
export const VIEW_LABELS: Record<ViewType, string> = {
  get table() { return i18n.t("notebook:dbUi.view.table"); }, get kanban() { return i18n.t("notebook:dbUi.view.kanban"); }, get gallery() { return i18n.t("notebook:dbUi.view.gallery"); }, get calendar() { return i18n.t("notebook:dbUi.view.calendar"); }, get list() { return i18n.t("notebook:dbUi.view.list"); },
};

export interface DbView {
  id: string;
  name: string;
  type: ViewType;
  filters: FilterCond[];
  sorts: SortRule[];
  groupFieldId: string | null;   // kanban : champ select de regroupement
  hiddenFieldIds?: string[];
  calcs?: Record<string, CalcType>;  // table : agrégat par champ (pied de colonne)
  rowHeight?: RowHeight;             // table : hauteur des lignes
  hiddenGroupKeys?: string[];        // kanban : colonnes (options) masquées dans cette vue
}

export type RowHeight = "short" | "medium" | "tall";
export const ROW_HEIGHT_PX: Record<RowHeight, number> = { short: 32, medium: 40, tall: 56 };
export const ROW_HEIGHT_LABELS: Record<RowHeight, string> = {
  get short() { return i18n.t("notebook:dbUi.rowHeight.short"); }, get medium() { return i18n.t("notebook:dbUi.rowHeight.medium"); }, get tall() { return i18n.t("notebook:dbUi.rowHeight.tall"); },
};

export interface Database {
  id: string;
  name: string;
  fields: DbField[];
  rows: DbRow[];
  views: DbView[];
  activeViewId: string;
}

// Palette d'étiquettes (options select + colonnes kanban), thémée sur des teintes douces sombres.
export const DB_COLORS: { key: string; label: string; bg: string; fg: string }[] = [
  { key: "gray", get label() { return i18n.t("notebook:dbUi.color.gray"); }, bg: "#3a3f4b", fg: "#e3e4e8" },
  { key: "blue", get label() { return i18n.t("notebook:dbUi.color.blue"); }, bg: "#2b4a7e", fg: "#dbe7ff" },
  { key: "green", get label() { return i18n.t("notebook:dbUi.color.green"); }, bg: "#2c5b43", fg: "#d6f5e3" },
  { key: "yellow", get label() { return i18n.t("notebook:dbUi.color.yellow"); }, bg: "#6b5a1f", fg: "#fbf1c7" },
  { key: "orange", get label() { return i18n.t("notebook:dbUi.color.orange"); }, bg: "#7a481f", fg: "#ffe4cc" },
  { key: "red", get label() { return i18n.t("notebook:dbUi.color.red"); }, bg: "#7a2f34", fg: "#ffd9dc" },
  { key: "purple", get label() { return i18n.t("notebook:dbUi.color.purple"); }, bg: "#4e336e", fg: "#ecdcff" },
  { key: "pink", get label() { return i18n.t("notebook:dbUi.color.pink"); }, bg: "#6e3355", fg: "#ffd9ee" },
];

// Champ primaire (1re colonne = titre de la ligne) + 1er champ date (vue calendrier).
export function primaryField(db: Database): DbField | undefined {
  return db.fields.find((f) => f.isPrimary) || db.fields[0];
}
export function firstDateField(fields: DbField[]): DbField | undefined {
  return fields.find((f) => f.type === "date");
}

export function colorOf(key: string): { bg: string; fg: string } {
  const c = DB_COLORS.find((x) => x.key === key);
  return c ? { bg: c.bg, fg: c.fg } : { bg: DB_COLORS[0].bg, fg: DB_COLORS[0].fg };
}

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  get text() { return i18n.t("notebook:dbUi.field.text"); }, get number() { return i18n.t("notebook:dbUi.field.number"); },
  get select() { return i18n.t("notebook:dbUi.field.select"); }, get multiSelect() { return i18n.t("notebook:dbUi.field.multiSelect"); },
  get date() { return i18n.t("notebook:dbUi.field.date"); }, get checkbox() { return i18n.t("notebook:dbUi.field.checkbox"); },
  get url() { return i18n.t("notebook:dbUi.field.url"); }, get checklist() { return i18n.t("notebook:dbUi.field.checklist"); },
  get createdTime() { return i18n.t("notebook:dbUi.field.createdTime"); }, get lastEditedTime() { return i18n.t("notebook:dbUi.field.lastEditedTime"); },
};

// Id client (avant persistance ; le core en régénère un si absent). Court, sans dépendance.
export function nbId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Construit l'arbre de pages (roots) à partir des métas plates, trié par orderIdx à chaque niveau.
export function buildPageTree(pages: PageMeta[]): PageTreeNode[] {
  const byParent = new Map<string | null, PageMeta[]>();
  for (const p of pages) {
    const key = p.parentId ?? null;
    const arr = byParent.get(key) || [];
    arr.push(p);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.orderIdx - b.orderIdx);
  const build = (parentId: string | null, depth: number): PageTreeNode[] =>
    (byParent.get(parentId) || []).map((p) => ({ ...p, depth, children: build(p.id, depth + 1) }));
  return build(null, 0);
}

// Chaîne d'ancêtres d'une page (racine → parent direct), pour le fil d'Ariane.
export function pageAncestors(pages: PageMeta[], pageId: string): PageMeta[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out: PageMeta[] = [];
  let cur = byId.get(pageId);
  const seen = new Set<string>([pageId]);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    const parent = byId.get(cur.parentId);
    if (!parent) break;
    seen.add(parent.id);
    out.unshift(parent);
    cur = parent;
  }
  return out;
}

// ---- Onglets (multi-documents ouverts) -----------------------------------------
// Un onglet = une page affichée + son historique de navigation propre (flèches ◀▶ du fil).
export interface NbTab {
  id: string;
  pageId: string;
  hist: string[];   // pages visitées dans CET onglet
  histIdx: number;  // position dans hist (back/forward)
}

// Lien interne `nbpage:<pageId>` ou `nbpage:<pageId>#<blockId>` (ancre vers un bloc précis).
export const NBPAGE_LINK_PREFIX = "nbpage:";
export function parseNbLink(href: string): { pageId: string; blockId?: string } | null {
  let s = String(href || "").trim();
  if (s.startsWith(NBPAGE_LINK_PREFIX)) s = s.slice(NBPAGE_LINK_PREFIX.length);
  else return null;
  if (!s) return null;
  const [pageId, blockId] = s.split("#");
  return pageId ? { pageId, blockId: blockId || undefined } : null;
}

// Ids d'une page + toute sa descendance (garde-fou anti-cycle côté renderer).
export function subtreeIds(pages: PageMeta[], rootId: string): string[] {
  const childrenOf = (pid: string) => pages.filter((p) => (p.parentId ?? null) === pid).map((p) => p.id);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (pid: string) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    out.push(pid);
    for (const c of childrenOf(pid)) walk(c);
  };
  walk(rootId);
  return out;
}

// Statistiques d'un document (menu ⋯ du document) : mots + caractères du texte inline, blocs imbriqués
// inclus. Miroir renderer du blockText() du core (mêmes formes de contenu BlockNote).
export function pageStats(blocks: NoteBlock[]): { words: number; chars: number } {
  let text = "";
  const walk = (bs: NoteBlock[]) => {
    for (const b of bs || []) {
      if (!b || typeof b !== "object") continue;
      const content = (b as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== "object") continue;
          const cc = c as { text?: unknown; props?: { label?: unknown }; content?: { text?: unknown }[] };
          if (typeof cc.text === "string") text += cc.text;
          else if (typeof cc.props?.label === "string") text += cc.props.label;
          else if (Array.isArray(cc.content)) for (const x of cc.content) if (typeof x?.text === "string") text += x.text;
        }
        text += "\n";
      }
      const kids = (b as { children?: unknown }).children;
      if (Array.isArray(kids)) walk(kids as NoteBlock[]);
    }
  };
  walk(blocks);
  const trimmed = text.trim();
  return { words: trimmed ? trimmed.split(/\s+/).length : 0, chars: trimmed.replace(/\n/g, "").length };
}

// Database vierge (à la création du bloc /database) : 1 champ titre + 1 champ statut + vues table/kanban.
export function makeEmptyDatabase(id: string): Database {
  const titleField: DbField = { id: nbId(), name: i18n.t("notebook:dbDefaults.titleField"), type: "text", isPrimary: true, width: 220 };
  const statusField: DbField = {
    id: nbId(),
    name: i18n.t("notebook:dbDefaults.statusField"),
    type: "select",
    width: 160,
    options: [
      { id: nbId(), label: i18n.t("notebook:dbDefaults.todo"), color: "gray" },
      { id: nbId(), label: i18n.t("notebook:dbDefaults.inProgress"), color: "blue" },
      { id: nbId(), label: i18n.t("notebook:dbDefaults.done"), color: "green" },
    ],
  };
  const tableView: DbView = { id: nbId(), name: i18n.t("notebook:dbDefaults.tableView"), type: "table", filters: [], sorts: [], groupFieldId: null };
  const kanbanView: DbView = { id: nbId(), name: i18n.t("notebook:dbUi.view.kanban"), type: "kanban", filters: [], sorts: [], groupFieldId: statusField.id };
  const now = Date.now();
  const row = (): DbRow => ({ id: nbId(), cells: {}, createdAt: now, updatedAt: now });
  return {
    id,
    name: i18n.t("notebook:dbDefaults.name"),
    fields: [titleField, statusField],
    rows: [row(), row(), row()],
    views: [tableView, kanbanView],
    activeViewId: tableView.id,
  };
}
