#!/usr/bin/env node
// The `research:` source front-end: enumerate research units against the briefs
// watermark. A research unit is external enrichment (Exa web + Grok/X discourse)
// about a topic or a specific URL, fetched by the `/clearvoid:research` skill's
// fetchResearch.mjs and cached at raw/<key>.research.md BEFORE compile runs. So,
// unlike url (which fetches in render), this source only ever READS the local
// substrate the skill already wrote — closest in shape to the md source: the unit
// is a whole file and the watermark is its content hash. A fresh research run
// overwrites the substrate → new hash → re-queues; an unchanged one is up to date.
// Pure Node, no deps. Full JSON goes to a payload file; stdout carries a
// compact stub naming it (lib.mjs writePayload).
//
// Usage: node listResearch.mjs <research:key...> [--cwd <p>] [--briefs-dir <p>] [--to <p>]
//   <research:key>  a `research:<key>` id (or bare <key>); the key is the slug
//                   fetchResearch wrote raw/<key>.research.md under. Multiple allowed.
//   --cwd           base for destination resolution (default cwd)
//   --briefs-dir    destination root override; default is <cwd>/briefs
//   --to            collection subfolder of the briefs root (resolveCollection)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	emitListResult,
	findRepoRoots,
	loadBriefsIndex,
	summaryBloatWarnings,
	loadRoots,
	resolveCollection,
	resolveDestination,
	sha256,
} from "./lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cwd = resolve(arg("--cwd", process.cwd()));
const briefsRoot = resolveDestination(cwd, arg("--briefs-dir"));
const newBriefsDir = resolveCollection(briefsRoot, arg("--to"));
const repo = findRepoRoots(cwd);
// raw cache is repo-rooted (a worktree shares its checkout's raw/), matching where
// fetchResearch wrote the substrate and where renderResearch reads it.
const rawDir = join(repo?.checkoutRoot ?? cwd, "raw");

// Positional selectors: everything that isn't a flag or a flag's value.
const VALUE_FLAGS = new Set(["--cwd", "--briefs-dir", "--to"]);
const keys = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--")) {
		if (VALUE_FLAGS.has(argv[i])) i++; // skip its value
		continue;
	}
	keys.push(argv[i].replace(/^research:/, ""));
}

if (keys.length === 0) {
	console.error(
		"listResearch: usage: node listResearch.mjs <research:key...> [--cwd <p>] [--briefs-dir <p>] [--to <p>]",
	);
	process.exit(1);
}

const errors = [];

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
for (const key of [...new Set(keys)].sort()) {
	const substratePath = join(rawDir, `${key}.research.md`);
	let raw;
	try {
		raw = readFileSync(substratePath, "utf8");
	} catch {
		// The skill's fetchResearch writes this before compile runs. A missing file
		// means compile was pointed at a research key that was never fetched.
		errors.push(
			`no research substrate at ${substratePath} — run /clearvoid:research first (fetchResearch writes it).`,
		);
		continue;
	}
	const id = `research:${key}`;
	// Watermark = content hash of the substrate (md pattern). A fresh research run
	// overwrites the file → new hash → re-queues; identical material is up to date.
	const watermark = sha256(raw);
	const prevWatermark = state.sources?.[id]?.units ?? null;
	if (watermark === prevWatermark) {
		upToDate.push({ id, watermark });
		continue;
	}
	const body = stripFrontmatter(raw).trim();
	const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const titleFm = raw.match(/^research_of:\s*(.+)$/m)?.[1]?.trim();
	queue.push({
		id,
		key,
		title: titleFm ?? heading ?? key,
		firstMessage: body.replace(/\s+/g, " ").slice(0, 300),
		newTokens: Math.ceil(body.length / 4),
		current: false,
		watermark,
		prevWatermark,
		bytes: raw.length,
	});
}

const warnings = [];
const inRepo = repo !== null;
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

emitListResult("listResearch", {
	source: "research",
	cwd,
	briefsRoot,
	newBriefsDir,
	rawDir,
	generatedAt: new Date().toISOString(),
	briefs: briefsIndex,
	queue,
	upToDateCount: upToDate.length,
	matched: keys.length,
	errors,
	warnings,
});
