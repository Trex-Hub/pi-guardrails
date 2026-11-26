# Away mode (design)

Status: agreed design, not built yet. We will adjust it based on runs that
go wrong.

## Problem

Guardrails can wait for a human forever. A flagged command opens a prompt
and the agent stops until someone answers. That is fine at the keyboard and
bad for long or overnight runs.

Numbers from the local sessions (96 delegated decisions):

- 82% of decisions ended as `ask`, which opens a prompt.
- The longest wait was 12.8 hours. Several others took 2 to 3.5 hours, and
  many took 15 to 25 minutes.
- 93 of the 96 were `rm -rf`, mostly cleanup of the agent's own files.

## Goal

Every Guardrails decision ends within a set time. When the user is away, a
decision ends in allow or block, never "wait".

Non-goals:

- Replacing a sandbox. A model reviewer misses things; Claude Code's own
  reviewer misses about 1 in 6 risky actions. A sandbox is still the real
  backstop.
- Changing behavior for users who don't turn this on. Away mode is off by
  default (`away.mode: "off"`).

## How it works

```text
Flagged command (dangerous pattern, or outside path)
  → SubQ decides?            yes → done
  → Opus/Fable decides?      yes → done
  → Both unsure:
      User present → prompt with a plain-language card (2 min limit)
                       answered → the user's choice
                       no answer → user is now away; apply the away rules
      User away    → away rules:
                       low risk    → run it, flag it for the morning review
                       higher risk → defer it: don't run it, put it on the list
```

Around that flow:

- Something clearly harmful is blocked. A severe case ends the turn at once
  and notifies the user (the tripwire).
- After any block, the next 10 commands are also reviewed, to catch the same
  action done another way.
- If the agent is stuck (3 blocks with nothing done in between), a
  supervisor model guides it or pauses it.
- After 50 blocks, the run pauses.
- Every item goes into one inbox shared by all sessions on the machine. In
  the morning the user works through it, and each agent picks up from where
  it stopped.

Modes (`away.mode`):

| mode | for | behavior |
|---|---|---|
| `off` | default | today's behavior; prompts wait for an answer |
| `auto` | a laptop | prompts wait 2 minutes, then the user counts as away |
| `always` | a home server | never prompts; the away rules always apply |

In `auto`, runs without a terminal UI (print and JSON mode) count as away.
In `off`, they keep today's behavior and block flagged actions.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Track presence (present or away) instead of only adding a timeout. | With only a timeout, every prompt in the night costs the full wait. With presence, only the first one does. |
| D2 | A prompt waits 2 minutes, then the user counts as away. | The user's choice. Long enough to notice a prompt, short enough to lose little time. |
| D3 | The command that times out follows the away rules. It is not denied outright. | It already has both reviews. Treat it like any command that arrives while away. |
| D4 | The models report facts: what the command does, risk, and whether it seems wanted. Guardrails code applies presence and policy. | The same answer can be reused when a prompt times out. Policy stays in reviewable code, not in a prompt. |
| D5 | Order: fast reviewer, then strong reviewer, then the user. | Fewer prompts, and every prompt shows the strong model's explanation. Token cost is acceptable. |
| D6 | Away and unsure and low risk: run it and flag it. | The user's choice. More progress overnight, and the morning review catches mistakes. |
| D7 | "Low risk" uses a fixed checklist, and code enforces the parts it can check. | A model alone shouldn't decide what counts as safe enough to run unwatched. |
| D8 | Away and unsure and not low risk: defer. The agent is told the action is queued. | Telling the agent the action is waiting removes the reason to look for a workaround. |
| D9 | Deferred and denied are different outcomes with different messages. | A deferral means the user wasn't there; it isn't the agent's fault. A denial means the agent shouldn't do this. |
| D10 | A repeat of a deferred or denied action is blocked at once, with no model call. | Retries cost nothing and teach nothing. |
| D11 | A severe denial ends the turn at once and notifies the user. | One attempt to send secrets off the machine is enough to stop. |
| D12 | After a block, the next 10 commands are reviewed. | Catches workarounds like `find build -delete` after `rm -rf build` was blocked. |
| D13 | Stuck means 3 blocks with nothing done in between. Then a supervisor steps in. | Progress matters more than block counts. 20 blocks over a productive night is normal. |
| D14 | 50 blocks since the user left pauses the run. | Only a cost limit. |
| D15 | When a limit is reached, the run pauses instead of stopping. Approving an item resumes it. | The night ends as "waiting for you", not dead. |
| D16 | Only the per-command reviewers or the user can allow an action. The ladder and the supervisor can only warn, pause, or stop. | Getting stuck must never make allowing easier. Otherwise looping or prompt injection would pay off. |
| D17 | Every item gets a plain-language card. | The user can't read long escaped bash. The cards help the user learn alongside the system. |
| D18 | The user writes standing permissions in plain words. The morning review suggests new ones. | The list shrinks each week. This is what scales to more agents. |
| D19 | Core behavior goes in this package (opt-in). Models and prompts go in the user's own reviewer extension. | Model choices are personal and change often. The core stays model-agnostic. |
| D20 | One inbox for all sessions on a machine. | The user runs 10+ sessions at once and can't track them one by one. |
| D21 | One setting, `away.mode: off / auto / always`, in `guardrails.json`. | One value can't form an invalid combination. Same file, schema and settings screen as every other Guardrails setting. |
| D22 | In `auto` and `always`, print and JSON runs count as away. | Nobody can answer a prompt there. |
| D23 | Messages sent through RPC don't count as presence. | Guardrails can't tell a script from a person. A script must not be able to cancel away mode. |
| D24 | Each session tracks presence on its own. | Simple. The cost is one 2-minute wait per session, which the user accepted. |

## Presence

Each Pi session tracks whether the user is present or away (D24). In `auto`
it starts as present, or as away in print and JSON mode. In `always` it is
always away and nothing changes it.

| Change | Cause |
|---|---|
| present → away | A prompt reaches its time limit; or the user runs `/guardrails:away` |
| away → present | Any key pressed in the terminal (`ctx.ui.onTerminalInput`); a message the user typed (`input` event with `source: "interactive"`); or an answer from a pi-live client |

Messages from other extensions (`source: "extension"`, such as pi-link) don't
count as presence. They come from agents, not the user. Messages sent through
RPC (`source: "rpc"`) don't count either (D23).

When the user returns, the stuck and limit counters reset. Items on the list
stay until the user handles them.

## Prompt time limit

- The prompt has a deadline (`away.promptTimeoutMs`, 120000 in the user's
  config).
- The pi-live item gets `expiresAt`, so clients can show a countdown.
- On timeout the prompt closes with `by: "timeout"`, the session becomes away,
  and the away rules run with the delegates' answers already collected.
- If one tool call had several prompts queued (several outside paths), the
  rest skip their prompts and go straight to the away rules.
- The input guard still applies: a key pressed in the last second doesn't
  answer the prompt, but it does count as presence.

## Away rules

Applied to an `ask` result (both reviewers unsure) while away:

1. If the action is low risk: allow it, and record it as "allowed while you
   were away".
2. Otherwise: defer it. Block it with the deferred message and record it as
   "waiting for you".

### Low risk

An action is low risk only if **all** of these are true:

- It can be undone, or it only touches the project folder or the system
  temp folder.
- It doesn't read or change secrets (`.env` files, keys, tokens, credentials).
- It doesn't send data off the machine.
- It doesn't use admin rights (`sudo`, `doas`, `pkexec`).

Delegates fill in the risk (see the contract changes below). Code overrides
the delegates when it can check a point itself:

- An action flagged by a built-in admin-rights matcher is never low risk.
- An action that touches a file covered by a policy rule is never low risk.
- If no delegate reported a risk, the action is not low risk.
- If any delegate reported high risk, the action is not low risk.

### Messages to the agent

Deferred:

> Queued for the user's approval; the user is away. Don't retry this or do
> the same thing another way. Continue with other work, and list this under
> "needs approval" in your final summary.

Denied:

> Blocked: <reviewer's reason>. Don't do this, and don't do the same thing
> another way.

Repeat:

> Already queued for the user's approval. / Already denied.

## Repeats

Guardrails remembers each deferred or denied action for the session:

- Commands: the command text with whitespace normalized.
- Paths: the absolute path.

A later request for the same action is blocked at once with the repeat
message, without running delegates. A repeat doesn't count toward stuck. It
does count toward the 50-block limit.

## Tripwire

A delegate can mark a `block` answer as severe. Severe means high impact and
clearly outside the user's request, sending data off the machine, or gaining
admin rights without being asked to.

On a severe block, Guardrails:

1. Blocks the call with `terminate: true`, so the turn ends after the current
   batch.
2. Records the item and emits `guardrails:tripwire`.
3. Shows the item as urgent at the top of the inbox.

For v1, the event and the inbox entry are the only notification.

This applies whether the user is present or away.

## Watch window

After any block (deferred, denied or repeat), the next 10 `bash` or
`powershell` commands go to delegates even if nothing flagged them.

- Only delegates that opt in (`watch: true`) receive these.
- The request carries `watch: { blocked: [...] }`, the actions blocked so far
  this session, and asks whether the new command does the same thing.
- For a watched command, only `block` has an effect. `allow`, `ask`, abstain,
  a timeout or an error all let it run, because nothing flagged it. A watched
  command never opens a prompt or gets deferred.
- A `block` here is treated as a denial and also counts toward the tripwire
  rules.

Known gap: an agent could retry after the window closes. The deferred message
removes most of the reason to do that.

## Stuck and the supervisor

**Progress:** a `bash`, `powershell`, `edit` or `write` call that runs and
isn't blocked, whatever its exit code. Reads don't count.

**Stuck:** 3 blocks (deferred or denied) with no progress between them.

When stuck, Guardrails asks the registered advisor (see the contract
changes). The advisor sees the user's requests, the agent's recent tool
calls, and the blocked list, and answers with one of:

- `advise`: a message sent to the agent as a steer message.
- `pause`: pause the run.

If no advisor is registered, Guardrails sends a built-in message ("several
actions in a row need the user's approval; continue with work that doesn't
need them, or wrap up with a summary"). If the agent gets stuck again before
making progress, Guardrails pauses the run.

The advisor can't allow anything (D16).

## Limit and pause

- 50 blocks since the user left pauses the run.
- Pausing blocks the current call with `terminate: true` and adds a summary
  to the session listing what is waiting.

Resume:

- Approving a waiting item (in the inbox or from pi-live) grants that exact
  action once.
- Guardrails then sends the agent "approved: <action>; you can run it now".
  If the agent is idle, the message starts a turn.
- Rejecting an item sends "rejected: <action>; don't do this" when the agent
  next runs.
- See "Shared inbox" for how a decision reaches a session that is running
  elsewhere or has closed.

## Cards

Each item gets a plain-language card, shown on the prompt and in the inbox:

```text
What it wants to do   one or two sentences
Why it was stopped    the flag, in plain words
Step by step          each part of the command, with its meaning
Risk                  low or higher, and why
Worth knowing         one thing the user can learn from it (optional)
```

The strong reviewer writes the card in the same call that judges the command,
so it costs no extra time. Without a card, the raw command and the flag
reason are shown, as today.

## Shared inbox: `/guardrails:inbox`

One inbox per machine, shared by every Pi session on it (D20). Running
`/guardrails:inbox` in any session shows every item from every session,
grouped by project and then session:

```text
⚠ Urgent (1)
  pi-guardrails · session "away-mode build" · 02:14
    Tried to upload .env to an unknown server. Run stopped.

Waiting for you (3)
  pi-guardrails · session "away-mode build" · paused
    sudo apt install ripgrep                       [approve] [reject]
  dashfit-api · session "migrations" · running
    rm -rf ../shared-cache                         [approve] [reject]

Allowed while you were away (12)
  dashfit-api · rm -rf node_modules                [✓ fine] [✗ shouldn't have]
```

Sections:

1. **Urgent:** tripwire items.
2. **Waiting for you:** deferred items. Approve once, always allow (adds a
   rule), or reject.
3. **Allowed while you were away:** flagged items. Mark ✓ fine or ✗ shouldn't
   have run.

Each item opens to its card.

### Storage

- Folder: `~/.pi/agent/guardrails/inbox/`.
- The session that creates an item writes `<id>.item.json`: session id,
  session file, cwd, session name, tool call id, kind, action, flag reason,
  card, and time.
- A decision is written to a separate `<id>.decision.json`: approve, reject,
  fine or shouldn't have, who decided, and when.
- Every write goes to a temp file first and is then renamed, so a reader
  never sees a half-written file. Each file has one writer, so 10+ sessions
  can write at once without locks.
- Handled items are deleted after 14 days.

### Getting a decision to its session

- **Running or paused session:** it watches the folder (`fs.watch`, plus a
  poll every few seconds as a fallback) for decisions on its own items, then
  applies them as described under "Limit and pause".
- **Closed session:** the decision is kept. When the session is opened
  again, it applies any decisions it missed. The inbox shows the command to
  reopen the session.

Waiting items are also pi-live items, so the user can approve them from a
phone.

Each machine has its own inbox. A home server's items are reviewed on the
server.

Learning:

- ✓ and approvals are confirmed false alarms. ✗ and rejections are confirmed
  catches.
- After a repeated pattern (for example 5 approved package installs), the list
  suggests a standing permission. The user accepts or ignores it.

## Standing permissions

Plain-language rules the user writes, for example:

```text
When I'm away, it's fine to:
- install well-known packages with brew, npm or pip if the task needs them
- delete anything inside the project folder or /tmp
- run docker containers, as long as they don't use --privileged
```

They are stored in config (`away.standingPermissions`) and passed to
delegates. Delegates use them as part of what the user wants. They don't
override the code checks in "Low risk", so `sudo` stays higher risk however
it's worded.

## What goes where

**This package (opt-in, written to upstream quality):**

- the `off`, `auto` and `always` modes, presence, the prompt time limit, and
  the away rules
- low-risk code checks
- repeats, tripwire, watch window, stuck detection, limit, pause and resume
- advisor hook
- the shared inbox, cards display, and standing permissions storage
- contract and event additions (below)
- optional: auto-allow `rm -rf` when every target is a literal path inside the
  project or the temp folder (AST-based, off by default)

**The user's reviewer extension (`~/.pi/agent/extensions/guardrails-reviewer.ts`):**

- the SubQ then Opus/Fable chain
- risk, severity and card output
- watch-window judgement ("is this the blocked thing in disguise?")
- the supervisor (advisor)
- context fixes:
  - count pi-link and other extension messages as user requests
  - drop the agent's own text
  - add recent tool calls (inputs only, no outputs)

## Contract changes

All changes are additions. With `away.mode: "off"` (the default), nothing
changes.

### Config

In `~/.pi/agent/extensions/guardrails.json`, or per project in
`.pi/extensions/guardrails.json`:

```jsonc
{
  "away": {
    "mode": "off",             // "off" | "auto" | "always"
    "promptTimeoutMs": 120000, // auto only
    "lowRisk": "allow",        // "allow" (run and flag) or "defer"
    "watchCommands": 10,       // 0 turns the watch window off
    "stuckBlocks": 3,
    "maxBlocks": 50,
    "standingPermissions": []  // plain-language strings
  }
}
```

`delegation.timeoutMs` is capped at 60s today. A strong model that reasons
through a command can take longer, so the cap goes up to 300s.

### Delegates

- `DelegateAnswer` gains optional `risk?: "low" | "high"`,
  `severe?: boolean` (only read on `block`), and `card?: Card`.
- `DelegationRequest` gains optional `watch?: { blocked: BlockedAction[] }`
  and `standingPermissions?: string[]`.
- `GuardrailsDelegate` gains optional `watch?: boolean`.
- New advisor hook, mirroring delegates: `guardrails:advisor:register` and
  `guardrails:advisor:request`. An advisor's `advise(situation, context)`
  returns `{ action: "advise", message }`, `{ action: "pause", reason }`, or
  `undefined`.

### Events

- `guardrails:presence:changed` `{ presence, cause }`
- `guardrails:away:item` with the item, whenever one is added or changes state
- `guardrails:tripwire` with the item
- `GuardrailsBlockSource` gains `"deferred"`
- `guardrails:prompt:closed` gains optional `by`

### pi-live

- Items get `expiresAt` when a prompt time limit is set.
- New close reason `by: "timeout"`.
- Views gain optional `card`.
- Waiting items from the inbox are published as items.

`docs/decision-delegation.md`, `docs/pi-live.md`, `README.md` and
`schema.json` get updated alongside the code.

## Build steps

Each step can ship alone.

1. **Modes, presence, time limit, away rules.** Ends the overnight hang.
   Includes `away.mode`, print and JSON runs counting as away, the deferred
   message, `risk` on delegate answers, the low-risk code checks, writing
   items to the shared inbox folder, and the pi-live `expiresAt` and
   `timeout`.
2. **Inbox, repeats, tripwire, stuck, limit, pause and resume.** Includes
   `/guardrails:inbox` across sessions, getting decisions to running and
   closed sessions, and the advisor hook with the built-in fallback message.
3. **Reviewer upgrade (local) and watch window (core).** The two-tier
   reviewer, risk, severity, cards, the supervisor, and the context fixes.
4. **Cards and learning in the inbox.** Cards on items, ✓ and ✗, standing
   permissions and suggestions, and the optional safe `rm -rf` rule.

## Later

- Shared presence across sessions, so only one session pays the 2-minute
  wait.
- One inbox across machines (laptop and home server).
- Phone notification for tripwires, through pi-live or Herdr.
