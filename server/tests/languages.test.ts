import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  resolveLanguage,
  isLanguage,
  DEFAULT_LANGUAGE,
} from "../src/services/languages.js";

describe("language detection", () => {
  it("detects each manifest", () => {
    expect(detectLanguage(["go.mod"])).toBe("go");
    expect(detectLanguage(["Cargo.toml"])).toBe("rust");
    expect(detectLanguage(["mix.exs"])).toBe("elixir");
    expect(detectLanguage(["pom.xml"])).toBe("java");
    expect(detectLanguage(["package.json"])).toBe("node");
    expect(detectLanguage(["requirements.txt"])).toBe("python");
    expect(detectLanguage(["Gemfile"])).toBe("ruby");
    expect(detectLanguage(["CMakeLists.txt"])).toBe("cpp");
  });

  it("detects bare source extensions", () => {
    expect(detectLanguage(["src/main.cpp"])).toBe("cpp");
    expect(detectLanguage(["main.c"])).toBe("c");
    expect(detectLanguage(["Main.java"])).toBe("java");
    expect(detectLanguage(["app.py"])).toBe("python");
    expect(detectLanguage(["app.rb"])).toBe("ruby");
  });

  it("prefers manifests over extensions", () => {
    expect(detectLanguage(["docs/notes.md", "package.json", "stray.py"])).toBe("node");
    expect(detectLanguage(["go.mod", "legacy.js"])).toBe("go");
  });

  it("prefers cpp over c when both extensions appear", () => {
    expect(detectLanguage(["a.c", "b.cpp"])).toBe("cpp");
  });

  it("returns null when nothing matches", () => {
    expect(detectLanguage(["README.md", "notes.txt"])).toBeNull();
    expect(detectLanguage([])).toBeNull();
  });

  it("matches case-insensitively and through directories", () => {
    expect(detectLanguage(["SRC/GO.MOD"])).toBe("go");
    expect(detectLanguage(["backend/PyProject.toml"])).toBe("python");
  });
});

describe("language resolution", () => {
  it("accepts a matching declaration", () => {
    expect(resolveLanguage("go", ["go.mod"])).toEqual({
      language: "go",
      source: "declared",
      note: null,
    });
  });

  it("lets detection override a contradicting declaration", () => {
    const resolved = resolveLanguage("node", ["requirements.txt"]);
    expect(resolved.language).toBe("python");
    expect(resolved.source).toBe("detected");
    expect(resolved.note).toContain("node");
  });

  it("falls back to detection, then the node default", () => {
    expect(resolveLanguage(undefined, ["Cargo.toml"]).language).toBe("rust");
    expect(resolveLanguage("cobol", ["README.md"])).toEqual({
      language: DEFAULT_LANGUAGE,
      source: "default",
      note: null,
    });
  });

  it("validates language ids", () => {
    expect(isLanguage("elixir")).toBe(true);
    expect(isLanguage("cobol")).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });
});
