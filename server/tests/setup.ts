import { beforeEach } from "vitest";

// Services read configuration at import time, so the test environment needs
// placeholder values to load them at all. None of these reach a real service.
beforeEach(() => {
  process.env.SUPABASE_URL ||= "https://placeholder.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "placeholder-service-role-key";
});
