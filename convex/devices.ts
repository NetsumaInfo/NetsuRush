import { verifyAsync } from "@noble/ed25519";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";
import type { Id } from "./_generated/dataModel";
import { recordProjectAudit } from "./audit";

const REGISTRATION_DOMAIN = new TextEncoder().encode(
  "netsurush/device-registration/v1\0",
);
const REGISTRATION_TTL_MS = 10 * 60 * 1000;
const MAX_DEVICES = 5;
const HEX_KEY = /^[0-9a-f]{64}$/;

export type DeviceRegistrationStatement = {
  version: number;
  challenge: string;
  accountId: string;
  deviceId: string;
  signingPublic: string;
  exchangePublic: string;
  endpointId: string;
};

function littleEndian(value: number, bytes: 2 | 4): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, true);
  return output.slice(0, bytes);
}

function concatenate(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function buildRegistrationBytes(
  statement: DeviceRegistrationStatement,
): Uint8Array {
  const encoder = new TextEncoder();
  const fields = [
    statement.challenge,
    statement.accountId,
    statement.deviceId,
    statement.signingPublic,
    statement.exchangePublic,
    statement.endpointId,
  ].map((field) => encoder.encode(field));
  return concatenate([
    REGISTRATION_DOMAIN,
    littleEndian(statement.version, 2),
    ...fields.flatMap((field) => [littleEndian(field.length, 4), field]),
  ]);
}

function hexBytes(value: string): Uint8Array | null {
  if (!HEX_KEY.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function base64Bytes(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function validStatement(statement: DeviceRegistrationStatement): boolean {
  return (
    statement.version === 1 &&
    statement.challenge.length > 0 &&
    statement.challenge.length <= 256 &&
    statement.accountId.length > 0 &&
    statement.accountId.length <= 256 &&
    statement.deviceId === statement.signingPublic &&
    statement.endpointId === statement.signingPublic &&
    HEX_KEY.test(statement.deviceId) &&
    HEX_KEY.test(statement.signingPublic) &&
    HEX_KEY.test(statement.exchangePublic) &&
    HEX_KEY.test(statement.endpointId) &&
    Object.values(statement).every(
      (value) =>
        typeof value === "number" || !/[\u0000-\u001f\u007f]/.test(value),
    )
  );
}

export async function verifyDeviceProof(
  statement: DeviceRegistrationStatement,
  signatureBase64: string,
): Promise<boolean> {
  if (!validStatement(statement)) return false;
  const publicKey = hexBytes(statement.signingPublic);
  const signature = base64Bytes(signatureBase64);
  if (!publicKey || !signature || signature.length !== 64) return false;
  try {
    return await verifyAsync(
      signature,
      buildRegistrationBytes(statement),
      publicKey,
    );
  } catch {
    return false;
  }
}

const statementValidator = v.object({
  version: v.number(),
  challenge: v.string(),
  accountId: v.string(),
  deviceId: v.string(),
  signingPublic: v.string(),
  exchangePublic: v.string(),
  endpointId: v.string(),
});

/** Creates a short-lived, single-use registration challenge for this signed-in account. */
export const beginRegistration = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("not signed in");
    const now = Date.now();
    const existing = await ctx.db
      .query("deviceRegistrationChallenges")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);
    const challenge = await ctx.db.insert("deviceRegistrationChallenges", {
      userId: user._id,
      createdAt: now,
      expiresAt: now + REGISTRATION_TTL_MS,
    });
    return {
      challenge,
      accountId: user._id,
      expiresAt: now + REGISTRATION_TTL_MS,
    };
  },
});

/** Registers only a device that proves possession of its claimed Ed25519 secret. */
export const registerDevice = mutation({
  args: {
    statement: statementValidator,
    signature: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, { statement, signature, label }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("not signed in");
    if (statement.accountId !== user._id)
      throw new Error("registration account mismatch");
    const challenge = await ctx.db.get(
      statement.challenge as Id<"deviceRegistrationChallenges">,
    );
    if (
      !challenge ||
      challenge.userId !== user._id ||
      challenge.expiresAt <= Date.now()
    ) {
      throw new Error("registration challenge expired or unknown");
    }
    if (!(await verifyDeviceProof(statement, signature)))
      throw new Error("device proof does not verify");
    if (label && (label.length > 120 || /[\u0000-\u001f\u007f]/.test(label))) {
      throw new Error("invalid device label");
    }

    const revoked = await ctx.db
      .query("revokedDevices")
      .withIndex("by_device", (q) => q.eq("deviceId", statement.deviceId))
      .unique();
    if (revoked) throw new Error("this device identity has been revoked");

    const now = Date.now();
    const existing = await ctx.db
      .query("userDevices")
      .withIndex("by_device", (q) => q.eq("deviceId", statement.deviceId))
      .unique();
    if (existing && existing.userId !== user._id)
      throw new Error("device belongs to another account");
    if (!existing) {
      const devices = await ctx.db
        .query("userDevices")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();
      if (devices.length >= MAX_DEVICES)
        throw new Error("this account already has five devices");
    }
    const row = {
      userId: user._id,
      deviceId: statement.deviceId,
      signingPublic: statement.signingPublic,
      exchangePublic: statement.exchangePublic,
      endpointId: statement.endpointId,
      registrationVersion: statement.version,
      label,
      lastSeenAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("userDevices", { ...row, createdAt: now });
    await ctx.db.delete(challenge._id);
    return {
      status: existing ? ("refreshed" as const) : ("registered" as const),
    };
  },
});

export const listDevices = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("userDevices")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
  },
});

/** Cheap token refresh path: a known proved device does not mint a new challenge every five minutes. */
export const getCurrentRegistration = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return null;
    const device = await ctx.db
      .query("userDevices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (
      !device ||
      device.userId !== user._id ||
      device.registrationVersion !== 1 ||
      !device.signingPublic ||
      !device.exchangePublic ||
      !device.endpointId
    )
      return null;
    return { deviceId: device.deviceId };
  },
});

/** Devices are disclosed only inside projects shared with the caller. */
export const listProjectDevices = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const mine = await ctx.db
      .query("projectMembers")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", projectId).eq("userId", user._id),
      )
      .unique();
    if (!mine) return [];
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const output = [];
    for (const member of members) {
      const devices = await ctx.db
        .query("userDevices")
        .withIndex("by_user", (q) => q.eq("userId", member.userId))
        .collect();
      for (const device of devices) {
        if (
          device.registrationVersion !== 1 ||
          !device.signingPublic ||
          !device.exchangePublic ||
          !device.endpointId
        )
          continue;
        output.push({
          userId: member.userId,
          deviceId: device.deviceId,
          signingPublic: device.signingPublic,
          exchangePublic: device.exchangePublic,
          endpointId: device.endpointId,
          canWrite: member.role === "owner" || member.role === "editor",
          isCurrentAccount: member.userId === user._id,
        });
      }
    }
    return output;
  },
});

export const forgetDevice = mutation({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) throw new Error("not signed in");
    const row = await ctx.db
      .query("userDevices")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (row?.userId === user._id) {
      const tombstone = await ctx.db
        .query("revokedDevices")
        .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
        .unique();
      if (!tombstone) {
        await ctx.db.insert("revokedDevices", {
          userId: user._id,
          deviceId,
          revokedAt: Date.now(),
        });
      }
      const uploads = await ctx.db
        .query("projectPayloadUploads")
        .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
        .collect();
      for (const upload of uploads) {
        if (await ctx.db.system.get(upload.storageId))
          await ctx.storage.delete(upload.storageId);
        await ctx.db.delete(upload._id);
      }
      const memberships = await ctx.db
        .query("projectMembers")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();
      for (const membership of memberships) {
        await ctx.db.patch(membership.projectId, { rotationRequired: true });
        const envelopes = await ctx.db
          .query("projectKeyEnvelopes")
          .withIndex("by_project_device", (q) =>
            q.eq("projectId", membership.projectId).eq("deviceId", deviceId),
          )
          .collect();
        for (const envelope of envelopes) await ctx.db.delete(envelope._id);
        await recordProjectAudit(ctx, {
          projectId: membership.projectId,
          actorUserId: user._id,
          kind: "device-forgotten",
          target: deviceId,
        });
      }
      await ctx.db.delete(row._id);
    }
    return { status: "forgotten" as const };
  },
});
