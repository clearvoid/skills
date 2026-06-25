# Source module: Claude Code sessions

How the default source works — read once before the first compile.

## Where sessions live

Claude Code writes one JSONL per session under `~/.claude/projects/<encoded-dir>/<uuid>.jsonl`, where `<encoded-dir>` is the session's cwd with `/` and `.` both replaced by `-` (`/Users/x/repo` → `-Users-x-repo`; a `/.` boundary renders as `--`). `listSessions.mjs` matches every dir equal to the repo root's encoding **or prefixed by it + `-`** — which catches subdirectory sessions and `.claude/worktrees/*` sessions automatically.

Known gaps, mention them if the user asks why a session is missing:
- **External worktrees** (worktrees outside the repo, e.g. `~/worktrees/...`) encode under their own path and are not matched.
- **The ~30-day purge**: Claude Code deletes old JSONLs. Compile regularly; provenance pointers in old briefs may dangle after purge — that's expected and fine.

## The scripts

All pure Node, no dependencies, run with `node`:

| Script | Job |
|---|---|
| `listSessions.mjs [--cwd <path>]` | The queue: repo sessions vs the state watermark. JSON. |
| `renderSession.mjs <id> [--from-line N] [--briefs-dir <p>]` | One session → clean markdown substrate; `--briefs-dir` records its watermark. |

Session ids are source-namespaced: `claude-code:<encoded-dir>/<uuid>`. Use the full id everywhere (state, frontmatter `sources:` lists).

**Units are non-empty JSONL lines.** The watermark stores the absolute line count compiled through; `renderSession --from-line` resumes there. Sessions grow — a session can appear in the queue again with only its tail to read.

**Recording it is automatic.** Rendering with `--briefs-dir` records the watermark (the line count read) as pending progress; `finalizeState.mjs` commits it once at the end of the run (see `sources/README.md`). There is no per-session call to remember.

## What the renderer gives you

`renderSession.mjs` outputs a header (title, branch, time span, line range) then chunks:

- Only real user/assistant text turns survive: thinking, tool calls/results, harness chrome (`<system-reminder>`, IDE injections, bash output, slash-command ceremony) are stripped. Slash-command turns are unwrapped to their `<command-args>` payload.
- Chunks split at `/compact` boundaries; a chunk opening with `PRIOR-SESSION-SUMMARY:` is the recap Claude Code injected when the session continued past compaction — treat it as context for the turns after it, not as new primary material.
- An incremental render (`--from-line > 0`) has no earlier context by design — the brief you're updating IS the context.

## Reading guidance

- `~tokens` per chunk tells you pacing; very large sessions are normal (whole working days). Read fully — the substance is often in the late-session corrections.
- The user's corrections and pushbacks are the most reliable signal of their actual position — weight them over the assistant's summaries.
- Sessions are work artifacts: decisions, reversals, dead ends. A brief should compile *positions and reasons*, not narrate the chronology.
