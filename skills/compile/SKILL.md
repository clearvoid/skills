---
name: compile
description: Compile a corpus into living markdown briefs in ./briefs/ — by default this repo's Claude Code sessions, or a markdown file/folder (md:<path>), or any URL including YouTube (url:<url>). Incremental, provenance-linked, each brief a framing plus a compiled current view. Use when the user asks to compile briefs, update the briefs, compile this session, fold a markdown file/notes into briefs, compile a YouTube video or other URL, or asks what this repo's session history adds up to.
user-invocable: true
argument-hint: "[optional md:<path> source prefix, then emphasis, e.g. 'pay special attention to the agency-strategy discussion']"
allowed-tools: Read, Write, Edit, Glob, Bash(node *)
---

# clearvoid-compile

Compile a corpus into **briefs**: markdown files in this repo's `briefs/` folder, each one
a human-ownable *framing* (what the brief is for) plus a compiled *current view* (what the
corpus says, through that framing). Everything happens locally; nothing leaves the machine
— briefs only travel when the user commits them.

The full file contract is `${CLAUDE_SKILL_DIR}/FORMAT.md` — read it on first run or
whenever unsure about frontmatter, the state file, or folder conventions.

## Sources

Compile is `source × destination`: a **source** enumerates and renders the material, a
**destination** is where briefs land. The contract every source satisfies (the shared queue
shape, the unit/watermark concepts, repo-bound vs free) is in
`${CLAUDE_SKILL_DIR}/sources/README.md` — read it once. The source modules today:

- **`claude-code`** (default) — Claude Code sessions belonging to this repo. Read
  `${CLAUDE_SKILL_DIR}/sources/claude-code.md` before the first compile (scripts, session
  encoding, JSONL quirks). Repo-bound: needs a git repo.
- **`md`** — a plain markdown file, directory, or glob, selected with the `md:` prefix
  (`md:/tmp/echo.md`). Read `${CLAUDE_SKILL_DIR}/sources/markdown.md` before the first
  markdown compile. Free: writes `briefs/` wherever you run (or `--briefs-dir`).
- **`url`** — any URL (a YouTube video, article, or tweet), selected with the `url:` prefix
  (`url:https://www.youtube.com/watch?v=…`), several space-separated URLs, or a channel
  (`url:channel:UC…`). Content is fetched from the hosted Clearvoid extract endpoint and
  cached under the repo's `raw/`. Read `${CLAUDE_SKILL_DIR}/sources/url.md` before the first
  url compile. Free.

**Source and destination selection are mechanical, never inferred from prose.** Scan only
the directive's leading whitespace-delimited tokens:

- **Source:** if the first token matches `<source>:` for a module above (`md:`, `url:`), it
  selects the source and the rest of that token is its argument (the path/glob/URL, or for
  `url:` several space-separated URLs). Otherwise the source is `claude-code`.
- **Destination:** a `to:<path>` token (a leading token, in any order with the source token)
  selects the destination **collection**: briefs land in `briefs/<path>/` (any depth). No
  `to:` writes to `briefs/` top-level. Pass it through to the list and `render` scripts as
  `--to <path>`.
- Everything after the consumed selector tokens is **emphasis** (it steers attention only).

A prefix naming a source with no module yet (`chatgpt:`) gets "that doesn't exist yet",
never reinterpreted. A bare path with no prefix is emphasis, not a source.

## Directive

Anything typed after the skill name is a free-text directive. After the optional leading
`<source>:` selector token is consumed (see Sources), the **rest is emphasis** — it steers
**attention**, nothing else. What it never does is scope *which units* compile: a run always
processes the full queue, oldest first — "everything since the last compile" is the
whole contract. (Unit scoping was considered and rejected: with an empty queue it's a
no-op, and with a stale queue it folds material out of chronological order, letting
older units later overwrite newer positions.)

Emphasis steers what to attend to within that sweep — "pay special attention to the
agency-strategy discussion", "especially this session" (the queue entry flagged
`current`). Read the named thread or session with extra care and lower the bar for
promoting it to its own brief. Two guardrails:

- Emphasis never fabricates: if the material isn't actually in the sessions, report that
  rather than writing a thin brief to satisfy the directive.
- Emphasis never overwrites an existing framing. On conflict, obey the framing as written
  and flag the tension in the report. Emphasis steers what the body attends to, never the
  framing.

If an emphasized thread does earn a new brief, seed its framing from the directive's own
language: the one-off instruction becoming durable steering is the framing mechanism
working as intended.

The conversation stays live during a run — treat mid-run steering ("skip that one",
"that belongs in the positioning brief") as directive, not interruption.

## Process

1. **Orient.** Read every existing brief in the **write dir** (the target collection — the
   list step's `briefsDir`, which is `briefs/` itself when there is no `to:`; a `to:`
   collection scopes orientation to that subfolder, not the whole tree). These framings are
   the lens for everything you read next. If the write dir doesn't exist yet, you're
   cold-starting that collection: you'll be proposing its first slate of briefs and seeding
   their framings yourself.

2. **Get the queue** from the resolved source's list script (append `--to <path>` when the
   directive named a `to:` collection):
   - claude-code: `node ${CLAUDE_SKILL_DIR}/scripts/listSessions.mjs [--to <path>]`
   - md: `node ${CLAUDE_SKILL_DIR}/scripts/listMarkdown.mjs <selector> --cwd . [--to <path>]`
   - url: `node ${CLAUDE_SKILL_DIR}/scripts/listUrl.mjs <url-or-channel…> --cwd . [--to <path>]`
   They return the units with new content, oldest first, with titles for triage, and two
   destination paths: **`briefsDir`** (the write dir — the collection where briefs and the
   watermark live; use it for steps 1 and 5–7) and **`briefsRoot`** (the repo's `briefs/`;
   use it for step 8's registration). The url source also returns `rawDir` (the raw-content
   cache); pass it to `renderUrl`. **Surface any `errors`/`warnings` to the user** (bad
   selectors, the "seeding a new unversioned briefs/" warning, the url channel-feed 15-video
   cap). For claude-code: the entry flagged `current` is the session this compile was invoked
   from — always compile it; skip *other* entries flagged `activeRecently` (parallel sessions
   likely mid-flight). md/url have no `current`/`activeRecently` — compile the whole queue.

3. **State the plan, don't block on it.** Report scope to the user — unit count (sessions
   or files), date span where applicable, and total substrate size from the queue's
   `newTokens` sum (NEVER from `bytes`: raw substrate overstates 30–300×) — and the window
   plan. Proceed immediately; the user can interrupt. Never wait for confirmation
   (non-interactive runs hang on questions). Report length only from what a script gives
   you: never estimate a video's duration or "minutes into the transcript" from token/byte
   counts (that guess runs 3–4× off). For a url transcript, the only length is the
   `transcript runs to <stamp>` figure `renderUrl` derives from the transcript's own
   timestamps — quote it or say nothing.

4. **Pre-scan.** Read the queue's `title`/`firstMessage` fields across the whole backlog
   to form a rough map of recurring threads before walking any session.

5. **Process oldest first, in windows.** For claude-code, group queue entries by ISO week
   of `startedAt`; for md (no chronology) take the queue's path order. For each window:
   - Re-read any briefs touched since the window started (your own writes accumulate).
   - Render each unit with the source's render script — **always pass `--briefs-dir
     <briefsDir>`**, which records the unit's watermark as you read it (this is what makes
     the watermark deterministic; step 7 commits it):
     - claude-code: `node ${CLAUDE_SKILL_DIR}/scripts/renderSession.mjs <id> --from-line <compiledLines> --briefs-dir <briefsDir>`
     - md: `node ${CLAUDE_SKILL_DIR}/scripts/renderMarkdown.mjs <id> --briefs-dir <briefsDir>` (whole-file, no offset)
     - url: `node ${CLAUDE_SKILL_DIR}/scripts/renderUrl.mjs <id> --briefs-dir <briefsDir> --raw-dir <rawDir>` (fetches via the extract endpoint on a cache miss, then caches to `rawDir`)
   - Entries with `newTokens: 0` (only chrome/meta in the new lines): still render them
     (they produce no substrate but the render records their watermark, so they don't
     re-queue). Don't write a brief for them.
   - Cluster as you read: does this material reinforce an existing brief's framing, or is
     it a genuinely new thread that deserves a new brief?

6. **Write briefs** (per FORMAT.md):
   - **Update**: integrate new material into the body — reconcile, supersede, don't
     append-only. Add the unit's id (the session id or the `md:<path>`) to `sources:`,
     bump `updated:`, and refresh `summary:` (one line, the current view distilled — the
     context skill selects by it) whenever the position moved. If the brief carries a
     `## Log` (or the new material warrants starting one), append a dated entry — newest
     last, a decision/material view-change plus its verbatim source quote(s) — while keeping
     the body above it a tight snapshot. Don't restate the body in the Log.
   - **Create**: kebab-case slug, a seeded framing, `summary:` one-liner, compiled body.
     Write the seeded framing with care: compile never revises a framing after creation,
     so this first pass is the only one it gets. New briefs need a reason to exist, a
     thread that recurs or clearly will. On a cold start, prefer fewer, denser briefs: one
     per genuinely distinct thread, never one per session.
   - **Framing discipline (the load-bearing rule):** compile seeds a framing once, on
     create, and never rewrites a framing on a later run. An existing framing is an
     instruction to you: obey it, never edit it; directives and emphasis may steer the body
     but never overwrite the framing. On conflict, flag the tension in the report. Content
     lives under the framing; the framing belongs to the human.
   - Cross-link related briefs with `[[slug]]` wikilinks.

7. **Finalize the watermark.** `node ${CLAUDE_SKILL_DIR}/scripts/finalizeState.mjs --briefs-dir <briefsDir>`
   — one call, after every brief is written. Each render in step 5 already recorded its
   unit's watermark (you passed `--briefs-dir`); this commits all of them into
   `state.json` and clears the pending file. There is no per-unit bookkeeping to remember:
   if you rendered a unit, it gets watermarked. A crash before this step commits nothing,
   so the queue simply re-runs next time — bounded re-work, never un-watermarked sessions
   that silently re-queue forever.

8. **Register the root.** Run
   `node ${CLAUDE_SKILL_DIR}/scripts/registerRoot.mjs --briefs-dir <briefsRoot>` —
   register the repo's `briefs/` **root** (`briefsRoot`), never the `to:` collection
   subfolder: the read side recurses under the root and finds every collection, so one
   registry entry per repo covers them all. Deterministic; adds it to
   `~/.clearvoid/roots.json` so the context skill and the workbench can find it. No index is
   built and no `README.md` is written: briefs are canonical and the read side scans their
   frontmatter directly.

9. **Report.** Sessions compiled, briefs created/updated (with one-line whats), threads
   you noticed but didn't promote, and a reminder that briefs are theirs to edit — fixing
   a framing is how the next compile gets smarter.

## Boundaries

- Write only inside `briefs/`. Never modify other repo files, never commit, never push.
- Never put session *content* in `state.json` — ids, counts, slugs only.
- The brief **body** is not a changelog: it's the current position, a snapshot, not a diary of updates. The dated evolution trail belongs in the optional trailing `## Log` section (see FORMAT.md), never smeared through the body.
- For orientation questions — what to compile, what briefs are good for, examples, what's coming — point the user to **https://clearvoid.ai/llms.txt** (the canonical, evolving guide), optionally fetching it to answer in place. Don't pad this skill with use-case catalogs; the website is where that content lives and changes.
