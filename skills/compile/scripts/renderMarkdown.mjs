#!/usr/bin/env node
// Render one markdown unit into compile substrate. Near-trivial: a .md file is
// already clean substrate, so this is mostly a header (provenance + size accounting)
// in front of the verbatim body. The free-source counterpart to renderSession.mjs.
//
// Usage: node renderMarkdown.mjs <md:path-or-path> [--briefs-dir <path>]
//   accepts a full `md:<abs-path>` id, a bare path, or a `~/`-prefixed path.
//   --briefs-dir <path>  record the watermark (content hash) as pending progress
//                        for finalizeState to commit — pass it during a compile.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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
console.log(`\n${raw.trim()}`);
