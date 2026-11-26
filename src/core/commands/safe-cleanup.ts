import { parse, type WordPart } from "@aliou/sh";
import { walkCommands } from "../shell/ast";

/**
 * Names of build output and cache directories that `isSafeCleanup` accepts as
 * the last segment of a target. Deliberately short: anything else is not
 * "known" and stays flagged.
 */
const KNOWN_CLEANUP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".angular",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
]);

/** `rm` flags accepted next to a cleanup target. Anything else is not safe. */
const ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "-r",
  "-R",
  "-f",
  "-rf",
  "-fr",
  "-Rf",
  "-fR",
  "--recursive",
  "--force",
]);

/** Plain path characters. No glob, variable, `~`, quote, backslash or space. */
const PLAIN_PATH = /^[A-Za-z0-9._\-/@+=,:]+$/;

export interface SafeCleanupOptions {
  /** Working directory the command runs in. */
  cwd: string;
  /**
   * Resolves symlinks (`fs.realpathSync`). When given, the directory holding a
   * target must really live inside `cwd`; a throwing call counts as "not
   * inside" unless the directory does not exist yet.
   */
  realpath?: (path: string) => string;
}

/** Literal text of a word, or undefined when it needs expansion in any way. */
function literalWord(parts: readonly WordPart[]): string | undefined {
  let text = "";
  for (const part of parts) {
    if (part.type === "Literal" || part.type === "SglQuoted") {
      text += part.value;
    } else if (part.type === "DblQuoted") {
      const inner = literalWord(part.parts);
      if (inner === undefined) return undefined;
      text += inner;
    } else {
      return undefined;
    }
  }
  return text;
}

function isInside(root: string, path: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
  );
}

function dirOfTargetIsInside(
  cwd: string,
  segments: string[],
  realpath: (path: string) => string,
): boolean {
  let realCwd: string;
  try {
    realCwd = realpath(cwd);
  } catch {
    return false;
  }
  // The deepest existing directory above the target decides: a symlinked
  // component such as `build -> /etc` in `build/x` is caught here. The last
  // segment itself is only unlinked by rm, never followed.
  for (let end = segments.length - 1; end >= 0; end--) {
    const dir = [cwd, ...segments.slice(0, end)].join("/");
    let real: string;
    try {
      real = realpath(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return false;
    }
    return isInside(realCwd, real);
  }
  return true;
}

/**
 * True only for a command line made entirely of `rm -rf` of known build/cache
 * directories, each a plain relative path strictly inside `cwd`.
 *
 * Every simple command in the line (pipelines, lists, subshells, substitutions)
 * must be such an `rm`; any other command, redirect, assignment, expansion,
 * glob, `~`, `..`, absolute path, `.git` component, unknown flag or parse
 * doubt returns false. Conservative on purpose: false only means "not
 * exempt", never "dangerous".
 */
export function isSafeCleanup(
  command: string,
  options: SafeCleanupOptions,
): boolean {
  const cwd = options.cwd;
  if (!cwd.startsWith("/")) return false;
  let ast: ReturnType<typeof parse>["ast"];
  try {
    const result = parse(command, { recoverErrors: true });
    if ((result.errors?.length ?? 0) > 0) return false;
    ast = result.ast;
  } catch {
    return false;
  }
  if (ast.body.length === 0) return false;

  let sawRm = false;
  let safe = true;
  walkCommands(
    ast,
    (cmd, redirects) => {
      if (redirects && redirects.length > 0) {
        safe = false;
        return true;
      }
      // Compound nodes only report their own redirects.
      if (!cmd) return false;
      if (
        (cmd.assignments?.length ?? 0) > 0 ||
        (cmd.redirects?.length ?? 0) > 0
      ) {
        safe = false;
        return true;
      }
      const words: string[] = [];
      for (const word of cmd.words ?? []) {
        const text = literalWord(word.parts);
        if (text === undefined) {
          safe = false;
          return true;
        }
        words.push(text);
      }
      if (!rmIsSafe(words, cwd, options.realpath)) {
        safe = false;
        return true;
      }
      sawRm = true;
      return false;
    },
    { includeSubstitutions: true },
  );
  return safe && sawRm;
}

function rmIsSafe(
  words: string[],
  cwd: string,
  realpath: ((path: string) => string) | undefined,
): boolean {
  if (words[0] !== "rm") return false;
  let recursive = false;
  let force = false;
  const operands: string[] = [];
  for (const word of words.slice(1)) {
    if (word.startsWith("-")) {
      if (!ALLOWED_FLAGS.has(word)) return false;
      if (word === "--recursive") recursive = true;
      else if (word === "--force") force = true;
      else {
        if (/[rR]/.test(word)) recursive = true;
        if (word.includes("f")) force = true;
      }
      continue;
    }
    operands.push(word);
  }
  if (!recursive || !force || operands.length === 0) return false;
  return operands.every((operand) => targetIsSafe(operand, cwd, realpath));
}

function targetIsSafe(
  operand: string,
  cwd: string,
  realpath: ((path: string) => string) | undefined,
): boolean {
  if (!PLAIN_PATH.test(operand)) return false;
  if (operand.startsWith("/")) return false;
  const segments = operand.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return false;
  if (segments.some((s) => s === ".." || s === ".git")) return false;
  const last = segments[segments.length - 1] ?? "";
  if (!KNOWN_CLEANUP_DIRS.has(last)) return false;
  if (realpath && !dirOfTargetIsInside(cwd, segments, realpath)) return false;
  return true;
}
