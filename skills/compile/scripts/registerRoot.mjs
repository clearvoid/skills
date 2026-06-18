#!/usr/bin/env node
// Register this repo's briefs/ in ~/.clearvoid/roots.json so the read side (the
// context skill, the desktop workbench) can find it. Deterministic, idempotent,
// no LLM. Run once at the end of every compile.
//
// No index is generated: briefs are canonical and the context skill scans their
// frontmatter directly. This step only makes the root discoverable.
//
// Usage: node registerRoot.mjs --briefs-dir <path>

import { registerRoot } from "./lib.mjs";

function arg(name) {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const briefsDir = arg("--briefs-dir");
if (!briefsDir) {
	console.error("registerRoot: usage: node registerRoot.mjs --briefs-dir <path>");
	process.exit(1);
}

const registered = registerRoot(briefsDir);
console.log(
	`registerRoot: ${registered ? "root registered in roots.json" : "root already registered"}`,
);
