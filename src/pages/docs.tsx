import { useState } from "react";
import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";
import { AuroraBackground } from "@/components/site/AuroraBackground";
import { Reveal } from "@/components/site/Reveal";
import { cn } from "@/lib/utils";

interface Section {
  id: string;
  title: string;
  body: string[];
  code?: string;
  extra?: Array<[label: string, value: string]>;
}

const SECTIONS: Section[] = [
  {
    id: "install",
    title: "Install the plugin",
    body: [
      "Install the published package and restart OpenCode. The plugin needs your account key, which you create in the dashboard under API keys.",
      "Write the key to ~/.config/opencode/shipit.key. The plugin checks SHIPIT_API_KEY first and falls back to that file, because launchers do not always forward custom environment variables to plugins. The key is only shown in full once, at creation, so copy it then.",
    ],
    code: `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-shipit-runtime"]
}`,
    extra: [
      ["npm", "npm install -g opencode-shipit-runtime"],
      ["key file", "echo \"ox_live_xxxxxxxx\" > ~/.config/opencode/shipit.key"],
    ],
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
      "A successful build starts in an ephemeral Docker container with the whole sandbox filesystem to itself. The agent writes the artifact, the server-agent runs it.",
      "Sessions are capped by your plan and by whatever remains of your monthly allowance. When the lease expires the container is destroyed along with its filesystem, so nothing outlives its session.",
    ],
  },
  {
    id: "quota",
    title: "Quotas and leases",
    body: [
      "Quota is enforced on the server, never in the plugin. The maximum session length is the smallest of your plan limit, the three-hour hard cap, and the time you have left this month.",
      "A user with thirty minutes remaining can start a thirty minute runtime. The server-agent enforces the lease independently, so a modified plugin cannot extend it.",
    ],
  },
  {
    id: "tools",
    title: "Tools the agent can use",
    body: [
      "Every tool is authorised against your plan on the server. Groups are build.*, runtime.*, fs.*, network.*, artifact.* and usage.*.",
    ],
  },
];

const TOOL_GROUPS = [
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
                            <button
                              type="button"
                              onClick={() => navigator.clipboard?.writeText(value)}
                              className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 transition-colors hover:border-white/25 hover:text-white"
                            >
                              Copy
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {section.id === "tools" && (
                      <div className="mt-6 grid gap-3 sm:grid-cols-2">
                        {TOOL_GROUPS.map((group) => (
                          <div key={group.group} className="glass rounded-xl p-4">
                            <p className="font-mono text-xs text-violet-300/90">
                              {group.group}
                            </p>
                            <p className="mt-2 font-mono text-[12px] leading-relaxed text-zinc-500">
                              {group.tools.join("  ")}
                            </p>
                          </div>
                        ))}
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
