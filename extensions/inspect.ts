import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	watch as fsWatch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import {
	dirname,
	join as joinPath,
	relative as relativePath,
	resolve as resolvePath,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultPackageManager,
	type ExtensionAPI,
	parseFrontmatter,
	type ResolvedResource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const extDir = fileURLToPath(new URL(".", import.meta.url));
const configuredPort = Number(process.env.PORT);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536 ? configuredPort : 5462;
const url = `http://localhost:${port}`;

const INSPECT_DIR = process.env.INSPECT_STATE_DIR
	?? joinPath(tmpdir(), `pi-inspect-${process.getuid?.() ?? "user"}`);
const SNAP_DIR = joinPath(INSPECT_DIR, "snapshots");
const INDEX_PATH = joinPath(SNAP_DIR, "index.json");
const REQ_ROOT = joinPath(INSPECT_DIR, "requests");
const SERVER_PATH = joinPath(INSPECT_DIR, "server.json");
const CAPABILITY_PATH = joinPath(INSPECT_DIR, "capability");
const REQ_STALE_MS = 60 * 60 * 1000; // 1 hour

let child: ChildProcess | null = null;
let lastStderr = "";
let piRef: ExtensionAPI | null = null;

function loadCapability(): string {
	try {
		mkdirSync(INSPECT_DIR, { recursive: true, mode: 0o700 });
		chmodSync(INSPECT_DIR, 0o700);
		const existing = readFileSync(CAPABILITY_PATH, "utf8").trim();
		chmodSync(CAPABILITY_PATH, 0o600);
		if (existing) return existing;
	} catch {}
	const value = randomBytes(32).toString("hex");
	mkdirSync(INSPECT_DIR, { recursive: true, mode: 0o700 });
	chmodSync(INSPECT_DIR, 0o700);
	writeFileSync(CAPABILITY_PATH, value, { encoding: "utf8", mode: 0o600 });
	chmodSync(CAPABILITY_PATH, 0o600);
	return value;
}

function secureStateTree(path: string): void {
	let stat;
	try { stat = lstatSync(path); } catch { return; }
	if (stat.isSymbolicLink()) return;
	if (stat.isDirectory()) {
		chmodSync(path, 0o700);
		for (const entry of readdirSync(path)) secureStateTree(joinPath(path, entry));
		return;
	}
	if (stat.isFile()) chmodSync(path, 0o600);
}

const capability = loadCapability();
secureStateTree(INSPECT_DIR);

function probePort(p: number, timeoutMs = 250): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = createConnection({ port: p, host: "127.0.0.1" });
		const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
		sock.setTimeout(timeoutMs);
		sock.once("connect", () => done(true));
		sock.once("timeout", () => done(false));
		sock.once("error", () => done(false));
	});
}

async function waitForPort(p: number, totalMs = 5000): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < totalMs) {
		if (await probePort(p)) return true;
		await new Promise((r) => setTimeout(r, 150));
	}
	return false;
}

function sanitize(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

type IndexEntry = {
	id: string;
	cwd: string | null;
	name: string | null;
	model: string | null;
	capturedAt: number;
};

function readIndex(): IndexEntry[] {
	try {
		const parsed = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as { sessions?: IndexEntry[] };
		return Array.isArray(parsed.sessions) ? parsed.sessions : [];
	} catch (e: any) {
		if (e?.code !== "ENOENT") console.warn(`pi-inspect: read index: ${e.message}`);
		return [];
	}
}

function writePrivateJson(path: string, value: unknown): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	chmodSync(parent, 0o700);
	writeFileSync(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
	chmodSync(path, 0o600);
}

function writeIndex(entries: IndexEntry[]): void {
	writePrivateJson(INDEX_PATH, { sessions: entries });
}

function upsertIndex(entry: IndexEntry): void {
	const list = readIndex().filter((e) => e.id !== entry.id);
	list.push(entry);
	writeIndex(list);
}

function removeIndexEntry(id: string): void {
	writeIndex(readIndex().filter((entry) => entry.id !== id));
}

function writeSnapshot(id: string, snapshot: unknown): void {
	writePrivateJson(joinPath(SNAP_DIR, `${sanitize(id)}.json`), snapshot);
}

type DisabledKind = "command" | "prompt" | "skill" | "extension" | "theme";
type DisabledScope = "user" | "project";
type DisabledItem = {
	kind: DisabledKind;
	name: string;
	displayName: string;
	description: string;
	source: string;
	scope: DisabledScope;
	settingsPath: string;
	path: string;
	reason: string;
	resourceKind: ResourceKind;
	baseDir: string;
};

const AGENT_DIR = joinPath(homedir(), ".pi", "agent");
const SETTINGS_PATH = joinPath(AGENT_DIR, "settings.json");

type ResourceKind = "skills" | "prompts" | "extensions" | "themes";
const RESOURCE_KINDS: readonly ResourceKind[] = ["skills", "prompts", "extensions", "themes"];

const KIND_MAP: Record<ResourceKind, { kind: DisabledKind; display: (n: string) => string }> = {
	prompts:    { kind: "prompt",    display: (n) => `/${n}` },
	skills:     { kind: "skill",     display: (n) => `/skill:${n}` },
	extensions: { kind: "extension", display: (n) => n },
	themes:     { kind: "theme",     display: (n) => n },
};

function sourceLabel(source: string): string {
	if (source.startsWith("npm:")) return source.slice(4);
	const norm = source.replace(/\\/g, "/").replace(/\/$/, "");
	return norm.split("/").pop() ?? norm;
}

const describeCache = new Map<string, { mtimeMs: number; desc: string }>();

function describeFromPath(path: string): string {
	let mtimeMs: number;
	try { mtimeMs = statSync(path).mtimeMs; } catch { return ""; }
	const cached = describeCache.get(path);
	if (cached && cached.mtimeMs === mtimeMs) return cached.desc;
	let desc = "";
	try {
		const { frontmatter, body } = parseFrontmatter<{ description?: string }>(readFileSync(path, "utf8"));
		desc = typeof frontmatter.description === "string" && frontmatter.description
			? frontmatter.description
			: body.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"))?.trim().slice(0, 240) ?? "";
	} catch {}
	describeCache.set(path, { mtimeMs, desc });
	return desc;
}

function nameFromPath(kind: ResourceKind, path: string): string {
	const norm = path.replace(/\\/g, "/");
	const base = norm.split("/").pop() ?? norm;
	if (kind === "skills" && /^SKILL\.md$/i.test(base)) {
		const parts = norm.split("/");
		return parts[parts.length - 2] ?? base;
	}
	return base.replace(/\.(md|ts|js|mjs|cjs|json|toml|ya?ml)$/i, "");
}

function buildItemFromResource(
	kind: ResourceKind,
	r: ResolvedResource,
	sessionCwd: string,
): DisabledItem {
	const md = r.metadata;
	const scope: DisabledScope = md.scope === "project" ? "project" : "user";
	const label = md.origin === "package" ? sourceLabel(md.source) : scope;
	const name = nameFromPath(kind, r.path);
	const cfg = KIND_MAP[kind];
	return {
		kind: cfg.kind,
		name,
		displayName: cfg.display(name),
		description: describeFromPath(r.path),
		source: label,
		scope,
		settingsPath: scope === "project" ? joinPath(sessionCwd, ".pi", "settings.json") : SETTINGS_PATH,
		path: r.path,
		reason: md.source,
		resourceKind: kind,
		baseDir: md.baseDir ?? AGENT_DIR,
	};
}

type ResourceListing = { disabled: DisabledItem[]; pending: DisabledItem[] };

async function discoverFromPackages(
	cwd: string | null,
	activePaths: Set<string>,
): Promise<ResourceListing> {
	const sessionCwd = cwd ?? process.cwd();
	const sm = SettingsManager.create(sessionCwd, AGENT_DIR);
	const pm = new DefaultPackageManager({ cwd: sessionCwd, agentDir: AGENT_DIR, settingsManager: sm });
	let resolved;
	try {
		resolved = await pm.resolve(async () => "skip");
	} catch (e: any) {
		console.warn(`pi-inspect: package resolve failed: ${e?.message ?? e}`);
		return { disabled: [], pending: [] };
	}

	const disabledByPath = new Map<string, DisabledItem>();
	const pendingByPath = new Map<string, DisabledItem>();
	// Pending detection only makes sense for resources with a 1:1 path→command mapping.
	// Extensions register tools at different paths, themes don't appear as commands at all.
	const PENDABLE: ReadonlySet<ResourceKind> = new Set(["skills", "prompts"]);
	for (const kind of RESOURCE_KINDS) {
		const list = resolved[kind] as ResolvedResource[];
		for (const r of list) {
			const item = buildItemFromResource(kind, r, sessionCwd);
			if (!r.enabled) {
				disabledByPath.set(r.path, item);
			} else if (
				PENDABLE.has(kind) &&
				!activePaths.has(r.path.replace(/\\/g, "/").toLowerCase())
			) {
				// Resolved-enabled but pi's boot-frozen command map doesn't have it yet.
				pendingByPath.set(r.path, item);
			}
		}
	}
	return { disabled: [...disabledByPath.values()], pending: [...pendingByPath.values()] };
}

type ToggleRequest = {
	id: string;
	sessionId: string;
	ts: number;
	action: "enable" | "disable";
	resourceKind: ResourceKind;
	path: string;
	scope: DisabledScope;
};

function normPath(p: string): string {
	return resolvePath(p).replace(/\\/g, "/").toLowerCase();
}

function requestDir(sessionId: string): string {
	return joinPath(REQ_ROOT, sanitize(sessionId));
}

function ensureReqDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function sweepStaleRequests(path: string): void {
	let entries: string[];
	try { entries = readdirSync(path); } catch { return; }
	const now = Date.now();
	for (const f of entries) {
		const full = joinPath(path, f);
		try {
			const st = statSync(full);
			if (now - st.mtimeMs > REQ_STALE_MS) unlinkSync(full);
		} catch {}
	}
}

// Mirrors the toggle logic in pi-coding-agent's ConfigSelectorComponent
// (modes/interactive/components/config-selector.js). Strips any existing
// `+`/`-`/`!` entries for the pattern, then appends the new one.
function applyPattern(arr: string[], pattern: string, enabled: boolean): string[] {
	const filtered = arr.filter((p) => {
		const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
		return stripped !== pattern;
	});
	filtered.push(enabled ? `+${pattern}` : `-${pattern}`);
	return filtered;
}

async function processToggleRequest(req: ToggleRequest, sessionCwd: string): Promise<void> {
	const sm = SettingsManager.create(sessionCwd, AGENT_DIR);
	const pm = new DefaultPackageManager({ cwd: sessionCwd, agentDir: AGENT_DIR, settingsManager: sm });
	const resolved = await pm.resolve(async () => "skip");
	const list = resolved[req.resourceKind] as ResolvedResource[];
	const target = list.find((r) => normPath(r.path) === normPath(req.path));
	if (!target) throw new Error(`resource not in resolution: ${req.path}`);
	const md = target.metadata;
	const enabled = req.action === "enable";
	const scope: DisabledScope = md.scope === "project" ? "project" : "user";

	if (md.origin === "package") {
		const baseDir = md.baseDir ?? dirname(target.path);
		const pattern = relativePath(baseDir, target.path);
		const settings = scope === "project" ? sm.getProjectSettings() : sm.getGlobalSettings();
		const packages = [...(settings.packages ?? [])];
		const idx = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === md.source);
		if (idx < 0) throw new Error(`package not found in settings: ${md.source}`);
		let pkg = packages[idx];
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[idx] = pkg;
		}
		const arrayKey = req.resourceKind as keyof typeof pkg & ("extensions" | "skills" | "prompts" | "themes");
		const current = ((pkg as any)[arrayKey] as string[] | undefined) ?? [];
		const updated = applyPattern(current, pattern, enabled);
		(pkg as any)[arrayKey] = updated.length > 0 ? updated : undefined;
		const hasFilters = (["extensions", "skills", "prompts", "themes"] as const).some(
			(k) => (pkg as any)[k] !== undefined,
		);
		if (!hasFilters) packages[idx] = (pkg as any).source;
		if (scope === "project") sm.setProjectPackages(packages);
		else sm.setPackages(packages);
		await sm.flush();
		return;
	}

	// top-level
	const baseDir = scope === "project" ? joinPath(sessionCwd, ".pi") : AGENT_DIR;
	const pattern = relativePath(baseDir, target.path);
	const settings = scope === "project" ? sm.getProjectSettings() : sm.getGlobalSettings();
	const current = ((settings as any)[req.resourceKind] as string[] | undefined) ?? [];
	const updated = applyPattern(current, pattern, enabled);
	const setters: Record<ResourceKind, { user: string; project: string }> = {
		skills:     { user: "setSkillPaths",          project: "setProjectSkillPaths" },
		prompts:    { user: "setPromptTemplatePaths", project: "setProjectPromptTemplatePaths" },
		extensions: { user: "setExtensionPaths",      project: "setProjectExtensionPaths" },
		themes:     { user: "setThemePaths",          project: "setProjectThemePaths" },
	};
	(sm as any)[setters[req.resourceKind][scope]](updated);
	await sm.flush();
}

let lastCtx: any = null;
let reqWatcher: FSWatcher | null = null;
const recentlyHandled = new Set<string>();

async function handleRequestFile(full: string): Promise<void> {
	if (recentlyHandled.has(full)) return;
	recentlyHandled.add(full);
	setTimeout(() => recentlyHandled.delete(full), 5000);

	let raw: string;
	try { raw = readFileSync(full, "utf8"); } catch { return; }
	if (!raw.trim()) return;
	let req: ToggleRequest;
	try { req = JSON.parse(raw) as ToggleRequest; } catch (e: any) {
		console.warn(`pi-inspect: bad request file ${full}: ${e?.message ?? e}`);
		try { renameSync(full, `${full}.err.json`); } catch {}
		return;
	}

	const sessionId = lastCtx?.sessionManager?.getSessionId?.();
	if (!sessionId || req.sessionId !== sessionId) return;
	const cwd = lastCtx?.sessionManager?.getCwd?.() ?? process.cwd();
	try {
		await processToggleRequest(req, cwd);
		try { unlinkSync(full); } catch {}
		if (lastCtx) await captureSnapshot(lastCtx);
	} catch (e: any) {
		console.warn(`pi-inspect: toggle failed: ${e?.message ?? e}`);
		try {
			const errorPath = `${full}.err.json`;
			writeFileSync(errorPath, JSON.stringify({ error: e?.message ?? String(e), req }, null, 2), { mode: 0o600 });
			chmodSync(errorPath, 0o600);
			unlinkSync(full);
		} catch {}
	}
}

function setupRequestWatcher(sessionId: string): void {
	const dir = requestDir(sessionId);
	ensureReqDir(dir);
	sweepStaleRequests(dir);
	// Drain only requests owned by this session.
	try {
		for (const f of readdirSync(dir)) {
			if (f.endsWith(".err.json") || !f.endsWith(".json")) continue;
			void handleRequestFile(joinPath(dir, f));
		}
	} catch {}
	if (reqWatcher) return;
	try {
		reqWatcher = fsWatch(dir, (_event, filename) => {
			if (!filename) return;
			const name = String(filename);
			if (!name.endsWith(".json") || name.endsWith(".err.json")) return;
			const full = joinPath(dir, name);
			try { statSync(full); } catch { return; }
			void handleRequestFile(full);
		});
	} catch (e: any) {
		console.warn(`pi-inspect: request watcher failed: ${e?.message ?? e}`);
	}
}

async function captureSnapshot(ctx: any): Promise<{ id: string; entry: IndexEntry } | null> {
	const sm = ctx.sessionManager;
	const id = sm?.getSessionId?.();
	if (!id) return null;
	const cwd = sm?.getCwd?.() ?? null;
	const name = sm?.getSessionName?.() ?? null;
	const model = ctx.getModel?.()?.id ?? null;
	const systemPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : null;
	const pi = piRef as any;
	const commands = typeof pi?.getCommands === "function" ? pi.getCommands() : [];
	const tools = typeof pi?.getAllTools === "function" ? pi.getAllTools() : [];
	const activeTools = typeof pi?.getActiveTools === "function" ? pi.getActiveTools() : [];
	const activePaths = new Set<string>();
	for (const c of commands) {
		const p = c?.sourceInfo?.path;
		if (typeof p === "string") activePaths.add(p.replace(/\\/g, "/").toLowerCase());
	}
	for (const t of tools) {
		const p = t?.sourceInfo?.path;
		if (typeof p === "string") activePaths.add(p.replace(/\\/g, "/").toLowerCase());
	}
	const { disabled: disabledItems, pending: pendingItems } = await discoverFromPackages(cwd, activePaths);
	const capturedAt = Date.now();
	const snap = { sessionId: id, sessionName: name, cwd, model, systemPrompt, commands, tools, activeTools, disabledItems, pendingItems, capturedAt };
	try {
		writeSnapshot(id, snap);
		upsertIndex({ id, cwd, name, model, capturedAt });
	} catch (e: any) {
		console.warn(`pi-inspect: snapshot write failed: ${e?.message ?? e}`);
		return null;
	}
	return { id, entry: { id, cwd, name, model, capturedAt } };
}

async function inspectServerInfo(): Promise<{ name?: string; pid?: number } | null> {
	try {
		const response = await fetch(`${url}/api/version`, { headers: { authorization: `Bearer ${capability}` } });
		if (!response.ok) return null;
		return await response.json() as { name?: string; pid?: number };
	} catch { return null; }
}

async function startServer(notify: (m: string, l?: "info" | "error") => void): Promise<boolean> {
	if (await probePort(port)) {
		const info = await inspectServerInfo();
		if (info?.name === "pi-inspect") return true;
		notify(`port ${port} is used by another process`, "error");
		return false;
	}
	lastStderr = "";
	const serverPath = resolvePath(extDir, "..", "server.js");
	child = spawn(process.execPath, [serverPath], {
		env: { ...process.env, PORT: String(port), INSPECT_CAPABILITY: capability },
		stdio: ["ignore", "ignore", "pipe"],
		detached: true,
		windowsHide: true,
	});
	child.stderr?.on("data", (b) => { lastStderr += b.toString(); });
	child.on("exit", () => { child = null; });
	if (!(await waitForPort(port))) {
		notify(`pi-inspect failed to start.\n${lastStderr.slice(-500) || "(no stderr)"}`, "error");
		return false;
	}
	child.stderr?.removeAllListeners("data");
	child.stderr?.resume();
	child.unref();
	return true;
}

async function stopServer(notify: (m: string, l?: "info" | "error") => void): Promise<void> {
	let record: { pid?: number } = {};
	try { record = JSON.parse(readFileSync(SERVER_PATH, "utf8")); } catch {}
	try {
		const response = await fetch(`${url}/api/version`, { headers: { authorization: `Bearer ${capability}` } });
		const info = await response.json() as { name?: string; pid?: number };
		if (!response.ok || info.name !== "pi-inspect" || info.pid !== record.pid || !record.pid) {
			notify("pi-inspect server ownership could not be verified", "error");
			return;
		}
		process.kill(record.pid, "SIGTERM");
		child = null;
		await new Promise((r) => setTimeout(r, 300));
		notify("pi-inspect stopped");
	} catch {
		notify("pi-inspect is not running");
	}
}

const SUBCOMMANDS = ["start", "stop", "restart", "status", "open", "list", "snapshot"] as const;
type Sub = (typeof SUBCOMMANDS)[number];
const OPEN_TARGETS = ["web", "app"] as const;

function showHelp(notify: (m: string, l?: "info" | "error") => void) {
	notify(
		[
			"Usage: /inspect <command>",
			"",
			"  start              Start the dashboard server",
			"  stop               Stop the dashboard server",
			"  restart            Restart the dashboard server",
			"  status             Show server status",
			"  open web           Open dashboard in browser (default)",
			"  open app           Open dashboard as PWA window",
			"  list               List captured session snapshots",
			"  snapshot           Re-capture the current session now",
			"",
			"Bare `/inspect` ensures the server is running and opens the current session.",
			"`/inspect <sessionId>` opens a specific past session.",
		].join("\n"),
	);
}

export default function inspectExtension(pi: ExtensionAPI) {
	piRef = pi;
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		const id = ctx.sessionManager?.getSessionId?.();
		if (id) setupRequestWatcher(id);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		reqWatcher?.close();
		reqWatcher = null;
		const id = ctx.sessionManager?.getSessionId?.();
		if (id) {
			rmSync(joinPath(SNAP_DIR, `${sanitize(id)}.json`), { force: true });
			removeIndexEntry(id);
		}
		lastCtx = null;
	});

	pi.registerCommand("inspect", {
		description:
			"pi-inspect dashboard: start | stop | restart | status | open web|app | list | snapshot. " +
			"Bare `/inspect` opens the current session; `/inspect <sessionId>` opens a specific session.",
		getArgumentCompletions: (prefix) => {
			const tokens = prefix.trim().split(/\s+/).filter(Boolean);
			if (tokens.length >= 1 && tokens[0] === "open") {
				const v = tokens[1] ?? "";
				return OPEN_TARGETS
					.filter((t) => t.startsWith(v))
					.map((t) => ({ value: `open ${t}`, label: t }));
			}
			return SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const notify = (m: string, l: "info" | "error" = "info") => ctx.ui.notify(m, l);
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const first = tokens[0] as Sub | string | undefined;

			if (first === "help" || first === "--help" || first === "-h") {
				showHelp(notify);
				return;
			}

			if (first === "stop") return stopServer(notify);

			if (first === "status") {
				const info = await inspectServerInfo();
				notify(info?.name === "pi-inspect" ? `running on ${url}` : "not running");
				return;
			}

			if (first === "start") {
				if (!(await startServer(notify))) return;
				await captureSnapshot(ctx);
				notify(`pi-inspect started → ${url}`);
				return;
			}

			if (first === "restart") {
				await stopServer(notify);
				await new Promise((r) => setTimeout(r, 200));
				if (!(await startServer(notify))) return;
				notify(`pi-inspect restarted → ${url}`);
				return;
			}

			if (first === "list") {
				const list = readIndex();
				if (!list.length) { notify("no snapshots yet — run /inspect to capture this session"); return; }
				const sorted = [...list].sort((a, b) => b.capturedAt - a.capturedAt);
				const lines = sorted.map((e) =>
					`  ${e.id}  ${e.name ?? "(no name)"}  cwd=${e.cwd ?? "?"}  model=${e.model ?? "?"}`,
				);
				notify(`pi-inspect snapshots:\n${lines.join("\n")}`);
				return;
			}

			if (first === "snapshot") {
				const r = await captureSnapshot(ctx);
				notify(r ? `snapshot captured: ${r.id}` : "no active session to snapshot", r ? "info" : "error");
				return;
			}

			// `open [web|app]` and default (bare /inspect or /inspect <sessionId>)
			const isExplicitOpen = first === "open";
			const openTarget = (isExplicitOpen ? (tokens[1] ?? "web") : "web") as "web" | "app";

			if (!(await startServer(notify))) return;
			await captureSnapshot(ctx);

			let openId: string | null = null;
			if (!isExplicitOpen && first && !(SUBCOMMANDS as readonly string[]).includes(first)) {
				openId = first; // /inspect <sessionId>
			} else {
				openId = ctx.sessionManager?.getSessionId?.() ?? null;
			}

			const query = new URLSearchParams({ token: capability });
			if (openId) query.set("session", openId);
			const target = `${url}/?${query.toString()}`;

			// If a dashboard tab is already connected, ask it to navigate instead of opening a new window.
			if (!isExplicitOpen) {
				try {
					const r = await fetch(`${url}/api/focus`, {
						method: "POST",
						headers: { "content-type": "application/json", authorization: `Bearer ${capability}` },
						body: JSON.stringify({ session: openId }),
					});
					const { delivered } = (await r.json()) as { delivered: number };
					if (delivered > 0) {
						notify(`focused existing dashboard → session ${openId ?? "(latest)"}`);
						return;
					}
				} catch {}
			}

			if (openTarget === "app") {
				const { default: openFn, apps } = await import("open");
				for (const name of [apps.chrome, apps.edge, apps.browser]) {
					try {
						await openFn(target, { app: { name, arguments: [`--app=${target}`] } });
						notify(`opened ${target} (app)`);
						return;
					} catch {}
				}
				notify("Could not find Chrome/Edge for PWA window mode", "error");
				return;
			}

			const { default: openFn } = await import("open");
			await openFn(target);
			notify(`opened ${target}`);
		},
	});
}
