# Terminal IA NetsuRush — couche agent unifiée + MCP

> Architecture pour brancher un **cerveau LLM** sur la recherche SigLIP 2 via **trois backends interchangeables** (Codex CLI, Claude Code CLI, OpenRouter), tous **unifiés derrière un seul chat custom**. Complète [search-siglip2.md](search-siglip2.md) (le moteur de recherche).

---

## 1. Principe

Le LLM ne « voit » **pas** à travers SigLIP. Division des rôles :

- **SigLIP 2** (local) = **moteur de retrieval**. Transforme pixels ↔ texte en vecteurs, renvoie des plans. Rapide, gratuit, offline.
- **LLM** = **cerveau / orchestrateur**. Comprend une demande floue en français, la décompose, appelle la recherche comme un **outil** (function-calling / MCP), lit les résultats JSON, affine en plusieurs passes, agit (construit la timeline).

C'est du **visual RAG agentique** : le LLM pilote, SigLIP exécute. Aucune fusion de modèle, aucun ré-entraînement.

**Choix produit : une seule UI chat custom, trois backends interchangeables derrière.** L'utilisateur ouvre un panneau chat unique ; un sélecteur choisit le moteur. L'UI ignore lequel tourne grâce à une abstraction `AgentBackend` commune (§5).

```
user (FR) → UI chat custom NetsuRush  (1 seul panneau)
   │  sélecteur provider
   ├─ Codex CLI        sidecar spawn   (abo ChatGPT, MCP natif)
   ├─ Claude Code CLI  sidecar spawn   (abo Claude Max, MCP natif)
   └─ OpenRouter       client OpenAI-compat (clé API, boucle agent maison §5b)
   ▼  abstraction AgentBackend  (envoyer msg → stream tokens + tool-calls)
   tools ──┬─► serveur MCP "search"          ──► daemon search.py (SigLIP local)
           └─► serveur MCP "davinci-resolve"  ──► scripting API (agir DANS Resolve)
   ◄── plans triés + explication + actions Resolve, résultats cliquables dans la grille
```

L'agent ne fait pas que **chercher** : il **agit dans Resolve** (timelines, media pool, couleur, Fusion, render…) via un second serveur MCP. Deux serveurs MCP, mêmes trois backends (§4 et §4·B).

---

## 2. Trois voies pour le cerveau — dont 2 via abonnement

Révision d'un ancien caveat : **un abonnement (ChatGPT Plus/Pro, Claude Max) ≠ clé API**, mais les **CLI officiels** s'authentifient via le compte abonné et exposent une **boucle agent + tool-use déjà faite**. Donc trois backends :

| Backend | Auth | Boucle agent | Tools / MCP | Coût |
|---|---|---|---|---|
| **Codex CLI** | login **abo ChatGPT** (ou clé API OpenAI) | fournie par le CLI | **MCP natif** → on pointe sa config sur notre serveur `search` | inclus dans l'abo |
| **Claude Code CLI** | login **abo Claude Max** (ou clé API Anthropic) | fournie par le CLI | **MCP natif** → idem | inclus dans l'abo |
| **OpenRouter** | **clé API** (BYOK) | **boucle maison** (§5b) | client OpenAI-compat, on injecte les `tools` du §3 | centimes/token, ou modèle *free* |

Les **CLI** (Codex, Claude Code) parlent **MCP nativement** → on n'écrit pas de boucle agent : on déclare notre serveur MCP `search` dans **leur** config et ils l'appellent seuls. **OpenRouter** (et tout endpoint OpenAI-compat : OpenAI, Ollama local, LM Studio) passe par la **boucle agent maison** du §5b.

Conséquence design : abstraction `AgentBackend` commune (§5) qui normalise les trois en un flux unique `message → stream(tokens + tool-calls + résultats)` que l'UI consomme sans savoir quel moteur tourne.

> ⚠️ Distinguer dans l'UI : **CLI = abonnement** (login navigateur, quota du forfait, pas de clé à coller) vs **OpenRouter/OpenAI = clé API** (payant au token). Un abo ChatGPT seul **ne marche pas** en appel API direct — il faut passer **par le Codex CLI**.

---

## 3. Outils exposés (tools)

Mappés sur les commandes existantes de `search.py` (+ actions Resolve). Schémas JSON pour le function-calling.

```jsonc
// Recherche texte → plans
{ "name": "search_text",
  "description": "Cherche des plans par description en langage naturel.",
  "parameters": { "type": "object",
    "properties": {
      "query":    { "type": "string", "description": "description du plan recherché" },
      "top_k":    { "type": "integer", "default": 60 },
      "min_score":{ "type": "number", "description": "seuil de pertinence 0..1 (sigmoid calibré)" }
    }, "required": ["query"] } }

// Recherche par image (similarité visuelle)
{ "name": "search_image",
  "parameters": { "type": "object",
    "properties": { "image_path": {"type":"string"}, "top_k": {"type":"integer","default":60} },
    "required": ["image_path"] } }

// État / inventaire
{ "name": "get_status" }      // {clips, frames, model}
{ "name": "list_indexed" }    // par clip : frames, stale, thumbs

// Action : construire la timeline depuis une sélection de plans
{ "name": "build_timeline",
  "parameters": { "type": "object",
    "properties": { "segments": { "type": "array", "items": {
      "type":"object", "properties": {
        "file_path": {"type":"string"}, "start_frame":{"type":"integer"}, "end_frame":{"type":"integer"} } } } },
    "required": ["segments"] } }
```

Extensions (capacités tier A/B de SigLIP, cf. search-siglip2.md) : `classify_shot(labels[])` (tags zero-shot), `find_duplicates()`, `cluster_shots()`.

Les `hits` renvoyés portent déjà `file_path`, `scene_index`, `start_frame`/`end_frame`, `start_sec`/`end_sec`, `score`, `thumb` → le LLM enchaîne sans rappel (multi-hop).

---

## 4. Serveur MCP `search`

Emballer la recherche **une fois** en serveur MCP → réutilisable par :
- **ton terminal maison** (le produit) ;
- **un CLI externe** (Codex CLI, opencode, aider, Claude Code…) pointé dessus, sans rien recoder.

Le serveur MCP est une fine couche : il déclare les tools du §3 et route chaque appel vers le **daemon `search.py serve`** existant (protocole ligne-JSON déjà en place) — zéro changement du moteur.

```
MCP client (terminal NetsuRush | Codex CLI)
   │  list_tools / call_tool
   ▼
MCP server "search"  ──(JSON {id,cmd,...})──►  python search.py serve  (modèle chargé 1×)
   ▲                                              │
   └──────────────  hits JSON  ◄──────────────────┘
```

---

## 4·B. Serveur MCP officiel de Blackmagic — outils `bmd_*`

DaVinci Resolve **Studio 21.1+** livre son propre serveur MCP, `ResolveMCP.exe`, dans le dossier d'installation (un bundle `DaVinciResolve.mcpb` l'accompagne : même serveur, empaqueté pour l'installateur d'extensions de Claude Desktop). Aucun serveur tiers n'est vendoré, et rien n'est redistribué : le binaire vient de l'installation de l'utilisateur, et sa version suit celle de Resolve.

- **Transport** : stdio local, JSON-RPC ligne par ligne (aucun listener réseau).
- **Découverte** : `core/agent/mcp/resolveBin.js` — emplacements d'installation par plateforme, `NR_RESOLVE_MCP` pour forcer un chemin. Absent = édition gratuite ou Resolve non installé ; le reste du copilote fonctionne.
- **14 outils** : `run_script` / `run_script_unsafe` (Python 3.14 avec `resolve` et `project` pré-injectés), `search_scripting_api`, `get_scripting_api`, `get_scripting_docs`, `get_whats_new`, `list_luts` / `list_dctls`, `generate_lut`, `update_dctl`, `delete_lut` / `delete_dctl`, `launch_resolve`, `get_resolve_status`.

### Consommé par le registre, jamais branché en direct

Le serveur **n'est pas** ajouté au `.mcp.json` qu'on écrit pour les agents CLI. L'agent l'appellerait alors directement, or la porte de permission de NetsuRush ne voit que **nos** outils : « lecture seule » laisserait un script réécrire le projet.

`core/agent/tools/resolveMcp.js` le consomme donc comme client (`core/agent/mcp/client.js`) et **réenregistre ses outils dans le registre**, préfixés `bmd_`. Conséquences : une seule porte de permission, la même trace d'appel dans le panneau, et les moteurs BYOK y ont accès comme les CLI.

```
core (registre d'outils)
   ├─ resolve_*  → pont Resolve maison (Python, scripting externe)
   ├─ bmd_*      → (stdio, client) ResolveMCP.exe        ← serveur officiel
   └─ exposés aux agents CLI par mcp/stdio.js (un seul serveur : `netsurush`)
```

La liste d'outils est **lue sur le serveur**, jamais tapée ici : les schémas sont livrés avec Resolve et changent avec lui. Seul le **risque** de chaque outil nous appartient, le serveur n'ayant aucune notion de nos modes de permission. Elle arrive donc dans le registre **après** le démarrage : `session.send` attend `resolveMcp.ready()` avant de composer sa liste d'outils.

### Deux chemins vers Resolve — ne pas les confondre

| | **`resolve_*` (pont maison)** | **`bmd_*` (serveur officiel)** |
|---|---|---|
| Accès | scripting externe, pont Python du core | scripting externe, process de Blackmagic |
| Pilote | code NetsuRush déterministe, exposé au modèle outil par outil | script Python écrit par le **LLM**, à la volée |
| Rôle | derush, coupe, proxies, `resolve_call` pour un appel isolé | boucles et allers-retours longs, API à jour, LUT et DCTL |

**Invariant à protéger** : la création de timeline **frame-accurate** reste `core/timeline.js` (`endFrame` inclusif, fréquence posée avant création, remap des frames du détecteur — cf. `docs/invariants.md`). `build_timeline` route vers lui, jamais vers un script généré.

**Anti-hallucination** : `bmd_search_scripting_api` et `bmd_get_whats_new` interrogent la version **installée**. Le prompt pilote impose de chercher avant d'affirmer qu'une chose est impossible — l'agent inventait des limites d'API tirées de sa mémoire.

### Garde-fous

- **Risque par outil** (`RISK` dans `resolveMcp.js`) : lecture pour la doc et les listes, écriture pour `launch_resolve` / `update_dctl` / `generate_lut`, destructif pour les suppressions et pour `run_script` — son bac à sable protège les fichiers, pas le projet.
- **`run_script` est jugé sur pièce** (`scriptRisk`) : un script qui n'appelle que des verbes de lecture (`Get`, `Is`, `Count`, `Find`…) redevient une **lecture**, donc silencieux en mode « demander » et autorisé en « lecture seule » — inspecter son projet est précisément ce qu'on attend de ce mode. Reconnaissance par **liste blanche** : verbe inconnu, appel dynamique (`exec`, `getattr`), ou l'une des méthodes de l'API qui empruntent un verbe de lecture (`AppendToTimeline`, `CopyGrades`, `CopyTimeline`) ⇒ destructif. Une méthode d'une version future de Resolve tombe donc du côté prudent sans que le fichier ait à la connaître. `run_script_unsafe` n'est **pas** jugé ainsi : hors du bac à sable, même une lecture atteint le disque et le réseau.
- **Un outil inconnu est destructif** : une version future de Resolve qui ajoute un outil ne le fait pas entrer en lecture seule au motif que ce fichier ne le connaît pas.
- **Plafond de résultat** (`MAX_CHARS`, 200 000 caractères) : un résultat trop gros est **refusé, jamais tronqué** — un stub d'API coupé fait lire au modèle l'absence d'une classe qui existe. Le plafond passe volontairement au-dessus du stub complet (146 000 caractères mesurés, ~36 500 tokens) : le couper ferait un outil qui échoue toujours. C'est le prompt pilote qui envoie chercher (`bmd_search_scripting_api`, ~1 700 tokens) avant de tout tirer.
- **`run_script_unsafe` n'est pas enregistré par défaut.** Il donne fichiers, réseau et sous-processus complets — exactement ce que `runtimes/defs.js` refuse aux agents CLI (`--disallowedTools Bash Edit Write`), et qu'aucun mode de permission ne peut retenir une fois le script parti. Case à cocher dans les réglages du Chat, décochée.

---

## 4·C. External MCP clients — the whole app for outside agents

NetsuRush is also an MCP **server for AI apps the user runs outside it**: Claude Desktop, Claude Code, Codex, Cursor, or any stdio MCP client. They get the same registry as the in-app copilot — the derush shortcuts, the `resolve_*` and `bmd_*` catalogues, and one compound tool per app domain — under their own switch and permission mode.

```
Claude Desktop / Codex / Cursor …
   │  spawns (its own config file, written by Settings › External agents)
   ▼
node core/agent/mcp/stdio.js   NR_SURFACE=external
   │  reads NR_HOME/core-port.json on every call (port + token change at each launch)
   ▼
core  /rpc agent:toolList · agent:toolCall · agent:resources · agent:resourceRead
   │  surface 'external' → own on/off + permission mode, prompts expire after 120 s
   ▼
registry ── netsu_* (app domains) ──► the rpc channels the UI uses (H table, via `invoke`)
         ├─ resolve_* / build_timeline … (derush, frame-accurate)
         └─ bmd_* (Blackmagic's server, folded in)
```

### App-domain tools (`core/agent/tools/app/`)

One compound tool per domain, built from a declarative table (`domain.js`): each action names an **existing rpc channel**, the positional args it takes, a risk, and a one-line usage the model reads. No business logic is duplicated — an agent reaches exactly the code the UI runs. Domains: `netsu_library`, `netsu_collections`, `netsu_search` (SigLIP + faces), `netsu_characters`, `netsu_media`, `netsu_export`, `netsu_process`, `netsu_models`, `netsu_host` (projects, outbox, host power, Adobe), `netsu_notebook`, `netsu_system`, `netsu_jobs`, `netsu_rpc`, `netsu_agents`.

- **Risk per action** (`riskFor`). An action the table does not know is destructive: the gate never waves through a call it cannot classify.
- **Long actions** (indexing, exports, upscales, archives) run through `core/agent/jobs.js`: they answer inline when they finish within the wait window (20 s, `waitSeconds` up to 50) and otherwise return `{background:true, jobId}`; the agent follows it with `netsu_jobs` (`status`, `wait`, `cancel`, `list`). Progress is the last `*progress*` broadcast the core already sends the UI.
- **Media in results**: a tool adds `__images` (local image paths) and `__files` (media paths) to its JSON; `mcp/format.js` turns them into MCP image blocks and `resource_link`s and strips them from the text. The in-app engines, which speak no MCP, simply see JSON. So `netsu_media thumbnail` / `thumbnails` and search hits let the model *look* at shots.
- **Correcting data**: an agent can fix what the pipeline got wrong, not only read it. `netsu_search forget` drops a file from the shot index, the face index and/or the cached detection; `set_scenes` imposes hand-corrected shot boundaries (stored as a scene cache row of model `manual`, which `media._cached_cut` prefers over any detection — the next `index` sees the boundaries moved and re-embeds that file only); `face_label` assigns a face to a character or to nobody, kept in `face_label_overrides_v1` and re-applied after every auto-labelling run. On shots: `netsu_collections update_shot(s)` (tags, label, rating, note, bounds, name, path) and `reorder` (manual order, written as `addedAt` stamps so the default "recently added" sort shows it).
- **Sorting into folders** (`app/folders.js`, `tools/mediaPool.js`): every folder an agent targets is a **path** from the root (`"Anime/OP"`, `""` = root) or an id that must exist. Moves and imports create the missing levels; a `folderId` that is not an id is accepted only when it is the exact path of one folder, otherwise refused, since an unknown id stored as is hid the item from every view of the tree. `netsu_library` and `netsu_collections` both have `folders` (with paths), `create_folder`, `move(ids, folder)`, `rename_folder`, `move_folder` (cycles refused) and `delete_folder`; `netsu_collections move_shots` moves or copies shots between collections with their metadata. `resolve_media_pool` does the same for Resolve bins: `list_folders`, `create_folder` (looks each level up first, as `AddSubFolder` accepts duplicate names), `move_clips(paths|ids, folder)`, `move_folder`, `import(paths, folder)` (restores the current bin after), `rename_clip`, `set_clip_color`, `delete_folders`. The scripting API cannot rename a bin: renaming is create, move the content, delete. Moves are writes, deletions are destructive, so in **Ask** mode an agent sorts freely and every deletion waits for the user.
- **`netsu_rpc`**: escape hatch to any core channel (`list`, `describe` = handler source showing its positional args, `call`). Risk is read off the method name: only known read verbs are reads, anything else is destructive. Channels that would widen an agent's own rights are refused: `agent:*`, `mcp:external:*`, `chat:approval*`, `chat:configure`.
- **Data changes**: every non-read call that succeeds broadcasts `agent:dataChanged {tool, action}`, whichever engine made it (in-app API engine in `session.js`, in-app CLI, external client, sub-agent); the renderer refetches the matching store (library, collections, notebook…) so what an agent did shows up without a reload.

### Seeing an action, not a still (`core/contactSheet.js`)

One frame cannot tell what a shot does, so what an agent gets by default is a **sheet**: frames of the shot in one image, read left to right then top to bottom.

- `netsu_search run` shows its best hits as **rows**: one row of 4 frames per shot, up to 9 shots per image, about 120 tokens per shot against 350 for a shot's own sheet. `view` switches to `sheet` or `frame`, `imageHits` sets how many hits are shown, `offset` goes further down the ranking.
- `netsu_media sheet` makes a larger one (4x3 by default) for any range; `netsu_media overview` scans a rush page by page, one or up to four frames per shot, with `shots` telling which cell is which. Shots come from the index, else the cached detection, else regular slices (flagged as such).
- **Cost**: a 4x3 sheet of 240 px cells weighs what one 854 px thumbnail does (about 530 tokens), and takes 0.15 s on 720p H.264, 0.76 s on a 10-bit H.265 BluRay. A range up to 30 s is decoded in one pass, since seeking per frame would redo the same GOP; a longer one goes through the shared thumbnail cache, as does `overview`.
- **Measured on an AMV of 144 shots, with eco sub-agents, checked by eye against the shots themselves.** One still or one sheet per hit, 6 hits: 3 and 5 shots of "a hand reaching out" where about 20 exist; a full `overview` scan found them for three times the cost (0.028 $ against 0.009 $). Sheets beat stills on movement: only they caught legs running. Seeing more shots matters more than seeing each one larger, hence rows: 6 to 8 shots per search, about 0.004 $ and 24 s. A scan at 4 frames per shot found 13 for about 0.02 $ and 55 s, and still misses subtle movements such as turning around. Search ranks on still images, so it can miss a movement however it is shown: `overview` is the exhaustive route.
- **Grids carry numbers.** A shot's number is drawn on its first frame: `label` for a search hit (its first frame, with a letter per file when hits span several), `sceneIndex` in an overview. Told only "row 7 is shot 27", Haiku described one row and attributed it to the shot above or below (a girl on the phone reported as "hands reaching"). A hit's rank does not work either: an agent running two searches read a rank on one image and took that entry of the other list. The number must belong to the shot. With no font found on the machine, the grid goes unlabelled and says so (`labelled: false`). Measured after the fix, checked by eye: 13 of 13 shots right on a scan, 10 of 10 on two searches.
- Sheets live in the thumbnail folder (`sheet_<hash>.jpg`), recorded in the cache index, so Settings › Storage purges them with the thumbnails.

### Smart frames and bad cuts (`core/motion.js`)

How many frames a shot gets, and which, depends on the shot, not on a mode. A background pass decodes the file at 64x36, below the interface's priority, and keeps per frame how much the picture changed and how alike it stayed (about three bytes per frame on disk; 80 to 215 s for a 24 min BluRay episode, one file at a time). It starts by itself the first time a file is shown; until it is done, frames are placed by time, and the result says so.

- **Count**: from the shot's length and how much happens per second. A nearly fixed shot (a held shot, a slow pan) gets 3 or 4 frames however long it lasts, enough to tell what kind of shot it is and no more tokens than that; a busy one up to 6; 8 only for a very long busy shot. `framesPerShot` (2, 3, 4) forces a number.
- **Placement**: equal shares of what happens rather than of time, so a 15 s "shot" hiding three real ones shows all three. From 4 frames, the first and last sit at the very ends of the shot, where a detection hides a scene it glued on. One flash cannot capture the frames: each frame's weight is capped.
- **Why not detect the bad cuts and fix them?** Measured by eye on that episode, a jump inside a shot is a real missed cut about 1 time in 5, the rest being flashes and fast animation, however it is filtered. So `netsu_media check_cuts` reports them as hints to look at (then `netsu_search split_shot`). False cuts are reliable: comparing the structure of both sides, ignoring brightness, separated them cleanly (a fade changes every pixel yet stays the same picture; real cuts scored 0.69 at most, false ones 0.91 and more). Fix with `merge_shots`.
- Shots need not fit one row: a busy one carries on to the next, under its single number.

**What the benchmark says** (72 eco sub-agents on a 24 min BluRay episode and a 130 min film, 6 actions, 2 repetitions, scored by eye). It is the reason for the defaults, and it does not flatter them:

| Configuration | Shots found | Right | Cost per agent |
|---|---|---|---|
| 2 frames, medium effort | 53% | 93% | 0.0062 $ |
| 3 frames, medium | 50% | 90% | 0.0047 $ |
| 4 frames, medium | 56% | 90% | 0.0049 $ |
| smart, medium | 50% | 92% | 0.0049 $ |
| 3 frames, high | 54% | 93% | 0.0064 $ |
| smart, high | 47% | 90% | 0.0074 $ |

- **The frame count does not decide the result on these tasks**: two runs of one configuration differ more (43% and 57%) than the configurations do. Smart stays the default for what the table cannot show: nearly fixed shots cost 3 or 4 frames however long, and a badly cut shot shows its hidden scenes. Fixed counts remain available.
- **High effort is not worth it**: no more shots, 36 to 51% more cost, about 70% slower. Medium is the default.
- **More agents is the lever**: merging the shots of 1, 2, 4 and 8 medium agents found 51%, about 60%, 72% and 81%, at 96%, about 89%, 85% and 79% right. The reference set itself comes from merging those agents' answers, so the absolute figures are optimistic; the ordering is what to trust.

### Sub-agents (`core/agent/subagents.js`, tool `netsu_agents`)

Any agent (an external client or the in-app copilot) can fan out small agent processes on footage: `dispatch` takes explicit `tasks`, or one `prompt` spread over `files`, and returns each sub-agent's findings (one JSON line per shot). How many run at once is the `maxSubagents` setting (Settings › External agents, 1-64, default 8); tasks beyond the limit queue, across all dispatches. A dispatch is a long action: it follows the job rules above.

- **A tier, never a model.** People have different subscriptions, so the caller asks for `tier: "eco"` (default) or `"normal"` and the core resolves it on the first installed engine: Claude Code (`haiku` / `sonnet`), else Codex (the `luna` / `terra` family, newest listed in Codex's `models_cache.json`). There is deliberately no setting for it: the tool description and the server instructions tell the agent to stay on eco unless eco proved insufficient. **The Codex runtime has never run against a real subscription**; its arguments come from `codex exec --help`.

- **Cheap by construction.** Each one is `claude -p` with `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, `--no-session-persistence` and a short `--system-prompt-file`: measured 722 tokens at start, about 3 s, against the user's whole environment (MCP servers, hooks, CLAUDE.md) otherwise. `--bare` is not usable: it refuses subscription logins. Only the footage tools are listed (`TOOLS`), not the 17 000 tokens of the full registry.
- **Rights ride in the MCP surface** of the spawned server. `subagent` reads; `subagent-write` (`access: "write"`) also writes, e.g. fills collections. Neither reaches a destructive action or anything outside `TOOLS`, whatever the permission mode, and neither can dispatch further agents. They have nobody to ask, so the decision is `subagentAllows`, not the prompting gate; dispatching itself is a `write` action, so read-only mode refuses it.
- **Native route.** Installing the Claude Code client also writes `~/.claude/agents/netsu-scout.md` (`model: haiku`, footage tools only), so a Claude Code session can fan out with its own Task tool. Those run under the external permission mode. A file of that name without our marker is the user's and is left alone.

### Resources (`core/agent/resources.js`)

Read-only JSON snapshots a client can attach without a tool call: `netsurush://status`, `library`, `library/folders`, `collections`, `collections/{id}`, `notebooks`, `notebooks/{id}`, `pages/{id}`, `timelines`, `search/index`, `models`, `jobs`, `jobs/{id}`. Lists over 500 items are truncated and say so.

### Protocol

`stdio.js` answers protocol versions 2024-11-05 up to 2026-07-28 (echoes the client's, else the newest), advertises `tools` and `resources`, sends server `instructions`, and annotates each tool from its risk (`readOnlyHint`, `destructiveHint`; a compound tool is never advertised read-only). `structuredContent` accompanies plain results and is dropped when images or links ride along, so a client preferring it does not lose them. A call that cannot reach the app is a **tool error** ("NetsuRush is not running…"), not a protocol failure.

### Access and safety

- Settings › External agents: on/off, permission mode (`read-only` / `ask` / `auto`, default `ask` = only destructive actions prompt), one-click install per client, a JSON snippet for any other client, and the last 20 external calls. Stored by the core in `DATA_DIR/mcp/external.json`, so it holds with no window open.
- External approvals are shown **globally** in the app (not only in the chat panel) and denied after 120 s unanswered — the agent gets a reason, not a hung connection.
- Client config writers (`mcp/external.js`) touch only the `netsurush` entry, keep the rest of the file, back the original up once as `*.netsurush.bak`, and write atomically. Paths: Claude Desktop `%APPDATA%\Claude\claude_desktop_config.json`, Claude Code `~/.claude.json` (user scope), Codex `$CODEX_HOME/config.toml` (`[mcp_servers.netsurush]`), Cursor `~/.cursor/mcp.json`.
- The spawned command is the core's own Node (`process.execPath`: the bundled `node.exe` in a release) on `stdio.js`; `NR_HOME` rides along when overridden so the server reads the right `core-port.json`.
- `bmd_run_script_unsafe` stays off unless enabled in the Chat settings; frame-accurate timeline creation stays `build_timeline` → `core/timeline.js`.

---

## 5. Abstraction `AgentBackend` — l'interface commune

Une seule interface que l'UI consomme ; trois implémentations derrière. C'est elle qui rend les backends interchangeables.

```ts
interface AgentBackend {
  id: 'codex' | 'claude-code' | 'openrouter'
  send(messages: Msg[], opts): AsyncIterable<AgentEvent>   // streaming
  cancel(): void
}
// AgentEvent = { type:'token', text } | { type:'tool_call', name, args }
//            | { type:'tool_result', name, result } | { type:'done', content }
//            | { type:'hits', hits: Hit[] }   // plans → grille cliquable
```

L'UI s'abonne au flux d'`AgentEvent` : tokens → bulle qui se remplit, `hits` → grille hover-to-play, `tool_call`/`tool_result` → trace repliable. **Le panneau chat ne sait pas quel provider tourne.**

### 5a. Backends CLI (Codex, Claude Code) — sidecar, MCP natif

Pas de boucle agent à écrire : le CLI la fait. `main.js` **spawn** le binaire en mode non-interactif/stream-JSON et **parse stdout** en `AgentEvent`. Notre serveur MCP `search` est déclaré dans la **config MCP du CLI** (écrite par `install-plugin.mjs`) → le CLI appelle `search_text`/`build_timeline` seul.

```
main.js ──spawn──► codex / claude  (--output-format stream-json, mcp-config → search)
        ◄─stdout──  events JSON ligne-par-ligne  →  normalisés en AgentEvent  →  UI
```

- **Auth** : déléguée au CLI (login navigateur abo). On ne manipule **jamais** de token ; on vérifie juste `codex login status` / équivalent et on guide l'user sinon.
- **Annulation** : kill du process enfant.
- **Détection binaire** : chemins persistés (réglages) + auto-détecte dans le PATH.

### 5b. Backend OpenRouter (OpenAI-compat) — boucle maison

Pour OpenRouter / OpenAI / Ollama local : pas de boucle fournie → on l'écrit (chat-completions + `tools` du §3).

```
messages = [system_prompt_derush, user_msg]
loop:
    resp = llm.chat(model, messages, tools)          # stream tokens → AgentEvent
    if resp.tool_calls:
        for call in resp.tool_calls:
            args = validate(call.arguments)           # ← VALIDER (schéma strict, retry si malformé)
            result = mcp.call(call.name, args)         # même serveur MCP search
            messages += tool_result(call.id, result)
        continue
    else:
        return resp.content                            # réponse finale + plans cliquables
```

**Validation des tool-calls = non négociable** : les modèles faibles produisent parfois des args malformés/hallucinés. Schéma strict + retry borné → encaisse sans crasher. C'est ce qui rend le « free model » utilisable. (Les CLI Codex/Claude gèrent ça en interne.)

**Les deux serveurs MCP (`search` + `davinci-resolve`) sont partagés par les trois backends** : appelés via stdio par les CLI, via un client MCP in-process par la boucle maison. Mêmes moteurs, trois consommateurs.

---

## 6. Combo fort : recall SigLIP + rerank vision

Si le modèle est **vision-capable** (Claude, GPT-vision, gros VLM open) :

1. **SigLIP** = recall large parmi des milliers de plans → top 50 candidats (rapide, gratuit, local).
2. **LLM-vision** = **regarde les 50 vignettes** retournées → re-trie, vire les faux positifs, juge la qualité/cadrage.

SigLIP ratisse, le LLM juge. Précision >> SigLIP seul, sans payer un LLM par frame.

→ **Deux modes** :
- **Texte seul** : large compat (la plupart des modèles, free inclus), pas de vignette envoyée.
- **Vision rerank** : meilleur, exige un modèle vision (les vignettes sortent → cf. privacy).

---

## 7. Habillage chat custom — le frontend unique

UI maison par-dessus les trois backends. **Jamais un terminal brut** : chat agréable, tuné derush.

Contenu du panneau :
- **Bulles de message** user/assistant, **streaming token-par-token** (flux `AgentEvent`).
- **Grille de plans cliquables** quand des `hits` arrivent → réutilise le pattern **hover-to-play de `CutStudio`** (proxy HEVC, muet par défaut).
- **Trace repliable** des tool-calls (`search_text(...)`, `build_timeline(...)`) → transparence sur ce que l'agent fait.
- **Bouton « Construire la timeline »** sur une sélection de plans → `build_timeline` (invariant frame-accurate, §8).
- **Sélecteur de provider** (Codex / Claude Code / OpenRouter) + état auth/modèle, en tête de panneau.

Cible directe : pas de phase « prototype CLI générique » séparée. Les CLI **sont** des backends de production derrière notre UI, pas un terminal jetable. Valider la qualité LLM se fait directement dans le chat custom en basculant le sélecteur.

---

## 8. Intégration dans NetsuRush

- **Panneau « Terminal IA »** : nouvelle entrée dans la navigation latérale gauche (jamais d'onglets en haut — exigence UX). Chat + grille (pattern hover-to-play de `CutStudio`).
- **Backends sidecar** : `main.js` spawn les CLI (Codex, Claude Code) en stream-JSON et parse stdout → `AgentEvent` ; la boucle OpenRouter tourne dans le process main (Node, fetch OpenAI-compat). Annulation = kill enfant / abort fetch.
- **IPC** : toute nouvelle commande (lancer l'agent, streamer la réponse en chunks, annuler, lister providers/auth) s'ajoute aux **3 endroits** — `ipcMain.handle` (main.js), `contextBridge` (preload.js), `NrApi` + mock (bridge.ts). Le streaming passe par des events (`webContents.send`) relayés au renderer.
- **Réglages persistés** : provider actif ; **chemins binaires CLI** (auto-détectés dans le PATH, override manuel) ; **clé OpenRouter** + baseURL + modèle (BYOK) ; mode texte-seul vs vision rerank ; endpoint local Ollama. Clé API stockée hors repo (jamais committée).
- **Config MCP des CLI** : `install-plugin.mjs` écrit la déclaration des **deux** serveurs MCP (`search` + `davinci-resolve`) dans la config attendue par chaque CLI (au même titre que `nr.config.json`) → les CLI trouvent les outils sans setup manuel.
- **Serveurs MCP** : `search` (Node ou sidecar → daemon `search.py serve`) + `davinci-resolve` (sidecar Python stdio, [davinci-resolve-mcp](https://github.com/samuelgursky/davinci-resolve-mcp), mode compound). Les deux **partagés** par les trois backends. Vérifier `External scripting = Local` au démarrage.
- **Actions** : `build_timeline` (derush frame-accurate) route vers `AppendToTimeline` dans `main.js` — **pas** vers les tools timeline du MCP Resolve (invariant, §4·B). Le MCP Resolve = actions larges, avec garde-fous (confirmation destructif, allowlist).

---

## 9. Caveats honnêtes

- **CLI = dépendance externe** : Codex CLI / Claude Code CLI doivent être **installés et loggés** sur la machine. À détecter et guider (binaire absent → lien install ; pas loggé → lancer `login`). On ne gère pas l'auth nous-mêmes.
- **Abo ≠ API** : un abo ChatGPT/Claude marche **via le CLI**, pas en appel API direct. L'UI doit clarifier : CLI = login forfait, OpenRouter = clé payante.
- **Quotas d'abonnement** : les CLI consomment le quota du forfait (limites d'usage). Pas illimité ; à surfacer si le CLI renvoie une erreur de rate-limit.
- **Choix du modèle (OpenRouter)** : prendre un modèle **bon en tool-use** (DeepSeek, Qwen3-Coder, GLM, Claude, GPT…). Les nano/free très petits ratent les appels.
- **Privacy** : CLI cloud (Codex/Claude) et OpenRouter envoient requêtes + (mode vision) **vignettes de rush** chez le provider. Offline total = **mode local Ollama** via la boucle §5b.
- **Coût/latence** : garder le LLM pour le **raisonnement** (quelques appels) ; jamais d'appel LLM par-frame. SigLIP encaisse le volume, gratuitement.
- **Agir dans Resolve = muter le projet de l'user** : un LLM faible ou un tool-call halluciné peut casser un montage. Garde-fous obligatoires (confirmation destructif, allowlist, validation args, §4·B). Mode compound (32 tools), pas granulaire (341).
- **Double accès Resolve** : notre plugin (`WorkflowIntegration.node`) **et** le MCP Resolve (scripting externe) tapent le même projet en parallèle. Exige `External scripting = Local`. Ne pas dupliquer le chemin frame-accurate — `build_timeline` reste côté `main.js`.
- **Resolve Studio requis** : le scripting API (donc le MCP Resolve) n'existe pas en version free — même contrainte que le reste de NetsuRush.

---

## 10. Étapes suggérées

1. **Serveur MCP `search`** : déclare les tools (§3), route vers le daemon `search.py serve`.
2. **Serveur MCP `davinci-resolve`** (§4·B) : intégrer davinci-resolve-mcp en sidecar (compound, allowlist, confirmation destructif) ; vérifier `External scripting = Local`.
3. **Abstraction `AgentBackend`** (§5) : interface + flux `AgentEvent`, consommée par l'UI.
4. **Backend OpenRouter** (§5b) : client OpenAI-compat (BYOK + sélecteur modèle) + boucle agent + validation tool-calls (client MCP des 2 serveurs).
5. **Backends CLI** (§5a) : spawn Codex / Claude Code en stream-JSON, parse stdout → `AgentEvent` ; écrire leur config MCP (2 serveurs) via `install-plugin.mjs` ; détection binaire + statut login.
6. **Habillage chat custom** (§7) en panneau NetsuRush : bulles, streaming, grille hover-to-play, trace tool-calls, sélecteur provider.
7. **System prompt derush** optimisé + `build_timeline` (frame-accurate) + actions Resolve via MCP.
8. **Mode vision rerank** (optionnel) pour les modèles vision (§6).

---

## Sources / références

- [Model Context Protocol — spec](https://modelcontextprotocol.io)
- [OpenRouter — API OpenAI-compatible, BYOK](https://openrouter.ai/docs)
- [OpenAI — chat completions + tool calling](https://platform.openai.com/docs/guides/function-calling)
- [Ollama — serveur local OpenAI-compatible](https://ollama.com)
- [davinci-resolve-mcp (samuelgursky) — MCP pilotant le scripting API Resolve](https://github.com/samuelgursky/davinci-resolve-mcp)
- [search-siglip2.md](search-siglip2.md) — moteur SigLIP 2 (capacités, tiers A/B/C)
