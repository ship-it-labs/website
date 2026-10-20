import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes as prismThemes } from "prism-react-renderer";

/**
 * The Ship-It manual.
 *
 * It is built into the site's own `dist` folder so one process serves both
 * the app and the documentation, and `baseUrl` puts it under /docs.
 */
const SITE = "https://ship-it-fri1.onrender.com";

const config: Config = {
  title: "Ship-It",
  tagline: "Build and run anything, from your AI assistant",
  url: "https://ship-it-fri1.onrender.com",
  baseUrl: "/docs/",
  trailingSlash: true,
  // A broken link is a mistake worth seeing in the build output, not a reason
  // to fail a deploy over a typo in a cross-reference.
  onBrokenLinks: "warn",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },
  presets: [
    [
      "classic",
      {
        docs: {
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    colorMode: {
      defaultMode: "dark",
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "Ship-It",
      items: [
        { type: "docSidebar", sidebarId: "docsSidebar", position: "left", label: "Manual" },
        { href: `${SITE}/`, label: "Dashboard", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Platform",
          items: [
            { label: "Dashboard", href: `${SITE}/` },
            { label: "Pricing", href: `${SITE}/pricing` },
            { label: "Status", href: `${SITE}/status` },
          ],
        },
        {
          title: "Connect",
          items: [
            { label: "Your AI assistant", to: "/docs/connect" },
            { label: "MCP server", to: "/docs/mcp" },
            { label: "OpenCode (deprecated)", to: "/docs/opencode" },
          ],
        },
      ],
      copyright: "Ship-It — build and run anything.",
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
