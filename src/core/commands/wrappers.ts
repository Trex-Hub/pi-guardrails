/**
 * Resolves what a simple command actually runs when it is wrapped.
 *
 * `env X=1 sudo ls` runs `sudo ls`; `xargs rm -rf` runs `rm -rf`;
 * `sh -c 'rm -rf x'` runs the script `rm -rf x`. Given the words of one simple
 * command, `resolveWrapped` returns what it hands over to: command words to
 * check again (wrappers chain) and shell scripts to parse again.
 *
 * Only these wrappers are known (the one place to extend):
 *   env, nohup, nice, ionice, timeout, command, exec, stdbuf, setsid, chrt,
 *   taskset, caffeinate, time, xargs, find -exec|-execdir|-ok|-okdir,
 *   sh|bash|zsh|dash|ksh -c, eval.
 * Where a wrapper's arguments are ambiguous, the guess errs toward treating a
 * word as the command (a false flag is better than a miss).
 */

export type Wrapped = { words: string[] } | { script: string };

export function basename(word: string): string {
  const i = word.lastIndexOf("/");
  return i === -1 ? word : word.slice(i + 1);
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Index of the first word after the options that start at `start`.
 * `withValue` lists the options (short `-n` or long `--name`) whose value is the
 * next word; attached values (`-n5`, `--name=x`) are single words anyway.
 */
function skipOptions(
  words: string[],
  start: number,
  withValue: readonly string[] = [],
): number {
  let i = start;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") return i + 1;
    if (!w.startsWith("-") || w === "-") return i;
    i += !w.includes("=") && withValue.includes(w) ? 2 : 1;
  }
  return i;
}

/** The command words after a wrapper, or nothing when nothing is left. */
function rest(words: string[], from: number): Wrapped[] {
  const inner = words.slice(from);
  return inner.length > 0 ? [{ words: inner }] : [];
}

function env(words: string[]): Wrapped[] {
  let i = 1;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (w === "--") {
      i++;
      break;
    }
    if (w === "-S" || w === "--split-string") {
      return splitString(words[i + 1], words.slice(i + 2));
    }
    if (w.startsWith("--split-string=")) {
      return splitString(w.slice("--split-string=".length), words.slice(i + 1));
    }
    if (w.startsWith("-S") && w.length > 2) {
      return splitString(w.slice(2), words.slice(i + 1));
    }
    if (!w.startsWith("-") || w === "-") break;
    const valued = ["-u", "-C", "-P", "-a", "--unset", "--chdir", "--argv0"];
    i += !w.includes("=") && valued.includes(w) ? 2 : 1;
  }
  while (ASSIGNMENT.test(words[i] ?? "")) i++;
  return rest(words, i);
}

/** `env -S 'sudo ls'`: the string is split into words and run. */
function splitString(value: string | undefined, tail: string[]): Wrapped[] {
  const inner = [...(value ?? "").split(/\s+/).filter(Boolean), ...tail];
  return inner.length > 0 ? [{ words: inner }] : [];
}

function timeout(words: string[]): Wrapped[] {
  const i = skipOptions(words, 1, ["-s", "-k", "--signal", "--kill-after"]);
  return rest(words, i + 1); // one duration, then the command
}

function command(words: string[]): Wrapped[] {
  const i = skipOptions(words, 1);
  // `command -v|-V name` only looks the name up.
  if (words.slice(1, i).some((w) => /^-[a-zA-Z]*[vV]/.test(w))) return [];
  return rest(words, i);
}

function chrt(words: string[]): Wrapped[] {
  let i = skipOptions(words, 1, [
    "-T",
    "-P",
    "-D",
    "--sched-runtime",
    "--sched-period",
    "--sched-deadline",
  ]);
  if (/^\d+$/.test(words[i] ?? "")) i++; // the priority
  return rest(words, i);
}

function taskset(words: string[]): Wrapped[] {
  const i = skipOptions(words, 1, ["-c", "--cpu-list"]);
  const listGiven = words
    .slice(1, i)
    .some(
      (w) => w === "-c" || w === "--cpu-list" || w.startsWith("--cpu-list="),
    );
  return rest(words, listGiven ? i : i + 1); // otherwise a CPU mask comes first
}

const XARGS_WITH_VALUE = [
  "-a",
  "-d",
  "-E",
  "-I",
  "-L",
  "-n",
  "-P",
  "-s",
  "--arg-file",
  "--delimiter",
  "--eof",
  "--replace",
  "--max-lines",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--process-slot-var",
];

/** `find ... -exec cmd args ;|+` (also -execdir, -ok, -okdir), possibly several. */
function find(words: string[]): Wrapped[] {
  const found: Wrapped[] = [];
  for (let i = 1; i < words.length; i++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(words[i] ?? "")) {
      continue;
    }
    let end = i + 1;
    while (end < words.length && words[end] !== ";" && words[end] !== "+") {
      end++;
    }
    const inner = words.slice(i + 1, end);
    if (inner.length > 0) found.push({ words: inner });
    i = end;
  }
  return found;
}

/** `sh -c 'script'`, `bash -lc 'script'`, `bash -e -c 'script'`. */
function shell(words: string[]): Wrapped[] {
  for (let j = 1; j < words.length; j++) {
    const w = words[j] ?? "";
    if (w === "--" || !(w.startsWith("-") || w.startsWith("+"))) return [];
    if (w.startsWith("--")) {
      if (w === "--rcfile" || w === "--init-file") j++;
      continue;
    }
    if (w.startsWith("-") && w.includes("c")) {
      const script = words[j + 1];
      return script === undefined ? [] : [{ script }];
    }
    if (w === "-o" || w === "+o" || w === "-O" || w === "+O") j++;
  }
  return [];
}

type Resolver = (words: string[]) => Wrapped[];

const WRAPPERS: Record<string, Resolver> = {
  env,
  nohup: (words) => rest(words, skipOptions(words, 1)),
  nice: (words) => rest(words, skipOptions(words, 1, ["-n", "--adjustment"])),
  ionice: (words) =>
    rest(words, skipOptions(words, 1, ["-c", "-n", "-p", "-P", "-u"])),
  timeout,
  command,
  exec: (words) => rest(words, skipOptions(words, 1, ["-a"])),
  stdbuf: (words) =>
    rest(
      words,
      skipOptions(words, 1, [
        "-i",
        "-o",
        "-e",
        "--input",
        "--output",
        "--error",
      ]),
    ),
  setsid: (words) => rest(words, skipOptions(words, 1)),
  chrt,
  taskset,
  caffeinate: (words) => rest(words, skipOptions(words, 1, ["-t", "-w"])),
  time: (words) =>
    rest(words, skipOptions(words, 1, ["-f", "-o", "--format", "--output"])),
  xargs: (words) => rest(words, skipOptions(words, 1, XARGS_WITH_VALUE)),
  find,
  eval: (words) =>
    words.length > 1 ? [{ script: words.slice(1).join(" ") }] : [],
  ...Object.fromEntries([...SHELLS].map((name) => [name, shell])),
};

/** What `words` (one simple command, head not yet normalized) hands over to. */
export function resolveWrapped(words: string[]): Wrapped[] {
  const head = basename(words[0] ?? "");
  const resolver = Object.hasOwn(WRAPPERS, head) ? WRAPPERS[head] : undefined;
  return resolver ? resolver([head, ...words.slice(1)]) : [];
}
