/**
 * Project languages. The runtime sandbox executes a self-contained bundle, and
 * the bundle is built per language in GitHub Actions — so the platform must
 * know which toolchain built each project. The AI declares it at upload; when
 * the declaration is missing or contradicts the archive contents, detection
 * wins and says why.
 */

export const LANGUAGES = [
  "node",
  "python",
  "go",
  "cpp",
  "c",
  "rust",
  "java",
  "ruby",
  "elixir",
] as const;

export type Language = (typeof LANGUAGES)[number];

/** The historical assumption, kept when nothing says otherwise. */
export const DEFAULT_LANGUAGE: Language = "node";

export function isLanguage(value: unknown): value is Language {
  return (
    typeof value === "string" &&
    (LANGUAGES as readonly string[]).includes(value)
  );
}

interface Signal {
  language: Language;
  /** Higher wins when several languages match the same archive. */
  weight: number;
  files: string[];
  extensions: string[];
}

/**
 * Ordered by specificity, not by weight: manifest files beat extensions, and
 * among manifests the one that names an exact toolchain wins. Weights only
 * break ties between manifests (go.mod outranks a stray package.json in a
 * docs folder, etc). Filenames are lowercase: basename() lowercases before
 * matching, so "Cargo.toml" here would never hit.
 */
const SIGNALS: Signal[] = [
  { language: "go", weight: 100, files: ["go.mod"], extensions: [] },
  { language: "rust", weight: 100, files: ["cargo.toml"], extensions: [] },
  { language: "elixir", weight: 100, files: ["mix.exs"], extensions: [] },
  { language: "java", weight: 100, files: ["pom.xml", "build.gradle", "build.gradle.kts"], extensions: [] },
  { language: "node", weight: 90, files: ["package.json"], extensions: [] },
  { language: "python", weight: 90, files: ["pyproject.toml", "requirements.txt", "setup.py", "pipfile"], extensions: [] },
  { language: "cpp", weight: 80, files: ["cmakelists.txt", "makefile", "meson.build"], extensions: [] },
  { language: "ruby", weight: 90, files: ["gemfile"], extensions: [] },
  { language: "cpp", weight: 40, files: [], extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh"] },
  { language: "c", weight: 40, files: [], extensions: [".c", ".h"] },
  { language: "java", weight: 40, files: [], extensions: [".java"] },
  { language: "go", weight: 40, files: [], extensions: [".go"] },
  { language: "rust", weight: 40, files: [], extensions: [".rs"] },
  { language: "python", weight: 40, files: [], extensions: [".py"] },
  { language: "ruby", weight: 40, files: [], extensions: [".rb"] },
  { language: "elixir", weight: 40, files: [], extensions: [".ex", ".exs"] },
  { language: "node", weight: 30, files: [], extensions: [".js", ".ts", ".mjs", ".cjs"] },
];

function basename(path: string): string {
  const normalized = path.split("\\").join("/").toLowerCase();
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function extension(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/**
 * Best-guess language from archive file paths (relative, posix-style, as the
 * upload manifest stores them). Null when nothing matches. Manifest files
 * outrank bare extensions, and among equals the first signal in SIGNALS order
 * wins so the result is deterministic.
 */
export function detectLanguage(files: string[]): Language | null {
  let best: { language: Language; weight: number; order: number } | null = null;

  for (const file of files) {
    const base = basename(file);
    const ext = extension(file);
    for (let i = 0; i < SIGNALS.length; i++) {
      const signal = SIGNALS[i];
      const hit =
        signal.files.includes(base) || (ext !== "" && signal.extensions.includes(ext));
      if (!hit) continue;
      if (
        !best ||
        signal.weight > best.weight ||
        (signal.weight === best.weight && i < best.order)
      ) {
        best = { language: signal.language, weight: signal.weight, order: i };
      }
    }
  }

  return best?.language ?? null;
}

export type LanguageSource = "declared" | "detected" | "default";

export interface ResolvedLanguage {
  language: Language;
  source: LanguageSource;
  /** Set when detection overrode the declaration, so the caller can say why. */
  note: string | null;
}

/**
 * Reconciles the AI's declaration with what the archive contains. An absent
 * or unknown declaration defers to detection, then to the node default; a
 * present declaration that contradicts a detected manifest loses to detection,
 * because the files are what actually get built.
 */
export function resolveLanguage(
  declared: unknown,
  files: string[]
): ResolvedLanguage {
  const detected = detectLanguage(files);

  if (!isLanguage(declared)) {
    if (detected) {
      return { language: detected, source: "detected", note: null };
    }
    return { language: DEFAULT_LANGUAGE, source: "default", note: null };
  }

  if (detected && detected !== declared) {
    return {
      language: detected,
      source: "detected",
      note: `Declared ${declared} but the archive looks like ${detected}; using ${detected}.`,
    };
  }

  return { language: declared, source: "declared", note: null };
}
