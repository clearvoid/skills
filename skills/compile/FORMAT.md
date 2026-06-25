# Brief file format & folder convention — v0

The contract every client shares: the compile skill, the desktop app, any editor, any agent. Files are canonical; everything else is a client.

## Layout

```
<repo root>/
  briefs/
    <slug>.md                  # one brief per file, kebab-case slug (top-level collection)
    <collection>/              # an optional subfolder grouping — a "collection" (brief files only, no .clearvoid)
      <slug>.md
    .clearvoid/                # repo-level bookkeeping — only ever at the briefs root
      state.json               # ONE watermark for the whole repo (committed — team-shared)
      ignore                   # source-unit ids/globs excluded from compile (committed)
      config.json              # OPTIONAL per-repo settings (e.g. context scope) — commit or not, your call
      follow-ups.md            # OPTIONAL co-authored follow-ups/actions backlog (NOT a brief)
  raw/                         # url-sourced extracted substrate (sibling of briefs/, see below)
    <key>.md                   # verbatim extracted substrate (script-managed cache)
    <key>.summary.md           # per-source detailed breakdown (agent-written reading view)
```

No artifacts are ever written into the user's repo besides the brief files themselves — no generated index/`README.md`, no HTML viewers, no generated blobs. The read side (the recall skill, the workbench) builds its selection surface by scanning brief frontmatter on demand. Markdown IS the viewer story: briefs render natively on GitHub, Obsidian, and any editor. (An on-demand local viewer — `npx clearvoid view`-shaped — is a possible later client; it is never a committed file.)

Everything Clearvoid-related lives inside `briefs/` — deleting the folder is a complete reset. Defaults work with zero global config; the only global file is the optional `~/.clearvoid/roots.json` registry (auto-written by compile) and an optional `~/.clearvoid/config.json` (context-scope default — see Context scope below).

## Collections (subfolders under `briefs/`)

Briefs may live in subfolders under `briefs/` at **any depth** — a "collection" is a brief's folder path relative to `briefs/`: `""` for `briefs/<slug>.md` (the top-level / default collection), `yc-ai` for `briefs/yc-ai/<slug>.md`, `ai/agents` for `briefs/ai/agents/<slug>.md`. A collection is a deliberate user grouping — video briefs vs CRM briefs vs daily checkins, say, all in one repo — and is orthogonal to both source (where the material came from) and topic (what the brief is about).

**Collections are folders, not walls.** The whole repo is one pool: a run orients against, clusters across, and watermarks for *every* collection at once, and may update or cross-link a brief in any collection. A collection is purely organizational filing — where new briefs are *filed*, not a boundary compile reads or writes within. (The hard boundary between genuinely separate scopes is the *repo*, walled by `roots.json` + context scope; see Cross-project roots and Context scope.)

- **Targeting with `to:<path>`.** The compile directive may carry a `to:<path>` token that sets where *new* briefs from this run are filed: `to:yc-ai` files new briefs into `briefs/yc-ai/`, `to:ai/agents` into `briefs/ai/agents/`. No `to:` token files new briefs at the `briefs/` top level. That is *all* `to:` does — it does not scope orientation, the queue, the watermark, or updates. (The destination root is still `<cwd>/briefs` or an explicit `--briefs-dir`; `to:` selects a subfolder inside it for new files.)
- **Orientation and the queue are repo-global.** A run reads the full recursive set of briefs (every collection) as its orientation index, and compares the source queue against one watermark for the whole repo. Updates land in place, in whatever collection a brief already lives.
- **One watermark per repo.** The watermark lives at `briefs/.clearvoid/state.json` (the root), not per collection. A source is compiled once and informs the whole pool; the same run can produce or update briefs in several collections. `.clearvoid/` exists only at the briefs root — collections hold brief files only.
- **Cross-collection links are forward-only; backlinks are derived.** Compile writes `[[slug]]` wikilinks across collections freely; the read side computes the reverse edges, so the brief graph is bidirectional without any cross-collection writes.
- **Compile registers the root, not the collection.** `registerRoot.mjs` always registers the briefs **root** (`<repo>/briefs`), never a collection subdir — so the read side discovers every collection from the single registered entry. The registry stays one entry per repo (see Cross-project roots).
- **Readers recurse.** The read side (the recall skill, the desktop workbench) walks the registered briefs root **recursively** to find briefs at any depth, skipping any `.clearvoid/` dir (at any depth) and `README.md`. A brief's collection is just its relpath from the root, recovered while walking.

## `raw/` — url-sourced substrate (sibling of `briefs/`)

The `url:` source caches the extracted markdown it fetches at `<repo root>/raw/<key>.md` — at the **repo root**, a sibling of `briefs/`, deliberately **outside** `briefs/` so the recursive brief reader never mistakes a transcript or article body for a brief. (Inside `briefs/`, recursion would otherwise pick it up.) The cache is plain markdown with a small header (`source_type`, `url`, `title`, …) and is safe to keep indefinitely; gitignoring `raw/` is left to the user.

Alongside the verbatim cache, compile writes a **per-source detailed summary** to a sibling `raw/<key>.summary.md` — a length-proportional breakdown of that one source (frontmatter `summary_of: <canonical-url>`, `title:`, `generated:`, then the markdown body). It's the desktop Links tab's reading view, complementary to the cross-source briefs; the verbatim `<key>.md` stays a pure script-managed cache and never carries the summary. Written once at compile time (frozen — the url watermark holds), url sources only. See `sources/url.md`.

## Brief file

```markdown
---
title: Content pipeline: X/tweet extraction
framing: |
  How tweet/X content gets extracted and processed. Track the pipeline shape,
  where bugs cluster, and decisions about structured metadata.
summary: One line distilling the current view — the recall skill's selection surface is built from it.
created: 2026-06-10
updated: 2026-06-10
sources:
  - claude-code:-Users-x-repo/0a1b2c3d-…   # full source-namespaced ids (encoded dir + uuid).
  - claude-code:-Users-x-repo/4e5f6a7b-…   #  Best-effort: raw sessions purge after ~30 days;
                                           #  pointers may dangle — that's expected.
---

<compiled current view — a SNAPSHOT of the current position, kept tight>

## Log
<dated entries, newest last: each a decision/view-change + the verbatim
 quote anchor(s) and date behind it — the evolution trail beneath the snapshot>

Wikilinks to sibling briefs use [[other-brief-slug]].
```

Rules:

- **Framing is the human anchor.** Compile *seeds* a framing on create and may **refine** an existing framing on a later run when the compiled view has clearly outgrown the original lens — but the framing is the human's, so editing it is high-friction: lightest touch (refine and extend, don't wholesale-reword), preserve the original intent, and **call out every framing change explicitly in the run report** (which brief, what changed, why). Briefs live in git and compile never commits, so a framing change rides as a reviewable diff hunk the human stages by hand — the diff is the review pass, the report is what points them at it. Edit the framing in any editor and the next compile respects it without being told to. There is deliberately no status field and no provenance tracking of who edited what when: that machinery would complicate the system, and the git diff is the gate that makes it unnecessary.
- **A framing evolves with the material, never with a single run's emphasis.** A directive or emphasis token steers what the body attends to; it must never rewrite the framing to chase one run's instruction. A framing moves only because the accumulated material has outgrown it. On conflict between emphasis and framing, obey the framing as written and flag the tension in the report.
- **The body is a snapshot; the optional `## Log` carries the trail.** The brief body above any `## Log` heading is the *current view* — the present position, kept tight, not a diary of how it got there. A brief may carry a trailing `## Log` section: dated entries, newest last, each pairing a decision or material view-change with the verbatim source quote(s) and date that anchor it. This keeps the current view from bloating while preserving the receipts and a record that lets the view be re-evaluated later. On update, append a Log entry when the view materially moves or a quote is worth anchoring — never restate the body there, and never let Log content leak up into the snapshot. The Log is optional: thin or purely-factual briefs may omit it.
- **Obsidian-renderable by construction:** standard YAML frontmatter, plain markdown body, native wikilinks. No custom syntax, no Tailwind-of-markdown.
- **No hard-wrapping inside paragraphs — one paragraph per line.** Briefs are retrieved by grep and reviewed by diff; a phrase that spans a wrapped line breaks search, and re-flowed paragraphs turn one-word edits into wall-of-churn diffs.
- Source ids are namespaced from day one: `claude-code:<sessionId>`, `md:<abs-path>`, `url:<canonical-url>`, `chatgpt:<conversationId>` — the schema is source-aware, so each new source drops in without migration. The `url:` id is the canonical URL itself (the same string the watermark uses); it stays resolvable as long as the page exists (and the `raw/` cache keeps a local copy of the extracted substrate regardless). See the per-source docs under `sources/`.

## state.json (the visited-sessions watermark)

```json
{
  "version": 1,
  "sources": {
    "claude-code:-Users-x-repo/0a1b2c3d-…": {
      "units": 142,
      "compiledAt": "2026-06-10T18:00:00Z",
      "briefs": ["content-pipeline-x-extraction"]
    }
  }
}
```

- `units` is a **progress offset** — the count of non-empty JSONL lines compiled through — not a boolean. Sessions grow; the next run renders only lines past the offset (`renderSession --from-line`). (The resume-offset pattern; a visited *flag* would either skip new messages or recompile whole sessions.) Other sources define their own unit in their source module: the `md:` source's unit is a whole file and its watermark is a content hash (`sha256:<hex>`); the `url:` source's unit is a URL and its watermark is the canonical URL itself (a stable string — published content doesn't change, so a compiled URL never auto-re-queues). `units` is therefore an opaque per-source token, compared by the source, not always a count.
- **One state.json per repo.** The watermark lives at the briefs root, `briefs/.clearvoid/state.json`, regardless of `to:`. The whole repo is one pool (collections are folders, not walls — see Collections): a source is compiled once and informs every collection, so there is a single watermark, not one per collection. `to:` only sets where new brief *files* land, never which watermark a run reads or writes.
- **Committed to git, deliberately:** sessions are per-user (ids never collide across machines), so a shared watermark gives the team incremental semantics for free — a new teammate's compile doesn't refold what others already folded in. Content-free by rule: ids, counts, timestamps, brief slugs. Never titles, never text.

## follow-ups.md — the follow-ups / actions backlog

`briefs/.clearvoid/follow-ups.md` is an OPTIONAL, repo-level, co-authored backlog — the durable home for what a compile would otherwise only mention in its chat report and then lose. It lives in `.clearvoid/` (not a collection) deliberately, so the recursive brief reader never mistakes it for a brief: it is **not** a brief, has no framing, and never enters the recall selection surface as one.

```markdown
---
version: 1
---
# Follow-ups & Actions

## Follow-ups
- <research thread worth going deeper on> (src: <source-id> · <date> · [[brief]])

## Actions
- <thing to do, often backed by a brief> (backing: [[brief]] · src: <source-id> · <date>)
```

- **Two sections.** `## Follow-ups` are research threads worth pursuing (usually a future compile — a follow-up *becomes* a brief once compiled). `## Actions` are things to do, often backed by a brief (an action *cites* a brief as its research backing). Each item is a `- ` bullet with a short metadata tail (source id, date, and a `[[brief]]` link where relevant).
- **Co-authored, like framings.** Compile *appends* grounded items and dedupes against what's there; it never deletes or rewrites a human-authored line. The human edits and deletes freely — **deleting a line means done** (no status field, the same no-status philosophy as briefs). The human also seeds items the agent can't infer (a "we need our own pitch"-style reminder).
- **Grounded only.** An entry is a concrete next source, a thread a source actually raised, or a specific implication — never generic "explore X further" filler. A compile run that surfaces nothing grounded writes nothing.
- **Surfaced, not auto-acted.** The read side (`/clearvoid:recall` backlog mode, via `resolveRoots.mjs --backlog`) aggregates `follow-ups.md` across the in-scope roots and prints it; nothing acts on it automatically.

## Teams (same repo → same substrate)

- Each member runs the skill locally over *their own* sessions; brief updates flow through git like code. **Git is the contribution gate**: nothing leaves your machine until you commit, and the diff is the review surface — "what did my session add to the shared view" is literally the staged hunk. (This is the v0 of layered-synthesis contribution gates, inherited from git instead of built.)
- Session privacy: exclude a session from compile via `briefs/.clearvoid/ignore` (one source id or glob per line), or simply don't commit the brief/hunk it produced.
- Concurrent compiles produce ordinary markdown merge conflicts; per-topic files keep the surface small. A reconcile instruction is a later addition, not v0.

## Cross-project roots — `~/.clearvoid/roots.json`

A registry of every place briefs live, shared by all clients (skills, the desktop workbench):

```json
{
  "version": 1,
  "roots": ["/Users/x/code/some-repo/briefs"]
}
```

- A flat `{ version, roots }` — no `personalRoot`. The destination is always explicit: compile writes to `<cwd>/briefs` or an explicit `--briefs-dir`, so a special repo-less "personal" home has no job. A legacy file carrying a `personalRoot` key self-heals (the key is dropped on the next write).
- Compile auto-registers the destination `briefs/` **root** at the end of every run (the `registerRoot.mjs` step) — never a collection subdir. The registry stays **one entry per repo**; readers recurse into collections from that single entry (see Collections).
- Read-side tools (the `recall` skill, the workbench) aggregate across the current repo + the registry, recursing into every collection under each root. Compile only ever writes to the collection it was pointed at.
- `CLEARVOID_HOME_DIR` overrides `$HOME` for the registry too (hermetic tests).

## Context scope — which OTHER repos a session pulls in

The registry above is omniscient by design: the desktop workbench shows **every** brief across **every** registered repo, and compile registers each repo it writes. But a working `/clearvoid:recall` session inside repo A doesn't always want repo B's briefs in its selection surface — deliberately independent projects want a clean wall. **Context scope** is the per-session knob that decides which *other* registered repos enter the pool. The current repo's own briefs are always loaded; scope only governs the others. Only the read side (the `recall` skill) consults it — the viewer stays omniscient and compile ignores it.

Two optional, layered files (defaults work with zero config):

- **Global** `~/.clearvoid/config.json` — the default scope across all repos:

  ```json
  { "version": 1, "context": { "scope": "repo" } }
  ```

  `scope` is `"repo"` (the shipped default: isolation — load only the current repo's briefs) or `"all"` (every registered repo, the omniscient-context workflow). A user who wants cross-repo context everywhere sets `"all"` once here.

- **Per-repo** `<repo>/briefs/.clearvoid/config.json` — overrides the global default for this repo and adds explicit include/exclude:

  ```json
  {
    "version": 1,
    "context": {
      "scope": "repo",
      "include": ["brain", "/Users/x/code/other-repo/briefs"],
      "exclude": ["client-work"]
    }
  }
  ```

Resolution: per-repo `scope` overrides global `scope` (default `"repo"`); then under that scope, `include` adds specific other repos and `exclude` removes them. **`exclude` always wins** over `include`/`scope`, so under global `"all"` a single repo can be walled off. An `include`/`exclude` entry names a repo by its **display name** — the folder that holds `briefs/` (`brain` for `/x/brain/briefs`), which is portable across machines and clones — or by an **absolute/`~` path** to the briefs dir or the repo dir.

`briefs/.clearvoid/config.json` is yours to commit or gitignore: a name-based include list is portable and reasonable to commit (every clone resolves `brain` the same way); a path-based list is machine-specific and usually better left uncommitted. The contract doesn't decide for you. Out-of-scope repos still surface in the recall skill's output as name + brief count (never their content), so a relevant one is one instruction away without editing a file.

## What we deliberately lose vs the desktop SQLite path

Raw-session archival. JSONLs purge after ~30 days; provenance pointers go best-effort after that. The compiled extracts in the briefs ARE the durable distillation. Session archive + full history replay is parked as paid surface (app/cloud) — the app remains the archiver for those who run it; the skill stays compile-only.

## Open questions for Alex

1. `briefs/` as the folder name — or `.briefs/`/`docs/briefs/`? (Visible top-level `briefs/` is the bet: it's a feature of the repo, not metadata.)
2. Frontmatter field for per-brief extracts/provenance detail (the desktop's extract layer) — v0 keeps only the `sources` list; brief extracts stay implicit in the body. (Partially resolved for url sources: a per-*source* detailed summary now lives at `raw/<key>.summary.md`. A per-*brief* extract layer is still open.)
3. Does `state.json` committed-by-default survive contact with real teams, or does it want to be gitignored for solo users? (Committed is the default bet for the team semantics.)
