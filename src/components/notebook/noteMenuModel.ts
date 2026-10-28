// Pure helpers of the notebook editor's right-click menu (kept free of BlockNote imports for testing).

// Block types the "Turn into" submenu can convert between: text blocks only, never media.
export const CONVERTIBLE_BLOCKS = new Set([
  "paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem", "quote", "callout", "codeBlock",
]);

export const isConvertible = (type: string): boolean => CONVERTIBLE_BLOCKS.has(type);

interface BlockLike { id?: string; children?: BlockLike[]; [key: string]: unknown }

// A copy of a block (children included) without ids, ready for insertBlocks: BlockNote assigns new
// ones, and a duplicate id would collide with the original.
export function stripBlockIds<T extends BlockLike>(block: T): Omit<T, "id"> {
  const { id: _id, children, ...rest } = block;
  void _id;
  return { ...rest, ...(children ? { children: children.map((c) => stripBlockIds(c)) } : {}) } as Omit<T, "id">;
}

// A lone http(s) address, the only clipboard content "Link" accepts.
export function clipboardUrl(text: string): string | null {
  const url = text.trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}
