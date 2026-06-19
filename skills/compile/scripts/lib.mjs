// Shared JSONL parsing + chrome-stripping for the clearvoid-compile scripts.
// Vendored from packages/lib/claudeSessions/{parseJsonl,chrome,buildSynthesisPayload}.ts —
// deliberately standalone (plugins are cached self-contained and cannot reach the monorepo).
// NOTE: keep semantics in lockstep with the originals; re-derive the chrome tag list
// empirically when output looks dirty (scan user turns for leading `<tag>`).

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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
 * Collapse a path inside a worktree (`<root>/.claude/worktrees/<name>/...`) back to
 * the equivalent path under the repo family root, e.g. `<root>/.claude/worktrees/foo/
 * briefs` → `<root>/briefs`. Worktrees are part of the repo family: briefs compiled on
 * a worktree branch belong to the repo, so the registry and the read-side dedup must
 * treat the worktree path and the main checkout path as ONE root, never two. A path
 * not inside a worktree is returned unchanged (resolved).
 */
export function collapseWorktreePath(p) {
	const abs = resolve(p);
	const m = abs.match(/^(.*?)\/\.claude\/worktrees\/[^/]+(\/.*)?$/);
	return m ? resolve(m[1] + (m[2] ?? "")) : abs;
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
	return { checkoutRoot: dir, matchRoot: collapseWorktreePath(dir) };
}

/**
 * Where briefs get written — the destination axis, orthogonal to the source.
 * Explicit `--briefs-dir` wins; otherwise `<cwd>/briefs`. No personalRoot, no git:
 * a free source (md) writes `briefs/` wherever it is run; a repo-bound source
 * (claude-code) resolves cwd → repo root before handing the root in here.
 */
export function resolveDestination(cwd, explicitBriefsDir) {
	return resolve(explicitBriefsDir ?? join(cwd, "briefs"));
}

/**
 * The write dir for a `to:<path>` collection — a subfolder (any depth) of the
 * briefs root. Collections are the grouping axis: compile reads/writes/watermarks
 * this dir (flat), while `registerRoot` records the *root* so the read side
 * (context skill, desktop app) recurses and sees every collection. No `to:` →
 * write dir IS the root (the default/top-level collection). Guards against `..`
 * escaping the root.
 */
export function resolveCollection(briefsRoot, toPath) {
	const root = resolve(briefsRoot);
	if (!toPath) return root;
	const sub = String(toPath).replace(/\\/g, "/").replace(/^\/+/, "");
	const writeDir = resolve(root, sub);
	if (writeDir !== root && !writeDir.startsWith(root + sep)) {
		throw new Error(`to: path escapes the briefs root: ${toPath}`);
	}
	return writeDir;
}

/** Content-addressed watermark for hash-based sources (md): `sha256:<hex>`. */
export function sha256(text) {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

// ── URL helpers (shared by listUrl + renderUrl) ─────────────────────────────
// Both the `url` source's enumeration (listUrl) and its render+cache (renderUrl)
// must derive the SAME video id and canonical URL — otherwise the watermark key
// and the raw cache key (`youtube-<id>.md`) diverge. These live here so the two
// scripts key identically.

/**
 * Pull a YouTube video id from any of its URL shapes (watch?v=, youtu.be/,
 * /embed/, /shorts/) — null if it's not a YouTube video URL. Validates the
 * 11-char id shape so a non-video YouTube page never produces a bogus key.
 */
export function youtubeVideoId(u) {
	let parsed;
	try {
		parsed = new URL(u);
	} catch {
		return null;
	}
	const host = parsed.hostname.replace(/^www\./, "");
	if (host === "youtu.be") {
		const id = parsed.pathname.slice(1).split("/")[0];
		return /^[\w-]{11}$/.test(id) ? id : null;
	}
	if (host === "youtube.com" || host === "m.youtube.com") {
		const v = parsed.searchParams.get("v");
		if (v && /^[\w-]{11}$/.test(v)) return v;
		const m = parsed.pathname.match(/^\/(?:embed|shorts)\/([\w-]{11})/);
		if (m) return m[1];
	}
	return null;
}

/** The canonical watch URL for a YouTube video id. */
export function youtubeWatchUrl(id) {
	return `https://www.youtube.com/watch?v=${id}`;
}

// Canonicalize a URL to a stable id key. YouTube videos collapse to the canonical
// watch URL; everything else gets light normalization (lowercased host, no hash,
// no trailing slash, no UTM/tracking params). Deliberately simple — the extract
// endpoint canonicalizes server-side too; this just keeps the watermark stable.
const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_eid$|mc_cid$|ref$|ref_src$)/i;
export function canonicalizeUrl(raw) {
	const vid = youtubeVideoId(raw);
	if (vid) return youtubeWatchUrl(vid);
	const parsed = new URL(raw); // throws on garbage — caller catches
	parsed.hostname = parsed.hostname.toLowerCase();
	parsed.hash = "";
	const keep = [];
	for (const [k, v] of parsed.searchParams) {
		if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
	}
	parsed.search = "";
	for (const [k, v] of keep) parsed.searchParams.append(k, v);
	let out = parsed.toString();
	// Drop a lone trailing slash on the path (but keep "/" for a bare host).
	out = out.replace(/\/(\?|$)/, "$1").replace(/^(https?:\/\/[^/]+)$/, "$1/");
	return out;
}

// Recursive walk; skips dotfiles/dotdirs (.git, .clearvoid, etc.). `predicate`
// decides which files to collect. Shared by listMarkdown (any .md) and the
// context skill's resolveRoots (briefs: .md minus README.md).
export function walk(dir, predicate, acc = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return acc;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const full = join(dir, e.name);
		if (e.isDirectory()) walk(full, predicate, acc);
		else if (e.isFile() && predicate(full)) acc.push(full);
	}
	return acc;
}

// ── Cross-project roots registry: ~/.clearvoid/roots.json ──────────────────
// Shared by every client (compile, context, the desktop workbench). Read-side
// tools aggregate across it; compile only writes where it was pointed.

export function rootsPath() {
	const home = process.env.CLEARVOID_HOME_DIR ?? homedir();
	return join(home, ".clearvoid", "roots.json");
}

// Schema is flat: { version, roots: [...] }. There is no personalRoot — the
// destination is always explicit (cwd or --briefs-dir), so a repo-less "personal"
// home has no job. A legacy roots.json with a personalRoot key self-heals: we drop
// it on the next write.
export function loadRoots() {
	try {
		const r = JSON.parse(readFileSync(rootsPath(), "utf8"));
		const roots = Array.isArray(r.roots) ? r.roots : [];
		return { version: r.version ?? 1, roots };
	} catch {
		return { version: 1, roots: [] };
	}
}

/**
 * Idempotently add a briefs dir to the registry. Returns true if it was new.
 * A worktree's briefs path collapses to the repo family root first, so compiling
 * from a worktree never leaves an ephemeral `.../worktrees/<name>/briefs` entry that
 * dangles once the worktree is cleaned up — one stable entry per repo.
 */
export function registerRoot(briefsDir) {
	const roots = loadRoots();
	const abs = collapseWorktreePath(briefsDir);
	if (roots.roots.includes(abs)) return false;
	roots.roots.push(abs);
	roots.roots.sort();
	mkdirSync(dirname(rootsPath()), { recursive: true });
	writeFileSync(rootsPath(), `${JSON.stringify(roots, null, 2)}\n`);
	return true;
}

/**
 * Minimal brief frontmatter read: the scalar fields + the first line of a
 * `framing: |` block. There is no generated index — the context skill calls
 * this over the brief files directly to build its selection surface.
 */
export function readBriefFrontmatter(text) {
	const m = text.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	const head = m[1];
	const fm = {};
	for (const key of ["title", "summary", "updated", "created"]) {
		const v = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
		if (v) fm[key] = v[1].trim();
	}
	const block = head.match(/^framing:\s*\|\s*\n((?:[ \t]+.*\n?)+)/m);
	if (block) {
		fm.framing = block[1]
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.join(" ");
	} else {
		const inline = head.match(/^framing:\s*(.+)$/m);
		if (inline) fm.framing = inline[1].trim();
	}
	return fm;
}

// ── The watermark: progress.json (pending) → state.json (committed) ──────────
// CONTEXT: watermarking used to be a per-unit `updateState` call the agent ran
// after folding each session in. It depended on agent discipline and was
// silently skipped (a compile would fold 11 sessions into briefs but watermark
// only 6, so the other 5 re-queued forever). It is now deterministic: the render
// scripts record what they actually rendered into progress.json as a side
// effect (given --briefs-dir), and `finalizeState` folds that into state.json
// once — run as the end-of-run wrap-up, so the "only watermark what was folded
// in" guarantee holds (a crash before finalize commits nothing and the whole
// queue re-runs, which is bounded re-work, never lost content).

export function statePath(briefsDir) {
	return join(briefsDir, ".clearvoid", "state.json");
}

export function loadState(briefsDir) {
	try {
		const s = JSON.parse(readFileSync(statePath(briefsDir), "utf8"));
		if (!s.sources) s.sources = {};
		return s;
	} catch {
		return { version: 1, sources: {} };
	}
}

export function progressPath(briefsDir) {
	return join(briefsDir, ".clearvoid", "progress.json");
}

/** Record a rendered unit's watermark as pending. Numeric line offsets advance
 *  monotonically (max); hash tokens (md) overwrite. Safe to call repeatedly. */
export function recordProgress(briefsDir, session, units) {
	const p = progressPath(briefsDir);
	let pending = {};
	try {
		pending = JSON.parse(readFileSync(p, "utf8"));
	} catch {
		// no pending file yet
	}
	const prev = pending[session];
	pending[session] =
		typeof units === "number" && typeof prev === "number"
			? Math.max(prev, units)
			: units;
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(pending, null, 2)}\n`);
}

// session id → [brief slug] reverse map, scanned from the briefs' `sources:`
// frontmatter. The forward map (brief → sources) is canonical in frontmatter;
// state.json keeps this reverse map as convenience provenance.
function sessionBriefMap(briefsDir) {
	const map = {};
	let files = [];
	try {
		files = readdirSync(briefsDir).filter(
			(f) => f.endsWith(".md") && f !== "README.md",
		);
	} catch {
		return map;
	}
	for (const f of files) {
		let text;
		try {
			text = readFileSync(join(briefsDir, f), "utf8");
		} catch {
			continue;
		}
		const fm = text.match(/^---\n([\s\S]*?)\n---/);
		if (!fm) continue;
		const slug = f.replace(/\.md$/, "");
		for (const m of fm[1].matchAll(/-\s*((?:claude-code|md):\S+)/g)) {
			(map[m[1]] ??= []).push(slug);
		}
	}
	return map;
}

/** Fold pending progress into the committed watermark, then clear it. Returns
 *  the list of session ids committed. Idempotent: nothing pending → no-op. */
export function commitProgress(briefsDir) {
	const p = progressPath(briefsDir);
	let pending;
	try {
		pending = JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return [];
	}
	const sessions = Object.keys(pending);
	if (sessions.length === 0) {
		rmSync(p, { force: true });
		return [];
	}
	const state = loadState(briefsDir);
	const touched = sessionBriefMap(briefsDir);
	const at = new Date().toISOString();
	for (const id of sessions) {
		const prev = state.sources[id];
		state.sources[id] = {
			units: pending[id],
			compiledAt: at,
			briefs: [
				...new Set([...(prev?.briefs ?? []), ...(touched[id] ?? [])]),
			].sort(),
		};
	}
	mkdirSync(dirname(statePath(briefsDir)), { recursive: true });
	writeFileSync(statePath(briefsDir), `${JSON.stringify(state, null, 2)}\n`);
	rmSync(p, { force: true });
	return sessions;
}
