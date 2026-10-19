import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	WATCH_LOOP_PROTOCOL_VERSION,
	createIdleState,
	reduceWatchLoop,
	type CompletionOutcome,
	type WatchEvent,
	type WatchLoopState,
	type WatchOperationResult,
	type WatchStartConfig,
	type WatchTransition,
} from "./watch-loop.ts";

const STATUS_KEY = "pi-watch-loop";
const DEFAULT_CONTEXT_ADVICE_PERCENT = 40;
const CONTEXT_ADVICE_BAND_PERCENT = 10;
const COMPACTION_RECHECK_MILLISECONDS = 1_000;
const COMPACTION_RECHECKS = 10;
const DEFAULT_AUTO_COMPACT_PERCENT = 70;
const AUTO_COMPACT_RESET_POINTS = 20;
/** Lets prompts deferred during agent_settled start before compaction claims the idle session. */
const AUTO_COMPACT_START_MILLISECONDS = 1_000;
const MAX_INSTRUCTION_TEXT_LENGTH = 300;

const watchLoopParameters = Type.Object({
	action: StringEnum(["status", "start", "complete", "stop"] as const),
	protocolVersion: Type.Optional(Type.Integer()),
	watchId: Type.Optional(Type.String({ description: "Required for complete and stop; from the tick prompt or status" })),
	generation: Type.Optional(Type.Integer({ description: "Required for complete, and for stop only while a tick is running" })),
	label: Type.Optional(Type.String()),
	tickPrompt: Type.Optional(Type.String()),
	mode: Type.Optional(StringEnum(["fixed", "adaptive"] as const)),
	initialDelaySeconds: Type.Optional(Type.Number()),
	intervalSeconds: Type.Optional(Type.Number()),
	missedCompletionPolicy: Type.Optional(StringEnum(["pause", "retry"] as const)),
	stopAt: Type.Optional(Type.String()),
	maxTicks: Type.Optional(Type.Integer()),
	allowIndefinite: Type.Optional(Type.Boolean()),
	outcome: Type.Optional(StringEnum(["continue", "stop"] as const)),
	delaySeconds: Type.Optional(Type.Number()),
	reason: Type.Optional(Type.String()),
});

type WatchLoopParameters = Static<typeof watchLoopParameters>;

export interface WatchLoopControllerDependencies {
	now: () => number;
	setTimer: (callback: () => void, delayMilliseconds: number) => ReturnType<typeof setTimeout>;
	clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
	createWatchId: () => string;
	isDisabled: () => boolean;
	/** Percent at which compaction advice starts, or undefined when advice is off. */
	contextAdviceThreshold: () => number | undefined;
	/** Percent at which an armed watch compacts automatically, or undefined when not opted in. */
	autoCompactThreshold: () => number | undefined;
}

/** Unset or invalid values use the default; `0` or `off` disables advice. */
export function parseContextAdviceThreshold(value: string | undefined): number | undefined {
	const trimmed = value?.trim().toLowerCase() ?? "";
	if (trimmed === "0" || trimmed === "off") return undefined;
	if (!/^[0-9]{1,2}$/.test(trimmed)) return DEFAULT_CONTEXT_ADVICE_PERCENT;
	return Number(trimmed);
}

/** Off unless `enabled` is `1`; thresholds outside 21-99 use the default so the reset level stays positive. */
export function parseAutoCompactThreshold(enabled: string | undefined, percent: string | undefined): number | undefined {
	if (enabled?.trim() !== "1") return undefined;
	const trimmed = percent?.trim() ?? "";
	const value = /^[0-9]{2}$/.test(trimmed) ? Number(trimmed) : 0;
	return value > AUTO_COMPACT_RESET_POINTS ? value : DEFAULT_AUTO_COMPACT_PERCENT;
}

const defaultDependencies: WatchLoopControllerDependencies = {
	now: Date.now,
	setTimer: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
	clearTimer: (timer) => clearTimeout(timer),
	createWatchId: randomUUID,
	isDisabled: () => process.env.PI_WATCH_LOOP_DISABLED === "1",
	contextAdviceThreshold: () => parseContextAdviceThreshold(process.env.PI_WATCH_LOOP_CONTEXT_PERCENT),
	autoCompactThreshold: () =>
		parseAutoCompactThreshold(process.env.PI_WATCH_LOOP_AUTO_COMPACT, process.env.PI_WATCH_LOOP_AUTO_COMPACT_PERCENT),
};

function requiredNumber(value: number | undefined, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is required and must be numeric`);
	return value;
}

function requiredString(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required`);
	return value;
}

function parseStopAt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error("stopAt must be an ISO-8601 timestamp");
	return parsed;
}

function canDispatch(ctx: ExtensionContext): boolean {
	return ctx.isIdle() && !ctx.hasPendingMessages();
}

function knownContextPercent(ctx: ExtensionContext): number | undefined {
	const percent = ctx.getContextUsage()?.percent;
	return typeof percent === "number" && Number.isFinite(percent) ? percent : undefined;
}

function bounded(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > MAX_INSTRUCTION_TEXT_LENGTH ? `${singleLine.slice(0, MAX_INSTRUCTION_TEXT_LENGTH)}…` : singleLine;
}

interface CompletionRecord {
	watchId: string;
	outcome: CompletionOutcome;
	reason?: string;
}

/** Summary guidance for a watch-triggered compaction: keep the session, collapse repeated ticks. */
export function autoCompactionInstructions(state: WatchLoopState, lastCompletion: CompletionRecord | undefined): string {
	const watch = state.watch;
	if (!watch) return "";
	const schedule = [
		watch.mode === "fixed" ? `fixed, every ${watch.intervalSeconds}s from completion` : "adaptive, 60-3600s chosen by each tick",
		state.due ? "next tick due now" : state.nextRunAt === undefined ? undefined : `next tick at ${new Date(state.nextRunAt).toISOString()}`,
	];
	const budget = [
		`ticks ${state.tickCount} of ${watch.maxTicks ?? "unbounded"}`,
		watch.stopAt === undefined ? undefined : `deadline ${new Date(watch.stopAt).toISOString()}`,
		watch.allowIndefinite && watch.stopAt === undefined && watch.maxTicks === undefined ? "explicitly indefinite" : undefined,
	];
	const completion = lastCompletion?.watchId === watch.id ? lastCompletion : undefined;
	const outcome = completion
		? `${completion.outcome}${completion.reason ? ` (${bounded(completion.reason)})` : ""}`
		: bounded(state.lastReason ?? "none yet");
	return [
		"This session runs a pi-watch-loop watch whose repeated ticks fill much of the history.",
		"Summarize the rest of the session as you normally would: keep the user's goals, ongoing work, decisions, open questions and any tasks unrelated to the watch, even where watch output dominates.",
		"Collapse repeated watch tick prompts, dashboards and watch_loop calls into the watch's current state: its latest findings, notable changes across ticks and unresolved items. Earlier tick prompts and generation numbers need not be kept; each new tick prompt carries its own protocol tokens.",
		"Keep these watch details:",
		`- Label ${JSON.stringify(bounded(watch.label))}, watch ID ${watch.id}`,
		`- Schedule: ${schedule.filter(Boolean).join("; ")}`,
		`- Budget: ${budget.filter(Boolean).join("; ")}`,
		`- Last outcome: ${outcome}`,
	].join("\n");
}

function formatDuration(milliseconds: number): string {
	if (milliseconds <= 0) return "due";
	const seconds = Math.ceil(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.ceil(minutes / 60)}h`;
}

export function formatWatchStatus(state: WatchLoopState, now = Date.now()): string {
	const lines = [`Protocol: ${WATCH_LOOP_PROTOCOL_VERSION}`, `State: ${state.status}`];
	const watch = state.watch;
	if (!watch) return lines.join("\n");

	lines.push(`Watch: ${watch.label} (${watch.id})`, `Mode: ${watch.mode}`);
	if (state.status === "armed") {
		lines.push(state.due ? "Next run: due when Pi is idle" : `Next run: ${formatDuration((state.nextRunAt ?? now) - now)}`);
	} else if (state.status === "running") {
		lines.push(`Running generation: ${state.generation}`);
	} else if (state.status === "paused") {
		lines.push("Next run: paused until /watch-resume");
	}
	lines.push(
		`Ticks: ${state.tickCount}/${watch.maxTicks ?? "unbounded"}`,
		`Consecutive misses: ${state.consecutiveMisses}`,
	);
	if (watch.mode === "fixed") lines.push(`Interval: ${watch.intervalSeconds}s from completion`);
	else lines.push("Interval: adaptive (60-3600s)");
	if (watch.stopAt !== undefined) lines.push(`Deadline: ${new Date(watch.stopAt).toISOString()}`);
	if (watch.maxTicks !== undefined) lines.push(`Tick budget: ${watch.maxTicks}`);
	if (watch.allowIndefinite && watch.stopAt === undefined && watch.maxTicks === undefined) {
		lines.push("Bounds: explicitly indefinite for this Pi process");
	}
	if (state.lastReason) lines.push(`Last reason: ${state.lastReason}`);
	return lines.join("\n");
}

function formatContextStatus(ctx: ExtensionContext, threshold: number | undefined): string {
	const usage = ctx.getContextUsage();
	const percent = usage?.percent;
	return [
		`Context advice: ${threshold === undefined ? "off" : `from ${threshold}%`}`,
		typeof percent === "number" && usage
			? `Context: ${Math.floor(percent)}% of ${usage.contextWindow} tokens`
			: "Context: unknown",
	].join("\n");
}

function footerStatus(state: WatchLoopState, now: number): string | undefined {
	const label = state.watch?.label;
	if (!label || state.status === "idle" || state.status === "stopped") return undefined;
	if (state.status === "paused") return `watch: ${label} · paused`;
	if (state.status === "running") return `watch: ${label} · running`;
	if (state.due) return `watch: ${label} · due`;
	return `watch: ${label} · ${formatDuration((state.nextRunAt ?? now) - now)}`;
}

export class WatchLoopController {
	private currentState = createIdleState();
	private tickTimer: ReturnType<typeof setTimeout> | undefined;
	private tickTimerToken = 0;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private deadlineTimerToken = 0;
	private currentContext: ExtensionContext | undefined;
	private contextAdvice: { watchId: string; band: number } | undefined;
	private lastCompletion: CompletionRecord | undefined;
	/** Identifies the current attempt; session end advances it so older callbacks are ignored. */
	private autoCompactAttempt = 0;
	private autoCompactLatch: { watchId: string; latched: boolean } | undefined;
	private autoCompactStart: ReturnType<typeof setTimeout> | undefined;
	private autoCompactStartToken = 0;
	private autoCompactInFlight = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly dependencies: WatchLoopControllerDependencies,
	) {}

	get state(): WatchLoopState {
		return this.currentState;
	}

	bind(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		this.updateFooter(ctx);
	}

	transition(event: WatchEvent, ctx: ExtensionContext): WatchTransition {
		this.currentContext = ctx;
		const transition = reduceWatchLoop(this.currentState, event);
		this.apply(transition, ctx);
		if (event.type === "complete" && transition.result?.ok) {
			this.lastCompletion = { watchId: event.watchId, outcome: event.outcome, reason: event.reason };
		}
		return transition;
	}

	onAgentSettled(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		if (this.currentState.status === "running" || this.isDue()) {
			this.apply(
				reduceWatchLoop(this.currentState, {
					type: "agent_settled",
					now: this.dependencies.now(),
					canDispatch: canDispatch(ctx),
				}),
				ctx,
			);
		}
		if (this.considerAutoCompaction(ctx)) return;
		this.adviseContext(ctx);
	}

	/**
	 * Manual compaction keeps Pi busy without a following agent_settled event, so a tick that fell
	 * due meanwhile is rechecked briefly through the normal timer path once compaction can finish.
	 */
	onManualCompactionEnded(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		if (this.isDue()) this.scheduleTick(COMPACTION_RECHECK_MILLISECONDS, COMPACTION_RECHECKS - 1);
	}

	formatContextStatus(ctx: ExtensionContext): string {
		return [formatContextStatus(ctx, this.dependencies.contextAdviceThreshold()), this.formatAutoCompactionStatus()].join("\n");
	}

	private formatAutoCompactionStatus(): string {
		const threshold = this.dependencies.autoCompactThreshold();
		if (threshold === undefined) return "Auto-compaction: off";
		const reset = threshold - AUTO_COMPACT_RESET_POINTS;
		const latched = this.autoCompactLatch?.latched && this.autoCompactLatch.watchId === this.currentState.watch?.id;
		const phase = this.autoCompactInFlight
			? " (compacting)"
			: this.autoCompactStart
				? " (starting)"
				: latched
					? ` (waiting for context below ${reset}%)`
					: "";
		return `Auto-compaction: from ${threshold}%, re-arms below ${reset}%${phase}`;
	}

	/**
	 * Tracks the per-watch latch and (re)starts the deferred start delay for an eligible armed watch.
	 * Returns true while a start is pending or in flight, so advice does not repeat it.
	 */
	private considerAutoCompaction(ctx: ExtensionContext): boolean {
		const threshold = this.dependencies.autoCompactThreshold();
		const watch = this.currentState.watch;
		if (threshold === undefined || !watch) return false;
		if (this.autoCompactLatch?.watchId !== watch.id) this.autoCompactLatch = { watchId: watch.id, latched: false };
		const percent = knownContextPercent(ctx);
		if (percent !== undefined && percent < threshold - AUTO_COMPACT_RESET_POINTS) this.autoCompactLatch.latched = false;
		if (this.autoCompactInFlight) return true;
		this.cancelAutoCompactionStart();
		if (!this.canAutoCompact(ctx, threshold)) return false;
		const token = this.autoCompactStartToken;
		const watchId = watch.id;
		this.autoCompactStart = this.dependencies.setTimer(() => {
			if (token !== this.autoCompactStartToken) return;
			this.autoCompactStart = undefined;
			const current = this.currentContext;
			if (!this.startAutoCompaction(watchId) && current) this.adviseContext(current);
		}, AUTO_COMPACT_START_MILLISECONDS);
		return true;
	}

	private canAutoCompact(ctx: ExtensionContext, threshold: number): boolean {
		const { status, due, watch } = this.currentState;
		const percent = knownContextPercent(ctx);
		return (
			status === "armed" &&
			!due &&
			canDispatch(ctx) &&
			this.autoCompactLatch?.watchId === watch?.id &&
			!this.autoCompactLatch?.latched &&
			percent !== undefined &&
			percent >= threshold
		);
	}

	/** Rechecks eligibility for the watch that scheduled the start; returns whether compaction began. */
	private startAutoCompaction(watchId: string): boolean {
		const ctx = this.currentContext;
		const threshold = this.dependencies.autoCompactThreshold();
		const watch = this.currentState.watch;
		if (!ctx || threshold === undefined || watch?.id !== watchId || this.autoCompactInFlight || !this.canAutoCompact(ctx, threshold)) {
			return false;
		}
		const percent = Math.floor(knownContextPercent(ctx) ?? threshold);
		const reset = threshold - AUTO_COMPACT_RESET_POINTS;
		const attempt = ++this.autoCompactAttempt;
		const label = `Watch "${watch.label}"`;
		this.autoCompactLatch = { watchId: watch.id, latched: true };
		this.autoCompactInFlight = true;
		const finish = (message: string, level: "info" | "warning") => {
			if (attempt !== this.autoCompactAttempt || !this.autoCompactInFlight) return;
			this.autoCompactInFlight = false;
			const current = this.currentContext;
			if (!current) return;
			if (current.hasUI) current.ui.notify(message, level);
			this.onManualCompactionEnded(current);
		};
		const failed = (error: unknown) =>
			finish(
				`${label}: auto-compaction failed: ${bounded(error instanceof Error ? error.message : String(error))}. The watch continues; auto-compaction waits until context falls below ${reset}%. Use /compact to retry now.`,
				"warning",
			);
		if (ctx.hasUI) {
			ctx.ui.notify(
				`${label}: context ${percent}% reached auto-compaction at ${threshold}%. Compacting between ticks; the watch keeps its schedule.`,
				"info",
			);
		}
		try {
			ctx.compact({
				customInstructions: autoCompactionInstructions(this.currentState, this.lastCompletion),
				onComplete: () => finish(`${label}: auto-compaction finished; the watch keeps its schedule.`, "info"),
				onError: failed,
			});
		} catch (error) {
			failed(error);
		}
		return true;
	}

	private cancelAutoCompactionStart(): void {
		this.autoCompactStartToken += 1;
		if (this.autoCompactStart) this.dependencies.clearTimer(this.autoCompactStart);
		this.autoCompactStart = undefined;
	}

	private isDue(): boolean {
		return this.currentState.status === "armed" && this.currentState.due;
	}

	private adviseContext(ctx: ExtensionContext): void {
		const { status, watch } = this.currentState;
		const threshold = this.dependencies.contextAdviceThreshold();
		if (threshold === undefined || !watch || !["armed", "running", "paused"].includes(status)) return;
		const percent = knownContextPercent(ctx);
		if (percent === undefined) return;

		const band = percent >= threshold ? Math.floor((percent - threshold) / CONTEXT_ADVICE_BAND_PERCENT) : -1;
		const advisedBand = this.contextAdvice?.watchId === watch.id ? this.contextAdvice.band : -1;
		this.contextAdvice = { watchId: watch.id, band };
		if (band <= advisedBand || !ctx.hasUI) return;
		ctx.ui.notify(
			`Watch "${watch.label}": context ${Math.floor(percent)}% (advice from ${threshold}%). Consider /compact while Pi is idle; the watch keeps its schedule.`,
			"info",
		);
	}

	shutdown(ctx: ExtensionContext, reason = "session shutdown"): void {
		this.autoCompactAttempt += 1;
		this.cancelAutoCompactionStart();
		this.autoCompactInFlight = false;
		this.autoCompactLatch = undefined;
		this.lastCompletion = undefined;
		this.currentContext = ctx;
		this.apply(
			reduceWatchLoop(this.currentState, { type: "shutdown", now: this.dependencies.now(), reason }),
			ctx,
		);
		this.currentContext = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	private apply(transition: WatchTransition, ctx: ExtensionContext): void {
		this.currentState = transition.state;
		for (const effect of transition.effects) {
			switch (effect.type) {
				case "schedule":
					this.scheduleTick(effect.delayMilliseconds);
					break;
				case "schedule_deadline":
					this.scheduleDeadline(effect.delayMilliseconds);
					break;
				case "clear_timer":
					this.clearTimers();
					break;
				case "notify":
					if (ctx.hasUI) ctx.ui.notify(effect.message, effect.level);
					break;
				case "dispatch":
					try {
						this.pi.sendUserMessage(effect.prompt);
					} catch (error) {
						const reason = error instanceof Error ? error.message : "Pi rejected watch-loop prompt injection";
						this.apply(
							reduceWatchLoop(this.currentState, {
								type: "dispatch_failed",
								now: this.dependencies.now(),
								reason,
							}),
							ctx,
						);
					}
					break;
			}
		}
		this.updateFooter(ctx);
	}

	private scheduleTick(delayMilliseconds: number, rechecks = 0): void {
		this.clearTickTimer();
		const token = this.tickTimerToken;
		this.tickTimer = this.dependencies.setTimer(() => {
			if (token !== this.tickTimerToken) return;
			this.tickTimer = undefined;
			this.tickTimerToken += 1;
			const ctx = this.currentContext;
			if (!ctx) return;
			this.apply(
				reduceWatchLoop(this.currentState, {
					type: "timer_due",
					now: this.dependencies.now(),
					canDispatch: canDispatch(ctx),
				}),
				ctx,
			);
			if (rechecks > 0 && this.isDue()) this.scheduleTick(COMPACTION_RECHECK_MILLISECONDS, rechecks - 1);
		}, delayMilliseconds);
	}

	private scheduleDeadline(delayMilliseconds: number): void {
		this.clearDeadlineTimer();
		const token = this.deadlineTimerToken;
		this.deadlineTimer = this.dependencies.setTimer(() => {
			if (token !== this.deadlineTimerToken) return;
			this.deadlineTimer = undefined;
			this.deadlineTimerToken += 1;
			const ctx = this.currentContext;
			if (!ctx) return;
			this.apply(
				reduceWatchLoop(this.currentState, {
					type: "deadline_due",
					now: this.dependencies.now(),
				}),
				ctx,
			);
		}, delayMilliseconds);
	}

	private clearTickTimer(): void {
		this.tickTimerToken += 1;
		if (this.tickTimer) this.dependencies.clearTimer(this.tickTimer);
		this.tickTimer = undefined;
	}

	private clearDeadlineTimer(): void {
		this.deadlineTimerToken += 1;
		if (this.deadlineTimer) this.dependencies.clearTimer(this.deadlineTimer);
		this.deadlineTimer = undefined;
	}

	private clearTimers(): void {
		this.clearTickTimer();
		this.clearDeadlineTimer();
	}

	private updateFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_KEY, footerStatus(this.currentState, this.dependencies.now()));
	}
}

interface WatchToolDetails {
	protocolVersion: number;
	state: WatchLoopState;
	result?: WatchOperationResult;
	summary?: string;
}

function toolResult(result: WatchOperationResult, state: WatchLoopState, now: number) {
	const summary = state.status === "armed" && state.watch
		? `watch · ${state.watch.label.replace(/\s+/g, " ")} · ${new Date(now).toTimeString().slice(0, 5)} · next ${formatDuration((state.nextRunAt ?? now) - now)} · tick ${state.tickCount}`
		: undefined;
	return {
		content: [{ type: "text" as const, text: `${result.message}\n\n${formatWatchStatus(state, now)}` }],
		details: { protocolVersion: WATCH_LOOP_PROTOCOL_VERSION, result, state, summary },
		terminate: true,
	};
}

function statusResult(state: WatchLoopState) {
	return {
		content: [{ type: "text" as const, text: formatWatchStatus(state) }],
		details: { protocolVersion: WATCH_LOOP_PROTOCOL_VERSION, state },
	};
}

function throwIfRejected(transition: WatchTransition, previousState: WatchLoopState): void {
	if (transition.result?.ok !== false || transition.state !== previousState) return;
	throw new Error(transition.result.message);
}

export function registerWatchLoopExtension(
	pi: ExtensionAPI,
	dependencies: WatchLoopControllerDependencies = defaultDependencies,
): WatchLoopController {
	const controller = new WatchLoopController(pi, dependencies);

	pi.registerTool<typeof watchLoopParameters, WatchToolDetails>({
		name: "watch_loop",
		label: "Watch Loop",
		description:
			"Control one in-memory protocol-v1 fixed or adaptive watch loop in the current interactive Pi session. Delays are clamped to 60-3600 seconds. Output is bounded and state is never restored after reload or exit.",
		promptSnippet: "Start, complete, stop, or inspect one bounded in-session watch loop",
		promptGuidelines: [
			"Use watch_loop status before starting a watch and require protocol version 1.",
			"Use watch_loop start only with a self-contained tick prompt plus a deadline, tick budget, or allowIndefinite: true.",
			"During an injected watch tick, render the visible dashboard before finishing with matching watch_loop complete tokens.",
			"To stop a watch on request, read watch_loop status, then call stop with protocolVersion 1 and its watchId; generation is needed only while a tick is running. Stop ends the turn, so make it the last action.",
		],
		parameters: watchLoopParameters,
		executionMode: "sequential",
		renderCall(args, theme, ctx) {
			if (ctx.expanded) return new Text(theme.fg("dim", `watch_loop ${JSON.stringify(args)}`), 0, 0);
			return new Text(args.action === "complete" ? "" : theme.fg("muted", `watch · ${args.action ?? "…"}`), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, ctx) {
			const details = result.details;
			if (!expanded && !isPartial && !ctx.isError && details?.summary && details.result?.ok && !details.result.clamped?.length) {
				return new TruncatedText(theme.fg("muted", details.summary));
			}
			const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			return new Text(theme.fg(ctx.isError || details?.result?.ok === false ? "error" : "toolOutput", text), 0, 0);
		},
		async execute(_toolCallId, params: WatchLoopParameters, _signal, _onUpdate, ctx) {
			controller.bind(ctx);
			if (params.action === "status") return statusResult(controller.state);

			const previousState = controller.state;
			let transition: WatchTransition;
			switch (params.action) {
				case "start": {
					if (dependencies.isDisabled()) {
						throw new Error("watch_loop start is disabled by PI_WATCH_LOOP_DISABLED=1");
					}
					if (ctx.mode !== "tui") {
						throw new Error(`watch_loop start requires an interactive TUI; current mode is ${ctx.mode}`);
					}
					const mode = params.mode;
					const missedCompletionPolicy = params.missedCompletionPolicy;
					if (!mode) throw new Error("mode is required");
					if (!missedCompletionPolicy) throw new Error("missedCompletionPolicy is required");
					const config: WatchStartConfig = {
						label: requiredString(params.label, "label"),
						tickPrompt: requiredString(params.tickPrompt, "tickPrompt"),
						mode,
						initialDelaySeconds: requiredNumber(params.initialDelaySeconds, "initialDelaySeconds"),
						intervalSeconds: params.intervalSeconds,
						missedCompletionPolicy,
						stopAt: parseStopAt(params.stopAt),
						maxTicks: params.maxTicks,
						allowIndefinite: params.allowIndefinite,
					};
					transition = controller.transition(
						{
							type: "start",
							protocolVersion: requiredNumber(params.protocolVersion, "protocolVersion"),
							watchId: dependencies.createWatchId(),
							config,
							now: dependencies.now(),
						},
						ctx,
					);
					break;
				}
				case "complete":
					if (!params.outcome) throw new Error("outcome is required");
					transition = controller.transition(
						{
							type: "complete",
							protocolVersion: requiredNumber(params.protocolVersion, "protocolVersion"),
							watchId: requiredString(params.watchId, "watchId"),
							generation: requiredNumber(params.generation, "generation"),
							outcome: params.outcome,
							delaySeconds: params.delaySeconds,
							reason: params.reason,
							now: dependencies.now(),
						},
						ctx,
					);
					break;
				case "stop":
					transition = controller.transition(
						{
							type: "stop",
							protocolVersion: requiredNumber(params.protocolVersion, "protocolVersion"),
							watchId: requiredString(params.watchId, "watchId"),
							generation: params.generation,
							reason: params.reason,
							now: dependencies.now(),
						},
						ctx,
					);
					break;
			}

			throwIfRejected(transition, previousState);
			if (!transition.result) throw new Error("watch_loop action produced no result");
			return toolResult(transition.result, transition.state, dependencies.now());
		},
	});

	pi.registerCommand("watch-status", {
		description: "Show the current in-memory watch-loop state",
		handler: async (_args, ctx) => {
			controller.bind(ctx);
			ctx.ui.notify(
				`${formatWatchStatus(controller.state, dependencies.now())}\n${controller.formatContextStatus(ctx)}`,
				"info",
			);
		},
	});

	pi.registerCommand("watch-stop", {
		description: "Stop the current in-memory watch loop",
		handler: async (_args, ctx) => {
			const transition = controller.transition(
				{ type: "user_stop", reason: "watch stopped by user", now: dependencies.now() },
				ctx,
			);
			if (transition.result?.ok === false) ctx.ui.notify(transition.result.message, "warning");
		},
	});

	pi.registerCommand("watch-resume", {
		description: "Resume one paused watch with an immediate tick",
		handler: async (_args, ctx) => {
			const transition = controller.transition({ type: "resume", now: dependencies.now() }, ctx);
			if (transition.result?.ok === false) ctx.ui.notify(transition.result.message, "warning");
			else if (transition.result) ctx.ui.notify(transition.result.message, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => controller.bind(ctx));
	pi.on("agent_settled", (_event, ctx) => controller.onAgentSettled(ctx));
	pi.on("session_compact", (event, ctx) => {
		if (event.reason === "manual") controller.onManualCompactionEnded(ctx);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		if (event.reason === "manual") controller.onManualCompactionEnded(ctx);
	});
	pi.on("session_tree", (_event, ctx) => controller.shutdown(ctx, "session tree changed"));
	pi.on("session_shutdown", (_event, ctx) => controller.shutdown(ctx));

	return controller;
}

export default function watchLoopExtension(pi: ExtensionAPI): void {
	registerWatchLoopExtension(pi);
}
