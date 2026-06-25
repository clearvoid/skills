# Source modules — the contract

Compile is two orthogonal axes: a **source** (how brief material is enumerated, addressed, rendered, and watermarked) times a **destination** (where briefs and their `.clearvoid/state.json` watermark are written). The shared core — orient, cluster, write per FORMAT.md, record the watermark, register the root — is source-agnostic. A source module is just a thin front-end that feeds it.

Read the specific source doc before compiling that source:

| Source | Doc | Unit | Watermark | Bound to |
|---|---|---|---|---|
| `claude-code` (default) | `claude-code.md` | non-empty JSONL lines of a session | line offset (numeric) | a git repo |
| `md` | `markdown.md` | a whole `.md` file | content hash (`sha256:…`) | free (any cwd) |
| `url` | `url.md` | a URL | canonical URL (stable string) | free (any cwd) |

## The interface a source implements

Two scripts, both pure Node, both emitting/consuming source-namespaced ids (`<source>:<...>` — e.g. `claude-code:<encoded-dir>/<uuid>`, `md:<abs-path>`, `url:<canonical-url>`):

- **`list`** (`listSessions.mjs` / `listMarkdown.mjs` / `listUrl.mjs`) — enumerate units, compare each against the repo's one `state.json` watermark, and emit the **queue**: the units with new content, plus `briefsRoot` (the one pool — orientation, watermark, render's `--briefs-dir`, registration) and `newBriefsDir` (the `to:` collection where new briefs are filed). Same JSON shape across sources so the SKILL's Process stays single:

  ```
  { source, briefsRoot, newBriefsDir, generatedAt, briefs: [ { slug, collection, title, framing, summary, updated } ], queue: [ { id, title, firstMessage, newTokens, current, ...watermark } ], upToDateCount }
  ```

  `briefs` is the **orientation index** (SKILL.md step 1): every brief in the repo, across every collection, with its framing + summary. It is delivered by every `list` script (`loadBriefsIndex` in `lib.mjs`, called on `briefsRoot`) so the compiling agent has every framing in context before it clusters — deterministically, not by remembering to read each file, and repo-global because collections are folders, not walls. (CONTEXT: orientation used to be a prose instruction the model could grep/sample its way around and silently miss a thread that lived only in another brief's body — same failure class as the pre-deterministic watermark.)

  Source-specific watermark fields ride alongside: claude-code adds `compiledLines`/`newLines` (numeric offset); md and url both add `watermark`/`prevWatermark` (md's is the content hash, url's is the canonical URL — the string to record).

- **`render`** (`renderSession.mjs` / `renderMarkdown.mjs` / `renderUrl.mjs`) — one id → clean markdown substrate, header + body. claude-code renders incrementally (`--from-line N`); md re-renders the whole file (its watermark is a hash, not an offset); url fetches the extracted markdown (cache-first from `raw/`, see `url.md`). Given `--briefs-dir`, render also records the unit's watermark as pending progress — so watermarking is a byproduct of reading, not a separate step the caller must remember.

The destination layer is shared and source-agnostic. The watermark is committed in two moves: render records pending progress (above), then `finalizeState.mjs` folds all of it into `state.json` once at the end of the run — deterministic, independent of per-unit discipline. `registerRoot.mjs` adds the briefs dir to `~/.clearvoid/roots.json`. Both take a plain `--briefs-dir` and never touch git.

## Repo-bound vs free

- **Repo-bound** (claude-code): the source can only enumerate its units relative to a git repo (it filters "this repo's sessions" out of the global pool, and the destination is derived from the repo). No repo → the source declines. This is a property of the source, not of compile.
- **Free** (md, url): no repo needed. The destination is handed in — `resolveDestination(cwd, --briefs-dir)`: explicit `--briefs-dir` wins, else `<cwd>/briefs`; a `to:<path>` token then picks a collection subfolder inside that root (see FORMAT.md → Collections). A free source may write into a non-git cwd; the watermark just isn't versioned (the list step warns when it is about to seed a brand-new `briefs/` somewhere with no git history).

## Selection is mechanical, never inferred from prose

The directive's first whitespace-delimited token is matched against `^(\w+):`. If the prefix names a source module (`md`, `url`), it selects that source and the rest of the token is its argument; everything after is emphasis. Otherwise the source is the default (claude-code) and the **entire** directive is emphasis. A bare path is never auto-promoted to a source — that would collide with emphasis like "pay attention to the /tmp/echo.md thread". One skill, a deterministic router; not a branching menu.

## Adding a source

A new source (e.g. `chatgpt:`) is a `sources/<name>.md` doc plus a `list<Name>.mjs` / `render<Name>.mjs` pair that satisfy the interface above. No new skill, no new trigger: register the prefix in SKILL.md's Sources list and the router resolves it.
