# Away mode

Status: built. Opt-in: with `away.mode: "off"` (the default), Guardrails
behaves exactly as it did before away mode existed.

## Problem

Guardrails can wait for a human forever. A flagged command opens a prompt
and the agent stops until someone answers. That is fine at the keyboard and
bad for long or overnight runs.

In practice, most delegated decisions end as `ask`, which opens a prompt,
and many flagged commands are routine cleanup of the agent's own files. A
prompt that nobody sees can hold a run for hours.

## Goal

Every Guardrails decision ends within a set time. When the user is away, a
decision ends in allow or block, never "wait".

Non-goals:

- Replacing a sandbox. A model reviewer misses things. A sandbox is still the
  real backstop.
- Changing behavior for users who don't turn this on. Away mode is off by
  default (`away.mode: "off"`).

## How it works

```text
Flagged command (dangerous pattern, or outside path)
  → fast reviewer decides?       yes → done
  → stronger reviewer decides?   yes → done
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
- After any block, the next `away.watchCommands` (10) commands are also
  reviewed, to catch the same action done another way.
- If the agent is stuck (3 blocks with nothing done in between), a
  supervisor model guides it or pauses it.
- After `away.maxBlocks` (50) blocks, the run pauses.
- Every item goes into one inbox shared by all sessions on the machine. In
  the morning the user works through it, and each agent picks up from where
  it stopped.

Modes (`away.mode`):

| mode | for | behavior |
|---|---|---|
| `off` | default | today's behavior; prompts wait for an answer |
| `auto` | a laptop | prompts wait 2 minutes, then the user counts as away |
| `always` | a home server | never prompts; the away rules always apply |

In `auto` and `always`, runs without a terminal UI (print and JSON mode)
count as away. In `off`, they keep today's behavior and block flagged
actions.

Away mode applies to both gates: dangerous commands (permission-gate) and
paths outside the workspace (path-access). The permission-gate asks about
bash and PowerShell commands. The path-access gate handles file tools and the
paths a bash command touches.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Track presence (present or away) instead of only adding a timeout. | With only a timeout, every prompt in the night costs the full wait. With presence, only the first one does. |
| D2 | A prompt waits 2 minutes, then the user counts as away. | The user's choice. Long enough to notice a prompt, short enough to lose little time. |
| D3 | The command that times out follows the away rules. It is not denied outright. | It already has both reviews. Treat it like any command that arrives while away. |
| D4 | The models report facts: what the command does, risk, and whether it seems wanted. Guardrails code applies presence and policy. | The same answer can be reused when a prompt times out. Policy stays in reviewable code, not in a prompt. |
| D5 | Order: fast reviewer, then stronger reviewer, then the user. | Fewer prompts, and every prompt shows the strong model's explanation. Token cost is acceptable. |
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
| D18 | The user writes standing permissions in plain words. The inbox suggests new ones. | The list shrinks each week. This is what scales to more agents. |
| D19 | Core behavior goes in this package (opt-in). Models and prompts go in your own delegate/advisor extension. | Model choices are personal and change often. The core stays model-agnostic. |
| D20 | One inbox for all sessions on a machine. | The user runs 10+ sessions at once and can't track them one by one. |
| D21 | One setting, `away.mode: off / auto / always`, in `guardrails.json`. | One value can't form an invalid combination. Same file, schema and settings screen as every other Guardrails setting. |
| D22 | In `auto` and `always`, print and JSON runs count as away. | Nobody can answer a prompt there. |
| D23 | Messages sent through RPC don't count as presence. | Guardrails can't tell a script from a person. A script must not be able to cancel away mode. |
| D24 | Each session tracks presence on its own. | Simple. The cost is one 2-minute wait per session, which the user accepted. |
| D25 | Urgent (tripwire) items offer only "approve once" and "reject", never "always allow". | One keypress must not turn a severe item into a permanent rule. |
| D26 | A non-severe denial writes no inbox item. | The agent is told, and the `[guardrails]` session entry records it. A denial is not waiting for anyone. |

## Presence

Each Pi session tracks whether the user is present or away (D24). In `auto`
it starts as present, or as away in print and JSON mode. In `always` it is
always away and nothing changes it.

| Change | Cause |
|---|---|
| present → away | A prompt reaches its time limit; or the user runs `/guardrails:away` |
| away → present | Any key pressed in the terminal (`ctx.ui.onTerminalInput`); a message the user typed (`input` event with `source: "interactive"`); or an answer from a pi-live client |

In `always`, nothing changes presence (the user is always away). A message the
user types still clears a pause (see "Limit and pause").

Messages from other extensions (`source: "extension"`, such as pi-link) don't
count as presence. They come from agents, not the user. Messages sent through
RPC (`source: "rpc"`) don't count either (D23).

When the user returns, the stuck and limit counters reset, and a paused run
resumes. Items on the list stay until the user handles them. In `auto`, any
key press or typed message makes the user present, which resumes a paused
run. When presence doesn't change (the user was already present, or the mode
is `always`), a typed message still clears a pause, but a key press alone
doesn't.

## Prompt time limit

- The prompt has a deadline (`away.promptTimeoutMs`, default 120000).
- The terminal prompt shows the time left next to its title. The pi-live
  item gets `expiresAt`, so clients can show a countdown.
- On timeout the prompt closes with `by: "timeout"`, the session becomes away,
  and the away rules run with the delegates' answers already collected.
- If one tool call had several prompts queued (several outside paths), the
  rest skip their prompts and go straight to the away rules.
- The RPC fallback (a plain select dialog) gets the same deadline.
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
- A write outside the system temp folder is never low risk. A bash command
  counts as a write, because it can write.
- If no delegate reported a risk, the action is not low risk.
- If any delegate reported high risk, the action is not low risk.

The checks see through wrappers (`env sudo ...`, `xargs sudo`, `/usr/bin/sudo`)
and parse the string passed to `sh -c` or `eval` (three levels deep). Anything
they can't parse counts as not low risk. This can over-match, which only ever
defers an action and never allows one.

### Messages to the agent

Deferred:

> Queued for the user's approval; the user is away. Don't retry this or do
> the same thing another way. Continue with other work, and list this under
> "needs approval" in your final summary.

Denied:

> Blocked: <reviewer's reason>. Don't do this, and don't do the same thing
> another way.

Repeat:

> Already queued for the user's approval. Don't retry it; continue with other
> work.

> Already denied. Don't retry it or do the same thing another way.

## Repeats

Guardrails remembers each deferred or denied action for the session:

- Commands: the command text with whitespace normalized.
- Paths: the absolute path.

A later request for the same action is blocked at once with the repeat
message, without running delegates. A repeat doesn't count toward stuck. It
does count toward the 50-block limit. A repeat also refills the watch window,
and it adds no new entry to the blocked list.

When a decision arrives for an item, the memory changes: an approval removes
it (the exact action may run once), and a rejection makes it denied.

## Tripwire

A delegate can mark a `block` answer as severe. Severe means high impact and
clearly outside the user's request, sending data off the machine, or gaining
admin rights without being asked to.

On a severe block, Guardrails:

1. Blocks the call with `terminate: true`, so the turn ends after the current
   batch.
2. Records the item and emits `guardrails:tripwire`.
3. Pauses the run (the reason is "a severe action was blocked: ...").
4. Shows the item as urgent at the top of the inbox.

For v1, the event and the inbox entry are the only notification. Urgent items
offer "approve once" and "reject" only (D25).

This applies whether the user is present or away.

## Watch window

After any block (deferred, denied or repeat), the next `away.watchCommands`
(10) `bash` or `powershell` commands go to delegates even if nothing flagged
them. Commands that are flagged anyway also use up the window, and the
delegates that opt in get the `watch` field on those requests too.

- Only delegates that opt in (`watch: true`) receive these.
- The request carries `watch: { blocked: [...] }`, the actions blocked so far
  this session, and asks whether the new command does the same thing.
- For a watched command, only `block` has an effect. `allow`, `ask`, abstain,
  a timeout or an error all let it run, because nothing flagged it. A watched
  command never opens a prompt or gets deferred.
- A `block` here is treated as a denial and also counts toward the tripwire
  rules.

A command that `permissionGate.allowSafeCleanup` exempts (see below) counts as
unflagged, so it goes through the window like any other unflagged command.

Known gap: an agent could retry after the window closes. The deferred message
removes most of the reason to do that.

## Stuck and the supervisor

**Progress:** a `bash`, `powershell`, `edit` or `write` call that runs and
isn't blocked, whatever its exit code. Reads don't count.

**Stuck:** 3 blocks (deferred or denied) with no progress between them.

When stuck, Guardrails asks the registered advisors (see the contract
changes). An advisor receives the blocked list, the count of blocks since the
user left, and the standing permissions; through its `context` it can read the
session to see the user's requests and the agent's recent tool calls. It
answers with one of:

- `advise`: a message added to the block reason ("Supervisor: <message>").
- `pause`: pause the run.

If any advisor pauses, the run pauses. Otherwise the advice messages are
joined. If no advisor is registered, or none answers in time, Guardrails adds
a built-in message to the block reason ("Several actions in a row need the
user's approval. Continue with work that doesn't need them, or wrap up with a
summary of what is waiting."). If the agent gets stuck again before making
progress, Guardrails pauses the run.

The advisor can't allow anything (D16).

## Limit and pause

- `away.maxBlocks` (50) blocks since the user left pauses the run.
- Pausing blocks the current call with `terminate: true` and tells the agent
  to stop and summarize what it did and what is waiting for approval.
- While paused, every tool call is blocked ("Guardrails paused this run until
  the user returns. Stop and summarize."), for all tools, not just the gated
  ones.
- A paused run shows as blocked in Herdr (`herdr:blocked`), and the status
  line says `paused · <n> waiting`.

Resume:

- The user comes back (see "Presence"), or a decision is applied that sends
  the agent a message. Either lifts the pause and restarts the stuck and
  limit counters.
- Approving a waiting item (in the inbox or from pi-live) grants that exact
  action once.
- Guardrails then sends the agent "Guardrails: the user approved this action.
  You can run it now: <action>". If the agent is idle, the message starts a
  turn; if it is running, the message is queued as a follow-up.
- Rejecting an item sends "Guardrails: the user rejected this action. Don't
  do it, or the same thing another way: <action>" the same way.
- "Fine" and "shouldn't have run" send nothing.
- See "Shared inbox" for how a decision reaches a session that is running
  elsewhere or has closed.

## Cards

Each item can get a plain-language card, shown on the prompt, in the inbox and
to pi-live clients:

```text
What it wants to do   one or two sentences
Why it was stopped    the flag, in plain words
Step by step          each part of the command, with its meaning
Risk                  low or higher, and why
Worth knowing         one thing the user can learn from it (optional)
Category              a short label such as "delete build output" (optional)
```

The delegate that judges the command writes the card in the same call, so it
costs no extra time. Without a card, the raw command and the flag reason are
shown, as today. The category groups similar actions for standing-permission
suggestions.

## Shared inbox: `/guardrails:inbox`

One inbox per machine, shared by every Pi session on it (D20). Running
`/guardrails:inbox` in any session shows every item from every session. Each
row shows the project, session, the session's state (`running`, `idle`,
`paused` or `closed`), the time and the action, in sections like these:

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

1. **Urgent:** tripwire items. Approve once (`a`) or reject (`r`).
2. **Waiting for you:** deferred items. Approve once (`a`), always allow
   (`A`, saves a rule to your global config), or reject (`r`).
3. **Allowed while you were away:** flagged items. Mark fine (`f`) or
   shouldn't have run (`w`).

`Enter` opens an item's card (the plain-language card first, then the raw
command or path, the flag reason and the reviewers' reason). For a closed
session the card shows the `pi --session <file>` command to reopen it. A
footer counts the items handled in the last 24 hours. Without a terminal UI
(RPC), the command falls back to select dialogs: pick an item, then an
action.

If two people decide the same item at once, the first decision wins and the
other gets "Already decided." "Always allow" saves the rule first, and the
decision is written only if the save worked. The status line shows
`away · <n> waiting` or `paused · <n> waiting`, and just `<n> waiting` when
you are present and something is open.

### Storage

- Folder: `guardrails/inbox/` inside the Pi agent directory.
- The session that creates an item writes `<id>.item.json`: session id,
  session file, cwd, session name, tool call id, kind (`waiting`, `allowed` or
  `urgent`), cause (`away`, `timeout`, `headless` or `tripwire`), action, flag
  reason, reviewers' reason, risk, card, and time.
- A decision is written to a separate `<id>.decision.json`: approve,
  approve-always, reject, fine or wrong, who decided (the inbox or a pi-live
  client), and when. The first decision wins.
- Each running session also writes a small status file in
  `guardrails/sessions/`, so the inbox can show whether a session is running,
  idle or paused.
- Every write goes to a temp file first and is then renamed, so a reader
  never sees a half-written file. Each file has one writer, so 10+ sessions
  can write at once without locks.
- Handled items are deleted after 14 days.

### Getting a decision to its session

- **Running or paused session:** it watches the folder (`fs.watch`, plus a
  poll every 5 seconds as a fallback) for decisions on its own items, then
  applies them as described under "Limit and pause". Each session only
  applies decisions for its own items, and records what it applied in the
  session, so nothing is applied twice.
- **Closed session:** the decision is kept. When the session is opened
  again, it applies any decisions it missed and tells the agent on its next
  turn. The inbox shows the command to reopen the session.

Waiting and urgent items are also pi-live items (kind `guardrails.inbox`), so
the user can approve them from a phone. An answer from a client is written as
a decision, counts as the user being present, and closes the item everywhere.

Each machine has its own inbox. A home server's items are reviewed on the
server.

Learning:

- ✓ and approvals are confirmed false alarms. ✗ and rejections are confirmed
  catches.
- After you decide an item from `/guardrails:inbox` (not pi-live) and a
  category has 5 approvals or "fine" marks in the last 14 days, Guardrails asks
  `Add standing permission: "<category>"?` once the inbox closes. Yes adds it
  to the global `away.standingPermissions`. A "no", or a category that is
  already a standing permission, is not asked about again in that session.

## Standing permissions

Plain-language rules the user writes, for example:

```text
When I'm away, it's fine to:
- install well-known packages with brew, npm or pip if the task needs them
- delete anything inside the project folder or /tmp
- run docker containers, as long as they don't use --privileged
```

They are stored in config (`away.standingPermissions`) and passed to
delegates and advisors. Delegates use them as part of what the user wants. They don't
override the code checks in "Low risk", so `sudo` stays higher risk however
it's worded.

## What goes where

**This package (opt-in):**

- the `off`, `auto` and `always` modes, presence, the prompt time limit, and
  the away rules
- low-risk code checks
- repeats, tripwire, watch window, stuck detection, limit, pause and resume
- the advisor hook
- the shared inbox, `/guardrails:inbox`, cards display, standing permissions
  storage and suggestions
- contract and event additions (below)
- an optional safe-cleanup rule (below)

**Your own delegate/advisor extension:**

- the models and prompts: which reviewers run, in what order, and what they
  are asked
- risk, severity and card output
- watch-window judgement ("is this the blocked thing in disguise?")
- the supervisor (an advisor)
- the context it gives the models: for example, count messages from other
  extensions as user requests, leave out the agent's own prose, and include
  recent tool-call inputs (not outputs)

Delegates read what the models need from `context.sessionManager`; Guardrails
doesn't prescribe a model. `examples/delegates/classifier.ts` and
`examples/advisors/nudge.ts` are starting points.

### Safe cleanup (optional)

`permissionGate.allowSafeCleanup` (default `false`). When `true`, a command
that is made only of `rm -rf` on known build or cache directories, with plain
relative paths strictly inside the working directory, is not flagged. For
example `rm -rf node_modules dist`. The check is conservative. Every command
in the line must be such an `rm`, and any of these makes it false: another
command, a redirect, a variable or substitution, a glob, `~`, a `..` or `.git`
segment, an absolute path, an unknown flag, a symlink that leaves the working
directory, or anything the parser can't read with certainty. It lifts only
the built-in `rm -rf` detection: a pattern you added yourself still flags the
command. It works with or without away mode.

## Contract changes

All changes are additions. With `away.mode: "off"` (the default), nothing
changes.

### Config

In the global `extensions/guardrails.json` in the Pi agent directory, or per
project in `.pi/extensions/guardrails.json`:

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
  },
  "permissionGate": { "allowSafeCleanup": false }
}
```

`delegation.timeoutMs` used to be capped at 60s. A strong model that reasons
through a command can take longer, so the cap is now 300s (the default stays
10s). Set it to something like `120000` when a delegate calls a strong model.

### Delegates

- `DelegateAnswer` gains optional `risk?: "low" | "high"`,
  `severe?: boolean` (only read on `block`), and `card?: GuardrailsCard`.
- `DelegationRequest` gains optional `watch?: { blocked: BlockedAction[] }`
  and `standingPermissions?: string[]`.
- `GuardrailsDelegate` gains optional `watch?: boolean`.
- New advisor hook, mirroring delegates: `guardrails:advisor:register` and
  `guardrails:advisor:request`. An advisor's `advise(situation, context)`
  returns `{ action: "advise", message }`, `{ action: "pause", reason }`, or
  `undefined`.

### Events

- `guardrails:presence:changed` `{ presence, cause }`, with cause `timeout`,
  `command`, `keypress`, `input` or `client`
- `guardrails:away:item` `{ item, decision? }`, when an item is written (no
  decision) and again when its decision is applied (with the decision)
- `guardrails:away:paused` `{ paused, reason? }`
- `guardrails:tripwire` `{ item }`
- `guardrails:advisor:register` and `guardrails:advisor:request`
- `GuardrailsBlockSource` gains `"deferred"`, `"repeat"` and `"paused"`
- `guardrails:prompt:closed` gains optional `by`, set only in away modes

### pi-live

- Items get `expiresAt` when a prompt time limit is set.
- New close reasons `by: "timeout"` and `by: "shutdown"`.
- Views gain optional `card`.
- Waiting and urgent items from the inbox are published as items, with kind
  `guardrails.inbox`.

See also `docs/decision-delegation.md` (delegates and advisors),
`docs/pi-live.md` and `README.md`.

## Later

- Show non-severe denials in the inbox.
- Use the command-argument read/write classification in the path-access
  floor: today any bash call counts as a write, so a `cat /outside/file` run
  through bash is always deferred while away.
- Shared presence across sessions, so only one session pays the 2-minute
  wait.
- One inbox across machines (laptop and home server).
- Phone notification for tripwires, through pi-live or Herdr.
