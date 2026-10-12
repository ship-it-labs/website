#!/usr/bin/env node
/**
 * One command that runs every quality gate the repo has — ESLint, both
 * TypeScript projects, and the test suite — and, when something fails, asks
 * Pollinations to summarise *what* broke in plain language.
 *
 * Why a summariser and not just the raw logs: a red CI run dumps hundreds of
 * lines, and the actionable line is usually one `error` among them. The model
 * is handed only the failing command output (never a passing run) and returns a
 * terse triage: verdict, per-error files, likely cause, smallest fix.
 *
 * The gate itself is deterministic: it never lets the model decide pass/fail.
 * Exit code is the commands' exit code, full stop. If Pollinations is
 * unreachable or the key is missing, the failures still print and the run still
 * fails — the summary is a convenience, never a dependency.
 *
 * Usage:
 *   node scripts/verify.mjs              # all gates + AI summary on failure
 *   node scripts/verify.mjs --no-ai      # skip the summary (offline/CI)
 *   node scripts/verify.mjs --only=tests # run a subset (comma-separated ids)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SERVER = path.join(ROOT, "server");

// ---------------------------------------------------------------------------
// .env loading. The API key lives in an untracked .env, not in the repo, and
// this script is run directly (not through npm), so it reads the same files the
// app does and never overrides a value already exported into the shell.
// ---------------------------------------------------------------------------
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env"));
loadEnvFile(path.join(SERVER, ".env"));

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const noAi = argv.includes("--no-ai") || process.env.VERIFY_NO_AI === "1";
const onlyArg = argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim())) : null;

// ---------------------------------------------------------------------------
// Steps. `shell:true` with node_modules/.bin on PATH is the one approach that
// behaves identically on Windows (.cmd shims) and POSIX.
// ---------------------------------------------------------------------------
const binDirs = [path.join(ROOT, "node_modules", ".bin"), path.join(SERVER, "node_modules", ".bin")];
const env = {
  ...process.env,
  PATH: [...binDirs, process.env.PATH ?? ""].join(path.delimiter),
  // Force colour off: the summariser prompt and captured logs are cleaner, and
  // the gate never depends on a TTY.
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};

const STEPS = [
  { id: "lint", label: "ESLint", cmd: "eslint src/ server/src/ scripts/", cwd: ROOT },
  { id: "types:web", label: "TypeScript (web)", cmd: "tsc --noEmit", cwd: ROOT },
  {
    id: "types:server",
    label: "TypeScript (server)",
    cmd: "tsc --noEmit -p server/tsconfig.json",
    cwd: ROOT,
  },
  { id: "tests", label: "Vitest", cmd: "vitest run", cwd: SERVER },
];

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function runStep(step) {
  const started = Date.now();
  const result = spawnSync(step.cmd, {
    cwd: step.cwd,
    shell: true,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ...step,
    ok: result.status === 0,
    status: result.status ?? 1,
    ms: Date.now() - started,
    output,
  };
}

function truncate(text, max) {
  if (text.length <= max) return text;
  // Keep both ends: the first errors and the final summary line usually matter
  // most, and the model does better with the tail than with a middle cut.
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.3));
  return `${head}\n…\n[${text.length - max} chars elided]\n…\n${tail}`;
}

// ---------------------------------------------------------------------------
// Pollinations triage. OpenAI-compatible chat completions on gen.pollinations.ai.
// Primary model is the requested qwen3.7-flash; if the account can't afford it
// (a 200 with a "not enough credits" body) the next model in the chain is used,
// so the summary still lands on a key with only Quest pollen.
// ---------------------------------------------------------------------------
const BASE_URL = process.env.POLLINATIONS_BASE_URL ?? "https://gen.pollinations.ai";
const PRIMARY_MODEL = process.env.POLLINATIONS_MODEL ?? "qwen/qwen3.7-flash";
const FALLBACK_MODELS = (process.env.POLLINATIONS_FALLBACK_MODELS ?? "openai/gpt-5.4-nano,openai/gpt-oss-20b")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SYSTEM_PROMPT =
  "You are a CI triage assistant for the Ship-It monorepo (a React/Vite frontend in src/ " +
  "and a Fastify/TypeScript control plane in server/src, tested with Vitest). You are given " +
  "the raw output of checks that FAILED. Reply in this exact shape, nothing else:\n" +
  "VERDICT: one sentence.\n" +
  "ERRORS:\n- file:line — the error (one bullet per distinct error, dedupe repeats)\n" +
  "CAUSE: the single most likely root cause.\n" +
  "FIX: the smallest change that resolves it.\n" +
  "Be terse and concrete. Never invent file paths or lines that are not in the output.";

function looksLikeInsufficientCredit(text) {
  return /enough credits|paid pollen|top ?up|insufficient/i.test(text);
}

async function callPollinations(model, apiKey, messages, maxTokens) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const choice = json.choices?.[0]?.message?.content ?? "";
  const usage = json.usage?.total_tokens ?? 0;
  // A credit-starved response is still HTTP 200, with zero tokens used and a
  // canned "top up" message — detect it so we fall through to the next model.
  if (!choice || (usage === 0 && looksLikeInsufficientCredit(choice))) {
    throw new Error(`model ${model} unavailable: ${choice.slice(0, 120) || "empty"}`);
  }
  return { text: choice.trim(), model, usage };
}

async function summarizeFailure(failed) {
  const apiKey = process.env.POLLINATIONS_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: "POLLINATIONS_API_KEY is not set — skipping AI summary." };
  }

  const sections = failed
    .map((s) => `### ${s.label} — ${s.cmd}\n${truncate(s.output || "(no output)", 6000)}`)
    .join("\n\n");
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${failed.length} check(s) failed.\n\n${sections}`,
    },
  ];

  const models = [PRIMARY_MODEL, ...FALLBACK_MODELS];
  const errors = [];
  for (const model of models) {
    try {
      return { ok: true, ...(await callPollinations(model, apiKey, messages, 700)) };
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
    }
  }
  return { ok: false, reason: `No model responded.\n  ${errors.join("\n  ")}` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const steps = only ? STEPS.filter((s) => only.has(s.id)) : STEPS;
  if (steps.length === 0) {
    console.error(`No steps matched --only=${onlyArg ?? ""}. Valid ids: ${STEPS.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }

  console.log(`${C.bold}${C.cyan}Ship-It verify${C.reset} ${C.dim}(${steps.map((s) => s.label).join(" → ")})${C.reset}\n`);

  const results = [];
  for (const step of steps) {
    process.stdout.write(`${C.dim}▶ ${step.label}…${C.reset}`);
    const result = runStep(step);
    results.push(result);
    const tag = result.ok ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
    process.stdout.write(`\r${result.ok ? C.green + "✔" : C.red + "✖"}${C.reset} ${step.label} ${tag} ${C.dim}(${result.ms}ms)${C.reset}\n`);
    if (!result.ok && result.output) {
      // Full failing output, indented, so the terminal keeps the raw truth even
      // when the AI summary below is unavailable.
      console.log(
        result.output
          .split(/\r?\n/)
          .map((l) => `    ${l}`)
          .join("\n")
      );
      console.log("");
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length === 0) {
    console.log(`${C.green}${C.bold}All checks passed.${C.reset} ${C.dim}(${results.length} gates, ${results.reduce((a, r) => a + r.ms, 0)}ms)${C.reset}`);
    process.exit(0);
  }

  console.log(`${C.red}${C.bold}${failed.length} of ${results.length} checks failed.${C.reset}`);

  if (noAi) {
    console.log(`${C.dim}--no-ai set: skipping the Pollinations summary.${C.reset}`);
  } else {
    console.log(`\n${C.bold}${C.cyan}AI triage${C.reset} ${C.dim}(pollinations.ai)${C.reset}`);
    const summary = await summarizeFailure(failed);
    if (summary.ok) {
      console.log(`${C.dim}model: ${summary.model}${C.reset}`);
      console.log(`\n${summary.text}`);
    } else {
      console.log(`${C.yellow}Summary unavailable.${C.reset} ${summary.reason}`);
    }
  }

  // The gate's verdict is the commands', not the model's.
  process.exit(1);
}

main().catch((err) => {
  console.error(`${C.red}verify crashed:${C.reset}`, err);
  process.exit(2);
});
