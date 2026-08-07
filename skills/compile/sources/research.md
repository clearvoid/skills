# Source module: research (`research:`)

A **free** source (the metered fetch already happened in the `/clearvoid:research` skill) that folds **external enrichment** — what the open web (Exa) and X/Twitter discourse (Grok) say about a topic or a specific URL — into briefs. Unlike every other source you do **not** select this directly: the `/clearvoid:research` skill calls the hosted research endpoint, writes the material to `raw/<key>.research.md`, and then runs `/clearvoid:compile research:<key>`. This module is how compile reads that substrate. Read once before the first research compile. The interface this satisfies is in `sources/README.md`.

## Selecting it

`/clearvoid:compile research:<key>` — emitted by the `/clearvoid:research` skill, not typed by hand. The leading `research:` token selects this source and `<key>` is the slug the research skill wrote `raw/<key>.research.md` under (`fetchResearch.mjs` prints it as `research-key: research:<key>`). Multiple keys are allowed.

## The scripts

| Script | Job |
|---|---|
| `listResearch.mjs <research:key...> [--cwd <p>] [--briefs-dir <p>] [--to <p>]` | The queue: research keys vs the watermark (content hash of the cached substrate). Stub JSON on stdout naming the full payload file (Read it whole — SKILL.md step 1). Reads the local cache only. |
| `renderResearch.mjs <research:key> [--briefs-dir <p>] [--raw-dir <p>]` | One key → substrate: header + a `substrate:` pointer at the cached `raw/<key>.research.md` (the body never rides stdout — Read the file whole); records its watermark. **No network** — the fetch already happened in the skill. |

`listResearch` emits the shared queue shape (`{ source, briefsRoot, newBriefsDir, rawDir, queue, upToDateCount }`) plus, per entry, `watermark` (the substrate's content hash) and `prevWatermark`, and `errors` (e.g. a key whose substrate was never fetched) — surface them. The metered Exa + Grok call lives in the research skill's `fetchResearch.mjs`, never in these scripts.

## Units & watermark

**The unit is a research key; the watermark is the content hash of `raw/<key>.research.md`** — stored as `units` in `state.json` under the id `research:<key>`. This is the `md` pattern, not the `url` one: research is **re-runnable**. Re-running `/clearvoid:research` overwrites the substrate with fresh web/X state → new hash → the key re-queues and compile re-folds it (and rewrites the report). An unchanged substrate is up to date and does not re-fold.

## The raw cache

The substrate lives at `<repoRoot>/raw/<key>.research.md`, written by the research skill's `fetchResearch.mjs` (frontmatter `research_of:` + `title:` + `generated:` + a `sources:` list of the web/X URLs the lanes surfaced, then the material: the web read, the X discourse, and any verbatim X-post enrichment). A freeform topic keys on a slug of the topic; researching a URL keys on that URL — so a `research:<url>` substrate (`raw/<key>.research.md`) sits beside, and never collides with, a `url:` extract of the same URL (`raw/<key>.md`). `renderResearch` reads this file and does no network; if it is missing it errors (run `/clearvoid:research` first).

## Per-source report (`raw/<key>.research.report.md`)

Compile folds a research unit into cross-source briefs **and** writes a per-source report — the same five sections as a url report (`## Summary` / `## Briefs updated` / `## Takeaways` / `## Pushbacks` / `## Next steps`), where `## Summary` is a faithful reading of the fetched enrichment (the web results and the X discourse). `renderResearch` prints the target as a `report-target: <abs path>` line; the agent writes the report there (SKILL.md step 6). The path is `raw/<key>.research.report.md` — the distinct `.research.report.md` suffix keeps it from colliding with a url source's `raw/<key>.report.md` at the same key, and it still ends in `.report.md`, so the backlog (recall's backlog mode + the desktop app) picks up its `## Next steps` with no extra wiring.

**Re-writable (not frozen).** Because the watermark is a content hash, a fresh research run re-folds and the report is rewritten — the opposite of the frozen, write-once url report.

## Env vars

The fetch is in the research skill (`fetchResearch.mjs` → `CLEARVOID_RESEARCH_URL` / `CLEARVOID_RESEARCH_TOKEN`); these compile scripts read no endpoint env. They only need the repo's `raw/` (resolved from the checkout root, or `--raw-dir`).

## Provenance

Brief frontmatter `sources:` carries the `research:<key>` ids, same shape as the other sources. A research pass is a *multi-source aggregation* (many web results + X posts), so the brief cites the pass (`research:<key>`), not each underlying link — the underlying URLs live in the substrate's `sources:` and the report.
