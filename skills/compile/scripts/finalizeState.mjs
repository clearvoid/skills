#!/usr/bin/env node
// Commit the compile's pending watermark and clear it. The render scripts record
// what they read into briefs/.clearvoid/progress.json as a side effect (given
// --briefs-dir); this folds that into the committed, team-shared watermark
// (state.json). Run it once at the end of a compile, alongside registerRoot,
// after every brief is written.
//
// CONTEXT: replaces the old per-unit `updateState` call the agent ran after each
// session. That depended on agent discipline and got silently skipped, so
// sessions folded into briefs went un-watermarked and re-queued forever. The
// watermark is now a deterministic byproduct of rendering + this single finalize.
//
// Usage: node finalizeState.mjs --briefs-dir <path>

import { commitProgress } from "./lib.mjs";

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const briefsDir = arg("--briefs-dir");
if (!briefsDir) {
	console.error(
		"finalizeState: usage: node finalizeState.mjs --briefs-dir <path>",
	);
	process.exit(1);
}

const committed = commitProgress(briefsDir);
console.log(
	committed.length === 0
		? "finalizeState: nothing pending — watermark unchanged"
		: `finalizeState: watermarked ${committed.length} unit(s)`,
);
