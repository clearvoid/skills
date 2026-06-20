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
	canonicalRoot,
	findRepoRoots,
	loadRoots,
	matchesRootEntry,
	readBriefFrontmatter,
	resolveContextScope,
	rootDisplayName,
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
		name: rootDisplayName(dir),
		briefsDir: dir,
		exists: existsSync(dir),
		briefCount: briefs.length,
		briefs,
	};
}

// A registered root that scope left OUT of the selection pool: name + count only,
// never its brief lines — out-of-scope briefs must not leak into the surface. The
// context skill surfaces these so the user can opt one in (include list / scope).
function describeAvailable(briefsDir) {
	const dir = resolve(briefsDir);
	return {
		kind: "available",
		name: rootDisplayName(dir),
		briefsDir: dir,
		exists: existsSync(dir),
		briefCount: walk(dir, isBrief, []).length,
	};
}

// Load the briefs of the repo you're sitting in (the worktree's own briefs/ when in
// one). For dedup, collapse to the FAMILY root: the registry holds one entry per repo
// (the main checkout path), so a worktree must dedup against that collapsed key or it
// would load the same repo's briefs twice. collapseWorktreePath also catches any legacy
// `.../worktrees/<name>/briefs` entry an older compile may have left in the registry.
const currentDir = repo ? join(repo.checkoutRoot, "briefs") : null;
const currentKey = currentDir ? canonicalRoot(currentDir) : null;

// Context scope decides which OTHER registered repos enter the selection pool.
// Default "repo" = isolation (only this repo's briefs); "all" = every registered
// root; per-repo include/exclude refine either. Exclude always wins. The current
// repo's own briefs are ALWAYS loaded — scope only governs the others.
const { scope, include, exclude } = resolveContextScope(currentDir);
const inScope = (r) => {
	if (exclude.some((e) => matchesRootEntry(e, r))) return false;
	if (scope === "all") return true;
	return include.some((e) => matchesRootEntry(e, r));
};

const otherRoots = registry.roots.filter(
	(r) => !currentKey || canonicalRoot(r) !== currentKey,
);
const selected = [];
const available = [];
for (const r of otherRoots) (inScope(r) ? selected : available).push(r);

const out = {
	scope,
	current: currentDir ? describe(currentDir, "current-repo") : null,
	others: selected.map((r) => describe(r, "registered")),
	// Registered but out of scope — name + count only, no brief lines.
	available: available.map((r) => describeAvailable(r)),
};

console.log(JSON.stringify(out, null, 2));
