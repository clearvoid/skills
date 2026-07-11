#!/usr/bin/env node
// Render one `research:` unit into compile substrate. The substrate (Exa web + Grok/X
// enrichment) was fetched and cached at raw/<key>.research.md by the
// `/clearvoid:research` skill's fetchResearch.mjs BEFORE compile ran — so unlike
// renderUrl this script never hits the network; it reads the local cache, prints the
// substrate plus the per-source report target, and records the content-hash
// watermark. The fold (briefs + the report) is the agent's job (SKILL.md step 6).
//
// Usage: node renderResearch.mjs <research:key> [--briefs-dir <writeDir>] [--raw-dir <rawDir>]
//   <research:key>          a `research:<key>` id (or bare <key>).
//   --briefs-dir <writeDir> record the content-hash watermark as pending progress for
//                           finalizeState to commit — pass during compile.
//   --raw-dir <rawDir>      where the research cache lives (default <cwd>/raw).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordProgress, sha256 } from "./lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
	console.error(
		"renderResearch: usage: node renderResearch.mjs <research:key> [--briefs-dir <p>] [--raw-dir <p>]",
	);
	process.exit(1);
}
const briefsDir = arg("--briefs-dir");
const rawDir = resolve(arg("--raw-dir", join(process.cwd(), "raw")));

const key = target.replace(/^research:/, "");
const substratePath = join(rawDir, `${key}.research.md`);
// The per-source report the agent writes sits beside the substrate:
// raw/<key>.research.report.md. The distinct `.research.report.md` suffix keeps it
// from colliding with a url: source's raw/<key>.report.md when both research and a
// plain extract target the same URL; it still ends in `.report.md`, so the backlog
// scanner (loadNextSteps) and the desktop app pick up its `## Next steps` for free.
const reportPath = join(rawDir, `${key}.research.report.md`);

let rawText;
try {
	rawText = readFileSync(substratePath, "utf8");
} catch {
	console.error(
		`renderResearch: no substrate at ${substratePath} — run /clearvoid:research first (fetchResearch writes it).`,
	);
	process.exit(1);
}

// Body for size accounting = everything after any frontmatter header.
const body = rawText.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

// Watermark = content hash of the substrate, matching listResearch's queue test.
if (briefsDir) recordProgress(briefsDir, `research:${key}`, sha256(rawText));

const size = `~${Math.ceil(body.length / 4)} tokens · ${rawText.length} bytes`;
console.log([`# research ${key}`, size].join("\n"));
// Machine-readable target for the per-source report the agent writes (SKILL.md
// step 6). Naming it here keeps the key derivation in one place; the agent Writes
// the report to this path. The verbatim raw/<key>.research.md is never edited.
console.log(`report-target: ${reportPath}`);
console.log(`\n${body}`);
