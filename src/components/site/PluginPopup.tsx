import { Link } from "react-router-dom";
import { Modal } from "@/components/site/Modal";
import { CopyButton } from "@/components/site/CopyButton";

const LOGIN_COMMAND = "npx opencode-shipit-runtime login";

/**
 * First-signup connect walkthrough. Shown once on the welcome dashboard until
 * dismissed: without the plugin the account can do nothing, and new users
 * otherwise land on an empty dashboard with no idea what connects to what.
 * Login is OAuth — no keys to copy. The token lands in the key file on its
 * own; SHIPIT_API_KEY in the environment is the headless fallback.
 */
export function PluginPopup({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Connect OpenCode to Ship-It"
      description="One command, one approval, then your agent can build and run here."
      onClose={onClose}
    >
      <ol className="space-y-5 text-sm text-zinc-300">
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-medium text-white">
            1
          </span>
          <div className="min-w-0">
            <p className="font-medium text-white">Run the login</p>
            <p className="mt-1 text-zinc-400">
              Run this where you run OpenCode:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg border border-white/10 bg-zinc-950/60 px-3 py-2 font-mono text-xs text-violet-100">
                {LOGIN_COMMAND}
              </code>
              <CopyButton text={LOGIN_COMMAND} label="Copy" />
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-medium text-white">
            2
          </span>
          <div>
            <p className="font-medium text-white">Approve in the browser</p>
            <p className="mt-1 text-zinc-400">
              Your browser opens with this exact page. Sign in if needed, hit{" "}
              <span className="text-zinc-200">Authorize</span>, and everything
              is set up for you — token stored, plugin added. Nothing to copy.
            </p>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-medium text-white">
            3
          </span>
          <div>
            <p className="font-medium text-white">Restart OpenCode</p>
            <p className="mt-1 text-zinc-400">
              Restart so every tool picks up the credentials, then ask it to
              build something. Full walkthrough in the{" "}
              <Link to="/docs" className="text-white underline underline-offset-2">
                docs
              </Link>
              .
            </p>
          </div>
        </li>
      </ol>
      <button
        type="button"
        onClick={onClose}
        className="mt-6 w-full rounded-xl bg-white px-5 py-2.5 text-sm font-medium text-zinc-950 transition-transform duration-200 hover:scale-[1.02]"
      >
        Got it
      </button>
    </Modal>
  );
}
