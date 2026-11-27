import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../shared/config/defaults";
import { checkDangerousCommand, compileCommandPatterns } from "./dangerous";

const patterns = DEFAULT_CONFIG.permissionGate.patterns;

function check(command: string, fallback = patterns) {
  return checkDangerousCommand({
    command,
    patterns: compileCommandPatterns(patterns),
    useBuiltinMatchers: true,
    fallbackPatterns: fallback,
  });
}

/** `sh -c '<script>'`, with the quotes in the script escaped. */
const wrapInShell = (script: string) =>
  `sh -c '${script.replaceAll("'", "'\\''")}'`;

const flagged: Array<[string, string]> = [
  // Flagged before this change.
  ["sudo ls", "superuser command"],
  ["FOO=1 sudo ls", "superuser command"],
  ["time sudo ls", "superuser command"],
  ["time -p sudo ls", "superuser command"],
  ["time -p rm -rf x", "recursive force delete"],
  ["time -p nohup sudo ls", "superuser command"],
  ["time -p sh -c 'sudo ls'", "superuser command"],
  ["time -p env X=1 sudo ls", "superuser command"],
  ["echo hi | time -p sudo ls", "superuser command"],
  ["time -p -- sudo ls", "superuser command"],
  ["(sudo ls)", "superuser command"],
  ["echo $(sudo ls)", "superuser command"],
  ["ls | sudo tee x", "superuser command"],
  ["rm -rf build", "recursive force delete"],
  // Wrappers.
  ["env FOO=1 sudo ls", "superuser command"],
  ["env -i sudo ls", "superuser command"],
  ["env -u HOME sudo ls", "superuser command"],
  ["env -S 'sudo ls'", "superuser command"],
  ["nohup rm -rf build", "recursive force delete"],
  ["nice rm -rf build", "recursive force delete"],
  ["nice -n 10 rm -rf build", "recursive force delete"],
  ["nice -10 rm -rf build", "recursive force delete"],
  ["ionice -c3 rm -rf x", "recursive force delete"],
  ["ionice -c 3 -n 5 rm -rf x", "recursive force delete"],
  ["timeout 5 sudo ls", "superuser command"],
  ["timeout -s KILL 5 rm -rf x", "recursive force delete"],
  ["timeout --kill-after=2 5 sudo ls", "superuser command"],
  ["command sudo ls", "superuser command"],
  ["command -p sudo ls", "superuser command"],
  ["exec sudo ls", "superuser command"],
  ["exec -a name sudo ls", "superuser command"],
  ["stdbuf -oL sudo ls", "superuser command"],
  ["stdbuf -o L sudo ls", "superuser command"],
  ["setsid sudo ls", "superuser command"],
  ["chrt -f 10 sudo ls", "superuser command"],
  ["taskset 0x3 sudo ls", "superuser command"],
  ["taskset -c 0-3 sudo ls", "superuser command"],
  ["caffeinate -i rm -rf x", "recursive force delete"],
  ["caffeinate -t 60 sudo ls", "superuser command"],
  ["/usr/bin/time sudo ls", "superuser command"],
  ["env X=1 nohup nice sudo ls", "superuser command"],
  // Path heads.
  ["/usr/bin/sudo ls", "superuser command"],
  ["/bin/rm -rf build", "recursive force delete"],
  ["./x/rm -rf build", "recursive force delete"],
  ["/sbin/mkfs.ext4 /dev/sda1", "filesystem format"],
  ["/usr/bin/docker run --privileged img", "container with privileged mode"],
  // Shells and eval.
  ["sh -c 'rm -rf build'", "recursive force delete"],
  ['bash -c "sudo ls"', "superuser command"],
  ["bash -lc 'sudo ls'", "superuser command"],
  ["bash -ec 'sudo ls'", "superuser command"],
  ["bash -e -c 'sudo ls'", "superuser command"],
  ["bash -o pipefail -c 'sudo ls'", "superuser command"],
  ["ksh -c 'sudo ls'", "superuser command"],
  ["zsh -c 'dd if=/dev/zero of=/dev/disk2'", "disk write operation"],
  ["eval sudo ls", "superuser command"],
  ['eval "rm -rf x"', "recursive force delete"],
  ["sudo -u x bash -c 'ls'", "superuser command"],
  ["env X=1 nohup sh -c 'sudo ls'", "superuser command"],
  ["bash -c 'echo hi; sudo ls'", "superuser command"],
  ["bash -c 'ls | sudo tee x'", "superuser command"],
  ['eval "$(sudo ls)"', "superuser command"],
  // xargs and find.
  ["xargs rm -rf", "recursive force delete"],
  ["xargs -0 rm -rf", "recursive force delete"],
  ["xargs -n1 sudo rm", "superuser command"],
  ["xargs -I{} rm -rf {}", "recursive force delete"],
  ["xargs -I {} -P 4 rm -rf {}", "recursive force delete"],
  ["xargs --max-args 1 rm -rf", "recursive force delete"],
  ["xargs -I{} sh -c 'rm -rf {}'", "recursive force delete"],
  ["find . -name x -exec rm -rf {} \\;", "recursive force delete"],
  ["find . -execdir rm -rf {} +", "recursive force delete"],
  ["find . -name x -ok sudo rm {} \\;", "superuser command"],
  ["find . -exec echo {} \\; -exec rm -rf {} \\;", "recursive force delete"],
  // Others.
  ["env docker run --privileged img", "container with privileged mode"],
  ["nohup doas ls", "privileged command execution"],
  ["timeout 5 pkexec ls", "privileged command execution"],
  ["nohup chmod -R 777 /x", "insecure recursive permissions"],
  ["nohup shred x", "secure file overwrite"],
];

const notFlagged = [
  "echo sudo",
  "echo rm -rf x",
  "grep -rn sudo src",
  'git grep "rm -rf"',
  "time -p ls",
  "time -p make test",
  "time -p",
  "man sudo",
  "which sudo",
  "brew install parted",
  "printf '%s' \"sudo ls\"",
  'git commit -m "sudo fix"',
  "sh script.sh",
  "bash -x script.sh",
  "bash script.sh -c 'sudo ls'",
  "env",
  "env | grep X",
  "env FOO=1 ./run.sh",
  "nohup ./server.sh &",
  "timeout 5 curl https://example.com",
  "xargs echo",
  "xargs -I{} echo {}",
  "find . -name '*.ts' -exec grep sudo {} \\;",
  "find . -name '*.ts' -print",
  "nice -n 10 make",
  "command -v sudo",
  "command -V rm",
  "bash -c 'echo hi'",
  'eval "$(direnv export bash)"',
  "exec ./run.sh",
  "stdbuf -oL tail -f x",
  "/usr/bin/env bash",
  "ls /usr/bin/sudo-docs",
  "cat /bin/rm",
  "sh -c 'echo sudo'",
  "setsid ./daemon",
  "taskset -c 0 ./bench",
];

describe("built-in detection through wrappers", () => {
  it.each(flagged)("flags %j", (command, description) => {
    const match = check(command);
    expect(match?.description).toBe(description);
    expect(match?.pattern).toBe("(structural)");
  });

  it.each(notFlagged)("does not flag %j", (command) => {
    expect(check(command)).toBeUndefined();
  });

  it("flags the nested-quote form from the brief (via the fallback check)", () => {
    const match = check('sh -c "sh -c \'sh -c \\"sudo ls\\"\'"');
    expect(match?.description).toBe("superuser command");
  });

  it("reports the inner matcher's description for a path head", () => {
    expect(check("/usr/bin/sudo ls")).toEqual({
      description: "superuser command",
      pattern: "(structural)",
    });
  });

  it("does nothing when built-in matchers are off", () => {
    expect(
      checkDangerousCommand({
        command: "env X=1 sudo ls",
        patterns: [],
        useBuiltinMatchers: false,
        fallbackPatterns: patterns,
      }),
    ).toBeUndefined();
  });

  describe("nested scripts that cannot be read", () => {
    it("falls back to the substring check when the nested parse fails", () => {
      const match = check("bash -c 'if sudo ls'");
      expect(match).toEqual({
        description: "superuser command",
        pattern: "sudo",
      });
    });

    it("matches structurally through three levels of sh -c", () => {
      const command = wrapInShell(wrapInShell(wrapInShell("sudo ls")));
      expect(check(command)).toEqual({
        description: "superuser command",
        pattern: "(structural)",
      });
    });

    it("falls back to the substring check past depth 3", () => {
      const command = wrapInShell(
        wrapInShell(wrapInShell(wrapInShell("rm -rf x"))),
      );
      const match = check(command);
      expect(match?.description).toBe("recursive force delete");
    });

    it("does not flag deep nesting that has nothing dangerous", () => {
      const command = wrapInShell(
        wrapInShell(wrapInShell(wrapInShell("echo hi"))),
      );
      expect(check(command)).toBeUndefined();
    });

    it("stays quiet when the unparsable script has no dangerous text", () => {
      expect(check("bash -c 'if echo hi'")).toBeUndefined();
    });

    it("never treats an unparsable nested script as safe", () => {
      expect(check("eval 'while sudo'")?.description).toBe("superuser command");
    });
  });

  it("still applies user patterns as before", () => {
    const user = [{ pattern: "curl", description: "network" }];
    const match = checkDangerousCommand({
      command: "env X=1 curl https://x",
      patterns: compileCommandPatterns(user),
      useBuiltinMatchers: true,
      fallbackPatterns: user,
    });
    expect(match).toEqual({ description: "network", pattern: "curl" });
  });
});
