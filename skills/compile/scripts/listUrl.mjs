#!/usr/bin/env node
// The `url:` source front-end: enumerate URL units (an article, tweet, or YouTube
// video — or a whole channel's recent videos) against the briefs watermark. The
// second free source after `md`. Pure Node, no deps. JSON on stdout.
//
// Unlike md/claude-code, list does NOT read the unit's content — it can't, the
// substrate lives behind the hosted extract endpoint. So it only canonicalizes the
// selectors and compares the canonical URL (a stable watermark — a published page
// or a video transcript doesn't change) against state.json. Fetching happens in
// renderUrl. title/firstMessage stay the URL/video id until then; newTokens is 0
// (substrate size is unknown pre-fetch).
//
// Usage: node listUrl.mjs <urlOrChannel...> [--cwd <p>] [--briefs-dir <p>] [--to <p>]
//   <urlOrChannel>  an article/tweet/YouTube watch URL, multiple URLs, OR a channel
//                   ref: channel:<UC...-or-url>, a youtube.com/@handle or /channel/UC...
//                   URL (resolved to its latest videos via the RSS feed).
//   --cwd           base for destination resolution (default cwd)
//   --briefs-dir    destination root override; default is <cwd>/briefs
//   --to            collection subfolder of the briefs root (resolveCollection)

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	canonicalizeUrl,
	findRepoRoots,
	loadBriefsIndex,
	summaryBloatWarnings,
	loadRoots,
	resolveCollection,
	resolveDestination,
	youtubeVideoId,
	youtubeWatchUrl,
} from "./lib.mjs";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cwd = resolve(arg("--cwd", process.cwd()));
const briefsRoot = resolveDestination(cwd, arg("--briefs-dir"));
// Orientation, queue, and watermark key off briefsRoot (one pool per repo);
// newBriefsDir is only where NEW briefs from this run are filed (collections are
// folders, not walls). No `to:` → newBriefsDir is the root.
const newBriefsDir = resolveCollection(briefsRoot, arg("--to"));
const repo = findRepoRoots(cwd);
// raw cache is repo-rooted (a worktree shares its checkout's raw/), falling back
// to cwd when not in a repo — mirrors where renderUrl expects it.
const rawDir = join(repo?.checkoutRoot ?? cwd, "raw");

// Positional selectors: everything that isn't a flag or a flag's value.
const VALUE_FLAGS = new Set(["--cwd", "--briefs-dir", "--to"]);
const selectors = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--")) {
		if (VALUE_FLAGS.has(argv[i])) i++; // skip its value
		continue;
	}
	selectors.push(argv[i]);
}

if (selectors.length === 0) {
	console.error(
		"listUrl: usage: node listUrl.mjs <urlOrChannel...> [--cwd <p>] [--briefs-dir <p>] [--to <p>]",
	);
	process.exit(1);
}

const errors = [];
const warnings = [];

// youtubeVideoId + canonicalizeUrl live in lib.mjs (shared with renderUrl, so the
// watermark key and the raw cache key are derived identically).

// ── Channel feed (P5) ────────────────────────────────────────────────────────
// Resolve a channel selector to its latest video ids via the public RSS feed
// (no API key, returns ~15 newest). Accepts: a raw UC... id, a /channel/UC... URL,
// or a /@handle (or any youtube page) whose HTML carries "channelId":"UC...".

function channelIdFromSelector(sel) {
	// Bare channel id.
	if (/^UC[\w-]{22}$/.test(sel)) return sel;
	let parsed;
	try {
		parsed = new URL(sel);
	} catch {
		return null;
	}
	const m = parsed.pathname.match(/\/channel\/(UC[\w-]{22})/);
	return m ? m[1] : null;
}

async function resolveChannelId(sel) {
	const direct = channelIdFromSelector(sel);
	if (direct) return direct;
	// A /@handle or other channel page — fetch the HTML and scrape the channelId.
	let pageUrl = sel;
	if (!/^https?:\/\//.test(sel)) {
		// `channel:@handle` or `channel:Foo` → a youtube.com URL guess.
		pageUrl = sel.startsWith("@")
			? `https://www.youtube.com/${sel}`
			: `https://www.youtube.com/@${sel}`;
	}
	const res = await fetch(pageUrl, {
		headers: { "user-agent": "Mozilla/5.0 (clearvoid-compile)" },
	});
	if (!res.ok) throw new Error(`channel page ${pageUrl} → HTTP ${res.status}`);
	const html = await res.text();
	// CONTEXT: externalId first — it is always the page OWNER's id, while the
	// first "channelId" match in the HTML can be a featured/related channel
	// (a @t3dotgg lookup once resolved to the owner's secondary channel that way).
	const m =
		html.match(/"externalId":"(UC[\w-]{22})"/) ??
		html.match(/"channelId":"(UC[\w-]{22})"/) ??
		html.match(/channel\/(UC[\w-]{22})/);
	if (!m) throw new Error(`could not find channelId in ${pageUrl}`);
	return m[1];
}

async function channelVideoUrls(channelId) {
	const feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
	const res = await fetch(feed);
	if (!res.ok) throw new Error(`channel feed ${feed} → HTTP ${res.status}`);
	const xml = await res.text();
	const ids = [...xml.matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map(
		(m) => m[1],
	);
	// FRAGILE: the RSS feed caps at ~15 newest videos — there's no pagination on
	// it. Going deeper needs the YouTube Data API (key + quota), not built here.
	warnings.push(
		`channel ${channelId}: RSS feed returns only the latest ${ids.length} videos (cap ~15). ` +
			`Older videos require the YouTube Data API (not implemented) — re-run later to pick up new uploads.`,
	);
	return ids.map((id) => youtubeWatchUrl(id));
}

function isChannelSelector(sel) {
	if (sel.startsWith("channel:")) return true;
	if (/^UC[\w-]{22}$/.test(sel)) return true;
	try {
		const p = new URL(sel);
		const host = p.hostname.replace(/^www\./, "");
		if (host !== "youtube.com" && host !== "m.youtube.com") return false;
		// A channel landing page (no video id) — /@handle, /channel/UC..., /c/...,
		// /user/... — counts as a channel; a watch/shorts/embed URL does not.
		if (youtubeVideoId(sel)) return false;
		return /^\/(channel\/|@|c\/|user\/)/.test(p.pathname);
	} catch {
		return false;
	}
}

// Expand every selector into canonical URLs (channels fan out to video URLs).
async function expandSelector(rawSel) {
	if (isChannelSelector(rawSel)) {
		const ref = rawSel.replace(/^channel:/, "");
		try {
			const channelId = await resolveChannelId(ref);
			const urls = await channelVideoUrls(channelId);
			return urls; // already canonical watch URLs
		} catch (e) {
			errors.push(`channel ${rawSel}: ${e.message}`);
			return [];
		}
	}
	try {
		return [canonicalizeUrl(rawSel)];
	} catch {
		errors.push(`invalid url: ${rawSel}`);
		return [];
	}
}

// Channel selectors each fan out over the network (RSS + page scrape); resolve all
// selectors concurrently and flatten in selector order. errors/warnings pushed
// inside the async callbacks may interleave — fine, they're sets, not positional.
const resolved = await Promise.all(selectors.map(expandSelector));
const urls = [...new Set(resolved.flat())].sort();

// state.json keyed by source-namespaced id; url ids carry the canonical URL.
let state = { version: 1, sources: {} };
try {
	state = JSON.parse(
		readFileSync(join(briefsRoot, ".clearvoid", "state.json"), "utf8"),
	);
	if (!state.sources) state.sources = {};
} catch {
	// fresh destination
}

const queue = [];
const upToDate = [];
for (const url of urls) {
	const id = `url:${url}`;
	// Watermark IS the canonical URL string — stable, so a once-compiled URL never
	// re-queues. (A page's content can drift, but we treat the URL as the unit;
	// re-compiling a changed page is an explicit re-run, not auto-detected.)
	const watermark = url;
	const prevWatermark = state.sources?.[id]?.units ?? null;
	if (prevWatermark != null) {
		upToDate.push({ id, watermark });
		continue;
	}
	const vid = youtubeVideoId(url);
	queue.push({
		id,
		url,
		// title/firstMessage are placeholders until renderUrl fetches the content —
		// list never hits the network.
		title: vid ? `YouTube ${vid}` : url,
		firstMessage: url,
		// Substrate size is unknown pre-fetch (content lives behind the extract
		// endpoint), so newTokens is 0 here. renderUrl reports the real size.
		newTokens: 0,
		current: false,
		watermark,
		prevWatermark,
	});
}

// Loud warning: about to seed a brand-new briefs/ in a place with no git history
// and no prior registration. Can't block (non-interactive runs hang on prompts),
// so it rides in the output for the SKILL to surface — same logic as listMarkdown.
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

console.log(
	JSON.stringify(
		{
			source: "url",
			cwd,
			briefsRoot,
			newBriefsDir,
			rawDir,
			generatedAt: new Date().toISOString(),
			briefs: briefsIndex,
			queue,
			upToDateCount: upToDate.length,
			matched: urls.length,
			errors,
			warnings,
		},
		null,
		2,
	),
);
