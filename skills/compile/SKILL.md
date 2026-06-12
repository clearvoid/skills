---
name: compile
description: Compile this repo's Claude Code sessions into living markdown briefs in ./briefs/ — incremental, provenance-linked, each brief a framing plus a compiled current view. Use when the user asks to compile briefs, update the briefs, compile this session, or asks what this repo's session history adds up to.
user-invocable: true
argument-hint: "[source and/or emphasis, e.g. 'pay special attention to the agency-strategy discussion in this session']"
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

The default source is **Claude Code sessions belonging to this repo**. Read
`${CLAUDE_SKILL_DIR}/sources/claude-code.md` before the first compile — it documents the
scripts, the session encoding, and the JSONL quirks. (Other sources — ChatGPT exports,
plain markdown folders — will be sibling modules under `sources/`; if the user names one
that doesn't exist yet, say so.)

## Directive

Anything typed after the skill name is a free-text directive. It can do two things: name
a **source** ("compile my ChatGPT export" — resolved per Sources above; a source with no
module yet gets "that doesn't exist yet", never reinterpreted as emphasis) and steer
**attention**. What it never does is scope *which sessions* compile: a run always
processes the full queue, oldest first — "everything since the last compile" is the
whole contract. (Session scoping was considered and rejected: with an empty queue it's a
no-op, and with a stale queue it folds material out of chronological order, letting
older sessions later overwrite newer positions.)

Emphasis steers what to attend to within that sweep — "pay special attention to the
agency-strategy discussion", "especially this session" (the queue entry flagged
`current`). Read the named thread or session with extra care and lower the bar for
promoting it to its own brief. Two guardrails:

- Emphasis never fabricates: if the material isn't actually in the sessions, report that
  rather than writing a thin brief to satisfy the directive.
- Emphasis never overrides a `framing_source: human` framing — on conflict, obey the
  framing and flag the tension in the report.

If an emphasized thread does earn a new brief, seed its framing from the directive's own
language: the one-off instruction becoming durable steering is the framing mechanism
working as intended.

The conversation stays live during a run — treat mid-run steering ("skip that one",
"that belongs in the positioning brief") as directive, not interruption.

## Process

1. **Orient.** Read every existing `briefs/*.md` (frontmatter + body). These framings are
   the lens for everything you read next. If `briefs/` doesn't exist, you're cold-starting:
   you'll be proposing the first slate of briefs and seeding their framings yourself.

2. **Get the queue.**
   `node ${CLAUDE_SKILL_DIR}/scripts/listSessions.mjs`
   Returns the repo's sessions with new content (`newLines > 0`), oldest first, with
   titles/first-messages for triage. The entry flagged `current` is the session this
   compile was invoked from — always compile it (running compile at the end of a session
   is the core ritual; lines written after this run fold in next time). Skip *other*
   entries flagged `activeRecently` (parallel sessions likely mid-flight) — they'll
   compile next run.

3. **State the plan, don't block on it.** Report scope to the user — session count, date
   span, and total substrate size from the queue's `newTokens` sum (NEVER from `bytes`:
   raw JSONL overstates substrate 30–300×) — and the window plan. Proceed immediately; the
   user can interrupt. Never wait for confirmation (non-interactive runs hang on questions).

4. **Pre-scan.** Read the queue's `title`/`firstMessage` fields across the whole backlog
   to form a rough map of recurring threads before walking any session.

5. **Process in week-sized windows, oldest first.** Group queue entries by ISO week of
   `startedAt`. For each window:
   - Re-read any briefs touched since the window started (your own writes accumulate).
   - Entries with `newTokens: 0` (only chrome/meta in the new lines): skip rendering,
     just record their watermark (step 7).
   - For each session: `node ${CLAUDE_SKILL_DIR}/scripts/renderSession.mjs <id> --from-line <compiledLines>`
   - Cluster as you read: does this material reinforce an existing brief's framing, or is
     it a genuinely new thread that deserves a new brief?

6. **Write briefs** (per FORMAT.md):
   - **Update**: integrate new material into the body — reconcile, supersede, don't
     append-only. Add the session's id to `sources:`, bump `updated:`.
   - **Create**: kebab-case slug, seeded framing (`framing_source: ai_seeded`), compiled
     body. New briefs need a reason to exist — a thread that recurs or clearly will. On a
     cold start, prefer fewer, denser briefs: one per genuinely distinct thread, never one
     per session.
   - **Framing discipline (the load-bearing rule):** a framing with
     `framing_source: human` is an instruction to you — obey it, never edit it. You may
     refine `ai_seeded` framings while the brief is young. Content lives under the
     framing; the framing belongs to the human.
   - Cross-link related briefs with `[[slug]]` wikilinks.

7. **Record progress.** After each session is folded in — per session, not batched at the
   end, so a crashed or interrupted run resumes exactly where it stopped:
   `node ${CLAUDE_SKILL_DIR}/scripts/updateState.mjs --briefs-dir <briefsDir> --session <id> --lines <lines> --touched <slugs>`
   `--lines` is the upper bound from the renderSession header (`lines: A..B` → use B), NOT
   the queue entry — the session may have grown between listing and rendering, and lines
   you didn't read must not be marked compiled.

8. **Regenerate the index.** Rewrite `briefs/README.md`: one line per brief — `[title](slug.md)` +
   the framing's first sentence. It's the folder's landing page on GitHub.

9. **Report.** Sessions compiled, briefs created/updated (with one-line whats), threads
   you noticed but didn't promote, and a reminder that briefs are theirs to edit — fixing
   a framing is how the next compile gets smarter.

## Boundaries

- Write only inside `briefs/`. Never modify other repo files, never commit, never push.
- Never put session *content* in `state.json` — ids, counts, slugs only.
- A brief is not a changelog: the body is the current position, not a diary of updates.
