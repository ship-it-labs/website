import { Link } from "react-router-dom";

export function SiteFooter() {
  return (
    <footer className="relative border-t border-white/[0.07] px-6 py-14">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-[15px] font-semibold text-white">Ship-It</p>
            <p className="mt-2 max-w-xs text-sm leading-relaxed text-zinc-500">
              Build and run anything. The AI handles the pipeline, you keep the
              quota.
            </p>
          </div>

          <FooterColumn
            title="Product"
            links={[
              { label: "Pricing", to: "/pricing" },
              { label: "Docs", to: "/docs" },
              { label: "Dashboard", to: "/dashboard" },
            ]}
          />
          <FooterColumn
            title="Resources"
            links={[
              { label: "Documentation", to: "/docs" },
              { label: "FAQ", to: "/faq" },
              { label: "Changelog", to: "/changelog" },
              { label: "Status", to: "/status" },
              { label: "Terms of Service", to: "/terms" },
              { label: "Privacy Policy", to: "/privacy" },
              { label: "Sign in", to: "/login" },
            ]}
          />
          <FooterColumn
            title="Account"
            links={[
              { label: "Create account", to: "/signup" },
              { label: "API keys", to: "/dashboard/keys" },
              { label: "Billing", to: "/dashboard/billing" },
              { label: "Contact support", to: "/contact" },
            ]}
          />
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-white/[0.07] pt-6 text-xs text-zinc-600 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Ship-It Labs. All rights reserved.</p>
          <p>Built for developers who ship.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: Array<{ label: string; to: string }>;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.14em] text-zinc-500">
        {title}
      </p>
      <ul className="mt-4 space-y-2.5">
        {links.map((link) => (
          <li key={link.to}>
            <Link
              to={link.to}
              className="text-sm text-zinc-400 transition-colors duration-200 hover:text-white"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
