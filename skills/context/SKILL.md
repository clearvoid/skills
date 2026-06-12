---
name: context
description: Load the user's compiled briefs relevant to the current conversation — resolves the current repo's briefs plus every registered root (personal + other repos), reads the indexes, and loads only the relevant briefs. Use when the user asks to load brief context, asks what their briefs say about something, or before strategy/research/direction work in a repo that has briefs.
user-invocable: true
argument-hint: "[topic to focus the selection, e.g. 'pricing decisions']"
allowed-tools: Read, Bash(node *), Glob
---

# clearvoid-context

The read side of briefs: pull the user's compiled state into the conversation — selectively. Briefs are a per-session token cost; the job is to load the few that matter, not the library.

## Process

1. **Resolve the roots.**
   `node ${CLAUDE_SKILL_DIR}/scripts/resolveRoots.mjs`
   Returns the current repo's `briefs/` plus the registry (`~/.clearvoid/roots.json`): the personal root and other registered repos, each with its index path and brief count.

2. **Read the indexes, not the briefs.** For each root that has an index, Read its `briefs/README.md` — one line per brief (title, summary/framing, updated). This is the selection surface; it exists so you don't open files to find out what they are.

3. **Select.** Pick the briefs relevant to the directive (`$ARGUMENTS`) or, with no directive, to the current conversation's topic. Be selective — typically 2–5 briefs, weighted toward the current repo's root; pull from the personal root and other repos only when the topic clearly crosses projects. Recency (`updated`) breaks ties.

4. **Load.** Read each selected brief in full. The framing tells you what the brief is for — read the current view through it.

5. **Report and apply.** One line per loaded brief ("loaded *X* — <its one-line summary>"), note anything relevant you deliberately skipped (so the user can ask for it), then continue the task with the loaded state as context.

## Boundaries

- **Read-only.** Never write, edit, or reorganize briefs from this skill — corrections belong to `/clearvoid:compile` runs or the user's own edits.
- No roots, no indexes, or empty registry → say so plainly and point at `/clearvoid:compile` (and that compiling a repo registers it). Never fabricate brief content.
- If an index looks stale relative to the brief files (missing entries), mention that a compile would refresh it — don't regenerate it yourself.
