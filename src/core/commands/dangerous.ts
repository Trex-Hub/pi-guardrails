import { type Program, parse } from "@aliou/sh";
import { walkCommands, wordToString } from "../shell/ast";
import { basename, resolveWrapped } from "./wrappers";

/**
 * Dangerous command matchers for the permission gate.
 *
 * Built-in dangerous patterns are matched structurally via AST parsing.
 * Each matcher receives the parsed command words and returns a description
 * if the command is dangerous, or undefined if not matched.
 */

export type StructuralMatcher = (words: string[]) => string | undefined;

export interface CommandPattern {
  pattern: string;
  description?: string;
  regex?: boolean;
}

export interface CompiledCommandPattern {
  test: (input: string) => boolean;
  source: CommandPattern;
}

export interface DangerousCommandMatch {
  description: string;
  pattern: string;
}

export interface DangerousCommandCheckOptions {
  command: string;
  patterns: readonly CompiledCommandPattern[];
  useBuiltinMatchers: boolean;
  fallbackPatterns: readonly CommandPattern[];
}

/**
 * Helper to check if any word starts with a given prefix.
 */
function hasArg(words: string[], prefix: string): boolean {
  return words.some((w) => w.startsWith(prefix));
}

/**
 * Helper to check if short options contain specific flags.
 * Handles grouped short options like -rf, -fr, -Rfv, etc.
 */
function hasShortFlag(words: string[], flag: string): boolean {
  return words.some(
    (w) =>
      w === `-${flag}` ||
      (w.startsWith("-") && !w.startsWith("--") && w.includes(flag)),
  );
}

/**
 * Helper to check for long options.
 */
function hasLongOption(words: string[], option: string): boolean {
  return words.some((w) => w === `--${option}`);
}

// =============================================================================
// File/Directory Destruction
// =============================================================================

/**
 * rm -rf, rm -r -f, rm --recursive --force, etc.
 * Catches recursive force delete in any form.
 */
const rmMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "rm") return undefined;

  const hasRecursive =
    hasShortFlag(words, "r") ||
    hasShortFlag(words, "R") ||
    hasLongOption(words, "recursive") ||
    hasLongOption(words, "dir");

  const hasForce = hasShortFlag(words, "f") || hasLongOption(words, "force");

  return hasRecursive && hasForce ? "recursive force delete" : undefined;
};

/**
 * shred - secure file/device overwrite
 */
const shredMatcher: StructuralMatcher = (words) => {
  if (words[0] === "shred") return "secure file overwrite";
  return undefined;
};

// =============================================================================
// Privilege Escalation
// =============================================================================

/**
 * sudo - superuser command
 */
const sudoMatcher: StructuralMatcher = (words) => {
  if (words[0] === "sudo") return "superuser command";
  return undefined;
};

/**
 * doas - privilege escalation (OpenBSD-style sudo alternative)
 */
const doasMatcher: StructuralMatcher = (words) => {
  if (words[0] === "doas") return "privileged command execution";
  return undefined;
};

/**
 * pkexec - PolicyKit privilege escalation
 */
const pkexecMatcher: StructuralMatcher = (words) => {
  if (words[0] === "pkexec") return "privileged command execution";
  return undefined;
};

// =============================================================================
// Disk/Filesystem Operations
// =============================================================================

/**
 * dd of= - disk write operation
 * Any dd command with an output file is potentially dangerous.
 */
const ddMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "dd") return undefined;
  return hasArg(words, "of=") ? "disk write operation" : undefined;
};

/**
 * mkfs, mkfs.* - filesystem format
 */
const mkfsMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "mkfs" || cmd?.startsWith("mkfs.")) return "filesystem format";
  return undefined;
};

/**
 * wipefs - filesystem signature wipe
 */
const wipefsMatcher: StructuralMatcher = (words) => {
  if (words[0] === "wipefs") return "filesystem signature wipe";
  return undefined;
};

/**
 * blkdiscard - block device discard (destroys data)
 */
const blkdiscardMatcher: StructuralMatcher = (words) => {
  if (words[0] === "blkdiscard") return "block device discard";
  return undefined;
};

// =============================================================================
// Disk Partitioning
// =============================================================================

/**
 * fdisk, sfdisk, cfdisk - disk partitioning
 */
const fdiskMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "fdisk" || cmd === "sfdisk" || cmd === "cfdisk") {
    return "disk partitioning";
  }
  return undefined;
};

/**
 * parted, sgdisk - advanced disk partitioning
 */
const partedMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (cmd === "parted" || cmd === "sgdisk") return "disk partitioning";
  return undefined;
};

// =============================================================================
// Permission Changes
// =============================================================================

/**
 * chmod -R 777, chmod --recursive 777, chmod -R 0777, etc.
 * Insecure recursive world-writable permissions.
 */
const chmodMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "chmod") return undefined;

  const hasRecursive =
    hasShortFlag(words, "R") || hasLongOption(words, "recursive");

  const hasWorldWritable = words.some(
    (w) =>
      w === "777" ||
      w === "0777" ||
      w === "a+rwx" ||
      w === "ugo+rwx" ||
      w === "7777" || // setuid/setgid/sticky + world writable
      w === "1777", // sticky + world writable
  );

  return hasRecursive && hasWorldWritable
    ? "insecure recursive permissions"
    : undefined;
};

/**
 * chown -R, chown --recursive - recursive ownership change
 */
const chownMatcher: StructuralMatcher = (words) => {
  if (words[0] !== "chown") return undefined;

  const hasRecursive =
    hasShortFlag(words, "R") || hasLongOption(words, "recursive");

  return hasRecursive ? "recursive ownership change" : undefined;
};

// =============================================================================
// Container Escape / Dangerous Container Operations
// =============================================================================

/**
 * Docker/Podman dangerous run/create patterns.
 * Flags: --privileged, --pid=host, --network=host, --userns=host,
 *        --uts=host, --ipc=host, -v /:/host, docker socket mounts
 */
const containerMatcher: StructuralMatcher = (words) => {
  const cmd = words[0];
  if (!cmd) return undefined;

  // Match docker or podman commands
  const isDocker = cmd === "docker" || cmd === "podman";
  if (!isDocker) return undefined;

  // Only check run and create commands (not build, pull, etc.)
  const subcommand = words[1];
  if (subcommand !== "run" && subcommand !== "create") return undefined;

  // Check for dangerous flags
  const hasPrivileged = words.some(
    (w) => w === "--privileged" || w.startsWith("--privileged="),
  );

  const hasHostPid = words.some(
    (w) => w === "--pid=host" || w.startsWith("--pid=host"),
  );

  const hasHostNetwork = words.some(
    (w) => w === "--network=host" || w.startsWith("--network=host"),
  );

  const hasHostUsers = words.some(
    (w) => w === "--userns=host" || w.startsWith("--userns=host"),
  );

  const hasHostUts = words.some(
    (w) => w === "--uts=host" || w.startsWith("--uts=host"),
  );

  const hasHostIpc = words.some(
    (w) => w === "--ipc=host" || w.startsWith("--ipc=host"),
  );

  // Check for root filesystem bind mount
  const hasRootMount = words.some(
    (w) =>
      w.startsWith("-v/:") ||
      w.startsWith("-v/=>") ||
      w.startsWith("--volume=/:") ||
      w.startsWith("--mount=type=bind,source=/,"),
  );

  // Check for docker socket mount
  const hasDockerSocket = words.some(
    (w) =>
      w.includes("/var/run/docker.sock") ||
      w.includes("/run/docker.sock") ||
      w.includes("/var/run/podman.sock") ||
      w.includes("/run/podman.sock"),
  );

  if (hasPrivileged) return "container with privileged mode";
  if (hasHostPid) return "container with host PID namespace";
  if (hasHostNetwork) return "container with host network";
  if (hasHostUsers) return "container with host user namespace";
  if (hasHostUts) return "container with host UTS namespace";
  if (hasHostIpc) return "container with host IPC";
  if (hasRootMount) return "container with root filesystem mount";
  if (hasDockerSocket) return "container with docker socket access";

  return undefined;
};

// =============================================================================
// Matcher Registry
// =============================================================================

/**
 * All built-in dangerous command matchers.
 * Order matters - earlier matchers take precedence if multiple match.
 */
export const BUILTIN_MATCHERS: StructuralMatcher[] = [
  // Destruction (highest priority)
  rmMatcher,
  shredMatcher,

  // Privilege escalation
  sudoMatcher,
  doasMatcher,
  pkexecMatcher,

  // Disk/filesystem operations
  ddMatcher,
  mkfsMatcher,
  wipefsMatcher,
  blkdiscardMatcher,
  fdiskMatcher,
  partedMatcher,

  // Permission changes
  chmodMatcher,
  chownMatcher,

  // Container escapes
  containerMatcher,
];

/**
 * Keywords for each built-in matcher, used for documentation/UI.
 * These should match the patterns in DEFAULT_CONFIG in config.ts.
 */
export const BUILTIN_KEYWORD_PATTERNS = new Set([
  "rm -rf",
  "sudo",
  "dd of=",
  "mkfs.",
  "chmod -R 777",
  "chown -R",
  "doas",
  "pkexec",
  "shred",
  "wipefs",
  "blkdiscard",
  "fdisk",
  "parted",
  "docker run --privileged",
]);

/**
 * Match a command against all built-in dangerous patterns.
 * Returns the first match found, or undefined if no match.
 */
export function matchDangerousCommand(
  words: string[],
): DangerousCommandMatch | undefined {
  for (const matcher of BUILTIN_MATCHERS) {
    const description = matcher(words);
    if (description) {
      // Use the command itself as the pattern identifier
      const pattern = words[0] ?? "unknown";
      return { description, pattern };
    }
  }
  return undefined;
}

export function compileCommandPattern(
  config: CommandPattern,
): CompiledCommandPattern {
  if (config.regex) {
    try {
      const re = new RegExp(config.pattern);
      return { test: (input) => re.test(input), source: config };
    } catch {
      return { test: () => false, source: config };
    }
  }

  return {
    test: (input) => input.includes(config.pattern),
    source: config,
  };
}

export function compileCommandPatterns(
  configs: readonly CommandPattern[],
): CompiledCommandPattern[] {
  return configs.map(compileCommandPattern);
}

function matchBuiltinDangerous(
  words: string[],
): DangerousCommandMatch | undefined {
  if (words.length === 0) return undefined;
  for (const matcher of BUILTIN_MATCHERS) {
    const description = matcher(words);
    if (description) return { description, pattern: "(structural)" };
  }
  return undefined;
}

const NEVER_LOW_RISK_MATCHERS: readonly StructuralMatcher[] = [
  sudoMatcher,
  doasMatcher,
  pkexecMatcher,
  ddMatcher,
  mkfsMatcher,
  wipefsMatcher,
  blkdiscardMatcher,
  fdiskMatcher,
  partedMatcher,
  containerMatcher,
  shredMatcher,
];

const NEVER_LOW_RISK_COMMANDS = new Set([
  "sudo",
  "doas",
  "pkexec",
  "dd",
  "wipefs",
  "blkdiscard",
  "fdisk",
  "sfdisk",
  "parted",
  "sgdisk",
  "shred",
  "docker",
  "podman",
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/** Nested `sh -c` / `eval` strings are parsed up to this depth. */
const MAX_NEVER_LOW_RISK_DEPTH = 3;

function isNeverLowRiskCommandName(name: string): boolean {
  return NEVER_LOW_RISK_COMMANDS.has(name) || name.startsWith("mkfs");
}

/** Script strings handed to a shell (`-c`) or `eval` by the word at `i`. */
function nestedScript(words: string[], i: number): string | undefined {
  const name = basename(words[i] ?? "");
  if (name === "eval") return words.slice(i + 1).join(" ");
  if (!SHELLS.has(name)) return undefined;
  for (let j = i + 1; j < words.length; j++) {
    const w = words[j] ?? "";
    if (w.startsWith("-") && !w.startsWith("--") && w.includes("c")) {
      return words[j + 1];
    }
  }
  return undefined;
}

function neverLowRisk(command: string, depth: number): boolean {
  if (depth > MAX_NEVER_LOW_RISK_DEPTH) return true;
  let ast: Program;
  try {
    const result = parse(command, { recoverErrors: true });
    if ((result.errors?.length ?? 0) > 0) return true;
    ast = result.ast;
  } catch {
    return true;
  }

  let found = false;
  walkCommands(
    ast,
    (cmd) => {
      if (!cmd) return false;
      const words = (cmd.words ?? []).map(wordToString);
      for (let i = 0; i < words.length; i++) {
        const name = basename(words[i] ?? "");
        if (isNeverLowRiskCommandName(name)) {
          const suffix = [name, ...words.slice(i + 1)];
          if (NEVER_LOW_RISK_MATCHERS.some((matcher) => matcher(suffix))) {
            found = true;
            return true;
          }
        }
        const script = nestedScript(words, i);
        if (script !== undefined && neverLowRisk(script, depth + 1)) {
          found = true;
          return true;
        }
      }
      return false;
    },
    { includeSubstitutions: true },
  );
  return found;
}

/**
 * True when any simple command in `command` (pipelines, lists, subshells and
 * substitutions included) matches a matcher whose commands can never count as
 * low risk: admin rights, disk and filesystem operations, risky container runs
 * and secure overwrite. Unparseable input returns true. `rm`, `chmod` and
 * `chown` are deliberately not on the list.
 *
 * Wrappers are seen through: every position in a command whose basename is one
 * of those commands is matched as if it started the command (`env X=1 sudo`,
 * `xargs sudo`, `/usr/bin/sudo`, ...), and the string argument of
 * `sh|bash|zsh|dash -c` and `eval` is parsed again (depth 3; deeper or
 * unparseable returns true). This over-matches (`echo sudo` is true); that is
 * acceptable because the result can only defer an action, never allow one.
 */
export function hasNeverLowRiskCommand(command: string): boolean {
  return neverLowRisk(command, 0);
}

/** Nested scripts (`sh -c`, `eval`) are parsed up to this depth. */
const MAX_SCRIPT_DEPTH = 3;

function substringMatch(
  command: string,
  fallbackPatterns: readonly CommandPattern[],
): DangerousCommandMatch | undefined {
  for (const pattern of fallbackPatterns) {
    if (command.includes(pattern.pattern)) {
      return {
        description: pattern.description ?? pattern.pattern,
        pattern: pattern.pattern,
      };
    }
  }
  return undefined;
}

/**
 * Matches the built-in matchers against the command a simple command really
 * runs: its head by basename (`/usr/bin/sudo`), and whatever a wrapper hands
 * over to (`env X=1 sudo`, `xargs rm -rf`, `sh -c '...'`), see `wrappers.ts`.
 */
function matchWrapped(
  words: string[],
  depth: number,
  fallbackPatterns: readonly CommandPattern[],
): DangerousCommandMatch | undefined {
  if (words.length === 0) return undefined;
  const direct = matchBuiltinDangerous([
    basename(words[0] ?? ""),
    ...words.slice(1),
  ]);
  if (direct) return direct;
  for (const inner of resolveWrapped(words)) {
    const match =
      "words" in inner
        ? matchWrapped(inner.words, depth, fallbackPatterns)
        : matchScript(inner.script, depth + 1, fallbackPatterns);
    if (match) return match;
  }
  return undefined;
}

/**
 * A script handed to a shell. Past the depth limit, or when it does not parse
 * cleanly, the substring fallbacks run on it: never safe just because it could
 * not be parsed.
 */
function matchScript(
  script: string,
  depth: number,
  fallbackPatterns: readonly CommandPattern[],
): DangerousCommandMatch | undefined {
  if (depth > MAX_SCRIPT_DEPTH) return substringMatch(script, fallbackPatterns);
  let ast: Program | undefined;
  let clean = false;
  try {
    const result = parse(script, { recoverErrors: true });
    ast = result.ast;
    clean = (result.errors?.length ?? 0) === 0;
  } catch {
    ast = undefined;
  }
  const match = ast ? matchProgram(ast, depth, fallbackPatterns) : undefined;
  if (match) return match;
  return clean ? undefined : substringMatch(script, fallbackPatterns);
}

function matchProgram(
  ast: Program,
  depth: number,
  fallbackPatterns: readonly CommandPattern[],
): DangerousCommandMatch | undefined {
  let match: DangerousCommandMatch | undefined;
  walkCommands(
    ast,
    (cmd) => {
      // Skip compound-node redirect callbacks (cmd === undefined): command
      // matchers match on words, not redirect targets.
      if (!cmd) return false;
      const words = (cmd.words ?? []).map(wordToString);
      match = matchWrapped(words, depth, fallbackPatterns);
      return match !== undefined;
    },
    { includeSubstitutions: true },
  );
  return match;
}

export function checkDangerousCommand({
  command,
  patterns,
  useBuiltinMatchers,
  fallbackPatterns,
}: DangerousCommandCheckOptions): DangerousCommandMatch | undefined {
  // Recovery returns a best-effort partial AST next to the errors that
  // triggered it. Structural matching on a recovered AST only adds detections;
  // the substring fallbacks still run for every parse that did not come back
  // clean, so a partial AST is never the sole basis for treating a command as
  // safe.
  let parsedCleanly = false;
  let ast: Program | undefined;
  try {
    const result = parse(command, { recoverErrors: true });
    ast = result.ast;
    parsedCleanly = (result.errors?.length ?? 0) === 0;
  } catch {
    ast = undefined;
  }

  if (useBuiltinMatchers) {
    if (ast && ast.body.length > 0) {
      const match = matchProgram(ast, 0, fallbackPatterns);
      if (match) return match;
    }
    if (!parsedCleanly) {
      const match = substringMatch(command, fallbackPatterns);
      if (match) return match;
    }
  }

  for (const compiled of patterns) {
    const source = compiled.source;
    if (
      useBuiltinMatchers &&
      parsedCleanly &&
      !source.regex &&
      BUILTIN_KEYWORD_PATTERNS.has(source.pattern)
    ) {
      continue;
    }

    if (compiled.test(command)) {
      return {
        description: source.description ?? source.pattern,
        pattern: source.pattern,
      };
    }
  }

  return undefined;
}
