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
