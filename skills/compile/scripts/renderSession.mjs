#!/usr/bin/env node
// Render one Claude Code session JSONL into clean compile substrate: chrome-stripped
// USER:/ASSISTANT: turns, chunked at /compact boundaries. Markdown on stdout.
//
// Usage: node renderSession.mjs <session-id-or-path> [--from-line N] [--briefs-dir <path>]
//   <session-id-or-path>  bare id (encoded-dir/uuid), claude-code:<id>, or absolute .jsonl path
//   --from-line N         skip the first N non-empty lines (the state.json offset),
//                         rendering only what's new since the last compile
//   --briefs-dir <path>   record the watermark (lines read) as pending progress for
//                         finalizeState to commit — pass it during a compile

import { existsSync, readFileSync } from "node:fs";
import {
	buildChunks,
	claudeProjectsDir,
	nonEmptyLines,
	parseSessionLines,
	recordProgress,
} from "./lib.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const fromIdx = args.indexOf("--from-line");
const fromLine = fromIdx >= 0 ? Number(args[fromIdx + 1]) || 0 : 0;
// When --briefs-dir is given, rendering records the watermark (lines read) as
// pending progress; finalizeState commits it. This is how the watermark is kept
// deterministic — see lib.mjs commitProgress.
const bdIdx = args.indexOf("--briefs-dir");
const briefsDir = bdIdx >= 0 ? args[bdIdx + 1] : null;

if (!target) {
	console.error(
		"renderSession: usage: node renderSession.mjs <session-id-or-path> [--from-line N]",
	);
	process.exit(1);
}

const bare = target.replace(/^claude-code:/, "");
const path = existsSync(bare)
	? bare
	: `${claudeProjectsDir()}/${bare}.jsonl`;
if (!existsSync(path)) {
	console.error(`renderSession: no session file at ${path}`);
	process.exit(1);
}

const all = nonEmptyLines(readFileSync(path, "utf8"));
// Watermark = the absolute line count read through (all.length), recorded the
// moment we read it so it can't be forgotten downstream. Matches listSessions'
// `lines.length`, so a finalized session re-queues with zero new lines.
if (briefsDir) recordProgress(briefsDir, `claude-code:${bare}`, all.length);
const lines = all.slice(fromLine);
const { messages, meta } = parseSessionLines(lines);
const chunks = buildChunks(messages);

const fmt = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16) : "?");
const header = [
	`# Session ${bare}`,
	[
		meta.title ? `title: ${meta.title}` : null,
		meta.gitBranch ? `branch: ${meta.gitBranch}` : null,
		`span: ${fmt(meta.startedAt)} → ${fmt(meta.endedAt)}`,
		`lines: ${fromLine}..${all.length}${fromLine > 0 ? " (incremental — earlier lines already compiled)" : ""}`,
	]
		.filter(Boolean)
		.join(" · "),
].join("\n");

console.log(header);
if (chunks.length === 0) {
	console.log("\n(no substrate content in this range)");
	process.exit(0);
}
for (const c of chunks) {
	console.log(
		`\n===== chunk ${c.chunkIndex + 1}/${chunks.length} · ~${c.approxTokens} tokens · ${c.messageCount} turns${c.startsWithCompactSummary ? " · opens with prior-session summary" : ""} =====\n`,
	);
	console.log(c.text);
}
