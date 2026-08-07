# Source module: chat threads (`chat:`)

A **free** source that folds **brief-primed chat threads** into briefs — the high-level life/mood/philosophy conversations you have with a frontier model primed with your briefs (chrome-home's Briefs tab is the reference server). The threads are your own raw material, the same class as Claude Code sessions, not external content to critique. No repo required; you compile threads into whatever repo's `briefs/` you point at. Read once before the first chat compile. The interface this satisfies is in `sources/README.md`.

Unlike sessions, chat **writes a per-source report** (`raw/chat-<id>.report.md`). The reason sessions don't and chat does: the thread transcript is **not saved locally** (a chat source refers to its thread by id only), so the report is the sole durable local artifact of what the thread explored and fed into the briefs — and it carries the title, so the desktop Sources tab stays legible when the chat server is down. Report framing (per the report contract in SKILL.md): the lens is "what this thread worked through and contributed," not `url`'s external-content critique. Its `## Summary` is a **full reading view** (proportional to thread length, like `url`/`md`) — the transcript has no local copy, so the report's Summary is all a reader has. The report is **re-writable** on re-queue (threads grow), same as `md`/`research`.

## Selecting it

`/clearvoid:compile chat: [emphasis]` — a bare `chat:` selects the source and enumerates **all** brief-primed threads (watermark-filtered). To scope to specific threads, pass their ids: `chat:<thread-id> [<thread-id2>…]` (a leading `chat:` on each token is accepted and stripped). Everything after the selector token(s) is emphasis (see the SKILL's Directive section).

## The scripts

| Script | Job |
|---|---|
| `listChat.mjs [<thread-id>...] [--cwd <p>] [--briefs-dir <p>] [--to <p>]` | The queue: brief-primed threads vs the watermark. Hits `GET /chat/briefs-threads` **once** (metadata only, no bodies). Stub JSON on stdout naming the full payload file (Read it whole — SKILL.md step 1). |
| `renderChat.mjs <chat:id-or-id> [--briefs-dir <p>] [--raw-dir <p>]` | One thread → substrate: header + a `substrate:` file holding the verbatim thread markdown (a transient temp file, not a repo copy — the body never rides stdout); resolves messageCount from `briefs-threads`, fetches the body, records its watermark, and prints the `report-target` (`raw/chat-<id>.report.md`) for step 6. |

`listChat` emits the shared queue shape (`{ source, briefsRoot, newBriefsDir, briefs, queue, upToDateCount }`) plus, per entry, `messageCount`, `updatedAt`, `briefsFilter` (the routing hint), and `watermark`/`prevWatermark` (the messageCount). It emits `errors` (a down/unreachable API — surface it: "is the chrome-home server running?") and `warnings` (the free-source "seeding a new unversioned briefs/" warning) — surface both. Because the substrate lives behind the API, `newTokens` is `0` until `renderChat` fetches the body; `firstMessage` is the thread's first user message.

## Units & watermark

**The unit is a thread; the watermark is its `messageCount`** — a monotonic integer, stored as `units` in `state.json` under the id `chat:<thread-id>`. Threads are *mutable* (they grow), so unlike a frozen `url` a thread **re-queues when it grows** (its messageCount exceeds the recorded watermark); on re-queue the **whole thread** is re-rendered and the agent reconciles the new material into the brief (the Update step in SKILL.md — reconcile, don't append-only). An edit that doesn't add messages does **not** auto-re-queue — re-compiling a mutated thread is an explicit re-run (drop the watermark), same posture as `url`'s stable-URL watermark. A thread with `messageCount 0` is skipped (nothing to compile); deleted and private threads never appear in `briefs-threads`.

`briefsFilter` rides in the queue entry as a **routing hint** for the compiling agent — `null` means the thread ranges over all briefs, `{tags:[…]}` means it was scoped to a subject area, so its insights route toward the brief(s) carrying those tags. It is never a queue filter.

## Folding discipline: attribution, register, corrections

A chat thread is a conversation **with an assistant**, and the assistant's own language is part of the transcript. Compiled carelessly, the assistant's framings get laundered into the briefs as the user's own words, primed back into the next chat session as "his" positions, and quoted back at him — a feedback loop that manufactures the user's views and erodes trust. These rules exist because that loop happened; they bind the Update step (SKILL.md) for every chat unit:

- **Only the user's words are the user's.** A framing the assistant proposed — a metaphor, a diagnosis, a summary line — is not the user's position unless he explicitly takes it up in his own words. Assent-shaped topic-closers ("yeah", "fair enough", "there's no point pushing this further") are **not** adoption. Never write "he named/called/said X" for words the assistant introduced; either attribute honestly ("the assistant framed it as X; he didn't take that up") or leave it out.
- **Quote him verbatim where it matters, qualifiers included.** "A bit colder" is not "colder". A statement about one bounded pattern must never be compiled into a claim about a whole person, relationship, or life — the sweeping version reads well and is wrong, and the user has named this exact failure ("you take things from the briefs as his literal thing when it's obviously hyperbolic").
- **Vent register is not a settled view.** In-the-moment absolutes, hyperbole, and late-night venting get recorded as what they were — a dated moment — if recorded at all, and never promoted into a brief's `framing:` or `summary:` as his operating position. When it is unclear whether something was vent or verdict, the brief says so rather than picking the stronger reading.
- **An in-thread correction outranks what it corrects, everywhere.** When the user pushes back on a framing in the thread, that correction wins across **all** briefs in this repo — if the corrected framing already sits in another brief from a previous render, fix it there **in the same run**: restore his verbatim words, reattribute or delete the assistant's phrasing, don't leave it standing as his while logging the correction elsewhere. This is the one case where the Update step deliberately reaches into a brief the thread's new messages didn't otherwise touch; use `sessionBriefMap`/provenance to find where the earlier render of this same thread wrote.

## Destination

`resolveDestination(cwd, --briefs-dir)` for the briefs **root**, then `resolveCollection(root, --to)` for the write dir (a `to:` collection subfolder, or the root itself). Explicit `--briefs-dir` wins, else `<cwd>/briefs`. Like `md`/`url` there is no repo requirement — you run compile where you want the briefs to land; `listChat` warns loudly when it is about to seed a brand-new `briefs/` in a place with no git history and no prior registration. To land chat-sourced briefs in a repo, point `--briefs-dir` at `<repo>/briefs`.

## The API contract

The source is defined against a small contract, not against chrome-home specifically. Any server implementing these two endpoints works; chrome-home is the reference server.

```
GET /chat/briefs-threads
  → { threads: [ { id, title, briefsFilter, updatedAt, messageCount, firstUserMessage } ] }
  ordered by updatedAt desc; deleted + private threads never appear; messageCount 0 = skip.
GET /chat/sessions/<id>/markdown
  → the whole thread rendered as markdown (the substrate).
```

`listChat` calls `briefs-threads` once. `renderChat` calls `briefs-threads` (to resolve its thread's `messageCount` + `title`) then `sessions/<id>/markdown` (the body) — so list and render derive the **same** `messageCount` watermark key.

## Env vars

- `CLEARVOID_CHAT_API_URL` — the API base (default `http://localhost:3010/v1/api`). Point it at any compatible endpoint.
- `CLEARVOID_CHAT_API_TOKEN` — optional Bearer token. chrome-home is a local open server, so this is only needed against a deployment configured closed; when set it is sent as `Authorization: Bearer <token>`.

## Provenance

Brief frontmatter `sources:` carries the `chat:<thread-id>` ids, same as the other sources. A thread id stays resolvable as long as the thread exists on the chat server.
