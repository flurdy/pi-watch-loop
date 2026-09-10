# Protocol v1 and lifecycle contract

Generic protocol-v1 Pi extension for running one fixed or adaptive watch loop inside one live interactive session. It injects bounded, single-flight tick prompts only while Pi is idle and requires each tick to finish with a matching `watch_loop complete` call.

The extension contains no workflow-specific logic. Watch skills supply the label, self-contained tick prompt, cadence, missed-completion policy, and stopping bounds.

## Runtime contract

`watch_loop` supports four actions:

- `status` — report protocol version and current state; does not terminate the turn.
- `start` — arm one watcher; requires `protocolVersion: 1` and terminates the initiating turn.
- `complete` — continue or stop the running generation; requires matching protocol version, watch ID, and generation, and terminates the tick.
- `stop` — model-facing terminal stop with the same matching tokens.

Only one watcher may be `armed`, `running`, or `paused`. A stopped watcher may be replaced by a new start.

### Start fields

| Field | Requirement |
|---|---|
| `label` | Short status label. |
| `tickPrompt` | Self-contained instructions for one tick. Tell the model to load the target skill by name, render visible output, and complete the protocol. |
| `mode` | `fixed` or `adaptive`. |
| `initialDelaySeconds` | Required; clamped to 60–3600 seconds. |
| `intervalSeconds` | Required only for fixed mode; clamped to 60–3600 seconds. |
| `missedCompletionPolicy` | `retry` for read-only watches or `pause` for attended/production-adjacent watches. |
| `stopAt` | Optional ISO-8601 deadline. |
| `maxTicks` | Optional positive tick budget. |
| `allowIndefinite` | Must be exactly `true` when neither deadline nor budget is supplied. |

Example fixed start:

```text
watch_loop start:
  protocolVersion = 1
  label = PRs
  tickPrompt = Load and follow the `pr-status` skill now. Render the full dashboard, then finish with the matching watch_loop complete call.
  mode = fixed
  initialDelaySeconds = 60
  intervalSeconds = 300
  missedCompletionPolicy = retry
  stopAt = 2026-07-30T17:00:00Z
```

Every injected prompt includes the watcher ID, protocol version, and current generation. A continuation must finish with:

```text
watch_loop complete:
  protocolVersion = 1
  watchId = <injected watcher ID>
  generation = <injected generation>
  outcome = continue
  delaySeconds = <required only for adaptive mode>
```

Use `outcome = stop` with an optional reason for a goal-terminating tick.

## State and scheduling

- `idle` — no watcher has started.
- `armed` — one timer or coalesced due marker exists.
- `running` — one injected generation owns the active tick.
- `paused` — policy stopped scheduling but retained the watcher for `/watch-resume` or `/watch-stop`.
- `stopped` — terminal until another start.

Fixed cadence is measured from successful completion, not previous dispatch. Adaptive completions select the next delay. Timer expiry while Pi is busy records one due marker; the next `agent_settled` dispatches it once. Laptop suspend never replays missed intervals.

The retry policy uses bounded exponential backoff and pauses on the third consecutive missed completion. The pause policy pauses on the first miss. Successful completion resets the miss count. Missing adaptive delay is a protocol miss, not a hot-loop fallback. Prompt-injection failure pauses immediately without leaving a tick timer armed; only an existing safety deadline remains enforceable.

Deadline evaluation wins over overdue dispatch. Deadline and tick budget are checked before scheduling and immediately before dispatch. A separate deadline timer remains active while armed, running, or paused so expiry stops the watcher and invalidates any running generation.

## Commands and status

- `/watch-status` — protocol, state, mode, next run/due state, tick count, misses, reason, deadline/budget/indefinite bound.
- `/watch-stop` — stop locally and invalidate a running generation.
- `/watch-resume` — resume a paused watcher with one immediate generation.

TUI mode also shows a compact footer status such as `watch: PRs · 2m`, `watch: PRs · running`, or `watch: PRs · paused`.

Set `PI_WATCH_LOOP_DISABLED=1` before starting Pi to refuse new watches while preserving status and stop access.

## Lifecycle and cost boundary

V1 is memory-only:

- no `appendEntry` records;
- no restore or re-arm after `/reload`, `/new`, `/resume`, `/fork`, `/clone`, tree navigation, or process restart;
- successful tree navigation stops the current watcher before work can continue on another conversation branch;
- `session_shutdown` clears timers and due markers;
- uninstalling needs no state migration or cleanup.

Ticks remain ordinary agent turns and consume model quota while adding messages to the session. Keep tick prompts and dashboards terse and use a deadline or budget unless an intentional process-lifetime watch explicitly opts into indefinite mode.

## Pi 0.82.1 behavior spike

Recorded on 2026-07-30 with a temporary `pi -e` extension in a real TUI. Throwaway spike code was not retained.

1. **Extension-origin `/skill:` does not expand.** `sendUserMessage("/skill:watch-loop-spike")` reached `before_agent_start` unchanged. The production protocol therefore uses the tested fallback: `Load and follow the skill named ... now.` With `read` active, the model loaded the named `SKILL.md` and followed it.
2. **Terminating completion preserves visible text.** Text emitted immediately before a `terminate: true` completion remained in the assistant message and TUI transcript.
3. **Settlement follows terminating completion.** `tool_execution_end` for the terminating completion occurred before `agent_settled`; no extra assistant turn was generated.
4. **Attended questions block the tick.** The real `ask_user_question` tool stayed open for one second with no `agent_settled`; settlement occurred only after the answer and final completion.
5. **Busy expiry coalesces safely.** A timer expired during that question, recorded one due marker, and dispatched exactly one follow-up after the first tick settled. Re-observing the stale timer produced no duplicate.
6. **Non-TUI start is inert.** A real print-mode start probe was rejected with `mode = print` and `timerActive = false`. Fake-host tests cover RPC and JSON refusal as well.

These observations replace the architecture plan's proposed `/skill:` injection format with the natural-language skill-loading boundary.

## Compatibility evidence

The historical Pi 0.82.1 spike above remains evidence for the original protocol decisions; it is not
current compatibility proof. Automated reducer and fake-host tests cover transitions and adapter
semantics. Current distribution changes additionally require:

```bash
npm run check
npm run verify:git-install
```

`check` runs the 33 protocol/adapter tests, typechecking against the pinned development Pi version,
and the exact npm-package allowlist. `verify:git-install` requires a clean committed tree and installs
that immutable commit through an isolated localhost Git server and Pi agent directory; it proves one
copy of each extension command loads and `/watch-status` reports protocol 1 idle state.

A focused real-TUI smoke is required for timer-originated prompt delivery and visible completion
ordering, because RPC and fake-host tests cannot prove those terminal lifecycle boundaries. Keep raw
smoke output under ignored `.artifacts/`; retain only the Pi version, commit, observed protocol states,
and duplicate-dispatch count when recording durable evidence.

**Current-Pi smoke:** On 2026-09-09, Pi 0.85.0 loaded immutable Git package commit
`eaeebd6f10623d90637d7b174564f97fbab46810`. `/watch-status` reported protocol 1 idle; a fixed watch
bounded to one tick armed for the real 60-second minimum, injected generation 1 once, preserved one
visible dashboard line before terminating completion, and stopped with `Ticks: 1/1` and zero misses.
A following status remained stopped; no duplicate prompt dispatch was observed.

## Installation and rollback

See the repository [README](../README.md) for immutable Git and local-checkout installation. Roll back
by stopping the active watch, removing the installed package or local extension symlink, and reloading
Pi. No watcher survives reload, so protocol v1 needs no persisted-state migration.
