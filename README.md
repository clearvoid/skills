# clearvoid

Compile your Claude Code sessions into **briefs** — living markdown files that hold what
each project decided, where it's heading, and why. In your repo, in files you own.

```
npx skills add clearvoid/skills
```

or, inside Claude Code:

```
/plugin marketplace add clearvoid/skills
/plugin install clearvoid@clearvoid
```

Then run `/clearvoid:compile` in any repo you've worked in, and read `briefs/`.

## What a brief is

A brief is a markdown file with two parts:

- a **framing** — a few sentences saying what the brief is *for*. Yours: edit it any
  time, and the compiler treats your edit as an instruction.
- a **current view** — everything your sessions say, read through that framing and
  reconciled into a position. Compiled, not retrieved: there is no chunk anywhere that
  contains "what this project actually thinks," so the skill builds it.

Each compile is incremental (a content-free watermark in `briefs/.clearvoid/state.json`
tracks how far each session has been read) and provenance-linked (every brief lists the
sessions it came from).

The full file contract lives in [skills/compile/FORMAT.md](skills/compile/FORMAT.md).

## The index: `briefs/README.md`

Every compile regenerates `briefs/README.md` deterministically — one line per brief (title, one-line summary, last updated). It does two jobs:

1. **The human navigator.** GitHub renders it as the folder's landing page, and it resolves the one thing GitHub can't: cross-brief navigation (wikilinks don't link there). Someone browsing your repo reads the index and knows what the project thinks in ten seconds.
2. **The machine selection surface.** The read-side `context` skill works by progressive disclosure: it reads the index, picks the briefs relevant to the conversation, and loads only those — the index is its table of contents, which is why it carries summaries and not just titles.

It's regenerated on every compile — treat it as generated output, not a file you edit (your edits belong in the briefs themselves, especially framings).

## Briefs across projects

Repo briefs live with their repo. For everything else — research tied to no project — there's a **personal root** (default `~/clearvoid/briefs`), and a registry at **`~/.clearvoid/roots.json`** listing every place briefs live: the compile skill auto-registers a repo's `briefs/` on first compile, so the registry builds itself. The `context` skill resolves the repo you're in plus the registry's other roots — ask a question in any project and your cross-project briefs are reachable. The desktop workbench reads the same file: one multi-root contract for every client. Reading aggregates across roots; compiling never writes outside the root you point it at.

Loading briefs back into a conversation is the `context` skill: `/clearvoid:context [topic]` resolves your roots, reads the indexes, and loads only the relevant briefs.

## Local by construction

- No account, no API key, no uploads. The skill runs inside your own Claude Code, against
  session files already on your disk, using the subscription you already have.
- Briefs are plain markdown — they render on GitHub, in Obsidian, in your editor.
- Nothing leaves your machine unless you commit it. Which also means a team shares one
  compiled view through ordinary git: each person compiles their own sessions locally,
  and the diff is the review.
- Writes are confined to `briefs/`. Deleting that folder is a complete reset.

## Scope

**Today:** Claude Code sessions, per repo (the sessions whose working directory is the
repo you run the skill in — `.claude/worktrees` included).

**Next:** more sources for the same skill and the same files — ChatGPT exports, plain
document folders — and a cross-project personal root. Source modules land under
[skills/compile/sources/](skills/compile/sources/).

The optional desktop workbench (navigate briefs, edit framings, trace provenance) lives
at [clearvoid.ai](https://clearvoid.ai). The skill doesn't need it.

## Feedback

Run it on a real repo and [open an issue](https://github.com/clearvoid/skills/issues)
with what it produced — especially where it's wrong: a framing it shouldn't have seeded,
a position it got backwards, a thread it missed. The failure modes are the interesting
part.

## License

[MIT](LICENSE) © Baseline Reset LLC
