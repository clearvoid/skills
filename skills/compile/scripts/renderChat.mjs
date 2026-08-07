#!/usr/bin/env node
// Render one chat-thread unit into compile substrate. Like renderUrl this hits the
// network — the thread body lives behind the chat API. Two calls: GET
// /chat/briefs-threads to resolve this thread's messageCount (the watermark) + title,
// then GET /chat/sessions/:id/markdown for the body. Keying the watermark off the
// same briefs-threads response listChat uses keeps list + render identical (the
// invariant the url pair enforces). The thread markdown is already clean substrate
// (a rendered chat), written verbatim to the substrate payload file — no
// chrome-stripping (stdout carries only the header + pointer; lib.mjs writePayload).
//
// Unlike sessions, chat gets a per-source report (raw/chat-<id>.report.md). The
// thread transcript is NOT saved locally (id-reference only, decision 2026-07-02),
// so the report is the sole durable local artifact of what the thread explored and
// fed into the briefs — and it carries the title, so the desktop Sources tab stays
// legible when the chat server is down. Its `## Summary` is therefore a full reading
// view (like url), NOT kept light the way md's is (md's file is its own reading view;
// a chat thread has none locally).
//
// Usage: node renderChat.mjs <chat:thread-id-or-id> [--briefs-dir <writeDir>] [--raw-dir <path>]
//   <chat:thread-id-or-id>  a full `chat:<id>` id or a bare thread id.
//   --briefs-dir <writeDir> record the watermark (messageCount) as pending progress
//                           for finalizeState to commit — pass during compile.
//   --raw-dir <path>        where the per-source report lands (default the raw/
//                           sibling of --briefs-dir, else <cwd>/raw).
//
// Env: CLEARVOID_CHAT_API_URL   (default http://localhost:3010/v1/api)
//      CLEARVOID_CHAT_API_TOKEN (optional Bearer — only if the endpoint is closed)

import { resolve, join } from "node:path";
import {
	fetchBriefsThreads,
	fetchThreadMarkdown,
	recordProgress,
	substrateNote,
	writePayload,
} from "./lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
	console.error(
		"renderChat: usage: node renderChat.mjs <chat:thread-id-or-id> [--briefs-dir <p>]",
	);
	process.exit(1);
}
const briefsDir = arg("--briefs-dir");
// raw/ is a sibling of briefs/ (one pool per repo); default to it when a
// briefs-dir is given, else <cwd>/raw — same convention as renderMarkdown/renderUrl.
const rawDir = arg("--raw-dir")
	? resolve(arg("--raw-dir"))
	: briefsDir
		? resolve(briefsDir, "..", "raw")
		: resolve(process.cwd(), "raw");
const threadId = target.replace(/^chat:/, "");

// Resolve the thread's messageCount (watermark) + title from the same endpoint
// listChat enumerates — so a rendered thread re-queues only if it has since grown.
// A thread absent here (deleted / private / out of scope) is a clear error, not a
// silent empty render.
// Thread ids are numeric from the API; compare stringified (threadId is the
// `chat:<id>` arg with the prefix stripped, always a string).
const threads = await fetchBriefsThreads();
const meta = threads.find((t) => t && String(t.id) === threadId);
if (!meta) {
	console.error(
		`renderChat: thread ${threadId} not found in /chat/briefs-threads ` +
			`(deleted, private, or not a brief-primed thread).`,
	);
	process.exit(1);
}
const messageCount = Number(meta.messageCount ?? 0);

const body = (await fetchThreadMarkdown(threadId)).trim();

// Watermark = messageCount, recorded the moment we have the substrate. Matches
// listChat's watermark, so a finalized thread re-queues only when it grows.
if (briefsDir) recordProgress(briefsDir, `chat:${threadId}`, messageCount);

console.log(
	[
		`# chat ${threadId}`,
		[
			meta.title ? `title: ${meta.title}` : null,
			`${messageCount} messages`,
			`~${Math.ceil(body.length / 4)} tokens`,
			meta.updatedAt ? `updated: ${meta.updatedAt}` : null,
		]
			.filter(Boolean)
			.join(" · "),
	].join("\n"),
);
// The per-source report path (raw/chat-<id>.report.md); the agent writes the report
// (it's LLM output), this script only names the target so keying stays in one place.
console.log(`report-target: ${join(rawDir, `chat-${threadId}.report.md`)}`);
// NOTE: the thread transcript is deliberately NOT saved in the repo (id-reference
// only, decision 2026-07-02) — this payload file lives in the OS temp dir and is
// transient run scratch, not a local copy of the thread. Stdout can't carry the
// body (Bash truncates over ~30KB; see lib.mjs writePayload).
const { path: substratePath, lines: substrateLines } = writePayload(
	`chat-${threadId}`,
	"md",
	`${body}\n`,
);
console.log(substrateNote(substratePath, substrateLines));
