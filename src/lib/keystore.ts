// Coffre de clés API (BYOK) chiffré au repos via Tauri Stronghold. Les clés ne sont JAMAIS écrites en
// clair : Stronghold chiffre le snapshot. Au runtime, le renderer les charge puis les pousse au core
// (nr.chat.configure) qui les garde EN RAM (le core, process Node séparé, ne lit jamais le coffre).
//
// Import dynamique tolérant : le build n'exige pas le paquet (@tauri-apps/plugin-stronghold) ; absent
// ou hors Tauri → no-op gracieux (les clés vivent alors le temps de la session, saisies à la main).

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const VAULT_PASSWORD = "netsurush-byok-vault-v1"; // chiffre le snapshot local (pas un secret partagé)
const CLIENT = "byok";
const SNAPSHOT = "netsurush.stronghold";

export type KeyName = "anthropic" | "openai" | "openrouter";
export interface ApiKeys { anthropic: string; openai: string; openrouter: string }

// Charge le module Stronghold sans que tsc/Vite n'exige sa présence (résolution dynamique).
async function loadStronghold(): Promise<any | null> {
  if (!isTauri) return null;
  try {
    const pkg = "@tauri-apps/plugin-stronghold";
    const mod = await import(/* @vite-ignore */ pkg);
    const { appLocalDataDir } = await import("@tauri-apps/api/path");
    const path = `${await appLocalDataDir()}/${SNAPSHOT}`;
    const stronghold = await mod.Stronghold.load(path, VAULT_PASSWORD);
    let client;
    try { client = await stronghold.loadClient(CLIENT); }
    catch { client = await stronghold.createClient(CLIENT); }
    return { stronghold, store: client.getStore() };
  } catch {
    return null;
  }
}

const dec = new TextDecoder();
const enc = new TextEncoder();

export async function loadKeys(): Promise<ApiKeys> {
  const sh = await loadStronghold();
  if (!sh) return { anthropic: "", openai: "", openrouter: "" };
  const read = async (k: KeyName): Promise<string> => {
    try { const v = await sh.store.get(k); return v ? dec.decode(new Uint8Array(v)) : ""; }
    catch { return ""; }
  };
  return { anthropic: await read("anthropic"), openai: await read("openai"), openrouter: await read("openrouter") };
}

export async function saveKey(name: KeyName, value: string): Promise<boolean> {
  const sh = await loadStronghold();
  if (!sh) return false;
  try {
    await sh.store.insert(name, Array.from(enc.encode(value)));
    await sh.stronghold.save();
    return true;
  } catch {
    return false;
  }
}

export const keystoreAvailable = isTauri;
