import {
  createEventBus,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/** Minimal ExtensionAPI with a real event bus, for away-mode tests. */
export function fakePi() {
  const bus = createEventBus();
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    events: bus,
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }),
    appendEntry: vi.fn(),
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    bus,
    fire: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
}

/** Collects every payload emitted on `event`. */
export function collect(
  bus: ReturnType<typeof createEventBus>,
  event: string,
): unknown[] {
  const seen: unknown[] = [];
  bus.on(event, (data) => seen.push(data));
  return seen;
}
