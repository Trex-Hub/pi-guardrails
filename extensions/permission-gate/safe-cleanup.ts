import { realpathSync } from "node:fs";
import {
  BUILTIN_KEYWORD_PATTERNS,
  isSafeCleanup,
} from "../../src/core/commands";
import type { ResolvedConfig } from "../../src/shared/config";
import { compileCommandPatterns } from "../../src/shared/matching";

/**
 * Whether a flagged command is exempt under `permissionGate.allowSafeCleanup`.
 * Off by default. Patterns the user added themselves still flag the command:
 * only the built-in `rm -rf` detection is lifted.
 */
export function isExemptSafeCleanup(
  config: ResolvedConfig["permissionGate"],
  command: string,
  cwd: string,
): boolean {
  if (config.allowSafeCleanup !== true) return false;
  const userPatterns = config.useBuiltinMatchers
    ? config.patterns.filter(
        (p) => p.regex || !BUILTIN_KEYWORD_PATTERNS.has(p.pattern),
      )
    : config.patterns;
  if (compileCommandPatterns(userPatterns).some((p) => p.test(command))) {
    return false;
  }
  return isSafeCleanup(command, { cwd, realpath: realpathSync });
}
