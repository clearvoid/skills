#!/usr/bin/env node
// Resolve every place the user's briefs live: the current repo's briefs/ plus the
// ~/.clearvoid/roots.json registry (the other registered repos), and emit one line
// per brief (slug, title, summary, updated) read straight from each file's
// frontmatter. There is no generated index — this output IS the selection surface.
// JSON on stdout; the recall skill reads this, then loads the briefs it picks.
//
// Usage: node resolveRoots.mjs [--cwd <path>]

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
	canonicalRoot,
	findRepoRoots,
	loadNextSteps,
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

// How many leading lines form a brief's CURRENT VIEW — everything above the
// trailing `## Log` history (matched leniently as `^## Log\b`, also catching
// `## Log & evolution …`); null when there is no log. Recall passes this straight
// to Read as a `limit` to load the current view and skip the log, which bloats
// context and confuses the model with superseded loops/turns.
function currentViewLineCount(text) {
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		// Heading at 0-based index i (1-based line i+1): the i lines above it
		// (1-based 1..i) are the current view, so Read `limit: i` excludes the log.
		if (/^## Log\b/.test(lines[i])) return i;
	}
	return null;
}

function describe(briefsDir, kind) {
	const dir = resolve(briefsDir);
	const briefs = [];
	for (const file of walk(dir, isBrief, [])) {
		let content, fm;
		try {
			content = readFileSync(file, "utf8");
			fm = readBriefFrontmatter(content);
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
			// anchor: load-bearing brief recall always loads (in full) and weights
			// first. currentViewLines: Read `limit` so the `## Log` history isn't loaded.
			anchor: fm.anchor ?? false,
			// tags: human-curated filter axis — lets recall select on "load
			// everything tagged X" and weigh a topic that matches a tag.
			tags: fm.tags ?? [],
			currentViewLines: currentViewLineCount(content),
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
// recall skill surfaces these so the user can opt one in (include list / scope).
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

// Flagged mode (recall's `--flagged`): the action-list cut of the backlog. Surface
// only the flagged-and-open items (the leading ⭐, not yet done) across in-scope
// roots, AND resolve the full context to hand an agent — the briefs each flagged
// item links (`[[slug]]`) and the per-source reports they live in — so the caller
// can load briefs + reports in full. Same scope rules as backlog.
if (process.argv.includes("--flagged")) {
	const inScopeDirs = [
		...(currentDir ? [currentDir] : []),
		...selected,
	].map((d) => resolve(d));

	const referencedSlugs = new Set();
	const reportPaths = new Set();
	const flaggedForRoot = (briefsDir, kind) => {
		const dir = resolve(briefsDir);
		const sources = loadNextSteps(dir)
			.sources.map((s) => ({
				...s,
				items: s.items.filter((i) => i.flagged && !i.done),
			}))
			.filter((s) => s.items.length > 0);
		for (const s of sources) {
			reportPaths.add(s.reportPath);
			for (const it of s.items)
				for (const m of it.text.matchAll(/\[\[([^\]]+)\]\]/g))
					referencedSlugs.add(m[1]);
		}
		return {
			kind,
			name: rootDisplayName(dir),
			briefsDir: dir,
			exists: existsSync(dir),
			sources,
		};
	};

	const roots = [
		...(currentDir ? [flaggedForRoot(currentDir, "current-repo")] : []),
		...selected.map((r) => flaggedForRoot(r, "registered")),
	].filter((r) => r.sources.length > 0);

	// Resolve `[[slug]]` links to brief paths — but only walk the brief dirs if a
	// flagged item actually referenced one (skips the walk in the common no-flags case).
	const briefs = [];
	if (referencedSlugs.size > 0) {
		const briefBySlug = new Map();
		for (const dir of inScopeDirs)
			for (const file of walk(dir, isBrief, [])) {
				const slug = basename(file, ".md");
				if (!briefBySlug.has(slug)) briefBySlug.set(slug, file);
			}
		for (const slug of referencedSlugs) {
			const file = briefBySlug.get(slug);
			if (file) briefs.push(file);
		}
	}

	console.log(
		JSON.stringify(
			{
				scope,
				mode: "flagged",
				roots,
				// Read these in full to ground an agent on the flagged work.
				load: { briefs, reports: [...reportPaths] },
			},
			null,
			2,
		),
	);
	process.exit(0);
}

// Backlog mode (recall's `--backlog`): surface each in-scope root's next-steps
// backlog — the `## Next steps` of every per-source report (raw/*.report.md),
// grouped by source — instead of the brief lines. Same scope rules: the current
// repo plus whatever context scope lets in; out-of-scope roots stay name+count only.
if (process.argv.includes("--backlog")) {
	const describeBacklog = (briefsDir, kind) => {
		const dir = resolve(briefsDir);
		return {
			kind,
			name: rootDisplayName(dir),
			briefsDir: dir,
			exists: existsSync(dir),
			...loadNextSteps(dir),
		};
	};
	console.log(
		JSON.stringify(
			{
				scope,
				mode: "backlog",
				current: currentDir ? describeBacklog(currentDir, "current-repo") : null,
				others: selected.map((r) => describeBacklog(r, "registered")),
				available: available.map((r) => describeAvailable(r)),
			},
			null,
			2,
		),
	);
	process.exit(0);
}

const out = {
	scope,
	current: currentDir ? describe(currentDir, "current-repo") : null,
	others: selected.map((r) => describe(r, "registered")),
	// Registered but out of scope — name + count only, no brief lines.
	available: available.map((r) => describeAvailable(r)),
};

console.log(JSON.stringify(out, null, 2));
