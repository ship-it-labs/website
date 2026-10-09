/**
 * Database error shapes, shared by every route and service. Postgres reports
 * a code (23505 for conflicts); the local SQLite stand-in reports no code at
 * all, just a message. Matching both keeps duplicate handling portable.
 * Previously copied into three files, which is how they drifted.
 */
export function isDuplicateKeyError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  const message = error.message ?? "";
  return /unique constraint failed/i.test(message) || /duplicate key value/i.test(message);
}
