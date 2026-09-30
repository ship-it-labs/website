import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SqliteClient } from "./sqlite/client.js";
import { logger } from "../utils/logger.js";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Development runs entirely on node:sqlite and the local filesystem, so the
 * platform boots with no external services. Production uses Supabase, which
 * owns auth, row level security and object storage.
 */
export type Database = SupabaseClient | SqliteClient;
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (isProduction && (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when NODE_ENV=production."
  );
}

export const usingSqlite = !isProduction;

export const supabase: Database = isProduction
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : new SqliteClient({
      file: process.env.SQLITE_PATH || "./.data/shipit.db",
      storageRoot: process.env.LOCAL_STORAGE_ROOT || "./.data/storage",
      publicBaseUrl:
        process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`,
    });

if (usingSqlite) {
  logger.info(
    { file: process.env.SQLITE_PATH || "./.data/shipit.db" },
    "Using local node:sqlite database (development)"
  );
}
