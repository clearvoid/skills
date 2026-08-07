# Source module: plain markdown (`md:`)

The first **free** source — a `.md` file, a directory of them, or a glob. No repo required; you compile markdown into briefs wherever you run. Read once before the first markdown compile. The interface this satisfies is in `sources/README.md`.

## Selecting it

`/clearvoid:compile md:<selector> [emphasis]`. The leading `md:` token selects this source; the rest of the directive is emphasis (see the SKILL's Directive section). `<selector>` is one of:

- a single file — `md:/tmp/echo.md`, `md:~/notes/strategy.md`
- a directory (recursive, all `*.md` under it, dotdirs like `.git`/`.clearvoid` skipped) — `md:~/notes/`
- a glob — `md:~/notes/**/*.md` (`**` spans directories, `*` does not)

Multiple selectors are allowed. `~/` and relative paths (against `--cwd`) are accepted.

## The scripts

| Script | Job |
|---|---|
| `listMarkdown.mjs <selector...> [--cwd <p>] [--briefs-dir <p>]` | The queue: matched `.md` files vs the watermark. Stub JSON on stdout naming the full payload file (Read it whole — SKILL.md step 1). |
| `renderMarkdown.mjs <md:path> [--briefs-dir <p>] [--raw-dir <p>]` | One file → substrate: a header plus a `substrate:` pointer at the file itself (the body never rides stdout — Read the file whole); `--briefs-dir` records its watermark; prints a `report-target: <path>` line for the per-source report. |

`listMarkdown` emits the shared queue shape (`{ source, briefsRoot, newBriefsDir, queue, upToDateCount }`) plus, per entry, `watermark` (the file's current content hash) and `prevWatermark`. It also emits `errors` (bad selectors) and `warnings` — surface both to the user.

## Units & watermark

**The unit is a whole file; the watermark is its content hash** (`sha256:<hex>`), stored as `units` in `state.json` under the id `md:<abs-path>`. Any change to the file flips the hash and re-queues it; an unchanged file is a no-op. Consequences:

- **Full re-render on change** — `renderMarkdown` has no offset; it re-reads the whole file. The brief is reconciled-not-appended, so re-folding already-seen material doesn't duplicate in the output, it's just redundant input (cheap for small files). A large append log (re-processing everything on every append) is the case offset-incrementality would later optimize — not built yet.
- **A moved/renamed file is a new id** (the path is the key). Acceptable for v0.

## Per-source report (`raw/<key>.report.md`)

Compile folds a markdown unit into cross-source briefs **and** writes a per-source report — the same five sections as a url report (`## Summary` / `## Briefs updated` / `## Takeaways` / `## Pushbacks` / `## Next steps`). `renderMarkdown` prints the target as a `report-target: <abs path>` line; the agent writes the report there (SKILL.md step 6). Frontmatter `report_of: md:<abs-path>`.

Two things are md-specific:

- **`## Summary` is a full reading view.** The report **is** what the desktop Sources tab shows for a md source (the raw file is not surfaced there), so the Summary has to stand on its own — a reading of the file proportional to its length, same as a url/chat report, not a thin orient. `## Briefs updated` (what this file changed and why) and `## Next steps` (the backlog) carry the rest.
- **Re-writable, not frozen.** This is the `md`/`research` pattern, not the `url` one: because the watermark is a content hash, an edited file re-queues and compile rewrites the report — the opposite of the write-once url report.

The report path keys off the file: a md file already inside `raw/` keys on its basename (`raw/<name>.report.md`, a sibling like a url report); a file anywhere else keys on a slug of its name plus a short hash of its absolute path, so two same-named files in different folders never collide. It still ends in `.report.md`, so the backlog (recall's backlog mode + the desktop app) picks up its `## Next steps` with no extra wiring.

## Destination

`resolveDestination(cwd, --briefs-dir)`: explicit `--briefs-dir` wins, else `<cwd>/briefs`. There is no personalRoot — you run compile where you want the briefs to land. Writing into a non-git cwd is allowed; `listMarkdown` warns loudly when it is about to seed a brand-new `briefs/` in a place with no git history and no prior registration (it can't block — non-interactive runs hang on prompts — so the warning rides in the queue output). To land markdown-sourced briefs in a repo, point `--briefs-dir` at `<repo>/briefs`.

## Recording progress

Automatic and shared with every source: `renderMarkdown --briefs-dir <briefsDir>` records the file's content hash as pending progress, and `finalizeState.mjs --briefs-dir <briefsDir>` commits it at the end of the run (see `sources/README.md`). An unchanged file's hash matches on the next queue and is a no-op; a changed file re-queues. Nothing per-file to remember.

## Provenance

Brief frontmatter `sources:` carries the `md:<abs-path>` ids, same as claude-code. Unlike sessions, markdown files don't purge after 30 days, so md provenance pointers stay resolvable as long as the file exists at that path.
