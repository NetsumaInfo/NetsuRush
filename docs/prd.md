# NetsuRush — PRD

> Application de bureau autonome qui pilote les logiciels de montage **de l'extérieur**.
> Hub de post-production : derush, recherche de plans, traitements GPU, référence, transfert.

## 1. Vision

Une surface unique, posée à côté du logiciel de montage, qui regroupe tout ce qui entoure le
montage lui-même : trier et découper les rush, retrouver un plan, traiter une image, rassembler
des références, faire passer une timeline d'un logiciel à l'autre. On reprend les *idées*
d'autres projets de la communauté, jamais leur code.

Le pari : ces tâches n'ont pas besoin de vivre *dans* le NLE. Les faire à l'extérieur permet de
servir Resolve, Premiere et After Effects avec la même application, et de ne dépendre d'aucun
runtime imposé par un éditeur.

## 2. Contraintes et faits techniques

- **Application Tauri standalone** : coquille Rust (WebView2) qui spawn un service Node « core »
  local en HTTP/SSE sur `127.0.0.1:8730`. Aucun plugin, aucun runtime hôte emprunté.
- **Resolve Studio** requis seulement pour les fonctions projet (la version gratuite n'expose pas
  l'API scripting), avec un projet ouvert et *Préférences ▸ Système ▸ Général ▸ Scripting externe*
  réglé sur `Local`. Le reste de l'application fonctionne sans Resolve.
- Accès Resolve par **pont Python externe** (`DaVinciResolveScript`), réexposé côté JS par un
  `Proxy` — la frame-math reste écrite en JavaScript.
- Accès Premiere / After Effects par une **extension CEP** (panneau dockable, ExtendScript).
  CEP et non UXP : UXP n'existe pas sur After Effects, et n'arrive sur Premiere qu'en 25.6+.
- **Lecture = proxy HEVC** : WebView2 décode le HEVC (`hvc1`) via `<video>`, mais la source brute
  ne se lit pas toujours → ffmpeg transcode un proxy court (NVENC quand le GPU le permet), servi
  en HTTP `/media`. Un lecteur natif libmpv couvre les cas que WebView2 refuse.
- ML (détection de plans, embeddings, ASR, upscale, segmentation) = **sidecars Python** dans un
  venv local, lancés et supervisés par le core.
- **Windows d'abord.** NVIDIA, AMD et Intel sont accélérés lorsque leur runtime passe la sonde ;
  le CPU prend le relais automatiquement.

## 3. Modules

| Module | Nom produit | Rôle | État |
|--------|-------------|------|------|
| Derush | **NetsuCut** | Preview des rush, détection de plans IA, découpe lossless, timeline frame-accurate, collections, timeline live | livré (cœur) |
| Recherche | **NetsuSearch** | Recherche de plans en langage naturel (SigLIP 2), doublons, visages, personnages nommés | livré |
| Référence | **NetsuBoard** | Board infini images / vidéos / YouTube, notes, cadres, dessin, fenêtre détachable, format `.netsu` | livré |
| Carnet | **NetsuBook** | Notes structurées, pages liées, bases de données, exports | livré |
| Script | **NetsuDraft** | Écriture script-first, paragraphe = plan, montage depuis le texte | livré |
| Traitements | **NetsuLab** | Upscale, interpolation, profondeur, détourage, matte, suppression d'objet, Roto Studio (SAM) | livré |
| Voix | **NetsuTalk** | Transcription word-level, suppression des silences, sous-titres, montage par texte | livré, runtime partiellement non testé |
| Chat IA | **NetsuPilot** | Copilote agentique sur les outils de l'app | livré, runtime non testé |
| Optimisation | **NetsuBoost** | Diagnostic et libération des ressources de l'hôte | livré |
| Transfert | **NetsuBridge** | Recopie d'une timeline d'un logiciel vers un autre | livré, runtime Adobe non testé |
| Export AE | — | Export d'une timeline vers After Effects (`.jsx`) | livré |

Les modules marqués « runtime non testé » compilent et passent leurs tests, mais exigent un
logiciel tiers, un GPU ou des modèles téléchargés pour être exercés de bout en bout.

## 4. Architecture

```
src-tauri/        coquille Rust : fenêtre WebView2, flag HEVC, lecteur natif mpv,
      │ spawn     spawn/kill du core
core/server.js    service Node :8730 (headless)
  ├─ media-server → /media (Range/seek) + /stream (ffmpeg live)
  ├─ rpc          → POST /rpc + SSE /events (315 canaux)
  ├─ resolve-bridge + resolve_helper.py → pont Python externe vers Resolve
  ├─ adobe        → jobs aller-retour vers le panneau CEP
  ├─ timeline     → buildTimeline frame-accurate (3 invariants)
  └─ ffmpeg · thumbs · proxy · sidecars · export · transfer · netsu · roto · voice
      │ HTTP/SSE
src/              renderer React (lib/bridge.ts → coreClient.ts)
adobe-cep/        extension CEP Premiere / After Effects
python/           sidecars ML (détection, recherche, upscale, roto, voix)
convex/           backend d'authentification (gate bêta Discord)
```

## 5. Invariants produit

Trois règles ont chacune corrigé un bug réel et ne doivent pas être cassées :

1. **Timeline frame-accurate** — la timeline référence le MediaPoolItem d'origine en in/out
   frames, jamais un fichier ré-exporté. `endFrame` est inclusif ; le fps de la timeline est
   forcé sur celui du clip *avant* sa création ; l'espace-frames du détecteur est remappé sur
   celui de l'hôte.
2. **Découpe lossless** — `-c copy`, jamais de réencodage.
3. **Le décodage vidéo est la ressource critique** — aucune animation JavaScript sur les grilles,
   aucun `<video>` monté hors écran, aucun fond animé pendant un traitement lourd.

## 6. Hors périmètre

- macOS et Linux (le lecteur natif, le panneau CEP et le packaging sont Windows).
- Backend cloud de partage de presets.
- DaVinci Resolve en version gratuite, pour les fonctions projet.

## 7. Risques

- L'**API scripting Resolve** est Studio-only, et ses noms de propriétés (`File Path`, `FPS`,
  `Frames`…) sont sensibles à la casse.
- Le **support ExtendScript de Premiere Pro s'arrête en septembre 2026** ; After Effects n'a pas
  d'UXP, donc CEP y reste la seule voie. Toute fonction adossée au QE DOM doit porter son repli.
- **Précision des coupes** : drift dès que le fps de la timeline diffère de celui du clip.
- **GPU / VRAM** : plusieurs modèles lourds peuvent être demandés en même temps — d'où un
  ordonnanceur central et des portails d'encodage.
- **Licences** : les modèles et poids tiers ont leurs propres conditions, parfois non
  commerciales. Voir `docs/licensing.md`.

## 8. Stack

- **Tauri v2** (Rust, WebView2) · Node 22 (core, CommonJS) · Python 3.10–3.12 (sidecars).
- React 19 · Vite 7 · TypeScript 5.8 · Tailwind CSS **v4** (CSS-first, pas de config JS).
- **shadcn/ui flavor Base UI** (jamais Radix) · zustand 5 · lucide-react · framer-motion.
- ffmpeg / ffprobe (CLI) · libmpv (lecteur natif) · SQLite via `node:sqlite`.
