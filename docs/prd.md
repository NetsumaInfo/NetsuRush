# NetsuRush — PRD

> Application de bureau autonome qui pilote les logiciels de montage **de l'extérieur**.
> Hub de post-production : derush, recherche de plans, traitements GPU, référence, transfert.
> Puis, en phase 2 : découverte de tutoriels et échange communautaire autour de DaVinci Resolve.

## 1. Vision

Une surface unique, posée à côté du logiciel de montage, qui regroupe tout ce qui entoure le
montage lui-même : trier et découper les rush, retrouver un plan, traiter une image, rassembler
des références, faire passer une timeline d'un logiciel à l'autre. On reprend les *idées*
d'autres projets de la communauté, jamais leur code.

Le pari : ces tâches n'ont pas besoin de vivre *dans* le NLE. Les faire à l'extérieur permet de
servir Resolve, Premiere et After Effects avec la même application, et de ne dépendre d'aucun
runtime imposé par un éditeur.

### 1.1 Deux actes

**Acte 1 — l'outillage local (en cours).** Les modules de la section 3 : tout tourne sur la
machine de l'utilisateur, sans compte obligatoire au-delà du gate bêta, sans serveur à payer.
C'est le périmètre à stabiliser avant tout le reste.

**Acte 2 — la découverte et la communauté (planifié).** DaVinci Resolve souffre d'un problème
que Premiere et After Effects n'ont pas : le savoir existe, mais il est *introuvable*. Les
tutoriels sont dispersés sur des petites chaînes YouTube mal référencées ; les scripts, macros
Fusion, DCTL, PowerGrades et plugins vivent dans quelques poches de communauté (forums,
Discord, dépôts isolés) que personne ne trouve en arrivant. Pourtant, la force propre de
Resolve est justement la facilité à *créer* et *partager* des presets et des outils.

NetsuRush ajoute donc deux surfaces adossées à un serveur du projet :

- **NetsuLearn** — découverte de tutoriels : page d'accueil éditoriale (populaires par thème,
  dernières sorties, chaînes qui montent), annuaire de chaînes par spécialité, et recherche
  qui rend une requête métier (« tracker un masque en Fusion ») sur le tutoriel adapté.
- **NetsuHub** — échange communautaire : scripts, macros, presets, plugins, avec une aide à
  l'installation dans Resolve, plus un forum de demandes (tutoriel manquant, preset cherché,
  entraide).

L'acte 2 est lancé progressivement sur le site : forum public, annuaire de chaînes et recherche
sur les métadonnées précèdent le stockage de fichiers, l'installation assistée et la vente. Cette
séparation permet de mesurer l'intérêt et la charge de modération sans rendre les outils locaux
dépendants d'un serveur. Conception, coûts, sécurité, monétisation et ordre de livraison :
[`community-hub.md`](community-hub.md).

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
| Tutoriels | **NetsuLearn** | Fil éditorial, annuaire de chaînes par spécialité, recherche de tutoriels Resolve | planifié (phase 2) |
| Communauté | **NetsuHub** | Scripts, macros Fusion, presets et plugins ; installation assistée dans Resolve ; forum de demandes | planifié (phase 2) |

Les modules marqués « runtime non testé » compilent et passent leurs tests, mais exigent un
logiciel tiers, un GPU ou des modèles téléchargés pour être exercés de bout en bout.
Les modules « planifié (phase 2) » ne sont **pas** commencés : ils dépendent d'un serveur du
projet et d'un signal d'adoption. Voir [`community-hub.md`](community-hub.md).

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
2. **Découpe lossless** — `-c copy`, jamais de réencodage. La coupe se cale donc sur les images
   clés (quelques images en trop, l'UI le signale) ; seul le réencodage coupe à l'image.
3. **Le décodage vidéo est la ressource critique** — aucune animation JavaScript sur les grilles,
   aucun `<video>` monté hors écran, aucun fond animé pendant un traitement lourd.

## 6. Hors périmètre

- macOS et Linux (le lecteur natif, le panneau CEP et le packaging sont Windows).
- DaVinci Resolve en version gratuite, pour les fonctions projet.
- **Phase 1 uniquement** : tout ce qui exige un serveur du projet — catalogue de presets, fil de
  tutoriels, forum, comptes au-delà du gate bêta. Ce n'est pas abandonné, c'est l'acte 2
  ([`community-hub.md`](community-hub.md)).
- **Définitivement hors périmètre** : héberger ou réencoder la vidéo des tutoriels (on renvoie
  vers YouTube via le lecteur officiel), et exécuter automatiquement du code communautaire.

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

Risques propres à l'acte 2 (détaillés dans [`community-hub.md`](community-hub.md)) :

- **Dépendance à YouTube** : quotas granulaires de l'API Data v3, règles de conservation des
  métadonnées et clé qui doit rester côté serveur.
  Les vidéos se regardent dans le **lecteur embarqué officiel** : la vue compte pour le créateur
  et la chaîne est mise en avant — l'app n'héberge et ne réencode jamais la vidéo.
- **Coût récurrent du serveur**, sans revenu garanti : c'est la raison du gate sur l'adoption.
- **Chaîne d'approvisionnement** : un script, un DCTL ou une macro Fusion communautaire est du
  code exécuté par Resolve. L'app ne l'exécute jamais d'elle-même.
- **Modération** : c'est le mur où meurent les plateformes de partage solo.

## 8. Stack

- **Tauri v2** (Rust, WebView2) · Node 22 (core, CommonJS) · Python 3.10–3.12 (sidecars).
- React 19 · Vite 7 · TypeScript 5.8 · Tailwind CSS **v4** (CSS-first, pas de config JS).
- **shadcn/ui flavor Base UI** (jamais Radix) · zustand 5 · lucide-react · framer-motion.
- ffmpeg / ffprobe (CLI) · libmpv (lecteur natif) · SQLite via `node:sqlite`.
