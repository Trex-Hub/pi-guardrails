// Local mirror of pi-live's protocol 1 event contract; pi-live is optional.
export interface PiLiveClient {
  connId: string;
  name: string;
}

export interface PiLiveTicket {
  close(outcome: {
    by: "keyboard" | "client" | "timeout" | "abort" | "error" | "shutdown";
    client?: PiLiveClient;
  }): void;
}

export interface PiLiveRequest {
  protocol: 1;
  id: string;
  owner: string;
  kind: string;
  title: string;
  view: unknown;
  expiresAt?: number;
  answer(
    raw: unknown,
    from: PiLiveClient,
  ): { status: "delivered" } | { status: "invalid"; reason: string };
  accept(ticket: PiLiveTicket): void;
}

interface ParkOption<T extends string> {
  result: T;
  disabled?: boolean;
  disabledReason?: string;
}

/** Call inside the custom component factory; dispose in the surrounding finally. */
export function parkPrompt<T extends string>(params: {
  events: { emit(event: string, data: PiLiveRequest): void };
  id: string;
  kind: "guardrails.command" | "guardrails.path";
  title: string;
  view: unknown;
  options: readonly ParkOption<T>[];
  onResult(result: T): void;
}) {
  let ticket: PiLiveTicket | undefined;
  let open = true;
  let outcome: Parameters<PiLiveTicket["close"]>[0] = { by: "error" };
  let disposed = false;

  const finish = (result: T, by: typeof outcome) => {
    if (!open) return false;
    open = false;
    outcome = by;
    try {
      params.onResult(result);
    } catch (error) {
      outcome = { by: "error" };
      throw error;
    }
    return true;
  };
  const dispose = (by?: "abort" | "error") => {
    if (disposed) return;
    disposed = true;
    if (open && by) outcome = { by };
    open = false;
    ticket?.close(outcome);
  };
  try {
    params.events.emit("pi-live:park", {
      protocol: 1,
      id: params.id,
      owner: "guardrails",
      kind: params.kind,
      title: params.title,
      view: params.view,
      answer(raw, from) {
        if (!open) return { status: "invalid", reason: "not open" };
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          !("result" in raw) ||
          typeof raw.result !== "string"
        ) {
          return {
            status: "invalid",
            reason: 'expected an object with a string "result"',
          };
        }
        const option = params.options.find(
          (item) => item.result === raw.result,
        );
        if (!option)
          return {
            status: "invalid",
            reason: `option "${raw.result}" not offered`,
          };
        if (option.disabled)
          return {
            status: "invalid",
            reason: `option "${raw.result}" disabled: ${option.disabledReason}`,
          };
        finish(option.result, { by: "client", client: from });
        return { status: "delivered" };
      },
      accept(accepted) {
        ticket = accepted;
      },
    });
  } catch (error) {
    dispose("error");
    throw error;
  }
  return {
    keyboard: (result: T) => finish(result, { by: "keyboard" }),
    abort: (result: T) => finish(result, { by: "abort" }),
    dispose,
  };
}
