# Source module: URL (`url:`)

A **free** source that turns any URL into clean markdown via the hosted extract endpoint — an article, a tweet/thread, or a YouTube video (transcript). No repo required; you compile a URL into briefs wherever you run. Read once before the first URL compile. The interface this satisfies is in `sources/README.md`.

## Selecting it

`/clearvoid:compile url:<selector> [emphasis]`. The leading `url:` token selects this source; the rest of the directive is emphasis (see the SKILL's Directive section). `<selector>` is one of:

- a single URL — `url:https://example.com/post`, `url:https://www.youtube.com/watch?v=<id>`, `url:https://x.com/<user>/status/<id>`
- multiple URLs (space-separated, each its own unit)
- a **channel** — `url:channel:<UC...-or-url>`, or a `youtube.com/@handle` / `youtube.com/channel/UC...` URL: fans out to the channel's latest videos via its public RSS feed (see Channel feed below)

`https://` and the `url:` prefix are both accepted on the token.

## The scripts

| Script | Job |
|---|---|
| `listUrl.mjs <urlOrChannel...> [--cwd <p>] [--briefs-dir <p>] [--to <p>]` | The queue: canonicalized URLs vs the watermark. JSON. Does NOT fetch content. |
| `renderUrl.mjs <url:canonical-or-url> [--briefs-dir <p>] [--raw-dir <p>]` | One URL → substrate (header + extracted markdown body); fetches (cache-first) and records its watermark. |

`listUrl` emits the shared queue shape (`{ source, briefsRoot, newBriefsDir, queue, upToDateCount }`) plus, per entry, `watermark` (the canonical URL) and `prevWatermark`. It also emits `errors` (bad selectors) and `warnings` — surface both to the user. Because the substrate lives behind the extract endpoint, `listUrl` never hits the network: `title`/`firstMessage` are placeholders (the URL or video id) and `newTokens` is `0` until `renderUrl` fetches the real content.

## Units & watermark

**The unit is a URL; the watermark is the canonical URL itself** — a stable string, stored as `units` in `state.json` under the id `url:<canonical-url>`. A published article or a video transcript doesn't change, so a once-compiled URL never re-queues automatically (re-compiling a drifted page is an explicit re-run, not auto-detected). YouTube watch URLs canonicalize to `https://www.youtube.com/watch?v=<id>`; other URLs get light normalization (lowercased host, no fragment, tracking params like `utm_*`/`fbclid` dropped).

## Destination

`resolveDestination(cwd, --briefs-dir)` for the briefs **root**, then `resolveCollection(root, --to)` for the write dir (a `to:` collection subfolder, or the root itself). Explicit `--briefs-dir` wins, else `<cwd>/briefs`. There is no personalRoot — you run compile where you want the briefs to land. Writing into a non-git cwd is allowed; `listUrl` warns loudly when it is about to seed a brand-new `briefs/` in a place with no git history and no prior registration (it can't block — non-interactive runs hang on prompts — so the warning rides in the queue output). To land URL-sourced briefs in a repo, point `--briefs-dir` at `<repo>/briefs`.

## The raw cache

Fetched substrate is cached at `<repoRoot>/raw/<key>` (`<key>` is `youtube-<videoId>.md` for a YouTube watch URL, else a filesystem-safe slug of the canonical URL). `listUrl` reports the resolved `rawDir`; `renderUrl` reads `--raw-dir`. On a cache hit `renderUrl` reads the file and does **no** network. The cached file carries a small frontmatter header (`source_type`, `url`, `title`, `author`, `channel_name`, `channel_id`, `published_at`, `thumbnail`) above the extracted body, so re-renders are deterministic and offline. `channel_name` + `channel_id` + `thumbnail` (the YouTube thumbnail or web `og:image`) are bookmark metadata the desktop Links tab reads — `channel_id` is the stable key its channel facet groups by, falling back to `channel_name` for older cache files that predate it. A published page doesn't change, so the cache is safe to keep indefinitely; delete a file to force a re-fetch.

## Per-source report (`raw/<key>.report.md`)

Beyond folding a url into cross-source briefs, compile writes a **per-source report** — five sections, `## Summary` and `## Briefs updated` always present, the rest best-effort: `## Summary` (what THIS one source says, start to finish, the reading view the desktop Links tab shows beside the citing briefs), `## Briefs updated` (which briefs this source contributed to in the run and what it added, as `[[slug]]` pointers, not a restatement), `## Takeaways` (the interpretive residue a neutral summary wouldn't contain — what a reader actually learned, never the thesis restated), `## Pushbacks` (specific skeptical reads — where the source is thin, marketing, or dodges, each grounded in an actual claim; written fewer or omitted, never padded with generic filler) and `## Next steps` (the grounded research threads and to-dos this source raised, as GFM task items — the backlog, kept under its source instead of in a central file so each item keeps its provenance; omitted when nothing grounded). It's complementary to briefs: a brief is cross-source synthesis (and dilutes a single long source), the report's `## Summary` is fidelity to the source in order and its `## Briefs updated` is the source-eye view of where it landed. It lives in a **sibling** of the verbatim cache, `raw/<key>.report.md` (so the verbatim `raw/<key>.md` stays a pure, byte-faithful, offline cache — the report, being LLM output, never lands in it). `renderUrl` prints the target as a `report-target: <abs path>` line; the agent writes the report there with its Write tool (SKILL.md step 6, url-only). The file carries frontmatter `report_of: <canonical-url>`, `title:`, `generated:` above the markdown body. The `## Summary` section is scaled to the source's length (the `transcript runs to <stamp>` runtime / token size is the proportionality signal), sectioned, with `[MM:SS]` anchors for video. Its sub-sections are `###` (h3) headings nested under `## Summary`, never `##` — the only `##` headings in a report are the five top-level sections, so the reading-view nav stays a clean section list rather than a flat wall of timestamp headings.

**Frozen at first compile.** Because the url watermark (the canonical URL) holds, a compiled url never auto-re-queues, so the report is written once and not regenerated on later runs. Improving it is an explicit re-run (drop the watermark + delete the files); a url compiled before this feature shipped keeps its `raw/<key>.md` but has no report (it degrades to no reading view, never an error). Deleting `raw/<key>.report.md` alone does not trigger regeneration — the watermark, not the file's presence, gates the queue.

## Env vars

`renderUrl` calls the hosted extract endpoint:

- `CLEARVOID_EXTRACT_URL` — the endpoint (default `https://kolnqincbwtmxtbswaet.supabase.co/functions/v1/extract`).
- `CLEARVOID_EXTRACT_TOKEN` — optional Bearer token. The public endpoint is open (the monthly cap + per-IP rate limit are the guardrails), so this is only needed against a deployment configured closed; when set it is sent as `Authorization: Bearer <token>`.

The endpoint returns `200 { status:"completed", title, markdown, source_type, author_name, author_username, published_at, channel_name, channel_id, og_image_url }` on success; a `202 { status:"pending", contentId }` means the extraction is still running — `renderUrl` re-polls by `contentId` every few seconds up to ~3 min until it completes (a `422`/4xx/5xx surfaces as a clear error). `listUrl` never touches the endpoint.

## Channel feed

A channel selector (`channel:<id-or-url>`, a `/@handle` or `/channel/UC...` URL) resolves to the channel's latest videos via the public RSS feed `https://www.youtube.com/feeds/videos.xml?channel_id=<UC...>` — no API key, ~15 newest videos. A raw `UC...` id or a `/channel/UC...` URL is used directly; a `/@handle` (or other channel page) is fetched and its `channelId` scraped from the HTML. Each `<yt:videoId>` becomes a watch URL unit. **The RSS feed caps at ~15 videos with no pagination** — `listUrl` surfaces this in `warnings` (no silent truncation); going deeper requires the YouTube Data API (key + quota), which is not built. Re-run later to pick up new uploads.

## Length: read it, never estimate it

Never state a video's duration, "minutes into the transcript", or reading length by eyeballing the token/byte count — that guess is routinely off by 3–4× (a 46-min video reads as "~13 min"). A YouTube transcript body is line-prefixed with `[MM:SS]` / `[H:MM:SS]` timestamps and `renderUrl` surfaces the largest one as `transcript runs to <stamp>` on its size line — that figure is the real runtime; report it verbatim or not at all. An article or tweet has no timestamps, so it has no duration: don't invent one.

## Provenance

Brief frontmatter `sources:` carries the `url:<canonical-url>` ids, same as the other sources. URL provenance pointers stay resolvable as long as the page exists at that URL (and the raw cache keeps a local copy of the extracted substrate regardless).
