#!/usr/bin/env node
// Render one URL unit into compile substrate. Unlike md (a local file) or
// claude-code (a local JSONL), the substrate lives behind the hosted extract
// endpoint — so this is the one render script that hits the network. Cache-first:
// a fetched page is written to <rawDir>/<key> and re-used verbatim on the next run
// (a published article / video transcript doesn't change, and the canonical URL is
// the watermark). The free-source counterpart to renderMarkdown.mjs.
//
// Usage: node renderUrl.mjs <url:canonical-or-url> [--briefs-dir <writeDir>] [--raw-dir <rawDir>]
//   <url:canonical-or-url>  a full `url:<canonical>` id or a bare URL.
//   --briefs-dir <writeDir> record the watermark (canonical URL) as pending
//                           progress for finalizeState to commit — pass during compile.
//   --raw-dir <rawDir>      where the raw markdown cache lives (default <cwd>/raw).
//
// Env: CLEARVOID_EXTRACT_URL   (default the hosted extract function)
//      CLEARVOID_EXTRACT_TOKEN (optional Bearer — only needed if the endpoint is
//                               configured closed; the public endpoint is open)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordProgress, youtubeVideoId } from "./lib.mjs";

const DEFAULT_EXTRACT_URL =
	"https://kolnqincbwtmxtbswaet.supabase.co/functions/v1/extract";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 180_000; // ~3 min ceiling for the 202 → completed path

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
if (!target) {
	console.error(
		"renderUrl: usage: node renderUrl.mjs <url:canonical-or-url> [--briefs-dir <p>] [--raw-dir <p>]",
	);
	process.exit(1);
}
const briefsDir = arg("--briefs-dir");
const rawDir = resolve(arg("--raw-dir", join(process.cwd(), "raw")));

const canonical = target.replace(/^url:/, "");

// Cache key: a YouTube watch URL keys on its video id (via the shared, stricter
// youtubeVideoId in lib.mjs — same key listUrl watermarks under); any other URL on
// a filesystem-safe slug of the canonical URL. Stable across runs.
function cacheKey(u) {
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

const key = cacheKey(canonical);
const cachePath = join(rawDir, key);
// Per-source report lives in a sibling of the verbatim cache:
// raw/<key>.report.md. The agent writes it (it's LLM output); this script only
// names the target so key derivation stays in one place. Verbatim raw stays a
// pure, byte-faithful, script-managed cache — the report never lands in it.
const reportPath = join(rawDir, key.replace(/\.md$/, ".report.md"));

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// POST to the extract endpoint with the given body; throws on non-2xx that isn't
// the 202 retry path. Returns the parsed JSON.
async function postExtract(body) {
	const extractUrl = process.env.CLEARVOID_EXTRACT_URL ?? DEFAULT_EXTRACT_URL;
	// Auth is optional: the endpoint is open unless it has a token configured. Send a
	// Bearer only when CLEARVOID_EXTRACT_TOKEN is set (keeps a private deployment usable).
	const headers = { "Content-Type": "application/json" };
	const token = process.env.CLEARVOID_EXTRACT_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(extractUrl, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	let json;
	try {
		json = await res.json();
	} catch {
		json = {};
	}
	if (res.status === 200) return { status: 200, json };
	if (res.status === 202) return { status: 202, json };
	// 4xx/5xx (incl. 422 failed extraction, 401 unauthorized) — surface clearly.
	const msg = json?.error ?? `HTTP ${res.status}`;
	throw new Error(`extract endpoint error (${res.status}): ${msg}`);
}

// Fetch the URL through the extract endpoint, polling the 202 path until done.
async function extract() {
	let { status, json } = await postExtract({ url: canonical });
	const deadline = Date.now() + POLL_MAX_MS;
	while (status === 202) {
		const contentId = json?.contentId;
		if (!contentId) {
			throw new Error("extract returned 202 without a contentId to resume");
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`extract still pending after ${Math.round(POLL_MAX_MS / 1000)}s (contentId=${contentId})`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
		({ status, json } = await postExtract({ contentId }));
	}
	if (json?.status !== "completed" || typeof json.markdown !== "string") {
		throw new Error(
			`extract returned no markdown (status=${json?.status ?? "?"})`,
		);
	}
	return json;
}

// Build the small frontmatter header written above the cached body.
function frontmatter(meta) {
	const lines = ["---", "source: url"];
	const add = (k, v) => {
		if (v != null && v !== "") lines.push(`${k}: ${String(v).replace(/\n/g, " ")}`);
	};
	add("source_type", meta.source_type);
	add("url", canonical);
	add("title", meta.title);
	const author = meta.author_name ?? meta.author_username;
	add("author", author);
	add("channel_name", meta.channel_name);
	// Stable YouTube channel id — the desktop Links facet bar groups channels by
	// it (survives renames / display-name collisions), falling back to
	// channel_name. Null for non-YouTube sources and for endpoints that predate
	// it; an existing cache file just keeps grouping by name.
	add("channel_id", meta.channel_id);
	add("published_at", meta.published_at);
	// Poster frame for the desktop Links tab: YouTube thumbnail / web og:image,
	// both surfaced by the extract endpoint as og_image_url.
	add("thumbnail", meta.og_image_url);
	lines.push("---");
	return lines.join("\n");
}

// `fromCache` captured BEFORE any write — after a cache miss we write the file, so
// existsSync(cachePath) would be true at the end and wrongly read as "cached".
const fromCache = existsSync(cachePath);
let rawText;
// `meta` is only populated on a fresh fetch — its sole use is the cosmetic render
// header below. On a cache hit we don't re-parse the frontmatter we wrote; the body
// is the substrate that matters and it's recovered straight from disk.
let meta = null;
if (fromCache) {
	// Cache hit — read substrate from disk, no network.
	rawText = readFileSync(cachePath, "utf8");
} else {
	const result = await extract();
	meta = {
		source_type: result.source_type,
		title: result.title,
		author_name: result.author_name,
		author_username: result.author_username,
		channel_name: result.channel_name,
		channel_id: result.channel_id,
		og_image_url: result.og_image_url,
		published_at: result.published_at,
	};
	// Keep stamping the frontmatter header into the raw cache file — it's useful
	// provenance in the raw file (read back as `source: url`, title, author, …).
	const header = frontmatter(meta);
	rawText = `${header}\n\n${result.markdown.trim()}\n`;
	mkdirSync(rawDir, { recursive: true });
	writeFileSync(cachePath, rawText);
}

// Body for size accounting = everything after the frontmatter header.
const body = rawText.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

// A YouTube transcript body is line-prefixed with `[MM:SS]` / `[H:MM:SS]` stamps
// (see the extract endpoint's transcript formatter). The largest such stamp IS the
// video's real runtime — the only reliable length signal we have (the extract API
// returns no duration field). Surfacing it stops the agent from inventing a duration
// by eyeballing the token count, which is wildly off (a guessed "~13 min" for a 46-min
// video). Returns null for non-transcript bodies (articles/tweets have no stamps).
function transcriptRuntime(text) {
	let maxSec = -1;
	const re = /^\[(?:(\d+):)?(\d+):(\d{2})\]/gm;
	let m;
	while ((m = re.exec(text)) !== null) {
		const h = m[1] ? Number(m[1]) : 0;
		const sec = h * 3600 + Number(m[2]) * 60 + Number(m[3]);
		if (sec > maxSec) maxSec = sec;
	}
	if (maxSec < 0) return null;
	const h = Math.floor(maxSec / 3600);
	const mm = Math.floor((maxSec % 3600) / 60);
	const ss = maxSec % 60;
	return h > 0
		? `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
		: `${mm}:${String(ss).padStart(2, "0")}`;
}

// Watermark = the canonical URL, recorded the moment we have substrate. Matches
// listUrl's `url` watermark, so a finalized URL re-queues with nothing new.
if (briefsDir) recordProgress(briefsDir, `url:${canonical}`, canonical);

const runtime = transcriptRuntime(body);
const size = [
	`~${Math.ceil(body.length / 4)} tokens`,
	runtime ? `transcript runs to ${runtime}` : null,
	`${rawText.length} bytes`,
]
	.filter(Boolean)
	.join(" · ");
if (fromCache) {
	// Cache hit — no metadata reconstruction, just the marker + size.
	console.log([`# url ${canonical}`, `${size} · cached`].join("\n"));
} else {
	const sourceType = meta.source_type ?? "url";
	const author = meta.author_name ?? meta.author_username;
	console.log(
		[
			`# ${sourceType} ${canonical}`,
			[
				meta.title ? `title: ${meta.title}` : null,
				author ? `author: ${author}` : null,
				meta.published_at ? `published: ${meta.published_at}` : null,
				size,
			]
				.filter(Boolean)
				.join(" · "),
		].join("\n"),
	);
}
// Machine-readable target for the per-source report the agent writes
// (SKILL.md step 6, url sources only). Naming it here keeps the cache-key logic
// in one place; the agent Writes the report to this path.
console.log(`report-target: ${reportPath}`);
console.log(`\n${body}`);
