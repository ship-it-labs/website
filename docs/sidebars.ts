import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * The manual's shape: start with what the platform is, connect a client, then
 * the parts you touch daily, then the reference.
 */
const sidebars: SidebarsConfig = {
  docsSidebar: [
    "intro",
    {
      type: "category",
      label: "Connect",
      collapsed: false,
      items: ["connect", "mcp", "opencode"],
    },
    {
      type: "category",
      label: "Using the platform",
      collapsed: false,
      items: ["projects", "builds", "runtimes", "quotas"],
    },
    {
      type: "category",
      label: "Reference",
      collapsed: false,
      items: ["api", "troubleshooting"],
    },
  ],
};

export default sidebars;
