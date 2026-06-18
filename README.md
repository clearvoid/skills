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

## Selecting briefs (no generated index)

There's no generated index file — the brief files are the only artifact compile writes. When the read-side `context` skill pulls briefs into a conversation it works by progressive disclosure: it scans each brief's frontmatter (title, one-line summary, last updated) on demand, picks the briefs relevant to the conversation, and loads only those. The `summary:` line carries that selection, which is why every brief has one. The scan reads the files directly, so the selection surface is always current — nothing to regenerate, nothing to fall out of date.

## Briefs across projects

Repo briefs live with their repo. For everything else — research tied to no project — there's a **personal root** (default `~/clearvoid/briefs`), and a registry at **`~/.clearvoid/roots.json`** listing every place briefs live: the compile skill auto-registers a repo's `briefs/` on first compile, so the registry builds itself. The `context` skill resolves the repo you're in plus the registry's other roots — ask a question in any project and your cross-project briefs are reachable. The desktop workbench reads the same file: one multi-root contract for every client. Reading aggregates across roots; compiling never writes outside the root you point it at.

Loading briefs back into a conversation is the `context` skill: `/clearvoid:context [topic]` resolves your roots, scans your briefs' frontmatter, and loads only the relevant ones.

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
