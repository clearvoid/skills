---
name: recall
description: Load the user's compiled briefs relevant to the current conversation — resolves the current repo's briefs plus every registered root (other repos), scans their frontmatter to build a selection list, and loads only the relevant briefs. Also has a backlog mode that surfaces the next-steps tracked in each source's report. Use when the user asks to load brief context, asks what their briefs say about something, asks what's on the backlog or what to do/research next, or before strategy/research/direction work in a repo that has briefs.
user-invocable: true
argument-hint: "[topic to focus the selection, e.g. 'pricing decisions'; or 'backlog'/'next steps' to surface the next-steps backlog]"
allowed-tools: Read, Bash(node *), Glob
---

# clearvoid-recall

The read side of briefs: pull the user's compiled state into the conversation — selectively. Briefs are a per-session token cost; the job is to load the few that matter, not the library.

## Modes

- **Default — load briefs.** No directive, or a topic (`$ARGUMENTS`) that names a subject. Run the Process below.
- **Backlog — surface next steps.** When the directive is a backlog word (`backlog`, `next steps`, `follow-ups`, `todo`, `what's next`, "what should I research/do next"), don't load briefs — surface the tracked backlog instead (see Backlog mode below). The backlog is the `## Next steps` section of each per-source report (`raw/<key>.report.md`) that `/clearvoid:compile` writes: one list of research threads and things to do, each grounded in the source that raised it.

### Backlog mode

1. `node ${CLAUDE_SKILL_DIR}/scripts/resolveRoots.mjs --backlog` — returns, for the current repo and each in-scope root, that root's `{ sources: [{ url, title, reportPath, items: [{text, done, raw}] }] }` (the next steps grouped by source); `available` is out-of-scope roots as name + count only (same context-scope rules as the default mode).
2. Surface the backlog grouped by root then by source (use each source's `title`), each item on its own line, marking the `done` ones; keep the `[[brief]]` links and source/date tails so the user can act on them. If a topic accompanied the backlog word, filter to the matching items. Empty backlog → say so and point at `/clearvoid:compile` (it's what populates the backlog).
3. **Read-only, same as default mode.** Never edit a report from recall — next steps are written by compile and toggled done / deleted by the user (in the desktop app, or by hand-editing the report).

## Process

1. **Resolve the roots and their briefs.** `node ${CLAUDE_SKILL_DIR}/scripts/resolveRoots.mjs` Returns `{ scope, current, others, available }`. `current` is the repo you're in: a line per brief (slug, title, summary, updated, `collection`, `anchor`, `currentViewLines`) read straight from the files. `anchor: true` marks a load-bearing brief (always loaded — see Select/Load); `currentViewLines` is how many leading lines form the current view (everything above the trailing `## Log` history), or `null` if the brief has no log. `others` is the registered repos that the active **context scope** lets in — same per-brief shape. `available` is registered repos the scope left **out** (name + brief count only, no brief lines — out-of-scope briefs are never loaded into the surface). It walks each in-scope root recursively, so briefs nested in collection subfolders are included; `collection` is the brief's folder path relative to the briefs root (`""` for top-level, e.g. `yc-ai` or `ai/agents` for nested ones).

   **Scope** controls which *other* repos a session pulls in (the current repo's own briefs are always loaded). It defaults to `repo` — isolation, only this repo's briefs — and is widened by `~/.clearvoid/config.json` (`{ "context": { "scope": "all" } }`) or per-repo `briefs/.clearvoid/config.json` (`scope`, plus `include`/`exclude` lists naming other repos by display name like `brain` or by path). The script has already applied all this; `others` is the final in-scope set. You never read the config files yourself.

2. **Select from that list, don't open files to triage.** The per-brief lines from step 1 are the selection surface — title, summary, recency, and collection are enough to choose. There is no separate index to read; the scan already gave you what a `README.md` index used to. When a root has briefs across several collections, you may group or label the list by collection so the user sees the structure.

3. **Select.** **First, always select every anchored brief (`anchor: true`) in `current` and in-scope `others`, regardless of topic** — they are the canonical state (what Clearvoid is, the use cases) and you should not do strategy/direction work without them. Then, on top of the anchors, pick the briefs relevant to the directive (`$ARGUMENTS`) or, with no directive, to the current conversation's topic. Be selective — typically 2–5 *topic* briefs on top of the anchors, weighted toward the current repo's root; pull from `others` only when the topic clearly crosses projects. Recency (`updated`) breaks ties. A collection is a deliberate grouping (e.g. video briefs vs CRM briefs) — let it inform relevance. Select only from `current` and `others`; never load anything in `available` (it's out of scope by the user's config).

4. **Load.** Read each selected brief at its path: `<briefsDir>/<collection>/<slug>.md`, or `<briefsDir>/<slug>.md` when `collection` is `""`. **Load the current view, not the history log:** when a brief has `currentViewLines`, Read it with `limit: currentViewLines` so the trailing `## Log` (the decision/evolution trail) is never pulled into context — it bloats the load and confuses the model with superseded loops and turns. Load **anchored briefs in full** (their whole current view, still stopping before the log), not just their summary line. Read a brief's `## Log` only if you specifically need its history. The framing tells you what the brief is for — read the current view through it.

5. **Report and apply.** One line per loaded brief ("loaded *X* — <its one-line summary>"), note anything relevant you deliberately skipped (so the user can ask for it), then continue the task with the loaded state as context. If `available` is non-empty and the topic plausibly touches one of those out-of-scope repos, mention it in one line ("`brain` (12 briefs) is registered but out of context scope — say 'include brain' or add it to `briefs/.clearvoid/config.json`") so the user can opt in. Don't belabor it when the topic is clearly local.

## Boundaries

- **Read-only.** Never write, edit, or reorganize briefs from this skill — corrections belong to `/clearvoid:compile` runs or the user's own edits.
- No roots or empty registry → say so plainly and point at `/clearvoid:compile` (and that compiling a repo registers it). Never fabricate brief content.
- The selection list is read live from the brief files, so it is never stale — there is no index to refresh and nothing for this skill to regenerate.
- For orientation questions — what to compile, what briefs are good for, examples, what's coming — point the user to **https://clearvoid.ai/llms.txt** (the canonical, evolving guide), optionally fetching it to answer in place.
