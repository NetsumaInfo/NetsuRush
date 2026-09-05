// Checkpoint, heads and the compaction CAS (docs/collab.md §5.2–5.4).
//
// Convex is the point of resume, not the source of truth. It holds one sealed checkpoint per
// project and at most one unmerged head per device, orders them, and guarantees the compare-and-set
// that makes compaction safe. It cannot read any of it.
//
// Roles are checked here on every call. Holding a project key is not authorisation: a revoked
// device can still carry a valid session, so the membership row is the gate.

import {
  query,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";
import type { Id } from "./_generated/dataModel";
import { isStaleHead } from "./collabPolicy";
import { recordProjectAudit } from "./audit";

/// Conservative ceiling, below Convex's 1 MiB document limit. Larger payloads belong in file
/// storage; refusing them here is better than a mutation that fails deep inside the platform.
const MAX_CIPHERTEXT = 768 * 1024;
const MAX_FILE_PAYLOAD = 32 * 1024 * 1024;
const MAX_PROJECT_HEADS = 50;
const MAX_PENDING_UPLOADS_PER_DEVICE = 3;
const UPLOAD_RESERVATION_TTL_MS = 60 * 60 * 1000;
const HEX_32 = /^[0-9a-f]{64}$/;
const ED25519_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

const sealedHeaderValidator = v.object({
  project_id: v.string(),
  device_id: v.string(),
  seq: v.number(),
  base_checkpoint_epoch: v.number(),
  key_epoch: v.number(),
  purpose: v.union(
    v.literal("head"),
    v.literal("checkpoint"),
    v.literal("thumbnail"),
  ),
  ciphertext_hash: v.string(),
});

export function checkpointCasMatches(
  currentEpoch: number,
  expectedEpoch: number,
  observed: Array<{ headId: string; revision: number }>,
  consumed: Array<{ headId: string; revision: number }>,
): boolean {
  if (currentEpoch !== expectedEpoch || observed.length < consumed.length)
    return false;
  const actual = new Map(observed.map((head) => [head.headId, head.revision]));
  return consumed.every((head) => actual.get(head.headId) === head.revision);
}

export function storageReservationMatches(
  reservation: {
    projectId: string;
    userId: string;
    deviceId: string;
    bytes: number;
  } | null,
  expected: {
    projectId: string;
    userId: string;
    deviceId: string;
    bytes: number;
  },
): boolean {
  return Boolean(
    reservation &&
    reservation.projectId === expected.projectId &&
    reservation.userId === expected.userId &&
    reservation.deviceId === expected.deviceId &&
    reservation.bytes === expected.bytes,
  );
}

export function isRedundantReservedUpload(
  retainedStorageId: string | undefined,
  submittedStorageId: string | undefined,
  hasReservation: boolean,
): boolean {
  return Boolean(
    hasReservation &&
      submittedStorageId &&
      submittedStorageId !== retainedStorageId,
  );
}

export function isObsoleteEnvelopeEpoch(
  envelopeEpoch: number,
  checkpointKeyEpoch: number,
): boolean {
  return envelopeEpoch < checkpointKeyEpoch;
}

async function requireMember(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  needWrite: boolean,
) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("not signed in");
  const member = await ctx.db
    .query("projectMembers")
    .withIndex("by_project_user", (q) =>
      q.eq("projectId", projectId).eq("userId", user._id),
    )
    .unique();
  if (!member) throw new Error("not a member of this project");
  if (needWrite && member.role !== "owner" && member.role !== "editor") {
    throw new Error("this account has no write role on this project");
  }
  return { user, member };
}

async function validatePayload(
  ctx: QueryCtx,
  args: {
    ciphertext?: string;
    storageId?: Id<"_storage">;
    bytes: number;
  },
) {
  if (
    !Number.isSafeInteger(args.bytes) ||
    args.bytes <= 0 ||
    args.bytes > MAX_FILE_PAYLOAD
  ) {
    throw new Error("invalid encrypted payload size");
  }
  if (Boolean(args.ciphertext) === Boolean(args.storageId)) {
    throw new Error(
      "payload needs exactly one inline ciphertext or storage object",
    );
  }
  if (args.ciphertext) {
    if (
      args.ciphertext.length > MAX_CIPHERTEXT ||
      args.ciphertext.length !== 4 * Math.ceil(args.bytes / 3) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(args.ciphertext)
    )
      throw new Error("invalid inline payload encoding or size");
    return;
  }
  const stored = await ctx.db.system.get(args.storageId!);
  if (!stored || stored.size !== args.bytes)
    throw new Error("storage payload is missing or has the wrong size");
}

function validateSealedMetadata(args: {
  seq: number;
  ciphertextHash: string;
  signature: string;
  header: {
    seq: number;
    base_checkpoint_epoch: number;
    key_epoch: number;
    ciphertext_hash: string;
  };
}) {
  if (
    !Number.isSafeInteger(args.seq) ||
    args.seq <= 0 ||
    !Number.isSafeInteger(args.header.base_checkpoint_epoch) ||
    args.header.base_checkpoint_epoch < 0 ||
    !Number.isSafeInteger(args.header.key_epoch) ||
    args.header.key_epoch <= 0 ||
    !HEX_32.test(args.ciphertextHash) ||
    args.header.ciphertext_hash !== args.ciphertextHash ||
    !ED25519_SIGNATURE.test(args.signature)
  )
    throw new Error("invalid sealed payload metadata");
}

async function requireProvedDevice(
  ctx: QueryCtx,
  userId: string,
  deviceId: string,
) {
  const device = await ctx.db
    .query("userDevices")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();
  if (
    !device ||
    device.userId !== userId ||
    device.registrationVersion !== 1 ||
    device.deviceId !== device.signingPublic ||
    device.deviceId !== device.endpointId ||
    !device.exchangePublic
  )
    throw new Error("unknown or unproved device for this account");
  return device;
}

function headerField(header: unknown, name: string): unknown {
  return header && typeof header === "object"
    ? (header as Record<string, unknown>)[name]
    : undefined;
}

async function requireCurrentHeader(
  ctx: QueryCtx,
  args: {
    projectId: Id<"projects">;
    deviceId: string;
    seq: number;
    purpose: "head" | "checkpoint";
    header: unknown;
  },
) {
  const project = await ctx.db.get(args.projectId);
  if (!project) throw new Error("project is unavailable");
  if (project.rotationRequired)
    throw new Error("project key rotation is pending");
  if (
    headerField(args.header, "project_id") !== args.projectId ||
    headerField(args.header, "device_id") !== args.deviceId ||
    headerField(args.header, "seq") !== args.seq ||
    headerField(args.header, "purpose") !== args.purpose ||
    headerField(args.header, "key_epoch") !== (project.keyEpoch ?? 0)
  )
    throw new Error("sealed header does not match the current project epoch");
  return project;
}

export const generatePayloadUploadUrl = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await requireMember(ctx, projectId, true);
    return ctx.storage.generateUploadUrl();
  },
});

/** Binds a completed upload to its authenticated writer before it can be retained or deleted. */
export const registerPayloadUpload = mutation({
  args: {
    projectId: v.id("projects"),
    deviceId: v.string(),
    storageId: v.id("_storage"),
    bytes: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, true);
    await requireProvedDevice(ctx, user._id, args.deviceId);
    if (
      !Number.isSafeInteger(args.bytes) ||
      args.bytes <= 0 ||
      args.bytes > MAX_FILE_PAYLOAD
    ) {
      throw new Error("invalid encrypted payload size");
    }
    const stored = await ctx.db.system.get(args.storageId);
    if (!stored || stored.size !== args.bytes)
      throw new Error("storage payload is missing or has the wrong size");
    const existing = await ctx.db
      .query("projectPayloadUploads")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (existing) throw new Error("storage payload is already registered");
    const now = Date.now();
    const pending = await ctx.db
      .query("projectPayloadUploads")
      .withIndex("by_device_created", (q) => q.eq("deviceId", args.deviceId))
      .order("asc")
      .take(MAX_PENDING_UPLOADS_PER_DEVICE + 1);
    let recent = 0;
    for (const upload of pending) {
      if (now - upload.createdAt < UPLOAD_RESERVATION_TTL_MS) {
        recent += 1;
        continue;
      }
      if (await ctx.db.system.get(upload.storageId))
        await ctx.storage.delete(upload.storageId);
      await ctx.db.delete(upload._id);
    }
    if (recent >= MAX_PENDING_UPLOADS_PER_DEVICE)
      throw new Error("this device has too many unfinished recovery uploads");
    await ctx.db.insert("projectPayloadUploads", {
      ...args,
      userId: user._id,
      createdAt: now,
    });
    return { status: "registered" as const };
  },
});

async function requirePayloadReservation(
  ctx: MutationCtx,
  args: {
    projectId: Id<"projects">;
    storageId?: Id<"_storage">;
    bytes: number;
  },
  userId: string,
  deviceId: string,
) {
  if (!args.storageId) return null;
  const reservation = await ctx.db
    .query("projectPayloadUploads")
    .withIndex("by_storage", (q) => q.eq("storageId", args.storageId!))
    .unique();
  if (
    !storageReservationMatches(reservation, {
      projectId: args.projectId,
      userId,
      deviceId,
      bytes: args.bytes,
    })
  )
    throw new Error(
      "storage payload is not reserved for this writer and project",
    );
  return reservation;
}

/** Best-effort cleanup for an upload whose following CAS/publish did not retain the object. */
export const deleteUncommittedStorage = mutation({
  args: { projectId: v.id("projects"), storageId: v.id("_storage") },
  handler: async (ctx, { projectId, storageId }) => {
    const { user } = await requireMember(ctx, projectId, true);
    const reservation = await ctx.db
      .query("projectPayloadUploads")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .unique();
    if (
      !reservation ||
      reservation.projectId !== projectId ||
      reservation.userId !== user._id
    ) {
      return { status: "unowned" as const };
    }
    const checkpoint = await ctx.db
      .query("projectCheckpoints")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .unique();
    if (checkpoint?.storageId === storageId) {
      await ctx.db.delete(reservation._id);
      return { status: "retained" as const };
    }
    const heads = await ctx.db
      .query("projectHeads")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    if (heads.some((head) => head.storageId === storageId)) {
      await ctx.db.delete(reservation._id);
      return { status: "retained" as const };
    }
    if (await ctx.db.system.get(storageId)) await ctx.storage.delete(storageId);
    await ctx.db.delete(reservation._id);
    return { status: "deleted" as const };
  },
});

/**
 * Publishes this device's unmerged branch.
 *
 * Idempotent on `(projectId, deviceId, seq, ciphertextHash)`: a device that crashed between sealing
 * and uploading republishes exactly the same bytes, and this recognises them.
 *
 * The same `(projectId, deviceId, seq)` carrying a DIFFERENT hash is refused, never upserted. That
 * combination means a reused sequence number — a bug, or a cloned device — and accepting it would
 * quietly destroy the branch already stored under that number.
 */
export const publishHead = mutation({
  args: {
    projectId: v.id("projects"),
    deviceId: v.string(),
    seq: v.number(),
    ciphertextHash: v.string(),
    header: sealedHeaderValidator,
    ciphertext: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    bytes: v.number(),
    signature: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, true);
    await validatePayload(ctx, args);
    validateSealedMetadata(args);
    // The device must belong to the caller: publishing under someone else's device id would forge
    // the authorship every reader verifies against.
    await requireProvedDevice(ctx, user._id, args.deviceId);
    const reservation = await requirePayloadReservation(
      ctx,
      args,
      user._id,
      args.deviceId,
    );
    await requireCurrentHeader(ctx, {
      projectId: args.projectId,
      deviceId: args.deviceId,
      seq: args.seq,
      purpose: "head",
      header: args.header,
    });

    const existing = await ctx.db
      .query("projectHeads")
      .withIndex("by_project_device", (q) =>
        q.eq("projectId", args.projectId).eq("deviceId", args.deviceId),
      )
      .unique();
    const now = Date.now();

    if (existing) {
      if (existing.seq === args.seq) {
        if (existing.ciphertextHash === args.ciphertextHash) {
          if (
            isRedundantReservedUpload(
              existing.storageId,
              args.storageId,
              Boolean(reservation),
            ) &&
            args.storageId &&
            (await ctx.db.system.get(args.storageId))
          ) {
            await ctx.storage.delete(args.storageId);
          }
          if (reservation) await ctx.db.delete(reservation._id);
          return { status: "already" as const, revision: existing.revision };
        }
        throw new Error(
          "this sequence number was already published with different content",
        );
      }
      if (args.seq < existing.seq) {
        return { status: "stale" as const, revision: existing.revision };
      }
      const revision = existing.revision + 1;
      const previousStorage = existing.storageId;
      await ctx.db.patch(existing._id, { ...args, revision, updatedAt: now });
      if (previousStorage && previousStorage !== args.storageId)
        await ctx.storage.delete(previousStorage);
      await notify(ctx, args.projectId, user._id);
      if (reservation) await ctx.db.delete(reservation._id);
      return { status: "published" as const, revision };
    }

    await ctx.db.insert("projectHeads", {
      ...args,
      revision: 1,
      updatedAt: now,
    });
    await notify(ctx, args.projectId, user._id);
    if (reservation) await ctx.db.delete(reservation._id);
    return { status: "published" as const, revision: 1 };
  },
});

/** Every unmerged head. Members only: an id alone must never yield a project's branches. */
export const listHeads = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await requireMember(ctx, projectId, false);
    const rows = await ctx.db
      .query("projectHeads")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(MAX_PROJECT_HEADS);
    return Promise.all(
      rows.map(async (row) => ({
        headId: row._id,
        deviceId: row.deviceId,
        seq: row.seq,
        revision: row.revision,
        header: row.header,
        ciphertext: row.ciphertext ?? null,
        storageId: row.storageId ?? null,
        downloadUrl: row.storageId
          ? await ctx.storage.getUrl(row.storageId)
          : null,
        signature: row.signature,
        updatedAt: row.updatedAt,
        bytes: row.bytes ?? row.ciphertext?.length ?? 0,
      })),
    );
  },
});

export const getCheckpoint = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await requireMember(ctx, projectId, false);
    const row = await ctx.db
      .query("projectCheckpoints")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .unique();
    if (!row) return null;
    return {
      epoch: row.epoch,
      header: row.header,
      ciphertext: row.ciphertext ?? null,
      storageId: row.storageId ?? null,
      downloadUrl: row.storageId
        ? await ctx.storage.getUrl(row.storageId)
        : null,
      bytes: row.bytes ?? row.ciphertext?.length ?? 0,
      signature: row.signature,
      authorDeviceId: row.authorDeviceId,
    };
  },
});

/**
 * Replaces the checkpoint and consumes the heads it absorbed — one transaction, one CAS.
 *
 * The epoch must be the one the compactor read, and every consumed head must still carry the
 * revision it had when compaction started. Either check failing means someone published meanwhile:
 * the mutation fails and compaction restarts, rather than deleting a branch that was never merged.
 *
 * The compactor must never fold its own unpublished work into a checkpoint — that is what reopens
 * lost updates. It publishes a head first; a checkpoint only ever absorbs published material.
 */
export const commitCheckpoint = mutation({
  args: {
    projectId: v.id("projects"),
    expectedEpoch: v.number(),
    header: sealedHeaderValidator,
    ciphertext: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    bytes: v.number(),
    signature: v.string(),
    authorDeviceId: v.string(),
    consumed: v.array(
      v.object({ headId: v.id("projectHeads"), revision: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    const { user } = await requireMember(ctx, args.projectId, true);
    await validatePayload(ctx, args);
    validateSealedMetadata({
      seq: args.expectedEpoch + 1,
      ciphertextHash: args.header.ciphertext_hash,
      signature: args.signature,
      header: args.header,
    });
    if (
      !Number.isSafeInteger(args.expectedEpoch) ||
      args.expectedEpoch < 0 ||
      args.header.base_checkpoint_epoch !== args.expectedEpoch ||
      args.consumed.length > MAX_PROJECT_HEADS ||
      args.consumed.some(
        (entry) => !Number.isSafeInteger(entry.revision) || entry.revision <= 0,
      )
    )
      throw new Error("invalid checkpoint CAS metadata");
    await requireProvedDevice(ctx, user._id, args.authorDeviceId);
    const reservation = await requirePayloadReservation(
      ctx,
      args,
      user._id,
      args.authorDeviceId,
    );
    await requireCurrentHeader(ctx, {
      projectId: args.projectId,
      deviceId: args.authorDeviceId,
      seq: args.expectedEpoch + 1,
      purpose: "checkpoint",
      header: args.header,
    });
    const current = await ctx.db
      .query("projectCheckpoints")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .unique();
    const epoch = current?.epoch ?? 0;
    const observed: Array<{ headId: string; revision: number }> = [];
    for (const entry of args.consumed) {
      const head = await ctx.db.get(entry.headId);
      if (!head || head.projectId !== args.projectId) {
        return { status: "conflict" as const, epoch };
      }
      observed.push({ headId: head._id, revision: head.revision });
    }
    if (
      !checkpointCasMatches(epoch, args.expectedEpoch, observed, args.consumed)
    ) {
      return { status: "conflict" as const, epoch };
    }

    const now = Date.now();
    const next = epoch + 1;
    if (current) {
      const previousStorage = current.storageId;
      await ctx.db.patch(current._id, {
        epoch: next,
        header: args.header,
        ciphertext: args.ciphertext,
        storageId: args.storageId,
        bytes: args.bytes,
        signature: args.signature,
        authorDeviceId: args.authorDeviceId,
        updatedAt: now,
      });
      if (previousStorage && previousStorage !== args.storageId)
        await ctx.storage.delete(previousStorage);
    } else {
      await ctx.db.insert("projectCheckpoints", {
        projectId: args.projectId,
        epoch: next,
        header: args.header,
        ciphertext: args.ciphertext,
        storageId: args.storageId,
        bytes: args.bytes,
        signature: args.signature,
        authorDeviceId: args.authorDeviceId,
        updatedAt: now,
      });
    }
    for (const entry of args.consumed) {
      const head = await ctx.db.get(entry.headId);
      if (head?.storageId) await ctx.storage.delete(head.storageId);
      await ctx.db.delete(entry.headId);
    }
    // Once every selected branch is inside a checkpoint sealed with the current project key, old
    // key envelopes are no longer needed for recovery. Keeping them forever would make rotations
    // grow Convex storage and administrative reads without bound.
    const envelopes = await ctx.db
      .query("projectKeyEnvelopes")
      .withIndex("by_project_device", (q) => q.eq("projectId", args.projectId))
      .collect();
    for (const envelope of envelopes) {
      if (isObsoleteEnvelopeEpoch(envelope.epoch, args.header.key_epoch)) {
        await ctx.db.delete(envelope._id);
      }
    }
    if (reservation) await ctx.db.delete(reservation._id);
    return { status: "committed" as const, epoch: next };
  },
});

/**
 * Discards a stale head that was never absorbed.
 *
 * The only path in this design allowed to lose a published operation, which is why it is owner-only
 * and refuses a head that is not actually stale. The destructive warning belongs in the UI; the
 * decision is also persisted in the bounded project audit trail.
 */
export const discardStaleHead = mutation({
  args: { headId: v.id("projectHeads") },
  handler: async (ctx, { headId }) => {
    const head = await ctx.db.get(headId);
    if (!head) return { status: "gone" as const };
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("not signed in");
    const project = await ctx.db.get(head.projectId);
    if (!project || project.ownerId !== user._id)
      throw new Error("only the owner may discard a head");
    const now = Date.now();
    const age = now - head.updatedAt;
    if (!isStaleHead(head.updatedAt, now))
      throw new Error("this head is not stale");
    if (head.storageId) await ctx.storage.delete(head.storageId);
    await ctx.db.delete(headId);
    await recordProjectAudit(ctx, {
      projectId: head.projectId,
      actorUserId: user._id,
      kind: "stale-head-discarded",
      target: head.deviceId,
      detail: `bytes=${head.bytes ?? head.ciphertext?.length ?? 0};ageMs=${age}`,
    });
    return {
      status: "discarded" as const,
      deviceId: head.deviceId,
      bytes: head.bytes ?? head.ciphertext?.length ?? 0,
      age,
    };
  },
});

/** Owner-only warning feed. Kept separate so opening the project list does not fan out head reads. */
export const listStaleHeads = query({
  args: { projectId: v.id("projects"), now: v.number() },
  handler: async (ctx, { projectId, now }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== user._id) return [];
    return (
      await ctx.db
        .query("projectHeads")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(MAX_PROJECT_HEADS)
    )
      .filter((head) => isStaleHead(head.updatedAt, now))
      .map((head) => ({
        headId: head._id,
        deviceId: head.deviceId,
        bytes: head.bytes ?? head.ciphertext?.length ?? 0,
        updatedAt: head.updatedAt,
      }));
  },
});

/** Publishes the wrapped project key for one device of the project. Owner or writer only. */
export const putKeyEnvelope = mutation({
  args: {
    projectId: v.id("projects"),
    deviceId: v.string(),
    epoch: v.number(),
    envelope: v.string(),
  },
  handler: async (ctx, args) => {
    const { user, member } = await requireMember(ctx, args.projectId, true);
    if (
      !Number.isSafeInteger(args.epoch) ||
      args.epoch <= 0 ||
      args.envelope.length > 16 * 1024
    ) {
      throw new Error("invalid key envelope");
    }
    const device = await ctx.db
      .query("userDevices")
      .withIndex("by_device", (q) => q.eq("deviceId", args.deviceId))
      .unique();
    if (
      !device ||
      device.registrationVersion !== 1 ||
      !device.signingPublic ||
      !device.exchangePublic ||
      !device.endpointId
    ) {
      throw new Error("recipient device has not completed proof registration");
    }
    const recipient = await ctx.db
      .query("projectMembers")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", args.projectId).eq("userId", device.userId),
      )
      .unique();
    if (!recipient) throw new Error("recipient is not a project member");
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("project is unavailable");
    const currentEpoch = project.keyEpoch ?? 0;
    if (project.rotationRequired) {
      if (
        member.role !== "owner" ||
        project.ownerId !== user._id ||
        args.epoch !== currentEpoch + 1
      ) {
        throw new Error(
          "only the owner may distribute the pending rotation epoch",
        );
      }
    } else if (args.epoch !== currentEpoch) {
      throw new Error("key envelope epoch is not current");
    }
    const existing = await ctx.db
      .query("projectKeyEnvelopes")
      .withIndex("by_project_device_epoch", (q) =>
        q
          .eq("projectId", args.projectId)
          .eq("deviceId", args.deviceId)
          .eq("epoch", args.epoch),
      )
      .unique();
    if (existing) return { status: "already" as const };
    await ctx.db.insert("projectKeyEnvelopes", {
      ...args,
      createdAt: Date.now(),
    });
    return { status: "stored" as const };
  },
});

/** The envelopes addressed to the caller's own devices — never anyone else's. */
export const myKeyEnvelopes = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const { user } = await requireMember(ctx, projectId, false);
    const devices = (
      await ctx.db
        .query("userDevices")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect()
    ).filter(
      (device) =>
        device.registrationVersion === 1 &&
        Boolean(device.signingPublic) &&
        Boolean(device.exchangePublic) &&
        Boolean(device.endpointId),
    );
    const out: Array<{ deviceId: string; epoch: number; envelope: string }> =
      [];
    for (const device of devices) {
      const rows = await ctx.db
        .query("projectKeyEnvelopes")
        .withIndex("by_project_device", (q) =>
          q.eq("projectId", projectId).eq("deviceId", device.deviceId),
        )
        .collect();
      for (const row of rows)
        out.push({
          deviceId: row.deviceId,
          epoch: row.epoch,
          envelope: row.envelope,
        });
    }
    return out;
  },
});

/** Commits a rotation only after every currently authorised device has the new epoch envelope. */
export const commitKeyRotation = mutation({
  args: {
    projectId: v.id("projects"),
    expectedEpoch: v.number(),
    newEpoch: v.number(),
  },
  handler: async (ctx, { projectId, expectedEpoch, newEpoch }) => {
    const { user, member } = await requireMember(ctx, projectId, true);
    if (member.role !== "owner")
      throw new Error("only the owner may commit key rotation");
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== user._id)
      throw new Error("project is unavailable");
    const currentEpoch = project.keyEpoch ?? 0;
    if (currentEpoch !== expectedEpoch)
      return { status: "conflict" as const, epoch: currentEpoch };
    if (newEpoch !== expectedEpoch + 1)
      throw new Error("key epoch must increase by one");
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const current of members) {
      const devices = await ctx.db
        .query("userDevices")
        .withIndex("by_user", (q) => q.eq("userId", current.userId))
        .collect();
      for (const device of devices) {
        // Rows created by the pre-proof prototype are not trusted devices and therefore cannot
        // block a rotation. They must re-register before they can receive a project key.
        if (
          device.registrationVersion !== 1 ||
          !device.signingPublic ||
          !device.exchangePublic ||
          !device.endpointId
        )
          continue;
        const envelope = await ctx.db
          .query("projectKeyEnvelopes")
          .withIndex("by_project_device_epoch", (q) =>
            q
              .eq("projectId", projectId)
              .eq("deviceId", device.deviceId)
              .eq("epoch", newEpoch),
          )
          .unique();
        if (!envelope)
          return {
            status: "missing-envelope" as const,
            deviceId: device.deviceId,
          };
      }
    }
    await ctx.db.patch(projectId, {
      keyEpoch: newEpoch,
      rotationRequired: false,
    });
    await recordProjectAudit(ctx, {
      projectId,
      actorUserId: user._id,
      kind: "key-rotated",
      detail: `${expectedEpoch}->${newEpoch}`,
    });
    return { status: "committed" as const, epoch: newEpoch };
  },
});

/** One row per member and project, patched in place — never one insert per edit. */
async function notify(ctx: any, projectId: Id<"projects">, actorId: string) {
  const members = await ctx.db
    .query("projectMembers")
    .withIndex("by_project", (q: any) => q.eq("projectId", projectId))
    .collect();
  const now = Date.now();
  for (const member of members) {
    if (member.userId === actorId) continue;
    const existing = await ctx.db
      .query("projectInbox")
      .withIndex("by_user_project", (q: any) =>
        q.eq("userId", member.userId).eq("projectId", projectId),
      )
      .unique();
    if (existing) {
      if (!existing.actors.includes(actorId)) {
        await ctx.db.patch(existing._id, {
          actors: [...existing.actors, actorId],
          updatedAt: now,
        });
      }
    } else {
      await ctx.db.insert("projectInbox", {
        userId: member.userId,
        projectId,
        actors: [actorId],
        mediaRequested: false,
        keyRequested: false,
        updatedAt: now,
      });
    }
  }
}

/** The caller's consolidated notifications. Read at launch — there is no live sync while closed. */
export const inbox = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("projectInbox")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(100);
    return rows.map((row) => ({
      projectId: row.projectId,
      actors: row.actors.length,
      mediaRequested: row.mediaRequested ?? false,
      keyRequested: row.keyRequested ?? false,
      updatedAt: row.updatedAt,
    }));
  },
});

export const clearInbox = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("not signed in");
    const row = await ctx.db
      .query("projectInbox")
      .withIndex("by_user_project", (q) =>
        q.eq("userId", user._id).eq("projectId", projectId),
      )
      .unique();
    if (row) await ctx.db.delete(row._id);
    return { status: "cleared" as const };
  },
});
