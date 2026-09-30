/**
 * Regression guards for #5 / #6 — un-unref'd handles in `extensions/inspect.ts`
 * keep the Node.js event loop alive, so non-interactive runs (`pi -p`,
 * headless/RPC) print their output and then hang forever instead of exiting.
 *
 * Two independent handles are involved:
 *   #5  the request-directory `FSWatcher` created by `setupRequestWatcher()`
 *   #6  the spawned server's stderr pipe, resumed by `startServer()`
 *
 * The handles are created on extension load / on `/inspect start`, so an
 * end-to-end test would need a full headless `pi` run. These guards are
 * source-level on purpose: they fail loudly if either `unref()` is dropped.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SOURCE = readFileSync(join(__dirname, "..", "extensions", "inspect.ts"), "utf8");

/** Slice out a top-level function body (top-level `}` sits at column 0). */
function functionBody(name) {
	const start = SOURCE.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name}() not found in extensions/inspect.ts`);
	const end = SOURCE.indexOf("\n}\n", start);
	assert.notEqual(end, -1, `${name}() has no top-level closing brace`);
	return SOURCE.slice(start, end);
}

test("setupRequestWatcher() unrefs the request-directory FSWatcher (#5)", () => {
	const body = functionBody("setupRequestWatcher");
	assert.match(body, /reqWatcher = fsWatch\(/, "expected the request watcher to still exist");
	assert.match(
		body,
		/reqWatcher\.unref\(\)/,
		"reqWatcher.unref() is required, otherwise non-interactive exits hang (#5)",
	);
});

test("startServer() unrefs the spawned server's stderr pipe after resuming it (#6)", () => {
	const body = functionBody("startServer");
	assert.match(
		body,
		/stdio: \["ignore", "ignore", "pipe"\]/,
		"expected the piped stderr to still be captured for failure messages",
	);

	const resumeAt = body.indexOf("child.stderr?.resume()");
	assert.notEqual(resumeAt, -1, "expected stderr to be resumed (so the server never blocks on a full pipe)");

	const unrefAt = body.indexOf("unref?.()", resumeAt);
	assert.notEqual(
		unrefAt,
		-1,
		"child.stderr.unref() must follow resume(), otherwise the resumed pipe pins the event loop (#6)",
	);
});

test("both handles are released before the extension finishes loading/starting", () => {
	// #5 is created at load time, #6 only when the dashboard server is spawned;
	// neither may be the last handle holding the loop.
	const watcher = functionBody("setupRequestWatcher");
	const start = functionBody("startServer");
	assert.match(watcher, /unref/);
	assert.match(start, /unref/);
});
