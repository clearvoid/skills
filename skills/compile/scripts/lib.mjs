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
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

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
 * Canonical identity of a briefs root for equality: collapse worktree paths to the
 * family root, then resolve symlinks. FRAGILE: on macOS the same repo reaches us under
 * both `/var/folders/...` and `/private/var/folders/...` (the agent's cwd resolves the
 * /var → /private symlink, our cwd doesn't), so a string compare would treat one repo
 * as two and fail to dedup the current repo out of the registry. realpath collapses
 * both spellings; falls back to the collapsed path when the dir doesn't exist (a
 * registered repo whose briefs/ was since deleted).
 */
export function canonicalRoot(p) {
	const collapsed = collapseWorktreePath(p);
	try {
		return realpathSync(collapsed);
	} catch {
		return collapsed;
	}
}

/**
 * Display name for a briefs root: the repo folder that contains `briefs/`
 * (`/x/brain/briefs` → `brain`). Stable across machines, so it is the portable,
 * commit-safe way to name another repo in a context include/exclude list. Mirrors
 * the desktop viewer's `label` (basename of the briefs dir's parent).
 */
export function rootDisplayName(briefsDir) {
	return basename(dirname(resolve(briefsDir))) || resolve(briefsDir);
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
 * The filing dir for a `to:<path>` collection — a subfolder (any depth) of the
 * briefs root where NEW briefs from this run land. Collections are folders, not
 * walls: orientation, the queue, and the watermark all key off the briefs ROOT
 * (one pool per repo), and a run may update an existing brief in any collection.
 * `to:` only sets where freshly-created briefs are filed. No `to:` → new briefs
 * land at the root (top-level). Guards against `..` escaping the root.
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
// recall skill's resolveRoots (briefs: .md minus README.md).
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

// ── Context scope config: which OTHER repos a session pulls in ─────────────
// Two optional, layered files (defaults work with zero config):
//   global  ~/.clearvoid/config.json        { "context": { "scope": "repo" | "all" } }
//   per-repo <briefsDir>/.clearvoid/config.json
//       { "context": { "scope"?, "include": [...], "exclude": [...] } }
// Only the READ side (recall skill) consults these — the desktop viewer stays
// omniscient and compile never reads them. Default scope is "repo" (isolation):
// a session loads only its own repo's briefs unless widened. Per-repo overrides
// global; exclude always wins over include/scope. Include/exclude entries name a
// repo by display name (`brain`) — portable, commit-safe — or by an absolute/`~`
// path to the briefs dir or the repo dir.

export function globalConfigPath() {
	const home = process.env.CLEARVOID_HOME_DIR ?? homedir();
	return join(home, ".clearvoid", "config.json");
}

export function loadGlobalConfig() {
	try {
		return JSON.parse(readFileSync(globalConfigPath(), "utf8"));
	} catch {
		return {};
	}
}

export function repoConfigPath(briefsDir) {
	return join(briefsDir, ".clearvoid", "config.json");
}

export function loadRepoConfig(briefsDir) {
	try {
		return JSON.parse(readFileSync(repoConfigPath(briefsDir), "utf8"));
	} catch {
		return {};
	}
}

function expandHome(p) {
	if (p === "~" || p.startsWith("~/")) {
		return join(homedir(), p.slice(1));
	}
	return p;
}

/**
 * Does an include/exclude entry refer to this briefs root? Matches by display
 * name (`brain`), or — when the entry looks like a path — by the resolved briefs
 * dir or its parent repo dir. Worktree paths collapse to the family root first so
 * a name/path match is stable regardless of which checkout is registered.
 */
export function matchesRootEntry(entry, briefsDir) {
	if (typeof entry !== "string") return false;
	const e = entry.trim();
	if (!e) return false;
	const root = canonicalRoot(briefsDir);
	if (e === rootDisplayName(root)) return true;
	if (e.includes("/") || e.startsWith("~") || e.startsWith(".")) {
		const abs = canonicalRoot(resolve(expandHome(e)));
		if (abs === root) return true;
		if (canonicalRoot(join(resolve(expandHome(e)), "briefs")) === root) return true;
	}
	return false;
}

/**
 * Resolve the effective context scope for a session sitting in `currentBriefsDir`.
 * Returns { scope, include, exclude } with per-repo overriding global and sane
 * defaults (scope "repo", empty lists).
 */
export function resolveContextScope(currentBriefsDir) {
	const global = loadGlobalConfig();
	const repo = currentBriefsDir ? loadRepoConfig(currentBriefsDir) : {};
	const gctx = global.context ?? {};
	const rctx = repo.context ?? {};
	return {
		scope: rctx.scope ?? gctx.scope ?? "repo",
		include: Array.isArray(rctx.include) ? rctx.include : [],
		exclude: Array.isArray(rctx.exclude) ? rctx.exclude : [],
	};
}

/**
 * Minimal brief frontmatter read: the scalar fields + the first line of a
 * `framing: |` block. There is no generated index — the recall skill calls
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
	// anchor: true marks a load-bearing brief recall always loads (in full) and
	// weights first; compile preserves it but never authors it. Boolean.
	fm.anchor = /^anchor:\s*true\s*$/m.test(head);
	return fm;
}

/**
 * The orientation index: every brief in the write dir, each with its framing +
 * summary, so the `list` step returns it alongside the queue and the compiling
 * agent has every framing in context before it clusters.
 *
 * CONTEXT: orientation (step 1 — "read every existing brief's framing before
 * clustering") used to be a prose instruction in SKILL.md, and like the watermark
 * before it (see the progress.json note below) it depended on agent discipline and
 * degraded silently: the model would grep/sample a keyword subset, miss a recurring
 * thread that lived only inside another brief's body, and mint a redundant
 * single-source brief. Making it a deterministic script output guarantees every
 * framing+summary is in context on every run — the model can't skip the index
 * because it rides in with the queue it already needs. Always called with the
 * briefs ROOT, so orientation is global: every brief across every collection is
 * in context before clustering (collections are folders, not walls). Skips
 * `.clearvoid/` (walk drops dot-dirs) and README.md.
 */
export function loadBriefsIndex(briefsRoot) {
	const files = walk(
		briefsRoot,
		(f) => f.endsWith(".md") && basename(f) !== "README.md",
	);
	const briefs = [];
	for (const file of files) {
		let fm;
		try {
			fm = readBriefFrontmatter(readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		if (!fm) continue;
		const rel = relative(briefsRoot, file);
		const collection = dirname(rel) === "." ? "" : dirname(rel);
		briefs.push({
			slug: basename(file, ".md"),
			collection,
			title: fm.title ?? null,
			summary: fm.summary ?? null,
			framing: fm.framing ?? null,
			updated: fm.updated ?? null,
		});
	}
	briefs.sort(
		(a, b) =>
			(b.updated ?? "").localeCompare(a.updated ?? "") ||
			a.slug.localeCompare(b.slug),
	);
	return briefs;
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

// ── Next steps: the `## Next steps` section of each per-source report ─────────
// Next steps live IN the report that raised them (raw/<key>.report.md), as GFM
// task-list items under a `## Next steps` heading — one list, no follow-ups/actions
// split. The backlog is a DERIVED view: scan every report's Next steps and group by
// source, so each item keeps the provenance the old flat central file lost. There is
// no central follow-ups.md anymore. URL/source-only — sessions emit no backlog.

/** A report's raw cache lives at <repoRoot>/raw/; reports are its `*.report.md`
 *  siblings. briefsDir is `<repoRoot>/briefs`, so the repo root is its parent. */
export function rawDirForBriefsDir(briefsDir) {
	return join(dirname(resolve(briefsDir)), "raw");
}

/**
 * Parse the `## Next steps` task-list items out of one report's markdown. Items are
 * GFM task items `- [ ] text` / `- [x] text`; `done` reads the box, `text` is the
 * rest (tail and `[[brief]]` link kept), `raw` is the verbatim line (the mutate key).
 * Deliberately loose: only the `## Next steps` section is scanned, a missing section
 * yields []. A line that isn't a task item (plain bullet, prose) is ignored.
 */
export function parseNextSteps(reportText) {
	const items = [];
	let inSection = false;
	for (const line of reportText.split("\n")) {
		const h = line.match(/^##\s+(.+?)\s*$/);
		if (h) {
			inSection = h[1].trim().toLowerCase() === "next steps";
			continue;
		}
		if (!inSection) continue;
		const m = line.match(/^-\s+\[([ xX])\]\s+(.*\S)\s*$/);
		if (m) items.push({ text: m[2], done: m[1] !== " ", raw: line });
	}
	return items;
}

/**
 * Every report under a repo that carries Next steps, grouped by source. Reads
 * `<repoRoot>/raw/*.report.md`, joins each item to its source via the report's
 * `report_of`/`title` frontmatter. Returns `{ sources: [{ url, title, reportPath,
 * items: [{text, done, raw}] }] }`; reports with no Next steps are omitted. Tolerant:
 * a missing raw dir or unreadable file degrades to empty, never throws.
 */
export function loadNextSteps(briefsDir) {
	const rawDir = rawDirForBriefsDir(briefsDir);
	let entries;
	try {
		entries = readdirSync(rawDir, { withFileTypes: true });
	} catch {
		return { sources: [] };
	}
	const sources = [];
	for (const e of entries) {
		if (!e.isFile() || !e.name.endsWith(".report.md")) continue;
		let text;
		try {
			text = readFileSync(join(rawDir, e.name), "utf8");
		} catch {
			continue;
		}
		const items = parseNextSteps(text);
		if (items.length === 0) continue;
		const head = text.match(/^---\n([\s\S]*?)\n---/);
		const fm = head ? head[1] : "";
		const url = (fm.match(/^report_of:\s*(.+)$/m)?.[1] ?? "").trim();
		const title = (fm.match(/^title:\s*(.+)$/m)?.[1] ?? "").trim();
		sources.push({
			url,
			title: title || url || e.name.replace(/\.report\.md$/, ""),
			reportPath: join(rawDir, e.name),
			items,
		});
	}
	sources.sort((a, b) => a.title.localeCompare(b.title));
	return { sources };
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

// source id → [brief slug] reverse map, scanned from the briefs' `sources:`
// frontmatter. The forward map (brief → sources) is canonical in frontmatter;
// state.json keeps this reverse map as convenience provenance. Recurses the briefs
// root (collections are folders, not walls — a source can produce briefs in any
// collection), skipping dot-dirs (`.clearvoid/`) and README.md via `walk`.
function sessionBriefMap(briefsDir) {
	const map = {};
	const files = walk(
		briefsDir,
		(f) => f.endsWith(".md") && basename(f) !== "README.md",
	);
	for (const file of files) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const fm = text.match(/^---\n([\s\S]*?)\n---/);
		if (!fm) continue;
		const slug = basename(file, ".md");
		for (const m of fm[1].matchAll(/-\s*((?:claude-code|md|url):\S+)/g)) {
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
