#!/usr/bin/env node
// Render one markdown unit into compile substrate. Near-trivial: a .md file is
// already clean substrate, so this is mostly a header (provenance + size accounting)
// in front of the verbatim body. The free-source counterpart to renderSession.mjs.
//
// Usage: node renderMarkdown.mjs <md:path-or-path> [--briefs-dir <path>] [--raw-dir <path>]
//   accepts a full `md:<abs-path>` id, a bare path, or a `~/`-prefixed path.
//   --briefs-dir <path>  record the watermark (content hash) as pending progress
//                        for finalizeState to commit — pass it during a compile.
//   --raw-dir <path>     where the per-source report lands (default the raw/
//                        sibling of --briefs-dir, else <cwd>/raw).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { recordProgress, sha256 } from "./lib.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
	console.error(
		"renderMarkdown: usage: node renderMarkdown.mjs <md:path-or-path> [--briefs-dir <path>]",
	);
	process.exit(1);
}
const bdIdx = args.indexOf("--briefs-dir");
const briefsDir = bdIdx >= 0 ? args[bdIdx + 1] : null;
const rdIdx = args.indexOf("--raw-dir");
// raw/ is a sibling of briefs/ (one pool per repo); default to it when a
// briefs-dir is given, else <cwd>/raw — same convention as renderUrl.
const rawDir =
	rdIdx >= 0
		? resolve(args[rdIdx + 1])
		: briefsDir
			? resolve(briefsDir, "..", "raw")
			: resolve(process.cwd(), "raw");

// The per-source report path (raw/<key>.report.md), a sibling of briefs/ like
// the url/research reports. Two keying cases: a md file already dropped inside
// raw/ keys on its own basename, so the report sits right beside it and mirrors
// a url report; a file anywhere else keys on a slug of its name plus a short
// hash of its absolute path, so two same-named files in different folders never
// collide on one report. The agent writes the report (it's LLM output); this
// script only names the target so key derivation stays in one place.
function reportKey(mdPath) {
	const abs = resolve(mdPath);
	const base = basename(abs).replace(/\.md$/, "");
	if (abs.startsWith(resolve(rawDir) + sep)) return base;
	const slug =
		base
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 120) || "md";
	// sha256() returns a `sha256:<hex>` watermark string — take the hex only.
	return `${slug}-${sha256(abs).replace(/^sha256:/, "").slice(0, 8)}`;
}

const stripped = target.replace(/^md:/, "");
const expanded = stripped.startsWith("~/")
	? join(homedir(), stripped.slice(2))
	: stripped;
const path = resolve(expanded);
if (!existsSync(path)) {
	console.error(`renderMarkdown: no markdown file at ${path}`);
	process.exit(1);
}

const raw = readFileSync(path, "utf8");
// Watermark = the file's content hash, recorded the moment we read it. Matches
// listMarkdown's `sha256(raw)`, so a finalized file re-queues only if it changes.
if (briefsDir) recordProgress(briefsDir, `md:${path}`, sha256(raw));
// Strip a leading YAML frontmatter block for the size accounting / heading scan;
// the rendered body below is the full file verbatim (frontmatter is substrate too).
const bodyForCount = raw.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
const heading = bodyForCount.match(/^#\s+(.+)$/m)?.[1]?.trim();

console.log(
	[
		`# Markdown ${path}`,
		[
			heading ? `title: ${heading}` : null,
			`~${Math.ceil(bodyForCount.length / 4)} tokens · ${raw.length} bytes`,
		]
			.filter(Boolean)
			.join(" · "),
	].join("\n"),
);
console.log(`report-target: ${join(rawDir, `${reportKey(path)}.report.md`)}`);
console.log(`\n${raw.trim()}`);
