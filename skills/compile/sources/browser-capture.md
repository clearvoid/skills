# Browser capture — AI-conversation URLs inside the `url:` source

Some URLs the `url:` source accepts cannot be fetched by any server: the conversation only renders in a real browser, behind the user's own session. For these, **the user's browser is the fetcher** — with their explicit consent, you read the rendered conversation from a browser tab, write it as the raw substrate yourself, and hand back to the normal url pipeline. Read this once before the first conversation capture. Everything else about the unit is unchanged: the id is `url:<canonical-url>`, the substrate lives at `raw/<key>.md`, the report at `raw/<key>.report.md`, and briefs cite it like any url source.

## Which URLs route here

Detection is `conversationSurface()` in `scripts/lib.mjs` — `listUrl` tags these queue entries `capture: "browser"` and `renderUrl` refuses to fetch them, printing `status: capture-required` instead:

- **grok** — `x.com/i/grok/share/<id>` (share), `x.com/i/grok?conversation=<id>` (private), `grok.com/c|chat|share/...`
- **chatgpt** — `chatgpt.com/c/<id>` (native conversation)
- **claude** — `claude.ai/chat/<id>` (native conversation)

`chatgpt.com/share/` and `claude.ai/share/` deliberately do **not** route here: those pages server-render and the extract endpoint handles them. A user may also ask to compile a conversation they have open with no URL at all — get the URL from the active tab, then proceed identically.

## Consent and availability — before touching the browser

1. **Browser tools present?** If the session has no browser-automation tools (Claude in Chrome / computer use), **fail fast**: tell the user this URL needs a browser capture and can't be compiled in this session. For chatgpt/claude add one sentence: creating a share link and compiling that instead works without a browser. Do not build a paste-in flow, do not retry.
2. **Ask before driving.** One short ask naming the URL and the mechanism: "This conversation only renders in a browser — OK if I capture it from yours?" If the user's directive already explicitly requested browser capture for this URL in this conversation, that is the consent — don't re-ask. Never capture silently, never as a background step.

## The capture loop

`renderUrl` on a conversation URL with no cache prints `capture-required` with two paths: `capture-target` (where the transcript goes) and `report-target` (the per-source report, step 6 of SKILL.md). The loop:

1. Open the URL (or reuse the tab already showing it). Wait for the conversation to render.
2. **Assume the thread is virtualized — a single read of the DOM is not the conversation.** Only a window of turns is mounted at any moment; the rest are unmounted, and a first read looks deceptively complete (consecutive user messages with no replies between them is the tell). Find the true total from the turn container's own numbering, then scroll the whole thread in steps and **accumulate as you go** (a page-context dict keyed by turn number, harvested after each step), because turns unmount behind you. Verify you hold every number up to the maximum before writing. Per-surface hooks and the scroll recipe are below. If scrolling is impractically slow, tell the user and (chatgpt/claude) offer the share-link path instead.
3. Read the conversation **by converting each message's DOM to markdown, not by reading page text**. Page text flattens structure: list bullets, headings, bold, and table cells all come out as bare lines, so a transcript built from it silently loses the shape of every answer. Walk the message element and map `h1`–`h6`, `ul`/`ol`, `pre`/`code`, `blockquote`, `strong`/`em`, and `table` yourself. Also take **the DOM's link hrefs and image alts for anything embedded** — quoted tweets, cards, and attachments render without their URLs in visible text, but the permalink is in the DOM, and an image's alt is usually the original filename. Capture those; the transcript cites them.
4. Write the transcript to `capture-target`, opening with exactly the frontmatter `renderUrl` printed (`source: url`, `source_type: ai_thread`, `surface`, `url`, `title`, `captured_at`, `turns`). `turns` is the total message count, user + assistant — it is this source's capture position. For anything but a short thread, hand the text over on disk rather than through your context — see **Handover** below.
5. Re-run the same `renderUrl` command. It now takes the cache-hit path: renders the substrate, records the watermark, prints `report-target`. Continue the normal compile.

## Turn attribution — per-surface recipes

Never guess speakers from prose when structure exists:

- **chatgpt**: every message carries `[data-message-author-role="user"|"assistant"]`. Structural — walk those. Each message sits in a `section[data-testid="conversation-turn-<n>"]`, and **that `<n>` is how you know the real length**: the mounted sections are a sparse subset (e.g. 15 sections numbered up to 78), so the maximum `<n>` is the target count, not the number you can see. The scroll container is the one `div` under `main` with `overflow-y: auto` — set its `scrollTop` in ~600px steps with a ~250ms settle between each, harvesting after every step; `scrollHeight` grows as content mounts, so re-check it instead of computing the step count up front. A number that never mounts is usually an empty zero-height turn (check the sibling between its neighbours) — mark it `[not captured: …]` rather than assuming a message is missing.
- **claude**: user messages carry `data-testid="user-message"`; assistant responses render in `.font-claude-response` containers. Structural.
- **grok**: no semantic hooks (obfuscated CSS-in-JS classes). Classify message containers by **runtime layout**, not class names: user bubbles are boxed and offset differently from assistant prose — computed style/geometry via the javascript tool survives their builds. Text-shape inference is the last resort; if you had to use it, say so in the report.

## Transcript format

The substrate is a clean speaker-labelled markdown transcript. Wording verbatim; structure reconstructed, never flattened:

- One `##` heading per turn: `## User`, and the assistant by name (`## Grok` / `## ChatGPT` / `## Claude`). Headings *inside* a message demote to `###` and below so turn boundaries stay the only `##`s.
- Tables as GFM tables (page text flattens them into word lists — rebuild from the DOM).
- Quoted/embedded content as blockquotes, attributed, with the permalink from step 3 (`> **@handle** · <date> — <url>`).
- Code blocks fenced. Non-text embeds marked in place: `[image]`, `[video, 2:00]`.
- Nothing invented: if a region didn't render or can't be read, mark the gap (`[not captured: <why>]`) rather than smoothing over it.

## Handover — getting the text from the tab onto disk

A real conversation is tens of thousands of characters. Pulling it through your context to retype it into `capture-target` costs twice over (once reading, once writing) and risks paraphrasing a substrate that is supposed to be verbatim. For a short thread the Write tool is fine. For anything longer, build the whole transcript **inside the page** (assemble it into a page variable as you harvest) and hand it over without reading it:

- **Two obvious routes are dead ends, don't spend time on them.** `navigator.clipboard.writeText` hangs the renderer from an extension JS context (it needs focus and then stalls on a permission prompt you cannot see) — the JS call times out and the clipboard keeps its old contents. And a direct `fetch` from the conversation page to a local receiver is blocked by the host's CSP (`connect-src`) — chatgpt.com refuses it with a bare `TypeError: Failed to fetch`.
- **What works: a local one-shot receiver plus a postMessage popup.** Start a tiny HTTP server on `127.0.0.1` that serves a `/sink` page and writes any POST body to the target path. From the conversation page, `window.open('http://127.0.0.1:<port>/sink')`, then `popup.postMessage(transcript, 'http://127.0.0.1:<port>')` — cross-origin postMessage isn't subject to the page's `connect-src`, and the sink POSTs the text back **same-origin** to the server, which writes the file. Verify with a byte count, then kill the server and close the tab.
- Verify the written file the same way you would any capture: byte size, turn-heading count, and the frontmatter at the top. Then re-run `renderUrl` (step 5).

## Re-capture — conversations grow

Unlike a published page, a conversation isn't frozen, so `listUrl` re-queues a conversation URL **every time it is explicitly named**, even when already compiled (`recapture: true` on the queue entry). On a re-queue with an existing cache (`renderUrl` echoes `turns:`/`captured:` on the cache hit):

- Ask consent as above, open the conversation, count its live turns.
- **Grown** → rewrite `capture-target` wholesale (full transcript, updated `turns` + `captured_at`), re-run `renderUrl`, and reconcile briefs against the new turns. The report is **re-writable** (like a chat report), not frozen.
- **Unchanged** → no rewrite, no report rewrite; just re-run `renderUrl` so the watermark records, and move on.

This is the one exception to "never edit the verbatim `raw/` substrate": a browser-captured raw file is agent-written by definition, and re-capture is its update path. It is still never edited during brief-writing — only the capture loop touches it.

## Boundaries

- **Capture-only is a legitimate request** ("just save the transcript, don't touch my briefs"). Do the capture loop, write the transcript wherever the user wants it, and stop: no report, no brief reconciliation. Critically, **do not re-run `renderUrl`** in that mode — the cache-hit path records the watermark, which would leave the source looking compiled when nothing was written to a brief. Capture-only leaves no trace in `.clearvoid/state.json`.
- Private conversation URLs (`x.com/i/grok?conversation=`, `chatgpt.com/c/`, `claude.ai/chat/`) resolve only for their owner. That's fine: the raw file is the durable local copy, and the URL in `sources:` is the identifier. Don't "fix" a private URL into anything else.
- Capture only the conversation the user named or has open. Never browse beyond it, never touch other tabs' content.
- The report follows the standard five-section contract (SKILL.md step 6). `## Summary` is a full reading view proportional to conversation length — like a chat source, the report may be the main way the conversation gets read later.
