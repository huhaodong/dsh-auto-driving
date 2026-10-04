/**
 * dsh-model-fallback NEXT-mode settings test.
 *
 * Simulates the dsh-settings 0.2.x `SettingsForms` seam (no `register`;
 * describe rows keyed by profile entry id; root-level `settings/document-updated`
 * emits) and asserts the plugin's live config source, the full-auto `auto`
 * subtree mirror, and write re-pulls actually update. Guards the DSH NEXT
 * regression where the settings page went dead (no volatile fields -> the
 * entry was invisible to describe(), so toggles could not read or write).
 */
import { apply, __clearHealthCache } from "../lib/index.js";

const assert = (condition, message) => {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`ok: ${message}`);
	}
};

const log = [];
const logger = {
	warn: (...a) => log.push(["warn", a.join(" ")]),
	info: (...a) => log.push(["info", a.join(" ")]),
	error: (...a) => log.push(["error", a.join(" ")]),
};

// --- fake SettingsForms (dsh-settings 0.2.x shape) ---
/** The live "profile patch" document the forms project. */
let doc = {
	enabled: true,
	providers: ["p1", "p2"],
	protectUnselected: true,
	allProvidersFallback: false,
	arrears: {},
	providerModels: {},
	sessionModes: {},
	auto: { enabled: false, autoAllowPermissions: true, autoAnswerQuestions: true, autoApprovePlans: true, workspaceLog: true },
	watchdog: {},
	retry: {},
};
let revision = 0;
const rootListeners = [];
const root = {
	on(event, listener) {
		if (event === "settings/document-updated") rootListeners.push(listener);
		return () => {};
	},
};
const fakeSettingsForms = {
	// No `register`: the 0.2.x form seam. Must route through the NEXT branch.
	describe() {
		return [{ ns: "model-fallback", revision, value: JSON.parse(JSON.stringify(doc)) }];
	},
	async update(ns, patch) {
		doc = { ...doc, ...JSON.parse(JSON.stringify(patch)) };
		revision += 1;
		for (const listener of rootListeners) listener("model-fallback", revision);
	},
};

const fakeLlm = { listModels: async () => [], adapterStream: async function* () {} };
const fakeWebServer = { register: () => () => {} };
const fakeSystemPrompt = { context: () => {} };

const ctx = {
	fiber: { state: 0 },
	logger,
	llm: fakeLlm,
	root,
	settings: fakeSettingsForms,
	get: () => undefined,
	on: () => () => {},
	effect(factory, name) {
		const result = factory();
		return typeof result === "function" ? result : undefined;
	},
	inject(deps, callback) {
		callback(ctx);
	},
};

__clearHealthCache();
apply(ctx, { enabled: true, providers: [] });

// The helpers are closures inside apply(); assert through observable state:
// `describeSelection` logs on every settings change.
const lastInfo = () => log.filter(([level]) => level === "info").map(([, text]) => text).join("\n");

assert(rootListeners.length >= 1, "listener registered on the root context for settings/document-updated");
assert(lastInfo().includes("2 provider group(s): p1 -> p2"), "live config source pulled from the describe() row (providers merged)");
assert(lastInfo().includes("auto-mode: disabled"), "auto subtree pulled from the shared row (auto.enabled=false)");

// Simulate the client toggling full-auto mode: remote.settings.mutate -> entry
// config update -> document-updated push.
doc.auto = { ...doc.auto, enabled: true };
await fakeSettingsForms.update("model-fallback", {});
assert(lastInfo().includes("auto-mode: enabled (permissions, questions, plans, audit)"), "document-updated push re-pulls the auto subtree (autopilot ON)");

// Simulate a fallback-config write: sessionModes + disabled provider pool.
doc.providers = ["p2"];
doc.sessionModes = { s1: { auto: true, fallback: null } };
await fakeSettingsForms.update("model-fallback", {});
assert(lastInfo().includes("1 provider group(s): p2") && lastInfo().includes("per-conversation toggles=1"), "main-config writes re-pull (providers + session overrides)");

console.log(process.exitCode ? "NEXT-MODE TEST FAILED" : "NEXT-MODE TEST PASSED");
