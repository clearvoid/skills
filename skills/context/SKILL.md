---
name: context
description: Load the user's compiled briefs relevant to the current conversation — resolves the current repo's briefs plus every registered root (other repos), scans their frontmatter to build a selection list, and loads only the relevant briefs. Use when the user asks to load brief context, asks what their briefs say about something, or before strategy/research/direction work in a repo that has briefs.
user-invocable: true
argument-hint: "[topic to focus the selection, e.g. 'pricing decisions']"
allowed-tools: Read, Bash(node *), Glob
---

# clearvoid-context

The read side of briefs: pull the user's compiled state into the conversation — selectively. Briefs are a per-session token cost; the job is to load the few that matter, not the library.

## Process

1. **Resolve the roots and their briefs.**
   `node ${CLAUDE_SKILL_DIR}/scripts/resolveRoots.mjs`
   Returns the current repo's `briefs/` plus the registry (`~/.clearvoid/roots.json`): the other registered repos, and for each one a line per brief (slug, title, summary, updated, and `collection`) read straight from the files' frontmatter. It walks each root recursively, so briefs nested in collection subfolders are included; `collection` is the brief's folder path relative to the briefs root (`""` for top-level, e.g. `yc-ai` or `ai/agents` for nested ones).

2. **Select from that list, don't open files to triage.** The per-brief lines from step 1 are the selection surface — title, summary, recency, and collection are enough to choose. There is no separate index to read; the scan already gave you what a `README.md` index used to. When a root has briefs across several collections, you may group or label the list by collection so the user sees the structure.

3. **Select.** Pick the briefs relevant to the directive (`$ARGUMENTS`) or, with no directive, to the current conversation's topic. Be selective — typically 2–5 briefs, weighted toward the current repo's root; pull from other repos only when the topic clearly crosses projects. Recency (`updated`) breaks ties. A collection is a deliberate grouping (e.g. video briefs vs CRM briefs) — let it inform relevance.

4. **Load.** Read each selected brief in full at its path: `<briefsDir>/<collection>/<slug>.md`, or `<briefsDir>/<slug>.md` when `collection` is `""`. The framing tells you what the brief is for — read the current view through it.

5. **Report and apply.** One line per loaded brief ("loaded *X* — <its one-line summary>"), note anything relevant you deliberately skipped (so the user can ask for it), then continue the task with the loaded state as context.

## Boundaries

- **Read-only.** Never write, edit, or reorganize briefs from this skill — corrections belong to `/clearvoid:compile` runs or the user's own edits.
- No roots or empty registry → say so plainly and point at `/clearvoid:compile` (and that compiling a repo registers it). Never fabricate brief content.
- The selection list is read live from the brief files, so it is never stale — there is no index to refresh and nothing for this skill to regenerate.
