import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";
import type { Id } from "./_generated/dataModel";
import { recordProjectAudit } from "./audit";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MEMBERS = 10;
const MAX_PROJECTS_PER_ACCOUNT = 100;
const MAX_VISIBLE_INVITES = 100;
export type ProjectRole = "owner" | "editor" | "viewer";

export function normalizeProjectRole(value: string): ProjectRole | null {
  return value === "owner" || value === "editor" || value === "viewer"
    ? value
    : null;
}

export function canInvite(role: ProjectRole): boolean {
  return role === "owner";
}

/**
 * Which module of the app a project belongs to. Kept in clear (see `schema.ts`) because an
 * invitation must name what it invites to before its recipient holds any key, and because the app
 * has to know which local object to create when they accept. The server does not interpret the
 * label, it only bounds it, so a new surface needs no backend change.
 */
export const DEFAULT_SURFACE = "board";

export function normalizeSurface(value: string | undefined): string {
  const label = (value ?? "").trim().toLowerCase();
  if (!label) return DEFAULT_SURFACE;
  if (label.length > 32 || !/^[a-z][a-z0-9-]*$/.test(label))
    throw new Error("invalid project surface");
  return label;
}

async function requireUser(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("not signed in");
  return user;
}

async function membership(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  userId: string,
) {
  return ctx.db
    .query("projectMembers")
    .withIndex("by_project_user", (q) =>
      q.eq("projectId", projectId).eq("userId", userId),
    )
    .unique();
}

async function requireOwner(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  userId: string,
) {
  const row = await membership(ctx, projectId, userId);
  if (!row || row.role !== "owner")
    throw new Error("only the project owner may do this");
  return row;
}

async function areFriends(ctx: QueryCtx, userId: string, otherId: string) {
  return Boolean(
    await ctx.db
      .query("friends")
      .withIndex("by_pair", (q) =>
        q.eq("userId", userId).eq("friendId", otherId),
      )
      .unique(),
  );
}

async function profileFor(ctx: QueryCtx, userId: string) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return {
    userId,
    handle: profile?.handle ?? "",
    name: profile?.name ?? "",
    image: profile?.image ?? null,
  };
}

async function deleteExpiredInvites(
  ctx: MutationCtx,
  projectId: Id<"projects">,
) {
  const rows = await ctx.db
    .query("projectInvites")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  const live = [];
  for (const row of rows) {
    if (row.expiresAt <= Date.now()) await ctx.db.delete(row._id);
    else live.push(row);
  }
  return live;
}

export const createProject = mutation({
  args: { nameCipher: v.optional(v.string()), surface: v.optional(v.string()) },
  handler: async (ctx, { nameCipher, surface }) => {
    const user = await requireUser(ctx);
    const label = normalizeSurface(surface);
    if (nameCipher && nameCipher.length > 16 * 1024)
      throw new Error("encrypted name is too large");
    const existing = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_PROJECTS_PER_ACCOUNT);
    if (existing.length >= MAX_PROJECTS_PER_ACCOUNT)
      throw new Error("project limit reached");
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      ownerId: user._id,
      createdAt: now,
      surface: label,
      nameCipher,
      keyEpoch: 0,
      rotationRequired: true,
    });
    await ctx.db.insert("projectMembers", {
      projectId,
      userId: user._id,
      role: "owner",
      addedAt: now,
    });
    return { projectId };
  },
});

/** Rollback for a native creation that failed before its first checkpoint became recoverable. */
export const abortEmptyProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await requireUser(ctx);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== user._id)
      throw new Error("only the project owner may abort creation");
    const checkpoint = await ctx.db
      .query("projectCheckpoints")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .unique();
    const heads = await ctx.db
      .query("projectHeads")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    if (
      checkpoint ||
      heads.length ||
      members.some((member) => member.userId !== user._id)
    ) {
      throw new Error(
        "project creation is already recoverable and cannot be rolled back",
      );
    }
    const invites = await ctx.db
      .query("projectInvites")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const envelopes = await ctx.db
      .query("projectKeyEnvelopes")
      .withIndex("by_project_device", (q) => q.eq("projectId", projectId))
      .collect();
    const mediaRequests = await ctx.db
      .query("projectMediaRequests")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const uploads = await ctx.db
      .query("projectPayloadUploads")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const invite of invites) await ctx.db.delete(invite._id);
    for (const envelope of envelopes) await ctx.db.delete(envelope._id);
    for (const request of mediaRequests) await ctx.db.delete(request._id);
    for (const upload of uploads) {
      if (await ctx.db.system.get(upload.storageId))
        await ctx.storage.delete(upload.storageId);
      await ctx.db.delete(upload._id);
    }
    for (const member of members) await ctx.db.delete(member._id);
    await ctx.db.delete(projectId);
    return { status: "aborted" as const };
  },
});

export const invite = mutation({
  args: {
    projectId: v.id("projects"),
    userIds: v.array(v.string()),
    role: v.string(),
  },
  handler: async (ctx, { projectId, userIds, role }) => {
    const user = await requireUser(ctx);
    await requireOwner(ctx, projectId, user._id);
    const grantedRole = normalizeProjectRole(role);
    if (!grantedRole || grantedRole === "owner")
      throw new Error("invite role must be editor or viewer");
    const targets = [...new Set(userIds)];
    if (!targets.length || targets.length > MAX_MEMBERS - 1)
      throw new Error("invalid invite count");
    if (
      targets.some(
        (target) =>
          !target ||
          target.length > 256 ||
          /[\u0000-\u001f\u007f]/.test(target),
      )
    ) {
      throw new Error("invalid invitation account id");
    }
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const pending = await deleteExpiredInvites(ctx, projectId);
    let seats = MAX_MEMBERS - members.length - pending.length;
    const now = Date.now();
    const results = [];
    for (const target of targets) {
      if (target === user._id || !(await areFriends(ctx, user._id, target))) {
        results.push({ userId: target, status: "not-eligible" });
        continue;
      }
      if (await membership(ctx, projectId, target)) {
        results.push({ userId: target, status: "already-member" });
        continue;
      }
      const existing = pending.find((row) => row.toUserId === target);
      if (existing) {
        await ctx.db.patch(existing._id, {
          role: grantedRole,
          createdAt: now,
          expiresAt: now + INVITE_TTL_MS,
        });
        results.push({ userId: target, status: "refreshed" });
        continue;
      }
      if (seats <= 0) {
        results.push({ userId: target, status: "full" });
        continue;
      }
      await ctx.db.insert("projectInvites", {
        projectId,
        fromUserId: user._id,
        toUserId: target,
        role: grantedRole,
        createdAt: now,
        expiresAt: now + INVITE_TTL_MS,
      });
      seats -= 1;
      results.push({ userId: target, status: "invited" });
    }
    return { results };
  },
});

export const listInvites = query({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query("projectInvites")
      .withIndex("by_to_expiry", (q) =>
        q.eq("toUserId", user._id).gt("expiresAt", now),
      )
      .take(MAX_VISIBLE_INVITES);
    return Promise.all(
      rows.map(async (row) => ({
        inviteId: row._id,
        projectId: row.projectId,
        role: row.role,
        surface: (await ctx.db.get(row.projectId))?.surface ?? DEFAULT_SURFACE,
        from: await profileFor(ctx, row.fromUserId),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      })),
    );
  },
});

export const cancelInvite = mutation({
  args: { inviteId: v.id("projectInvites") },
  handler: async (ctx, { inviteId }) => {
    const user = await requireUser(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) return { status: "gone" as const };
    await requireOwner(ctx, invite.projectId, user._id);
    await ctx.db.delete(inviteId);
    return { status: "cancelled" as const };
  },
});

export const respondInvite = mutation({
  args: { inviteId: v.id("projectInvites"), accept: v.boolean() },
  handler: async (ctx, { inviteId, accept }) => {
    const user = await requireUser(ctx);
    const invite = await ctx.db.get(inviteId);
    if (!invite) return { status: "gone" as const };
    if (invite.toUserId !== user._id)
      throw new Error("invitation does not belong to this account");
    if (!accept || invite.expiresAt <= Date.now()) {
      await ctx.db.delete(inviteId);
      return { status: accept ? ("expired" as const) : ("declined" as const) };
    }
    const role = normalizeProjectRole(invite.role);
    if (!role || role === "owner") throw new Error("invalid invitation role");
    const mine = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_PROJECTS_PER_ACCOUNT);
    if (
      mine.length >= MAX_PROJECTS_PER_ACCOUNT &&
      !mine.some((row) => row.projectId === invite.projectId)
    ) {
      return { status: "account-full" as const };
    }
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", invite.projectId))
      .collect();
    if (
      members.length >= MAX_MEMBERS &&
      !members.some((member) => member.userId === user._id)
    ) {
      return { status: "full" as const };
    }
    const alreadyMember = await membership(ctx, invite.projectId, user._id);
    if (!alreadyMember) {
      await ctx.db.insert("projectMembers", {
        projectId: invite.projectId,
        userId: user._id,
        role,
        addedAt: Date.now(),
      });
      // A new member cannot decrypt the project until an existing writer wraps the current key for
      // their proved device. Reuse the one-row inbox instead of polling every open project.
      for (const member of members) {
        if (member.role !== "owner" && member.role !== "editor") continue;
        const existing = await ctx.db
          .query("projectInbox")
          .withIndex("by_user_project", (q) =>
            q.eq("userId", member.userId).eq("projectId", invite.projectId),
          )
          .unique();
        const now = Date.now();
        if (existing) {
          const actorAdded = !existing.actors.includes(user._id);
          const actors = actorAdded
            ? [...existing.actors, user._id]
            : existing.actors;
          if (!existing.keyRequested || actorAdded) {
            await ctx.db.patch(existing._id, {
              actors,
              keyRequested: true,
              updatedAt: now,
            });
          }
        } else {
          await ctx.db.insert("projectInbox", {
            userId: member.userId,
            projectId: invite.projectId,
            actors: [user._id],
            mediaRequested: false,
            keyRequested: true,
            updatedAt: now,
          });
        }
      }
    }
    await ctx.db.delete(inviteId);
    return {
      status: "joined" as const,
      projectId: invite.projectId,
      keyStatus: "pending" as const,
    };
  },
});

/** Cheap account overview: no member-profile or invitation fan-out for every known project. */
export const listProjectSummaries = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const mine = await ctx.db
      .query("projectMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_PROJECTS_PER_ACCOUNT);
    return Promise.all(
      mine.map(async (row) => {
        const project = await ctx.db.get(row.projectId);
        return {
          projectId: row.projectId,
          role: row.role,
          isOwner: project?.ownerId === user._id,
          surface: project?.surface ?? DEFAULT_SURFACE,
          createdAt: project?.createdAt ?? row.addedAt,
          nameCipher: project?.nameCipher ?? null,
          keyEpoch: project?.keyEpoch ?? 0,
          rotationRequired: project?.rotationRequired ?? false,
        };
      }),
    );
  },
});

/** Full roster only for the one project whose collaboration dialog is open. */
export const getProjectDetails = query({
  args: { projectId: v.id("projects"), now: v.number() },
  handler: async (ctx, { projectId, now }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return null;
    const mine = await membership(ctx, projectId, user._id);
    const project = await ctx.db.get(projectId);
    if (!mine || !project) return null;
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const pending = (
      await ctx.db
        .query("projectInvites")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect()
    ).filter((invite) => invite.expiresAt > now);
    return {
      projectId,
      role: mine.role,
      surface: project.surface ?? DEFAULT_SURFACE,
      rotationRequired: project.rotationRequired ?? false,
      members: await Promise.all(
        members.map(async (member) => ({
          ...(await profileFor(ctx, member.userId)),
          role: member.role,
        })),
      ),
      pending: await Promise.all(
        pending.map(async (invite) => ({
          ...(await profileFor(ctx, invite.toUserId)),
          inviteId: invite._id,
          role: invite.role,
        })),
      ),
    };
  },
});

export const getProjectAccess = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return null;
    const row = await membership(ctx, projectId, user._id);
    const project = await ctx.db.get(projectId);
    if (!row || !project) return null;
    return {
      role: row.role,
      keyEpoch: project.keyEpoch ?? 0,
      rotationRequired: project.rotationRequired ?? false,
    };
  },
});

export const listAuditEvents = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return [];
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== user._id) return [];
    return ctx.db
      .query("projectAuditEvents")
      .withIndex("by_project_created", (q) => q.eq("projectId", projectId))
      .order("desc")
      .take(100);
  },
});

/** Single-query native security snapshot: membership, current epoch and proved project devices. */
export const getProjectRoster = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return null;
    const mine = await membership(ctx, projectId, user._id);
    const project = await ctx.db.get(projectId);
    if (!mine || !project) return null;
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const devices = [];
    for (const member of members) {
      const rows = await ctx.db
        .query("userDevices")
        .withIndex("by_user", (q) => q.eq("userId", member.userId))
        .collect();
      for (const device of rows) {
        if (
          device.registrationVersion !== 1 ||
          !device.signingPublic ||
          !device.exchangePublic ||
          !device.endpointId
        )
          continue;
        const currentEnvelope = await ctx.db
          .query("projectKeyEnvelopes")
          .withIndex("by_project_device_epoch", (q) =>
            q
              .eq("projectId", projectId)
              .eq("deviceId", device.deviceId)
              .eq("epoch", project.keyEpoch ?? 0),
          )
          .unique();
        devices.push({
          userId: member.userId,
          deviceId: device.deviceId,
          signingPublic: device.signingPublic,
          exchangePublic: device.exchangePublic,
          endpointId: device.endpointId,
          canWrite: member.role === "owner" || member.role === "editor",
          isCurrentAccount: member.userId === user._id,
          hasCurrentEnvelope: Boolean(currentEnvelope),
        });
      }
    }
    return {
      access: {
        role: mine.role,
        keyEpoch: project.keyEpoch ?? 0,
        rotationRequired: project.rotationRequired ?? false,
      },
      devices,
    };
  },
});

export const setMemberRole = mutation({
  args: { projectId: v.id("projects"), userId: v.string(), role: v.string() },
  handler: async (ctx, { projectId, userId, role }) => {
    const user = await requireUser(ctx);
    await requireOwner(ctx, projectId, user._id);
    const next = normalizeProjectRole(role);
    if (
      !userId ||
      userId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(userId)
    ) {
      throw new Error("invalid member account id");
    }
    if (!next || next === "owner")
      throw new Error("member role must be editor or viewer");
    const row = await membership(ctx, projectId, userId);
    if (!row || row.role === "owner")
      throw new Error("member cannot be changed");
    const downgrade = row.role === "editor" && next === "viewer";
    await ctx.db.patch(row._id, { role: next });
    if (downgrade) await ctx.db.patch(projectId, { rotationRequired: true });
    await recordProjectAudit(ctx, {
      projectId,
      actorUserId: user._id,
      kind: "member-role-changed",
      target: userId,
      detail: `${row.role}->${next}`,
    });
    return { status: "updated" as const, rotationRequired: downgrade };
  },
});

export const removeMember = mutation({
  args: { projectId: v.id("projects"), userId: v.string() },
  handler: async (ctx, { projectId, userId }) => {
    const user = await requireUser(ctx);
    await requireOwner(ctx, projectId, user._id);
    if (
      !userId ||
      userId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(userId)
    ) {
      throw new Error("invalid member account id");
    }
    const project = await ctx.db.get(projectId);
    if (!project || userId === project.ownerId)
      throw new Error("owner cannot be removed");
    const row = await membership(ctx, projectId, userId);
    if (row) await ctx.db.delete(row._id);
    const devices = await ctx.db
      .query("userDevices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const device of devices) {
      const envelopes = await ctx.db
        .query("projectKeyEnvelopes")
        .withIndex("by_project_device", (q) =>
          q.eq("projectId", projectId).eq("deviceId", device.deviceId),
        )
        .collect();
      for (const envelope of envelopes) await ctx.db.delete(envelope._id);
    }
    const notice = await ctx.db
      .query("projectInbox")
      .withIndex("by_user_project", (q) =>
        q.eq("userId", userId).eq("projectId", projectId),
      )
      .unique();
    if (notice) await ctx.db.delete(notice._id);
    const mediaRequest = await ctx.db
      .query("projectMediaRequests")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", projectId).eq("userId", userId),
      )
      .unique();
    if (mediaRequest) await ctx.db.delete(mediaRequest._id);
    const uploads = await ctx.db
      .query("projectPayloadUploads")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", projectId).eq("userId", userId),
      )
      .collect();
    for (const upload of uploads) {
      if (await ctx.db.system.get(upload.storageId))
        await ctx.storage.delete(upload.storageId);
      await ctx.db.delete(upload._id);
    }
    await ctx.db.patch(projectId, { rotationRequired: true });
    await recordProjectAudit(ctx, {
      projectId,
      actorUserId: user._id,
      kind: "member-removed",
      target: userId,
    });
    return { status: "removed" as const, rotationRequired: true };
  },
});

export const leaveProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await requireUser(ctx);
    const project = await ctx.db.get(projectId);
    if (!project) return { status: "gone" as const };
    if (project.ownerId === user._id)
      throw new Error("the owner must delete the project instead");
    const row = await membership(ctx, projectId, user._id);
    if (!row) return { status: "gone" as const };
    await ctx.db.delete(row._id);
    const devices = await ctx.db
      .query("userDevices")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    for (const device of devices) {
      const envelopes = await ctx.db
        .query("projectKeyEnvelopes")
        .withIndex("by_project_device", (q) =>
          q.eq("projectId", projectId).eq("deviceId", device.deviceId),
        )
        .collect();
      for (const envelope of envelopes) await ctx.db.delete(envelope._id);
    }
    const notice = await ctx.db
      .query("projectInbox")
      .withIndex("by_user_project", (q) =>
        q.eq("userId", user._id).eq("projectId", projectId),
      )
      .unique();
    if (notice) await ctx.db.delete(notice._id);
    const mediaRequest = await ctx.db
      .query("projectMediaRequests")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", projectId).eq("userId", user._id),
      )
      .unique();
    if (mediaRequest) await ctx.db.delete(mediaRequest._id);
    const uploads = await ctx.db
      .query("projectPayloadUploads")
      .withIndex("by_project_user", (q) =>
        q.eq("projectId", projectId).eq("userId", user._id),
      )
      .collect();
    for (const upload of uploads) {
      if (await ctx.db.system.get(upload.storageId))
        await ctx.storage.delete(upload.storageId);
      await ctx.db.delete(upload._id);
    }
    await ctx.db.patch(projectId, { rotationRequired: true });
    await recordProjectAudit(ctx, {
      projectId,
      actorUserId: user._id,
      kind: "member-left",
      target: user._id,
    });
    return { status: "left" as const, rotationRequired: true };
  },
});

export const deleteProject = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    const user = await requireUser(ctx);
    await requireOwner(ctx, projectId, user._id);
    const project = await ctx.db.get(projectId);
    if (!project || project.ownerId !== user._id)
      throw new Error("project is unavailable");
    const checkpoint = await ctx.db
      .query("projectCheckpoints")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .unique();
    if (checkpoint?.storageId) await ctx.storage.delete(checkpoint.storageId);
    if (checkpoint) await ctx.db.delete(checkpoint._id);
    const heads = await ctx.db
      .query("projectHeads")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const head of heads) {
      if (head.storageId) await ctx.storage.delete(head.storageId);
      await ctx.db.delete(head._id);
    }
    const members = await ctx.db
      .query("projectMembers")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const invites = await ctx.db
      .query("projectInvites")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const envelopes = await ctx.db
      .query("projectKeyEnvelopes")
      .withIndex("by_project_device", (q) => q.eq("projectId", projectId))
      .collect();
    const mediaRequests = await ctx.db
      .query("projectMediaRequests")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const uploads = await ctx.db
      .query("projectPayloadUploads")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const member of members) await ctx.db.delete(member._id);
    for (const invite of invites) await ctx.db.delete(invite._id);
    for (const envelope of envelopes) await ctx.db.delete(envelope._id);
    for (const request of mediaRequests) await ctx.db.delete(request._id);
    for (const upload of uploads) {
      if (await ctx.db.system.get(upload.storageId))
        await ctx.storage.delete(upload.storageId);
      await ctx.db.delete(upload._id);
    }
    const notices = await ctx.db
      .query("projectInbox")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const notice of notices) await ctx.db.delete(notice._id);
    const auditEvents = await ctx.db
      .query("projectAuditEvents")
      .withIndex("by_project_created", (q) => q.eq("projectId", projectId))
      .collect();
    for (const event of auditEvents) await ctx.db.delete(event._id);
    await ctx.db.delete(projectId);
    return { status: "deleted" as const };
  },
});
