#!/usr/bin/env node
// Resolve every place the user's briefs live: the current repo's briefs/ plus the
// ~/.clearvoid/roots.json registry (personal root + other registered repos).
// JSON on stdout — the context skill reads this, then the indexes, then the briefs.
//
// Usage: node resolveRoots.mjs [--cwd <path>]

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findRepoRoots, loadRoots } from "../../compile/scripts/lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cwd = arg("--cwd", process.cwd());
const repo = findRepoRoots(cwd);
const registry = loadRoots();

function describe(briefsDir, kind) {
	const dir = resolve(briefsDir);
	const index = join(dir, "README.md");
	let briefCount = 0;
	try {
		briefCount = readFileSync(index, "utf8").split("\n").filter((l) => l.startsWith("- ")).length;
	} catch {
		// no index yet
	}
	return {
		kind,
		briefsDir: dir,
		exists: existsSync(dir),
		index: existsSync(index) ? index : null,
		briefCount,
	};
}

const currentDir = repo ? join(repo.checkoutRoot, "briefs") : null;
const out = {
	current: currentDir ? describe(currentDir, "current-repo") : null,
	personal: describe(registry.personalRoot, "personal"),
	others: registry.roots
		.filter((r) => !currentDir || resolve(r) !== resolve(currentDir))
		.map((r) => describe(r, "registered")),
};

console.log(JSON.stringify(out, null, 2));
