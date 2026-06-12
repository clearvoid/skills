# Brief file format & folder convention — v0

The contract every client shares: the compile skill, the desktop app, any editor, any agent.
Files are canonical; everything else is a derived index or a client.

## Layout

```
<repo root>/
  briefs/
    README.md                  # generated index: title + one-line framing per brief.
                               #  GitHub renders it as the folder landing page; this is
                               #  the v0 navigator (wikilinks don't resolve on GitHub).
    <slug>.md                  # one brief per file, kebab-case slug
    .clearvoid/
      state.json               # compile bookkeeping (committed — team-shared watermark)
      ignore                   # source-unit ids/globs excluded from compile (committed)
```

No other artifacts are ever written into the user's repo — no HTML viewers, no generated
blobs. Markdown IS the viewer story: briefs render natively on GitHub, Obsidian, and any
editor. (An on-demand local viewer — `npx clearvoid view`-shaped — is a possible later
client; it is never a committed file.)

Everything Clearvoid-related lives inside `briefs/` — deleting the folder is a complete
reset. No state anywhere else; no global config required.

## Brief file

```markdown
---
title: Content pipeline: X/tweet extraction
framing: |
  How tweet/X content gets extracted and processed. Track the pipeline shape,
  where bugs cluster, and decisions about structured metadata.
framing_source: ai_seeded        # ai_seeded | human — human means promoted/edited
created: 2026-06-10
updated: 2026-06-10
sources:
  - claude-code:-Users-x-repo/0a1b2c3d-…   # full source-namespaced ids (encoded dir + uuid).
  - claude-code:-Users-x-repo/4e5f6a7b-…   #  Best-effort: raw sessions purge after ~30 days;
                                           #  pointers may dangle — that's expected.
---

<compiled current view — plain markdown body>

Wikilinks to sibling briefs use [[other-brief-slug]].
```

Rules:

- **Framing is the human anchor.** The compile loop may *seed* a framing
  (`framing_source: ai_seeded`); only a human edit makes it `human`. Promotion IS editing
  the framing — no separate status enum (matches the desktop substrate's collapse of
  candidate/canonical into framing-edit-only).
- **The skill updates content within a framing; it never rewrites a `human` framing.**
- **Obsidian-renderable by construction:** standard YAML frontmatter, plain markdown body,
  native wikilinks. No custom syntax, no Tailwind-of-markdown.
- **No hard-wrapping inside paragraphs — one paragraph per line.** Briefs are retrieved by grep and reviewed by diff; a phrase that spans a wrapped line breaks search, and re-flowed paragraphs turn one-word edits into wall-of-churn diffs.
- Source ids are namespaced from day one: `claude-code:<sessionId>`,
  `chatgpt:<conversationId>`, `md:<relative-path>` — v0 only emits `claude-code:` but the
  schema is source-aware so ChatGPT export (article #2) drops in without migration.

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

- `units` is a **progress offset** — the count of non-empty JSONL lines compiled through —
  not a boolean. Sessions grow; the next run renders only lines past the offset
  (`renderSession --from-line`). (The resume-offset pattern; a visited *flag* would either
  skip new messages or recompile whole sessions.) Other sources define their own unit in
  their source module (e.g. conversations for a ChatGPT export).
- **Committed to git, deliberately:** sessions are per-user (ids never collide across
  machines), so a shared watermark gives the team incremental semantics for free — a new
  teammate's compile doesn't refold what others already folded in. Content-free by rule:
  ids, counts, timestamps, brief slugs. Never titles, never text.

## Teams (same repo → same substrate)

- Each member runs the skill locally over *their own* sessions; brief updates flow through
  git like code. **Git is the contribution gate**: nothing leaves your machine until you
  commit, and the diff is the review surface — "what did my session add to the shared
  view" is literally the staged hunk. (This is the v0 of layered-synthesis contribution
  gates, inherited from git instead of built.)
- Session privacy: exclude a session from compile via `briefs/.clearvoid/ignore` (one
  source id or glob per line), or simply don't commit the brief/hunk it produced.
- Concurrent compiles produce ordinary markdown merge conflicts; per-topic files keep the
  surface small. A reconcile instruction is a later addition, not v0.

## What we deliberately lose vs the desktop SQLite path

Raw-session archival. JSONLs purge after ~30 days; provenance pointers go best-effort
after that. The compiled extracts in the briefs ARE the durable distillation. Session
archive + full history replay is parked as paid surface (app/cloud) — the app remains the
archiver for those who run it; the skill stays compile-only.

## Open questions for Alex

1. `briefs/` as the folder name — or `.briefs/`/`docs/briefs/`? (Visible top-level `briefs/`
   is the bet: it's a feature of the repo, not metadata.)
2. Frontmatter field for per-brief extracts/provenance detail (the desktop's extract layer)
   — v0 keeps only the `sources` list; extracts stay implicit in the body. Enough?
3. Does `state.json` committed-by-default survive contact with real teams, or does it want
   to be gitignored for solo users? (Committed is the default bet for the team semantics.)
