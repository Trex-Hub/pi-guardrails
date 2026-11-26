import { describe, expect, it } from "vitest";
import { hasNeverLowRiskCommand } from "./dangerous";

describe("hasNeverLowRiskCommand", () => {
  it.each([
    ["sudo", "sudo apt install ripgrep"],
    ["doas", "doas pkg_add vim"],
    ["pkexec", "pkexec ls"],
    ["dd", "dd if=/dev/zero of=/dev/sda"],
    ["mkfs", "mkfs.ext4 /dev/sda1"],
    ["wipefs", "wipefs -a /dev/sda"],
    ["blkdiscard", "blkdiscard /dev/sda"],
    ["fdisk", "fdisk /dev/sda"],
    ["sfdisk", "sfdisk /dev/sda"],
    ["parted", "parted /dev/sda"],
    ["docker privileged", "docker run --privileged alpine"],
    ["podman host network", "podman run --network=host alpine"],
    ["docker socket", "docker run -v /var/run/docker.sock:/s alpine"],
    ["shred", "shred -u secret.txt"],
  ])("flags %s", (_name, command) => {
    expect(hasNeverLowRiskCommand(command)).toBe(true);
  });

  it.each([
    ["after &&", "cd build && sudo make install"],
    ["after ;", "echo hi; sudo true"],
    ["in a pipeline", "echo y | sudo tee /etc/x"],
    ["in a subshell", "(cd /tmp && sudo ls)"],
    ["after a harmless first match", "rm -rf build && sudo reboot"],
    ["inside a substitution", "echo $(sudo cat /etc/shadow)"],
    ["in an if body", "if true; then sudo ls; fi"],
  ])("flags a risky part that is not first: %s", (_name, command) => {
    expect(hasNeverLowRiskCommand(command)).toBe(true);
  });

  it.each([
    "rm -rf build",
    "rm -rf node_modules && npm install",
    "chmod -R 777 .",
    "chown -R me .",
    "ls -la",
    "docker run alpine echo hi",
    "docker build .",
    "dd if=a.img",
    "git status | head",
  ])("does not flag %s", (command) => {
    expect(hasNeverLowRiskCommand(command)).toBe(false);
  });

  it.each([
    "env FOO=1 sudo ls",
    "nohup sudo ls",
    "xargs sudo rm",
    "command sudo ls",
    "exec sudo ls",
    "timeout 5 sudo ls",
    "/usr/bin/sudo ls",
    "bash -c 'sudo ls'",
    `sh -c "sudo rm -rf /"`,
    "eval sudo ls",
  ])("sees through wrapper: %s", (command) => {
    expect(hasNeverLowRiskCommand(command)).toBe(true);
  });

  it.each([
    "env FOO=1 /sbin/mkfs.ext4 /dev/sda1",
    "nice dd if=a of=b",
    "env docker run --privileged alpine",
    "zsh -c 'doas ls'",
    "dash -lc 'sudo ls'",
    "env bash -c 'echo hi; sudo ls'",
    `bash -c "sh -c 'eval sudo ls'"`,
    "eval 'echo a' ';' 'sudo ls'",
  ])("sees through wrapper and nesting: %s", (command) => {
    expect(hasNeverLowRiskCommand(command)).toBe(true);
  });

  it("does not flag shell -c scripts that are harmless", () => {
    expect(hasNeverLowRiskCommand("bash -c 'ls -la'")).toBe(false);
    expect(hasNeverLowRiskCommand("env FOO=1 ls")).toBe(false);
    expect(hasNeverLowRiskCommand("eval echo hi")).toBe(false);
    expect(hasNeverLowRiskCommand("xargs rm")).toBe(false);
  });

  it("treats nesting deeper than 3 as risky", () => {
    expect(hasNeverLowRiskCommand("bash -c 'bash -c \"bash -c ls\"'")).toBe(
      false,
    );
    const deep = 'bash -c "bash -c \'bash -c \\"bash -c ls\\"\'"';
    expect(hasNeverLowRiskCommand(deep)).toBe(true);
  });

  it("over-matches on purpose: a wrapped name as a plain argument is flagged", () => {
    // Acceptable: the floor can only defer, never allow.
    expect(hasNeverLowRiskCommand("echo sudo")).toBe(true);
    expect(hasNeverLowRiskCommand("git commit -m 'docker run'")).toBe(false);
    expect(hasNeverLowRiskCommand("echo docker run --privileged")).toBe(true);
  });

  it("returns true when a nested script cannot be parsed", () => {
    expect(hasNeverLowRiskCommand("bash -c 'echo \"unterminated'")).toBe(true);
  });

  it("returns true when the command cannot be parsed", () => {
    expect(hasNeverLowRiskCommand("echo 'unterminated")).toBe(true);
    expect(hasNeverLowRiskCommand("if then fi ((")).toBe(true);
  });
});
