#!/usr/bin/env node
// List the compile queue for the repo at cwd: every Claude Code session tied to
// this repo (main checkout + .claude/worktrees), with line counts compared against
// briefs/.clearvoid/state.json. Pure Node, no deps. JSON on stdout.
//
// Usage: node listSessions.mjs [--cwd <path>]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	buildChunks,
	claudeProjectsDir,
	cleanContentForTitle,
	encodeProjectPath,
	findRepoRoots,
	resolveCollection,
	nonEmptyLines,
	parseSessionLines,
} from "./lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function loadState(briefsDir) {
	try {
		return JSON.parse(
			readFileSync(join(briefsDir, ".clearvoid", "state.json"), "utf8"),
		);
	} catch {
		return { version: 1, sources: {} };
	}
}

function loadIgnoreGlobs(briefsDir) {
	try {
		return readFileSync(join(briefsDir, ".clearvoid", "ignore"), "utf8")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"))
			.map(
				(g) =>
					new RegExp(
						`^${g.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
					),
			);
	} catch {
		return [];
	}
}

const cwd = arg("--cwd", process.cwd());
const roots = findRepoRoots(cwd);
if (!roots) {
	console.error("listSessions: not inside a git repository");
	process.exit(1);
}
const { checkoutRoot, matchRoot } = roots;
// briefsRoot is the repo's briefs/ (what registerRoot records); a `to:<path>`
// directive narrows the write dir to a collection subfolder. No `to:` → they're equal.
const briefsRoot = join(checkoutRoot, "briefs");
const briefsDir = resolveCollection(briefsRoot, arg("--to"));
const encodedRoot = encodeProjectPath(matchRoot);
// On macOS, /private/var is the realpath for the /var symlink. Claude Code may encode
// the session using either form depending on how it resolved the cwd at creation time.
const altEncodedRoot = matchRoot.startsWith("/private/")
	? encodeProjectPath(matchRoot.slice("/private".length))
	: null;
const projectsDir = claudeProjectsDir();

const state = loadState(briefsDir);
const ignoreGlobs = loadIgnoreGlobs(briefsDir);
const ignoredMatch = (fullId, bareId) =>
	ignoreGlobs.some((re) => re.test(fullId) || re.test(bareId));

let dirs = [];
try {
	dirs = readdirSync(projectsDir).filter(
		(d) =>
			d === encodedRoot ||
			d.startsWith(`${encodedRoot}-`) ||
			(altEncodedRoot &&
				(d === altEncodedRoot || d.startsWith(`${altEncodedRoot}-`))),
	);
} catch {
	console.error(`listSessions: cannot read ${projectsDir}`);
	process.exit(1);
}

const queue = [];
const upToDate = [];
const ignored = [];
const now = Date.now();
// The session this compile is running in (Claude Code sets this in the Bash env).
// Flagged so the skill can include it despite activeRecently — invoking compile is
// what touched its mtime. May be unset, or a subagent id matching nothing: both fine.
const currentSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;

for (const dir of dirs) {
	let files = [];
	try {
		files = readdirSync(join(projectsDir, dir)).filter((f) =>
			f.endsWith(".jsonl"),
		);
	} catch {
		continue;
	}
	for (const file of files) {
		const path = join(projectsDir, dir, file);
		const bareId = `${dir}/${file.replace(/\.jsonl$/, "")}`;
		const fullId = `claude-code:${bareId}`;
		if (ignoredMatch(fullId, bareId)) {
			ignored.push(fullId);
			continue;
		}
		let raw;
		let mtime;
		try {
			raw = readFileSync(path, "utf8");
			mtime = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		const lines = nonEmptyLines(raw);
		const compiledLines = state.sources?.[fullId]?.units ?? 0;
		const newLines = lines.length - compiledLines;
		if (newLines <= 0) {
			upToDate.push({ id: fullId, lines: lines.length });
			continue;
		}
		// Cheap triage parse over the head of the file only.
		const { meta } = parseSessionLines(lines.slice(0, 80));
		// Real substrate size of the NEW portion — raw JSONL bytes overstate it
		// 30–300×, so scope statements must come from this, never from bytes.
		const newTokens = buildChunks(
			parseSessionLines(lines.slice(compiledLines)).messages,
		).reduce((a, c) => a + c.approxTokens, 0);
		let firstMessage = "";
		for (const line of lines.slice(0, 80)) {
			let e;
			try {
				e = JSON.parse(line);
			} catch {
				continue;
			}
			if (e.type !== "user" || e.isMeta) continue;
			const c = e.message?.content ?? e.content;
			const text =
				typeof c === "string"
					? c
					: Array.isArray(c)
						? c
								.filter((b) => b?.type === "text")
								.map((b) => b.text ?? "")
								.join("\n")
						: "";
			const cleaned = cleanContentForTitle(text);
			if (cleaned) {
				firstMessage = cleaned.slice(0, 300);
				break;
			}
		}
		queue.push({
			id: fullId,
			path,
			title: meta.title ?? null,
			firstMessage,
			gitBranch: meta.gitBranch ?? null,
			startedAt: meta.startedAt ? new Date(meta.startedAt).toISOString() : null,
			mtime: new Date(mtime).toISOString(),
			// The session compile was invoked from — always compiled, never deferred.
			current: currentSessionId !== null && file === `${currentSessionId}.jsonl`,
			// Another session writing within the last 5 min (a parallel terminal,
			// likely mid-flight) — defer it to the next compile.
			activeRecently: now - mtime < 5 * 60 * 1000,
			lines: lines.length,
			compiledLines,
			newLines,
			newTokens,
			bytes: raw.length,
		});
	}
}

queue.sort((a, b) =>
	(a.startedAt ?? a.mtime).localeCompare(b.startedAt ?? b.mtime),
);

console.log(
	JSON.stringify(
		{
			repoRoot: matchRoot,
			checkoutRoot,
			encodedRoot,
			briefsRoot,
			briefsDir,
			generatedAt: new Date(now).toISOString(),
			queue,
			upToDateCount: upToDate.length,
			ignoredCount: ignored.length,
		},
		null,
		2,
	),
);
