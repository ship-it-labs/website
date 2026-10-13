import crypto from "node:crypto";

/**
 * A project id is chosen by the caller — the plugin's `project_upload` tool or
 * the AI — so two accounts can independently pick the same slug such as
 * `mini-app`. The id is the primary key, so a blind upsert on a slug that
 * already belongs to another account would silently move that account's project
 * to the writer: a cross-account overwrite.
 *
 * The fix is a deterministic, account-scoped id for the collision case. Same
 * account and slug always resolve to the same row (so a re-upload updates in
 * place), and no two accounts can ever resolve to the same id. A globally
 * unclaimed slug is left untouched, so existing projects keep their ids.
 */
export function scopedProjectId(userId: string, projectId: string): string {
  const suffix = crypto.createHash("sha256").update(userId).digest("hex").slice(0, 8);
  return `${projectId}--${suffix}`;
}

/**
 * Resolves the id a write should target. `ownerId` is the user who currently
 * owns the requested id, or null when it is unclaimed. A foreign owner forces
 * the scoped id; otherwise the requested id stands.
 */
export function resolveProjectId(input: {
  requestedId: string;
  userId: string;
  ownerId: string | null | undefined;
}): string {
  if (input.ownerId && input.ownerId !== input.userId) {
    return scopedProjectId(input.userId, input.requestedId);
  }
  return input.requestedId;
}
