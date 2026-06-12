#!/usr/bin/env node
// Record compile progress in briefs/.clearvoid/state.json — the team-shared,
// content-free watermark. One call per compiled session.
//
// Usage: node updateState.mjs --briefs-dir <path> --session <full-id> --lines <N> [--touched slug1,slug2]
//   --session  full source-namespaced id, e.g. claude-code:<encoded-dir>/<uuid>
//   --lines    total non-empty JSONL lines compiled through (absolute, not delta)
//   --touched  brief slugs this session contributed to

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const briefsDir = arg("--briefs-dir");
const session = arg("--session");
const lines = Number(arg("--lines"));
const touched = (arg("--touched") ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

if (!briefsDir || !session || !Number.isFinite(lines)) {
	console.error(
		"updateState: usage: node updateState.mjs --briefs-dir <path> --session <id> --lines <N> [--touched a,b]",
	);
	process.exit(1);
}

const dir = join(briefsDir, ".clearvoid");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "state.json");

let state = { version: 1, sources: {} };
try {
	state = JSON.parse(readFileSync(statePath, "utf8"));
	if (!state.sources) state.sources = {};
} catch {
	// fresh state
}

const prev = state.sources[session];
state.sources[session] = {
	units: lines,
	compiledAt: new Date().toISOString(),
	briefs: [...new Set([...(prev?.briefs ?? []), ...touched])].sort(),
};

writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(`updateState: ${session} → ${lines} lines (${state.sources[session].briefs.length} briefs)`);
