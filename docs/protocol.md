# Protocol v1 and lifecycle contract

Generic protocol-v1 Pi extension for running one fixed or adaptive watch loop inside one live interactive session. It injects bounded, single-flight tick prompts only while Pi is idle and requires each tick to finish with a matching `watch_loop complete` call.

The extension contains no workflow-specific logic. Watch skills supply the label, self-contained tick prompt, cadence, missed-completion policy, and stopping bounds.

## Runtime contract

`watch_loop` supports four actions:

- `status` — report protocol version and current state; does not terminate the turn.
- `start` — arm one watcher; requires `protocolVersion: 1` and terminates the initiating turn.
- `complete` — continue or stop the running generation; requires matching protocol version, watch ID, and generation, and terminates the tick.
- `stop` — model-facing terminal stop of the active watcher. Requires `protocolVersion: 1` and its `watchId` from status or the tick prompt. `generation` is also required, and must match, only while a tick is running; armed and paused watchers have no in-flight tick, so it is ignored there. Stop terminates the turn. Idle or stopped state rejects with no active watch.

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

- `/watch-status` — protocol, state, mode, next run/due state, tick count, misses, reason, deadline/budget/indefinite bound, context advice threshold, and current estimated context usage.
- `/watch-stop` — stop locally and invalidate a running generation.
- `/watch-resume` — resume a paused watcher with one immediate generation.

Routine successful tool completions render one compact line in the TUI, for example
`watch · PR feedback · 15:12 · next 30m · tick 5`. The timestamp is the result's local 24-hour
creation time (completion time for tick results), captured once and retained in scrollback.
The delay is a snapshot of the schedule at completion, not a live countdown. Long labels truncate to fit narrow panes. Expand with Ctrl+O for the full
arguments and result; `/watch-status` still reports full current status. Errors, paused/stopped
states, and delay-clamping notices remain detailed even when collapsed. Model-facing text and
protocol tokens are unchanged; older results without summary metadata retain their full display.

TUI mode also shows a compact footer status such as `watch: PRs · 2m`, `watch: PRs · running`, or `watch: PRs · paused`.

Set `PI_WATCH_LOOP_DISABLED=1` before starting Pi to refuse new watches while preserving status and stop access.

## Context advice

Every tick adds its dashboard and tool output to the session, while Pi auto-compacts only near the
full context window (`contextTokens > contextWindow - reserveTokens`). After each `agent_settled`
while a watch is armed, running, or paused, the extension reads `ctx.getContextUsage()` and shows a
non-blocking TUI notification suggesting `/compact` while Pi is idle once usage reaches the threshold.

- `PI_WATCH_LOOP_CONTEXT_PERCENT` sets the threshold before Pi starts: an integer from 1 to 99.
  Unset or invalid values use 40; `0` or `off` disables advice.
- Advice repeats only for each further 10-point band, such as 40%, 50%, and 60%, per watch.
  A lower reading, for example after compaction or a larger-window model, re-arms lower bands.
- Unknown usage, such as immediately after compaction, stays silent. No watch means no advice.
- Advice adds no model turn and never changes tick prompts, tool results, the footer, or protocol-v1
  tokens. Advice itself never compacts; see [automatic watch compaction](#automatic-watch-compaction).

Pi's `compaction.reserveTokens` setting can trigger automatic compaction earlier, but it applies to
every session rather than only watched ones.

## Automatic watch compaction

Off by default. Set `PI_WATCH_LOOP_AUTO_COMPACT=1` before starting Pi to let a watch compact the
session between ticks. `PI_WATCH_LOOP_AUTO_COMPACT_PERCENT` sets the threshold: an integer from 21
to 99; unset or invalid values use 70. It is independent of the advice threshold.

- **Only between ticks.** After `agent_settled`, the watch must be armed with no due tick, Pi must be
  idle with no queued messages, and known usage must be at or above the threshold. A settlement that
  dispatches a due tick, a running tick, and a paused or stopped watch never compact. Paused
  watches still get advice.
- **Deferred start.** Compaction starts one second after the latest settlement, after prompts that
  extensions queued during `agent_settled` have begun. Each settlement restarts that delay, and
  every condition is checked again for the same watch when it ends; if the watch is no longer
  eligible, the usual advice appears instead. It calls Pi's `ctx.compact()`, the same path as
  `/compact`, so Pi's compaction settings and `session_before_compact` hooks apply. Its model cost
  is that of an ordinary `/compact`, usually one or more summarization requests.
- **One attempt per crossing.** Starting an attempt latches the watch. Only a later known reading
  below the reset level, 20 points under the threshold (50% for the default 70%), clears it.
  Unknown usage, such as right after compaction, keeps it. A failure or still-high usage therefore
  causes no retry loop; use `/compact` to retry sooner. A new watch starts unlatched.
- **Notifications.** TUI notifications report the start and success as info and a failure as a
  warning. A failure never stops or pauses the watch.
- **Summary instructions.** The summary keeps the user's goals, ongoing work, decisions, open
  questions and tasks unrelated to the watch. It collapses repeated tick prompts, dashboards and
  `watch_loop` calls into the watch's current state, and records its label, watch ID, schedule and
  next tick time, tick budget or deadline, and last completion outcome and reason.
- **Due ticks.** A tick timer that expires during compaction records the usual due marker. When
  compaction ends, the one-second recheck described under [compaction](#compaction) dispatches it
  once Pi is idle; the completion callback starts that recheck again.
- **Status.** `/watch-status` reports `Auto-compaction: off`, or the threshold and reset level with
  `starting`, `compacting` or `waiting for context below N%`.

Pi's compaction aborts any active run first, so the extension starts it only while Pi reports idle.
A prompt submitted at that moment by the user or another extension can still overlap it: Pi rejects
extension prompts while compaction runs, and one already past that check could start alongside it.
The deferral and rechecks narrow this window; closing it would need host-side admission control.
The watch's own ticks cannot overlap, because tick dispatch and the start recheck share one state.

## Compaction

- **Manual `/compact` while armed or paused:** state, deadline, budget, and footer are unchanged.
  A tick timer that expires during compaction records the usual due marker. Because manual
  compaction emits no `agent_settled`, its successful or failed end rechecks that due tick once per
  second for up to ten seconds and dispatches it once Pi is idle. Otherwise the next `agent_settled`
  dispatches it as before.
- **Manual `/compact` during a running tick:** Pi aborts the current turn before compacting. The tick
  settles without `watch_loop complete` and follows the normal missed-completion policy.
- **Automatic threshold or overflow compaction:** Pi compacts inside the running agent run and emits
  one final `agent_settled`, so a tick continues and completes normally without a recorded miss.
- **Watch auto-compaction:** uses the manual path and reports reason `manual`, so the same
  due-tick recheck applies.

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

`check` runs the protocol, adapter, and rendering tests, typechecking against the pinned development Pi version,
and the exact npm-package allowlist. `verify:git-install` requires a clean committed tree and installs
that immutable commit through an isolated localhost Git server and Pi agent directory; it proves one
copy of each extension command loads and `/watch-status` reports protocol 1 idle state.

A focused real-TUI smoke is required for timer-originated prompt delivery and visible completion
ordering, because RPC and fake-host tests cannot prove those terminal lifecycle boundaries. Keep raw
smoke output under ignored `.artifacts/`; retain only the Pi version, commit, observed protocol states,
and duplicate-dispatch count when recording durable evidence.

**Current-Pi smoke:** On 2026-09-10 (02:30–02:33 UTC), Pi 0.85.0 loaded immutable Git package commit
`eaeebd6f10623d90637d7b174564f97fbab46810`. `watch_loop status` reported protocol 1 idle; a fixed watch
bounded to one tick armed for the real 60-second minimum, injected generation 1 once, preserved one
visible dashboard line before terminating completion, and stopped with `Ticks: 1/1` and zero misses.
A following status remained stopped; no duplicate prompt dispatch was observed.

**Context advice and compaction smoke:** On 2026-10-13, Pi 1.1.0 loaded commit
`6856ad31a936f3a40aefee4e30cf74f5cb70f926` as the only extension, with the advice threshold set to 1%.
`/watch-status` reported the threshold and current usage. A notification appeared once at 2% during
an armed watch; none appeared after the watch stopped. In a fixed 60-second watch, manual `/compact`
started 7 seconds before the tick. The footer changed to `due` at expiry. Compaction finished
24 seconds later; the tick dispatched within one second, then completed. Both watches stopped at
their tick budgets with zero misses. No duplicate dispatch was observed.

## Installation and rollback

See the repository [README](../README.md) for immutable Git and local-checkout installation. Roll back
by stopping the active watch, removing the installed package or local extension symlink, and reloading
Pi. No watcher survives reload, so protocol v1 needs no persisted-state migration.
