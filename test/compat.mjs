/**
 * dsh-model-fallback cross-version compatibility matrix.
 *
 * The plugin resolves `@deepseek-ai/dsh-settings` to whatever generation the
 * host harness ships, and that package's export surface moved twice:
 *
 *   - 0.0.1-rc.x … 0.1.6  export `installSettingsSection` / `settingsNamespace`
 *   - 0.1.7 … 0.2.x       dropped both (SettingsForms seam only)
 *
 * A static named import crashed the plugin at load time ("does not provide an
 * export named …") on every 0.1.7+ host. This matrix vendors the REAL package
 * files of one representative generation per era (test/fixtures/dsh-settings,
 * extracted from the published npm tarballs, MIT) and loads the plugin against
 * each: module load, schema construction, and a live settings install on BOTH
 * host seam shapes (legacy `settings.register` registry and NEXT
 * `settings.describe()` forms) must all succeed and reach the same state.
 *
 * Everything except the dsh-settings generation under test resolves to the
 * real workspace tree (schemastery / cordis / cosmokit); only the fixture's
 * own load-time imports that the workspace does not carry (`yaml`,
 * `@deepseek-ai/cordis-plugin-loader`, `isVolatile` from cosmokit) get stubs.
 */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const assert = (condition, message) => {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`ok: ${message}`);
	}
};

/** Representative real @deepseek-ai/dsh-settings generations and their era. */
const GENERATIONS = [
	{ version: "0.0.1-rc.1", helpers: true, era: "earliest published (helpers exported)" },
	{ version: "0.1.1-rc.2", helpers: true, era: "legacy section registry era (helpers exported)" },
	{ version: "0.1.7-rc.2", helpers: false, era: "SettingsForms seam lands (helpers REMOVED)" },
	{ version: "0.2.1-alpha.1", helpers: false, era: "current DSH NEXT (helpers removed)" },
];

/** Stub a tiny ESM package inside `nodeModulesDir`. */
async function stub(nodeModulesDir, name, code) {
	const dir = join(nodeModulesDir, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-stub", type: "module", main: "index.js" }));
	await writeFile(join(dir, "index.js"), code);
}

/** Walk up from a resolved module entry to its package root (dir with package.json). */
function packageRootOf(entry) {
	let dir = dirname(entry);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) return dir;
		dir = dirname(dir);
	}
	throw new Error(`no package root above ${entry}`);
}

/**
 * Build one isolated tree: the plugin entry copied next to a node_modules that
 * shadows `@deepseek-ai/dsh-settings` with the fixture generation and links the
 * real workspace schemastery / cordis beside it. Load-time imports the
 * workspace cannot satisfy for the newer fixture generations (`yaml`,
 * `@deepseek-ai/cordis-plugin-loader`, cosmokit's `isVolatile`) get stubs.
 */
async function buildTree(version) {
	const scratch = join(here, ".tmp");
	await mkdir(scratch, { recursive: true });
	const root = await mkdtemp(join(scratch, `compat-${version}-`));
	const nodeModules = join(root, "node_modules");
	const scope = join(nodeModules, "@deepseek-ai");
	await mkdir(scope, { recursive: true });
	await cp(join(here, "fixtures", "dsh-settings", version), join(scope, "dsh-settings"), { recursive: true });
	// Real peers, linked from the workspace install (resolution follows the
	// symlink to the store, so their own dependencies still resolve).
	const link = process.platform === "win32" ? "junction" : "dir";
	const workspaceSettings = await realpath(join(repoRoot, "node_modules", "@deepseek-ai", "dsh-settings"));
	const workspaceRequire = createRequire(join(workspaceSettings, "package.json"));
	await symlink(packageRootOf(workspaceRequire.resolve("@deepseek-ai/schemastery")), join(scope, "schemastery"), link);
	await symlink(packageRootOf(workspaceRequire.resolve("@deepseek-ai/cordis")), join(scope, "cordis"), link);
	// Load-time imports of the newer fixture generations the workspace lacks.
	await stub(nodeModules, "yaml", "export const parse = (text) => text;\n");
	await stub(nodeModules, "@deepseek-ai/cordis-plugin-loader", "export const interpolate = (value) => value;\n");
	await stub(nodeModules, "@deepseek-ai/cosmokit", "export const isVolatile = () => false;\n");
	await cp(join(here, "..", "lib", "index.js"), join(root, "index.js"));
	return root;
}

/** Fake host logger capturing the observable outcome of the settings install. */
function makeLogger() {
	const log = [];
	return {
		log,
		text: () => log.filter(([level]) => level === "info").map(([, text]) => text).join("\n"),
		warn: (...a) => log.push(["warn", a.join(" ")]),
		info: (...a) => log.push(["info", a.join(" ")]),
		error: (...a) => log.push(["error", a.join(" ")]),
	};
}

/** Shared fake services (mirrors test/next-settings.mjs). */
function baseCtx(logger, root, settings) {
	const ctx = {
		fiber: { state: 0 },
		logger,
		llm: { listModels: async () => [], adapterStream: async function* () {} },
		root,
		settings,
		get: () => undefined,
		on: () => () => {},
		effect(factory) {
			const result = factory();
			return typeof result === "function" ? result : undefined;
		},
		inject(deps, callback) {
			callback(ctx);
		},
	};
	return ctx;
}

/** Host seam A: the legacy section registry (dsh-settings 0.1.x hosts). */
function legacySeam() {
	const registered = new Map();
	const resolved = new Map([["model-fallback", { enabled: true, providers: ["p1", "p2"] }]]);
	const settings = {
		register(namespace, schema, options) {
			registered.set(namespace, { schema, options });
			return {
				get: () => resolved.get(namespace),
				watch: (callback) => {
					callback();
					return () => {};
				},
			};
		},
	};
	return { settings, registered };
}

/** Host seam B: the NEXT SettingsForms mirror (dsh-settings 0.2.x hosts). */
function nextSeam() {
	const doc = {
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
	const rootListeners = [];
	const root = {
		on(event, listener) {
			if (event === "settings/document-updated") rootListeners.push(listener);
			return () => {};
		},
	};
	const settings = {
		describe: () => [{ ns: "model-fallback", revision: 1, value: JSON.parse(JSON.stringify(doc)) }],
	};
	return { settings, root, rootListeners };
}

const trees = new Map();
try {
	for (const gen of GENERATIONS) {
		// --- fixture sanity: the vendored files still match the era claim ---
		const fixtureSource = await readFile(join(here, "fixtures", "dsh-settings", gen.version, "lib", "index.js"), "utf8");
		const exportsLine = fixtureSource.split("\n").find((line) => line.startsWith("export {")) ?? "";
		assert(
			exportsLine.includes("installSettingsSection") === gen.helpers,
			`${gen.version} fixture export surface matches the era claim (${gen.era})`,
		);

		const tree = await buildTree(gen.version);
		trees.set(gen.version, tree);
		const mod = await import(pathToFileURL(join(tree, "index.js")).href);
		assert(typeof mod.apply === "function" && typeof mod.Config === "function" && mod.name === "model-fallback", `${gen.version}: plugin module loads (apply/Config/name intact)`);

		// --- seam A: legacy registry install ---
		const legacyLogger = makeLogger();
		const legacy = legacySeam();
		const legacyRoot = { on: () => () => {} };
		mod.__clearHealthCache();
		mod.apply(baseCtx(legacyLogger, legacyRoot, legacy.settings), { enabled: true, providers: ["p1", "p2"] });
		assert(legacy.registered.has("model-fallback") && legacy.registered.has("model-fallback-auto"), `${gen.version}: legacy seam — both settings sections registered`);
		assert(legacyLogger.text().includes("2 provider group(s): p1 -> p2") && legacyLogger.text().includes("auto-mode:"), `${gen.version}: legacy seam — config source live (providers + auto subtree)`);

		// --- seam B: NEXT describe() forms install ---
		const nextLogger = makeLogger();
		const next = nextSeam();
		mod.__clearHealthCache();
		mod.apply(baseCtx(nextLogger, next.root, next.settings), { enabled: true, providers: ["p1", "p2"] });
		assert(next.rootListeners.length >= 1, `${gen.version}: NEXT seam — settings/document-updated listener armed`);
		assert(nextLogger.text().includes("2 provider group(s): p1 -> p2") && nextLogger.text().includes("auto-mode:"), `${gen.version}: NEXT seam — config source live (providers + auto subtree)`);
	}
} finally {
	for (const tree of trees.values()) {
		await rm(tree, { recursive: true, force: true });
	}
	await rm(join(here, ".tmp"), { recursive: true, force: true });
}

console.log(process.exitCode ? "COMPAT MATRIX FAILED" : "COMPAT MATRIX PASSED");
process.exit(process.exitCode ?? 0);
