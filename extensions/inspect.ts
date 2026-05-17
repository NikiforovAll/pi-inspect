import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const extDir = fileURLToPath(new URL(".", import.meta.url));
const port = 5462;
const url = `http://localhost:${port}`;

const INSPECT_DIR = joinPath(homedir(), ".pi", "agent", "inspect");
const SNAP_DIR = joinPath(INSPECT_DIR, "snapshots");
const INDEX_PATH = joinPath(SNAP_DIR, "index.json");

let child: ChildProcess | null = null;
let lastStderr = "";
let piRef: ExtensionAPI | null = null;

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

function findPidsOnPort(p: number): number[] {
	if (process.platform === "win32") {
		const r = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
		if (r.status !== 0) return [];
		const pids = new Set<number>();
		for (const line of r.stdout.split(/\r?\n/)) {
			const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
			if (m && Number(m[1]) === p) pids.add(Number(m[2]));
		}
		return [...pids];
	}
	const r = spawnSync("lsof", ["-tiTCP:" + p, "-sTCP:LISTEN"], { encoding: "utf8" });
	if (r.status !== 0) return [];
	return r.stdout.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

function killPid(pid: number): void {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
	} else {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
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

function writeIndex(entries: IndexEntry[]): void {
	mkdirSync(SNAP_DIR, { recursive: true });
	writeFileSync(INDEX_PATH, JSON.stringify({ sessions: entries }, null, 2), "utf8");
}

function upsertIndex(entry: IndexEntry): void {
	const list = readIndex().filter((e) => e.id !== entry.id);
	list.push(entry);
	writeIndex(list);
}

function writeSnapshot(id: string, snapshot: unknown): void {
	mkdirSync(SNAP_DIR, { recursive: true });
	writeFileSync(joinPath(SNAP_DIR, `${sanitize(id)}.json`), JSON.stringify(snapshot, null, 2), "utf8");
}

function captureSnapshot(ctx: any): { id: string; entry: IndexEntry } | null {
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
	const capturedAt = Date.now();
	const snap = { sessionId: id, sessionName: name, cwd, model, systemPrompt, commands, tools, activeTools, capturedAt };
	try {
		writeSnapshot(id, snap);
		upsertIndex({ id, cwd, name, model, capturedAt });
	} catch (e: any) {
		console.warn(`pi-inspect: snapshot write failed: ${e?.message ?? e}`);
		return null;
	}
	return { id, entry: { id, cwd, name, model, capturedAt } };
}

async function startServer(notify: (m: string, l?: "info" | "error") => void): Promise<boolean> {
	if (await probePort(port)) return true;
	lastStderr = "";
	const serverPath = resolvePath(extDir, "..", "server.js");
	child = spawn(process.execPath, [serverPath], {
		env: { ...process.env, PORT: String(port) },
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
	if (child) child.kill("SIGINT");
	child = null;
	if (await probePort(port)) {
		const pids = findPidsOnPort(port);
		for (const pid of pids) killPid(pid);
		await new Promise((r) => setTimeout(r, 300));
	}
	notify("pi-inspect stopped");
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
		captureSnapshot(ctx);
	});
	// session_start fires before all extensions register their tools/commands.
	// before_agent_start fires after the user's first prompt with the fully assembled state — re-capture then.
	pi.on("before_agent_start", async (_event, ctx) => {
		captureSnapshot(ctx);
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
			const notify = (m: string, l: "info" | "error" = "info") => ctx.ui.notify(m, l);
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const first = tokens[0] as Sub | string | undefined;

			if (first === "help" || first === "--help" || first === "-h") {
				showHelp(notify);
				return;
			}

			if (first === "stop") return stopServer(notify);

			if (first === "status") {
				const up = await probePort(port);
				notify(up ? `running on ${url}` : "not running");
				return;
			}

			if (first === "start") {
				if (!(await startServer(notify))) return;
				captureSnapshot(ctx);
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
				const r = captureSnapshot(ctx);
				notify(r ? `snapshot captured: ${r.id}` : "no active session to snapshot", r ? "info" : "error");
				return;
			}

			// `open [web|app]` and default (bare /inspect or /inspect <sessionId>)
			const isExplicitOpen = first === "open";
			const openTarget = (isExplicitOpen ? (tokens[1] ?? "web") : "web") as "web" | "app";

			if (!(await startServer(notify))) return;
			captureSnapshot(ctx);

			let openId: string | null = null;
			if (!isExplicitOpen && first && !(SUBCOMMANDS as readonly string[]).includes(first)) {
				openId = first; // /inspect <sessionId>
			} else {
				openId = ctx.sessionManager?.getSessionId?.() ?? null;
			}

			const target = openId ? `${url}/?session=${encodeURIComponent(openId)}` : url;

			// If a dashboard tab is already connected, ask it to navigate instead of opening a new window.
			if (!isExplicitOpen) {
				try {
					const r = await fetch(`${url}/api/focus`, {
						method: "POST",
						headers: { "content-type": "application/json" },
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
