import { describe, expect, it, vi } from "vitest";
import { type PiLiveRequest, parkPrompt } from "./pi-live";

describe("parkPrompt", () => {
  function setup(accept = true) {
    let request!: PiLiveRequest;
    const close = vi.fn();
    const onResult = vi.fn();
    const view = { command: "echo test", options: [{ result: "allow" }] };
    const park = parkPrompt({
      events: {
        emit: (_event, data) => {
          request = data;
          if (accept) data.accept({ close });
        },
      },
      id: "prompt-1",
      kind: "guardrails.command",
      title: "Dangerous command: test",
      view,
      options: [
        { result: "allow" },
        {
          result: "always",
          disabled: true,
          disabledReason: "project not trusted",
        },
      ] as const,
      onResult,
    });
    return { request, close, onResult, view, park };
  }
  const client = { connId: "1", name: "test" };

  it("emits the protocol request and delivers immediately", () => {
    const { request, view, onResult, park, close } = setup();
    expect(request).toMatchObject({
      protocol: 1,
      id: "prompt-1",
      owner: "guardrails",
      kind: "guardrails.command",
      title: "Dangerous command: test",
      view,
    });
    expect(request.answer({ result: "allow" }, client)).toEqual({
      status: "delivered",
    });
    expect(onResult).toHaveBeenCalledWith("allow");
    park.dispose();
    expect(close).toHaveBeenCalledExactlyOnceWith({ by: "client", client });
    expect(request.answer({ result: "allow" }, client)).toEqual({
      status: "invalid",
      reason: "not open",
    });
  });
  it("rejects invalid and disabled answers", () => {
    const { request } = setup();
    for (const raw of [null, [], {}, { result: 1 }]) {
      expect(request.answer(raw, client)).toEqual({
        status: "invalid",
        reason: 'expected an object with a string "result"',
      });
    }
    expect(request.answer({ result: "no" }, client)).toEqual({
      status: "invalid",
      reason: 'option "no" not offered',
    });
    expect(request.answer({ result: "always" }, client)).toEqual({
      status: "invalid",
      reason: 'option "always" disabled: project not trusted',
    });
  });
  it("closes once on keyboard or abort and rejects late answers", () => {
    const a = setup();
    a.park.keyboard("allow");
    a.park.dispose();
    a.park.dispose();
    expect(a.close).toHaveBeenCalledExactlyOnceWith({ by: "keyboard" });
    expect(a.request.answer({ result: "allow" }, client)).toEqual({
      status: "invalid",
      reason: "not open",
    });
    const b = setup();
    b.park.dispose("abort");
    expect(b.close).toHaveBeenCalledExactlyOnceWith({ by: "abort" });
  });
  it("works without a ticket", () => {
    const { park, onResult, close } = setup(false);
    park.keyboard("allow");
    park.dispose();
    expect(onResult).toHaveBeenCalledWith("allow");
    expect(close).not.toHaveBeenCalled();
  });
  it("closes on errors", () => {
    const close = vi.fn();
    expect(() =>
      parkPrompt({
        events: {
          emit: (_event, request) => {
            request.accept({ close });
            throw new Error("boom");
          },
        },
        id: "1",
        kind: "guardrails.path",
        title: "test",
        view: {},
        options: [],
        onResult: () => {},
      }),
    ).toThrow("boom");
    expect(close).toHaveBeenCalledExactlyOnceWith({ by: "error" });
    const { park, close: close2 } = setup();
    park.dispose();
    expect(close2).toHaveBeenCalledExactlyOnceWith({ by: "error" });
  });
});
