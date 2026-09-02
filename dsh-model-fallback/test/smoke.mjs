/**
 * dsh-model-fallback host-logic smoke test.
 *
 * Stubs the small cordis surface the plugin touches (ctx.on / logger / llm /
 * inject->settings / effect) and drives real scenarios through the registered
 * `llm/stream` listener: fallback on early failure, pass-through on
 * mid-stream failure, abort pass-through, disabled / not-selected passthrough,
 * and chain exhaustion.
 */
import { apply, Config, name, __clearHealthCache } from "../lib/index.js";

const assert = (condition, message) => {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`ok: ${message}`);
	}
};

//#region stubs
const log = [];
const logger = {
	warn: (...args) => log.push(["warn", args.join(" ")]),
	info: (...args) => log.push(["info", args.join(" ")]),
	error: (...args) => log.push(["error", args.join(" ")]),
};

/** Fake adapter boundary: every model streams one text delta then a stop finish. */
const healthyModels = new Set(["p1/m2", "p2/m1"]);
/** Models that fail with a terminal error before any content. */
const failingModels = new Map(); // "provider/model" -> failure chunk
const adapterStreamCalls = [];

const fakeLlm = {
	listModels: async (provider) => {
		if (provider === "p1") return [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }];
		if (provider === "p2") return [{ id: "m1", name: "M1" }];
		return [];
	},
	adapterStream(options) {
		adapterStreamCalls.push(`${options.provider}/${options.model}`);
		const key = `${options.provider}/${options.model}`;
		const failure = failingModels.get(key);
		const healthy = healthyModels.has(key);
		return (async function* () {
			if (failure) {
				yield failure;
				return;
			}
			if (!healthy) {
				yield { type: "finish", reason: { kind: "error", failure: { code: "UNKNOWN_MODEL", message: `no such model ${key}` } } };
				return;
			}
			yield { type: "text-delta", text: `hello from ${key}` };
			yield { type: "finish", reason: { kind: "stop", usage: {} } };
		})();
	},
};

const registered = new Map();
const resolved = new Map([["model-fallback", { enabled: true, providers: ["p1", "p2"] }]]);
const watchers = [];
/** Fake user-questions service: mirrors the real single-provider seam. */
const fakeUQ = {
	mail: null,
	registerProvider(provider) {
		this.provider = provider;
		return () => {
			this.provider = undefined;
		};
	},
};
const approvalListeners = [];
const loopListeners = [];
const ctx = {
	fiber: { state: 0 },
	logger,
	llm: fakeLlm,
	listeners: new Map(),
	get(name) {
		return name === "userQuestions" ? fakeUQ : undefined;
	},
	on(eventName, listener) {
		if (eventName === "approval/request") approvalListeners.push(listener);
		if (eventName === "agent/request-error") loopListeners.push(listener);
		if (!this.listeners.has(eventName)) this.listeners.set(eventName, []);
		this.listeners.get(eventName).push(listener);
		return () => {};
	},
	effect(factory) {
		return typeof factory?.() === "function" ? factory() : undefined;
	},
	inject(deps, callback) {
		callback(ctx);
	},
	settings: {
		register(namespace, schema, options) {
			registered.set(namespace, { schema, options });
			return {
				get: () => resolved.get(namespace),
				watch: (callback) => {
					watchers.push(callback);
					return () => {};
				},
			};
		},
		// Mirror dsh-settings' update(): deep-merge plain-object patches into the
		// stored section so runtime arrears writes accumulate instead of clobber.
		async update(namespace, patch) {
			console.log("UPDATE CALLED:", namespace, JSON.stringify(patch));
			const section = { ...(resolved.get(namespace) ?? {}) };
			for (const [key, value] of Object.entries(patch ?? {})) {
				if (value && typeof value === "object" && !Array.isArray(value) && section[key] && typeof section[key] === "object" && !Array.isArray(section[key])) {
					section[key] = { ...section[key], ...value };
				} else {
					section[key] = value;
				}
			}
			resolved.set(namespace, section);
		},
	},
};

const streamListener = (() => {
	let captured = null;
	const originalOn = ctx.on.bind(ctx);
	ctx.on = (eventName, listener) => {
		if (eventName === "llm/stream") captured = listener;
		return originalOn(eventName, listener);
	};
	return { get: () => captured };
})();

apply(ctx, { enabled: true, providers: ["p1", "p2"] });
//#endregion

/** Drain one async generator into an array. */
async function drain(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

/** Run one request through the registered listener. */
function request(options, downstream) {
	return streamListener.get()(options, () => downstream);
}

const failChunk = (code, message) => ({ type: "finish", reason: { kind: "error", failure: { code, message } } });

//#region scenarios
// Let the catalog warm-up scheduled by apply() settle.
await new Promise((resolve) => setTimeout(resolve, 20));
assert(log.some(([, line]) => line.includes("loop-level retry listener armed")), "loop-retry armed line present at apply");

{
	// 1. protectUnselected (default on): an unselected provider's failing model
	//    cycles into the selected groups and recovers.
	const seen = [];
	const chunks = await drain(
		request({ provider: "other", model: "m1" }, (async function* () {
			seen.push("downstream");
			yield failChunk("UNKNOWN_MODEL", "nope");
		})()),
	);
	assert(seen.length === 1, "unselected provider reaches downstream exactly once");
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello from p1/m2"), "unselected provider recovers through the selected groups (protectUnselected on)");
	assert(log.some(([, line]) => line.includes("engaged for other/m1")), "engagement decision logged for the unselected provider");
}

{
	// 1b. protectUnselected off: unselected providers pass through untouched.
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], protectUnselected: false });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	const seen = [];
	const chunks = await drain(
		request({ provider: "other", model: "m1" }, (async function* () {
			seen.push("downstream");
			yield failChunk("UNKNOWN_MODEL", "nope");
		})()),
	);
	assert(seen.length === 1 && chunks.length === 1 && chunks[0].reason.kind === "error", "protectUnselected off: unselected provider passes through");
	assert(log.some(([, line]) => line.includes("not engaged for other")), "skip decision logged when protection is off");
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
}

{
	// 2. fallback: p1/m1 fails early -> adapterStream retry on p1/m2 -> success.
	const downstreamCalls = [];
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			downstreamCalls.push(1);
			yield failChunk("UNKNOWN_MODEL", `unknown model p1/m1`);
		})()),
	);
	assert(downstreamCalls.length === 1, "downstream chain invoked once for attempt 0");
	assert(adapterStreamCalls.includes("p1/m2"), `retry dispatched to adapter boundary (${adapterStreamCalls.join(", ")})`);
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello from p1/m2"), "fallback stream content reaches the consumer");
	assert(chunks.at(-1).reason.kind === "stop", "fallback stream ends with a stop finish");
	assert(log.some(([, line]) => line.includes("switching to p1/m2")), "switch logged");
}

{
	// 3. mid-stream failure does NOT switch: content was already produced.
	const chunks = await drain(
		request({ provider: "p1", model: "m2" }, (async function* () {
			yield { type: "text-delta", text: "partial" };
			yield failChunk("CONNECTION_CLOSED", "dropped mid-stream");
		})()),
	);
	assert(chunks.length === 2 && chunks.at(-1).reason.kind === "error", "mid-stream failure surfaces untouched");
	assert(adapterStreamCalls.filter((call) => call === "p2/m1").length === 0, "no adapter retry after visible content");
}

{
	// 4. aborted finish passes through without switching.
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "user aborted" } } };
		})()),
	);
	assert(chunks.length === 1 && chunks[0].reason.kind === "aborted", "aborted finish passes through");
}

{
	// 5. cross-provider loop: every p1 model fails -> p2/m1 succeeds.
	failingModels.set("p1/m2", failChunk("QUOTA", "insufficient balance"));
	adapterStreamCalls.length = 0;
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			yield failChunk("UNKNOWN_MODEL", "unknown model p1/m1");
		})()),
	);
	assert(adapterStreamCalls.includes("p1/m2") && adapterStreamCalls.includes("p2/m1"), `full loop traverses both providers (${adapterStreamCalls.join(", ")})`);
	assert(chunks.at(-1).reason.kind === "stop", "cross-provider recovery ends with a stop finish");
}

{
	// 6. chain exhaustion returns the last failure.
	healthyModels.clear();
	adapterStreamCalls.length = 0;
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			yield failChunk("UNKNOWN_MODEL", "unknown model p1/m1");
		})()),
	);
	assert(chunks.length === 1 && chunks[0].reason.kind === "error", "terminal error after exhausting every candidate");
	assert(log.some(([, line]) => line.includes("exhausted")), "exhaustion logged");
	healthyModels.add("p1/m2");
	healthyModels.add("p2/m1");
}

{
	// 7. disabled via settings -> passthrough.
	resolved.set("model-fallback", { enabled: false, providers: ["p1", "p2"] });
	for (const watcher of watchers) watcher();
	const seen = [];
	await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			seen.push(1);
			yield failChunk("UNKNOWN_MODEL", "nope");
		})()),
	);
	assert(seen.length === 1, "disabled plugin passes through");
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
}

{
	// 8. settings schema basics: defaults apply.
	const section = registered.get("model-fallback");
	const value = section.schema({});
	assert(value.enabled === true && Array.isArray(value.providers) && value.providers.length === 0, "schema defaults resolve enabled=true, providers=[]");
}

	{
		// 9. task retry: chain exhausted with non-model error -> retry original model -> success.
		failingModels.clear();
		healthyModels.clear();
		adapterStreamCalls.length = 0;
		log.length = 0;
		// All chain candidates fail with NETWORK_ERROR initially.
		failingModels.set("p1/m1", failChunk("NETWORK_ERROR", "connection reset"));
		failingModels.set("p1/m2", failChunk("NETWORK_ERROR", "connection reset"));
		failingModels.set("p2/m1", failChunk("NETWORK_ERROR", "connection reset"));
		let callCount = 0;
		const origAdapterStream = fakeLlm.adapterStream;
		fakeLlm.adapterStream = function(options) {
			callCount++;
			const key = `${options.provider}/${options.model}`;
			if (key === "p1/m1" && callCount <= 2) {
				return (async function* () {
					yield failChunk("NETWORK_ERROR", "connection reset");
				})();
			}
			if (key === "p1/m1" && callCount > 2) {
				return (async function* () {
					yield { type: "text-delta", text: "hello from p1/m1" };
					yield { type: "finish", reason: { kind: "stop", usage: {} } };
				})();
			}
			return origAdapterStream.call(fakeLlm, options);
		};
		resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 } });
		for (const watcher of watchers) watcher();
		await new Promise((r) => setTimeout(r, 20));
		const chunks = await drain(
			request({ provider: "p1", model: "m1" }, (async function* () {
				yield failChunk("NETWORK_ERROR", "downstream network error");
			})()),
		);
		assert(chunks.some((c) => c.type === "text-delta" && c.text === "hello from p1/m1"), "retry same model recovers on NETWORK_ERROR");
		assert(log.some(([, line]) => line.includes("non-model error, retry")), "retry logged");
		fakeLlm.adapterStream = origAdapterStream;
		healthyModels.add("p1/m2");
		healthyModels.add("p2/m1");
	}

	{
		// 10. task retry disabled -> chain exhaustion returns error immediately.
		failingModels.clear();
		healthyModels.clear();
		adapterStreamCalls.length = 0;
		resolved.set("model-fallback", { enabled: true, providers: ["p1"], retry: { enabled: false, maxRetries: 3 } });
		for (const watcher of watchers) watcher();
		await new Promise((r) => setTimeout(r, 20));
		const chunks = await drain(
			request({ provider: "p1", model: "m1" }, (async function* () {
				yield failChunk("NETWORK_ERROR", "downstream network error");
			})()),
		);
		assert(chunks.length === 1 && chunks[0].reason.kind === "error", "retry disabled skips same-model retry");
		assert(adapterStreamCalls.filter((c) => c === "p1/m1").length <= 1, "no adapter retry when disabled");
		resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], retry: { enabled: true, maxRetries: 3, baseDelayMs: 500 } });
	}

	{
		// 11. model error is NOT retried (UNKNOWN_MODEL is a model error).
		failingModels.clear();
		healthyModels.clear();
		adapterStreamCalls.length = 0;
		log.length = 0;
		const chunks = await drain(
			request({ provider: "p1", model: "m1" }, (async function* () {
				yield failChunk("UNKNOWN_MODEL", "unknown model");
			})()),
		);
		assert(chunks.length === 1 && chunks[0].reason.kind === "error", "model error not retried");
		assert(!log.some(([, line]) => line.includes("non-model error, retry")), "model error does not trigger retry log");
		healthyModels.add("p1/m2");
		healthyModels.add("p2/m1");
	}

	{
		// 12. abort is never retried even with retry enabled.
		const chunks = await drain(
			request({ provider: "p1", model: "m1" }, (async function* () {
				yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "user aborted" } } };
			})()),
		);
		assert(chunks.length === 1 && chunks[0].reason.kind === "aborted", "abort is never retried");
	}

	{
		// 13. schema defaults include retry config.
		const section = registered.get("model-fallback");
		const value = section.schema({});
		assert(value.enabled === true, "schema defaults enabled=true");
		assert(Array.isArray(value.providers) && value.providers.length === 0, "schema defaults providers=[]");
		assert(value.retry && typeof value.retry.enabled === "boolean", "schema defaults retry.enabled");
		assert(typeof value.retry.maxRetries === "number" && value.retry.maxRetries === 3, "schema defaults retry.maxRetries=3");
		assert(typeof value.retry.baseDelayMs === "number" && value.retry.baseDelayMs === 500, "schema defaults retry.baseDelayMs=500");
		assert(Array.isArray(value.retry.retryableCodes), "schema defaults retry.retryableCodes is array");
	}

	{
	// 14. full-auto: disabled by default -> approval waterfall passes through.
	assert(approvalListeners.length === 1, "approval/request listener registered");
	let nextCalled = 0;
	const passThrough = approvalListeners[0]({ toolName: "bash", reason: "escalation" }, () => {
		nextCalled++;
		return "unavailable";
	});
	assert(nextCalled === 1 && passThrough === "unavailable", "auto mode off: approval passes to later answerers");
}

{
	// 15. full-auto: enabled -> allowed-once + workspace audit file written.
	const { mkdtempSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "dsh-auto-"));
	resolved.set("model-fallback-auto", { enabled: true, autoAllowPermissions: true, autoAnswerQuestions: true, autoApprovePlans: true, workspaceLog: true });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	const outcome = approvalListeners[0](
		{ agent: { session: { header: { cwd: root } } }, toolName: "bash", reason: "sandbox escalation to danger-full-access" },
		() => "unavailable",
	);
	assert(outcome === "allowed-once", "auto mode on: permission auto-allowed");
	const auditFile = join(root, "AUTO-MODE.md");
	await new Promise((r) => setTimeout(r, 60));
	assert(existsSync(auditFile), "workspace audit file created");
	const audit = readFileSync(auditFile, "utf8");
	assert(audit.includes("全自动模式操作审计"), "audit file carries the banner");
	assert(audit.includes("bash"), "audit entry names the approved tool");
	// disabled again -> passthrough
	resolved.set("model-fallback-auto", { enabled: false });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	let nextCalled2 = 0;
	const outcome2 = approvalListeners[0]({ toolName: "bash" }, () => {
		nextCalled2++;
		return "unavailable";
	});
	assert(nextCalled2 === 1 && outcome2 === "unavailable", "auto mode off again: passthrough restored");
}

{
	// 16. full-auto: user-question provider wrap answers defaults.
	assert(typeof fakeUQ.registerProvider === "function", "user-questions provider wrap armed");
	let realAsked = 0;
	const realProvider = {
		ask: async () => {
			realAsked++;
			return { answers: [{ id: "real", selected: ["REAL"], custom: undefined }] };
		},
	};
	fakeUQ.registerProvider(realProvider);
	const provider = fakeUQ.provider;
	assert(typeof provider?.ask === "function", "provider registration wrapped");
	// 16a. plan review with intent -> approve label, real provider untouched.
	const planReq = {
		questions: [{
			id: "plan-review",
			question: "Approve this plan and leave plan mode?",
			options: [{ label: "Approve (Recommended)" }, { label: "Keep planning" }],
			intent: { kind: "plan-review", approve: "Approve (Recommended)" },
		}],
	};
	resolved.set("model-fallback-auto", { enabled: true, autoAnswerQuestions: true, autoApprovePlans: true });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	const planAnswer = await provider.ask(planReq);
	assert(realAsked === 0, "plan review did not reach the real provider");
	assert(planAnswer.answers[0].id === "plan-review" && planAnswer.answers[0].selected[0] === "Approve (Recommended)", "plan review auto-approved with the intent label");
	// 16b. plain question without intent -> first option.
	const plainAnswer = await provider.ask({
		questions: [{ id: "choice", question: "Pick one", options: [{ label: "First" }, { label: "Second" }] }],
	});
	assert(plainAnswer.answers[0].selected[0] === "First", "confirmation question auto-answered with the first option");
	// 16c. free-text question -> empty selection with the auto custom text.
	const freeAnswer = await provider.ask({ questions: [{ id: "text", question: "Type something" }] });
	assert(freeAnswer.answers[0].selected.length === 0 && typeof freeAnswer.answers[0].custom === "string", "free-text question auto-answered with the fallback custom text");
	// 16d. plan gated off -> delegates to the real provider.
	resolved.set("model-fallback-auto", { enabled: true, autoApprovePlans: false });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	await provider.ask(planReq);
	assert(realAsked === 1, "plan gate off: review delegated to the real provider");
	// 16e. master off -> everything delegates.
	resolved.set("model-fallback-auto", { enabled: false });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	await provider.ask({ questions: [{ id: "choice", question: "Pick one", options: [{ label: "First" }] }] });
	assert(realAsked === 2, "master off: all questions delegate to the real provider");
}

{
	// 17. auto settings namespace registered with its own schema defaults.
	const section = registered.get("model-fallback-auto");
	assert(section !== undefined, "auto settings namespace registered");
	const value = section.schema({});
	assert(value.enabled === false, "auto defaults enabled=false (opt-in)");
	assert(value.autoAllowPermissions === true && value.autoAnswerQuestions === true && value.autoApprovePlans === true && value.workspaceLog === true, "auto sub-toggles default on");
}

{
	// 18. loop-level request recovery on agent/request-error.
	assert(loopListeners.length === 1, "agent/request-error listener registered");
	const session = { events: [], append(type, data) { this.events.push({ type, data }); } };
	const payload = (overrides = {}) => ({
		agent: { session },
		turn: 1,
		step: 1,
		provider: "p1",
		failure: { code: "NETWORK_ERROR", message: "connection reset" },
		...overrides,
	});
	const failNext = async () => undefined;

	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], retry: { enabled: true, loopRetry: true, maxRetries: 2, baseDelayMs: 5, retryableCodes: ["NETWORK_ERROR"] } });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));

	let nextCalls = 0;
	const first = await loopListeners[0](payload(), async () => {
		nextCalls++;
		return undefined;
	});
	assert(nextCalls === 1, "loop recovery consults the native chain first");
	assert(first && first.kind === "retry", "loop recovery returns retry for a retryable failure");
	const retryEvent = session.events.find((event) => event.type === "llm/retry");
	assert(retryEvent && retryEvent.data.retry === 1 && retryEvent.data.provider === "p1", "retry bookkeeping appended to the session");
	assert(session.events.some((event) => event.type === "llm/retry-started"), "retry-started appended after the backoff");

	await loopListeners[0](payload(), failNext);
	assert(session.events.filter((event) => event.type === "llm/retry").length === 2, "second failure schedules retry 2");

	const capped = await loopListeners[0](payload(), failNext);
	assert(capped === undefined && !session.events.some((event) => event.type === "llm/retry" && event.data.retry === 3), "maxRetries cap stops further loop retries");

	const model = await loopListeners[0](payload({ failure: { code: "UNKNOWN_MODEL", message: "no such model" } }), failNext);
	assert(model === undefined, "model errors are not loop-retried");

	const aborted = await loopListeners[0](payload({ failure: { code: "ABORTED", message: "user aborted" } }), failNext);
	assert(aborted === undefined, "aborted failures are never loop-retried");

	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], retry: { enabled: true, loopRetry: false, maxRetries: 2, baseDelayMs: 5 } });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	const off = await loopListeners[0](payload(), failNext);
	assert(off === undefined, "loopRetry off: failures pass through to the native chain");

	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], retry: { enabled: true, loopRetry: true, maxRetries: 2, baseDelayMs: 5 } });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	const nativeOutcome = await loopListeners[0](payload(), async () => ({ kind: "retry" }));
	assert(nativeOutcome && nativeOutcome.kind === "retry", "native retry decisions pass through untouched");
}

{
	// 19. empty catalog no longer disarms the wrapper: single-candidate chain
	//     still engages and the request-level retry runs on the same model.
	failingModels.clear();
	healthyModels.clear();
	adapterStreamCalls.length = 0;
	failingModels.set("empty/m1", failChunk("NETWORK_ERROR", "connection reset"));
	let recover = false;
	const origAdapterStream = fakeLlm.adapterStream;
	fakeLlm.adapterStream = function(options) {
		const key = `${options.provider}/${options.model}`;
		if (key === "empty/m1") {
			if (!recover) {
				recover = true;
				return (async function* () {
					yield { type: "text-delta", text: "recovered on retry" };
					yield { type: "finish", reason: { kind: "stop", usage: {} } };
				})();
			}
		}
		return origAdapterStream.call(fakeLlm, options);
	};
	resolved.set("model-fallback", { enabled: true, providers: ["empty"], retry: { enabled: true, maxRetries: 3, baseDelayMs: 5 } });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 30));
	const chunks = await drain(
		request({ provider: "empty", model: "m1" }, (async function* () {
			yield failChunk("NETWORK_ERROR", "downstream failed");
		})()),
	);
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "recovered on retry"), "empty catalog still wraps: same-model retry recovers");
	assert(log.some(([, line]) => line.includes("engaged for empty/m1, chain=1")), "single-candidate chain engagement logged");
	fakeLlm.adapterStream = origAdapterStream;
	healthyModels.add("p1/m2");
	healthyModels.add("p2/m1");
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
}

{
	// 21. a throwing listModels does not lock the catalog for the full TTL:
	//     the errored entry re-attempts after the short error TTL.
	let boomCalls = 0;
	const origListModels = fakeLlm.listModels;
	fakeLlm.listModels = async (provider) => {
		if (provider === "boom") {
			boomCalls += 1;
			throw new Error("catalog unavailable");
		}
		return origListModels(provider);
	};
	resolved.set("model-fallback", { enabled: true, providers: ["boom", "p1"] });
	for (const watcher of watchers) watcher();
	// First engagement triggers refresh attempt #1.
	await drain(
		request({ provider: "boom", model: "m1" }, (async function* () {
			yield failChunk("UNKNOWN_MODEL", "nope");
		})()),
	);
	await new Promise((r) => setTimeout(r, 20));
	assert(boomCalls === 1, "throwing catalog attempted once");
	// The errored entry must not block the wrapper: the chain still forms from p1.
	healthyModels.clear();
	healthyModels.add("p1/m1");
	const chunks = await drain(
		request({ provider: "boom", model: "m1" }, (async function* () {
			yield failChunk("UNKNOWN_MODEL", "nope");
		})()),
	);
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello from p1/m1"), "errored catalog does not disarm the wrapper: p1 candidates still serve");
	fakeLlm.listModels = origListModels;
	healthyModels.clear();
	healthyModels.add("p1/m2");
	healthyModels.add("p2/m1");
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
}

{
	// 22. arrears setting: an account marked in arrears is excluded from the
	//     fallback pool (but the originally requested model still leads).
	__clearHealthCache();
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], arrears: { p1: true } });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	failingModels.clear();
	healthyModels.clear();
	healthyModels.add("p2/m1");
	adapterStreamCalls.length = 0;
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			yield failChunk("UNKNOWN_MODEL", "unknown model p1/m1");
		})()),
	);
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello from p2/m1"), "arrears: p1 account skipped, recovery uses p2");
	assert(!adapterStreamCalls.includes("p1/m2"), "arrears: p1/m2 not dispatched because the p1 account is in arrears");
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
}

{
	// 22b. a wallet-level failure (QUOTA/402) auto-marks the account in arrears
	//      and persists the marker through the settings service.
	__clearHealthCache();
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	failingModels.clear();
	healthyModels.clear();
	healthyModels.add("p2/m1");
	adapterStreamCalls.length = 0;
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			yield failChunk("QUOTA", "insufficient balance");
		})()),
	);
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello from p2/m1"), "arrears auto-mark: recovery still lands on p2/m1");
	assert(!adapterStreamCalls.includes("p1/m2"), "arrears auto-mark: p1/m2 skipped after the wallet failure");
	// The arrears write is a fire-and-forget settings.update promise; poll
	// instead of sleeping a fixed 20 ms so the assertion cannot race it.
	let stored = resolved.get("model-fallback");
	for (let i = 0; i < 50 && stored?.arrears?.p1 !== true; i += 1) {
		await new Promise((r) => setTimeout(r, 20));
		stored = resolved.get("model-fallback");
	}
	assert(stored?.arrears?.p1 === true, "arrears auto-mark: the account marker persisted through settings.update");
}

{
	// 23. providerModels allow-list: only the selected model ids participate.
	__clearHealthCache();
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], providerModels: { p1: ["m2"] } });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	failingModels.clear();
	healthyModels.clear();
	healthyModels.add("p1/m2");
	adapterStreamCalls.length = 0;
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			yield failChunk("UNKNOWN_MODEL", "unknown model p1/m1");
		})()),
	);
	assert(adapterStreamCalls.includes("p1/m2"), "providerModels: p1/m2 is allowed as fallback");
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello from p1/m2"), "providerModels: recovery lands on selected p1/m2");
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
}

{
	// 23b. providerModels exclusion: an UNCHECKED model is skipped even when
	//      it is healthy — unchecked models never serve as fallback candidates.
	__clearHealthCache();
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"], providerModels: { p1: [] } });
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
	failingModels.clear();
	healthyModels.clear();
	healthyModels.add("p1/m2");
	healthyModels.add("p2/m1");
	adapterStreamCalls.length = 0;
	const chunks = await drain(
		request({ provider: "p1", model: "m1" }, (async function* () {
			yield failChunk("UNKNOWN_MODEL", "unknown model p1/m1");
		})()),
	);
	assert(!adapterStreamCalls.includes("p1/m2"), "providerModels exclusion: healthy but unchecked p1/m2 never dispatched");
	assert(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "hello from p2/m1"), "providerModels exclusion: recovery falls through to p2/m1");
	resolved.set("model-fallback", { enabled: true, providers: ["p1", "p2"] });
	healthyModels.add("p1/m2");
	for (const watcher of watchers) watcher();
	await new Promise((r) => setTimeout(r, 20));
}

{
	// 24. log system: the ring buffer captures events and the /dsh-model-fallback/api/log
	//     route serves them as newest-first JSON.
	const webServerRoutes = [];
	// Faithful cordis semantics: webServer is reachable ONLY through inject —
	// the exact guard that broke the first implementation ("without inject").
	const originalInject = ctx.inject.bind(ctx);
	ctx.inject = (deps, callback) => {
		if (Array.isArray(deps) && deps.includes("webServer")) {
			callback({ ...ctx, webServer: { register(route) { webServerRoutes.push(route); return () => {}; } } });
			return;
		}
		return originalInject(deps, callback);
	};
	// Re-apply to mount the route (fresh plugin instance over the same stubs),
	// with auto-mode on so an approval allow lands in the fresh ring buffer.
	resolved.set("model-fallback-auto", { enabled: true, autoAllowPermissions: true, workspaceLog: false });
	apply(ctx, { enabled: true, providers: ["p1", "p2"] });
	await new Promise((r) => setTimeout(r, 20));
	const route = webServerRoutes.find((entry) => entry.path === "/dsh-model-fallback/api/log");
	assert(route !== undefined && route.kind === "exact", "log route registered at /dsh-model-fallback/api/log");

	// Drive a warn through the plugin (listener from the fresh apply).
	const freshApproval = approvalListeners.at(-1);
	await freshApproval({ agent: { session: { header: { cwd: undefined } } }, toolName: "bash", reason: "log e2e" }, async () => "unavailable");
	const chunks = [];
	const writeHead = (code, headers) => { chunks.push({ code, headers }); };
	const end = (body) => { chunks.push({ body }); };
	route.handler({ method: "GET" }, { writeHead, end });
	assert(chunks[0]?.code === 200 && chunks[0]?.headers?.["content-type"]?.startsWith("application/json"), "log route answers 200 JSON");
	const payload = JSON.parse(chunks[1].body);
	assert(Array.isArray(payload.events) && payload.events.length > 0, `log ring served (${payload.events.length} event(s))`);
	assert(payload.events[0].message.includes("bash"), "newest event is the auto-mode allow just driven");
	const times = payload.events.map((entry) => entry.at);
	assert(times.every((at, index) => index === 0 || times[index - 1] >= at), "events ordered newest first");
	// HEAD + method guard
	const headChunks = [];
	route.handler({ method: "HEAD" }, { writeHead: (c, h) => headChunks.push({ c, h }), end: (b) => headChunks.push({ b }) });
	assert(headChunks[0]?.c === 200 && (headChunks[1]?.b === undefined || headChunks[1]?.b === ""), "HEAD answers 200 without a body");
	const methodChunks = [];
	route.handler({ method: "POST" }, { writeHead: (c) => methodChunks.push(c), end: () => {} });
	assert(methodChunks[0] === 405, "non-GET methods answer 405");
	resolved.set("model-fallback-auto", { enabled: false });
	delete ctx.webServer;
}

assert(name === "model-fallback", "plugin name exported");
console.log(process.exitCode ? "SMOKE TEST FAILED" : "SMOKE TEST PASSED");
//#endregion
