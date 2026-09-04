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
 * to a different account's groups. Chinese gateway wording counts too —
 * "余额不足，请充值后重试" is an empty wallet even when no status code rides
 * along.
 */
function isAccountLevelFailure(code, message) {
	const upper = typeof code === "string" ? code.toUpperCase() : "";
	if (upper === "QUOTA") return true;
	// 402 (wallet empty) is account-wide; 401/403 may be model-scoped
	// permissions where the same account's other models still serve.
	if (typeof message === "string" && /\b402\b|insufficient credits|never purchased credits|余额不足|已欠费|欠费|请充值|额度已用完|配额已用完/i.test(message)) return true;
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
 * message before trusting the coarse code. Chinese gateway text counts too:
 * model-pool gateways answer outages with "模型服务暂时不可用，请稍后重试"
 * and similar wording that carries no status code at all.
 */
const TRANSIENT_MESSAGE_RE = /\b(?:429|5\d\d)\b|timeout|timed out|econn|socket|network|terminated|reset|temporarily|unavailable|overloaded|bad gateway|service error|稍后重试|稍后再试|暂时|不可用|繁忙|过载|服务异常|服务器错误|网关错误|网络异常|连接异常|请重试/i;

/**
 * Context-overflow class (dsh-auto-continue's "permanent" family): the request
 * itself cannot fit the model's window, so a blind "继续" would dead-loop on
 * the same oversized request. The keep-alive answers these with a forced
 * manual compaction pass FIRST (shrinking the history), and only then wakes
 * the task; when nothing compactable remains it stands down honestly.
 */
const OVERFLOW_RE = /context[_-]?[\s_]*(?:window|length|limit|overflow|exceed)|token[_-]?[\s_]*limit|max[_-]?[\s_]*context|上下文|超出长度|长度超|会话过长|prompt too long|maximum context/i;
/** Other deterministic failures a "继续" cannot fix (dsh-auto-continue's permanent family). */
const PERMANENT_RE = /auth|unauthor|forbidden|credential|api[_-]?key|permission|model.*not[_-]?found|unknown[_-]?model|model[_-]?not[_-]?found|not.*support.*model|invalid[_-]?request|bad[_-]?request|模型不存在|无效请求|请求无效/i;

/** Default codes that qualify as retryable non-model errors. */
const DEFAULT_RETRYABLE_CODES = [
	"NETWORK_ERROR",
	"TRANSPORT",
	"TIMEOUT",
	"CONNECTION_CLOSED",
	"RATE_LIMITED",
	"SERVER_ERROR",
	// pi-ai adapter vocabulary (classifyPiAiError): its families use shorter
	// names than dsh-llm's canonical codes, and PI_AI_ERROR is its catch-all
	// for unclassified gateway failures (account-level wording is screened by
	// isAccountLevelFailure BEFORE this list is consulted, so 402-style
	// messages never reach a retry through these entries).
	"SERVER",
	"RATE_LIMIT",
	"PI_AI_ERROR",
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
			/**
			 * Turn keep-alive (轮次保活): when a whole turn still dies to a
			 * transient model-service failure (every candidate, every retry and
			 * loop retry exhausted — the "本轮运行失败" boundary), the plugin
			 * sends a "继续" user message into the conversation so the task
			 * restarts instead of sitting dead. Attempts back off exponentially;
			 * it stops only when every selected provider account is in arrears or
			 * the failure class is one a "继续" cannot fix.
			 */
			keepAlive: z
				.object({
					enabled: z.boolean().default(true),
					/** Grace/cooldown base: wait after a dead turn before the first wake; grows per consecutive failure. */
					delayMs: z.number().min(0).default(5000),
					/** Backoff cap so a long outage still probes about once a minute. */
					maxDelayMs: z.number().min(0).default(60000),
					/** Adaptive backoff multiplier per consecutive failure. */
					backoffFactor: z.number().min(1).default(2),
					/**
					 * Max consecutive auto-continues per failure streak before standing
					 * down (0 = unlimited: keep going until success or the pool is dead).
					 */
					maxConsecutive: z.number().min(0).default(0),
					/** Idempotency guard: inspect the last tool call before resuming and steer the model. */
					guardTools: z.boolean().default(true),
					/** Wake-up text template ({code}/{message}/{status}/{tool}/{turn}/{errorCount}). */
					continueText: z.string().default("\u7ee7\u7eed"),
					/** Wake-up text when the turn ended at the output-token cap. */
					continueTextMaxTokens: z.string().default("\u7ee7\u7eed"),
					/**
					 * Provider-specific literal fragments (one per line) that force a
					 * failure to count as transient/retryable — overrides every builtin
					 * classification (dsh-auto-continue's retryableErrorPatterns).
					 */
					retryablePatterns: z.string().default(""),
				})
				.default({}),
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
	/**
	 * Record one ring entry. The optional metadata object carries session
	 * attribution: the client toast feed shows a bubble only on the conversation
	 * page the event belongs to, so the sessionId rides the JSON log payload and
	 * every SSE frame. Events without an attributable session never surface as
	 * a bubble (they stay in the settings log viewer).
	 */
	const recordEvent = (level, message, meta) => {
		const entry = { at: new Date().toISOString(), level, message: String(message) };
		if (meta && typeof meta === "object" && typeof meta.sessionId === "string" && meta.sessionId.length > 0) {
			entry.sessionId = meta.sessionId;
		}
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
	/** Session id carried by llm request options (request-level events: switch / recovery). */
	const requestSessionId = (options) => {
		const id = options?.sessionId;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	};
	/** Best-effort session id off an in-memory session object (auto-mode gates). */
	const sessionObjectSessionId = (session) => {
		for (const candidate of [session?.header?.id, session?.id, session?.header?.sessionId, session?.sessionId]) {
			if (typeof candidate === "string" && candidate.length > 0) return candidate;
		}
		return undefined;
	};
	/** Split an optional trailing metadata object (session attribution) off a log call so the host logger never sees it. */
	const splitLogMeta = (args) => {
		const last = args[args.length - 1];
		if (args.length > 1 && last !== null && typeof last === "object") return [args.slice(0, -1), last];
		return [args, undefined];
	};
	const rawLoggerInfo = logger.info.bind(logger);
	const rawLoggerWarn = logger.warn.bind(logger);
	logger.info = (...args) => {
		const [rest, meta] = splitLogMeta(args);
		recordEvent("info", rest.join(" "), meta);
		return rawLoggerInfo(...rest);
	};
	logger.warn = (...args) => {
		const [rest, meta] = splitLogMeta(args);
		recordEvent("warn", rest.join(" "), meta);
		return rawLoggerWarn(...rest);
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
							logger.info(`model-fallback: request recovered on ${entry.provider}/${entry.model} after ${index} switch(es)`, { sessionId: requestSessionId(options) });
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
										logger.info(`model-fallback: request recovered on ${origEntry.provider}/${origEntry.model} after ${retry} retry(ies)`, { sessionId: requestSessionId(options) });
									}
								}
								return;
							}
							const rcode = rreason.failure?.code ?? "UNKNOWN";
							// A wallet failure surfacing mid-retry is terminal for the
							// account — the same model cannot recover it; stop here.
							if (isAccountLevelFailure(rcode, rreason.failure?.message)) {
								markAccountFailure(origEntry.provider);
								markArrears(accountKeyOf(origEntry.provider));
								logger.warn(`model-fallback: retry ${retry} hit an account-level failure (${rcode}) on ${origEntry.provider}/${origEntry.model}; giving up`);
								yield retryFinish;
								return;
							}
							// Re-classify WITH the message: pi-ai codes (SERVER, PI_AI_ERROR, …)
							// fall outside the explicit code list, so the message text is what
							// made the original failure retryable — the re-check must see it too.
							if (!isRetryable(rcode, explicitCodes, rreason.failure?.message)) {
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
				logger.warn(`model-fallback: ${entry.provider}/${entry.model} failed (${failure?.code ?? "UNKNOWN"}: ${truncate(failure?.message)}); switching to ${upcoming.provider}/${upcoming.model}`, { sessionId: requestSessionId(options) });
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
		// The master switch governs the whole plugin: toggling 模型回退 off
		// mid-task must disarm loop-level recovery too, on the very next
		// failure (the config source is re-read at every event).
		if (cfg?.enabled !== true) return outcome;
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

	//#region turn keep-alive (轮次保活)
	/**
	 * Last line of recovery: a turn that STILL died to a transient model-service
	 * failure — every candidate switched, every same-model retry burned, every
	 * loop retry spent — ends with `turn/end { kind: "error" }` and the UI's
	 * "本轮运行失败" row, and the session would sit idle forever. The keep-alive
	 * listener fires on that boundary (`agent/error` is emitted exactly there,
	 * and never on user aborts) and sends a "继续" user message into the
	 * conversation, so the task restarts like the user had typed it.
	 *
	 * Stop conditions, deliberately narrow: the task must keep going unless the
	 * failure class is one a "继续" cannot fix (aborts, wallet failures handled
	 * by the arrears machinery, deterministic model errors), or every selected
	 * provider account is in arrears / no group is selected (the keep-alive
	 * pool itself is dead). Attempts back off exponentially per consecutive
	 * failure and reset whenever the session produces a non-error turn again.
	 */
	/**
	 * agent id -> keep-alive state `{ streak, timer, lastTool }`.
	 * `timer != null` means a wake is already armed for this agent.
	 * `lastTool` tracks the most recent tool invocation (`tool/call`→`tool/result`)
	 * so the idempotency guard (`guardTools`) can steer a blind "继续" away from
	 * re-running a side-effecting step (dsh-auto-continue's guard family).
	 */
	const keepAliveStates = new Map();

	/** Build the keep-alive user message (same shape dsh-schedule's followups use). */
	function continueMessage(text) {
		return Object.freeze({
			id: randomUUID(),
			role: "user",
			content: [{ type: "text", text: typeof text === "string" && text.trim() !== "" ? text : "继续" }],
			source: { kind: "plugin", plugin: name },
		});
	}

	/** Extract a stable machine route code from a failure fact. */
	function failureCode(failure) {
		return failure && typeof failure === "object" ? `${failure.code ?? "UNKNOWN"}` : "UNKNOWN";
	}

	/**
	 * Format an elapsed millisecond count like "1m5s" (dsh-auto-continue's
	 * formatElapsed) — placeholder `{elapsed}`.
	 */
	function formatElapsed(ms) {
		if (!(typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) return "";
		if (ms < 1000) return `${Math.round(ms)}ms`;
		const seconds = Math.round(ms / 1000);
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const rest = seconds % 60;
		return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
	}

	/**
	 * Fill a keep-alive text template with failure/turn context placeholders:
	 * `{code}` `{message}` `{status}` `{tool}` `{turn}` `{errorCount}` `{elapsed}`.
	 * Missing context expands to an empty string.
	 */
	function fillContinueTemplate(template, ctx) {
		const t = typeof template === "string" ? template : "继续";
		const code = ctx.code ?? "";
		const message = ctx.message ?? "";
		const status = typeof ctx.status === "number" && Number.isFinite(ctx.status) ? String(ctx.status) : "";
		const tool = ctx.tool ?? "";
		const turn = typeof ctx.turn === "number" ? String(ctx.turn) : "";
		const errorCount = typeof ctx.errorCount === "number" ? String(ctx.errorCount) : "";
		const elapsed = formatElapsed(ctx.elapsedMs);
		return t
			.replace(/\{code\}/g, code)
			.replace(/\{message\}/g, message)
			.replace(/\{status\}/g, status)
			.replace(/\{tool\}/g, tool)
			.replace(/\{turn\}/g, turn)
			.replace(/\{errorCount\}/g, errorCount)
			.replace(/\{elapsed\}/g, elapsed);
	}

	/**
	 * Keep-alive retryability: a configured literal fragment (`keepAlive.retryablePatterns`,
	 * one per line) that matches the code/message/status OVERRIDES every builtin
	 * classification and forces the failure to count as transient — mirroring
	 * dsh-auto-continue's `retryableErrorPatterns`. Otherwise the deterministic
	 * permanent family (auth / wallet / unknown model / context overflow / invalid
	 * request) is screened off the combined haystack FIRST — a coarse retryable
	 * code (e.g. PI_AI_ERROR) wrapping "context length exceeded" must not receive
	 * a blind 继续 that dead-loops on the same oversized request — and the rest
	 * falls back to the shared request-level `isRetryable` classification.
	 */
	function isKeepAliveRetryable(code, message, status, ka, explicitCodes) {
		const patterns =
			typeof ka?.retryablePatterns === "string" && ka.retryablePatterns.trim() !== ""
				? ka.retryablePatterns
				: "";
		const haystack = `${code} ${status ?? ""} ${message}`.toLowerCase();
		if (patterns !== "") {
			const forced = patterns
				.split(/\r?\n/)
				.map((p) => p.trim().toLowerCase())
				.filter((p) => p !== "")
				.some((p) => haystack.includes(p));
			if (forced) return true;
		}
		// Deterministic failures a "继续" cannot fix — even when the coarse code
		// list would otherwise mark them retryable (dsh-auto-continue's permanent
		// classification screens these before any retry decision).
		if (OVERFLOW_RE.test(haystack) || PERMANENT_RE.test(haystack)) return false;
		if (isAccountLevelFailure(code, message)) return false;
		const implicit = Array.isArray(explicitCodes) ? explicitCodes : DEFAULT_RETRYABLE_CODES;
		return isRetryable(code, implicit, message);
	}

	/** Extract a classifiable { code, message } off a thrown turn error. */
	function failureOfTurnError(error) {
		const failure = error?.failure;
		if (failure && typeof failure === "object" && typeof failure.code === "string" && failure.code.length > 0) {
			return { code: failure.code, message: typeof failure.message === "string" ? failure.message : "" };
		}
		return { code: "UNKNOWN", message: error instanceof Error ? String(error.message ?? "") : String(error ?? "") };
	}

	/** Keep-alive stop condition: no pool, or every selected account in arrears. */
	function keepAlivePoolDead(cfg) {
		const selected = Array.isArray(cfg?.providers) ? cfg.providers.filter((provider) => typeof provider === "string" && provider.length > 0) : [];
		if (selected.length === 0) return "no provider group is selected";
		const dead = selected.filter((provider) => cfg?.arrears?.[accountKeyOf(provider)] === true);
		if (dead.length === selected.length) return `all ${selected.length} selected provider account(s) are in arrears`;
		return null;
	}

	/** Backoff for the Nth consecutive dead turn (0-based streak). */
	function keepAliveDelayMs(ka, streak) {
		const base = typeof ka?.delayMs === "number" && ka.delayMs >= 0 ? ka.delayMs : 5000;
		const max = typeof ka?.maxDelayMs === "number" && ka.maxDelayMs >= base ? ka.maxDelayMs : Math.max(base, 60000);
		const factor = typeof ka?.backoffFactor === "number" && ka.backoffFactor > 0 ? ka.backoffFactor : 2;
		return Math.min(base * Math.pow(factor, streak), max);
	}

	/**
	 * Whether a keep-alive has blown its consecutive-attempt budget.
	 * `maxConsecutive` 0 means "unlimited — keep going until success or pool dead".
	 */
	function keepAliveConsecutiveExhausted(state, maxConsecutive) {
		const cap = typeof maxConsecutive === "number" && maxConsecutive > 0 ? maxConsecutive : 0;
		return cap > 0 && state.streak >= cap;
	}

	/** Whether the agent can accept a followup right now (idle, nothing pending). */
	function agentAcceptsFollowup(agent) {
		try {
			if (agent?.status !== "idle") return false;
			const inbox = agent.inbox;
			if (!inbox) return true;
			if (inbox.hasPending === true) return false;
			if (Array.isArray(inbox.nextTurn) && inbox.nextTurn.length > 0) return false;
			if (Array.isArray(inbox.nextStep) && inbox.nextStep.length > 0) return false;
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Fire the keep-alive followup once the backoff delay elapsed. Renders the
	 * configured `continueText` template (or `continueTextMaxTokens` when the
	 * turn died at the output-token cap), honors the `maxConsecutive` budget,
	 * and — when `guardTools` is on — appends an idempotency guard based on the
	 * last tool invocation so a blind "继续" does not re-run a side-effecting step
	 * (dsh-auto-continue's guard family).
	 */
	function injectTurnKeepAlive(agent, code, state, failure, maxTokens) {
		state.timer = null;
		try {
			if (!agent) return; // no live agent resolvable (e.g. max-tokens path) — skip
			const cfg = current();
			if (!cfg || cfg.enabled !== true || cfg?.retry?.keepAlive?.enabled === false) return;
			const ka = cfg?.retry?.keepAlive ?? {};
			if (keepAliveConsecutiveExhausted(state, ka.maxConsecutive)) {
				logger.warn(`auto-keepalive: reached ${ka.maxConsecutive} consecutive 继续 for ${agent.id}; standing down until an error-free turn resets the budget`, { sessionId: agent.id });
				return;
			}
			const dead = keepAlivePoolDead(cfg);
			if (dead) {
				logger.warn(`auto-keepalive: not sending 继续 — ${dead}; the failure must surface instead`);
				return;
			}
			// A paused/blocked goal owns the loop re-entry: resuming it re-drives
			// the task properly, so let the goal machinery wake instead of adding
			// a "继续" message on top of it.
			try {
				const goals = ctx.get?.("goals");
				const goal = goals?.get?.(agent);
				if (goal && (goal.phase === "paused" || goal.phase === "blocked") && typeof goals.resume === "function") {
					goals.resume(agent, { id: goal.id, revision: goal.revision });
					state.streak += 1;
					logger.warn(`auto-keepalive: turn died to ${code}; resumed ${goal.phase} goal "${goal.id}" instead of injecting 继续`, { sessionId: agent.id });
					return;
				}
			} catch {
				// Goal service unavailable or resume rejected — fall through to the message.
			}
			if (!agentAcceptsFollowup(agent)) return; // the loop is already driving; retry on the next failure
			// Render the wake-up text from the active template.
			const template = maxTokens
				? (ka.continueTextMaxTokens ?? "继续")
				: (ka.continueText ?? "继续");
			const text = buildContinueText(agent, code, state, failure, template, ka);
			agent.followup(continueMessage(text));
			state.streak += 1;
			logger.warn(`auto-keepalive: turn died to ${code}; sent 「${truncate(text, 60)}」 to wake the task (streak ${state.streak})`, { sessionId: agent.id });
		} catch (error) {
			logger.warn(`auto-keepalive: followup failed: ${error?.message ?? error}`);
		}
	}

	/**
	 * Assemble the keep-alive wake-up message: fill the template placeholders,
	 * then append an idempotency guard when the last tool call has an ambiguous
	 * outcome (pending) or finished successfully (done) — a "继续" must steer the
	 * model to verify state / not re-run, never blindly repeat a side effect.
	 */
	function buildContinueText(agent, code, state, failure, template, ka) {
		const facts = failure ?? {};
		const templateCtx = {
			code: failureCode(facts),
			message: typeof facts.message === "string" ? facts.message : "",
			status: typeof facts.status === "number" && Number.isFinite(facts.status) ? facts.status : undefined,
			tool: state.lastTool?.name ?? "",
			turn: state.lastTurn,
			errorCount: state.streak + 1,
			elapsedMs: state.lastFailureAt > 0 ? Date.now() - state.lastFailureAt : undefined,
		};
		let text = fillContinueTemplate(template, templateCtx);
		if (ka?.guardTools !== false && state.lastTool) {
			if (state.lastTool.state === "pending") {
				text += ` (上一步工具「${state.lastTool.name}」可能未完成，先确认状态再继续，不要重复执行)`;
			} else if (state.lastTool.state === "done") {
				const excerpt = typeof state.lastTool.excerpt === "string" && state.lastTool.excerpt !== ""
					? truncate(state.lastTool.excerpt, 160)
					: "";
				text += ` (上一步工具「${state.lastTool.name}」已完成${excerpt !== "" ? `，结果: ${excerpt}` : ""}; 不要重复执行，直接继续)`;
			}
		}
		return text;
	}

	ctx.on("agent/error", ({ agent, error }) => {
		try {
			const cfg = current();
			if (!cfg || cfg.enabled !== true) return;
			const ka = cfg?.retry?.keepAlive;
			if (!ka || ka.enabled === false) return;
			if (!agent || typeof agent.id !== "string") return;
			const { code, message } = failureOfTurnError(error);
			if (code.toUpperCase() === "ABORTED") return;
			// Wallet failures are the arrears machinery's job; deterministic model
			// errors (unknown model, context overflow, invalid request) cannot be
			// fixed by another "继续" — they would dead-loop on the same request.
			if (isAccountLevelFailure(code, message)) return;
			// `retryablePatterns` (one literal fragment per line) can force a
			// provider-specific failure to count as transient regardless of builtin
			// classification; otherwise fall back to the shared retry policy.
			const status = typeof error?.failure?.status === "number" ? error.failure.status : undefined;
			const retryCfg = cfg?.retry ?? {};
			const explicitCodes = Array.isArray(retryCfg.retryableCodes) ? retryCfg.retryableCodes : DEFAULT_RETRYABLE_CODES;
			if (!isKeepAliveRetryable(code, message, status, ka, explicitCodes)) return;
			const dead = keepAlivePoolDead(cfg);
			if (dead) {
				logger.warn(`auto-keepalive: turn failed (${code}) but ${dead}; not sending 继续`);
				return;
			}
			const state = keepAliveStateOf(agent.id);
			state.lastFailure = { code, message, ...(status !== undefined ? { status } : {}) };
			state.lastFailureAt = Date.now();
			if (state.timer !== null) return; // a keep-alive is already armed for this agent
			if (keepAliveConsecutiveExhausted(state, ka.maxConsecutive)) {
				logger.warn(`auto-keepalive: reached ${ka.maxConsecutive} consecutive 继续 for ${agent.id}; standing down until an error-free turn resets the budget`, { sessionId: agent.id });
				return;
			}
			const delay = keepAliveDelayMs(ka, state.streak);
			state.timer = setTimeout(() => injectTurnKeepAlive(agent, code, state, state.lastFailure, false), delay);
			logger.warn(`auto-keepalive: turn failed (${code}: ${truncate(message)}); 继续 scheduled in ${Math.round(delay / 1000)}s`, { sessionId: agent.id });
		} catch {
			// Keep-alive scheduling is best-effort; never break the failure surfacing.
		}
	});

	/** Get-or-create the keep-alive state for a session id (like the reference's state()). */
	function keepAliveStateOf(sessionId) {
		let state = keepAliveStates.get(sessionId);
		if (!state) {
			state = { streak: 0, timer: null, lastTool: null, lastTurn: undefined, lastFailure: undefined, lastFailureAt: 0 };
			keepAliveStates.set(sessionId, state);
		}
		return state;
	}

	/**
	 * Extract a bounded textual summary from a tool/result content block array
	 * (model-visible output; used for the `guardTools` "已完成，结果: …" appendix).
	 */
	function extractToolResultText(content) {
		if (!Array.isArray(content)) return "";
		let out = "";
		const collect = (part) => {
			if (out.length >= 200 || part === null || part === undefined) return;
			if (Array.isArray(part)) {
				for (const item of part) collect(item);
				return;
			}
			if (typeof part === "object") {
				if (part.type === "text" && typeof part.text === "string") {
					out += part.text.endsWith("\n") ? part.text : `${part.text} `;
					return;
				}
				for (const value of Object.values(part)) collect(value);
			}
		};
		collect(content);
		return out.trim();
	}

	/**
	 * Resolve the live agent for a session id (the `agent/error` path hands us the
	 * agent directly; the `session/event` max-tokens path must look it up). Returns
	 * undefined when no agents service is reachable — the wake is then skipped
	 * rather than risk a malformed followup.
	 */
	function agentFor(session) {
		const sessionId = session?.id || session?.header?.id;
		try {
			const agents =
				(typeof ctx.get === "function" && ctx.get("agents")) ||
				(typeof ctx.agents !== "undefined" ? ctx.agents : undefined);
			if (agents && typeof agents.get === "function" && typeof sessionId === "string") {
				return agents.get(sessionId);
			}
		} catch {
			// agents service unavailable — fall through.
		}
		return undefined;
	}

	// Session-level tracking feeding the keep-alive: (a) the last tool
	// invocation so the idempotency guard can steer a blind "继续" away from
	// re-running a side-effect; (b) the current turn number for the {turn}
	// template placeholder; (c) streak bookkeeping — a completed / aborted /
	// blocked turn means the pool served again and resets the backoff, while a
	// `max-tokens` turn ending is itself a wake-able interruption (its own
	// dedicated template, dsh-auto-continue's max-tokens path).
	ctx.on("session/event", (session, event) => {
		try {
			if (typeof session?.id !== "string" || session.id.length === 0) return;
			if (event?.type === "tool/call") {
				// Get-or-create: the guard must see the call even when no keep-alive
				// has fired yet (the first failure of a session).
				const state = keepAliveStateOf(session.id);
				const data = event.data;
				state.lastTool = {
					name: typeof data?.name === "string" ? data.name : "tool",
					state: "pending",
					excerpt: "",
				};
				return;
			}
			if (event?.type === "tool/result") {
				const state = keepAliveStateOf(session.id);
				const data = event.data;
				// The real payload nests the result inside message.content blocks
				// (`{ type: "tool-result", content, isError }`); accept the flat
				// `data.content` form too for robustness across host releases.
				const resultBlock =
					(Array.isArray(data?.message?.content) && data.message.content.find((part) => part?.type === "tool-result")) ||
					(null);
				const isError = resultBlock
					? resultBlock.isError === true
					: data?.isError === true || data?.error !== undefined;
				const content = resultBlock ? resultBlock.content : data?.content;
				const excerpt = extractToolResultText(content);
				state.lastTool = {
					name: state.lastTool?.name ?? "tool",
					state: isError ? "failed" : "done",
					excerpt,
				};
				return;
			}
			if (event?.type === "turn/start") {
				const state = keepAliveStateOf(session.id);
				state.lastTurn = event.data?.turn;
				// A fresh turn resets the last-tool guard evidence (the reference's
				// startTurn clears the tool correlation state).
				state.lastTool = null;
				return;
			}
			if (event?.type !== "turn/end") return;
			const kind = event?.data?.reason?.kind;
			if (kind === "error") return; // the agent/error path owns error turns
			const state = keepAliveStateOf(session.id);
			// token cap reached: a fresh turn can continue the same generation
			// without re-deriving it — wake with the max-tokens template.
			if (kind === "max-tokens") {
				const cfg = current();
				const ka = cfg?.retry?.keepAlive;
				if (cfg?.enabled === true && ka?.enabled !== false && state.timer === null && !keepAliveConsecutiveExhausted(state, ka?.maxConsecutive)) {
					const agent = agentFor(session);
					if (!agent) {
						logger.warn("auto-keepalive: max-tokens turn ended but no live agent is resolvable; skipping the wake", { sessionId: session.id });
						return;
					}
					const delay = keepAliveDelayMs(ka, state.streak);
					state.timer = setTimeout(() => injectTurnKeepAlive(agent, "MAX_TOKENS", state, state.lastFailure, true), delay);
					logger.warn(`auto-keepalive: turn hit the output-token cap; 继续 scheduled in ${Math.round(delay / 1000)}s`, { sessionId: session.id });
				}
				return;
			}
			if (state.timer !== null) {
				clearTimeout(state.timer);
				state.timer = null;
			}
			state.streak = 0;
		} catch {
			// Streak bookkeeping is best-effort.
		}
	});

	logger.info("auto-keepalive: turn keep-alive armed on agent/error");
	//#endregion

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
		logger.warn(`auto-mode: permission for "${tool}" auto-allowed${reason ? ` (${reason})` : ""}${root ? `; logged to ${AUTO_LOG_NAME}` : ""}`, { sessionId: sessionObjectSessionId(req?.agent?.session) });
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
					logger.warn(`auto-mode: ${kind} auto-answered (${detail}); logged to ${AUTO_LOG_NAME}`, { sessionId: sessionObjectSessionId(request?.agent?.session) });
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
