import assert from "node:assert/strict";
import test from "node:test";
import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	formatWatchStatus,
	parseContextAdviceThreshold,
	registerWatchLoopExtension,
	type WatchLoopControllerDependencies,
} from "./index.ts";

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

type HostEvent = { type: string; reason?: string };
type EventHandler = (event: HostEvent, ctx: ExtensionContext) => unknown;

class FakePi {
	readonly tools = new Map<string, ToolDefinition>();
	readonly commands = new Map<string, RegisteredCommand>();
	readonly events = new Map<string, EventHandler[]>();
	readonly messages: string[] = [];
	throwOnSend = false;

	registerTool(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, command: RegisteredCommand): void {
		this.commands.set(name, command);
	}

	on(name: string, handler: EventHandler): void {
		const handlers = this.events.get(name) ?? [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}

	sendUserMessage(prompt: string): void {
		if (this.throwOnSend) throw new Error("Pi became busy");
		this.messages.push(prompt);
	}

	async emit(name: string, ctx: ExtensionContext, fields: Omit<HostEvent, "type"> = {}): Promise<void> {
		for (const handler of this.events.get(name) ?? []) await handler({ type: name, ...fields }, ctx);
	}
}

interface FakeTimer {
	callback: () => void;
	delay: number;
	cleared: boolean;
}

class FakeTimers {
	readonly timers: FakeTimer[] = [];

	setTimer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
		const timer: FakeTimer = { callback, delay, cleared: false };
		this.timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
		(handle as unknown as FakeTimer).cleared = true;
	};

	fire(index: number): void {
		const timer = this.timers[index];
		if (!timer) return;
		timer.cleared = true;
		timer.callback();
	}

	active(): FakeTimer[] {
		return this.timers.filter((timer) => !timer.cleared);
	}
}

interface UiProbe {
	statuses: Array<string | undefined>;
	notifications: Array<{ message: string; level: string }>;
}

type TestContext = ExtensionContext & { idle: boolean; pending: boolean; usage: ContextUsage | undefined };

function usage(percent: number | null): ContextUsage {
	return { tokens: percent === null ? null : percent * 2_000, contextWindow: 200_000, percent };
}

function context(probe: UiProbe, mode: ExtensionContext["mode"] = "tui"): TestContext {
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/tmp/watch-loop",
		idle: true,
		pending: false,
		usage: undefined,
		isIdle: () => ctx.idle,
		hasPendingMessages: () => ctx.pending,
		getContextUsage: () => ctx.usage,
		ui: {
			setStatus(_key: string, value: string | undefined) {
				probe.statuses.push(value);
			},
			notify(message: string, level: string) {
				probe.notifications.push({ message, level });
			},
		},
	} as unknown as TestContext;
	return ctx;
}

function harness(options: { disabled?: boolean; contextThreshold?: number | undefined } = {}) {
	const pi = new FakePi();
	const timers = new FakeTimers();
	const probe: UiProbe = { statuses: [], notifications: [] };
	let now = NOW;
	let watchCount = 0;
	const dependencies: WatchLoopControllerDependencies = {
		now: () => now,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		createWatchId: () => `watch-${++watchCount}`,
		isDisabled: () => options.disabled === true,
		contextAdviceThreshold: () => ("contextThreshold" in options ? options.contextThreshold : 50),
	};
	const controller = registerWatchLoopExtension(pi as unknown as ExtensionAPI, dependencies);
	return { pi, timers, probe, controller, setNow: (value: number) => (now = value) };
}

async function callTool(
	pi: FakePi,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> {
	const tool = pi.tools.get("watch_loop");
	assert.ok(tool);
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

function startParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: "start",
		protocolVersion: 1,
		label: "PRs",
		tickPrompt: "Load and follow the `pr-status` skill now, render its dashboard, then complete the watch tick.",
		mode: "fixed",
		initialDelaySeconds: 60,
		intervalSeconds: 120,
		missedCompletionPolicy: "retry",
		maxTicks: 5,
		...overrides,
	};
}

test("registers one sequential tool, three commands, and lifecycle handlers without arming a timer", async () => {
	const { pi, timers, probe } = harness();
	assert.equal(pi.tools.get("watch_loop")?.executionMode, "sequential");
	assert.deepEqual([...pi.commands.keys()], ["watch-status", "watch-stop", "watch-resume"]);
	assert.ok(pi.events.has("session_start"));
	assert.ok(pi.events.has("agent_settled"));
	assert.ok(pi.events.has("session_shutdown"));
	assert.ok(pi.events.has("session_tree"));

	const ctx = context(probe);
	await pi.emit("session_start", ctx);
	assert.equal(timers.timers.length, 0);
	assert.equal(probe.statuses.at(-1), undefined);
});

test("reports protocol version and complete idle status without terminating the turn", async () => {
	const { pi, probe, controller } = harness();
	const result = await callTool(pi, { action: "status" }, context(probe, "print"));
	assert.equal(result.terminate, undefined);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Protocol: 1/);
	assert.equal((result.details as { state: { status: string } }).state.status, "idle");
	assert.equal(controller.state.status, "idle");
});

test("rejects start in every non-TUI mode without arming timers", async () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const { pi, timers, probe, controller } = harness();
		await assert.rejects(callTool(pi, startParams(), context(probe, mode)), /interactive TUI/);
		assert.equal(controller.state.status, "idle");
		assert.equal(timers.timers.length, 0);
	}
});

test("kill switch refuses start while status remains available", async () => {
	const { pi, timers, probe } = harness({ disabled: true });
	const ctx = context(probe);
	await callTool(pi, { action: "status" }, ctx);
	await assert.rejects(callTool(pi, startParams(), ctx), /PI_WATCH_LOOP_DISABLED/);
	assert.equal(timers.timers.length, 0);
});

test("starts, dispatches, and reschedules a fixed watch from completion time", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	const started = await callTool(pi, startParams(), ctx);
	assert.equal(started.terminate, true);
	assert.equal(controller.state.status, "armed");
	assert.equal(timers.active()[0]?.delay, 60_000);
	assert.match(probe.statuses.at(-1) ?? "", /watch: PRs/);

	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.status, "running");
	assert.equal(controller.state.generation, 1);
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0] ?? "", /watch-loop protocol 1 tick watch-1\/1/);
	assert.match(pi.messages[0] ?? "", /watch_loop complete/);

	setNow(NOW + 90_000);
	const completed = await callTool(
		pi,
		{ action: "complete", protocolVersion: 1, watchId: "watch-1", generation: 1, outcome: "continue" },
		ctx,
	);
	assert.equal(completed.terminate, true);
	assert.equal(controller.state.status, "armed");
	assert.equal(controller.state.nextRunAt, NOW + 210_000);
	assert.equal(timers.active()[0]?.delay, 120_000);

	await pi.emit("agent_settled", ctx);
	assert.equal(controller.state.status, "armed");
	assert.equal(controller.state.consecutiveMisses, 0);
});

test("keeps deadline enforcement active while a tick is running", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(
		pi,
		startParams({ maxTicks: undefined, stopAt: new Date(NOW + 120_000).toISOString() }),
		ctx,
	);
	assert.equal(timers.active().length, 2);
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.status, "running");
	setNow(NOW + 120_000);
	timers.fire(1);
	assert.equal(controller.state.status, "stopped");
	assert.equal(controller.state.generation, 2);
	assert.equal(timers.active().length, 0);
});

test("coalesces a busy timer and stale timer callback into one dispatch", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);

	ctx.idle = false;
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.due, true);
	assert.equal(pi.messages.length, 0);

	ctx.idle = true;
	await pi.emit("agent_settled", ctx);
	assert.equal(pi.messages.length, 1);
	assert.equal(controller.state.status, "running");

	timers.fire(0);
	assert.equal(pi.messages.length, 1);
});

test("pauses without a timer when sendUserMessage loses the idle race", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	pi.throwOnSend = true;
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.status, "paused");
	assert.equal(timers.active().length, 0);
	assert.match(probe.notifications.at(-1)?.message ?? "", /Pi became busy/);
});

test("user stop invalidates a running generation and rejects its late completion", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	setNow(NOW + 60_000);
	timers.fire(0);

	const stop = pi.commands.get("watch-stop");
	assert.ok(stop);
	await stop.handler("", ctx as never);
	assert.equal(controller.state.status, "stopped");
	assert.equal(controller.state.generation, 2);
	await assert.rejects(
		callTool(
			pi,
			{ action: "complete", protocolVersion: 1, watchId: "watch-1", generation: 1, outcome: "continue" },
			ctx,
		),
		/no running watch tick/,
	);
	assert.equal(timers.active().length, 0);
});

test("adaptive completion without a delay applies the pause policy and terminates safely", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(
		pi,
		startParams({ mode: "adaptive", intervalSeconds: undefined, missedCompletionPolicy: "pause" }),
		ctx,
	);
	setNow(NOW + 60_000);
	timers.fire(0);
	const result = await callTool(
		pi,
		{ action: "complete", protocolVersion: 1, watchId: "watch-1", generation: 1, outcome: "continue" },
		ctx,
	);
	assert.equal(result.terminate, true);
	assert.equal(controller.state.status, "paused");
	assert.equal(timers.active().length, 0);
});

test("resume schedules an immediate generation and shutdown clears it without persistence", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(
		pi,
		startParams({ missedCompletionPolicy: "pause" }),
		ctx,
	);
	setNow(NOW + 60_000);
	timers.fire(0);
	await pi.emit("agent_settled", ctx);
	assert.equal(controller.state.status, "paused");

	const resume = pi.commands.get("watch-resume");
	assert.ok(resume);
	await resume.handler("", ctx as never);
	assert.equal(controller.state.status, "armed");
	assert.equal(timers.active()[0]?.delay, 0);

	await pi.emit("session_shutdown", ctx);
	assert.equal(controller.state.status, "stopped");
	assert.equal(timers.active().length, 0);
	assert.equal(probe.statuses.at(-1), undefined);
});

test("tree navigation stops the in-memory watch instead of carrying it to another branch", async () => {
	const { pi, timers, probe, controller } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	await pi.emit("session_tree", ctx);
	assert.equal(controller.state.status, "stopped");
	assert.equal(controller.state.lastReason, "session tree changed");
	assert.equal(timers.active().length, 0);
	assert.equal(probe.statuses.at(-1), undefined);
});

test("status text exposes cadence, budget, misses, reason, and explicit bounds", async () => {
	const { pi, probe, controller } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams({ maxTicks: 3, stopAt: new Date(NOW + 3_600_000).toISOString() }), ctx);
	const text = formatWatchStatus(controller.state, NOW);
	assert.match(text, /Protocol: 1/);
	assert.match(text, /State: armed/);
	assert.match(text, /Mode: fixed/);
	assert.match(text, /Ticks: 0\/3/);
	assert.match(text, /Consecutive misses: 0/);
	assert.match(text, /Deadline: 2026-/);
	assert.match(text, /Last reason: watch started/);
	assert.doesNotMatch(text, /Context/);
});

function contextNotices(probe: UiProbe): string[] {
	return probe.notifications.map((notice) => notice.message).filter((message) => /context/i.test(message));
}

test("parses the context advice threshold strictly and falls back to 50", () => {
	for (const value of [undefined, "", "  ", "50junk", "1.5", "100", "-1", "5e1", "０５"]) {
		assert.equal(parseContextAdviceThreshold(value), 50, String(value));
	}
	for (const value of ["0", "off", " OFF "]) assert.equal(parseContextAdviceThreshold(value), undefined, value);
	assert.equal(parseContextAdviceThreshold("1"), 1);
	assert.equal(parseContextAdviceThreshold(" 70 "), 70);
	assert.equal(parseContextAdviceThreshold("99"), 99);
});

test("suggests compaction once per 10-point band without touching tick prompts", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	ctx.usage = usage(80);
	await pi.emit("agent_settled", ctx);
	assert.deepEqual(contextNotices(probe), [], "no watch, no advice");

	await callTool(pi, startParams(), ctx);
	const readings: Array<number | null> = [49.9, 50, 59.9, 72, null, 79.9, 80.2];
	const counts: number[] = [];
	for (const percent of readings) {
		ctx.usage = usage(percent);
		await pi.emit("agent_settled", ctx);
		counts.push(contextNotices(probe).length);
	}
	assert.deepEqual(counts, [0, 1, 1, 2, 2, 2, 3]);
	assert.match(contextNotices(probe)[0] ?? "", /Watch "PRs": context 50% \(advice from 50%\)\. Consider \/compact/);
	assert.match(contextNotices(probe)[1] ?? "", /context 72%/);
	assert.ok(probe.notifications.every((notice) => notice.level === "info" || !/context/.test(notice.message)));

	ctx.usage = undefined;
	await pi.emit("agent_settled", ctx);
	assert.equal(contextNotices(probe).length, 3, "missing usage stays silent");
	assert.equal(pi.messages.length, 0);
	assert.equal(controller.state.status, "armed");
	assert.equal(timers.active()[0]?.delay, 60_000);

	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(pi.messages.length, 1);
	assert.doesNotMatch(pi.messages[0] ?? "", /context|compact/i);
});

test("a lower reading after compaction re-arms advice for the same watch", async () => {
	const { pi, probe } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	for (const percent of [65, null, 30, 51, 64]) {
		ctx.usage = usage(percent);
		await pi.emit("agent_settled", ctx);
	}
	assert.deepEqual(contextNotices(probe).map((message) => message.match(/context (\d+)%/)?.[1]), ["65", "51", "64"]);
});

test("advice is per watch and covers paused watches but not stopped ones", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams({ missedCompletionPolicy: "pause" }), ctx);
	ctx.usage = usage(55);
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.status, "running");
	await pi.emit("agent_settled", ctx);
	assert.equal(controller.state.status, "paused");
	assert.equal(contextNotices(probe).length, 1);

	const stop = pi.commands.get("watch-stop");
	assert.ok(stop);
	await stop.handler("", ctx as never);
	await pi.emit("agent_settled", ctx);
	assert.equal(contextNotices(probe).length, 1, "stopped watch stays silent");

	await callTool(pi, startParams(), ctx);
	assert.equal(controller.state.watch?.id, "watch-2");
	await pi.emit("agent_settled", ctx);
	assert.equal(contextNotices(probe).length, 2, "a new watch starts a fresh band history");
});

test("disabled advice stays silent and non-UI modes never notify", async () => {
	const disabled = harness({ contextThreshold: undefined });
	const ctx = context(disabled.probe);
	await callTool(disabled.pi, startParams(), ctx);
	ctx.usage = usage(95);
	await disabled.pi.emit("agent_settled", ctx);
	assert.deepEqual(contextNotices(disabled.probe), []);

	const enabled = harness({ contextThreshold: 70 });
	const tui = context(enabled.probe);
	await callTool(enabled.pi, startParams(), tui);
	tui.usage = usage(69);
	await enabled.pi.emit("agent_settled", tui);
	assert.deepEqual(contextNotices(enabled.probe), []);
	const print = context(enabled.probe, "print");
	print.usage = usage(90);
	await enabled.pi.emit("agent_settled", print);
	assert.deepEqual(contextNotices(enabled.probe), []);
});

test("/watch-status reports context advice and current usage without changing tool output", async () => {
	const { pi, probe } = harness();
	const ctx = context(probe);
	const status = pi.commands.get("watch-status");
	assert.ok(status);
	await status.handler("", ctx as never);
	assert.match(probe.notifications.at(-1)?.message ?? "", /Context advice: from 50%\nContext: unknown/);
	ctx.usage = usage(61.4);
	await status.handler("", ctx as never);
	assert.match(probe.notifications.at(-1)?.message ?? "", /Context: 61% of 200000 tokens/);
	const result = await callTool(pi, { action: "status" }, ctx);
	assert.doesNotMatch(result.content[0]?.type === "text" ? result.content[0].text : "", /Context/);

	const off = harness({ contextThreshold: undefined });
	const offStatus = off.pi.commands.get("watch-status");
	assert.ok(offStatus);
	await offStatus.handler("", context(off.probe) as never);
	assert.match(off.probe.notifications.at(-1)?.message ?? "", /Context advice: off/);
});

test("a tick that falls due during manual compaction dispatches once compaction ends", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams({ maxTicks: undefined, stopAt: new Date(NOW + 3_600_000).toISOString() }), ctx);
	assert.equal(timers.active().length, 2);

	ctx.idle = false;
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.due, true);
	assert.match(probe.statuses.at(-1) ?? "", /due/);

	await pi.emit("session_compact", ctx, { reason: "manual" });
	const recheck = timers.timers.length - 1;
	assert.equal(timers.timers[recheck]?.delay, 1_000);
	timers.fire(recheck);
	assert.equal(controller.state.due, true, "still compacting");
	assert.equal(pi.messages.length, 0);

	ctx.idle = true;
	timers.fire(timers.timers.length - 1);
	assert.equal(controller.state.status, "running");
	assert.equal(pi.messages.length, 1);
	assert.equal(timers.active().length, 1, "only the deadline timer remains");
	assert.equal(timers.active()[0]?.delay, 3_600_000);

	timers.fire(recheck);
	await pi.emit("session_compact", ctx, { reason: "manual" });
	assert.equal(pi.messages.length, 1, "stale or duplicate rechecks never redispatch");
});

test("failed manual compaction also rechecks and stops after a bounded number of attempts", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	ctx.idle = false;
	setNow(NOW + 60_000);
	timers.fire(0);
	await pi.emit("session_compact_failed", ctx, { reason: "manual" });
	let fired = 0;
	while (timers.active().length > 0 && fired < 20) {
		timers.fire(timers.timers.indexOf(timers.active()[0] as never));
		fired += 1;
	}
	assert.equal(fired, 10);
	assert.equal(controller.state.status, "armed");
	assert.equal(controller.state.due, true);

	ctx.idle = true;
	await pi.emit("agent_settled", ctx);
	assert.equal(pi.messages.length, 1, "the next settle still dispatches the due tick");
});

test("compaction leaves scheduled, paused, and auto-compacted watches untouched", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams({ missedCompletionPolicy: "pause" }), ctx);
	await pi.emit("session_compact", ctx, { reason: "manual" });
	assert.equal(timers.timers.length, 1);
	assert.equal(timers.active()[0]?.delay, 60_000);
	assert.equal(controller.state.due, false);

	ctx.idle = false;
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.due, true);
	for (const reason of ["threshold", "overflow"]) await pi.emit("session_compact", ctx, { reason });
	assert.equal(timers.active().length, 0, "automatic compaction runs inside an agent run that still settles");

	ctx.idle = true;
	await pi.emit("agent_settled", ctx);
	assert.equal(controller.state.status, "running");
	await pi.emit("agent_settled", ctx);
	assert.equal(controller.state.status, "paused");
	await pi.emit("session_compact", ctx, { reason: "manual" });
	assert.equal(controller.state.status, "paused");
	assert.equal(timers.active().length, 0);
	assert.equal(pi.messages.length, 1);
});
