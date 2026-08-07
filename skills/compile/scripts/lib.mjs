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
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
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

// ── AI-conversation URLs (browser capture) ──────────────────────────────────
// Conversation URLs the extract endpoint cannot serve: the content sits behind a
// login/bot wall (or, for grok shares, a bare SPA shell) and only renders in a
// real browser. renderUrl routes these to the browser-capture flow
// (sources/browser-capture.md) instead of the endpoint, and listUrl re-queues
// them whenever they are explicitly named — conversations grow, and only the
// browser can see whether this one did. Shared so both scripts route identically.
// NOTE: chatgpt.com/share/ and claude.ai/share/ are deliberately NOT matched —
// those pages server-render and stay on the extract-endpoint path.
export function conversationSurface(u) {
	let parsed;
	try {
		parsed = new URL(u);
	} catch {
		return null;
	}
	const host = parsed.hostname.replace(/^www\./, "");
	const path = parsed.pathname;
	if (host === "x.com" || host === "twitter.com") {
		// Share links (/i/grok/share/<id>) and private conversation links
		// (/i/grok?conversation=<id>) both route to the browser.
		if (path.startsWith("/i/grok/share/")) return "grok";
		if (path === "/i/grok" && parsed.searchParams.has("conversation"))
			return "grok";
	}
	if (host === "grok.com" && /^\/(c|share)\//.test(path)) return "grok";
	// Plain conversations (/c/<id>) and project/GPT conversations (/g/<slug>/c/<id>).
	if (host === "chatgpt.com" && /^(\/g\/[^/]+)?\/c\//.test(path))
		return "chatgpt";
	if (host === "claude.ai" && path.startsWith("/chat/")) return "claude";
	return null;
}

// Raw-cache key for a url unit — shared by renderUrl (reads/writes the cache)
// and listUrl (checks capture existence for conversation re-queues) so the two
// derive the SAME filename. A YouTube watch URL keys on its video id; any other
// URL on a filesystem-safe slug of the canonical URL. Stable across runs.
export function urlCacheKey(u) {
	const vid = youtubeVideoId(u);
	if (vid) return `youtube-${vid}.md`;
	const slug = u
		.replace(/^https?:\/\//, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 180);
	return `${slug || "url"}.md`;
}

// ── Research source keys ──────────────────────────────────────────────────
// A `research:` unit is keyed by a filesystem-safe slug, shared by the research
// skill's fetchResearch (which WRITES raw/<key>.research.md) and compile's
// list/renderResearch (which READ it). For a per-source research pass over a URL
// the key tracks the URL (so it sits beside that URL's verbatim cache); for a
// freeform/per-theme pass the key is a slug of the topic. Returns the BARE key —
// callers append `.research.md` (substrate) or `.research.report.md` (report).
export function slugify(s, max = 180) {
	return (
		String(s)
			.toLowerCase()
			.replace(/^https?:\/\//, "")
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, max) || "research"
	);
}

export function researchKey({ query, url } = {}) {
	if (url) {
		let canonical;
		try {
			canonical = canonicalizeUrl(url);
		} catch {
			canonical = url;
		}
		const vid = youtubeVideoId(canonical);
		return vid ? `youtube-${vid}` : slugify(canonical);
	}
	return slugify(query ?? "");
}

// ── Chrome-home briefs-chat API (shared by listChat + renderChat) ───────────
// The `chat` source folds brief-primed chat threads — chrome-home's Briefs tab,
// or any server speaking the same tiny contract — into briefs. CONTEXT: the
// reference server is chrome-home (localhost:3010), ours; but the source is
// defined against the CONTRACT (GET /chat/briefs-threads, GET
// /chat/sessions/:id/markdown), not that server, so anyone running a compatible
// endpoint points CLEARVOID_CHAT_API_URL at it — exact parity with how the `url`
// source is gated by CLEARVOID_EXTRACT_URL. Both list (enumerate + watermark) and
// render (fetch one thread) hit the same base and key each thread by the SAME
// messageCount watermark, so they must derive it identically (see url.mjs pair).

export function chatApiBase() {
	return (
		process.env.CLEARVOID_CHAT_API_URL ?? "http://localhost:3010/v1/api"
	).replace(/\/+$/, "");
}

// Auth is optional (chrome-home is a local open server); send a Bearer only when
// CLEARVOID_CHAT_API_TOKEN is set, for a deployment configured closed.
function chatHeaders() {
	const token = process.env.CLEARVOID_CHAT_API_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * GET /chat/briefs-threads → the brief-primed threads with metadata only (no
 * bodies): { id, title, briefsFilter, updatedAt, messageCount, firstUserMessage }.
 * The single cheap enumeration call — list never fetches a thread body, and render
 * uses it only to resolve its thread's messageCount + title before fetching one body.
 */
export async function fetchBriefsThreads() {
	const url = `${chatApiBase()}/chat/briefs-threads`;
	const res = await fetch(url, { headers: chatHeaders() });
	if (!res.ok) {
		throw new Error(`briefs-threads → HTTP ${res.status} ${res.statusText} (${url})`);
	}
	const body = await res.json();
	return Array.isArray(body.threads) ? body.threads : [];
}

/** GET /chat/sessions/:id/markdown → the whole thread as markdown (the substrate). */
export async function fetchThreadMarkdown(id) {
	const url = `${chatApiBase()}/chat/sessions/${encodeURIComponent(id)}/markdown`;
	const res = await fetch(url, { headers: chatHeaders() });
	if (!res.ok) {
		throw new Error(`thread markdown → HTTP ${res.status} ${res.statusText} (${url})`);
	}
	return await res.text();
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
	// tags: human-curated filter axis (FORMAT.md). Canonical inline-flow form
	// `tags: [a, b, c]`; tolerate a bare comma list (with an optional trailing
	// YAML comment) and a block list (`- a` lines). Each token is unquoted, has a
	// leading `#` stripped (the contract stores bare), and empties drop. Preserved
	// by compile, never authored — surfaced so recall can select on a tag. Mirrors
	// the desktop parser (packages/desktop-core/files/briefFiles.ts), hand-locked.
	let tagTokens = [];
	// `[ \t]*` not `\s*`: an empty value must NOT swallow the newline into the
	// block-list form below. Require a non-space first char so `tags:` alone misses.
	const tagsInline = head.match(/^tags:[ \t]*(\S[^\n]*)$/m);
	if (tagsInline) {
		let inner = tagsInline[1].trim();
		if (inner.startsWith("[")) {
			const end = inner.lastIndexOf("]");
			inner = inner.slice(1, end > 0 ? end : undefined);
		} else {
			inner = inner.replace(/\s+#.*$/, ""); // drop a trailing YAML comment
		}
		tagTokens = inner.split(",");
	} else {
		const block = head.match(/^tags:[ \t]*\n((?:[ \t]+-[ \t].*\n?)+)/m);
		if (block) {
			tagTokens = block[1]
				.split("\n")
				.map((l) => l.replace(/^[ \t]+-[ \t]*/, ""));
		}
	}
	fm.tags = tagTokens
		.map((t) => t.trim().replace(/^["']|["']$/g, "").replace(/^#\s*/, ""))
		.filter(Boolean);
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

// The summary is the recall selection key: a tight 1–2-sentence distillation of
// the brief's current view (FORMAT.md target ~60 words). It regresses silently
// by accretion — an incremental compile that appends "source X adds Y" instead
// of rewriting ratchets it up, and a hot brief that many sources route into can
// balloon to thousands of words (this is exactly how the research/brain repos
// grew 500–5000-word summaries before this guard existed). A bloated summary
// degrades selection across the WHOLE repo, so the drift is worth surfacing on
// every compile. Threshold is set well above a legitimately dense summary
// (~90–100 words in practice, incl. a 3-sentence anchor brief) so this fires
// only on genuine bloat, never as style-nitpick noise on a good summary.
// CONTEXT: warning, not a hard cap — the summary is authored by the model into
// the file; a script can't compress it well. Surfaced through the list step's
// `warnings` (SKILL.md tells the agent to surface warnings), so the next compile
// that touches the brief rewrites it instead of appending to it again.
export const SUMMARY_WORD_CAP = 120;
export function summaryBloatWarnings(briefs) {
	const out = [];
	for (const b of briefs) {
		if (!b.summary) continue;
		const words = b.summary.trim().split(/\s+/).filter(Boolean).length;
		if (words <= SUMMARY_WORD_CAP) continue;
		const where = b.collection ? `${b.collection}/${b.slug}` : b.slug;
		out.push(
			`brief "${where}" has a ${words}-word summary — the summary: field is the recall selection key and must be a tight 1–2 sentences (~60 words; FORMAT.md), not a changelog. REWRITE it to the current view distilled (never append a per-source delta), or it degrades brief selection across the repo.`,
		);
	}
	return out;
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

// The follow-up flag marker (a leading ⭐ on a Next-steps item). Named so the one
// FORMAT.md contract symbol isn't a bare literal sprinkled through the parser. The
// desktop reader keeps its own copy of this (desktop-core/files/nextSteps.ts) — the
// two are deliberately separate, kept in lockstep by the FORMAT.md contract.
const FLAG_MARKER = "⭐";

/**
 * Parse the `## Next steps` task-list items out of one report's markdown. Items are
 * GFM task items `- [ ] text` / `- [x] text`; `done` reads the box, `text` is the
 * rest (tail and `[[brief]]` link kept), `raw` is the verbatim line (the mutate key).
 * A leading `⭐ ` right after the box flags the item as a follow-up (`flagged`,
 * orthogonal to done); the marker is stripped from `text`. Deliberately loose: only
 * the `## Next steps` section is scanned, a missing section yields []. A line that
 * isn't a task item (plain bullet, prose) is ignored.
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
		if (m) {
			const flagged = m[2].startsWith(FLAG_MARKER);
			const text = flagged
				? m[2].slice(FLAG_MARKER.length).replace(/^\s+/, "")
				: m[2];
			items.push({ text, done: m[1] !== " ", flagged, raw: line });
		}
	}
	return items;
}

/**
 * Every report under a repo that carries Next steps, grouped by source. Reads
 * `<repoRoot>/raw/*.report.md`, joins each item to its source via the report's
 * `report_of`/`title` frontmatter. Returns `{ sources: [{ url, title, reportPath,
 * items: [{text, done, flagged, raw}] }] }`; reports with no Next steps are omitted. Tolerant:
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
		for (const m of fm[1].matchAll(
			/-\s*((?:claude-code|md|url|research|chat):\S+)/g,
		)) {
			(map[m[1]] ??= []).push(slug);
		}
	}
	return map;
}

// ── Payload spill: full output goes to a file, stdout stays a compact stub ───
// CONTEXT: the Bash tool replaces any command output over ~30KB with a ~2KB
// preview plus a "saved to file" note (boundary measured 2026-08-05 across 184
// real compile runs: largest intact result 29.1KB, smallest truncated 29.4KB;
// see plans/active/2026-08-05-lightweight-compile.md phase 1). listSessions
// emitted 96KB in a mature repo, so the orientation index SKILL.md promises
// never reached the model, and runs recovered with greps and
// `renderSession | tail -100` — silently dropping the START of the session
// being compiled. Therefore NO list/render script pipes a large payload
// through stdout: the payload is written here and stdout carries a small stub
// naming the file. The agent Reads the file (the Read tool has no such cap).
export function writePayload(name, ext, text) {
	const dir = join(tmpdir(), "clearvoid-compile");
	mkdirSync(dir, { recursive: true });
	// Best-effort prune of stale payloads (>24h) so tmp never grows unbounded
	// on systems that don't clean their temp dir.
	const cutoff = Date.now() - 24 * 60 * 60 * 1000;
	try {
		for (const f of readdirSync(dir)) {
			try {
				const full = join(dir, f);
				if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
			} catch {
				// another process may have removed it; pruning is best-effort
			}
		}
	} catch {
		// unreadable dir — skip pruning, the write below will surface real errors
	}
	// Timestamp + pid keeps concurrent runs (and multiple renders in one run)
	// from colliding on a name.
	const path = join(dir, `${name}-${Date.now()}-${process.pid}.${ext}`);
	writeFileSync(path, text);
	return { path, lines: text.split("\n").length };
}

// ── Scope-confirmation gate ─────────────────────────────────────────────────
// CONTEXT: a compile can be far larger than the user expects. A cold start
// processes the repo's ENTIRE session history, and the user has no idea before
// it starts; SKILL.md step 3 pauses on the `confirmationGate` field this emits
// and asks before anything is rendered or spent, regardless of model. Computed
// here, deterministically, from the same queue the run will process, so the
// prompt states what will actually be processed: the queue's post-chrome-strip
// incremental `newTokens` sum, never raw `bytes` (overstates 30-300x) and
// never the total size of all sessions on disk.
// Headless callers declare themselves with CLEARVOID_ASSUME_YES=1 (then no
// gate is emitted and the run never pauses): a non-interactive run that
// stopped on the gate's question would hang forever, which is exactly the
// hazard step 3's "never wait for confirmation" rule exists to prevent.

// NOTE: trigger 2 ("large-run") is deliberately separable: delete the
// LARGE_RUN_NEW_TOKENS constant and its block in confirmationGate() to remove
// it without touching the cold-start trigger. Rationale for 150K: measured on
// the heaviest real repo (plans/active/2026-08-05-lightweight-compile.md), a
// routine incremental queue was ~23K newTokens and a full 30-day single-repo
// substrate ~372K, so 150K is ~6x the largest routine queue (never fires on a
// normal run) yet catches the months-away catch-up compile, which surprises
// the user exactly like a cold start. chars/4 underestimates markdown ~1.25-
// 1.5x, so the real volume at the threshold is higher still.
export const LARGE_RUN_NEW_TOKENS = 150_000;

/** The gate object for a list result, or null when no confirmation is needed
 *  (empty queue, CLEARVOID_ASSUME_YES=1, or a routine incremental run). */
export function confirmationGate(result) {
	if (process.env.CLEARVOID_ASSUME_YES === "1") return null;
	const queue = result.queue ?? [];
	if (queue.length === 0) return null;
	const newTokens = queue.reduce((a, u) => a + (u.newTokens ?? 0), 0);
	const dates = queue
		.map((u) => u.startedAt)
		.filter(Boolean)
		.sort();
	const scope = {
		units: queue.length,
		newTokens,
		...(dates.length
			? {
					dateSpan: {
						from: dates[0].slice(0, 10),
						to: dates[dates.length - 1].slice(0, 10),
					},
				}
			: {}),
		note:
			"Confirmation required BEFORE rendering or spending anything: show the user these numbers " +
			"(units, date span, newTokens as an approximate floor) and wait for an explicit yes, per SKILL.md step 3. " +
			"Headless callers suppress this gate with CLEARVOID_ASSUME_YES=1.",
	};
	// Trigger 1: cold start, i.e. this run would create the repo's first slate of briefs.
	if ((result.briefs ?? []).length === 0) {
		return { trigger: "cold-start", ...scope };
	}
	// Trigger 2: an unusually large run even though briefs exist (see the
	// LARGE_RUN_NEW_TOKENS comment above; delete this block to remove trigger 2).
	if (newTokens >= LARGE_RUN_NEW_TOKENS) {
		return { trigger: "large-run", threshold: LARGE_RUN_NEW_TOKENS, ...scope };
	}
	return null;
}

/**
 * Emit a list script's result: the full JSON (contract unchanged) goes to a
 * payload file, stdout gets a compact self-describing stub well under the Bash
 * cap. The stub deliberately lacks what a run needs to proceed — the briefs[]
 * orientation index and the per-unit fields (compiledLines, paths, titles) —
 * so an agent that skips Reading the payload cannot silently work from
 * partial data; it simply doesn't have the inputs.
 */
export function emitListResult(name, result) {
	const { path, lines } = writePayload(
		name,
		"json",
		`${JSON.stringify(result, null, 2)}\n`,
	);
	const queue = result.queue ?? [];
	const warnings = result.warnings ?? [];
	const gate = confirmationGate(result);
	const stub = {
		stub: true,
		payloadFile: path,
		payloadLines: lines,
		...(gate ? { confirmationGate: gate } : {}),
		note:
			`STUB ONLY — not the queue. The full ${name} output (the briefs[] orientation index plus complete queue entries) is at payloadFile. ` +
			`Read that ENTIRE file with the Read tool (all ${lines} lines; continue with offset if one Read does not reach the end) before doing anything else. ` +
			`Do not grep, sample, head, or tail it, and do not proceed from this stub alone.`,
		source: result.source ?? "claude-code",
		briefsRoot: result.briefsRoot,
		newBriefsDir: result.newBriefsDir,
		...(result.rawDir !== undefined ? { rawDir: result.rawDir } : {}),
		...(result.runReportTarget !== undefined
			? { runReportTarget: result.runReportTarget }
			: {}),
		generatedAt: result.generatedAt,
		briefCount: (result.briefs ?? []).length,
		queueCount: queue.length,
		queueIds: queue.slice(0, 20).map((u) => u.id),
		...(queue.length > 20 ? { queueIdsOmitted: queue.length - 20 } : {}),
		totalNewTokens: queue.reduce((a, u) => a + (u.newTokens ?? 0), 0),
		upToDateCount: result.upToDateCount,
		...(result.ignoredCount !== undefined
			? { ignoredCount: result.ignoredCount }
			: {}),
		...(result.matched !== undefined ? { matched: result.matched } : {}),
		errors: result.errors ?? [],
		warningCount: warnings.length,
		// First few warnings ride in the stub so a seeding warning is visible
		// immediately; the full list is always in the payload.
		warnings: warnings.slice(0, 5),
	};
	console.log(JSON.stringify(stub, null, 2));
}

/**
 * The stdout tail every render script prints instead of the substrate body:
 * a machine-readable pointer plus an instruction that makes a partial read
 * detectable (the line count) and a silent skip loud.
 */
export function substrateNote(path, lines) {
	return [
		`substrate: ${path}`,
		`substrate-lines: ${lines}`,
		`NOTE: the rendered substrate is NOT in this output (Bash stdout truncates over ~30KB). ` +
			`Read the ENTIRE substrate file with the Read tool — all ${lines} lines, continuing with offset if one Read does not reach the end — ` +
			`or hand it whole to an extraction sub-agent. Never grep, head, or tail it: a partial read silently drops part of this unit.`,
	].join("\n");
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
