# Decision delegation

How permission-gate and path-access let other extensions decide an action
before prompting the user, and how to write such a delegate.

## Flow

Delegation sits between the deterministic checks and the confirmation prompt.
Only actions that would prompt reach delegates.

```text
permission-gate / path-access  tool_call
├─ session grants, auto-deny, policies, safe checks   unchanged; delegates never see these
├─ nothing would prompt                               unchanged; no delegation
│    (requireConfirmation off, pathAccess "block", print/JSON mode)
├─ delegateDecision()                                 src/shared/delegation/dispatch.ts
│  ├─ roster.list(): enabled delegates (none → prompt as usual)
│  ├─ runDelegates(): all in parallel, shared deadline (delegation.timeoutMs)
│  │                  the first block cancels the rest
│  ├─ combineDelegateOutcomes()                       src/core/delegation.ts
│  ├─ pi.appendEntry("guardrails:decision")           session entry, not sent to the model
│  └─ emit guardrails:decision:delegated
├─ allow → the tool runs, no prompt
├─ block → { block: true }, guardrails:action:blocked with block.source "delegate"
└─ ask   → the usual prompt (RPC uses its select dialog)
```

Merge rule:

| outcomes | result |
|---|---|
| any delegate blocks | blocked |
| every delegate allows | runs without a prompt |
| anything else: an ask, a timeout, an error, an abstention | the usual prompt |

Delegates get `delegation.timeoutMs` to answer (default 10s, capped at 300s). The cap used to be 60s; a delegate that calls a strong model may need `120000` or more.

When one path-access tool call touches several outside paths, each path is
a separate decision, and all of them are delegated at once. Any block blocks
the tool call. Paths that are not allowed are then prompted one at a time.

## Writing a delegate

A delegate is a plain Pi extension. It does not import this package; it
registers an object on the event bus:

```ts
const delegate = {
  id: "example:no-network",          // stable; re-registering replaces it
  name: "no-network",                // shown in the session entry
  isEnabled: () => true,             // optional runtime switch
  decide(request, context) {
    return { verdict: "block", reason: "network downloads are not allowed here" };
  },
};
const register = () => pi.events.emit("guardrails:delegate:register", { delegate });
pi.events.on("guardrails:delegate:request", register);  // features loaded later ask again
register();                                             // features loaded earlier
```

Runnable examples:

- `examples/delegates/no-network.ts`: synchronous rules that block, allow, or abstain.
- `examples/delegates/slow-review.ts`: async work that honors `context.signal`.
- `examples/delegates/classifier.ts`: a delegate backed by Pi classifier models.

Load one with `pi -e examples/delegates/no-network.ts`.

### `decide(request, context)`

Return `{ verdict: "allow" | "block" | "ask", reason, risk?, severe?, card? }`,
a promise of it, or `undefined` to abstain. Abstaining, throwing, or returning a malformed answer
all escalate to the prompt. The `reason` is shown to the user, and to the agent
when the action is blocked.

`request` describes the flagged action:

| field | example |
|---|---|
| `feature` | `"permissionGate"`, `"pathAccess"` |
| `action` | `{ kind: "command", command }` or `{ kind: "file", path }` |
| `reason` | why it was flagged, e.g. `"recursive force delete"` |
| `metadata` | the feature's risk metadata |
| `toolName` | `"bash"`, `"read"`, … |
| `input` | the raw tool input |
| `watch` | away mode only, see [Watch requests](#watch-requests) |
| `standingPermissions` | away mode only: the user's plain-language rules, see [Standing permissions](#standing-permissions) |

`context` is a slice of Pi's extension context:

| field | use |
|---|---|
| `cwd` | session working directory |
| `signal` | aborts on timeout, agent abort, or once another delegate blocked; stop work when it fires |
| `sessionManager` | read-only session: `buildSessionProjection()` for what the model sees, `getBranch()` / `getEntries()` for the full history |
| `modelRegistry` | Pi models, e.g. `getModelOfType("classifier", …)` and `classify()` |

A delegate cannot prompt the user through this contract; it returns `ask`
instead. It is still ordinary extension code and can use its own `pi` API.

## Away mode fields

These only matter when `away.mode` is `"auto"` or `"always"` (see
[away-mode.md](away-mode.md)). Delegates that don't return them keep working.

Extra fields on an answer:

| field | meaning |
|---|---|
| `risk` | `"low"` or `"high"`. While the user is away, an `ask` (or no verdict) can run only if every delegate that reported a risk said `"low"`, at least one reported it, and Guardrails' own checks agree (admin-rights commands, policy-protected files, writes outside the temp folder and anything unparseable are never low risk). Any other value is ignored. |
| `severe` | `true` on a `block` answer marks it as high impact and clearly outside the user's request, such as sending secrets off the machine or gaining admin rights unasked. It ends the turn, pauses the run and creates an urgent inbox item. Ignored on any other verdict. |
| `card` | A plain-language explanation shown on the prompt, in the inbox and to pi-live clients: `{ summary, why?, steps?: { part, meaning }[], risk?, worthKnowing?, category? }`. `summary` is required; other fields are optional strings. Malformed cards are dropped. `category` is a short label such as `"delete build output"` that groups similar actions for standing-permission suggestions. |

Guardrails keeps the first valid card, in roster order, from the delegates
that answered. Delegates report facts (what it does, how risky); Guardrails
code decides what to do with them. A risk or verdict must not depend on
whether the user is present.

### Watch requests

After Guardrails blocks something in away mode, the next
`away.watchCommands` bash or PowerShell commands (10 by default) are also
sent to delegates, even when nothing flagged them, to catch the same action
done another way. Only delegates with `watch: true` receive them:

```ts
const delegate = { id: "...", name: "...", watch: true, decide(request) { /* ... */ } };
```

Those requests have `request.watch = { blocked }`, the actions blocked so
far in the session (`{ feature, toolName, action, outcome: "deferred" | "denied", reason, at }`,
newest last, at most 20). Only `block` has an effect: `allow`, `ask`,
abstaining, a timeout or an error all let the command run, because nothing
flagged it, and a watched command never opens a prompt. A `block` is treated
as a denial. Flagged commands inside the window also carry `watch`, so a
delegate can see the earlier blocks.

### Standing permissions

`request.standingPermissions` is `away.standingPermissions`: plain-language
rules the user wrote for when they are away, for example "delete anything
inside the project folder or /tmp". Treat them as part of what the user
wants. They never override Guardrails' own checks: `sudo` stays higher risk
however a rule is worded.

### Advisors

An advisor is consulted when an away run is stuck (3 blocks in a row with no
progress between them). It registers like a delegate, with its own events:

```ts
const advisor = {
  id: "example:nudge",
  name: "nudge",
  isEnabled: () => true,   // optional
  advise(situation, context) {
    // situation: { reason: "stuck", blocked, blocksSinceAway, standingPermissions }
    return { action: "advise", message: "Skip the blocked steps and summarize." };
    // or { action: "pause", reason: "..." }, or undefined to abstain
  },
};
const register = () => pi.events.emit("guardrails:advisor:register", { advisor });
pi.events.on("guardrails:advisor:request", register);
register();
```

`context` is the same slice the delegates get (`cwd`, `signal`,
`sessionManager`, `modelRegistry`). All enabled advisors run in parallel under
`delegation.timeoutMs`. If any pauses, the run pauses (the first pause reason
in roster order wins). Otherwise the `advise` messages are joined and added to
the block reason the agent sees. Abstaining, throwing and timing out are
ignored; with no usable answer Guardrails sends its own nudge. An advisor can
only warn or pause. It can never allow an action. See
`examples/advisors/nudge.ts`.

## What the user sees

- While delegates decide, one line above the editor:
  `[guardrails] ⠋ deciding rm -rf build/cache · 1/3 answered · 2.6s left`,
  or `[guardrails] ⠋ 2 decisions in progress · 1.4s left` when several tool
  calls are waiting.
- Under the tool call, one session entry per decision:

  ```text
  [guardrails] ✓ allowed: no-network, slow-review · 1.5s
  [guardrails] ? escalated: slow-review timed out · 10.0s
  [guardrails] ✗ blocked: no-network: network downloads are not allowed here · 1ms
  ```

  Expanding it (the tool expand key, or a click) adds the flagged reason and
  one line per delegate with its verdict, reason, and time.

## Events

| event | payload |
|---|---|
| `guardrails:delegate:request` | emitted by each feature on load |
| `guardrails:delegate:register` | `{ delegate }`, emitted by a delegate |
| `guardrails:decision:delegated` | the merged decision with every delegate's outcome |
| `guardrails:advisor:request` | emitted when away mode starts asking for advisors |
| `guardrails:advisor:register` | `{ advisor }`, emitted by an advisor |

Types: `src/shared/delegation/types.ts`.

## Model-backed delegates

A delegate can call Pi classifier models through `context.modelRegistry`
(`getModelOfType("classifier", …)` + `classify()`).
`examples/delegates/classifier.ts` is a full example: for each flagged action
it asks the model three questions (enough context? in scope of the user's
request? impact 0–4?) and maps the answers to a verdict. Copy it into your
own extensions and tune its models, rubric, and thresholds there.
