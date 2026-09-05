import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Tables de l'app (les tables d'AUTH appartiennent au composant `@convex-dev/better-auth`, isolées).
// P0 minimal : contrôle d'accès beta. De la place pour la sync board / collab plus tard.
export default defineSchema({
  // Droits d'accès par utilisateur (id Better Auth). Beta ouverte = flag OPEN_BETA côté env ;
  // cette table sert la future ALLOWLIST (grant manuel) sans changer le schéma.
  betaGrants: defineTable({
    userId: v.string(), // id du user Better Auth (document._id du composant)
    role: v.string(), // "member" | "admin" | "pending" — accès BETA DESKTOP
    // Rôle sur le SITE : "moderator" | "admin". Absent = membre ordinaire, ce
    // qu'est tout compte connecté (les inscriptions du site sont ouvertes).
    // Champ SÉPARÉ de `role` à dessein : promouvoir un modérateur du site ne
    // doit pas ouvrir la beta desktop, et retirer la beta ne doit pas retirer
    // la modération. Deux droits, deux colonnes.
    siteRole: v.optional(v.string()),
    grantedAt: v.number(),
    note: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  // ——— Tables consommées par le site web (client n°2 du même déploiement) ———

  // Inscriptions « préviens-moi pour la beta » (formulaire public du site).
  waitlist: defineTable({
    email: v.string(), // normalisé lowercase
    createdAt: v.number(),
    source: v.optional(v.string()), // ex. "landing", "download"
  }).index("by_email", ["email"]),

  // Tableau d'idées : propositions de la communauté, votées.
  ideas: defineTable({
    title: v.string(),
    description: v.string(),
    authorId: v.string(), // id user Better Auth
    authorName: v.string(), // dénormalisé (pseudo Discord au moment du post)
    status: v.string(), // "open" | "planned" | "done" | "declined"
    votes: v.number(), // compteur dénormalisé (source de vérité : ideaVotes)
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_votes", ["votes"]),

  // Trace des rapports de bug relayés vers Discord. Le CONTENU reste dans le salon (embed + pièces
  // jointes) : ici seulement de quoi retrouver un rapport et plafonner les envois d'un compte.
  bugReports: defineTable({
    reportId: v.string(), // NR-XXXX, identique au titre de l'embed Discord
    userId: v.optional(v.string()), // id Better Auth quand l'envoi est authentifié
    userName: v.optional(v.string()),
    // Clé du plafond horaire : id du compte, ou empreinte salée de l'IP pour un envoi anonyme
    // (l'IP elle-même n'est jamais écrite).
    quotaKey: v.optional(v.string()),
    severity: v.optional(v.string()),
    category: v.optional(v.string()),
    module: v.optional(v.string()),
    appVersion: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_report", ["reportId"])
    .index("by_quota_created", ["quotaKey", "createdAt"]),

  // Un vote par user et par idée.
  ideaVotes: defineTable({
    ideaId: v.id("ideas"),
    userId: v.string(),
  })
    .index("by_idea_user", ["ideaId", "userId"])
    .index("by_user", ["userId"]),

  // ——— Rendezvous layer of collaborative projects (`docs/collab.md`) ———
  // Discord is only an identity provider here: its friend list is unreachable (the API needs the
  // Social SDK and Discord's approval), so NetsuRush keeps its own graph, keyed by Better Auth ids.
  // Plaintext never lands here: sealed checkpoints and device heads are the bounded offline
  // recovery layer, and original media stays on participant disks.

  // Exact directory used to add someone by a server-enforced NetsuRush handle or by Discord fields
  // observed from the account's OAuth token. Display name and avatar also come from authenticated
  // server identity rather than renderer claims; nothing here is secret.
  profiles: defineTable({
    userId: v.string(),
    handle: v.string(), // lowercased unique NetsuRush handle, the lookup key
    discordId: v.optional(v.string()), // stable Discord snowflake, never renderer-supplied
    discordUsername: v.optional(v.string()), // current normalized Discord username
    name: v.string(), // as displayed
    image: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_handle", ["handle"])
    .index("by_discord_id", ["discordId"])
    .index("by_discord_username", ["discordUsername"]),

  // Accepted friendship, written as TWO rows, one per direction: every list query then reads a
  // single index instead of merging two.
  friends: defineTable({
    userId: v.string(),
    friendId: v.string(),
    since: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_pair", ["userId", "friendId"]),

  // A request may be addressed to an account that has not signed in here yet. `toUserId` is then
  // empty and the identifier the sender typed is kept instead; the request binds itself the moment
  // that person first publishes a profile. Without this, adding someone would require them to open
  // NetsuRush first, which is exactly backwards — an invitation is what makes them open it.
  friendRequests: defineTable({
    fromUserId: v.string(),
    toUserId: v.string(), // "" while pending
    toDiscordId: v.optional(v.string()),
    toDiscordUsername: v.optional(v.string()),
    toHandle: v.optional(v.string()),
    // Exactly what the sender typed, for the pending row shown in their list.
    toLabel: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_to", ["toUserId"])
    .index("by_from", ["fromUserId"])
    .index("by_pair", ["fromUserId", "toUserId"])
    .index("by_pending_discord_id", ["toDiscordId"])
    .index("by_pending_discord_username", ["toDiscordUsername"])
    .index("by_pending_handle", ["toHandle"]),

  // Devices authorised to take part. `exchangePublic` is the X25519 half that will receive wrapped
  // project keys; the secret never leaves the machine. `deviceId` is the Ed25519 public key, which
  // is also the iroh EndpointId, so the signed project allowlist and transport identity coincide.
  userDevices: defineTable({
    userId: v.string(),
    deviceId: v.string(),
    signingPublic: v.optional(v.string()),
    exchangePublic: v.string(),
    endpointId: v.optional(v.string()),
    registrationVersion: v.optional(v.number()),
    label: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_device", ["deviceId"]),

  // A forgotten native identity cannot silently enrol itself again with the same still-live web
  // session. These sparse tombstones are intentionally durable; deleting one would undo the
  // security decision that created it.
  revokedDevices: defineTable({
    userId: v.string(),
    deviceId: v.string(),
    revokedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_device", ["deviceId"]),

  // Short-lived and single-use. Possessing an account session is insufficient to register an
  // arbitrary public key: the device must sign this challenge with the key it claims.
  deviceRegistrationChallenges: defineTable({
    userId: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_user", ["userId"]),

  // A project carries NO name here. The display name is encrypted with the project key and, until
  // that key exists, simply stays on each member's disk — the server has no business reading it.
  //
  // `surface` names WHICH module of the app the project belongs to ("board", "collection",
  // "notebook", …) and is deliberately in clear: an invitation must say what it invites to before
  // the recipient holds any key, and the app must know which local object to create when they
  // accept. It is a module label, never content. Absent = "board", the first surface shipped.
  projects: defineTable({
    ownerId: v.string(),
    createdAt: v.number(),
    surface: v.optional(v.string()),
    nameCipher: v.optional(v.string()),
    keyEpoch: v.optional(v.number()),
    rotationRequired: v.optional(v.boolean()),
  }).index("by_owner", ["ownerId"]),

  projectMembers: defineTable({
    projectId: v.id("projects"),
    userId: v.string(),
    role: v.string(), // "owner" | "editor" | "viewer"
    addedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_user", ["userId"])
    .index("by_project_user", ["projectId", "userId"]),

  // Rare, bounded administrative actions only. No project name, content, file path, token or key.
  projectAuditEvents: defineTable({
    projectId: v.id("projects"),
    actorUserId: v.string(),
    kind: v.string(),
    target: v.optional(v.string()),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_project_created", ["projectId", "createdAt"]),

  projectInvites: defineTable({
    projectId: v.id("projects"),
    fromUserId: v.string(),
    toUserId: v.string(),
    role: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_to", ["toUserId"])
    .index("by_to_expiry", ["toUserId", "expiresAt"])
    .index("by_project", ["projectId"])
    .index("by_project_user", ["projectId", "toUserId"]),

  // Sealed header Convex is allowed to index. It can order and authorise; it cannot read.
  // `keyEpoch` is in clear on purpose: a device must know which key to try before decrypting.
  projectCheckpoints: defineTable({
    projectId: v.id("projects"),
    epoch: v.number(),
    header: v.any(),
    ciphertext: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    bytes: v.optional(v.number()),
    signature: v.string(),
    authorDeviceId: v.string(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId"]),

  // At most one unmerged head per device. A published head is NEVER deleted automatically: the
  // originating disk may be gone, so the server copy can be the only surviving branch.
  projectHeads: defineTable({
    projectId: v.id("projects"),
    deviceId: v.string(),
    seq: v.number(),
    ciphertextHash: v.string(),
    header: v.any(),
    ciphertext: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    bytes: v.optional(v.number()),
    signature: v.string(),
    // Bumped on every replacement. Compaction consumes a head only if this is unchanged.
    revision: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_device", ["projectId", "deviceId"]),

  // Ownership receipt for a freshly uploaded opaque payload. Publication consumes it; failed
  // uploads may be deleted only through this row, never by presenting an arbitrary storage id.
  projectPayloadUploads: defineTable({
    projectId: v.id("projects"),
    userId: v.string(),
    deviceId: v.string(),
    storageId: v.id("_storage"),
    bytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_storage", ["storageId"])
    .index("by_project", ["projectId"])
    .index("by_device", ["deviceId"])
    .index("by_device_created", ["deviceId", "createdAt"])
    .index("by_project_user", ["projectId", "userId"]),

  // One HPKE envelope of the project key per authorised device. Never the bare key.
  projectKeyEnvelopes: defineTable({
    projectId: v.id("projects"),
    deviceId: v.string(),
    epoch: v.number(),
    envelope: v.string(),
    createdAt: v.number(),
  })
    .index("by_project_device", ["projectId", "deviceId"])
    .index("by_project_device_epoch", ["projectId", "deviceId", "epoch"])
    .index("by_device", ["deviceId"]),

  // ONE consolidated notification per user and project, patched in place, never inserted again.
  // No plaintext project name: the client decorates it with its own local name after decryption.
  projectInbox: defineTable({
    userId: v.string(),
    projectId: v.id("projects"),
    actors: v.array(v.string()),
    mediaRequested: v.optional(v.boolean()),
    keyRequested: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_project", ["projectId"])
    .index("by_user_project", ["userId", "projectId"]),

  // One coalesced set per requester/project. Hashes reveal no path or bytes and expire naturally;
  // repeated offline retries patch neither this row nor the inbox inside the retry window.
  projectMediaRequests: defineTable({
    projectId: v.id("projects"),
    userId: v.string(),
    hashes: v.array(v.string()),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_expiry", ["projectId", "expiresAt"])
    .index("by_project_user", ["projectId", "userId"]),
});
