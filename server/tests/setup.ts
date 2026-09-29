import { beforeEach, vi } from "vitest";

// Services resolve their configuration at import time, so the test environment
// needs placeholder credentials to load them at all. None of these reach a real
// service: the tests either exercise pure functions or fail before any request.
beforeEach(() => {
  process.env.SUPABASE_URL ||= "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "placeholder-service-role-key";
});

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({ single: async () => ({ data: null, error: null }), eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      insert: async () => ({ data: null, error: null }),
      upsert: async () => ({ data: null, error: null }),
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  },
}));
