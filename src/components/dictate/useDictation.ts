import { useCallback, useEffect, useRef, useState } from "react";
import { nr } from "@/lib/bridge";
import i18n from "@/i18n";
import { describeError, logCaught, logWarn } from "@/lib/appLog";

export type DictateState = "idle" | "recording" | "transcribing";

// Ouvre le micro DEMANDÉ, et à défaut celui du système. `deviceId: {exact}` est une contrainte DURE :
// dès que l'id ne désigne plus rien (micro débranché, ids renumérotés par une réinitialisation des
// permissions), le navigateur répond OverconstrainedError et la dictée restait morte — avec pour seul
// message le nom brut de l'exception. Mieux vaut enregistrer sur le micro par défaut et le dire.
async function openMic(deviceId?: string): Promise<{ stream: MediaStream; fellBack: boolean }> {
  if (deviceId) {
    try {
      const audio = { deviceId: { exact: deviceId } };
      return { stream: await navigator.mediaDevices.getUserMedia({ audio }), fellBack: false };
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw e;
    }
  }
  return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), fellBack: !!deviceId };
}

// Message lisible : l'utilisateur voyait « NotAllowedError » ou « OverconstrainedError » tels quels.
function micErrorText(e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return i18n.t("dictate:mic.denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return i18n.t("dictate:mic.missing");
  if (name === "NotReadableError") return i18n.t("dictate:mic.busy");
  return String(e);
}

// Dictée push-to-talk. Capture le micro en PCM brut (WebAudio) et envoie un WAV auto-suffisant au core
// pour transcription (daemon whisper), puis remonte le texte via `onText`.
//
// POURQUOI DU PCM/WAV et pas MediaRecorder : l'aperçu en direct re-transcrit le buffer partiel toutes
// les ~1,4 s ; concaténer des fragments WebM en cours de flux donne un conteneur invalide (ffmpeg :
// « EBML header parsing failed »). Un WAV construit depuis les échantillons PCM accumulés est TOUJOURS
// un fichier valide, partiel comme final.
//
// APERÇU EN DIRECT (pseudo-streaming) : `onPartial` reçoit le texte au fil de la parole → « ça s'écrit
// pendant que tu parles ». Le vrai streaming faible latence (Kyutai/Nemotron) réutilisera le même
// contrat renderer (onPartial/onText) sans changer l'UI.
export function useDictation(
  onText: (t: string) => void,
  opts?: { lang?: string; model?: string; deviceId?: string; idleMs?: number; onPartial?: (t: string) => void; liveMs?: number },
) {
  const [state, setState] = useState<DictateState>("idle");
  const [err, setErr] = useState<string | null>(null);
  const audio = useRef<{ ctx: AudioContext; src: MediaStreamAudioSourceNode; proc: ScriptProcessorNode; stream: MediaStream } | null>(null);
  const pcm = useRef<Float32Array[]>([]);   // échantillons PCM accumulés (à la fréquence du contexte)
  const srcRate = useRef(16000);
  const liveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const partialBusy = useRef(false);        // évite les transcriptions partielles concurrentes

  // Options via ref pour rester stables dans les timers/handlers sans recréer start().
  const cfg = useRef(opts);
  const onTextRef = useRef(onText);
  const teardownRef = useRef<() => void>(() => {});
  // Synchronisé après chaque commit : les appelants peuvent fournir des callbacks/options inline
  // sans recréer les handlers audio ni provoquer un effet à dépendance toujours neuve.
  useEffect(() => { cfg.current = opts; onTextRef.current = onText; });

  const clearLive = () => { if (liveTimer.current) { clearInterval(liveTimer.current); liveTimer.current = null; } };

  const teardown = () => {
    clearLive();
    const a = audio.current;
    if (a) {
      try { a.proc.disconnect(); } catch { /* */ }
      try { a.src.disconnect(); } catch { /* */ }
      try { a.stream.getTracks().forEach((t) => t.stop()); } catch { /* */ }
      try { a.ctx.close(); } catch { /* */ }
    }
    audio.current = null;
  };
  teardownRef.current = teardown;

  // Le démontage doit RELÂCHER LE MICRO. `teardown()` n'était appelé que par les chemins d'arrêt
  // explicites : quitter la vue en pleine dictée laissait le flux ouvert (témoin d'enregistrement de
  // l'OS allumé, micro jamais rendu), l'AudioContext vivant et le timer de partielles en train de
  // tourner sur un composant démonté.
  useEffect(() => () => teardownRef.current(), []);

  // Construit un WAV mono au DÉBIT NATIF du micro depuis le PCM accumulé, en base64. On NE
  // sous-échantillonne PAS en JS (une décimation brute sans filtre anti-repliement crée de l'aliasing
  // → whisper transcrit n'importe quoi) : whisper/ffmpeg rééchantillonnent proprement côté core.
  const buildWavB64 = (): string | null => {
    if (!pcm.current.length) return null;
    const merged = mergeFloat(pcm.current);
    if (!merged.length) return null;
    return wavB64(merged, srcRate.current);
  };

  const start = useCallback(async () => {
    setErr(null);
    try {
      const { stream, fellBack } = await openMic(cfg.current?.deviceId);
      if (fellBack) {
        setErr(i18n.t("dictate:mic.fallback"));
        logWarn("dictée", `micro « ${cfg.current?.deviceId} » introuvable — bascule sur le micro par défaut`);
      }
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      pcm.current = [];
      srcRate.current = ctx.sampleRate;
      proc.onaudioprocess = (e) => { pcm.current.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      src.connect(proc);
      // ScriptProcessor n'émet que s'il est branché à la sortie ; gain 0 → aucun retour audio.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      proc.connect(mute);
      mute.connect(ctx.destination);
      audio.current = { ctx, src, proc, stream };
      setState("recording");

      // Aperçu en direct : re-transcrit le buffer PCM courant à cadence fixe (ignore si déjà en cours).
      const onPartial = cfg.current?.onPartial;
      if (onPartial) {
        const every = Math.max(700, cfg.current?.liveMs ?? 1400);
        liveTimer.current = setInterval(async () => {
          if (partialBusy.current) return;
          const b64 = buildWavB64();
          if (!b64) return;
          partialBusy.current = true;
          try {
            const r = await nr.dictateTranscribe({ audioB64: b64, mime: "audio/wav", lang: cfg.current?.lang, model: cfg.current?.model, idleMs: cfg.current?.idleMs });
            if (r.ok && typeof r.text === "string") onPartial(r.text);
          } catch { /* partiel best-effort */ } finally { partialBusy.current = false; }
        }, every);
      }
    } catch (e) {
      // La pastille dit ce qui se passe à l'utilisateur ; la console garde le nom exact de l'exception
      // (c'est elle qu'on relit dans un rapport de bug, pas la phrase traduite).
      logCaught("dictée", "ouverture du micro", e);
      setErr(micErrorText(e));
      teardown();
      setState("idle");
    }
  }, []);

  const stop = useCallback(async () => {
    clearLive();
    if (!audio.current) { setState("idle"); return; }
    const b64 = buildWavB64();
    teardown();
    if (!b64) { setState("idle"); return; }
    setState("transcribing");
    try {
      const r = await nr.dictateTranscribe({ audioB64: b64, mime: "audio/wav", lang: cfg.current?.lang, model: cfg.current?.model, idleMs: cfg.current?.idleMs });
      if (r.ok && r.text) onTextRef.current(r.text);
      else if (r.error) { logCaught("dictée", "transcription", r.error); setErr(r.error); }
    } catch (e) {
      logCaught("dictée", "transcription", e);
      setErr(describeError(e));
    } finally { setState("idle"); }
  }, []);

  const toggle = useCallback(() => { if (state === "recording") stop(); else start(); }, [state, start, stop]);

  return { state, err, start, stop, toggle };
}

// Concatène les blocs Float32 en un seul tampon.
function mergeFloat(parts: Float32Array[]): Float32Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Encode un WAV PCM 16 bits mono → base64 (sans préfixe data:).
function wavB64(samples: Float32Array, sampleRate: number): string {
  const bytes = 44 + samples.length * 2;
  const buf = new ArrayBuffer(bytes);
  const view = new DataView(buf);
  const put = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  put(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, "data"); view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return u8ToB64(new Uint8Array(buf));
}

// Uint8Array → base64 par blocs (évite le dépassement d'argument de String.fromCharCode).
function u8ToB64(u8: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode(...u8.subarray(i, i + chunk));
  return btoa(s);
}

// Insère du texte dans l'élément actuellement focalisé (champ, zone de texte, ou éditeur contentEditable
// façon BlockNote/tiptap). Couvre la dictée « globale » ET « dans l'éditeur » avec un seul mécanisme.
export function insertIntoFocused(text: string): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const input = el as HTMLInputElement;
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    input.value = input.value.slice(0, s) + text + input.value.slice(e);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const pos = s + text.length;
    try { input.setSelectionRange(pos, pos); } catch { /* noop */ }
    return true;
  }
  if (el.isContentEditable) {
    // execCommand est déprécié mais reste le moyen le plus compatible d'insérer dans tiptap/BlockNote.
    document.execCommand("insertText", false, text);
    return true;
  }
  return false;
}
