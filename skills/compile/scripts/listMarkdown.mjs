#!/usr/bin/env node
// The `md:` source front-end: enumerate plain-markdown units (a file, a directory,
// or a glob) against the briefs watermark. The free-source counterpart to
// listSessions.mjs — same queue shape, but the unit is a whole file and the
// watermark is a content hash, not a line offset. Pure Node, no deps. JSON on stdout.
//
// Usage: node listMarkdown.mjs <selector...> [--cwd <path>] [--briefs-dir <path>]
//   <selector>     md:<path>, a bare path, a directory (recursive *.md), or a *-glob.
//                  Leading `md:` and `~/` are accepted. Multiple selectors allowed.
//   --cwd          base for relative selectors + destination resolution (default cwd)
//   --briefs-dir   destination override; default is <cwd>/briefs (resolveDestination)

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	findRepoRoots,
	loadBriefsIndex,
	summaryBloatWarnings,
	loadRoots,
	resolveCollection,
	resolveDestination,
	sha256,
	walk,
} from "./lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cwd = resolve(arg("--cwd", process.cwd()));
const briefsRoot = resolveDestination(cwd, arg("--briefs-dir"));
// Orientation, queue, and watermark all key off briefsRoot (one pool per repo).
// to:<path> only sets newBriefsDir — the collection subfolder where NEW briefs from
// this run are filed (collections are folders, not walls). registerRoot (run by the
// SKILL) records briefsRoot so the read side recurses and sees every collection.
const newBriefsDir = resolveCollection(briefsRoot, arg("--to"));
// Positional selectors: everything that isn't a flag or a flag's value.
const VALUE_FLAGS = new Set(["--cwd", "--briefs-dir", "--to"]);
const selectors = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--")) {
		if (VALUE_FLAGS.has(argv[i])) i++; // skip its value
		continue;
	}
	selectors.push(argv[i]);
}

if (selectors.length === 0) {
	console.error(
		"listMarkdown: usage: node listMarkdown.mjs <selector...> [--cwd <p>] [--briefs-dir <p>]",
	);
	process.exit(1);
}

function expandTilde(p) {
	return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// Build a RegExp from a `*`/`**` glob: `*` stays within a path segment; `**/`
// matches zero or more directory segments (so `dir/**/*.md` also matches files
// directly in `dir`); a bare `**` spans separators. One printable pass — the
// alternation tries `**/` before `**` before `*`, so the callback never sees an
// already-rewritten token, and there's no placeholder char to corrupt a glob over
// a path that itself contains spaces.
function globToRe(glob) {
	const re = glob
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\/|\*\*|\*/g, (m) =>
			m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : "[^/]*",
		);
	return new RegExp(`^${re}$`);
}

const errors = [];

function expandSelector(rawSel) {
	const sel = resolve(cwd, expandTilde(rawSel.replace(/^md:/, "")));
	if (sel.includes("*")) {
		const base = sel.slice(0, sel.indexOf("*")).replace(/\/[^/]*$/, "") || "/";
		const re = globToRe(sel);
		return walk(base, (p) => p.endsWith(".md") && re.test(p), []);
	}
	let st;
	try {
		st = statSync(sel);
	} catch {
		errors.push(`no such path: ${sel}`);
		return [];
	}
	if (st.isDirectory()) return walk(sel, (p) => p.endsWith(".md"), []);
	if (st.isFile()) {
		if (sel.endsWith(".md")) return [sel];
		errors.push(`not a .md file: ${sel}`);
		return [];
	}
	return [];
}

const files = [...new Set(selectors.flatMap(expandSelector))].sort();

// state.json keyed by source-namespaced id; md ids carry the absolute path.
let state = { version: 1, sources: {} };
try {
	state = JSON.parse(
		readFileSync(join(briefsRoot, ".clearvoid", "state.json"), "utf8"),
	);
	if (!state.sources) state.sources = {};
} catch {
	// fresh destination
}

// Strip a leading YAML frontmatter block for the title/preview scan only.
function stripFrontmatter(text) {
	const m = text.match(/^---\n[\s\S]*?\n---\n?/);
	return m ? text.slice(m[0].length) : text;
}

const queue = [];
const upToDate = [];
for (const path of files) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		continue;
	}
	const id = `md:${path}`;
	const watermark = sha256(raw);
	const prevWatermark = state.sources?.[id]?.units ?? null;
	if (watermark === prevWatermark) {
		upToDate.push({ id, watermark });
		continue;
	}
	const body = stripFrontmatter(raw).trim();
	const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	queue.push({
		id,
		path,
		title: heading ?? basename(path).replace(/\.md$/, ""),
		firstMessage: body.replace(/\s+/g, " ").slice(0, 300),
		// Approx-token substrate size (chars/4) — same scope-statement unit as the
		// claude-code source's newTokens. md files are already clean substrate.
		newTokens: Math.ceil(body.length / 4),
		// md re-renders whole on any change — no incremental offset.
		current: false,
		watermark,
		prevWatermark,
		bytes: raw.length,
	});
}

// Loud warning: about to seed a brand-new briefs/ in a place with no git history
// and no prior registration. Can't block (non-interactive runs hang on prompts),
// so it rides in the output for the SKILL to surface.
const warnings = [];
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
			source: "md",
			cwd,
			briefsRoot,
			newBriefsDir,
			generatedAt: new Date().toISOString(),
			briefs: briefsIndex,
			queue,
			upToDateCount: upToDate.length,
			matched: files.length,
			errors,
			warnings,
		},
		null,
		2,
	),
);
