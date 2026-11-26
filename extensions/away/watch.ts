import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { inboxDir } from "../../src/shared/away/inbox";

const DEBOUNCE_MS = 100;

export interface Watching {
  close(): void;
}

/**
 * Calls `onChange` when the inbox dir changes (`fs.watch`, debounced) and every
 * `pollMs` as a fallback for filesystems where watching is unreliable. Both
 * only wake the caller; the caller reads the files, so a double wake is harmless.
 */
export async function startWatching(
  pollMs: number,
  onChange: () => void,
): Promise<Watching> {
  const dir = inboxDir();
  await mkdir(dir, { recursive: true }).catch(() => undefined);

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const wake = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      onChange();
    }, DEBOUNCE_MS);
    debounce.unref?.();
  };

  let watcher: ReturnType<typeof watch> | undefined;
  try {
    watcher = watch(dir, { persistent: false }, wake);
    watcher.on("error", () => {
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    watcher = undefined;
  }

  const poll = setInterval(onChange, pollMs);
  poll.unref?.();

  return {
    close() {
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      watcher = undefined;
    },
  };
}
