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
    "echo sudo",
    "git status | head",
  ])("does not flag %s", (command) => {
    expect(hasNeverLowRiskCommand(command)).toBe(false);
  });

  it("returns true when the command cannot be parsed", () => {
    expect(hasNeverLowRiskCommand("echo 'unterminated")).toBe(true);
    expect(hasNeverLowRiskCommand("if then fi ((")).toBe(true);
  });
});
