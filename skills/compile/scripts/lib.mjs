// Shared JSONL parsing + chrome-stripping for the clearvoid-compile scripts.
// Vendored from packages/lib/claudeSessions/{parseJsonl,chrome,buildSynthesisPayload}.ts —
// deliberately standalone (plugins are cached self-contained and cannot reach the monorepo).
// NOTE: keep semantics in lockstep with the originals; re-derive the chrome tag list
// empirically when output looks dirty (scan user turns for leading `<tag>`).

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// FRAGILE: mirrors what Claude Code emits; grows across CC versions.
const BLOCK_CHROME_TAGS = [
	"task-notification",
	"local-command-stdout",
	"local-command-stderr",
	"local-command-caveat",
	"system-reminder",
	"bash-input",
	"bash-stdout",
	"bash-stderr",
	"ide_opened_file",
	"ide_selection",
	"ide_diagnostics",
	"ide_closed_file",
];

const BLOCK_CHROME_RE = new RegExp(
	`<(${BLOCK_CHROME_TAGS.join("|")})>[\\s\\S]*?<\\/\\1>`,
	"g",
);

export function stripChromeBlocks(content) {
	return content.replace(BLOCK_CHROME_RE, "").trim();
}

// Whole-turn IDE injections sometimes arrive with no closing tag — drop the turn
// when it leads with one.
const WHOLE_TURN_CHROME_RE = new RegExp(
	`^<(?:ide_opened_file|ide_selection|ide_diagnostics|ide_closed_file)(?:\\s|>|$)`,
);

export function isWholeTurnChrome(content) {
	return WHOLE_TURN_CHROME_RE.test(content.trimStart());
}

// Slash-command turns: <command-name>/x</command-name>…<command-args>real intent</command-args>
// Args are real user content; argless invocations are pure ceremony.
export function extractSlashCommandArgs(content) {
	if (
		!content.startsWith("<command-name>") &&
		!content.startsWith("<command-message>")
	) {
		return null;
	}
	const m = content.match(/<command-args>([\s\S]*?)<\/command-args>/);
	return m ? m[1].trim() : "";
}

export function stripTrailingUsage(content) {
	return content.replace(/\s*<usage>[\s\S]*?<\/usage>\s*$/, "").trimEnd();
}

export function cleanContentForTitle(content) {
	if (isWholeTurnChrome(content)) return "";
	const args = extractSlashCommandArgs(content);
	const base = args !== null ? args : content;
	return stripChromeBlocks(base).trim();
}

function parseTs(val) {
	if (val == null) return undefined;
	if (typeof val === "string") {
		const t = new Date(val).getTime();
		if (!Number.isNaN(t)) return t;
	}
	if (typeof val === "number") {
		// FRAGILE: some entries store seconds, others ms — disambiguate by magnitude.
		return val < 100_000_000_000 ? val * 1000 : val;
	}
	return undefined;
}

/** Non-empty lines of a JSONL file — the unit everything counts in (state.json offsets). */
export function nonEmptyLines(raw) {
	return raw.split("\n").filter((l) => l.trim().length > 0);
}

/**
 * Parse JSONL lines into the minimal message stream the compile substrate needs:
 * user/assistant text turns (+ entry-level isMeta / isCompactSummary flags) and
 * session metadata. Thinking, tool_use/tool_result, progress, and snapshots are
 * dropped here — the synthesis filter never used them.
 */
export function parseSessionLines(lines) {
	const messages = [];
	let cwd;
	let gitBranch;
	let customTitle;
	let startedAt;
	let endedAt;

	for (const line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
		if (typeof entry.gitBranch === "string") gitBranch = entry.gitBranch;
		if (typeof entry.customTitle === "string") customTitle = entry.customTitle;

		const created = parseTs(entry.timestamp);
		if (created !== undefined) {
			if (startedAt === undefined || created < startedAt) startedAt = created;
			if (endedAt === undefined || created > endedAt) endedAt = created;
		}

		if (entry.type !== "user" && entry.type !== "assistant") continue;
		const msgContent = entry.message?.content ?? entry.content;
		const push = (content) =>
			messages.push({
				role: entry.type,
				content,
				isMeta: entry.isMeta === true,
				isCompactSummary: entry.isCompactSummary === true,
				createdAt: created,
			});

		if (typeof msgContent === "string") {
			push(msgContent);
		} else if (Array.isArray(msgContent)) {
			for (const block of msgContent) {
				if (
					block &&
					typeof block === "object" &&
					block.type === "text" &&
					typeof block.text === "string"
				) {
					push(block.text);
				}
			}
		}
	}

	const firstUserTitle = messages
		.filter((m) => m.role === "user" && !m.isMeta && !m.isCompactSummary)
		.map((m) => cleanContentForTitle(m.content))
		.find((c) => c.length > 0);
	const title =
		customTitle ??
		(firstUserTitle ? firstUserTitle.split("\n")[0].slice(0, 100) : undefined);

	return { messages, meta: { title, gitBranch, cwd, startedAt, endedAt } };
}

/**
 * Build clean per-segment chunks: USER:/ASSISTANT: turns joined with `---`,
 * sliced at /compact markers whose recap seeds the next chunk as
 * PRIOR-SESSION-SUMMARY. Port of buildSynthesisChunks — same filter order.
 */
export function buildChunks(messages) {
	const chunks = [];
	let lines = [];
	let messageCount = 0;
	let startsWithCompact = false;

	function flush() {
		if (lines.length === 0) return;
		const text = lines.join("\n\n---\n\n");
		chunks.push({
			chunkIndex: chunks.length,
			text,
			approxTokens: Math.ceil(text.length / 4),
			messageCount,
			startsWithCompactSummary: startsWithCompact,
		});
		lines = [];
		messageCount = 0;
		startsWithCompact = false;
	}

	for (const m of messages) {
		if (m.isCompactSummary) {
			flush();
			const content = m.content?.trim();
			if (content) {
				lines.push(`PRIOR-SESSION-SUMMARY:\n${content}`);
				messageCount++;
				startsWithCompact = true;
			}
			continue;
		}
		if (m.isMeta) continue;
		let content = m.content?.trim();
		if (!content) continue;
		if (isWholeTurnChrome(content)) continue;

		if (m.role === "user") {
			const args = extractSlashCommandArgs(content);
			if (args !== null) {
				if (!args) continue;
				content = args;
			}
		} else if (m.role === "assistant") {
			content = stripTrailingUsage(content);
		}

		content = stripChromeBlocks(content);
		if (!content) continue;

		const turn = `${m.role === "user" ? "USER" : "ASSISTANT"}:\n${content}`;
		// Re-sent messages (user resubmits the same turn) render as consecutive
		// duplicates — keep the first only.
		if (lines.length > 0 && lines[lines.length - 1] === turn) continue;
		lines.push(turn);
		messageCount++;
	}
	flush();
	return chunks;
}

/** Claude Code encodes a cwd into a project-dir name by replacing `/` and `.` with `-`. */
export function encodeProjectPath(p) {
	return p.replace(/[/.]/g, "-");
}

/**
 * Where session JSONLs live. CLEARVOID_HOME_DIR (same convention as the
 * desktop app's demo corpus) overrides the real home — points at a directory
 * CONTAINING `.claude/projects/`. Enables hermetic end-to-end tests.
 */
export function claudeProjectsDir() {
	const home = process.env.CLEARVOID_HOME_DIR ?? homedir();
	return join(home, ".claude", "projects");
}

/**
 * Nearest ancestor containing .git (dir in a checkout, file in a worktree).
 * `checkoutRoot` is where briefs/ lives (a worktree writes briefs onto its OWN
 * branch); `matchRoot` collapses <root>/.claude/worktrees/<name> back to <root>
 * so session matching covers the whole repo family.
 */
export function findRepoRoots(start) {
	let dir = resolve(start);
	for (;;) {
		if (existsSync(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	const m = dir.match(/^(.*?)\/\.claude\/worktrees\/[^/]+$/);
	return { checkoutRoot: dir, matchRoot: m ? m[1] : dir };
}

// ── Cross-project roots registry: ~/.clearvoid/roots.json ──────────────────
// Shared by every client (compile, context, the desktop workbench). Read-side
// tools aggregate across it; compile only writes where it was pointed.

export function rootsPath() {
	const home = process.env.CLEARVOID_HOME_DIR ?? homedir();
	return join(home, ".clearvoid", "roots.json");
}

export function loadRoots() {
	const home = process.env.CLEARVOID_HOME_DIR ?? homedir();
	try {
		const r = JSON.parse(readFileSync(rootsPath(), "utf8"));
		if (!Array.isArray(r.roots)) r.roots = [];
		if (!r.personalRoot) r.personalRoot = join(home, "clearvoid", "briefs");
		return r;
	} catch {
		return { version: 1, personalRoot: join(home, "clearvoid", "briefs"), roots: [] };
	}
}

/** Idempotently add a briefs dir to the registry. Returns true if it was new. */
export function registerRoot(briefsDir) {
	const roots = loadRoots();
	const abs = resolve(briefsDir);
	if (roots.roots.includes(abs) || abs === resolve(roots.personalRoot)) return false;
	roots.roots.push(abs);
	roots.roots.sort();
	mkdirSync(dirname(rootsPath()), { recursive: true });
	writeFileSync(rootsPath(), `${JSON.stringify(roots, null, 2)}\n`);
	return true;
}
