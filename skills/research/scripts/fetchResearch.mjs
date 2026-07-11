#!/usr/bin/env node
// The metered fetch behind `/clearvoid:research`: call the hosted Clearvoid research
// endpoint (Exa web + Grok/X discourse, server-side, the keys public users don't have)
// for a query or a specific URL, and write the returned material as compile substrate
// at raw/<key>.research.md. Then the skill runs `/clearvoid:compile research:<key>`,
// which folds this substrate into briefs + a per-source report — so research is just a
// source compile consumes, fetched here instead of in renderResearch (the endpoint call
// is the metered, money-spending step, so it lives at the skill front door). Pure Node.
//
// Usage: node fetchResearch.mjs "<query>" [--url <u>] [--cwd <p>] [--raw-dir <p>] [--days N]
//   "<query>"     freeform research topic (per-theme). Omit when researching a bare URL.
//   --url <u>     research a specific URL (per-source); enriches with the tweet for X URLs.
//   --cwd <p>     repo base (default cwd) — raw/ is resolved under its checkout root.
//   --raw-dir <p> override the raw/ dir (default <repo-or-cwd>/raw).
//   --days N      recency window passed to both lanes.
//
// Env: CLEARVOID_RESEARCH_URL   (default the hosted research function)
//      CLEARVOID_RESEARCH_TOKEN (optional Bearer — the public endpoint is open, metered
//                               by a cap + per-IP rate limit; only needed against a
//                               deployment configured gated for a paid tier)

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findRepoRoots, researchKey } from "../../compile/scripts/lib.mjs";

const DEFAULT_RESEARCH_URL =
	"https://kolnqincbwtmxtbswaet.supabase.co/functions/v1/research";

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const VALUE_FLAGS = new Set(["--url", "--cwd", "--raw-dir", "--days"]);
const positionals = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--")) {
		if (VALUE_FLAGS.has(argv[i])) i++;
		continue;
	}
	positionals.push(argv[i]);
}

const query = positionals.join(" ").trim() || undefined;
const url = arg("--url");
const cwd = resolve(arg("--cwd", process.cwd()));
const repo = findRepoRoots(cwd);
const rawDir = resolve(arg("--raw-dir", join(repo?.checkoutRoot ?? cwd, "raw")));
const daysArg = arg("--days");
const days = daysArg != null ? Number(daysArg) : undefined;

if (!query && !url) {
	console.error('fetchResearch: usage: node fetchResearch.mjs "<query>" [--url <u>]');
	process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

async function callEndpoint() {
	const endpoint = process.env.CLEARVOID_RESEARCH_URL ?? DEFAULT_RESEARCH_URL;
	const headers = { "Content-Type": "application/json" };
	const token = process.env.CLEARVOID_RESEARCH_TOKEN;
	if (token) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify({ query, url, days }),
		signal: AbortSignal.timeout(180_000),
	});
	let json;
	try {
		json = await res.json();
	} catch {
		json = {};
	}
	if (!res.ok) {
		throw new Error(
			`research endpoint error (${res.status}): ${json?.error ?? `HTTP ${res.status}`}`,
		);
	}
	return json;
}

// Build the substrate raw/<key>.research.md from the endpoint's { web, x, tweet }.
function renderSubstrate(result) {
	const subject = query ?? url;
	const sourceUrls = [
		...(result.web?.results ?? []).map((r) => r.url),
		...(result.x?.sources ?? []).map((s) => s.url),
	].filter(Boolean);

	const fm = ["---", `research_of: ${subject}`, `title: Research — ${subject}`, `generated: ${today}`];
	if (sourceUrls.length) {
		fm.push("sources:");
		for (const u of [...new Set(sourceUrls)]) fm.push(`  - ${u}`);
	}
	fm.push("---");

	const body = [];
	body.push(`# Research — ${subject}`);

	if (result.tweet?.markdown) {
		body.push("\n## The source (X)\n");
		body.push(result.tweet.markdown);
	}

	body.push("\n## Web read (Exa)\n");
	const webResults = result.web?.results ?? [];
	if (webResults.length === 0) {
		body.push("_No web results._");
	} else {
		for (const r of webResults) {
			body.push(`**${r.title || r.url}**`);
			body.push(r.url);
			if (r.publishedDate) body.push(`_${r.publishedDate}_`);
			for (const h of r.highlights ?? []) body.push(`> ${h}`);
			body.push("");
		}
	}

	body.push("\n## X discourse (Grok)\n");
	if (result.x?.report) {
		body.push(result.x.report);
		const xs = result.x.sources ?? [];
		if (xs.length) {
			body.push("\n### Sources\n");
			for (const s of xs) {
				const tail = [s.author_handle, s.date].filter(Boolean).join(" · ");
				body.push(`- **${s.title}** ${tail ? `(${tail})` : ""}`);
				body.push(`  ${s.url}${s.relevance ? ` — ${s.relevance}` : ""}`);
			}
		}
	} else {
		body.push("_No X discourse._");
	}

	if (result.errors?.length) {
		body.push("\n## Lane errors\n");
		for (const e of result.errors) body.push(`- ${e}`);
	}

	return `${fm.join("\n")}\n\n${body.join("\n")}\n`;
}

const result = await callEndpoint();
const key = researchKey({ query, url });
const substratePath = join(rawDir, `${key}.research.md`);
mkdirSync(rawDir, { recursive: true });
writeFileSync(substratePath, renderSubstrate(result));

// The skill reads these two lines: the key to hand to compile, and the path written.
console.log(`research-key: research:${key}`);
console.log(`substrate: ${substratePath}`);
