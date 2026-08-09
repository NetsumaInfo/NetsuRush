# Partage & collaboration — architecture Iroh

> Doc de conception (pas encore codé). Transport P2P pour partage de rush, liens de partage, et sync d'équipe dans NetsuRush.

## Pourquoi Iroh

[iroh](https://github.com/n0-computer/iroh) — v1.0.2, dual-licence **Apache 2.0 / MIT** (commercial OK).

Écrit par les anciens de IPFS/libp2p, en réécriture **allégée** : pas de DHT global lent, connexion directe par **clé publique** (EndpointId) via QUIC + hole-punching NAT, repli sur relais publics si nécessaire. Chiffré/authentifié bout-en-bout.

Avantage clé pour NetsuRush : **crate Rust natif** → embarqué directement dans `src-tauri`, **zéro daemon externe** (contrairement à IPFS/Syncthing/Nextcloud). Colle parfaitement à l'archi Tauri + core Node.

### Les briques (crates composables)

| Crate | Rôle | Usage NetsuRush |
|---|---|---|
| `iroh` | Connexion P2P (EndpointId, hole-punch, relais) | Socle transport |
| `iroh-blobs` | Transfert de blobs adressés par contenu (BLAKE3, chunké, reprise, du Ko au To) | **Rush, médias, exports** — vérifiés, reprenables |
| `iroh-docs` | Store clé-valeur répliqué, eventually-consistent (CRDT) | État simple (métadonnées) — voir **Loro** ci-dessous pour le live riche |
| `iroh-gossip` | Pub/sub sur secret partagé | Présence/notifs équipe, signalement de mises à jour |
| `iroh-ffi` | Bindings non-Rust | Non requis (on reste Rust dans `src-tauri`) |

### Modèle de données live — Loro (au-dessus d'Iroh)

Pour l'édition **temps réel simultanée** (board, timeline, collections à plusieurs), on ne s'appuie pas sur `iroh-docs` (store clé-valeur basique) mais sur [Loro](https://github.com/loro-dev/loro) — **CRDT Rust natif, MIT**, plus riche : rich text, listes, **arbre déplaçable (movable tree)**, historique/versions.

Séparation des rôles :

- **Iroh = transport** (achemine les octets entre pairs, chiffré, NAT-safe).
- **Loro = modèle de données** (fusionne les modifications concurrentes sans conflit, offline-first).

Loro produit/consomme des updates binaires ; Iroh les transporte (via un protocole custom sur `iroh`, ou `iroh-gossip` pour diffuser les deltas à l'espace). On garde `iroh-blobs` pour les **médias** (jamais dans le CRDT) et `iroh-docs` reste une option pour de l'état simple non-live.

Bonus : Loro a des bindings WASM → utilisable côté renderer (React/zustand) **et** Rust côté `src-tauri`, au choix de la couche où vit la vérité.

### Concepts

- **EndpointId** = clé publique du nœud. C'est l'adresse. Pas d'IP.
- **Ticket** = blob sérialisable (EndpointId + infos de connexion + hash du contenu). **C'est ça, le « lien de partage »** : encodable en URL/texte, scannable/collable.
- **Relais** = serveur public de repli quand le direct échoue (n0 en héberge ; on peut self-host plus tard).

## Les 3 usages visés

### 1. Bouton « Partager » un rush → amis Discord

Flux : sélection d'un rush dans le Derush → **Partager** → choisir un ami → l'ami reçoit une notif in-app, télécharge en P2P.

Astuce archi : **on a déjà Discord + Convex** (auth beta, cf. `netsurush-auth-convex`). On réutilise :
- **Discord** = identité + graphe d'amis (qui est qui).
- **Convex** = annuaire + **signalement** : stocke `userId → EndpointId courant`, et une petite boîte de messages « X veut te partager le rush Y (ticket=…) ».
- **Iroh** = transport des octets (jamais via Convex, qui ne voit que le ticket, pas le média).

Séparation nette : **Convex = signalisation, Iroh = données.** Convex ne stocke aucun média lourd.

### 2. Lien de partage facile (projet / roto / document)

Flux : n'importe quel objet (board, session roto, export, collection) → **Copier le lien de partage** → colle le lien à qui tu veux.

Le lien = **ticket Iroh** encodé. Quiconque a le lien (et l'app) peut fetch en P2P. Pas besoin d'être ami/connecté.

Options de portée :
- **Snapshot figé** : ticket sur un blob immuable (le `.netsu` ZIP déjà prévu, ou un dossier). Simple, sûr.
- **Live** : ticket sur un espace **Loro** → le destinataire voit les mises à jour tant que tu partages.
- **Expiration/révocation** : géré côté app (le nœud arrête de servir le blob) — pas de garantie de suppression une fois téléchargé.

### 3. Sync d'équipe (travail collaboratif)

Flux : un « espace équipe » (projet partagé) où plusieurs personnes voient les mêmes rush, boards, collections, et les changements se propagent.

- **Loro** porte l'**état live** (liste des rush, découpes, tags, positions de board) → CRDT riche, fusion sans conflit, offline-first, édition simultanée.
- **iroh** transporte les updates Loro entre pairs ; **iroh-gossip** diffuse les deltas + la présence (« qui est en ligne »).
- **iroh-blobs** porte les **médias** (rush, proxies, vignettes) à la demande — on ne réplique pas 500 Go partout, on fetch ce qu'on ouvre. Jamais dans le CRDT.
- **Convex** = point d'entrée de l'espace (liste des membres, invitations, EndpointIds courants).

Modèle mental : Convex fait l'annuaire/les invitations, Iroh fait la sync réelle des données entre pairs.

## Plomberie dans NetsuRush

```
src-tauri/ (Rust)
  └─ module iroh : Endpoint persistant (clé stockée dans NR_HOME),
     iroh-blobs (store médias) + iroh-docs (état) + iroh-gossip (présence)
        │ exposé au core via commandes Tauri / socket local
core/
  └─ sync.js : orchestrateur — expose les canaux au renderer,
     parle à Convex (annuaire/signalisation) + pilote le peer Iroh
core/rpc.js : nouveaux canaux (table H)
src/ (renderer)
  └─ store/sync.ts (zustand) + boutons Partager / Copier le lien / Espace équipe
```

Nouveaux canaux IPC (règle des **3 endroits** : table `H` core/rpc.js, `NrApi`+impl coreClient.ts, `mock` bridge.ts) :

| Canal | Rôle |
|---|---|
| `sync:shareBlob(paths)` | Ajoute au store blobs → retourne un **ticket** (le lien) |
| `sync:fetchTicket(ticket)` | Télécharge le contenu d'un ticket → chemin local |
| `sync:sendToFriend(userId, ticket)` | Dépose le ticket dans la boîte Convex de l'ami |
| `sync:inbox()` + SSE `sync:incoming` | Partages reçus (pull + push temps réel) |
| `sync:teamJoin(spaceId)` / `sync:teamState` | Rejoint un espace iroh-docs, s'abonne aux updates |
| `sync:presence` (SSE) | Membres en ligne (gossip) |

## Découpage proposé (phases)

1. **P0 — Blob + ticket** : `sync:shareBlob` / `sync:fetchTicket`. Bouton « Copier le lien de partage » sur un rush et sur un export `.netsu`. Valide le transport de bout en bout, sans Discord ni équipe. **Le plus rentable à tester en premier.**
2. **P1 — Amis Discord** : annuaire EndpointId dans Convex + boîte de partage + bouton « Partager à un ami ». S'appuie sur l'auth Discord existante.
3. **P2 — Sync d'équipe** : **Loro** (CRDT) pour l'état projet, transporté sur Iroh, + fetch médias à la demande (`iroh-blobs`) + présence gossip. Le gros morceau.

## Points d'attention

- **NAT/réseau** : le hole-punch marche dans la plupart des cas ; sinon repli relais (latence, on ne maîtrise pas le débit). Un self-host de relais est possible plus tard.
- **Sécurité** : un ticket = accès. Le traiter comme un secret. Prévoir révocation côté app (arrêt du service du blob) — sachant qu'un contenu déjà téléchargé ne se reprend pas.
- **Persistance** : la clé du nœud (identité) doit vivre dans `NR_HOME` (survit aux updates). Sinon l'EndpointId change et les liens cassent.
- **Modifs Rust** → **redémarrer `npm run tauri dev`** (re-spawn du core) pour tester.
- **Runtime non testé** tant que pas codé — check:core/build restent le garde-fou.

## Liens

- Iroh (transport) : https://github.com/n0-computer/iroh · docs https://docs.iroh.computer/
- Crates Iroh : `iroh`, `iroh-blobs`, `iroh-gossip`, `iroh-docs` (crates.io)
- Loro (CRDT live) : https://github.com/loro-dev/loro — MIT, Rust natif + WASM
</content>
</invoke>
