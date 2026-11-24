# Answering prompts from other apps (pi-live)

When pi-live is loaded, Guardrails parks interactive permission-gate and path-access prompts so a pi-live client can answer them. The terminal and clients race: the first answer wins. Without pi-live, prompts remain keyboard-only. Parking occurs only inside the TUI custom prompt; RPC's select fallback never parks. Noninteractive blocks, automatic decisions and delegated decisions do not park.

**Security:** anyone who can use a pi-live client can approve `sudo`. Protect access to pi-live accordingly.

## Common contract

Items use protocol `1`, owner `guardrails`, and the same `id` as the corresponding `guardrails:prompt:opened` event's `prompt.id`. They have no `expiresAt`. Each outside target that needs confirmation has its own item. The client answers with an object:

```json
{ "result": "allow" }
```

Each view carries the originating `toolCallId`; `parentToolCallId` is present when the call was made by another tool, allowing clients to correlate nested calls with their parent transcript row.

The result must be one of the item's offered, enabled options. A valid client answer ends the prompt and has the same effect as the corresponding keyboard choice, including session or persistent grants and stopping the turn. Client answers bypass the terminal input guard.

Invalid answers leave the item open and return one of these exact reasons:

- `expected an object with a string "result"`
- `option "<result>" not offered`
- `option "<result>" disabled: <disabledReason>`
- `not open` (the prompt has already ended)

A ticket closes `by: "keyboard"` for a keyboard choice, `by: "client"` for a client answer, `by: "abort"` if the context signal aborts, and `by: "error"` on an error. When the context signal aborts, the prompt ends as `deny`; for a dangerous command, Guardrails records `User denied dangerous command`. The turn is already being aborted.

## Dangerous commands: `guardrails.command`

The title is `Dangerous command: <reason>`. The JSON view is:

```ts
{
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string; // bash or powershell
  command: string;  // raw command, unchanged and untruncated
  reason: string;
  options: Array<{ result: "allow" | "allow-session" | "deny" | "stop"; label: string }>;
}
```

Options are ordered: `allow` (Allow once), `allow-session` (Allow for session), `deny` (Deny), and `stop` (Decline and stop).

## Outside paths: `guardrails.path`

The title is `Outside workspace: <displayPath>`. The JSON view is:

```ts
{
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  path: string;        // absolute target
  displayPath: string; // as shown in the terminal
  directory: string;   // absolute directory a directory grant covers
  cwd: string;
  target: "file" | "directory";
  command?: string;    // raw, unchanged bash or PowerShell command, if present
  reason: string;
  alwaysSavedTo: "project" | "global";
  options: Array<{
    result: "allow-file-once" | "allow-dir-once" | "allow-file-session" |
      "allow-dir-session" | "allow-file-always" | "allow-dir-always" | "deny";
    label: string;
    disabled?: true;
    disabledReason?: string;
  }>;
}
```

`target` is `directory` for directory-only prompts (`ls` and `find`), otherwise `file`. Options and ordering match the terminal: file prompts offer Allow once, Allow file this session, Allow file always, Allow directory this session, Allow directory always, and Deny; directory-only prompts offer Allow once, Allow directory this session, Allow directory always, and Deny. Directory grant options are omitted if the directory is too broad. An untrusted project disables the always options when saving to the project; these options have `disabled: true` and `disabledReason: "project not trusted"`.

`alwaysSavedTo` maps the config's `pathAccess.alwaysScope` value `local` to `project`, and `global` to `global`.
