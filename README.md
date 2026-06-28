# clearvoid

Compile your sessions, notes, and links into **briefs** — living markdown files that hold what each project decided, where it's heading, and why. In your repo, in files you own.

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

- a **framing** — a few sentences saying what the brief is *for*. Yours: edit it any time, and the compiler treats your edit as an instruction.
- a **current view** — everything your sessions say, read through that framing and reconciled into a position. Compiled, not retrieved: there is no chunk anywhere that contains "what this project actually thinks," so the skill builds it.

Each compile is incremental (a content-free watermark in `briefs/.clearvoid/state.json` tracks how far each session has been read) and provenance-linked (every brief lists the sessions it came from).

The full file contract lives in [skills/compile/FORMAT.md](skills/compile/FORMAT.md).

## Recall loads only what's relevant

When you pull briefs back into a conversation with `recall`, it doesn't dump the whole library. It reads each brief's frontmatter (title, one-line `summary:`, last updated), picks the few relevant to what you're working on, and loads only those — that's what the `summary:` line is for, and why every brief has one. It reads the brief files directly each time, so the selection is always current: there's nothing to rebuild or keep in sync.

## Briefs across projects

Repo briefs live with their repo. For everything else — research tied to no project — there's a **personal root** (default `~/clearvoid/briefs`), and a registry at **`~/.clearvoid/roots.json`** listing every place briefs live: the compile skill auto-registers a repo's `briefs/` on first compile, so the registry builds itself. The `recall` skill resolves the repo you're in plus the registry's other roots — ask a question in any project and your cross-project briefs are reachable. The desktop workbench reads the same file: one multi-root contract for every client. Reading aggregates across roots; compiling never writes outside the root you point it at.

Loading briefs back into a conversation is the `recall` skill: `/clearvoid:recall [topic]` resolves your roots, scans your briefs' frontmatter, and loads only the relevant ones.

## Local by construction

- No account, no API key, no uploads. The skill runs inside your own Claude Code, against session files already on your disk, using the subscription you already have.
- Briefs are plain markdown — they render on GitHub, in Obsidian, in your editor.
- Nothing leaves your machine unless you commit it. Which also means a team shares one compiled view through ordinary git: each person compiles their own sessions locally, and the diff is the review.
- Writes are confined to `briefs/`. Deleting that folder is a complete reset.

## Installing without a marketplace (locked-down machines)

If you can't add a remote plugin marketplace — a managed work machine, a security team that flags installs — you don't need one. The skill is plain files (Node with no npm packages, plus git), and nothing contacts a network *except* the optional `url:` source, which only runs when you explicitly pass a `url:`. Compiling your own sessions never leaves the machine. Two ways to run it with no remote install:

- **Local plugin install.** Download this repo as a zip (the green **Code → Download ZIP**, or a tagged release) and unzip it anywhere. Then, inside Claude Code, point the marketplace at the local folder instead of a remote:

  ```
  /plugin marketplace add /path/to/clearvoid-skills
  /plugin install clearvoid@clearvoid
  ```

  Both commands read from the unzipped folder — no remote fetch. Then use `/clearvoid:compile` and `/clearvoid:recall` as normal.

- **By reference, no install at all.** Drop the unzipped folder into your repo and just tell Claude to follow the skill — e.g. *"follow `skills/compile/SKILL.md` and compile this repo's sessions into briefs"* (and `skills/recall/SKILL.md` to load them). The skill files mention `${CLAUDE_SKILL_DIR}`: outside the plugin harness that's simply the folder the `SKILL.md` lives in, so read the script paths relative to that.

## Compiling URLs (articles, tweets, YouTube)

Briefs don't have to come from your sessions. Point compile at a URL with the `url:` prefix and it becomes clean markdown substrate — then compiles into briefs exactly like a session:

```
/clearvoid:compile url:https://www.youtube.com/watch?v=<id>
/clearvoid:compile url:https://example.com/some-article
/clearvoid:compile url:https://x.com/<user>/status/<id>
```

- **What it handles:** articles, tweets/threads, and YouTube videos (the transcript). Pass several at once, space-separated (each becomes its own source), and a leading `https://…` works even without the `url:` prefix.
- **YouTube channels:** `url:channel:<UC…>` or a `https://youtube.com/@handle` URL fans out to the channel's ~15 most recent videos (via its public RSS feed — re-run later to pick up new uploads).
- **Where it lands:** run it in the repo where you want the briefs. Each URL is fetched once and cached locally under `raw/`, and produces both a brief (synthesis across your sources) and a per-source report (`raw/<key>.report.md` — a faithful in-order reading view, a briefs-updated cross-reference, the non-obvious takeaways, and specific skeptical pushbacks). Compiled URLs appear in each brief's `sources:` as provenance, and a once-compiled URL won't re-compile on its own (re-running a changed page is an explicit re-run).

**This is the one source that uses the network.** Compiling your sessions or local files is fully offline; `url:` sends *only the URL you pass* to a hosted extractor (free and open, with a usage cap + per-IP rate limit as the guardrails) which returns the clean markdown. Your other content never touches it, and nothing runs unless you actually type a `url:`. To point it at your own deployment, set `CLEARVOID_EXTRACT_URL` (and `CLEARVOID_EXTRACT_TOKEN` if it's locked down).

## Scope

**Today:** Claude Code sessions (per repo — the sessions whose working directory is the repo you run the skill in, `.claude/worktrees` included), local markdown files or folders (`md:<path>`), and any URL — article, tweet, or YouTube video (`url:<url>`).

**Next:** more sources for the same skill and the same files — ChatGPT exports — and a cross-project personal root. Source modules land under [skills/compile/sources/](skills/compile/sources/).

The optional desktop workbench (navigate briefs, edit framings, trace provenance) lives at [clearvoid.ai](https://clearvoid.ai). The skill doesn't need it.

## Feedback

Run it on a real repo and [open an issue](https://github.com/clearvoid/skills/issues) with what it produced — especially where it's wrong: a framing it shouldn't have seeded, a position it got backwards, a thread it missed. The failure modes are the interesting part.

## License

[MIT](LICENSE) © Baseline Reset LLC
