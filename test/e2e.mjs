/**
 * dsh-model-fallback — in-process end-to-end test.
 *
 * Loads the REAL plugin through apply() against a host stub whose llm service
 * mirrors dsh-llm's observable semantics:
 *
 *   1. stream(options) runs the `llm/stream` waterfall with the adapter as the
 *      fallback — exactly LlmRuntime.streamWithRegistration.
 *   2. adapterStream normalizes EVERY upstream throw into a terminal error
 *      finish chunk — exactly LlmRuntime.adapterStream ("iteration failures
 *      become terminal error finish chunks"), so 403/500 reach plugin
 *      listeners as finish chunks in production and here.
 *   3. The simulated agent loop drains the stream and, on a surfaced error
 *      finish, runs the `agent/request-error` waterfall (the loop's request
 *      recovery extension point) and re-issues the whole request on
 *      { kind: "retry" } — mirroring dsh-agent-loop + dsh-llm-retry.
 *
 * Scenarios: 403/500 pre-content switch-and-recover, mid-stream 500 recovered
 * by loop-level retry, unselected-provider protection on/off, cold-cache
 * engagement, and chain exhaustion.
 */
import { apply, __clearHealthCache } from "../lib/index.js";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const failures = [];
const assert = (condition, message) => {
	if (condition) console.log(`ok: ${message}`);
	else {
		console.error(`FAIL: ${message}`);
		failures.push(message);
	}
};

/** Read the plugin's event ring through the registered /api/log route. */
async function readRing() {
	const handler = routes.get("/dsh-model-fallback/api/log");
	if (typeof handler !== "function") throw new Error("log route not registered");
	let body = null;
	handler({ method: "GET" }, {
		writeHead() {},
		end(data) {
			body = data;
		},
	});
	return JSON.parse(body).events;
}

//#region faithful sessions service
/** sessionId -> { events: [], appended: [], append(type,data), events.findLast works } */
const sessionStore = new Map();
function makeSession(id) {
	const events = [{ type: "turn/start", data: { turn: 3 } }, { type: "step/start", data: { step: 3 } }];
	const appended = [];
	return {
		id,
		events,
		appended,
		append(type, data) {
			appended.push({ type, data });
			events.push({ type, data });
		},
	};
}
const sessions = {
	get: (id) => sessionStore.get(id),
};
//#endregion

//#region faithful llm service
const DEFAULT_CODES = ["NETWORK_ERROR", "TIMEOUT", "CONNECTION_CLOSED", "RATE_LIMITED", "SERVER_ERROR", "500", "502", "503", "504"];

/** Upstream scripts: "provider/model" -> behavior per attempt. */
const scripts = new Map();
const adapterCalls = [];

function errorFinish(code, message) {
	return { type: "finish", reason: { kind: "error", failure: { code, message } } };
}
function stopFinish() {
	return { type: "finish", reason: { kind: "stop", usage: {} } };
}
function textDelta(text) {
	return { type: "text-delta", text };
}

/** Faithful adapterStream: catches every throw into an error finish chunk. */
function adapterStream(options) {
	adapterCalls.push(`${options.provider}/${options.model}`);
	const key = `${options.provider}/${options.model}`;
	const behavior = scripts.get(key) ?? (() => ({ kind: "error", code: "UNKNOWN_MODEL", message: `no script for ${key}` }));
	const iterator = (async function* () {
		const outcome = behavior();
		if (outcome.kind === "throw") throw Object.assign(new Error(outcome.message), typeof outcome.code === "string" ? { code: outcome.code } : {});
		if (outcome.kind === "error") {
			yield errorFinish(outcome.code, outcome.message);
			return;
		}
		if (outcome.kind === "hung") {
			await new Promise(() => {}); // never resolves — simulates a dead transport
			return;
		}
		if (outcome.kind === "mid-throw") {
			yield textDelta(outcome.partial);
			throw new Error(outcome.message);
		}
		if (outcome.kind === "ok") {
			yield textDelta(outcome.text);
			yield stopFinish();
			return;
		}
	})();
	// Normalize throws the way dsh-llm does: the consumer only ever sees
	// chunks, never exceptions.
	return (async function* () {
		let wrapped;
		try {
			wrapped = iterator[Symbol.asyncIterator]();
		} catch (error) {
			yield errorFinish("UNKNOWN", String(error?.message ?? error));
			return;
		}
		while (true) {
			try {
				const next = await wrapped.next();
				if (next.done) return;
				yield next.value;
			} catch (error) {
				// Mirror normalizeLlmFailure: a carried LlmError code survives;
				// a plain Error falls back to a generic code.
				yield errorFinish(typeof error?.code === "string" ? error.code : "SERVER_ERROR", String(error?.message ?? error));
				return;
			}
		}
	})();
}

/** Minimal waterfall with dsh's listener chaining. */
function waterfall(listeners, payload, fallback) {
	const run = (index) => (index >= listeners.length ? fallback() : listeners[index](payload, () => run(index + 1)));
	return run(0);
}

const llmListeners = new Map();
const llm = {
	listProviders: () => [...catalogs.keys()].map((id) => ({ id, name: id })),
	listModels: async (provider) => {
		const catalog = catalogs.get(provider);
		if (catalog === undefined) throw new Error(`no registration for provider "${provider}"`);
		return catalog.map((id) => ({ id, name: id }));
	},
	adapterStream,
	stream(options) {
		return waterfall(llmListeners.get("llm/stream") ?? [], options, () => adapterStream(options));
	},
};
const catalogs = new Map([
	["modlens-openrouter", ["m-a", "m-b", "m-ok"]],
	["modlens-jiyuanlvdong", ["m-c"]],
	["openrouter", ["m-raw"]],
	["boom", []],
]);
//#endregion

//#region host stub
const log = [];
const logger = {
	warn: (...args) => log.push(["warn", args.join(" ")]),
	info: (...args) => log.push(["info", args.join(" ")]),
	error: (...args) => log.push(["error", args.join(" ")]),
};

const allListeners = new Map();
const ctx = {
	fiber: { state: 0 },
	logger,
	llm,
	on(eventName, listener) {
		if (!allListeners.has(eventName)) allListeners.set(eventName, []);
		allListeners.get(eventName).push(listener);
		if (eventName === "llm/stream") llmListeners.set("llm/stream", allListeners.get(eventName));
		return () => {};
	},
	effect(factory) {
		return typeof factory?.() === "function" ? factory() : undefined;
	},
	inject(deps, callback) {
		if (Array.isArray(deps) && deps.includes("webServer")) {
			callback({ ...ctx, webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {}; } } });
			return;
		}
		if (Array.isArray(deps) && deps.includes("sessions")) {
			callback({ ...ctx, sessions });
			return;
		}
		callback(ctx);
	},
	get() {
		return undefined;
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
	},
};
const registered = new Map();
/** Routes the plugin registered on the webServer ("/dsh-model-fallback/api/log" etc.). */
const routes = new Map();
const resolved = new Map([
	[
		"model-fallback",
		{
			enabled: true,
			providers: ["modlens-jiyuanlvdong", "modlens-openrouter"],
			protectUnselected: true,
			allProvidersFallback: false,
			retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES },
		},
	],
]);
const watchers = [];

apply(ctx, {});
await new Promise((resolve) => setTimeout(resolve, 30));
//#endregion

//#region simulated agent loop
function request(options) {
	return waterfall(llmListeners.get("llm/stream") ?? [], options, () => adapterStream(options));
}

async function drain(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return chunks;
}

/**
 * One agent turn: drain the (possibly wrapped) stream; when an error finish
 * surfaces, run the agent/request-error recovery waterfall exactly like the
 * loop does and re-issue the whole request on { kind: "retry" }.
 */
async function agentTurn(options, { maxAttempts = 8 } = {}) {
	const session = { events: [{ type: "turn/start", data: { turn: 3 } }, { type: "step/start", data: { step: 3 } }], append(type, data) { this.events.push({ type, data }); } };
	if (typeof options.sessionId === "string" && options.sessionId.length > 0) sessionStore.set(options.sessionId, session);
	const agent = { session };
	for (let step = 1; step <= maxAttempts; step += 1) {
		const chunks = await drain(request(options));
		const last = chunks.at(-1);
		if (!last || last.type !== "finish" || last.reason?.kind !== "error") return { ok: true, chunks, session };
		const outcome = await waterfall(
			allListeners.get("agent/request-error") ?? [],
			{ agent, turn: 1, step, provider: options.provider, failure: last.reason.failure, signal: undefined },
			() => undefined,
		);
		if (!outcome || outcome.kind !== "retry") return { ok: false, failure: last.reason.failure, chunks, session };
	}
	return { ok: false, exhausted: true, session };
}
//#endregion

//#region scenarios
const clearHealth = () => __clearHealthCache();
{
	// 1.
	// 403 pre-content on a selected group model -> switch through the chain
	clearHealth();
	//    and recover on the first healthy candidate.
	scripts.set("modlens-jiyuanlvdong/m-c", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-a", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-b", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-ok", () => ({ kind: "ok", text: "recovered from 403" }));
	const result = await agentTurn({ provider: "modlens-openrouter", model: "m-a", messages: [] });
	assert(result.ok, "403 scenario: turn completes");
	assert(result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "recovered from 403"), "403 scenario: recovered via chain switch");
	assert(log.some(([, line]) => line.includes("switching to")), "403 scenario: switch logged");
	assert(log.some(([, line]) => line.includes("request recovered on modlens-openrouter/m-ok")), "403 scenario: recovery logged");
	// PROOF the model really switched: the adapter boundary was dispatched with
	// the requested model first, then the OTHER models, ending on the winner.
	const switched = adapterCalls.filter((call) => call.startsWith("modlens-"));
	assert(
		switched[0] === "modlens-openrouter/m-a" &&
			switched.includes("modlens-jiyuanlvdong/m-c") &&
			switched.includes("modlens-openrouter/m-b") &&
			switched.at(-1) === "modlens-openrouter/m-ok",
		`403 scenario: adapter dispatched every candidate in order (${switched.join(" -> ")})`,
	);
}

{
	// 2.
	// 500 as a THROWN exception (normalized to an error finish chunk by the
	clearHealth();
	//    adapter boundary, exactly like dsh-llm) -> switch and recover.
	scripts.set("modlens-openrouter/m-a", () => ({ kind: "throw", message: "500 internal server error" }));
	const result = await agentTurn({ provider: "modlens-openrouter", model: "m-a", messages: [] });
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "recovered from 403"), "thrown 500 scenario: recovered via chain switch");
}

{
	// 3.
	// Mid-stream 500: partial content already surfaced -> the request-level
	clearHealth();
	//    wrapper passes it through; the loop-level retry re-issues the whole
	//    request and the second attempt succeeds.
	let attempt = 0;
	scripts.set("modlens-openrouter/m-a", () => {
		attempt += 1;
		return attempt === 1 ? { kind: "mid-throw", partial: "half an answer", message: "500 mid-stream" } : { kind: "ok", text: "full answer after retry" };
	});
	const result = await agentTurn({ provider: "modlens-openrouter", model: "m-a", messages: [] });
	assert(result.ok, "mid-stream 500 scenario: turn completes");
	assert(result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "full answer after retry"), "mid-stream 500 scenario: loop retry re-issued and recovered");
	assert(result.session.events.some((event) => event.type === "llm/retry"), "mid-stream 500 scenario: llm/retry event appended");
	assert(log.some(([, line]) => line.includes("loop retry 1/3")), "mid-stream 500 scenario: loop retry logged");
}

{
	// 4.
	// Unselected raw provider (openrouter) with protectUnselected ON (default):
	clearHealth();
	//    the wrapper engages, the requested model leads, selected groups follow.
	scripts.set("openrouter/m-raw", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-jiyuanlvdong/m-c", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-a", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-b", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-ok", () => ({ kind: "ok", text: "recovered from 403" }));
	const result = await agentTurn({ provider: "openrouter", model: "m-raw", messages: [] });
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "recovered from 403"), "unselected provider: protected by default, recovered through selected groups");
	assert(log.some(([, line]) => line.includes("engaged for openrouter/m-raw")), "unselected provider: engagement decision logged");
}

{
	// 5.
	// 5b. protectUnselected OFF: the raw provider passes through untouched.
	clearHealth();
	resolved.set("model-fallback", { ...resolved.get("model-fallback"), protectUnselected: false });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	scripts.set("openrouter/m-raw", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	const result = await agentTurn({ provider: "openrouter", model: "m-raw", messages: [] });
	assert(!result.ok && result.failure?.code === "AUTH_FAILED", "protectUnselected off: unselected provider failure surfaces untouched");
	resolved.set("model-fallback", { ...resolved.get("model-fallback"), protectUnselected: true });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
}

{
	// 6.
	// Cold cache: a provider whose catalog refresh THROWS still gets a
	clearHealth();
	//    working wrapper — the single-candidate chain keeps the request-level
	//    retry armed and the same-model retry recovers.
	resolved.set("model-fallback", { enabled: true, providers: ["boom"], protectUnselected: true, allProvidersFallback: false, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	let attempt = 0;
	scripts.set("boom/m1", () => {
		attempt += 1;
		return attempt === 1 ? { kind: "error", code: "NETWORK_ERROR", message: "connection reset" } : { kind: "ok", text: "cold-cache retry recovered" };
	});
	const result = await agentTurn({ provider: "boom", model: "m1", messages: [] });
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "cold-cache retry recovered"), "cold cache: single-candidate chain still recovers via same-model retry");
	assert(log.some(([, line]) => line.includes("engaged for boom/m1, chain=1")), "cold cache: single-candidate engagement logged");
}

{
	// 6b. TRANSPORT — dsh-llm-deepseek's connection-failure code — is retried
	//     even when the user's explicit code list omits it (built-in floor).
	resolved.set("model-fallback", { enabled: true, providers: ["boom"], protectUnselected: true, allProvidersFallback: false, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: ["NETWORK_ERROR"] } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	let transportAttempt = 0;
	scripts.set("boom/m1", () => {
		transportAttempt += 1;
		return transportAttempt === 1 ? { kind: "throw", message: "terminated", code: "TRANSPORT" } : { kind: "ok", text: "transport floor recovered" };
	});
	const transportResult = await agentTurn({ provider: "boom", model: "m1", messages: [] });
	assert(transportResult.ok && transportResult.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "transport floor recovered"), "TRANSPORT floor: retried despite an explicit list without it");
}

{
	// 7.
	// Chain exhausted with a persistent (non-retryable) code: the failure
	clearHealth();
	//    surfaces after every candidate was tried.
	resolved.set("model-fallback", { enabled: true, providers: ["modlens-openrouter"], protectUnselected: true, retry: { enabled: true, loopRetry: true, maxRetries: 2, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	for (const model of ["m-a", "m-b", "m-ok"]) scripts.set(`modlens-openrouter/${model}`, () => ({ kind: "error", code: "AUTH_FAILED", message: "403 everywhere" }));
	const result = await agentTurn({ provider: "modlens-openrouter", model: "m-a", messages: [] });
	assert(!result.ok && result.failure?.code === "AUTH_FAILED", "exhaustion: persistent 403 surfaces after the chain is spent");
	assert(log.some(([, line]) => line.includes("exhausted")), "exhaustion: logged");
}
//#endregion

{
	// 8.
	// PI_AI_ERROR is a catch-all code: transient class comes from the
	clearHealth();
	//    message. A mid-stream "502 status code" PI_AI_ERROR is retried by the
	//    loop-level recovery even though PI_AI_ERROR is not in the code list.
	resolved.set("model-fallback", { enabled: true, providers: ["boom"], protectUnselected: true, allProvidersFallback: false, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: ["NETWORK_ERROR"] } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	let piaiAttempt = 0;
	scripts.set("boom/m1", () => {
		piaiAttempt += 1;
		return piaiAttempt === 1 ? { kind: "mid-throw", partial: "partial", message: "502 status code (no body)", code: "PI_AI_ERROR" } : { kind: "ok", text: "pi-ai 502 recovered" };
	});
	const piaiResult = await agentTurn({ provider: "boom", model: "m1", messages: [] });
	assert(piaiResult.ok && piaiResult.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "pi-ai 502 recovered"), "PI_AI_ERROR 502: transient by message, loop-retried");
}

{
	// 9.
	// PI_AI_ERROR 402 (empty wallet) is persistent: not loop-retried.
	clearHealth();
	resolved.set("model-fallback", { enabled: true, providers: ["boom"], protectUnselected: true, allProvidersFallback: false, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: ["NETWORK_ERROR"] } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	scripts.set("boom/m1", () => ({ kind: "error", code: "PI_AI_ERROR", message: "402 status code (no body)" }));
	const result = await agentTurn({ provider: "boom", model: "m1", messages: [] });
	assert(!result.ok && result.failure?.code === "PI_AI_ERROR", "PI_AI_ERROR 402: persistent, surfaces without same-model retry");
}

{
	// 10.
	clearHealth();
	// 10. allProvidersFallback: the selected group is fully down, but another
	//     configured provider has a healthy model — the tail pool saves the task.
	resolved.set("model-fallback", { enabled: true, providers: ["boom"], protectUnselected: true, allProvidersFallback: true, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: ["NETWORK_ERROR"] } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	scripts.set("boom/m1", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-jiyuanlvdong/m-c", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-a", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-b", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-ok", () => ({ kind: "ok", text: "saved by the tail pool" }));
	const saved = await agentTurn({ provider: "boom", model: "m1", messages: [] });
	assert(saved.ok && saved.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "saved by the tail pool"), "allProvidersFallback on: tail pool recovers the task");
}

{
	// 11.
	clearHealth();
	// 10b. allProvidersFallback off: the tail pool is skipped and exhaustion surfaces.
	resolved.set("model-fallback", { enabled: true, providers: ["boom"], protectUnselected: true, allProvidersFallback: false, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: ["NETWORK_ERROR"] } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	const result = await agentTurn({ provider: "boom", model: "m1", messages: [] });
	assert(!result.ok && result.failure?.code === "AUTH_FAILED", "allProvidersFallback off: exhaustion surfaces without the tail pool");
	resolved.set("model-fallback", { ...resolved.get("model-fallback"), allProvidersFallback: true });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
}

{
	// 12.
	// The user's exact cross-API-key question: reth-dai/glm-5.3 fails with
	clearHealth();
	//     403 and the chain continues on reth-ruijie/glm-5.3-flash — a DIFFERENT
	//     provider registration (its own credentials), same as production where
	//     reth-main 503 switched to modlens-jiyuanlvdong at 18:40:25.
	catalogs.set("reth-dai", ["glm-5.3"]);
	catalogs.set("reth-ruijie", ["glm-5.3-flash"]);
	resolved.set("model-fallback", { enabled: true, providers: ["reth-dai", "reth-ruijie"], protectUnselected: false, allProvidersFallback: false, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	adapterCalls.length = 0;
	scripts.set("reth-dai/glm-5.3", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("reth-ruijie/glm-5.3-flash", () => ({ kind: "ok", text: "cross-key recovery on reth-ruijie" }));
	const result = await agentTurn({ provider: "reth-dai", model: "glm-5.3", messages: [] });
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "cross-key recovery on reth-ruijie"), "cross-API-key: reth-dai/glm-5.3 -> reth-ruijie/glm-5.3-flash recovers the task");
	assert(adapterCalls[0] === "reth-dai/glm-5.3" && adapterCalls[1] === "reth-ruijie/glm-5.3-flash", `adapter dispatched across providers in order (${adapterCalls.slice(0, 2).join(" -> ")})`);
	assert(log.some(([, line]) => line.includes("reth-dai/glm-5.3 failed") && line.includes("switching to reth-ruijie/glm-5.3-flash")), "cross-API-key switch logged");
}

{
	// 13.
	// Liveness watchdog: a request that produces NOTHING for longer than
	clearHealth();
	//     idleTimeoutMs is terminated by the watchdog (WATCHDOG_IDLE), the
	//     chain switches, and the task continues — no more stuck runs.
	catalogs.set("watchdog-test", ["hung-model", "healthy-model"]);
	resolved.set("model-fallback", { enabled: true, providers: ["watchdog-test"], protectUnselected: false, allProvidersFallback: false, watchdog: { enabled: true, idleTimeoutMs: 150 }, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	scripts.set("watchdog-test/hung-model", () => ({ kind: "hung" }));
	scripts.set("watchdog-test/healthy-model", () => ({ kind: "ok", text: "watchdog re-activated the task" }));
	const started = Date.now();
	const result = await agentTurn({ provider: "watchdog-test", model: "hung-model", messages: [] });
	const elapsed = Date.now() - started;
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "watchdog re-activated the task"), "watchdog: hung request terminated and task re-activated on the next candidate");
	assert(elapsed < 5000, `watchdog: re-activation was fast (${elapsed} ms)`);
	assert(log.some(([, line]) => line.includes("WATCHDOG_IDLE") || line.includes("switching to watchdog-test/healthy-model")), "watchdog: idle termination logged");
}

{
	// 14.
	// Watchdog off: a hung request stays hung (no synthesized failure).
	clearHealth();
	resolved.set("model-fallback", { enabled: true, providers: ["watchdog-test"], protectUnselected: false, allProvidersFallback: false, watchdog: { enabled: false, idleTimeoutMs: 100 }, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	scripts.set("watchdog-test/hung-model", () => ({ kind: "hung" }));
	scripts.delete("watchdog-test/healthy-model");
	let hungResolved = false;
	// Fire-and-forget: with the watchdog off the turn stays stuck by design —
	// the pending promise never settles and the process must not wait on it.
	void agentTurn({ provider: "watchdog-test", model: "hung-model", messages: [] }).then(() => {
		hungResolved = true;
	});
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert(!hungResolved, "watchdog off: a hung request stays hung (by design)");
}

{
	// 15.
	// Patience order for silent models (the user's requirement): the same
	clearHealth();
	//     model is re-sent `resends` times before the chain moves on —
	//     adapter order: hung, hung, hung, healthy.
	resolved.set("model-fallback", { enabled: true, providers: ["watchdog-test"], protectUnselected: false, allProvidersFallback: false, watchdog: { enabled: true, idleTimeoutMs: 120, resends: 2 }, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	adapterCalls.length = 0;
	scripts.set("watchdog-test/hung-model", () => ({ kind: "hung" }));
	scripts.set("watchdog-test/healthy-model", () => ({ kind: "ok", text: "patience recovery" }));
	const result = await agentTurn({ provider: "watchdog-test", model: "hung-model", messages: [] });
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "patience recovery"), "patience: task recovers after the resend budget");
	const order = adapterCalls.filter((call) => call.startsWith("watchdog-test/"));
	assert(
		JSON.stringify(order) === JSON.stringify(["watchdog-test/hung-model", "watchdog-test/hung-model", "watchdog-test/hung-model", "watchdog-test/healthy-model"]),
		`patience: same model re-sent before switching (${order.join(" -> ")})`,
	);
	assert(log.some(([, line]) => line.includes("re-sending watchdog-test/hung-model (1/2)")), "resend logged");
}

{
	// 16.
	// Wallet-empty (402) on one route skips the whole ACCOUNT (route + its
	clearHealth();
	//     modlens wrapper share the wallet) and jumps to another account's
	//     models — exactly the "switch to another API key's group" requirement.
	catalogs.set("wallet-a", ["w1", "w2"]);
	catalogs.set("wallet-b", ["x1"]);
	resolved.set("model-fallback", { enabled: true, providers: ["wallet-a", "wallet-b"], protectUnselected: false, allProvidersFallback: false, watchdog: { enabled: true, idleTimeoutMs: 120, resends: 0 }, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	adapterCalls.length = 0;
	scripts.set("wallet-a/w1", () => ({ kind: "error", code: "PI_AI_ERROR", message: "402 status code (no body)" }));
	scripts.set("wallet-a/w2", () => ({ kind: "error", code: "PI_AI_ERROR", message: "402 status code (no body)" }));
	scripts.set("wallet-b/x1", () => ({ kind: "ok", text: "other wallet serves" }));
	const result = await agentTurn({ provider: "wallet-a", model: "w1", messages: [] });
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "other wallet serves"), "wallet-empty: task continues on another account");
	assert(
		JSON.stringify(adapterCalls) === JSON.stringify(["wallet-a/w1", "wallet-b/x1"]),
		`wallet-empty: same-account w2 skipped, jumped straight to the other key (${adapterCalls.join(" -> ")})`,
	);
	assert(log.some(([, line]) => line.includes("skipping its remaining 1 candidate(s)")), "wallet-empty: account skip logged");
	resolved.set("model-fallback", { ...resolved.get("model-fallback"), allProvidersFallback: false });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
}

{
	// Switch visibility: every pre-content switch must append an llm/retry row
	// (plus llm/retry-started) into the requesting session so the conversation
	// renders the whole fallback journey — not a silent pill. All switches in one
	// request share a single retryId, so the UI shows ONE expanding retry chain.
	clearHealth();
	resolved.set("model-fallback", {
		enabled: true,
		providers: ["modlens-jiyuanlvdong", "modlens-openrouter"],
		protectUnselected: true,
		allProvidersFallback: false,
		retry: { enabled: true, loopRetry: true, maxRetries: 1, baseDelayMs: 5, retryableCodes: DEFAULT_CODES },
	});
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	scripts.set("modlens-openrouter/m-a", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-jiyuanlvdong/m-c", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-b", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-ok", () => ({ kind: "ok", text: "visible switch recovered" }));
	const result = await agentTurn({ provider: "modlens-openrouter", model: "m-a", sessionId: "sess-switch", messages: [] });
	assert(result.ok && result.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "visible switch recovered"), "switch-visibility: turn completes through the chain");
	const session = sessionStore.get("sess-switch");
	const retries = session.events.filter((entry) => entry.type === "llm/retry");
	const started = session.events.filter((entry) => entry.type === "llm/retry-started");
	assert(retries.length === 3, `switch-visibility: one llm/retry row per switch (${retries.length})`);
	assert(started.length === 3, `switch-visibility: llm/retry-started marks each takeover running (${started.length})`);
	const ids = new Set(retries.map((entry) => entry.data.retryId));
	assert(ids.size === 1 && retries[0].data.retryId.length > 0, "switch-visibility: all switches share ONE retry-chain id");
	assert(
		JSON.stringify(retries.map((entry) => entry.data.retry)) === JSON.stringify([1, 2, 3]),
		"switch-visibility: retry counters ascend across the chain",
	);
	assert(retries[0].data.turn === 3 && retries[0].data.step === 3, "switch-visibility: rows attach to the live turn/step");
	assert(/switching to /.test(retries[0].data.failure?.message ?? ""), "switch-visibility: each row names the model taking over");

	// Session attribution: ring entries served at /api/log carry the sessionId
	// of the conversation that produced them, so the client bubble feed can
	// scope every bubble to one conversation page.
	const ring = await readRing();
	const switchEntry = ring.find((entry) => entry.message.includes("switching to"));
	assert(switchEntry !== undefined, "session-attribution: switch entry present in the ring");
	assert(switchEntry.sessionId === "sess-switch", `session-attribution: switch entry carries the requesting session id (${switchEntry.sessionId})`);
	const recoveredSwitchEntry = ring.find((entry) => /request recovered on .+ after \d+ switch\(es\)/.test(entry.message));
	assert(recoveredSwitchEntry?.sessionId === "sess-switch", `session-attribution: recovery entry carries the session id (${recoveredSwitchEntry?.sessionId})`);
	const unattributed = ring.filter((entry) => entry.message.includes("fallback loop armed"));
	assert(unattributed.length > 0 && unattributed.every((entry) => entry.sessionId === undefined), "session-attribution: host-level entries carry no session id");
}

{
	// 18.
	// Auto-mode approval gate: with full-auto on, an approval/request for a
	// session is answered allowed-once AND the ring entry carries THAT
	// session's id — the bubble then shows on that conversation page only.
	clearHealth();
	resolved.set("model-fallback-auto", { enabled: true, autoAllowPermissions: true, autoAnswerQuestions: true, autoApprovePlans: true });
	const approvalListeners = allListeners.get("approval/request") ?? [];
	assert(approvalListeners.length === 1, `auto-approval: gate registered (${approvalListeners.length})`);
	const requestRoot = await mkdtemp(join(tmpdir(), "dshmfb-e2e-"));
	const outcome = await approvalListeners[0]({ toolName: "write", reason: "e2e auto approval", agent: { session: { header: { id: "sess-approve", cwd: requestRoot } } } }, () => "ask-human");
	assert(outcome === "allowed-once", "auto-approval: permission answered allowed-once");
	const ring = await readRing();
	const approvalEntry = ring.find((entry) => entry.message.includes(`permission for "write" auto-allowed`));
	assert(approvalEntry !== undefined, "auto-approval: decision recorded in the ring");
	assert(approvalEntry.sessionId === "sess-approve", `auto-approval: entry carries the requesting session id (${approvalEntry.sessionId})`);
	// Gate off: the same request falls through to the host runtime untouched.
	resolved.set("model-fallback-auto", { enabled: false });
	const passthrough = await approvalListeners[0]({ toolName: "write", agent: { session: { header: { id: "sess-approve" } } } }, () => "ask-human");
	assert(passthrough === "ask-human", "auto-approval: gate off delegates to the host runtime");
}

{
	// 19.
	// Real-time toggle: flipping the fallback master switch between requests
	// applies to the very next request — no re-arm, no reload. The wrap
	// decision re-reads the resolved settings on every llm/stream event, and
	// the loop-level recovery honours the master switch too.
	clearHealth();
	resolved.set("model-fallback", { enabled: true, providers: ["boom"], protectUnselected: true, allProvidersFallback: true, retry: { enabled: true, loopRetry: true, maxRetries: 3, baseDelayMs: 5, retryableCodes: DEFAULT_CODES } });
	for (const watcher of watchers) watcher();
	await new Promise((resolve) => setTimeout(resolve, 10));
	scripts.set("boom/m1", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-jiyuanlvdong/m-c", () => ({ kind: "error", code: "AUTH_FAILED", message: "403 forbidden" }));
	scripts.set("modlens-openrouter/m-a", () => ({ kind: "ok", text: "wrapped while on" }));
	const on = await agentTurn({ provider: "boom", model: "m1", sessionId: "sess-rt", messages: [] });
	assert(on.ok && on.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "wrapped while on"), "real-time: fallback on — failing model switches to the healthy candidate");
	// Toggle OFF mid-task (what the composer pill write does): the next
	// request surfaces the error untouched — no switching, no loop retry.
	resolved.set("model-fallback", { ...resolved.get("model-fallback"), enabled: false });
	const off = await agentTurn({ provider: "boom", model: "m1", sessionId: "sess-rt", messages: [] });
	const offSession = sessionStore.get("sess-rt");
	assert(!off.ok && off.failure?.code === "AUTH_FAILED", "real-time: fallback off — next request surfaces the error untouched");
	assert(offSession !== undefined && offSession.events.every((event) => event.type !== "llm/retry"), "real-time: fallback off — loop-level recovery stays disarmed too");
	// Toggle back ON: wrapped again immediately.
	resolved.set("model-fallback", { ...resolved.get("model-fallback"), enabled: true });
	const again = await agentTurn({ provider: "boom", model: "m1", sessionId: "sess-rt", messages: [] });
	assert(again.ok && again.chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "wrapped while on"), "real-time: fallback on again — next request switches once more");
}

if (failures.length > 0) {
	console.error(`E2E TEST FAILED (${failures.length})`);
	process.exitCode = 1;
} else {
	console.log("E2E TEST PASSED");
}
