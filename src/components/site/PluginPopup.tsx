import { Link } from "react-router-dom";
import { Modal } from "@/components/site/Modal";
import { CopyButton } from "@/components/site/CopyButton";

const INSTALL_COMMAND = "npm install -g opencode-shipit-runtime";

/**
 * First-signup connect walkthrough. Shown once on the welcome dashboard until
 * dismissed: without the plugin the account can do nothing, and new users
 * otherwise land on an empty dashboard with no idea what connects to what.
 */
export function PluginPopup({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Connect OpenCode to Ship-It"
      description="Three steps, then your agent can build and run here."
      onClose={onClose}
    >
      <ol className="space-y-5 text-sm text-zinc-300">
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-medium text-white">
            1
          </span>
          <div className="min-w-0">
            <p className="font-medium text-white">Install the plugin</p>
            <p className="mt-1 text-zinc-400">
              Run this where you run OpenCode:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg border border-white/10 bg-zinc-950/60 px-3 py-2 font-mono text-xs text-violet-100">
                {INSTALL_COMMAND}
              </code>
              <CopyButton text={INSTALL_COMMAND} label="Copy" />
            </div>
          </div>
        </li>
        <li className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-medium text-white">
            2
          </span>
          <div>
            <p className="font-medium text-white">Add your API key</p>
            <p className="mt-1 text-zinc-400">
              Create one under{" "}
              <Link to="/dashboard/keys" className="text-white underline underline-offset-2">
                API keys
              </Link>
              , then expose it as <code className="font-mono text-xs text-zinc-200">SHIPIT_API_KEY</code> or
              write it to <code className="font-mono text-xs text-zinc-200">~/.config/opencode/shipit.key</code>.
              The key is shown once, at creation.
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
              Restart so it picks up the plugin, then ask it to build
              something. Full walkthrough in the{" "}
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
