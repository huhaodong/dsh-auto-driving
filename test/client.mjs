/**
 * dsh-model-fallback client-UI render test.
 *
 * Loads lib/client.js in a stubbed browser environment (window /
 * __ModuleLoader__ / react) and drives the real FallbackSection + RetrySection
 * components through render and interaction: initial render, retry-field
 * edits, code-list parsing, restore-defaults, save round-trip, and the
 * disabled/writable surface.
 */
import { readFileSync } from "node:fs";

const failures = [];
const assert = (condition, message) => {
	if (condition) console.log(`ok: ${message}`);
	else {
		console.error(`FAIL: ${message}`);
		failures.push(message);
	}
};

//#region react stub (hook-order based, synchronous re-render)
let hookState = null;
const react = {
	createElement(tag, props, ...children) {
		return { tag, props: props ?? {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true) };
	},
	useState(initial) {
		const state = hookState;
		const index = state.index++;
		if (!state.cells[index]) state.cells[index] = { value: typeof initial === "function" ? initial() : initial };
		const set = (value) => {
			const next = typeof value === "function" ? value(state.cells[index].value) : value;
			if (!Object.is(next, state.cells[index].value)) {
				state.cells[index].value = next;
				state.rerender();
			}
		};
		return [state.cells[index].value, set];
	},
	useEffect(effect) {
		hookState.effects.push(effect);
	},
	useCallback(fn) {
		return fn;
	},
	useMemo(factory) {
		const state = hookState;
		const index = state.index++;
		if (!state.cells[index]) state.cells[index] = { value: factory() };
		return state.cells[index].value;
	},
	useRef(initial) {
		const state = hookState;
		const index = state.index++;
		if (!state.cells[index]) state.cells[index] = { value: { current: initial } };
		return state.cells[index].value;
	},
};

/**
 * Mount one component instance. Hook cells persist across renders, so state
 * written by event handlers stays visible to subsequent render() calls — the
 * same guarantee React gives between renders of one instance.
 */
function mount(component, props) {
	const state = { cells: [], index: 0, effects: [], rerender: null };
	const render = () => {
		state.index = 0;
		const previous = hookState;
		hookState = state;
		try {
			return component(props);
		} finally {
			hookState = previous;
		}
	};
	state.rerender = render;
	return {
		render,
		// Run recorded mount effects once (React commits effects after mount).
		runEffects: () => {
			render();
			state.cleanups = [];
			for (const effect of [...state.effects]) {
				const cleanup = effect?.();
				if (typeof cleanup === "function") state.cleanups.push(cleanup);
			}
		},
		// React runs effect cleanups in reverse order on unmount.
		unmount: () => {
			for (const cleanup of [...(state.cleanups ?? [])].reverse()) cleanup?.();
			state.cleanups = [];
		},
	};
}
//#endregion

//#region load the client bundle
const factories = new Map();
globalThis.window = { __ModuleLoader__: { load(definition) { factories.set(definition.id, definition.factory); } } };
(0, eval)(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"));
const factory = factories.get("dsh-model-fallback");
assert(typeof factory === "function", "client factory registered under dsh-model-fallback");

const exports = factory(() => react);
assert(typeof exports.apply === "function", "client exports apply()");
//#endregion

//#region host-side stubs
const DEFAULT_CODES = ["NETWORK_ERROR", "TIMEOUT", "CONNECTION_CLOSED", "RATE_LIMITED", "SERVER_ERROR", "SERVER", "RATE_LIMIT", "PI_AI_ERROR", "500", "502", "503", "504"];
let snapshotValue = {
	enabled: true,
	providers: ["p1"],
	retry: { enabled: true, maxRetries: 3, baseDelayMs: 500, retryableCodes: ["NETWORK_ERROR"] },
};
const sets = [];
const controller = {
	getSnapshot: () => ({ status: "ready", writable: true, mode: "host", value: snapshotValue }),
	subscribe: () => () => {},
	set: async (key, value) => {
		sets.push({ key, value });
		snapshotValue = { ...snapshotValue, [key]: value };
	},
};

// Auto-mode namespace controller (the merged tab's full-auto pane + pill wiring).
const autoSets = [];
let autoSnapshot = {};
const autoController = {
	getSnapshot: () => ({ status: "ready", writable: true, mode: "host", value: autoSnapshot }),
	subscribe: () => () => {},
	set: async (key, value) => {
		autoSets.push({ key, value });
		autoSnapshot = { ...autoSnapshot, [key]: value };
	},
};

const dictionaries = new Map();
const t = (key) => dictionaries.get("model-fallback")?.zh?.[key] ?? key;

const sections = [];
exports.apply({
	effect(fn) {
		return fn?.();
	},
	locale: {
		register(ns, dict) {
			dictionaries.set(ns, dict);
		},
		bind(ns) {
			return (key) => dictionaries.get(ns)?.zh?.[key] ?? key;
		},
	},
	get(service) {
		if (service === "connection") return { api: {} };
		if (service === "settingsScope") return { bind: () => controller };
		return null;
	},
	slots: {
		inject(_name, register) {
			register();
		},
		register(spec, component) {
			sections.push({ spec, component });
		},
	},
});
const sectionsByName = new Map(sections.map((entry) => [entry.spec.name, entry]));
const fallbackSection = sectionsByName.get("settings.section") && sections.find((entry) => entry.spec.id === "model-fallback");
const composerButton = sections.find((entry) => entry.spec.name === "conversation.input.right");
assert(sections.length === 2, `merged settings tab + composer pill registered (${sections.length})`);
assert(fallbackSection !== undefined && fallbackSection.spec.order === 20, "merged settings tab registered with order 20");
assert(fallbackSection.spec.label() === "自动驾驶", "merged tab uses the rootNav label (no separate full-auto tab)");
assert(composerButton !== undefined && composerButton.spec.id === "model-fallback-auto-drive", "auto-drive pill registered in the composer input bar");
assert(t("retrySection") === "任务重试", "zh dictionary carries the retry section strings");
//#endregion

//#region tree helpers
function walk(node, visit) {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	if (node.tag !== undefined) {
		visit(node);
		walk(node.children, visit);
	}
}

function textOf(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) textOf(child, out);
		return out;
	}
	if (typeof node === "object" && node.tag !== undefined) textOf(node.children, out);
	return out;
}

function findByText(root, wanted) {
	let hit = null;
	walk(root, (element) => {
		if (hit) return;
		if (textOf(element).join("") === wanted) hit = element;
	});
	return hit;
}

/**
 * Invoke nested stateless function elements (bounded depth) so their inner
 * elements become walkable — h(AutoToggleRow, …) children only exist once the
 * component function runs. Stateful instances must be mounted instead.
 */
function invokeFnElements(root, depth = 2) {
	const parts = [root];
	let frontier = [root];
	for (let level = 0; level < depth; level += 1) {
		const next = [];
		for (const node of frontier) {
			walk(node, (element) => {
				if (typeof element.tag === "function") next.push(element);
			});
		}
		frontier = next.map((element) => {
			// Stateful nested components (e.g. RetrySection) need a hook state to
			// render once for inspection; the throwaway cells are never written.
			const state = { cells: [], index: 0, effects: [], rerender: () => {} };
			const previous = hookState;
			hookState = state;
			try {
				return element.tag(element.props);
			} finally {
				hookState = previous;
			}
		});
		parts.push(...frontier);
	}
	return parts;
}

function findAllByTag(root, tag) {
	const hits = [];
	walk(root, (element) => {
		if (element.tag === tag) hits.push(element);
	});
	return hits;
}
//#endregion

//#region scenarios
const outer = mount(fallbackSection.component, { controller, autoController, api: {}, t });
const tree = outer.render();

// 1. outer section renders its core surface
assert(textOf(tree).join("").includes("模型供应商分组自动回退"), "fallback section renders the title");
assert(textOf(tree).join("").includes("刷新中…"), "fallback section renders the loading refresh button");

// 1b. sub-menu bar: four function panes, only the active one visible
assert(findByText(tree, "回退分组") !== null, "sub-menu bar shows the groups tab");
assert(findByText(tree, "任务重试") !== null, "sub-menu bar shows the retry tab");
assert(findByText(tree, "运行状态") !== null, "sub-menu bar shows the status tab");
assert(findByText(tree, "全自动模式") !== null, "sub-menu bar shows the full-auto tab");
const panesOf = (root) => findAllByTag(root, "div").filter((el) => typeof el.props.className === "string" && el.props.className.includes("dshmfb-tabPane"));
assert(panesOf(tree).length === 4, `four function panes rendered (${panesOf(tree).length})`);
assert(panesOf(tree).filter((el) => el.props.className.includes("dshmfb-tabPaneOff")).length === 3, "three panes hidden while groups is active");
const tabButtons = findAllByTag(tree, "button").filter((el) => typeof el.props.className === "string" && el.props.className.includes("dshmfb-tab"));
assert(tabButtons.length === 4, `sub-menu bar has four tab buttons (${tabButtons.length})`);
tabButtons[3].props.onClick();
const switched = panesOf(outer.render());
assert(switched.length === 4 && !switched[3].props.className.includes("dshmfb-tabPaneOff") && switched.filter((el) => el.props.className.includes("dshmfb-tabPaneOff")).length === 3, "clicking the full-auto tab switches the visible pane");
tabButtons[0].props.onClick();

// 2. the retry card is present as a nested function component
const retryElement = (() => {
	let found = null;
	walk(tree, (element) => {
		if (!found && typeof element.tag === "function") found = element;
	});
	return found;
})();
assert(retryElement !== null, "retry card is rendered inside the settings tab");

// Mount the retry card ONCE; hooks persist across renders, so interactions stick.
const card = mount(retryElement.tag, retryElement.props);
const first = card.render();
const firstText = textOf(first).join("");

// 3. static settings surface
assert(firstText.includes("任务重试"), "retry card shows its title");
assert(firstText.includes("已启用"), "retry card shows the enabled badge");
assert(findByText(first, "启用任务重试") !== null, "retry master toggle present");
assert(findByText(first, "最大重试次数") !== null, "max retries label present");
assert(findByText(first, "基础延迟(ms)") !== null, "base delay label present");
assert(findByText(first, "可重试错误码") !== null, "retryable codes label present");
assert(firstText.includes("候选链全部失败后"), "max retries hint present");
assert(firstText.includes("单次上限 10 秒"), "base delay hint present");
assert(firstText.includes("UNKNOWN_MODEL"), "codes hint lists the known model errors");

const numbers = findAllByTag(first, "input").filter((input) => input.props.type === "number");
assert(numbers.length === 8, `eight numeric inputs rendered (${numbers.length})`);
assert(numbers[0].props.value === 3 && numbers[1].props.value === 500 && numbers[2].props.value === 300000 && numbers[3].props.value === 2 && numbers[4].props.value === 5000 && numbers[5].props.value === 60000 && numbers[6].props.value === 2 && numbers[7].props.value === 0, "numeric inputs show stored values (3 retries / 500 ms / 300000 idle / 2 resends / 5000 wake / 60000 cap / backoff 2 / max consecutive 0)");

const codesInputOf = (root) => findAllByTag(root, "input").find((input) => input.props.type === "text" && String(input.props.className ?? "").includes("dshmfb-retryCodesInput"));
assert(codesInputOf(first).props.value === "NETWORK_ERROR", "codes input shows the stored code list");
const retryBoxes = findAllByTag(first, "input").filter((input) => input.props.type === "checkbox");
assert(retryBoxes.length === 5, `retry card has master + loop-retry + watchdog + keep-alive + guard toggles (${retryBoxes.length})`);
assert(retryBoxes[1].props.checked === true, "loop-level retry defaults on");
assert(retryBoxes[2].props.checked === true, "liveness watchdog defaults on");
assert(retryBoxes[3].props.checked === true, "turn keep-alive defaults on");
assert(retryBoxes[4].props.checked === true, "keep-alive idempotency guard defaults on");
assert(findByText(first, "轮次保活（继续唤醒）") !== null, "keep-alive toggle label present");
assert(firstText.includes("「本轮运行失败」"), "keep-alive description names the turn-error boundary");
assert(textOf(first).join("").includes("整轮重发"), "loop-retry hint explains the whole-request re-issue");
assert(findByText(first, "重试间隔: 500ms → 1s → 2s") !== null, "backoff preview shows the computed schedule");
assert(findByText(first, "保存").props.disabled === true, "save disabled before any edit");
assert(findByText(first, "放弃修改").props.disabled === true, "discard disabled before any edit");

// 4. editing maxRetries enables save and updates the preview
numbers[0].props.onChange({ target: { value: "5" } });
const edited = card.render();
assert(findByText(edited, "保存").props.disabled === false, "save button enables after an edit");
assert(findByText(edited, "放弃修改").props.disabled === false, "discard button enables after an edit");
assert(findByText(edited, "重试间隔: 500ms → 1s → 2s → 4s → 8s") !== null, "preview extends to five intervals");

// 5. save round-trip persists the parsed policy
await findByText(edited, "保存").props.onClick();
const saved = card.render();
const retrySave = sets.find((entry) => entry.key === "retry");
assert(retrySave !== undefined, "save writes the retry key through the controller");
assert(
	retrySave.value.maxRetries === 5 && retrySave.value.enabled === true && retrySave.value.baseDelayMs === 500,
	"saved retry policy keeps enabled/maxRetries/baseDelayMs",
);
assert(retrySave.value.keepAlive && retrySave.value.keepAlive.enabled === true && retrySave.value.keepAlive.delayMs === 5000 && retrySave.value.keepAlive.maxDelayMs === 60000, "saved retry policy round-trips the keep-alive defaults");
assert(JSON.stringify(retrySave.value.retryableCodes) === JSON.stringify(["NETWORK_ERROR"]), "saved retry policy keeps the code list");
assert(findByText(saved, "保存").props.disabled === true, "save disables again after persisting");

// 6. code list parsing: commas, spaces, CJK commas, empties
codesInputOf(card.render()).props.onChange({ target: { value: " NETWORK_ERROR，502  bad ,, " } });
await findByText(card.render(), "保存").props.onClick();
const lastSet = sets.filter((entry) => entry.key === "retry").at(-1);
assert(
	JSON.stringify(lastSet.value.retryableCodes) === JSON.stringify(["NETWORK_ERROR", "502", "bad"]),
	`code list parses commas/spaces/CJK commas and drops empties (${JSON.stringify(lastSet.value.retryableCodes)})`,
);

// 7. restore defaults repopulates the draft with the known default policy
findByText(card.render(), "恢复默认").props.onClick();
const restored = card.render();
assert(codesInputOf(restored).props.value === DEFAULT_CODES.join(", "), "restore defaults fills the default code list");
assert(findByText(restored, "保存").props.disabled === false, "restore defaults marks the draft dirty");
await findByText(restored, "保存").props.onClick();
const defaultsSet = sets.filter((entry) => entry.key === "retry").at(-1);
assert(
	defaultsSet.value.maxRetries === 3 && defaultsSet.value.baseDelayMs === 500 && JSON.stringify(defaultsSet.value.retryableCodes) === JSON.stringify(DEFAULT_CODES),
	"restore defaults + save persists the default policy",
);

// 8. master toggle off -> saved enabled=false
const toggle = findAllByTag(card.render(), "input").find((input) => input.props.type === "checkbox");
toggle.props.onChange({ target: { checked: false } });
const toggled = card.render();
assert(findByText(toggled, "未启用") !== null, "badge flips to 未启用 when toggled off");
assert(findByText(toggled, "重试间隔: 500ms → 1s → 2s") === null, "preview hides when retry is off");
await findByText(toggled, "保存").props.onClick();
const retryKeySets = sets.filter((entry) => entry.key === "retry");
assert(retryKeySets.at(-1).value.enabled === false, "toggling off persists enabled=false");
const watchdogSet = sets.filter((entry) => entry.key === "watchdog").at(-1);
assert(watchdogSet !== undefined && watchdogSet.value.enabled === true && watchdogSet.value.idleTimeoutMs === 300000 && watchdogSet.value.resends === 2, "watchdog defaults round-trip through the top-level key (5 min idle, 2 resends)");

// 9. read-only connection disables every input and button
const readonly = mount(retryElement.tag, { ...retryElement.props, writable: false });
const readonlyTree = readonly.render();
const readonlyInputs = findAllByTag(readonlyTree, "input");
const disabledInputs = readonlyInputs.filter((input) => input.props.disabled === true);
assert(readonlyInputs.length === 16 && disabledInputs.length === 16, `read-only connection disables every retry control (${disabledInputs.length}/${readonlyInputs.length})`);
assert(findByText(readonlyTree, "保存").props.disabled === true, "read-only connection disables save");
assert(findByText(readonlyTree, "恢复默认").props.disabled === true, "read-only connection disables restore defaults");
//#endregion

// ===== fallback tab: runtime status card =====
{
	const mountFallback = mount(fallbackSection.component, { controller, autoController, api: {}, t });
	const parts = invokeFnElements(mountFallback.render(), 3);
	const statusText = textOf(parts).join("");

	assert(statusText.includes("运行状态"), "status card renders its title");
	assert(statusText.includes("未选定分组也纳入保护"), "status card shows the protectUnselected toggle label");

	// Drive the toggle through StatusCard's own onToggleProtect prop — the
	// stateless card hands that callback straight to its checkbox.
	let foundProtect = false;
	const statusCards = [];
	for (const part of parts) {
		walk(part, (element) => {
			if (typeof element.tag === "function" && element.props && typeof element.props.onToggleProtect === "function") statusCards.push(element);
		});
	}
	for (const card of statusCards) {
		const st = { cells: [], index: 0, effects: [], rerender: () => {} };
		const previous = hookState;
		hookState = st;
		try {
			const subtree = card.tag(card.props);
			const boxes = [];
			walk(subtree, (element) => {
				if (element.tag === "input" && element.props.type === "checkbox") boxes.push(element);
			});
			// First checkbox in DOM order is the protect toggle; the second is
			// allProvidersFallback (default off since v0.1.6).
			assert(boxes.length === 2, `status card has both toggles (${boxes.length})`);
			assert(boxes[0].props.checked === true, "status card: protectUnselected defaults to checked");
			assert(boxes[1].props.checked === false, "status card: allProvidersFallback defaults to off (unselected providers excluded)");
			foundProtect = true;
		} finally {
			hookState = previous;
		}
	}
	assert(statusCards.length >= 1, "status card: StatusCard element found");
	statusCards[0].props.onToggleProtect(false);
	// Re-capture AFTER the toggle: the pre-toggle tree's closures hold the
	// stale draft (the same stale-closure hazard the earlier scenarios fix).
	const afterToggle = invokeFnElements(mountFallback.render(), 3);
	assert(findByText(afterToggle, "保存").props.disabled === false, "status card: toggling protection enables save");
	await findByText(afterToggle, "保存").props.onClick();
	const protectSet = sets.find((entry) => entry.key === "protectUnselected");
	assert(protectSet !== undefined && protectSet.value === false, "status card: save persists protectUnselected=false");
	assert(sets.some((entry) => entry.key === "providers" && Array.isArray(entry.value)), "status card save also rewrites the providers list");
}

// ===== fallback tab: arrears marker + per-provider model pool =====
{
	const arrearsSets = [];
	let arrearsSnapshot = {
		enabled: true,
		providers: ["p1"],
		arrears: { p1: true },
		providerModels: { p1: ["m1"] },
	};
	const arrearsListeners = new Set();
	const arrearsController = {
		getSnapshot: () => ({ status: "ready", writable: true, mode: "host", value: arrearsSnapshot }),
		subscribe: (listener) => {
			arrearsListeners.add(listener);
			return () => arrearsListeners.delete(listener);
		},
		set: async (key, value) => {
			arrearsSets.push({ key, value });
			arrearsSnapshot = { ...arrearsSnapshot, [key]: value };
			for (const listener of [...arrearsListeners]) listener();
		},
	};
	const catalogApi = {
		llm: {
			providers: async () => ({ result: { ok: true, value: { providers: [{ provider: "p1", displayName: "Provider One", active: true }] } } }),
			models: async () => ({ result: { ok: true, value: { groups: [{ id: "p1", models: [{ id: "m1" }, { id: "m2" }] }], failures: [] } } }),
		},
	};

	const arrearsMount = mount(fallbackSection.component, { controller: arrearsController, autoController, api: catalogApi, t });
	arrearsMount.runEffects(); // fires the catalog load effect
	await new Promise((resolve) => setTimeout(resolve, 10)); // let loadCatalog settle
	let arrearsTree = arrearsMount.render();
	let arrearsText = textOf(arrearsTree).join("");

	assert(arrearsText.includes("欠费"), "provider row shows the arrears badge for a marked account");
	const closeButtons = [];
	walk(arrearsTree, (element) => {
		if (element.tag === "button" && element.props?.className === "dshmfb-arrearsClose") closeButtons.push(element);
	});
	assert(closeButtons.length === 1, `arrears badge has exactly one close control (${closeButtons.length})`);
	assert(closeButtons[0].props.disabled === false, "arrears close control is enabled on a writable connection");

	// Model pool chips: p1 selected with providerModels {p1:["m1"]} — m1 checked, m2 unchecked.
	const chipsOf = (tree) => {
		const chips = [];
		walk(tree, (element) => {
			if (element.tag === "label" && element.props?.className === "dshmfb-modelChip") chips.push(element);
		});
		return chips.map((chip) => ({
			id: textOf(chip).join(""),
			input: (chip.children ?? []).find((child) => child && child.tag === "input"),
		}));
	};
	let chips = chipsOf(arrearsTree);
	assert(chips.length === 2, `selected provider renders one chip per catalog model (${chips.length})`);
	assert(chips[0].id === "m1" && chips[1].id === "m2", "model chips render in catalog order");
	assert(chips[0].input.props.checked === true, "m1 is checked (in providerModels selection)");
	assert(chips[1].input.props.checked === false, "m2 is unchecked (not in providerModels selection)");
	assert(chips[1].input.props.disabled === false, "model chips are editable on a writable connection");

	// Clicking × persists the arrears dict WITHOUT the cleared account.
	closeButtons[0].props.onClick();
	arrearsTree = arrearsMount.render();
	const arrearsSet = arrearsSets.find((entry) => entry.key === "arrears");
	assert(arrearsSet !== undefined && typeof arrearsSet.value === "object" && arrearsSet.value.p1 === undefined, "closing the arrears tag persists the dict without the account key");
	assert(!textOf(arrearsMount.render()).join("").includes("欠费"), "arrears badge disappears after clearing");

	// Checking the last model completes the selection -> the key is dropped entirely.
	chips = chipsOf(arrearsMount.render());
	chips[1].input.props.onChange();
	const afterCheck = arrearsMount.render();
	assert(findByText(afterCheck, "保存").props.disabled === false, "model-pool edit marks the draft dirty");
	await findByText(afterCheck, "保存").props.onClick();
	const poolSet = arrearsSets.filter((entry) => entry.key === "providerModels").at(-1);
	assert(poolSet !== undefined && poolSet.value.p1 === undefined, "selecting every model drops the provider key (all-models default)");
}

// ===== composer combo pill (fallback + auto-drive) =====
{
	const makeController = (setsRef) => {
		let snapshot = {};
		const listeners = new Set();
		return {
			getSnapshot: () => ({ status: "ready", writable: true, mode: "host", value: snapshot }),
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			set: async (key, value) => {
				setsRef.push({ key, value });
				snapshot = { ...snapshot, [key]: value };
				for (const listener of [...listeners]) listener();
			},
		};
	};

	const fallbackSets = [];
	const autoSets = [];
	const fallbackPillController = makeController(fallbackSets);
	const autoPillController = makeController(autoSets);

	// The registration's inject() wires both controllers; exercise directly.
	const pillMount = mount(composerButton.component, { controller: fallbackPillController, autoController: autoPillController, t });
	pillMount.runEffects(); // activates the snapshot subscriptions
	const pillTree = pillMount.render();

	assert(pillTree.props.className === "dshmfb-comboPill", "composer renders the combined capsule");

	// Find the two nested HalfPill function elements.
	const halfPillElements = [];
	walk(pillTree, (element) => {
		if (typeof element.tag === "function") halfPillElements.push(element);
	});
	assert(halfPillElements.length === 2, `combined pill contains two half-pill elements (${halfPillElements.length})`);

	// Mount each half and exercise its toggle.
	const testHalf = async (element, sets, label) => {
		const halfMount = mount(element.tag, element.props);
		halfMount.runEffects();
		const halfTree = halfMount.render();
		const buttons = findAllByTag(halfTree, "button");
		assert(buttons.length === 1, `${label} half renders one button`);
		const button = buttons[0];
		assert(button.props["aria-pressed"] === false, `${label} half starts unpressed`);
		assert(button.props.disabled === false, `${label} half is clickable on a writable connection`);
		assert(typeof button.props["data-tip"] === "string" && button.props["data-tip"].length > 0, `${label} half carries a hover tooltip (data-tip)`);
		assert(/点击关闭|点击开启|turn off|turn on/i.test(button.props["data-tip"]), `${label} half tooltip explains function and state`);

		await button.props.onClick();
		const afterOn = halfMount.render();
		const onButton = findAllByTag(afterOn, "button")[0];
		assert(onButton.props["aria-pressed"] === true, `${label} half flips to pressed after a click`);
		assert(onButton.props["data-tip"] !== button.props["data-tip"], `${label} half tooltip reflects the toggled state`);

		await onButton.props.onClick();
		const afterOff = halfMount.render();
		const offButton = findAllByTag(afterOff, "button")[0];
		assert(offButton.props["aria-pressed"] === false, `${label} half toggles back off`);

		const set = sets.find((entry) => entry.key === "enabled");
		assert(set !== undefined && set.value === true, `${label} half writes the enabled key`);
	};

	await testHalf(halfPillElements[0], autoSets, "auto");
	await testHalf(halfPillElements[1], fallbackSets, "fallback");
}

// ===== activity log card =====
{
	// Stub fetch with a canned ring payload; render the fallback tab and locate
	// the nested LogCard subtree (the function element rendering 工作日志).
	const fetches = [];
	globalThis.fetch = async (url, init) => {
		fetches.push({ url, init });
		return {
			ok: true,
			status: 200,
			json: async () => ({
				cap: 200,
				events: [
					{ at: "2026-09-01T08:30:00.000Z", level: "warn", message: "model-fallback: a failed (SERVER: 500); switching to b" },
					{ at: "2026-09-01T08:30:05.000Z", level: "info", message: "model-fallback: request recovered on b after 1 switch(es)" },
				],
			}),
		};
	};

	const logTabMount = mount(fallbackSection.component, { controller, autoController, api: {}, t });
	const parts = invokeFnElements(logTabMount.render(), 3);
	let logCardElement = null;
	for (const part of parts) {
		if (logCardElement) break;
		walk(part, (element) => {
			if (logCardElement || typeof element.tag !== "function") return;
			const st = { cells: [], index: 0, effects: [], rerender: () => {} };
			const previous = hookState;
			hookState = st;
			try {
				const subtree = element.tag(element.props);
				if (textOf(subtree).join("").includes("工作日志")) logCardElement = element;
			} finally {
				hookState = previous;
			}
		});
	}
	assert(logCardElement !== null, "log card renders its title inside the fallback tab");

	// Mount LogCard for real: runEffects fires the fetch effect, the promise
	// chain resolves on a microtask, and the re-render shows the events.
	const logMount = mount(logCardElement.tag, logCardElement.props);
	logMount.runEffects();
	await new Promise((resolve) => setTimeout(resolve, 10));
	const logText = textOf(logMount.render()).join("");
	assert(logText.includes("switching to b") && logText.includes("request recovered"), "log card lists the fetched events");
	assert(fetches.some((call) => call.url === "/dsh-model-fallback/api/log" && call.init?.cache === "no-store"), "log card fetches the host route with cache: no-store");
	delete globalThis.fetch;
}

// ===== full-auto (now a pane inside the merged settings tab) =====
let autoSectionComponent = null;
{
	// AutoModeSection lives INSIDE the merged tab; locate its function element
	// in the merged tree, then mount it standalone exactly the way the settings
	// page does: { controller, t } only — writability comes from the snapshot.
	const mergedMount = mount(fallbackSection.component, { controller, autoController, api: {}, t });
	const mergedParts = invokeFnElements(mergedMount.render(), 3);
	for (const part of mergedParts) {
		if (autoSectionComponent) break;
		walk(part, (element) => {
			if (autoSectionComponent || typeof element.tag !== "function") return;
			const st = { cells: [], index: 0, effects: [], rerender: () => {} };
			const previous = hookState;
			hookState = st;
			try {
				const subtree = element.tag(element.props);
				if (textOf(subtree).join("").includes("全自动模式（默认允许）")) autoSectionComponent = element.tag;
			} finally {
				hookState = previous;
			}
		});
	}
	assert(autoSectionComponent !== null, "auto section found inside the merged tab tree");
	const autoMount = mount(autoSectionComponent, { controller: autoController, t });
	const partsOf = () => invokeFnElements(autoMount.render());
	const autoText = textOf(partsOf()).join("");

	assert(autoText.includes("全自动模式（默认允许）"), "auto tab shows its title");
	assert(autoText.includes("未启用"), "auto tab shows the off badge by default (opt-in)");
	assert(autoText.includes("AUTO-MODE.md"), "auto tab names the workspace audit file");
	assert(autoText.includes("exit_plan_mode"), "plan-review hint explains the plan channel");

	const boxesOf = () => findAllByTag(partsOf(), "input").filter((input) => input.props.type === "checkbox");
	let boxes = boxesOf();
	assert(boxes.length === 5, `five toggles rendered (${boxes.length})`);
	assert(boxes.every((box) => box.props.checked === false), "all toggles start unchecked");
	assert(boxes.every((box) => box.props.disabled === false), "writable snapshot enables every toggle (regression: no writable prop)");

	// Master toggle on first, then the four sub-toggles. Re-capture before
	// every click: each onChange rerenders synchronously, so stale closures
	// would clobber the previous flip.
	boxes[0].props.onChange({ target: { checked: true } });
	for (let index = 1; index < 5; index += 1) {
		boxes = boxesOf();
		boxes[index].props.onChange({ target: { checked: true } });
	}
	const afterOn = partsOf();
	assert(findByText(afterOn, "已启用") !== null, "badge flips to 已启用 when the master toggle goes on");
	assert(findByText(afterOn, "保存").props.disabled === false, "auto save enables after edits");
	await findByText(afterOn, "保存").props.onClick();
	assert(autoSets.length === 5, `save persists all five keys (${autoSets.length})`);
	assert(autoSets.every((entry) => entry.value === true), "all five keys saved as true");
	assert(findByText(partsOf(), "保存").props.disabled === true, "auto save disables again after persisting");
}

{
	// Read-only connection: the SNAPSHOT (not a prop) disables the surface.
	const readonlyAuto = mount(autoSectionComponent, {
		controller: { getSnapshot: () => ({ status: "ready", writable: false, mode: "remote", value: autoSnapshot }), subscribe: () => () => {}, set: async () => {} },
		t,
	});
	const readonlyParts = invokeFnElements(readonlyAuto.render());
	const boxes = findAllByTag(readonlyParts, "input").filter((input) => input.props.type === "checkbox");
	assert(boxes.length === 5 && boxes.every((box) => box.props.disabled === true), "read-only connection disables every auto toggle");
	assert(findByText(readonlyParts, "保存").props.disabled === true, "read-only connection disables auto save");
}

// ===== per-conversation toast bubble: session gating, switch replay, composer follow =====
{
	//#region minimal DOM + rAF + SSE stubs
	class StubElement {
		constructor(tag) {
			this.tagName = tag;
			this.children = [];
			this.parentElement = null;
			this.style = {};
			this.dataset = {};
			this.className = "";
			this.id = "";
			this.textContent = "";
			this.offsetWidth = 0;
			this.visible = false; // offsetParent proxy for composerBarForToast
			this.hasTextarea = false; // composer marker
			this.rect = { left: 100, top: 300, width: 600, height: 60 };
			this.isConnected = true;
			this.classes = new Set();
		}
		get clientWidth() {
			return this.rect.width;
		}
		get classList() {
			const classes = this.classes;
			return {
				add: (...names) => names.forEach((name) => classes.add(name)),
				remove: (...names) => names.forEach((name) => classes.delete(name)),
				contains: (name) => classes.has(name),
				toggle: (name, force) => {
					const has = classes.has(name);
					const next = force === undefined ? !has : force;
					if (next) classes.add(name);
					else classes.delete(name);
					return next;
				},
			};
		}
		get offsetParent() {
			return this.visible ? { stub: true } : null;
		}
		appendChild(child) {
			child.parentElement = this;
			this.children.push(child);
			return child;
		}
		replaceChildren(...kids) {
			this.children = kids;
		}
		querySelector(selector) {
			if (selector === "textarea" && this.hasTextarea) return {};
			for (const child of this.children) {
				if (typeof child.querySelector === "function") {
					const hit = child.querySelector(selector);
					if (hit) return hit;
				}
			}
			return null;
		}
		getBoundingClientRect() {
			return this.rect;
		}
	}

	const pillEl = new StubElement("div");
	pillEl.className = "dshmfb-comboPill";
	pillEl.visible = true;
	const composerEl = new StubElement("div");
	composerEl.hasTextarea = true;
	composerEl.appendChild(pillEl);
	const documentStub = {
		head: new StubElement("head"),
		body: new StubElement("body"),
		createElement: (tag) => new StubElement(tag),
		querySelector: (selector) => (selector === ".dshmfb-comboPill" ? pillEl : null),
		querySelectorAll: (selector) => (selector === ".dshmfb-comboPill" ? [pillEl] : []),
		getElementById(id) {
			const find = (node) => {
				if (node.id === id) return node;
				for (const child of node.children) {
					const hit = find(child);
					if (hit) return hit;
				}
				return null;
			};
			return find(this.body);
		},
	};
	let frameSeq = 0;
	let frameQueue = [];
	globalThis.document = documentStub;
	globalThis.requestAnimationFrame = (fn) => {
		frameSeq += 1;
		frameQueue.push({ id: frameSeq, fn });
		return frameSeq;
	};
	globalThis.cancelAnimationFrame = (id) => {
		frameQueue = frameQueue.filter((entry) => entry.id !== id);
	};
	const flushFrames = (count = 2) => {
		for (let index = 0; index < count; index += 1) {
			const queue = frameQueue;
			frameQueue = [];
			for (const entry of queue) entry.fn();
		}
	};

	class StubEventSource {
		constructor(url) {
			this.url = url;
			this.closed = false;
			StubEventSource.instances.push(this);
		}
		close() {
			this.closed = true;
		}
		emit(entry) {
			this.onmessage?.({ data: JSON.stringify(entry) });
		}
	}
	StubEventSource.instances = [];
	globalThis.EventSource = StubEventSource;

	// The responsive capsule watches the composer bar through a ResizeObserver;
	// the stub records instances so tests can drive width changes manually.
	class StubResizeObserver {
		constructor(callback) {
			this.callback = callback;
			StubResizeObserver.instances.push(this);
		}
		observe() {}
		disconnect() {}
		emit() {
			this.callback();
		}
	}
	StubResizeObserver.instances = [];
	globalThis.ResizeObserver = StubResizeObserver;

	// Re-apply the plugin WITH a DOM: this arms the global toast feed through
	// the SSE stub (the first apply() ran before any DOM existed).
	exports.apply({
		effect(fn) {
			return fn?.();
		},
		locale: {
			register(ns, dict) {
				dictionaries.set(ns, dict);
			},
			bind(ns) {
				return (key) => dictionaries.get(ns)?.zh?.[key] ?? key;
			},
		},
		get(service) {
			if (service === "connection") return { api: {} };
			if (service === "settingsScope") return { bind: () => controller };
			return null;
		},
		slots: {
			inject(_name, register) {
				register();
			},
			register(spec, component) {
				sections.push({ spec, component });
			},
		},
	});
	const feedSource = StubEventSource.instances.at(-1);
	assert(feedSource?.url === "/dsh-model-fallback/api/events", "toast feed subscribes to the SSE event stream");
	globalThis.fetch = async () => ({ ok: true, json: async () => ({ cap: 200, events: [] }) });

	const nodeText = (node) => (node.children.length === 0 ? node.textContent ?? "" : node.children.map(nodeText).join(""));
	const hostNode = () => documentStub.getElementById("dshmfb-toast-host");
	const hostVisible = () => hostNode()?.dataset.visible === "1";
	const hostText = () => {
		const host = hostNode();
		return host ? nodeText(host) : "";
	};
	//#endregion

	// A. No conversation on screen: a session-tagged event stays dormant
	//    (recorded for that conversation, never displayed).
	feedSource.emit({ at: "2026-09-03T10:00:00.000Z", level: "warn", message: 'auto-mode: permission for "bash" auto-allowed; logged to AUTO-MODE.md', sessionId: "session-1" });
	assert(!hostVisible(), "no bubble before any conversation page is on screen");

	// B. The conversation page for session-1 mounts (its pill reports the
	//    session id) -> its still-fresh status replays on enter, anchored to
	//    the composer bar.
	const pill1 = mount(composerButton.component, { controller, autoController, t, sessionId: "session-1" });
	pill1.runEffects();
	assert(hostVisible(), "bubble shows when its own conversation page is on screen");
	assert(hostText().includes("已自动允许权限"), `bubble text is the auto-allowed notice (${hostText()})`);
	assert(hostNode().style.left === "400px" && hostNode().style.top === "256px", `bubble anchors centered 44px above the composer (${hostNode().style.left}/${hostNode().style.top})`);

	// C. A background conversation's event never leaks into session-1's page.
	feedSource.emit({ at: "2026-09-03T10:00:05.000Z", level: "warn", message: "model-fallback: p/a failed (AUTH_FAILED: 403); switching to p/b", sessionId: "session-2" });
	assert(hostText().includes("已自动允许权限") && !hostText().includes("模型已切换"), "another conversation's switch event does not replace the bubble");

	// D. Switching to session-2 hides session-1's bubble and replays
	//    session-2's OWN still-fresh status.
	const pill2 = mount(composerButton.component, { controller, autoController, t, sessionId: "session-2" });
	pill2.runEffects();
	pill1.unmount();
	assert(hostVisible(), "the new conversation's fresh status replays after the switch");
	assert(hostText().includes("模型已切换: p/a → p/b"), `switch replay shows THAT conversation's switch (${hostText()})`);

	// E. The bubble follows the composer when the layout moves it.
	composerEl.rect = { left: 300, top: 500, width: 400, height: 60 };
	flushFrames(2);
	assert(hostNode().style.left === "500px" && hostNode().style.top === "456px", `bubble keeps its relative spot when the composer moves (${hostNode().style.left}/${hostNode().style.top})`);

	// F. The conversation leaving the screen takes the bubble with it.
	pillEl.visible = false;
	flushFrames(2);
	assert(!hostVisible(), "bubble hides when the composer disappears from the screen");
	pillEl.visible = true;

	// G. A conversation with no recorded status shows no bubble.
	const pill3 = mount(composerButton.component, { controller, autoController, t, sessionId: "session-3" });
	pill3.runEffects();
	pill2.unmount();
	assert(!hostVisible(), "no bubble on a conversation without a fresh status");

	// H. An expired status (older than the 30 s window) does not replay.
	feedSource.emit({ at: "2026-09-03T10:00:10.000Z", level: "warn", message: "model-fallback: request recovered on p/c after 1 switch(es)", sessionId: "session-4" });
	const realNow = Date.now;
	Date.now = () => realNow() + 31000;
	const pill4 = mount(composerButton.component, { controller, autoController, t, sessionId: "session-4" });
	pill4.runEffects();
	pill3.unmount();
	Date.now = realNow;
	assert(!hostVisible(), "an expired status does not replay when entering its conversation");

	// I. An unattributable event (no sessionId) never surfaces as a bubble.
	feedSource.emit({ at: "2026-09-03T10:00:15.000Z", level: "warn", message: "model-fallback: x/y failed (AUTH_FAILED: 403); switching to z/w" });
	assert(!hostVisible(), "an event without session attribution never displays");

	// J. Leaving every conversation (settings page) keeps the bubble hidden.
	pill4.unmount();
	assert(!hostVisible(), "bubble stays hidden with no conversation on screen");

	// K. Full-auto notices read apart per channel: a plan review bubbles as
	//    「已自动批准方案」— its own notice, distinct from a question answer.
	const pill5 = mount(composerButton.component, { controller, autoController, t, sessionId: "session-5" });
	pill5.runEffects();
	feedSource.emit({ at: "2026-09-03T10:00:20.000Z", level: "warn", message: "auto-mode: 方案审批 auto-answered (Approve this plan and leave plan mode?); logged to AUTO-MODE.md", sessionId: "session-5" });
	assert(hostVisible(), "the plan-review event bubbles on its own conversation page");
	assert(hostText().includes("已自动批准方案"), `plan review shows its own notice (${hostText()})`);
	assert(!hostText().includes("已自动应答确认提问"), "the plan notice is not the generic question notice");

	// L. A long question detail is capped inside the bubble (the full text
	//    stays in the log viewer and AUTO-MODE.md) so the pill keeps shape.
	const longQuestion = "你".repeat(80);
	feedSource.emit({ at: "2026-09-03T10:00:25.000Z", level: "warn", message: `auto-mode: 人工确认 auto-answered (${longQuestion}); logged to AUTO-MODE.md`, sessionId: "session-5" });
	assert(hostText().includes("已自动应答确认提问") && hostText().includes("…"), `a long question detail is capped with an ellipsis (${hostText().length} chars)`);
	assert(!hostText().includes(longQuestion), "the bubble never carries the full 80-char question");
	pill5.unmount();

	// M. Responsive capsule: a tight composer row drops the text labels and
	//    keeps the dot / layers icon (compact class driven by the bar width).
	const pill6 = mount(composerButton.component, { controller, autoController, t, sessionId: "session-6" });
	pill6.runEffects();
	composerEl.rect = { left: 100, top: 300, width: 900, height: 60 };
	StubResizeObserver.instances.at(-1).emit();
	assert(!pillEl.classes.has("dshmfb-comboCompact"), "a wide composer keeps the text labels visible");
	composerEl.rect = { left: 100, top: 300, width: 500, height: 60 };
	StubResizeObserver.instances.at(-1).emit();
	assert(pillEl.classes.has("dshmfb-comboCompact"), "a narrow composer switches the capsule to icon-only compact mode");
	pill6.unmount();
	assert(!pillEl.classes.has("dshmfb-comboCompact"), "unmount clears the compact class");

	//#endregion teardown
	delete globalThis.document;
	delete globalThis.requestAnimationFrame;
	delete globalThis.cancelAnimationFrame;
	delete globalThis.EventSource;
	delete globalThis.ResizeObserver;
	delete globalThis.fetch;
}

if (failures.length > 0) {
	console.error(`CLIENT UI TEST FAILED (${failures.length})`);
	process.exitCode = 1;
} else {
	console.log("CLIENT UI TEST PASSED");
}
