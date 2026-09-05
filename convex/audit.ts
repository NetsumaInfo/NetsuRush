// Sparse, bounded security history for destructive collaboration decisions.
//
// These rows deliberately contain only account/device ids and compact action metadata. Project
// names and board content remain encrypted/local. Recording happens only for rare administrative
// mutations, so this does not turn ordinary editing into Convex write traffic.

import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const MAX_AUDIT_EVENTS_PER_PROJECT = 200;

export async function recordProjectAudit(
  ctx: MutationCtx,
  event: {
    projectId: Id<"projects">;
    actorUserId: string;
    kind: string;
    target?: string;
    detail?: string;
  },
): Promise<void> {
  if (
    !event.kind ||
    event.kind.length > 64 ||
    event.actorUserId.length > 256 ||
    (event.target?.length ?? 0) > 256 ||
    (event.detail?.length ?? 0) > 256
  ) {
    throw new Error("invalid audit event");
  }
  await ctx.db.insert("projectAuditEvents", {
    ...event,
    createdAt: Date.now(),
  });
  const rows = await ctx.db
    .query("projectAuditEvents")
    .withIndex("by_project_created", (q) => q.eq("projectId", event.projectId))
    .order("desc")
    .take(MAX_AUDIT_EVENTS_PER_PROJECT + 1);
  for (const row of rows.slice(MAX_AUDIT_EVENTS_PER_PROJECT)) {
    await ctx.db.delete(row._id);
  }
}
