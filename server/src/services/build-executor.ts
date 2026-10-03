import { publicBaseUrl } from "../config/urls.js";
import { supabase } from "../db/index.js";

/**
 * Decides where a build runs.
 *
 * GitHub Actions needs two things a local deployment does not have: a token, and
 * a control plane the hosted runner can reach. When the public address is
 * loopback the runner cannot download the project at all, and the build dies at
 * "Download uploaded project" with a connection error that looks nothing like a
 * network problem. So a loopback deployment builds in the platform's own
 * runtime, which is also faster because nothing leaves the machine.
 */
export type BuildExecutor = "github" | "runtime";

export function resolveBuildExecutor(): BuildExecutor {
  const configured = (process.env.BUILD_EXECUTOR ?? "auto").trim().toLowerCase();
  if (configured === "github") return "github";
  if (configured === "runtime") return "runtime";

  const token = (process.env.GITHUB_TOKEN ?? "").trim();
  if (!token) return "runtime";

  return isReachableFromTheInternet(publicBaseUrl()) ? "github" : "runtime";
}

/**
 * The admin panel's override for the executor. An explicit BUILD_EXECUTOR env
 * var always wins — an operator who sets one has a reason — and the database
 * setting decides only when the env is "auto" or unset. Falls back to the
 * plain resolution when the settings table does not exist yet, so a database
 * created before the admin panel cannot break builds.
 */
export async function resolveBuildExecutorWithSettings(): Promise<BuildExecutor> {
  const configured = (process.env.BUILD_EXECUTOR ?? "auto").trim().toLowerCase();
  if (configured === "github") return "github";
  if (configured === "runtime") return "runtime";

  try {
    const { data } = await supabase
      .from("platform_settings")
      .select("value")
      .eq("key", "build_executor")
      .single();

    const raw = (data as { value: unknown } | null)?.value;
    const setting = typeof raw === "string" ? tryParseJson(raw) : raw;
    if (setting === "github") return "github";
    if (setting === "runtime") return "runtime";
  } catch {
    // A missing table or driver is not a build failure.
  }

  return resolveBuildExecutor();
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * A public address that a hosted runner can resolve is the test.
 *
 * Hostnames and IP literals are judged differently: `127.example.com` is an
 * ordinary public domain that merely starts with the same digits as a loopback
 * address, while a bare `website` is a container name that resolves nowhere
 * outside the deployment.
 */
export function isReachableFromTheInternet(url: string): boolean {
  let hostname: string;
  try {
    // IPv6 literals come back wrapped in brackets, which are not part of the host.
    hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }

  if (!hostname) return false;
  if (isPrivateIp(hostname)) return false;

  // A single label is a container or machine name, not a public domain.
  if (!hostname.includes(".")) return false;

  if (hostname === "localhost" || hostname.endsWith(".localhost")) return false;
  if (hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;

  return true;
}

/** True when the host is an IP literal that a public runner cannot reach. */
function isPrivateIp(hostname: string): boolean {
  if (hostname === "::1" || hostname === "0.0.0.0") return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!ipv4) return false;

  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return false;

  const [a, b] = octets;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;

  return false;
}
