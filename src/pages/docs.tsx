import { useState } from "react";
import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { Reveal } from "@/components/site/Reveal";
import { CopyButton } from "@/components/site/CopyButton";
import { ConnectTabs } from "@/components/site/ConnectTabs";
import { usePageTitle } from "@/lib/page-title";
import { cn } from "@/lib/utils";

interface Section {
  id: string;
  title: string;
  body: string[];
  code?: string;
  extra?: Array<[label: string, value: string]>;
  /** Renders the client tab strip instead of a code block. */
  render?: "connect";
}

const SECTIONS: Section[] = [
  {
    id: "connect",
    title: "Connect your AI assistant",
    body: [
      "Ship-It speaks the Model Context Protocol, so one server works with Claude, Codex, Cursor, VS Code, Windsurf and anything else that speaks MCP. Paste the snippet for your client, then ask your agent to log in: it calls the login tool, which opens a Ship-It page where you approve the connection.",
      "The OpenCode plugin is deprecated and no longer receives updates. It still works, and it is still the shortest way to connect OpenCode itself: npx opencode-shipit-runtime login. Everything new lands in the MCP server.",
    ],
    render: "connect",
  },
  {
    id: "mcp",
    title: "The MCP server",
    body: [
      "The server is one URL: /mcp. It speaks JSON-RPC 2.0, and every tool it exposes runs as you — the same credential, the same plan limits, the same quota as any other client. There is no privileged path for AI clients.",
      "The tools cover projects, builds, runtimes, usage and the documentation itself. The platform manual is also available as MCP resources, so a client can read the docs instead of guessing from tool names.",
    ],
    code: `POST ${typeof window === "undefined" ? "" : window.location.origin}/mcp`,
  },
  {
    id: "build",
    title: "How a build works",
    body: [
      "You never write a pipeline config. The agent decides the install and build commands, uploads your project, and submits the job.",
      "The workflow runs in GitHub Actions with a hard three-minute timeout. If it fails, the agent reads the logs, fixes the project and submits another build. Nothing is ever compiled on the runtime itself.",
    ],
  },
  {
    id: "run",
    title: "How a runtime works",
    body: [
      "A successful build is packaged with its language toolchain into a self-contained bundle, and the sandbox runs that bundle — node, python, go, C++, Rust, Java, Ruby and Elixir are all supported. The agent writes nothing; the server-agent executes.",
      "Sessions are capped by your plan and by whatever remains of your monthly allowance. When the lease expires the sandbox is destroyed along with its filesystem, so nothing outlives its session.",
    ],
  },
  {
    id: "quota",
    title: "Quotas and leases",
    body: [
      "Quota is enforced on the server, never in the client. The maximum session length is the smallest of your plan limit, the three-hour hard cap, and the time you have left this month.",
      "A user with thirty minutes remaining can start a thirty minute runtime. The server-agent enforces the lease independently, so a modified client cannot extend it.",
    ],
  },
  {
    id: "tools",
    title: "Tools the agent can use",
    body: [
      "Every tool is authorised against your plan on the server. The MCP server exposes these groups:",
    ],
  },
];

const MCP_TOOL_GROUPS = [
  { group: "auth", tools: ["login"] },
  { group: "projects", tools: ["list_projects", "upload_project"] },
  { group: "builds", tools: ["submit_build", "list_builds", "get_build", "get_build_logs"] },
  {
    group: "runtimes",
    tools: ["start_runtime", "list_runtimes", "get_runtime", "stop_runtime", "runtime_logs", "exec_in_runtime"],
  },
  { group: "account", tools: ["get_usage", "get_account"] },
  { group: "docs", tools: ["search_docs"] },
];

const PLUGIN_TOOL_GROUPS = [
  { group: "auth", tools: ["shipit_login"] },
  { group: "project", tools: ["project_upload"] },
  { group: "build.*", tools: ["build_submit", "build_status", "build_logs", "build_list"] },
  {
    group: "runtime.*",
    tools: [
      "runtime_start",
      "runtime_stop",
      "runtime_restart",
      "runtime_status",
      "runtime_list",
      "runtime_logs",
      "runtime_info",
      "runtime_health",
      "runtime_exec",
    ],
  },
  { group: "fs", tools: ["list", "read", "write", "delete", "move", "copy", "mkdir", "stat", "exists", "chmod", "symlink"] },
  { group: "network", tools: ["list", "expose", "close"] },
  { group: "usage.*", tools: ["usage_quota", "runtime_monitoring"] },
  { group: "artifact.*", tools: ["artifact_list", "artifact_verify"] },
];

export function DocsPage() {
  usePageTitle("Documentation");
  const [active, setActive] = useState(SECTIONS[0].id);

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100">
      <AuroraBackground />
      <SiteNav />

      <main className="px-6 pb-24 pt-36">
        <div className="mx-auto max-w-6xl">
          <h1
            className="stagger font-serif text-[clamp(2.5rem,6vw,4rem)] font-bold tracking-[-0.03em]"
            style={{ "--i": 0 } as React.CSSProperties}
          >
            <span className="text-gradient">Documentation</span>
          </h1>
          <p
            className="stagger mt-5 max-w-2xl text-lg text-zinc-400"
            style={{ "--i": 1 } as React.CSSProperties}
          >
            How the platform fits together, and what the agent is allowed to do.
          </p>

          <div className="mt-14 grid gap-10 lg:grid-cols-[220px_1fr]">
            <nav className="lg:sticky lg:top-28 lg:self-start">
              <ul className="space-y-1">
                {SECTIONS.map((section) => (
                  <li key={section.id}>
                    <a
                      href={`#${section.id}`}
                      onClick={() => setActive(section.id)}
                      className={cn(
                        "block rounded-lg px-3 py-2 text-sm transition-colors duration-200",
                        active === section.id
                          ? "bg-white/[0.07] text-white"
                          : "text-zinc-500 hover:text-zinc-300"
                      )}
                    >
                      {section.title}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="space-y-16">
              {SECTIONS.map((section) => (
                <Reveal key={section.id}>
                  <section id={section.id} className="scroll-mt-28">
                    <h2 className="text-2xl font-semibold tracking-tight text-white">
                      {section.title}
                    </h2>
                    {section.body.map((paragraph, i) => (
                      <p
                        key={i}
                        className="mt-4 text-[15px] leading-relaxed text-zinc-400"
                      >
                        {paragraph}
                      </p>
                    ))}

                    {section.render === "connect" && (
                      <div className="mt-6">
                        <ConnectTabs />
                      </div>
                    )}

                    {section.code && (
                      <pre className="glass mt-6 overflow-x-auto rounded-2xl p-5 text-[13px] leading-relaxed">
                        <code className="text-zinc-300">{section.code}</code>
                      </pre>
                    )}

                    {section.extra && (
                      <div className="mt-4 space-y-2.5">
                        {section.extra.map(([label, value]) => (
                          <div key={label} className="glass flex items-center gap-3 rounded-xl px-4 py-3">
                            <span className="font-mono text-[11px] uppercase tracking-widest text-violet-300/80">
                              {label}
                            </span>
                            <code className="flex-1 truncate font-mono text-xs text-zinc-300">
                              {value}
                            </code>
                            <CopyButton text={value} />
                          </div>
                        ))}
                      </div>
                    )}

                    {section.id === "tools" && (
                      <div className="mt-6 space-y-8">
                        <div>
                          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
                            MCP server
                          </p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            {MCP_TOOL_GROUPS.map((group) => (
                              <div key={group.group} className="glass rounded-xl p-4">
                                <p className="font-mono text-xs text-violet-300/90">{group.group}</p>
                                <p className="mt-2 font-mono text-[12px] leading-relaxed text-zinc-500">
                                  {group.tools.join("  ")}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
                            OpenCode plugin (deprecated)
                          </p>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2">
                            {PLUGIN_TOOL_GROUPS.map((group) => (
                              <div key={group.group} className="glass rounded-xl p-4">
                                <p className="font-mono text-xs text-violet-300/90">{group.group}</p>
                                <p className="mt-2 font-mono text-[12px] leading-relaxed text-zinc-500">
                                  {group.tools.join("  ")}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </section>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
