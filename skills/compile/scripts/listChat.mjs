#!/usr/bin/env node
// The `chat:` source front-end: enumerate brief-primed chat threads (chrome-home's
// Briefs tab, or any server speaking the same contract) against the briefs
// watermark. A free source like md/url — the threads are global, you compile them
// into whatever repo's briefs/ you point at. Pure Node, no deps. JSON on stdout.
//
// Like url, list does NOT fetch thread bodies — it hits GET /chat/briefs-threads
// once (metadata only) and keys each thread by its messageCount (a monotonic
// integer: a thread re-queues when it grows). firstMessage is the thread's first
// user message; newTokens is 0 (substrate size is unknown until renderChat fetches
// the body). A thread with messageCount 0 is skipped (nothing to compile).
//
// Usage: node listChat.mjs [<thread-id>...] [--cwd <p>] [--briefs-dir <p>] [--to <p>]
//   <thread-id>   optional filter: only these threads (bare `chat:` → all threads).
//                 A leading `chat:` on the token is accepted and stripped.
//   --cwd         base for destination resolution (default cwd)
//   --briefs-dir  destination root override; default is <cwd>/briefs
//   --to          collection subfolder of the briefs root (resolveCollection)
//
// Env: CLEARVOID_CHAT_API_URL   (default http://localhost:3010/v1/api)
//      CLEARVOID_CHAT_API_TOKEN (optional Bearer — only if the endpoint is closed)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	fetchBriefsThreads,
	findRepoRoots,
	loadBriefsIndex,
	summaryBloatWarnings,
	loadRoots,
	resolveCollection,
	resolveDestination,
} from "./lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cwd = resolve(arg("--cwd", process.cwd()));
const briefsRoot = resolveDestination(cwd, arg("--briefs-dir"));
// Orientation, queue, and watermark key off briefsRoot (one pool per repo);
// newBriefsDir is only where NEW briefs from this run are filed (collections are
// folders, not walls). No `to:` → newBriefsDir is the root.
const newBriefsDir = resolveCollection(briefsRoot, arg("--to"));

// Positional selectors = optional thread-id filters (everything not a flag/value).
const VALUE_FLAGS = new Set(["--cwd", "--briefs-dir", "--to"]);
const idFilter = new Set();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--")) {
		if (VALUE_FLAGS.has(argv[i])) i++; // skip its value
		continue;
	}
	idFilter.add(argv[i].replace(/^chat:/, ""));
}

const errors = [];
const warnings = [];

// state.json keyed by source-namespaced id; chat ids carry the thread id.
let state = { version: 1, sources: {} };
try {
	state = JSON.parse(
		readFileSync(join(briefsRoot, ".clearvoid", "state.json"), "utf8"),
	);
	if (!state.sources) state.sources = {};
} catch {
	// fresh destination
}

let threads = [];
try {
	threads = await fetchBriefsThreads();
} catch (e) {
	// A down / unreachable API (e.g. chrome-home not running) is an error the SKILL
	// surfaces — not a crash. Empty queue, clear message.
	errors.push(
		`could not reach the chat API (${e.message}). Is the chrome-home server running, ` +
			`or is CLEARVOID_CHAT_API_URL pointed at a compatible endpoint?`,
	);
}

const queue = [];
const upToDate = [];
for (const t of threads) {
	if (!t || t.id == null) continue;
	// The chat API returns numeric thread ids; the id is stringified into the
	// `chat:<id>` namespace + the CLI id filter (which arrives as a string).
	const tid = String(t.id);
	if (idFilter.size > 0 && !idFilter.has(tid)) continue;
	const messageCount = Number(t.messageCount ?? 0);
	if (messageCount <= 0) continue; // nothing to compile
	const id = `chat:${tid}`;
	// Watermark = messageCount: a monotonic integer, so a thread re-queues only when
	// it grows. An edit that doesn't add messages needs an explicit re-run (drop the
	// watermark) — same posture as url's stable-URL watermark.
	const prevWatermark = state.sources?.[id]?.units ?? null;
	if (typeof prevWatermark === "number" && messageCount <= prevWatermark) {
		upToDate.push({ id, watermark: messageCount });
		continue;
	}
	queue.push({
		id,
		title: t.title ?? tid,
		firstMessage: t.firstUserMessage ?? "",
		// Body isn't fetched here (list hits metadata only), so substrate size is
		// unknown until renderChat — 0, same as url. messageCount is the triage signal.
		newTokens: 0,
		messageCount,
		updatedAt: t.updatedAt ?? null,
		// Routing hint for the agent: null = all briefs, {tags:[…]} = a subject area.
		// NOT a queue filter — it steers which brief(s) the thread's insights land in.
		briefsFilter: t.briefsFilter ?? null,
		current: false,
		watermark: messageCount,
		prevWatermark,
	});
}

// Oldest-first (compile processes the queue chronologically); the endpoint returns
// updatedAt desc, so sort ascending here.
queue.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));

// Loud warning: about to seed a brand-new briefs/ in a place with no git history
// and no prior registration. Can't block (non-interactive runs hang on prompts),
// so it rides in the output for the SKILL to surface — same logic as listMarkdown/listUrl.
const inRepo = findRepoRoots(cwd) !== null;
const registered = loadRoots()
	.roots.map((r) => resolve(r))
	.includes(briefsRoot);
if (!existsSync(briefsRoot) && !inRepo && !registered) {
	warnings.push(
		`Destination ${briefsRoot} does not exist yet and ${cwd} is not inside a git repo — ` +
			`compiling here seeds a NEW, unversioned briefs/ folder (no committed watermark, no diff review). ` +
			`Re-run with --briefs-dir <repo>/briefs to land these briefs in a repo if that was not intended.`,
	);
}

const briefsIndex = loadBriefsIndex(briefsRoot);
warnings.push(...summaryBloatWarnings(briefsIndex));

console.log(
	JSON.stringify(
		{
			source: "chat",
			cwd,
			briefsRoot,
			newBriefsDir,
			generatedAt: new Date().toISOString(),
			briefs: briefsIndex,
			queue,
			upToDateCount: upToDate.length,
			matched: queue.length + upToDate.length,
			errors,
			warnings,
		},
		null,
		2,
	),
);
