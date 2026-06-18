#!/usr/bin/env node
// Resolve every place the user's briefs live: the current repo's briefs/ plus the
// ~/.clearvoid/roots.json registry (the other registered repos), and emit one line
// per brief (slug, title, summary, updated) read straight from each file's
// frontmatter. There is no generated index — this output IS the selection surface.
// JSON on stdout; the context skill reads this, then loads the briefs it picks.
//
// Usage: node resolveRoots.mjs [--cwd <path>]

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	findRepoRoots,
	loadRoots,
	readBriefFrontmatter,
	walk,
} from "../../compile/scripts/lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cwd = arg("--cwd", process.cwd());
const repo = findRepoRoots(cwd);
const registry = loadRoots();

// Collect every .md under the briefs root, at any depth, skipping dotdirs
// (.clearvoid) and README.md (the shared walk() skips dotdirs; the predicate adds
// the README.md exclusion). Collections are subfolders under briefs/ — the brief's
// folder relative to the root is its collection ("" = top-level).
const isBrief = (p) => p.endsWith(".md") && basename(p) !== "README.md";

function describe(briefsDir, kind) {
	const dir = resolve(briefsDir);
	const briefs = [];
	for (const file of walk(dir, isBrief, [])) {
		let fm;
		try {
			fm = readBriefFrontmatter(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (!fm?.title) continue;
		const summary =
			fm.summary ??
			(fm.framing ? fm.framing.split(". ")[0].replace(/\.?$/, ".") : "");
		// Collection = the brief's folder relative to the briefs root, posix-style.
		const collection = relative(dir, dirname(file)).split(sep).join("/");
		briefs.push({
			slug: basename(file, ".md"),
			collection,
			title: fm.title,
			summary,
			updated: fm.updated ?? "",
		});
	}
	briefs.sort(
		(a, b) =>
			a.collection.localeCompare(b.collection) ||
			b.updated.localeCompare(a.updated) ||
			a.title.localeCompare(b.title),
	);
	return {
		kind,
		briefsDir: dir,
		exists: existsSync(dir),
		briefCount: briefs.length,
		briefs,
	};
}

const currentDir = repo ? join(repo.checkoutRoot, "briefs") : null;
const out = {
	current: currentDir ? describe(currentDir, "current-repo") : null,
	others: registry.roots
		.filter((r) => !currentDir || resolve(r) !== resolve(currentDir))
		.map((r) => describe(r, "registered")),
};

console.log(JSON.stringify(out, null, 2));
