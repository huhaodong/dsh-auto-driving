import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

//#region lib/index.js
/**
 * dsh-model-fallback — provider-group model fallback for the DeepSeek Harness.
 *
 * The user selects one or more configured model providers ("provider groups")
 * in the plugin's own Settings tab. Every LLM request whose provider is in the
 * selection is wrapped at the `llm/stream` waterfall: when the requested model
 * fails with a terminal error BEFORE emitting any visible content, the request
 * transparently re-dispatches through the group's remaining models (in catalog
 * order, then the next selected provider), until one streams successfully. The
 * agent loop never sees the failed attempts, so the unfinished task continues
 * on the first working model.
 *
 * Attempts after the first bypass the `llm/stream` waterfall and dispatch
 * through `LlmRuntime.adapterStream()` directly — the innermost adapter
 * boundary. That keeps invariants, request logging, and checkpoint middleware
 * (which validated the original request header) untouched, while the assistant
 * message's model source still names the model that actually produced it.
 *
 * @module dsh-model-fallback
 */

/** Cordis plugin name used by loader diagnostics. */
const name = "model-fallback";

/** Services required before this plugin can activate. */
const inject = ["llm"];

/** Settings namespace carrying the fallback selection. */
const NS = settingsNamespace("model-fallback");

/** How long a provider's cached model catalog stays fresh. */
const MODEL_TTL_MS = 5 * 60 * 1000;
/** Re-attempt a catalog refresh this soon after the previous one threw. */
const REFRESH_ERROR_TTL_MS = 30 * 1000;
/** Throttle for per-route engagement decision lines. */
const DECISION_LOG_TTL_MS = 5 * 60 * 1000;
/**
 * Account key for one provider route: modlens wraps its upstream, so
 * "modlens-jiyuanlvdong" and "jiyuanlvdong" share one account (one API key,
 * one wallet). Account-level failures (402/401/403) skip every remaining
 * candidate of the same account instead of burning the chain on it.
 */
function accountKeyOf(route) {
	return typeof route === "string" && route.startsWith("modlens-") ? route.slice("modlens-".length) : route;
}
/**
 * Whether a failure class is account-level (auth/quota): the account itself
 * cannot serve — switching models WITHIN it is pointless; the chain must jump
 * to a different account's groups.
 */
function isAccountLevelFailure(code, message) {
	const upper = typeof code === "string" ? code.toUpperCase() : "";
	if (upper === "QUOTA") return true;
	// 402 (wallet empty) is account-wide; 401/403 may be model-scoped
	// permissions where the same account's other models still serve.
	if (typeof message === "string" && /\b402\b|insufficient credits|never purchased credits/i.test(message)) return true;
	return false;
}

/** Cooldowns for the health cache: wallet-dead accounts 10 min, sick models 90 s. */
const ACCOUNT_COOLDOWN_MS = 10 * 60 * 1000;
const MODEL_COOLDOWN_MS = 90 * 1000;
/** accountKey/route -> { until } — wallet-level circuit breaker. */
const accountHealth = new Map();
/** "provider\u0000model" -> { until } — model-level circuit breaker. */
const modelHealth = new Map();

/** Mark an account (route family) unhealthy until its cooldown elapses. */
function markAccountFailure(route) {
	accountHealth.set(accountKeyOf(route), { until: Date.now() + ACCOUNT_COOLDOWN_MS });
}
/** Mark one model unhealthy until its cooldown elapses. */
function markModelFailure(provider, model) {
	modelHealth.set(`${provider}\u0000${model}`, { until: Date.now() + MODEL_COOLDOWN_MS });
}
/** A candidate that just PRODUCED content is healthy — clear its breakers. */
function markModelHealthy(provider, model) {
	modelHealth.delete(`${provider}\u0000${model}`);
	accountHealth.delete(accountKeyOf(provider));
}
/** Whether the candidate (or its whole account) is inside a cooldown. */
function isCandidateBlocked(provider, model) {
	const now = Date.now();
	const account = accountHealth.get(accountKeyOf(provider));
	if (account && now < account.until) return "account";
	const entry = modelHealth.get(`${provider}\u0000${model}`);
	if (entry && now < entry.until) return "model";
	return null;
}
/**
 * Built-in transient floor: connection-level failures that are transient by
 * definition. These are retryable EVEN when the user configured an explicit
 * code list that omits them — an explicit list narrows the policy, it must not
 * be able to strand a task on a dropped connection. TRANSPORT is dsh-llm's
 * vocabulary for "the provider stream connection failed" (deepseek adapter).
 */
const RETRY_FLOOR_CODES = ["TRANSPORT", "NETWORK_ERROR", "TIMEOUT", "CONNECTION_CLOSED", "WATCHDOG_IDLE"];
/**
 * Catch-all adapter codes (e.g. pi-ai's PI_AI_ERROR) hide the real class in
 * the message text — "PI_AI_ERROR: 502 status code" is a transient gateway
 * blip while "PI_AI_ERROR: 402 status code" is an empty wallet. Classify by
 * message before trusting the coarse code.
 */
const TRANSIENT_MESSAGE_RE = /\b(?:429|5\d\d)\b|timeout|timed out|econn|socket|network|terminated|reset|temporarily/i;

/** Default codes that qualify as retryable non-model errors. */
const DEFAULT_RETRYABLE_CODES = [
	"NETWORK_ERROR",
	"TRANSPORT",
	"TIMEOUT",
	"CONNECTION_CLOSED",
	"RATE_LIMITED",
	"SERVER_ERROR",
	"500",
	"502",
	"503",
	"504",
];

/** Runtime schema for the settings section (mirrored by the Settings tab). */
const Config = z.object({
	/** Master switch; the loop only runs when enabled and a group is selected. */
	enabled: z.boolean().default(true),
	/** Selected provider routes in loop priority order (first = tried first). */
	providers: z.array(z.string()).default([]),
	/**
	 * Wrap requests whose provider is OUTSIDE the selected groups too: the
	 * requested model leads the chain and the selected groups serve as the
	 * candidate pool, so every request carries a recovery net.
	 */
	protectUnselected: z.boolean().default(true),
	/**
	 * Append every OTHER configured provider's catalog to the candidate pool
	 * after the selected groups. OFF by default: the fallback pool is exactly
	 * the selected groups (unselected providers are excluded unless this
	 * last-resort tail is explicitly enabled).
	 */
	allProvidersFallback: z.boolean().default(false),
	/**
	 * Account-level arrears marker. When a wallet-level failure (402/quota)
	 * is detected, the whole account is recorded here and excluded from the
	 * fallback pool until the user manually clears the marker in Settings.
	 */
	arrears: z.dict(z.boolean()).default({}),
	/**
	 * Per-provider selected model pool. Keys are provider routes; values are the
	 * model ids that may be used as fallback candidates. A missing key means
	 * "all models in the catalog are allowed"; an empty array means the provider
	 * contributes no candidates.
	 */
	providerModels: z.dict(z.array(z.string())).default({}),
	/**
	 * Liveness watchdog: a request that produces NO chunk (not even a
	 * keep-alive) for idleTimeoutMs is presumed hung. The watchdog closes the
	 * stream, logs, and the failure flows through the normal switch/retry
	 * machinery — stuck tasks are re-activated instead of waiting forever.
	 */
	watchdog: z
		.object({
			enabled: z.boolean().default(true),
			idleTimeoutMs: z.number().default(300000),
			resends: z.number().default(2),
		})
		.default({}),
	/** Task-level retry policy for non-model errors (same model, exponential backoff). */
	retry: z
		.object({
			/** Master switch for task retry. */
			enabled: z.boolean().default(true),
			/** Max retry attempts after the model fallback chain is exhausted. */
			maxRetries: z.number().min(0).default(3),
			/** Base delay in ms before the first retry; each retry doubles (cap 10 s). */
			baseDelayMs: z.number().min(0).default(500),
			/**
			 * Explicit retryable error codes. Empty means "retry everything that is
			 * not a known model error".
			 */
			retryableCodes: z.array(z.string()).default(DEFAULT_RETRYABLE_CODES),
			/**
			 * Loop-level recovery: when a request fails mid-stream (partial output
			 * already emitted), the agent loop discards the half message and re-issues
			 * the whole request on the same model. Shares maxRetries/baseDelayMs.
			 */
			loopRetry: z.boolean().default(true),
		})
		.default({}),
});

/**
 * Full-auto mode settings (own namespace -> own Settings tab). When enabled,
 * the plugin answers every permission approval with `allowed-once`, answers
 * user questions with their declared/default option, and approves plan
 * reviews — so agent tasks never stall on human verification. Every automatic
 * decision is appended to `AUTO-MODE.md` in the session workspace.
 */
const NS_AUTO = settingsNamespace("model-fallback-auto");
/** Workspace file carrying the auto-operation audit trail. */
const AUTO_LOG_NAME = "AUTO-MODE.md";
const AUTO_LOG_HEADER = [
	"# \u26a1 \u5168\u81ea\u52a8\u6a21\u5f0f\u64cd\u4f5c\u5ba1\u8ba1\uff08dsh-model-fallback\uff09",
	"",
	"> \u672c\u6587\u4ef6\u7531\u63d2\u4ef6\u300c\u5168\u81ea\u52a8\u6a21\u5f0f\u300d\u81ea\u52a8\u5199\u5165\uff1a\u6240\u6709\u88ab\u81ea\u52a8\u5141\u8bb8\u7684\u6743\u9650\u5ba1\u6279\u4e0e\u81ea\u52a8\u5e94\u7b54\u7684\u4eba\u5de5\u786e\u8ba4\u90fd\u4f1a\u8bb0\u5f55\u5728\u6b64\u3002",
	"> \u5173\u95ed\u65b9\u6cd5\uff1a\u8bbe\u7f6e \u2192 \u5168\u81ea\u52a8\u6a21\u5f0f \u2192 \u5173\u95ed\u300c\u542f\u7528\u5168\u81ea\u52a8\u6a21\u5f0f\u300d\u3002",
	"",
	"| \u65f6\u95f4 | \u7c7b\u578b | \u5185\u5bb9 | \u7ed3\u679c |",
	"| --- | --- | --- | --- |",
	"",
].join("\n");
/** Model-facing notice while full-auto mode is on. */
const AUTO_PROMPT_SENTENCE = "Full-auto mode is ON (dsh-model-fallback plugin): permission approvals, confirmation questions, and plan reviews are answered automatically with the default-allow choice. Do not wait for a human; proceed with the task.";

/** Runtime schema for the full-auto settings tab. */
const AutoConfig = z.object({
	/** Master switch; every hook no-ops while false. */
	enabled: z.boolean().default(false),
	/** Auto-answer tool permission requests with allowed-once. */
	autoAllowPermissions: z.boolean().default(true),
	/** Auto-answer ask-user confirmation questions. */
	autoAnswerQuestions: z.boolean().default(true),
	/** Auto-approve plan reviews (exit_plan_mode). */
	autoApprovePlans: z.boolean().default(true),
	/** Append every automatic decision to AUTO-MODE.md in the workspace. */
	workspaceLog: z.boolean().default(true),
});

/**
 * Append one auto-decision to the workspace audit file. Fire-and-forget: a
 * logging failure must never break the approval flow it documents.
 * @param root - session workspace root (session.header.cwd); skipped when absent.
 * @param kind - human-readable decision class (e.g. "权限审批").
 * @param summary - what was auto-allowed / auto-answered.
 * @param outcome - the decision handed to the runtime.
 */
function auditAutoAction(root, kind, summary) {
	if (typeof root !== "string" || root.length === 0) return;
	const line = `| ${new Date().toISOString()} | ${kind} | ${summary.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ")} | \u5df2\u81ea\u52a8\u5141\u8bb8 |\n`;
	const file = join(root, AUTO_LOG_NAME);
	writeFile(file, AUTO_LOG_HEADER, { flag: "wx" })
		.catch(() => {})
		.then(() => appendFile(file, line))
		.catch(() => {});
}

/** Shorten a failure message for log lines. */
function truncate(text, max = 200) {
	const message = typeof text === "string" ? text : "";
	return message.length > max ? `${message.slice(0, max)}…` : message;
}

/**
 * Whether a stream chunk carries visible model output. Mirrors dsh-llm's
 * first-token boundary: empty deltas (heartbeats, empty tool-call frames) do
 * not count, so a model that fails before its first token is switchable.
 * @param chunk - one raw stream chunk.
 * @returns true when the chunk contains non-empty model output.
 */
function isContentChunk(chunk) {
	if (!chunk || typeof chunk !== "object") return false;
	switch (chunk.type) {
		case "text-delta":
		case "reasoning-delta":
			return typeof chunk.text === "string" ? chunk.text !== "" : true;
		case "tool-call-delta":
			return chunk.name !== undefined || (typeof chunk.argumentsDelta === "string" && chunk.argumentsDelta !== "");
		case "block-end":
			return true;
		default:
			return false;
	}
}

/** Test seam: forget every recorded failure (test isolation only). */
function __clearHealthCache() {
	accountHealth.clear();
	modelHealth.clear();
}

/**
 * @param ctx - host plugin context (`llm` service injected).
 * @param config - composition entry config from the bundle patch.
 */
/** Cap of the in-memory event ring buffer served to the settings page. */
const LOG_RING_CAP = 200;

function apply(ctx, config) {
	const logger = ctx.logger;
	/**
	 * Structured event ring buffer backing the settings-page log viewer: every
	 * warn/info line the plugin emits is captured here (newest last) and served
	 * as JSON at /dsh-model-fallback/api/log.
	 */
	const logRing = [];
	/** Live SSE subscribers (raw ServerResponse objects) for the real-time toast feed. */
	const sseClients = new Set();
	const recordEvent = (level, message) => {
		const entry = { at: new Date().toISOString(), level, message: String(message) };
		logRing.push(entry);
		if (logRing.length > LOG_RING_CAP) logRing.splice(0, logRing.length - LOG_RING_CAP);
		// Real-time push: every subscriber receives the event the instant it is
		// recorded (the client toast feed rides this). Dead sockets clean up via
		// their own close/error handlers.
		if (sseClients.size > 0) {
			const frame = `data: ${JSON.stringify(entry)}\n\n`;
			for (const client of sseClients) {
				try {
					client.write(frame);
				} catch {
					sseClients.delete(client);
				}
			}
		}
	};
	const rawLoggerInfo = logger.info.bind(logger);
	const rawLoggerWarn = logger.warn.bind(logger);
	logger.info = (...args) => {
		recordEvent("info", args.join(" "));
		return rawLoggerInfo(...args);
	};
	logger.warn = (...args) => {
		recordEvent("warn", args.join(" "));
		return rawLoggerWarn(...args);
	};
	/**
	 * Live sessions service (captured once available) so the wrapper can append
	 * `llm/retry` rows into the requesting conversation. Undefined until the
	 * sessions fiber is up; switch visibility simply stays off until then.
	 */
	let sessionsService;
	/** Optional settings service reference, used to persist runtime arrears.
	 *  Declared BEFORE the inject below: inject callbacks may run synchronously. */
	let settingsService = null;
	try {
		ctx.inject(["sessions"], (scope) => {
			sessionsService = scope.sessions;
		});
	} catch {
		// Without sessions the fallback machinery still works; only the
		// in-conversation switch rows are skipped.
	}
	try {
		ctx.inject(["settings"], (scope) => {
			settingsService = scope.settings;
		});
	} catch {
		// Settings service is optional; arrears will fall back to the
		// in-memory health cache.
	}
	/**
	 * Append an `llm/retry` event to the requesting session so the switch is
	 * rendered NATIVELY in the conversation stream (the same node the UI uses
	 * for its own model retries — "已重试模型请求" rows). Falls back silently
	 * when the request carries no sessionId or the session is unavailable.
	 */
	function appendRetryEvent(options, type, data) {
		try {
			const sessionId = typeof options?.sessionId === "string" ? options.sessionId : "";
			if (sessionId.length === 0) return;
			const sessions = sessionsService ?? (typeof ctx.get === "function" ? ctx.get("sessions") : undefined) ?? ctx.sessions;
			const session = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
			if (session === undefined || !Array.isArray(session.events) || typeof session.append !== "function") return;
			// Attach to the live turn/step so the row lands inside the right message.
			const turn = session.events.findLast((event) => event.type === "turn/start")?.data.turn ?? 0;
			const step = session.events.findLast((event) => event.type === "step/start")?.data.step ?? turn;
			session.append(type, { turn, step, ...data });
		} catch {
			// Rendering the switch is best-effort; the switch itself already happened.
		}
	}

	/** Settings-resolved config source; swapped by installSettingsSection. */
	let current = () => config ?? {};
	/** Mark one account as in arrears and persist the marker to settings. */
	function markArrears(accountKey) {
		if (typeof accountKey !== "string" || accountKey.length === 0) return;
		const cfg = current();
		if (cfg?.arrears?.[accountKey] === true) return;
		markAccountFailure(accountKey);
		if (settingsService && typeof settingsService.update === "function") {
			settingsService
				.update(NS, { arrears: { [accountKey]: true } })
				.catch((error) => logger.warn(`model-fallback: failed to persist arrears for ${accountKey}: ${error?.message ?? error}`));
		}
	}

	/** Provider route -> { at, models, error? } catalog cache. */
	const modelsCache = new Map();
	/** Provider routes with an in-flight catalog refresh. */
	const inflight = new Set();
	/** provider-route -> last decision-log time; one line per route per 5 min. */
	const decisionLogAt = new Map();

	/**
	 * One throttled decision line per route, so the host log always answers
	 * "is the plugin actually engaging for this provider?" without spamming.
	 */
	function logDecision(route, message) {
		const now = Date.now();
		if (now - (decisionLogAt.get(route) ?? 0) < DECISION_LOG_TTL_MS) return;
		decisionLogAt.set(route, now);
		logger.info(message);
	}
	/** Retry dispatch needs the adapter boundary; without it the plugin is inert. */
	const bypassSupported = typeof ctx.llm?.adapterStream === "function";
	if (!bypassSupported) {
		logger.warn("model-fallback: this dsh build exposes no llm.adapterStream(); the fallback loop stays disabled");
	}

	/**
	 * Warm the catalog cache for the selected providers. listModels is adapter
	 * catalog metadata (no network on the pi-ai adapter), but it is async while
	 * the `llm/stream` listener must return its wrapper synchronously, so
	 * requests read the last good snapshot and misses simply pass through.
	 */
	function scheduleRefresh(providers) {
		const now = Date.now();
		for (const provider of providers) {
			if (typeof provider !== "string" || provider.length === 0 || inflight.has(provider)) continue;
			const hit = modelsCache.get(provider);
			// A refresh that THREW is retried after the short error TTL; a real
			// catalog (even an empty one) keeps the full TTL.
			const ttl = hit?.error === true ? REFRESH_ERROR_TTL_MS : MODEL_TTL_MS;
			if (hit && now - hit.at < ttl) continue;
			inflight.add(provider);
			Promise.resolve()
				.then(() => ctx.llm.listModels(provider))
				.then((models) => {
					const clean = Array.isArray(models) ? models.filter((model) => model && typeof model.id === "string" && model.id.length > 0) : [];
					if (clean.length === 0) {
						logger.warn(`model-fallback: group "${provider}" lists 0 models; it contributes no fallback candidates (check the Models page or select the raw provider group)`);
					}
					modelsCache.set(provider, { at: Date.now(), models: clean });
				})
				.catch(() => {
					// Keep whatever was cached; mark the entry errored so the short
					// TTL re-attempts soon instead of locking an empty catalog for 5 min.
					modelsCache.set(provider, { at: Date.now(), models: modelsCache.get(provider)?.models ?? [], error: true });
				})
				.finally(() => inflight.delete(provider));
		}
	}

	/** Synchronously read one provider's cached catalog (empty while cold). */
	function modelsOf(provider) {
		const hit = modelsCache.get(provider);
		return hit ? hit.models : [];
	}

	/**
	 * Build the ordered candidate chain for one request, or null when the loop
	 * does not apply. The requested (provider, model) always leads; the selected
	 * groups' catalogs follow in the user's priority order, deduplicated. The
	 * chain is returned whenever it applies — even with a single candidate — so
	 * the request-level retry stays armed when catalogs are empty or cold; an
	 * empty catalog only shrinks the candidate pool, it never disarms the
	 * wrapper. Requests on unselected providers are wrapped too while
	 * `protectUnselected` is on (default): their model leads, the selected
	 * groups remain the candidate pool.
	 */
	function buildChain(options) {
		const cfg = current();
		if (!cfg || cfg.enabled !== true) return null;
		const selected = Array.isArray(cfg.providers) ? cfg.providers.filter((provider) => typeof provider === "string" && provider.length > 0) : [];
		if (selected.length === 0) return null;
		const provider = typeof options?.provider === "string" ? options.provider : "";
		if (provider.length === 0) return null;
		const inGroup = selected.includes(provider);
		if (!inGroup && cfg.protectUnselected === false) {
			logDecision(`skip:${provider}`, `model-fallback: not engaged for ${provider} (outside selected groups and protectUnselected is off)`);
			return null;
		}
		const model = typeof options?.model === "string" && options.model.length > 0 ? options.model : "";
		const chain = [];
		const seen = new Set();
		const push = (routeProvider, routeModel) => {
			if (routeProvider.length === 0 || routeModel.length === 0) return;
			const key = `${routeProvider}\u0000${routeModel}`;
			if (seen.has(key)) return;
			seen.add(key);
			chain.push({ provider: routeProvider, model: routeModel });
		};
		push(provider, model);
		// Echo switches (the same model id through another route — e.g.
		// jiyuanlvdong/glm-5.2 -> modlens-jiyuanlvdong/glm-5.2) share the upstream
		// account and fail identically, so they sort AFTER genuinely different
		// models: a switch should change something.
		const sameModelTail = [];
		let culledUnhealthy = 0;
		const pushCandidate = (routeProvider, routeModel) => {
			const key = `${routeProvider}\u0000${routeModel}`;
			if (seen.has(key)) return;
			seen.add(key);
			// The originally requested model always leads so the first real attempt
			// matches the user's explicit choice; every other candidate is filtered.
			const headItself = routeProvider === provider && routeModel === model;
			if (!headItself) {
				// Fast-path: candidates inside a health cooldown are culled BEFORE any
				// dispatch — the pool is searched without paying for known-dead calls.
				if (isCandidateBlocked(routeProvider, routeModel) !== null) {
					culledUnhealthy += 1;
					return;
				}
				// Accounts manually marked as in arrears (wallet/auth failures) stay
				// out of the fallback pool until the user clears the marker.
				if (cfg?.arrears?.[accountKeyOf(routeProvider)] === true) {
					culledUnhealthy += 1;
					return;
				}
				// Respect per-provider model selection: unchecked models are skipped.
				const allowedModels = cfg?.providerModels?.[routeProvider];
				if (Array.isArray(allowedModels) && !allowedModels.includes(routeModel)) return;
			}
			if (routeModel === model && routeProvider !== provider) sameModelTail.push({ provider: routeProvider, model: routeModel });
			else chain.push({ provider: routeProvider, model: routeModel });
		};
		for (const route of selected) {
			for (const candidate of modelsOf(route)) pushCandidate(route, candidate.id);
		}
		const extraRoutes = [];
		if (cfg.allProvidersFallback !== false && typeof ctx.llm?.listProviders === "function") {
			try {
				for (const entry of ctx.llm.listProviders()) {
					const id = typeof entry?.id === "string" ? entry.id : typeof entry?.provider === "string" ? entry.provider : "";
					if (id.length === 0 || id === provider || selected.includes(id) || extraRoutes.includes(id)) continue;
					extraRoutes.push(id);
					for (const candidate of modelsOf(id)) pushCandidate(id, candidate.id);
				}
			} catch {
				// Enumeration is best-effort; the selected groups already form the pool.
			}
		}
		for (const echo of sameModelTail) chain.push(echo);
		scheduleRefresh(selected.concat(extraRoutes));
		logDecision(
			`engage:${provider}`,
			`model-fallback: engaged for ${provider}/${model || "?"}, chain=${chain.length} candidate(s)${culledUnhealthy > 0 ? `, ${culledUnhealthy} culled by cache/arrears/selection` : ""}${inGroup ? "" : " (outside selected groups; protectUnselected on)"}`,
		);
		return chain;
	}

	/**
		 * Whether an error code is retryable as a non-model exception.
		 * @param code - the failure code from a finish chunk.
		 * @param explicitCodes - user-configured retryable codes (may be empty).
		 * @returns true when the code should trigger a same-model retry.
		 */
		function isRetryable(code, explicitCodes, message) {
			if (!code) return false;
			const upper = code.toUpperCase();
			if (upper === "ABORTED") return false;
			if (RETRY_FLOOR_CODES.includes(upper)) return true;
			if (typeof message === "string" && TRANSIENT_MESSAGE_RE.test(message)) return true;
			if (explicitCodes.length > 0) return explicitCodes.some((c) => c.toUpperCase() === upper);
			// Default: retry anything that is not a known model-error class.
			const modelErrors = new Set(["UNKNOWN_MODEL", "QUOTA", "CONTEXT_OVERFLOW", "MODEL_UNAVAILABLE", "AUTH_FAILED", "RATE_LIMITED"]);
			return !modelErrors.has(upper);
		}

		/**
		 * Drive the request through the candidate chain. Attempt 0 rides the
		 * downstream waterfall unchanged (middleware and logging stay valid);
		 * attempts >= 1 dispatch straight to the adapter boundary. A terminal error
		 * finish chunk is retried on the next candidate only when no visible content
		 * was produced — splicing a second model onto partial output would corrupt
		 * the assembled message, so mid-stream failures surface untouched. Aborted
		 * finish chunks always pass through.
		 *
		 * When the entire candidate chain is exhausted and the final error is a
		 * retryable non-model exception, the plugin re-dispatches through the last
		 * model with exponential backoff (default: up to 3 retries, base delay 500 ms).
		 */
		async function* runWithFallback(chain, next, options) {
			const cfg = current();
			const retryCfg = cfg?.retry ?? {};
			const retryEnabled = retryCfg.enabled === true;
			const maxRetries = typeof retryCfg.maxRetries === "number" ? retryCfg.maxRetries : 3;
			const baseDelayMs = typeof retryCfg.baseDelayMs === "number" ? retryCfg.baseDelayMs : 500;
			const explicitCodes = Array.isArray(retryCfg.retryableCodes) ? retryCfg.retryableCodes : [];

			// Liveness watchdog: any chunk (even a keep-alive) counts as progress; a
			// silent gap longer than idleTimeoutMs presumes a hung request. The
			// watchdog closes the upstream stream and synthesizes a WATCHDOG_IDLE
			// failure, which flows through the normal switch/retry machinery —
			// bounded by the chain length and the loop-retry cap, so no dead loops.
			const watchdogEnabled = cfg?.watchdog?.enabled !== false;
			const idleTimeoutMs = typeof cfg?.watchdog?.idleTimeoutMs === "number" ? Math.max(250, cfg.watchdog.idleTimeoutMs) : 300000;
			// Silence means the transport accepted the request (402/403-style
			// rejections arrive instantly as error chunks), so a silent model gets
		// patience first: the same model is re-sent this many times before the
		// chain moves on to a different candidate.
			const watchdogResends = typeof cfg?.watchdog?.resends === "number" ? Math.max(0, Math.floor(cfg.watchdog.resends)) : 2;
			async function* withWatchdog(stream) {
				const iterator = stream[Symbol.asyncIterator]();
				let lastActivity = Date.now();
				while (true) {
					const budget = Math.max(250, idleTimeoutMs - (Date.now() - lastActivity));
					let timerFired = false;
					let cancelTimer = () => {};
					const timeoutPromise = new Promise((resolve) => {
						const timer = setTimeout(() => {
							timerFired = true;
							resolve({ idle: true });
						}, budget);
						cancelTimer = () => {
							clearTimeout(timer);
							resolve({ cleared: true });
						};
					});
					const settled = await Promise.race([iterator.next(), timeoutPromise]);
					if (timerFired && !(settled && Object.prototype.hasOwnProperty.call(settled, "done"))) {
						// Abandon the hung upstream: return() on a generator suspended at
						// a never-settling await would queue forever, so it is fired
						// without waiting — the watchdog still owns the outcome.
						try {
							void Promise.resolve(iterator.return?.()).catch(() => {});
						} catch {
						}
						yield { type: "finish", reason: { kind: "error", failure: { code: "WATCHDOG_IDLE", message: `no model output for ${Math.round((Date.now() - lastActivity) / 1000)}s (liveness watchdog)` } } };
						return;
					}
					cancelTimer();
					lastActivity = Date.now();
					if (settled.done) return;
					if (settled.value?.type === "finish") {
						yield settled.value;
						return;
					}
					yield settled.value;
				}
			}

			// One retry-chain id per request: every switch inside this request joins
			// the SAME message-stream chain so the UI renders one expanding
			// "已重试模型请求" row covering the whole fallback journey.
			let requestRetryId = null;
			for (let index = 0; index < chain.length; index += 1) {
				const entry = chain[index];
				let finishChunk = null;
				let sawContent = false;
				// Per-candidate patience: on total silence the SAME model is re-sent
			// (watchdogResends times, each with a fresh idle window) before the
			// chain moves to a different candidate. Any real error chunk (402/403/
			// 500…) skips the patience loop immediately and switches.
				for (let attempt = 0; ; attempt += 1) {
					const rawStream = index === 0 && attempt === 0 ? next() : ctx.llm.adapterStream({ ...options, provider: entry.provider, model: entry.model });
					const stream = watchdogEnabled ? withWatchdog(rawStream) : rawStream;
					finishChunk = null;
					sawContent = false;
					let idle = false;
					for await (const chunk of stream) {
						if (chunk?.type === "finish") {
							finishChunk = chunk;
							break;
						}
						if (!sawContent && isContentChunk(chunk)) sawContent = true;
						yield chunk;
					}
					const attemptReason = finishChunk?.reason;
					idle = attemptReason?.kind === "error" && attemptReason.failure?.code === "WATCHDOG_IDLE";
					if (idle && !sawContent && attempt < watchdogResends) {
						logger.warn(`model-fallback: watchdog re-sending ${entry.provider}/${entry.model} (${attempt + 1}/${watchdogResends}) after ${Math.round(idleTimeoutMs / 1000)}s of silence`);
						continue;
					}
					break;
				}
				const reason = finishChunk?.reason;
				if (!reason || reason.kind !== "error" || sawContent) {
					if (finishChunk) {
						yield finishChunk;
						markModelHealthy(entry.provider, entry.model);
						if (index > 0 && reason.kind !== "aborted") {
							logger.info(`model-fallback: request recovered on ${entry.provider}/${entry.model} after ${index} switch(es)`);
						}
					}
					return;
				}
				const failure = reason.failure;
				// Health bookkeeping: wallet failures cool the whole account down;
				// other failures cool just this model. Later requests skip them
				// without paying for another dead dispatch.
				if (isAccountLevelFailure(failure?.code, failure?.message)) {
					markAccountFailure(entry.provider);
					markArrears(accountKeyOf(entry.provider));
				} else {
					markModelFailure(entry.provider, entry.model);
				}
				// Account-level rejection (402/401/403, quota): every remaining candidate of
				// the SAME account (route + its modlens wrapper) is equally dead — skip
				// straight to the next account's groups instead of burning the chain.
				if (isAccountLevelFailure(failure?.code, failure?.message)) {
					const deadAccount = accountKeyOf(entry.provider);
					let skip = 0;
					while (index + 1 + skip < chain.length && accountKeyOf(chain[index + 1 + skip].provider) === deadAccount) skip += 1;
					if (skip > 0) {
						logger.warn("model-fallback: account \"" + deadAccount + "\" rejected (" + (failure?.code ?? "UNKNOWN") + "); skipping its remaining " + skip + " candidate(s)");
						index += skip;
					}
				}
				if (index + 1 >= chain.length) {
					// Chain exhausted — decide whether to retry the same model.
					const code = failure?.code ?? "UNKNOWN";
					// Account-level failures (402/quota/arrears) are terminal across
					// the whole account — retrying the same model is pointless and
					// would create a dead loop. Yield the failure immediately.
					if (isAccountLevelFailure(code, failure?.message)) {
						logger.warn(`model-fallback: exhausted ${chain.length} candidate(s); account-level failure (${code}) on ${entry.provider}/${entry.model}, not retrying`);
						yield finishChunk;
						return;
					}
					if (retryEnabled && isRetryable(code, explicitCodes, failure?.message) && maxRetries > 0) {
						// Retry the ORIGINAL requested model (first in chain), not the last candidate.
						const origEntry = chain[0];
						let lastChunk = finishChunk;
						// Continuation numbering: the chain already consumed
						// (chain.length - 1) switch attempts, so same-model retries
						// keep ascending inside the SAME conversation retry chain.
						const switchAttempts = Math.max(0, chain.length - 1);
						for (let retry = 1; retry <= maxRetries; retry++) {
							const delay = Math.min(baseDelayMs * Math.pow(2, retry - 1), 10000);
							logger.warn(
								`model-fallback: ${origEntry.provider}/${origEntry.model} failed (${code}); non-model error, retry ${retry}/${maxRetries} after ${delay} ms`,
							);
							requestRetryId ??= randomUUID();
							appendRetryEvent(options, "llm/retry", {
								retryId: requestRetryId,
								provider: origEntry.provider,
								mode: "normal",
								policyKey: "model-fallback:retry",
								retry: switchAttempts + retry,
								maxRetries: switchAttempts + maxRetries,
								delayMs: delay,
								failure: { code, message: `${origEntry.provider}/${origEntry.model} → same-model retry ${retry}/${maxRetries} in ${delay} ms` },
							});
							await new Promise((resolve) => setTimeout(resolve, delay));
							const retryStream = ctx.llm.adapterStream({ ...options, provider: origEntry.provider, model: origEntry.model });
							appendRetryEvent(options, "llm/retry-started", { retryId: requestRetryId, retry: switchAttempts + retry });
							let retryFinish = null;
							let retrySawContent = false;
							for await (const rchunk of retryStream) {
								if (rchunk?.type === "finish") {
									retryFinish = rchunk;
									break;
								}
								if (!retrySawContent && isContentChunk(rchunk)) retrySawContent = true;
								yield rchunk;
							}
							const rreason = retryFinish?.reason;
							if (!rreason || rreason.kind !== "error" || retrySawContent) {
								if (retryFinish) {
									yield retryFinish;
									if (rreason?.kind !== "aborted") {
										logger.info(`model-fallback: request recovered on ${origEntry.provider}/${origEntry.model} after ${retry} retry(ies)`);
									}
								}
								return;
							}
							const rcode = rreason.failure?.code ?? "UNKNOWN";
							if (!isRetryable(rcode, explicitCodes)) {
								logger.warn(`model-fallback: retry ${retry} surfaced non-retryable error (${rcode}); giving up`);
								yield retryFinish;
								return;
							}
							lastChunk = retryFinish;
						}
						logger.warn(
							`model-fallback: exhausted ${chain.length} candidate(s) and ${maxRetries} retry(ies); last failure on ${origEntry.provider}/${origEntry.model}: ${failure?.code ?? "UNKNOWN"} ${truncate(failure?.message)}`,
						);
						yield lastChunk;
						return;
					}
					logger.warn(`model-fallback: exhausted ${chain.length} candidate(s); last failure on ${entry.provider}/${entry.model}: ${failure?.code ?? "UNKNOWN"} ${truncate(failure?.message)}`);
					yield finishChunk;
					return;
				}
				const upcoming = chain[index + 1];
				logger.warn(`model-fallback: ${entry.provider}/${entry.model} failed (${failure?.code ?? "UNKNOWN"}: ${truncate(failure?.message)}); switching to ${upcoming.provider}/${upcoming.model}`);
				requestRetryId ??= randomUUID();
				appendRetryEvent(options, "llm/retry", {
					retryId: requestRetryId,
					provider: upcoming.provider,
					mode: "normal",
					policyKey: "model-fallback:chain",
					retry: index + 1,
					maxRetries: chain.length,
					delayMs: 0,
					failure: { code: failure?.code ?? "UNKNOWN", message: `${entry.provider}/${entry.model} → switching to ${upcoming.provider}/${upcoming.model}` },
				});
				// The switch dispatches immediately — mark the attempt started so the
				// conversation row reflects the new model actually taking the call.
				appendRetryEvent(options, "llm/retry-started", { retryId: requestRetryId, retry: index + 1 });
			}
		}

	ctx.on("llm/stream", (options, next) => {
		if (!bypassSupported) return next();
		let chain = null;
		try {
			chain = buildChain(options);
		} catch (error) {
			logger.warn(`model-fallback: building the candidate chain failed, passing the request through: ${error?.message ?? error}`);
		}
		if (!chain) return next();
		return runWithFallback(chain, next, options);
	});

	/** agent id -> last auto-resume time; one resume per agent per 10 minutes. */
	const lastAutoResumeAt = new Map();

	/**
	 * Auto-resume a paused/blocked goal after the pool exhausted and the task
	 * stopped: the switch machinery already moved the session to a (possibly
	 * healthy) model, so re-arming the goal lets the task continue on it.
	 * Guards: auto-mode on, a model switch happened within 2 minutes (this
	 * was a recoverable model failure, not a dead-end), one resume per agent
	 * per 10 minutes, and the goal service's own round budget.
	 *
	 * When ALL selected providers are in arrears, resuming is futile and would
	 * create a dead loop — the failure is terminal; the user must clear the
	 * arrears marker or switch providers manually.
	 */
	function scheduleGoalAutoResume(agent, code) {
		try {
			if (!agent || typeof agent.id !== "string") return;
			if (current()?.enabled !== true) return;
			const cfg = current();
			// If ALL selected providers are in arrears, resuming just re-enters
			// the same failure loop. Check: for every selected provider, if its
			// account is in arrears, the resume is pointless.
			const selected = Array.isArray(cfg?.providers) ? cfg.providers.filter((p) => typeof p === "string" && p.length > 0) : [];
			if (selected.length > 0 && selected.every((p) => cfg?.arrears?.[accountKeyOf(p)] === true)) {
				logger.warn(`auto-mode: goal auto-resume skipped — all ${selected.length} selected provider account(s) are in arrears; surfacing the failure instead`);
				return;
			}
			const now = Date.now();
			if (now - (lastAutoResumeAt.get(agent.id) ?? 0) < 10 * 60 * 1000) return;
			const recentSwitch = logRing.some((entry) => now - Date.parse(entry.at) < 2 * 60 * 1000 && entry.message.includes("switching to"));
			if (!recentSwitch) return;
			lastAutoResumeAt.set(agent.id, now);
			setTimeout(() => {
				try {
					const goals = ctx.get?.("goals");
					const goal = goals?.get(agent);
					if (!goal || (goal.phase !== "paused" && goal.phase !== "blocked")) return;
					goals.resume(agent, { id: goal.id, revision: goal.revision });
					logger.warn(`auto-mode: goal "${goal.id}" auto-resumed after model switch (last failure ${code}); the task continues on the new model`);
				} catch (error) {
					logger.warn(`auto-mode: goal auto-resume failed: ${error?.message ?? error}`);
				}
			}, 3000);
		} catch {
			// Auto-resume is best-effort; the user can always resume manually.
		}
	}

	/**
	 * Loop-level request recovery on the agent loop's extension point. The
	 * request-level fallback above cannot recover a mid-stream failure (partial
	 * output already reached the consumer), but the loop can: it discards the
	 * half-built assistant message and re-issues the entire request. This
	 * listener always calls next() first so a provider-configured native policy
	 * (dsh-llm-retry) keeps priority; when the native chain declines, our retry
	 * policy takes over with the same durable session-event bookkeeping.
	 */
	ctx.on("agent/request-error", async (payload, next) => {
		const outcome = await next();
		if (outcome && typeof outcome === "object" && outcome.kind === "retry") return outcome;
		const cfg = current();
		const retryCfg = cfg?.retry ?? {};
		if (retryCfg.enabled !== true || retryCfg.loopRetry !== true) return outcome;
		const agent = payload?.agent;
		const session = agent?.session;
		if (!session || !Array.isArray(session.events)) return outcome;
		const failure = payload?.failure;
		const code = typeof failure?.code === "string" ? failure.code : "UNKNOWN";
		const provider = typeof payload?.provider === "string" ? payload.provider : "";
		if (code.toUpperCase() === "ABORTED") return outcome;
		// Account-level failures (402/quota) cannot be fixed by re-issuing the
		// same request — the wallet is empty. Skip loop retry and auto-resume
		// for these; surfacing the failure terminates the task cleanly instead
		// of cycling through retry → resume → fail → retry again.
		if (isAccountLevelFailure(code, failure?.message)) {
			logger.warn(`model-fallback: loop-level retry skipped for ${provider || "?"} — account-level failure (${code}); surfacing the failure`);
			return outcome;
		}
		const explicitCodes = Array.isArray(retryCfg.retryableCodes) ? retryCfg.retryableCodes : [];
		if (!isRetryable(code, explicitCodes, failure?.message)) return outcome;

		const maxRetries = typeof retryCfg.maxRetries === "number" ? retryCfg.maxRetries : 3;
		const baseDelayMs = typeof retryCfg.baseDelayMs === "number" ? retryCfg.baseDelayMs : 500;
		const policyKey = JSON.stringify(["normal", maxRetries, [...explicitCodes].sort(), baseDelayMs, 10000, 0.1]);
		const turn = payload?.turn;
		const step = payload?.step;
		const prior = [...session.events].reverse().find((event) => event.type === "llm/retry" && event.data?.turn === turn && event.data?.step === step && event.data?.provider === provider && event.data?.policyKey === policyKey);
		const previousRetry = prior?.data?.retry ?? 0;
		if (previousRetry >= maxRetries) {
			logger.warn(`model-fallback: loop retry exhausted (${maxRetries}) on ${provider} after ${code}; surfacing the failure`);
			// If the final failure is account-level, don't attempt auto-resume —
			// resuming would just re-enter the same dead loop because all
			// accounts are still in arrears. Let the agent surface the failure.
			if (!isAccountLevelFailure(code, failure?.message)) {
				scheduleGoalAutoResume(payload?.agent, code);
			}
			return outcome;
		}
		const retry = previousRetry + 1;
		const retryId = prior?.data?.retryId ?? randomUUID();
		const delayMs = Math.min(baseDelayMs * 2 ** (retry - 1), 10000);
		session.append("llm/retry", { retryId, turn, step, provider, mode: "normal", policyKey, retry, maxRetries, delayMs, failure });
		const signal = payload?.signal;
		if (signal?.aborted) return outcome;
		if (signal) {
			const proceed = await new Promise((resolve) => {
				const timer = setTimeout(() => {
					signal.removeEventListener("abort", onAbort);
					resolve(true);
				}, delayMs);
				function onAbort() {
					clearTimeout(timer);
					resolve(false);
				}
				signal.addEventListener("abort", onAbort, { once: true });
			});
			if (!proceed) return outcome;
		} else {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
		session.append("llm/retry-started", { retryId, turn, step, retry });
		logger.warn(`model-fallback: loop retry ${retry}/${maxRetries} on ${provider} after ${code} (delay ${delayMs} ms); re-issuing the request`);
		return { kind: "retry" };
	});

	logger.info("model-fallback: loop-level retry listener armed on agent/request-error");

	// Settings-page log viewer: same-origin JSON endpoint over the webServer
	// (the dsh-market plugin's route contract — kind "exact", method-checked).
	// webServer is inject-only: cordis refuses bare property access, so the
	// route mounts inside the declared dependency scope.
	try {
		ctx.inject(["webServer"], (scope) => {
			scope.effect(() => {
				const disposeLog = scope.webServer.register({
					kind: "exact",
					path: "/dsh-model-fallback/api/log",
					handler: (request, response) => {
						if (request.method !== "GET" && request.method !== "HEAD") {
							response.writeHead(405, { allow: "GET" });
							response.end();
							return;
						}
						const body = JSON.stringify({
							cap: LOG_RING_CAP,
							events: logRing.slice().reverse(),
						});
						response.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store",
						});
						response.end(request.method === "HEAD" ? undefined : body);
					},
				});
				// Real-time event stream (SSE): the client toast feed subscribes
				// here and receives every ring event the moment it is recorded —
				// no polling latency.
				const disposeEvents = scope.webServer.register({
					kind: "exact",
					path: "/dsh-model-fallback/api/events",
					handler: (request, response) => {
						if (request.method !== "GET") {
							response.writeHead(405, { allow: "GET" });
							response.end();
							return;
						}
						response.writeHead(200, {
							"content-type": "text/event-stream; charset=utf-8",
							"cache-control": "no-store",
							connection: "keep-alive",
							"x-accel-buffering": "no",
						});
						response.flushHeaders?.();
						response.socket?.setNoDelay?.(true);
						response.write(": connected\n\n");
						sseClients.add(response);
						// Application-level heartbeat keeps idle connections alive.
						const heartbeat = setInterval(() => {
							try {
								response.write(": hb\n\n");
							} catch {
								/* the close/error handlers clean up */
							}
						}, 25000);
						const drop = () => {
							clearInterval(heartbeat);
							sseClients.delete(response);
						};
						response.on("close", drop);
						response.on("error", drop);
					},
				});
				return () => {
					try {
						disposeLog?.();
					} catch {}
					try {
						disposeEvents?.();
					} catch {}
					for (const client of [...sseClients]) {
						try {
							client.end();
						} catch {}
					}
					sseClients.clear();
				};
			}, "model-fallback: log viewer + real-time event stream routes");
		});
	} catch (error) {
		logger.warn(`model-fallback: log viewer route unavailable: ${error?.message ?? error}`);
	}

	ctx.on("llm/adapters-updated", () => {
		scheduleRefresh(current().providers ?? []);
	});

	/** Describe the current fallback posture for logs. */
	function describeSelection(cfg) {
		const selected = Array.isArray(cfg?.providers) ? cfg.providers.filter((provider) => typeof provider === "string" && provider.length > 0) : [];
		const arrearsKeys = Object.keys(cfg?.arrears ?? {}).filter((key) => cfg.arrears[key] === true);
		return `${cfg?.enabled === true ? "enabled" : "disabled"}; ${selected.length} provider group(s)${selected.length > 0 ? `: ${selected.join(" -> ")}` : ""}; protectUnselected=${cfg?.protectUnselected === false ? "off" : "on"}; allProvidersFallback=${cfg?.allProvidersFallback === false ? "off" : "on"}; arrears=${arrearsKeys.length > 0 ? arrearsKeys.join(",") : "none"}`;
	}

	/** Previous arrears snapshot used to react when markers are cleared/added. */
	let previousArrears = {};

	installSettingsSection(ctx, NS, Config, config ?? {}, {
		setSource: (source) => {
			current = source;
		},
		onChange: () => {
			const cfg = current();
			const nowArrears = cfg?.arrears ?? {};
			for (const key of Object.keys(previousArrears)) {
				if (previousArrears[key] === true && !nowArrears[key]) {
					accountHealth.delete(key);
					logger.info(`model-fallback: arrears marker cleared for ${key}; account rejoins fallback pool`);
				}
			}
			for (const key of Object.keys(nowArrears)) {
				if (nowArrears[key] === true && previousArrears[key] !== true) {
					markAccountFailure(key);
					logger.warn(`model-fallback: arrears marker set for ${key}; excluding account from fallback pool`);
				}
			}
			previousArrears = { ...nowArrears };
			logger.info(`model-fallback: ${describeSelection(cfg)}`);
			scheduleRefresh(cfg.providers ?? []);
		},
	});

	logger.info(`model-fallback: fallback loop armed (${describeSelection(current())})`);
	scheduleRefresh(config?.providers ?? []);

	//#region full-auto mode
	/** Settings-resolved full-auto config source; swapped by installSettingsSection. */
	let autoCurrent = () => config?.auto ?? {};
	/** Read one auto-mode flag with a safe default. */
	function autoFlag(key, fallback) {
		try {
			const cfg = autoCurrent();
			if (!cfg || typeof cfg !== "object") return fallback;
			const value = cfg[key];
			return typeof value === "boolean" ? value : fallback;
		} catch {
			return fallback;
		}
	}

	/** Shorten a reason to one audit-table-friendly line. */
	function auditSummary(text, max = 160) {
		const message = typeof text === "string" ? text : "";
		return message.length > max ? `${message.slice(0, max)}\u2026` : message;
	}

	// 1. Tool-permission gate: answer every approval with allowed-once.
	ctx.on("approval/request", (req, next) => {
		if (!autoFlag("enabled", false) || !autoFlag("autoAllowPermissions", true)) return next();
		const tool = typeof req?.toolName === "string" ? req.toolName : "unknown-tool";
		const reason = auditSummary(req?.reason);
		const root = req?.agent?.session?.header?.cwd;
		logger.warn(`auto-mode: permission for "${tool}" auto-allowed${reason ? ` (${reason})` : ""}${root ? `; logged to ${AUTO_LOG_NAME}` : ""}`);
		auditAutoAction(root, "\u6743\u9650\u5ba1\u6279", `\u5de5\u5177 ${tool}${reason ? ` \u2014 ${reason}` : ""}`);
		return "allowed-once";
	});

	// 2. User-question gate: wrap whatever provider the UI registers, so
	// ask_user confirmations and plan reviews resolve to their default-allow
	// choice without a human. When auto mode (or a sub-toggle) is off the
	// wrapper fully delegates to the real provider.
	const userQuestions = typeof ctx.get === "function" ? ctx.get("userQuestions") : undefined;
	if (userQuestions && typeof userQuestions.registerProvider === "function" && !userQuestions.autoModeWrapped) {
		const originalRegister = userQuestions.registerProvider.bind(userQuestions);
		userQuestions.registerProvider = (provider) => originalRegister({
			ask: async (request) => {
				const questions = Array.isArray(request?.questions) ? request.questions : [];
				const planReview = questions.some((question) => question?.intent?.kind === "plan-review");
				const gatedOff =
					!autoFlag("enabled", false) ||
					!autoFlag("autoAnswerQuestions", true) ||
					(planReview && !autoFlag("autoApprovePlans", true));
				if (gatedOff) return provider.ask(request);
				const answers = questions.map((question) => {
					const approveLabel =
						typeof question?.intent?.approve === "string"
							? question.intent.approve
							: Array.isArray(question?.options) && typeof question.options[0]?.label === "string"
								? question.options[0].label
								: undefined;
					const kind = question?.intent?.kind === "plan-review" ? "\u65b9\u6848\u5ba1\u6279" : "\u4eba\u5de5\u786e\u8ba4";
					const detail = auditSummary(typeof question?.question === "string" ? question.question : question?.id);
					logger.warn(`auto-mode: ${kind} auto-answered (${detail}); logged to ${AUTO_LOG_NAME}`);
					auditAutoAction(request?.agent?.session?.header?.cwd, kind, detail);
					return {
						id: question.id,
						selected: approveLabel !== undefined ? [approveLabel] : [],
						...(approveLabel === undefined ? { custom: "\uff08\u5168\u81ea\u52a8\u6a21\u5f0f\uff1a\u9ed8\u8ba4\u5e94\u7b54\uff09" } : {}),
					};
				});
				return { answers };
			},
		});
		try {
			Object.defineProperty(userQuestions, "autoModeWrapped", { value: true });
		} catch {
			userQuestions.autoModeWrapped = true;
		}
		logger.info("auto-mode: user-question provider wrap armed");
	}

	// 3. Model-facing notice so the agent stops waiting for a human.
	try {
		ctx.inject(["systemPrompt"], (scope) => {
			scope.systemPrompt.context({
				name: "auto-mode:enabled",
				order: 116,
				text: () => (autoFlag("enabled", false) ? AUTO_PROMPT_SENTENCE : ""),
			});
		});
	} catch (error) {
		logger.warn(`auto-mode: systemPrompt notice unavailable: ${error?.message ?? error}`);
	}

	/** Describe the full-auto posture for logs. */
	function describeAuto(cfg) {
		const on = cfg?.enabled === true;
		const parts = [
			cfg?.autoAllowPermissions === false ? null: "permissions",
			cfg?.autoAnswerQuestions === false ? null : "questions",
			cfg?.autoApprovePlans === false ? null : "plans",
			cfg?.workspaceLog === false ? null : "audit",
		].filter(Boolean);
		return `${on ? "enabled" : "disabled"} (${parts.join(", ")})`;
	}

	installSettingsSection(ctx, NS_AUTO, AutoConfig, config?.auto ?? {}, {
		setSource: (source) => {
			autoCurrent = source;
		},
		onChange: () => {
			logger.info(`auto-mode: ${describeAuto(autoCurrent())}`);
		},
	});

	logger.info(`auto-mode: armed (${describeAuto(autoCurrent())})`);
	//#endregion
}
//#endregion

export { Config, __clearHealthCache, apply, inject, name };
