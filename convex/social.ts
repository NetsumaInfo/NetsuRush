// Friend graph for collaborative projects (docs/collab.md §5).
//
// Discord signs the user in and nothing more: reading someone's Discord friends needs the
// `relationships.read` scope, which is part of the Social SDK and gated behind Discord's approval.
// So the graph is NetsuRush's own, keyed by Better Auth ids, and someone is added by a stable
// NetsuRush handle derived from their authenticated account.
//
// Every function authenticates and scopes to the caller. Membership and friendship are checked
// server-side: possession of a key is never authorisation.

import {
  internalMutation,
  query,
  mutation,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { authComponent } from "./auth";

const MAX_FRIENDS = 200;
const MAX_PENDING_REQUESTS = 100;
const DISCORD_ID = /^\d{17,20}$/;
const DISCORD_USERNAME = /^[a-z0-9_.]{2,32}$/;

function validText(value: string, maximum: number) {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

async function requireUser(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user) throw new Error("not signed in");
  return user;
}

function normalizeHandle(handle: string) {
  return handle
    .trim()
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeDiscordUsername(username: string) {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export function classifySocialIdentifier(identifier: string) {
  const normalized = normalizeDiscordUsername(identifier);
  return {
    discordId: DISCORD_ID.test(normalized) ? normalized : null,
    discordUsername: DISCORD_USERNAME.test(normalized) ? normalized : null,
    handle: normalizeHandle(identifier),
  };
}

export function uniqueProfileIds(
  profiles: ReadonlyArray<{ userId: string } | null | undefined>,
) {
  return [...new Set(profiles.flatMap((profile) => profile ? [profile.userId] : []))];
}

export function profileHandle(suggested: string, accountId: string) {
  const base = normalizeHandle(suggested) || "user";
  const suffix = accountId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-16);
  if (!suffix) throw new Error("account cannot produce a stable handle");
  return `${base.slice(0, 64 - suffix.length - 1)}-${suffix}`;
}

async function profileOf(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

async function publicProfile(ctx: QueryCtx, userId: string) {
  const profile = await profileOf(ctx, userId);
  return {
    userId,
    handle: profile?.handle ?? "",
    discordUsername: profile?.discordUsername ?? null,
    name: profile?.name ?? "",
    image: profile?.image ?? null,
  };
}

/** Records only Discord fields fetched by the authenticated server action. */
export const syncDiscordProfile = internalMutation({
  args: {
    userId: v.string(),
    discordId: v.string(),
    discordUsername: v.string(),
    name: v.string(),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const discordUsername = normalizeDiscordUsername(args.discordUsername);
    const name = args.name.trim() || discordUsername;
    if (!DISCORD_ID.test(args.discordId) || !DISCORD_USERNAME.test(discordUsername))
      throw new Error("invalid Discord profile");
    if (!validText(name, 120)) throw new Error("invalid public profile");
    if (args.image) {
      if (args.image.length > 2048) throw new Error("profile image URL is too long");
      try {
        if (new URL(args.image).protocol !== "https:") throw new Error();
      } catch {
        throw new Error("profile image URL must use HTTPS");
      }
    }

    const discordIdOwners = await ctx.db
      .query("profiles")
      .withIndex("by_discord_id", (q) => q.eq("discordId", args.discordId))
      .take(2);
    if (discordIdOwners.some((profile) => profile.userId !== args.userId))
      throw new Error("Discord account is already linked to another NetsuRush account");

    const now = Date.now();
    const usernameOwners = await ctx.db
      .query("profiles")
      .withIndex("by_discord_username", (q) =>
        q.eq("discordUsername", discordUsername),
      )
      .take(10);
    for (const profile of usernameOwners) {
      if (profile.userId !== args.userId) {
        await ctx.db.patch(profile._id, { discordUsername: undefined, updatedAt: now });
      }
    }

    const existing = await profileOf(ctx, args.userId);
    const handle = existing?.handle ?? profileHandle(discordUsername, args.userId);
    const handleOwner = await ctx.db
      .query("profiles")
      .withIndex("by_handle", (q) => q.eq("handle", handle))
      .unique();
    if (handleOwner && handleOwner.userId !== args.userId)
      throw new Error("this NetsuRush handle is already in use");

    const row = {
      userId: args.userId,
      handle,
      discordId: args.discordId,
      discordUsername,
      name,
      image: args.image,
      updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("profiles", row);
    // Anyone who added this account before it ever signed in here now has a real request.
    await bindPendingRequests(ctx, args.userId, {
      handle,
      discordId: args.discordId,
      discordUsername,
    });
  },
});

/** Caps the sender, exactly like a resolved request: a pending row is still a row. */
async function requestPending(
  ctx: MutationCtx,
  fromUserId: string,
  label: string,
  classified: { discordId: string | null; discordUsername: string | null; handle: string },
) {
  if (!classified.discordId && !classified.discordUsername && !validText(classified.handle, 64)) {
    return { status: "unknown" as const };
  }
  const outgoing = await ctx.db
    .query("friendRequests")
    .withIndex("by_from", (q) => q.eq("fromUserId", fromUserId))
    .take(MAX_PENDING_REQUESTS);
  if (outgoing.length >= MAX_PENDING_REQUESTS) throw new Error("friend request limit reached");
  const duplicate = outgoing.find(
    (row) =>
      !row.toUserId &&
      ((classified.discordId && row.toDiscordId === classified.discordId) ||
        (classified.discordUsername && row.toDiscordUsername === classified.discordUsername) ||
        (classified.handle && row.toHandle === classified.handle)),
  );
  if (duplicate) return { status: "pending" as const };

  await ctx.db.insert("friendRequests", {
    fromUserId,
    toUserId: "",
    toDiscordId: classified.discordId ?? undefined,
    toDiscordUsername: classified.discordUsername ?? undefined,
    toHandle: validText(classified.handle, 64) ? classified.handle : undefined,
    toLabel: label.slice(0, 128),
    createdAt: Date.now(),
  });
  return { status: "invited" as const };
}

/**
 * Binds every request that was addressed to this identity before it existed here.
 *
 * Called right after a profile is published. A request that meanwhile crossed one coming the other
 * way is accepted immediately, and a request whose sender is now already a friend is dropped:
 * neither should survive as a pending row nobody can act on.
 */
async function bindPendingRequests(
  ctx: MutationCtx,
  userId: string,
  profile: { handle: string; discordId?: string; discordUsername?: string },
) {
  const candidates = [];
  if (profile.discordId) {
    candidates.push(
      ...(await ctx.db
        .query("friendRequests")
        .withIndex("by_pending_discord_id", (q) => q.eq("toDiscordId", profile.discordId))
        .take(MAX_PENDING_REQUESTS)),
    );
  }
  if (profile.discordUsername) {
    candidates.push(
      ...(await ctx.db
        .query("friendRequests")
        .withIndex("by_pending_discord_username", (q) =>
          q.eq("toDiscordUsername", profile.discordUsername),
        )
        .take(MAX_PENDING_REQUESTS)),
    );
  }
  candidates.push(
    ...(await ctx.db
      .query("friendRequests")
      .withIndex("by_pending_handle", (q) => q.eq("toHandle", profile.handle))
      .take(MAX_PENDING_REQUESTS)),
  );

  const seen = new Set<string>();
  for (const row of candidates) {
    if (row.toUserId || seen.has(row._id)) continue;
    seen.add(row._id);
    if (row.fromUserId === userId) {
      await ctx.db.delete(row._id);
      continue;
    }
    const already = await ctx.db
      .query("friends")
      .withIndex("by_pair", (q) => q.eq("userId", userId).eq("friendId", row.fromUserId))
      .unique();
    if (already) {
      await ctx.db.delete(row._id);
      continue;
    }
    const mirrored = await ctx.db
      .query("friendRequests")
      .withIndex("by_pair", (q) => q.eq("fromUserId", userId).eq("toUserId", row.fromUserId))
      .unique();
    if (mirrored) {
      await link(ctx, userId, row.fromUserId);
      await ctx.db.delete(mirrored._id);
      await ctx.db.delete(row._id);
      continue;
    }
    await ctx.db.patch(row._id, {
      toUserId: userId,
      toDiscordId: undefined,
      toDiscordUsername: undefined,
      toHandle: undefined,
    });
  }
}

/**
 * Publishes the caller's server-authenticated public fields so others can find them by a unique
 * NetsuRush handle.
 *
 * Called by the renderer on every authenticated start so display-name or avatar changes do not
 * leave a stale row that nobody can resolve.
 */
export const upsertProfile = mutation({
  args: { handle: v.string() },
  handler: async (ctx, { handle }) => {
    const user = await requireUser(ctx);
    const base = normalizeHandle(handle) || "user";
    // The suffix is derived server-side from the authenticated account. Another renderer cannot
    // pre-claim or impersonate it by choosing the same visible Discord name.
    const normalized = profileHandle(base, user._id);
    const name = user.name?.trim() || base;
    const image = user.image || undefined;
    if (!validText(normalized, 64) || !validText(name, 120))
      throw new Error("invalid public profile");
    if (image) {
      if (image.length > 2048) throw new Error("profile image URL is too long");
      try {
        if (new URL(image).protocol !== "https:") throw new Error();
      } catch {
        throw new Error("profile image URL must use HTTPS");
      }
    }
    const existing = await profileOf(ctx, user._id);
    const handleOwner = await ctx.db
      .query("profiles")
      .withIndex("by_handle", (q) => q.eq("handle", normalized))
      .unique();
    if (handleOwner && handleOwner.userId !== user._id)
      throw new Error("this NetsuRush handle is already in use");
    const row = {
      userId: user._id,
      handle: normalized,
      name,
      image,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("profiles", row);
    await bindPendingRequests(ctx, user._id, {
      handle: normalized,
      discordId: existing?.discordId,
      discordUsername: existing?.discordUsername,
    });
    return { handle: normalized };
  },
});

/** Friends, plus requests in both directions. One query feeds the whole settings section. */
export const listSocial = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx);
    if (!user) return { friends: [], incoming: [], outgoing: [], self: null };

    const friendRows = await ctx.db
      .query("friends")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .take(MAX_FRIENDS);
    const incomingRows = await ctx.db
      .query("friendRequests")
      .withIndex("by_to", (q) => q.eq("toUserId", user._id))
      .take(MAX_PENDING_REQUESTS);
    const outgoingRows = await ctx.db
      .query("friendRequests")
      .withIndex("by_from", (q) => q.eq("fromUserId", user._id))
      .take(MAX_PENDING_REQUESTS);

    return {
      self: await publicProfile(ctx, user._id),
      friends: await Promise.all(
        friendRows.map(async (row) => ({
          ...(await publicProfile(ctx, row.friendId)),
          since: row.since,
        })),
      ),
      incoming: await Promise.all(
        incomingRows.map(async (row) => ({
          requestId: row._id,
          ...(await publicProfile(ctx, row.fromUserId)),
        })),
      ),
      outgoing: await Promise.all(
        outgoingRows.map(async (row) =>
          row.toUserId
            ? { requestId: row._id, pending: false, ...(await publicProfile(ctx, row.toUserId)) }
            : {
                requestId: row._id,
                // Nobody to resolve yet. ONE label — the identifier that was typed — because the
                // handle, the Discord username and the label are the same string at this point, and
                // printing all three showed the same pseudonym twice. Name and avatar arrive with
                // the account, the moment it signs in.
                pending: true,
                userId: "",
                handle: "",
                discordUsername: null,
                name: row.toLabel ?? row.toHandle ?? "",
                image: null,
              },
        ),
      ),
    };
  },
});

/**
 * Sends a friend request by exact Discord id, Discord username, or NetsuRush handle.
 *
 * A request that crosses one already coming the other way is accepted immediately: making two people
 * who each asked first wait for one another would be a dead end with no way out.
 */
export const sendRequest = mutation({
  args: { identifier: v.string() },
  handler: async (ctx, { identifier }) => {
    const user = await requireUser(ctx);
    if (!validText(identifier.trim(), 128)) throw new Error("invalid identifier");
    const classified = classifySocialIdentifier(identifier);
    const matches = [];
    if (validText(classified.handle, 64)) {
      matches.push(
        await ctx.db
          .query("profiles")
          .withIndex("by_handle", (q) => q.eq("handle", classified.handle))
          .unique(),
      );
    }
    if (classified.discordId) {
      matches.push(
        ...(await ctx.db
          .query("profiles")
          .withIndex("by_discord_id", (q) => q.eq("discordId", classified.discordId!))
          .take(2)),
      );
    }
    if (classified.discordUsername) {
      matches.push(
        ...(await ctx.db
          .query("profiles")
          .withIndex("by_discord_username", (q) =>
            q.eq("discordUsername", classified.discordUsername!),
          )
          .take(2)),
      );
    }
    const targetIds = uniqueProfileIds(matches);
    if (targetIds.length > 1) return { status: "ambiguous" as const };
    const target = matches.find((profile) => profile?.userId === targetIds[0]);
    if (!target) {
      // Nobody with that identifier has published a profile here yet. The request WAITS instead of
      // failing: requiring the other person to open NetsuRush before they can be added is
      // backwards, since the invitation is usually what makes them open it. `upsertProfile` binds
      // this row the moment they sign in.
      return await requestPending(ctx, user._id, identifier.trim(), classified);
    }
    if (target.userId === user._id) return { status: "self" as const };

    const already = await ctx.db
      .query("friends")
      .withIndex("by_pair", (q) =>
        q.eq("userId", user._id).eq("friendId", target.userId),
      )
      .unique();
    if (already) return { status: "already" as const };

    const mirrored = await ctx.db
      .query("friendRequests")
      .withIndex("by_pair", (q) =>
        q.eq("fromUserId", target.userId).eq("toUserId", user._id),
      )
      .unique();
    if (mirrored) {
      await link(ctx, user._id, target.userId);
      await ctx.db.delete(mirrored._id);
      return { status: "linked" as const };
    }

    const pending = await ctx.db
      .query("friendRequests")
      .withIndex("by_pair", (q) =>
        q.eq("fromUserId", user._id).eq("toUserId", target.userId),
      )
      .unique();
    if (pending) return { status: "pending" as const };

    const outgoing = await ctx.db
      .query("friendRequests")
      .withIndex("by_from", (q) => q.eq("fromUserId", user._id))
      .take(MAX_PENDING_REQUESTS);
    const incoming = await ctx.db
      .query("friendRequests")
      .withIndex("by_to", (q) => q.eq("toUserId", target.userId))
      .take(MAX_PENDING_REQUESTS);
    if (
      outgoing.length >= MAX_PENDING_REQUESTS ||
      incoming.length >= MAX_PENDING_REQUESTS
    ) {
      throw new Error("friend request limit reached");
    }

    await ctx.db.insert("friendRequests", {
      fromUserId: user._id,
      toUserId: target.userId,
      createdAt: Date.now(),
    });
    return { status: "sent" as const };
  },
});

export const respondRequest = mutation({
  args: { requestId: v.id("friendRequests"), accept: v.boolean() },
  handler: async (ctx, { requestId, accept }) => {
    const user = await requireUser(ctx);
    const request = await ctx.db.get(requestId);
    // Only the addressee decides. A sender cancelling their own request deletes it below.
    if (!request) return { status: "gone" as const };
    if (request.toUserId !== user._id && request.fromUserId !== user._id)
      throw new Error("not yours");
    if (accept && request.toUserId === user._id)
      await link(ctx, request.fromUserId, request.toUserId);
    await ctx.db.delete(requestId);
    return { status: accept ? ("linked" as const) : ("declined" as const) };
  },
});

export const removeFriend = mutation({
  args: { friendId: v.string() },
  handler: async (ctx, { friendId }) => {
    const user = await requireUser(ctx);
    if (!validText(friendId, 256)) throw new Error("invalid friend id");
    await unlink(ctx, user._id, friendId);
    await unlink(ctx, friendId, user._id);
    return { status: "removed" as const };
  },
});

// Two rows, one per direction: neither side has to read the other's index to list its own friends.
async function link(ctx: MutationCtx, a: string, b: string) {
  const since = Date.now();
  for (const userId of [a, b]) {
    const rows = await ctx.db
      .query("friends")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_FRIENDS);
    if (rows.length >= MAX_FRIENDS) throw new Error("friend limit reached");
  }
  for (const [userId, friendId] of [
    [a, b],
    [b, a],
  ]) {
    const existing = await ctx.db
      .query("friends")
      .withIndex("by_pair", (q) =>
        q.eq("userId", userId).eq("friendId", friendId),
      )
      .unique();
    if (!existing) await ctx.db.insert("friends", { userId, friendId, since });
  }
}

async function unlink(ctx: MutationCtx, userId: string, friendId: string) {
  const row = await ctx.db
    .query("friends")
    .withIndex("by_pair", (q) =>
      q.eq("userId", userId).eq("friendId", friendId),
    )
    .unique();
  if (row) await ctx.db.delete(row._id);
}
