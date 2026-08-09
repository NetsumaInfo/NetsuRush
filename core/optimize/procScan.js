// @ts-check
// Scan des processus du poste, classé par usage.
//
// L'ancien scan triait les 30 premiers par working set. Une tâche de fond qui mange le CPU en tenant
// 80 Mo de RAM n'apparaissait donc nulle part, et rien ne distinguait « Windows », « l'hôte qui tient
// mon montage » et « un updater ». On lit ici, en un appel : RAM, chemin de l'exécutable, présence
// d'une fenêtre principale, et — à la demande — la charge CPU réelle mesurée par DELTA entre deux
// échantillons (`TotalProcessorTime` est un cumul depuis le démarrage : sa valeur brute ne dit rien).
//
// La présence d'une fenêtre est décisive : une application visible n'est jamais arrêtée
// automatiquement, même classée « bruit » — l'utilisateur s'en sert peut-être.

const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");

const pExecFile = promisify(execFile);

const SCAN_TIMEOUT_MS = 12_000;
const TRIM_TIMEOUT_MS = 25_000;
const LOAD_SAMPLE_MS = 700; // assez long pour un delta CPU lisible, assez court pour rester réactif

// `Path` et `TotalProcessorTime` lèvent sur les processus protégés (noyau, services système) : sans
// try/catch PowerShell interrompt TOUT le pipeline et le scan revient vide.
const SCAN_SCRIPT =
  "Get-Process | Select-Object Id,Name," +
  "@{N='ws';E={$_.WorkingSet64}}," +
  "@{N='cpuMs';E={try{$_.TotalProcessorTime.TotalMilliseconds}catch{0}}}," +
  "@{N='win';E={try{[int]($_.MainWindowHandle -ne 0)}catch{0}}}," +
  "@{N='path';E={try{$_.Path}catch{''}}} | ConvertTo-Json -Compress";

/**
 * @typedef {Object} RawProc
 * @property {number} pid
 * @property {string} name
 * @property {number} ram    octets (working set)
 * @property {number} cpuMs  temps processeur CUMULÉ depuis le démarrage du processus
 * @property {boolean} windowed
 * @property {string} path
 */

/**
 * @typedef {RawProc & {
 *   cpu: number|null,
 *   vramMB: number,
 *   kind: import('./noise').ProcClass,
 *   family: string|null,
 *   risk: string|null,
 *   restart: string|null,
 *   critical: boolean,
 * }} ScannedProc
 */

/** @param {string} stdout @returns {RawProc[]} */
function parseScan(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]; // un seul process → objet, pas tableau
  const out = [];
  for (const r of rows) {
    const pid = Number(r && r.Id);
    if (!Number.isFinite(pid)) continue;
    out.push({
      pid,
      name: String((r && r.Name) || ""),
      ram: Number(r && r.ws) || 0,
      cpuMs: Number(r && r.cpuMs) || 0,
      windowed: !!(r && r.win),
      path: String((r && r.path) || ""),
    });
  }
  return out;
}

/** Un échantillon brut de tous les processus. @returns {Promise<RawProc[]>} */
async function sampleProcesses() {
  if (process.platform !== "win32") return [];
  const { stdout } = await pExecFile("powershell", ["-NoProfile", "-Command", SCAN_SCRIPT], {
    timeout: SCAN_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseScan(stdout);
}

/**
 * Charge CPU par processus (%) entre deux échantillons, rapportée à la machine entière : 100 % = tous
 * les cœurs saturés par ce seul processus.
 * @param {RawProc[]} first @param {RawProc[]} second @param {number} elapsedMs
 * @returns {Map<number, number>}
 */
function cpuDelta(first, second, elapsedMs) {
  const cores = Math.max(1, (os.cpus() || []).length);
  const budget = elapsedMs * cores;
  const before = new Map(first.map((p) => [p.pid, p.cpuMs]));
  const out = new Map();
  if (budget <= 0) return out;
  for (const p of second) {
    const prev = before.get(p.pid);
    if (prev == null) continue; // process apparu entre les deux échantillons : pas de base de calcul
    const used = p.cpuMs - prev;
    if (!(used > 0)) continue;
    out.set(p.pid, Math.min(100, Math.round((used / budget) * 100)));
  }
  return out;
}

/**
 * @param {RawProc[]} rows
 * @param {{ classify: (name: string) => import('./noise').ProcVerdict }} classifier
 * @param {{ cpu?: Map<number, number>, vram?: Map<number, { vramMB: number }> }} [extra]
 * @returns {ScannedProc[]}
 */
function classifyRows(rows, classifier, extra = {}) {
  const cpu = extra.cpu;
  const vram = extra.vram;
  return rows.map((p) => {
    const v = classifier.classify(p.name);
    return {
      ...p,
      cpu: cpu ? (cpu.get(p.pid) ?? 0) : null,
      vramMB: vram ? (vram.get(p.pid)?.vramMB ?? 0) : 0,
      kind: v.kind,
      family: v.family,
      risk: v.risk,
      restart: v.restart,
      critical: v.critical,
    };
  });
}

/**
 * Processus de BRUIT arrêtables : jamais un critique, jamais NOTRE process, et — garde-fou principal —
 * jamais une application avec une fenêtre visible, même reconnue comme bruit.
 * @param {ScannedProc[]} procs
 * @returns {ScannedProc[]}
 */
function killableNoise(procs) {
  return procs
    .filter((p) => p.kind === "noise" && !p.critical && !p.windowed && p.pid !== process.pid)
    .sort((a, b) => b.ram - a.ram);
}

/**
 * Libère la mémoire physique inutilisée d'une LISTE de processus (`EmptyWorkingSet`) : Windows la
 * pagine sur disque, la RAM redevient disponible tout de suite. Non destructif — la page revient à la
 * demande.
 *
 * On vise des PID précis, jamais « tous les processus » : trimmer l'hôte de montage le force à
 * repaginer plusieurs gigaoctets, exactement pendant qu'on veut qu'il soit rapide.
 *
 * `Add-Type` compile du C# à la volée (~1 s à froid) — d'où l'appel groupé plutôt qu'un par PID.
 * @param {number[]} pids
 * @returns {Promise<{ ok: boolean, trimmed: number, error?: string }>}
 */
async function trimProcesses(pids) {
  if (process.platform !== "win32") return { ok: false, trimmed: 0, error: "windows-only" };
  const ids = [...new Set((pids || []).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return { ok: true, trimmed: 0 };
  const script =
    "$s='[DllImport(\"psapi.dll\")] public static extern int EmptyWorkingSet(IntPtr h);'; " +
    "Add-Type -MemberDefinition $s -Name Mem -Namespace Win32 -ErrorAction SilentlyContinue; " +
    `$ids=@(${ids.join(",")}); ` +
    "foreach($id in $ids){ try { $p=Get-Process -Id $id -ErrorAction Stop; " +
    "[Win32.Mem]::EmptyWorkingSet($p.Handle) | Out-Null } catch {} }";
  try {
    await pExecFile("powershell", ["-NoProfile", "-Command", script], { timeout: TRIM_TIMEOUT_MS });
    return { ok: true, trimmed: ids.length };
  } catch (e) {
    return { ok: false, trimmed: 0, error: String(e) };
  }
}

/**
 * Scan simple : un échantillon, pas de mesure CPU. C'est ce que consomme le watchdog — il lui faut des
 * PID de bruit, pas un classement de charge.
 * @param {{ classify: (name: string) => import('./noise').ProcVerdict }} classifier
 * @returns {Promise<ScannedProc[]>}
 */
async function scanProcesses(classifier) {
  return classifyRows(await sampleProcesses(), classifier);
}

/**
 * Scan complet : deux échantillons espacés pour la charge CPU réelle. Réservé au scan À LA DEMANDE de
 * l'interface (coût ≈ 1,5 s).
 * @param {{ classify: (name: string) => import('./noise').ProcVerdict }} classifier
 * @param {Map<number, { vramMB: number }>} [vram]
 * @returns {Promise<ScannedProc[]>}
 */
async function scanProcessesWithLoad(classifier, vram) {
  const first = await sampleProcesses();
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, LOAD_SAMPLE_MS));
  const second = await sampleProcesses();
  const cpu = cpuDelta(first, second, Date.now() - startedAt);
  return classifyRows(second, classifier, { cpu, vram });
}

module.exports = {
  parseScan,
  cpuDelta,
  classifyRows,
  killableNoise,
  trimProcesses,
  scanProcesses,
  scanProcessesWithLoad,
  LOAD_SAMPLE_MS,
};
