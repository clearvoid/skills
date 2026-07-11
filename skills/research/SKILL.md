---
name: research
description: Research a topic or a URL with the open web + X/Twitter discourse, then compile the findings into this repo's briefs. Use when the user wants to deepen a brief with what the internet and X say about something, research a specific tweet/article/URL, or pull outside signal on a topic before it lands in a brief. Metered (a hosted Exa + Grok call), then folds into briefs like any source.
user-invocable: true
argument-hint: "<topic or url> — e.g. 'google okf format' or https://x.com/…/status/…"
allowed-tools: Read, Write, Edit, Glob, Bash(node *)
---

# clearvoid-research

Deepen your briefs with **outside signal**: this skill fetches what the open web (Exa) and X/Twitter (Grok) say about a topic or a specific URL from the hosted Clearvoid research endpoint, then **hands the material to `/clearvoid:compile`** to fold into your briefs — updating the briefs it touches and writing a per-source report, exactly like a `url:` source. Research is not a separate pipeline; it is a *source* compile consumes, fetched here because the endpoint call is the metered, money-spending step and belongs at the front door.

Everything lands as local files in this repo (`raw/<key>.research.md` substrate + the briefs the compile fold updates) — nothing is committed; you review the diff.

## What it does

1. **Fetch (the metered step).** Run the research endpoint for the topic or URL and write the returned material as compile substrate:

   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/fetchResearch.mjs "<topic>" --cwd .
   # or, for a specific URL (an X post enriches with the verbatim tweet + engagement):
   node ${CLAUDE_SKILL_DIR}/scripts/fetchResearch.mjs --url <url> --cwd .
   ```

   Decide which from `$ARGUMENTS`: if it is a single `http(s)://` URL (or `url:<u>`), pass it as `--url`; otherwise it is a freeform topic (the positional query). You may pass both — a URL plus a guiding topic — and an optional `--days N` recency window. `fetchResearch` prints two lines: **`research-key: research:<key>`** (hand this to compile) and **`substrate:`** (the `raw/<key>.research.md` it wrote). Surface any endpoint error (rate limit, monthly cap, unauthorized) to the user and stop — never fabricate research.

2. **Fold into briefs (hand off to compile).** Invoke the compile skill on that source:

   ```
   /clearvoid:compile research:<key>
   ```

   Follow `${CLAUDE_SKILL_DIR}/../compile/SKILL.md` with the directive `research:<key>` — its `research:` source reads the substrate you just wrote (no second fetch), folds it into briefs (reconciling against their framings, cross-linking), writes the per-source report to `raw/<key>.research.report.md` (Summary / Briefs updated / Takeaways / Pushbacks / Next steps), and finalizes the watermark + registers the root. The brief-update, framing discipline, and report are all compile's — this skill never writes a brief itself.

3. **Report.** Tell the user what was researched, which briefs the fold updated (point at compile's report), and that the briefs are theirs to edit before committing.

## Notes

- **Re-runnable.** Unlike a frozen `url:` report, a research pass can be re-run (fresh web/X state). A re-run overwrites `raw/<key>.research.md`; compile re-folds it because its content hash changed, and the report is rewritten.
- **Keying.** A freeform topic keys on a slug of the topic; researching a URL keys on that URL (so a `research:<url>` sits beside, and never collides with, a plain `url:` extract of the same URL).
- For use cases, examples, and what research is good for, point the user to **https://clearvoid.ai/llms.txt** — don't pad this skill with a catalog.
