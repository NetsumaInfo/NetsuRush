// Vrais aperçus de documents dans le Carnet :
//  - PDF → rendu par PDF.js (pdfjs-dist) en <canvas>, page par page, dans un conteneur défilable.
//    Fiable quel que soit le lecteur de la WebView2 (on dessine nous-mêmes ; l'iframe restait blanche).
//  - Texte/Markdown/CSV/JSON/code → octets lus et affichés en <pre> défilable.
// Les octets viennent du serveur /media (fetch même origine). Aucune anim JS.
import { useEffect, useRef, useState } from "react";
import { createLazyModule } from "@/lib/lazyModule";
import { nr } from "@/lib/bridge";
import i18n from "@/i18n";

// PDF.js (~420 ko) est chargé PARESSEUSEMENT : un carnet sans document PDF n'a pas à le payer à
// l'ouverture de l'onglet. Le worker est BUNDLÉ par Vite (`?worker`) → module worker correct ;
// `?url` échouait silencieusement (pdfjs tentait un worker classique sur un fichier ESM →
// getDocument rejeté → « Aperçu indisponible »). Il n'est instancié qu'ici, une seule fois.
const pdfjsEngine = createLazyModule("PDF.js", async () => {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?worker"),
  ]);
  pdfjs.GlobalWorkerOptions.workerPort = new worker.default();
  return pdfjs;
});

const boxCls = "border-t border-border";
const msgCls = "flex h-40 items-center justify-center gap-1 text-sm text-muted-foreground";

function b64ToAb(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Octets d'un document. Asset local (/media?p=…) → RPC readAsset (le renderer ne peut PAS fetch /media :
// cross-origin sans CORS). URL distante → fetch normal (le serveur distant gère son CORS).
async function loadBytes(url: string): Promise<ArrayBuffer> {
  try {
    const u = new URL(url, window.location.href);
    const p = u.searchParams.get("p");
    if (p && nr.notebook?.readAsset) {
      const r = await nr.notebook.readAsset(p);
      if (r.ok && r.b64) return b64ToAb(r.b64);
    }
  } catch { /* repli fetch */ }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(String(resp.status));
  return resp.arrayBuffer();
}

export function PdfPreview({ url, label }: { url: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"load" | "ok" | "fallback" | "err">("load");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    const box = host.current;
    setState("load"); setBlobUrl(null);
    (async () => {
      const [buf, pdfjs] = await Promise.all([loadBytes(url).catch(() => null), pdfjsEngine.load()]);
      if (cancelled) return;
      if (!buf) { setState("err"); return; }
      if (!pdfjs) { setState("err"); return; }
      try {
        const pdf = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
        if (cancelled || !box) return;
        box.innerHTML = "";
        const width = box.clientWidth || 800;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: ((width - 24) / base.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.width = "100%"; canvas.style.height = "auto";
          canvas.className = "mb-2 rounded shadow-md";
          const ctx = canvas.getContext("2d");
          box.appendChild(canvas);
          if (ctx) await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        }
        if (!cancelled) setState("ok");
      } catch {
        // Repli : blob application/pdf dans une iframe (lecteur natif WebView2).
        if (cancelled) return;
        created = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
        setBlobUrl(created); setState("fallback");
      }
    })();
    return () => { cancelled = true; if (created) URL.revokeObjectURL(created); };
  }, [url]);

  if (state === "err") {
    return <div className={`${boxCls} ${msgCls}`}>{i18n.t("notebook:preview.unavailable")} — <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">{i18n.t("notebook:preview.openPdf")}</a></div>;
  }
  if (state === "fallback" && blobUrl) {
    return <iframe src={blobUrl} title={label} sandbox="" className={`${boxCls} h-[600px] w-full border-0 bg-white`} />;
  }
  return (
    <div className={boxCls}>
      {state === "load" && <div className={msgCls}>{i18n.t("notebook:preview.loadingPdf", { label })}</div>}
      <div ref={host} className="max-h-[620px] overflow-y-auto bg-[color:var(--color-surface)] p-3" style={{ display: state === "ok" ? "block" : "none" }} />
    </div>
  );
}

export function TextPreview({ url }: { url: string }) {
  const [txt, setTxt] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let dead = false;
    setTxt(null); setErr(false);
    loadBytes(url)
      .then((buf) => { if (!dead) setTxt(new TextDecoder().decode(buf).slice(0, 200000)); })
      .catch(() => { if (!dead) setErr(true); });
    return () => { dead = true; };
  }, [url]);
  if (err) return <div className={`${boxCls} ${msgCls}`}>{i18n.t("notebook:preview.unavailable")}</div>;
  if (txt == null) return <div className={`${boxCls} ${msgCls}`}>{i18n.t("notebook:preview.loading")}</div>;
  return <pre className={`${boxCls} max-h-[520px] overflow-auto whitespace-pre-wrap bg-[color:var(--color-surface)] p-3 font-mono text-xs text-foreground`}>{txt}</pre>;
}
