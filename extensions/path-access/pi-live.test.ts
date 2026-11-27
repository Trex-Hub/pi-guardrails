import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMock } from "@golevelup/ts-vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiLiveRequest } from "../../src/shared/pi-live";
import { pathPark } from "./pi-live";
import { createPathAccessPromptComponent, promptOptions } from "./prompt";

const client = { connId: "1", name: "test" };
function setup(
  showFileOptions = true,
  dirGrantable = true,
  alwaysEnabled = true,
) {
  const events = createMock<ExtensionAPI["events"]>();
  const close = vi.fn();
  let request!: PiLiveRequest;
  events.emit.mockImplementation((name, data) => {
    if (name === "pi-live:park") {
      request = data as PiLiveRequest;
      request.accept({ close });
    }
  });
  const signal = new AbortController();
  const result = vi.fn();
  const component = createPathAccessPromptComponent(
    "bash",
    "/outside/a",
    "/outside",
    "/workspace",
    showFileOptions,
    { inputGuardMs: 10000 },
  );
  const park = pathPark({
    events,
    id: "id",
    toolCallId: "test-call",
    toolName: "bash",
    path: "/outside/a",
    displayPath: "/outside/a",
    directory: "/outside",
    cwd: "/workspace",
    command: "cat\n\t/outside/a",
    reason: "outside",
    alwaysScope: "local",
    showFileOptions,
    dirGrantable,
    alwaysEnabled,
    signal: signal.signal,
    component,
  });
  park.factory(
    { terminal: { columns: 80 }, requestRender: vi.fn() },
    { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
    {},
    result,
  );
  return { request, result, close, park, signal };
}

describe("pathPark", () => {
  it("offers raw view and enabled results identical to prompt options", () => {
    for (const option of promptOptions(true)) {
      const { request, result, park } = setup();
      expect(request).toMatchObject({
        id: "id",
        owner: "guardrails",
        kind: "guardrails.path",
        title: "Outside workspace: /outside/a",
        view: {
          path: "/outside/a",
          directory: "/outside",
          target: "file",
          command: "cat\n\t/outside/a",
          alwaysSavedTo: "project",
        },
      });
      expect(request.answer({ result: option.result }, client)).toEqual({
        status: "delivered",
      });
      expect(result).toHaveBeenCalledExactlyOnceWith(option.result);
      park.dispose();
    }
  });
  it("uses directory-only options and removes ungrantable directory grants", () => {
    const { request, park } = setup(false, false);
    expect(request.view).toMatchObject({
      target: "directory",
      options: [{ result: "allow-dir-once" }, { result: "deny" }],
    });
    expect(request.answer({ result: "allow-dir-session" }, client)).toEqual({
      status: "invalid",
      reason: 'option "allow-dir-session" not offered',
    });
    park.dispose();
  });
  it("marks disabled always grants and rejects them", () => {
    const { request, park } = setup(true, true, false);
    expect(request.view).toMatchObject({
      options: expect.arrayContaining([
        {
          result: "allow-file-always",
          label: "Allow file always",
          disabled: true,
          disabledReason: "project not trusted",
        },
      ]),
    });
    expect(request.answer({ result: "allow-file-always" }, client)).toEqual({
      status: "invalid",
      reason: 'option "allow-file-always" disabled: project not trusted',
    });
    park.dispose();
  });
  it("ends on abort and closes once", () => {
    const { signal, result, park, close, request } = setup();
    signal.abort();
    expect(result).toHaveBeenCalledExactlyOnceWith("deny");
    expect(request.answer({ result: "deny" }, client)).toEqual({
      status: "invalid",
      reason: "not open",
    });
    park.dispose();
    expect(close).toHaveBeenCalledExactlyOnceWith({ by: "abort" });
  });
});

describe("pathPark deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setupWithTimeout(timeoutMs?: number) {
    const events = createMock<ExtensionAPI["events"]>();
    const close = vi.fn();
    let request!: PiLiveRequest;
    events.emit.mockImplementation((name, data) => {
      if (name === "pi-live:park") {
        request = data as PiLiveRequest;
        request.accept({ close });
      }
    });
    const result = vi.fn();
    const park = pathPark({
      events,
      id: "id",
      toolCallId: "test-call",
      toolName: "read",
      path: "/outside/a",
      displayPath: "/outside/a",
      directory: "/outside",
      cwd: "/workspace",
      reason: "outside",
      alwaysScope: "local",
      showFileOptions: true,
      dirGrantable: true,
      alwaysEnabled: true,
      timeoutMs,
      card: timeoutMs ? { summary: "Reads a file" } : undefined,
      component: createPathAccessPromptComponent(
        "read",
        "/outside/a",
        "/outside",
        "/workspace",
        true,
      ),
    });
    park.factory(
      { terminal: { columns: 80 }, requestRender: vi.fn() },
      { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s },
      {},
      result,
    );
    return { request, result, close, park };
  }

  it("has no expiresAt, card or timer without a timeout", () => {
    const { request } = setupWithTimeout();
    expect(request).not.toHaveProperty("expiresAt");
    expect(request.view).not.toHaveProperty("card");
  });

  it("carries expiresAt and the card, and closes with by timeout", () => {
    vi.useFakeTimers();
    const { request, result, close, park } = setupWithTimeout(5000);
    expect(request.expiresAt).toBe(Date.now() + 5000);
    expect(request.view).toMatchObject({ card: { summary: "Reads a file" } });
    vi.advanceTimersByTime(5000);
    expect(result).toHaveBeenCalledWith("timeout");
    park.dispose();
    expect(close).toHaveBeenCalledExactlyOnceWith({ by: "timeout" });
    expect(park.closedBy()).toBe("timeout");
  });

  it("clears the timer on dispose", () => {
    vi.useFakeTimers();
    const { result, park } = setupWithTimeout(5000);
    park.dispose();
    vi.advanceTimersByTime(5000);
    expect(result).not.toHaveBeenCalled();
  });
});
