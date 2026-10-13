import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * The Pollinations wrapper carries three behaviours worth locking down: it must
 * walk the model chain past a model that answers 200 with a billing notice, it
 * must mark the cache boundary only for providers that understand it, and it
 * must fail with a *typed* error that carries whether credit was the cause.
 */

function resetEnv(env: Record<string, string>): void {
  for (const key of [
    "POLLINATIONS_API_KEY",
    "POLLINATIONS_MODEL",
    "POLLINATIONS_FALLBACK_MODELS",
    "POLLINATIONS_BASE_URL",
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
}

async function load(env: Record<string, string>) {
  vi.resetModules();
  resetEnv(env);
  return import("../src/services/pollinations.js");
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("pollinations configuration", () => {
  it("is disabled without a key", async () => {
    const mod = await load({ POLLINATIONS_API_KEY: "" });
    expect(mod.agentEnabled()).toBe(false);
    await expect(
      mod.chatCompletion([{ role: "user", content: "hi" }])
    ).rejects.toBeInstanceOf(mod.AgentUnavailableError);
  });

  it("orders the primary first and drops duplicates", async () => {
    const mod = await load({
      POLLINATIONS_API_KEY: "k",
      POLLINATIONS_MODEL: "a/one",
      POLLINATIONS_FALLBACK_MODELS: "b/two, a/one ,",
    });
    expect(mod.agentModels()).toEqual(["a/one", "b/two"]);
  });
});

describe("pollinations fallback", () => {
  it("skips a model that answers with a low-balance notice", async () => {
    const mod = await load({
      POLLINATIONS_API_KEY: "k",
      POLLINATIONS_MODEL: "low/model",
      POLLINATIONS_FALLBACK_MODELS: "high/model",
    });

    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(String(init.body)) as { model: string };
      if (model === "low/model") {
        return json({
          choices: [
            { message: { content: "This model doesn't have enough credits. It needs paid Pollen." } },
          ],
          usage: { total_tokens: 0 },
        });
      }
      return json({
        choices: [{ message: { content: "Hello from the fallback" } }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 3,
          total_tokens: 8,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const reply = await mod.chatCompletion([{ role: "user", content: "hi" }]);
    expect(reply.text).toBe("Hello from the fallback");
    expect(reply.model).toBe("high/model");
    expect(reply.usage.cachedTokens).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a typed low-balance error when every model is out of credit", async () => {
    const mod = await load({
      POLLINATIONS_API_KEY: "k",
      POLLINATIONS_MODEL: "a/x",
      POLLINATIONS_FALLBACK_MODELS: "b/y",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          choices: [{ message: { content: "This model doesn't have enough credits." } }],
          usage: { total_tokens: 0 },
        })
      )
    );

    let caught: unknown;
    try {
      await mod.chatCompletion([{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(mod.AgentUnavailableError);
    expect((caught as InstanceType<typeof mod.AgentUnavailableError>).lowBalance).toBe(true);
  });

  it("parses tool calls from a response", async () => {
    const mod = await load({ POLLINATIONS_API_KEY: "k", POLLINATIONS_MODEL: "a/one" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "t1", type: "function", function: { name: "list_builds", arguments: "{}" } },
                ],
              },
            },
          ],
          usage: { total_tokens: 4 },
        })
      )
    );

    const reply = await mod.chatCompletion([{ role: "user", content: "my builds?" }], {
      tools: [
        {
          type: "function",
          function: { name: "list_builds", description: "builds", parameters: { type: "object" } },
        },
      ],
    });
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]?.function.name).toBe("list_builds");
  });
});

describe("pollinations prompt cache markers", () => {
  it("marks the static prefix for a cache-capable model", async () => {
    const mod = await load({ POLLINATIONS_API_KEY: "k", POLLINATIONS_MODEL: "google/gemini-2.5-flash" });
    const capture = vi.fn(async () =>
      json({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } })
    );
    vi.stubGlobal("fetch", capture);

    await mod.chatCompletion([
      { role: "system", cachePrefix: "STATIC", content: "DYN" },
      { role: "user", content: "hi" },
    ]);

    const body = bodyOf(capture.mock.calls[0] as unknown[]);
    const messages = body.messages as Array<{ content: unknown }>;
    expect(Array.isArray(messages[0]?.content)).toBe(true);
    expect((messages[0]?.content as unknown[])[0]).toMatchObject({
      type: "text",
      text: "STATIC",
      cache_control: { type: "ephemeral" },
    });
  });

  it("concatenates the prefix as plain text for other models", async () => {
    const mod = await load({ POLLINATIONS_API_KEY: "k", POLLINATIONS_MODEL: "openai/gpt-oss-20b" });
    const capture = vi.fn(async () =>
      json({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } })
    );
    vi.stubGlobal("fetch", capture);

    await mod.chatCompletion([
      { role: "system", cachePrefix: "STATIC", content: "DYN" },
      { role: "user", content: "hi" },
    ]);

    const body = bodyOf(capture.mock.calls[0] as unknown[]);
    const messages = body.messages as Array<{ content: unknown }>;
    expect(messages[0]?.content).toBe("STATIC\n\nDYN");
  });
});
