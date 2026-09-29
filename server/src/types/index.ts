export interface User {
  id: string;
  email: string;
  created_at: string;
  plan_id: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  is_active: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface Plan {
  id: string;
  name: string;
  runtime_hours_per_month: number;
  max_runtime_hours: number;
  max_ram_mb: number;
  cpu: number;
  build_timeout_seconds: number;
  price_cents: number;
  whop_product_id: string | null;
}

export interface Subscription {
  id: string;
  user_id: string;
  plan_id: string;
  whop_subscription_id: string;
  status: "active" | "canceled" | "past_due" | "trialing";
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  repo_url: string;
  created_at: string;
}

export interface Build {
  id: string;
  user_id: string;
  project_id: string;
  status: "pending" | "running" | "success" | "failure" | "timeout";
  install_commands: string[];
  build_commands: string[];
  test_commands: string[];
  workflow_run_id: string | null;
  exit_code: number | null;
  started_at: string | null;
  completed_at: string | null;
  timeout_seconds: number;
  created_at: string;
}

export interface Artifact {
  id: string;
  build_id: string;
  name: string;
  sha256: string;
  size: number;
  url: string;
  created_at: string;
}

export interface Runtime {
  id: string;
  user_id: string;
  project_id: string;
  status: "starting" | "running" | "stopping" | "stopped" | "expired";
  agent_id: string | null;
  container_id: string | null;
  lease_expires_at: string;
  started_at: string | null;
  stopped_at: string | null;
  created_at: string;
}

export interface RuntimeUsage {
  id: string;
  user_id: string;
  runtime_id: string;
  period_start: string;
  period_end: string;
  used_seconds: number;
}

export interface UsageMonth {
  user_id: string;
  period_start: string;
  period_end: string;
  runtime_used_seconds: number;
  build_count: number;
}

export interface WebhookEvent {
  id: string;
  provider: "whop" | "github";
  event_type: string;
  payload: Record<string, unknown>;
  processed: boolean;
  idempotency_key: string;
  created_at: string;
}

export interface AuthenticatedRequest {
  userId: string;
  plan: Plan;
  apiKeyId: string;
}
