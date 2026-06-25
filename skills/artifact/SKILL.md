---
name: artifact
description: Generate a clean HTML artifact from a free-form instruction, in the Clearvoid house style, written into this repo's artifacts/ folder and rendered by the Clearvoid desktop app. The instruction is the what (e.g. "an overview of all the briefs", "a one-pager comparing X and Y", "a small checklist tool for Z"); the skill constrains only the output (house style, clean fragment, file conventions). Use when the user asks to make/build an artifact, dashboard, overview page, report, internal tool, or one-pager.
user-invocable: true
argument-hint: "what to make, e.g. 'an overview of all the briefs' or 'a checklist tool for onboarding'"
allowed-tools: Read, Write, Bash, Glob
---

# clearvoid-artifact

Turn a free-form instruction into a clean HTML artifact in the Clearvoid house style. The artifact is a file in this repo (`artifacts/<slug>.html`); the Clearvoid desktop app renders it in its Artifacts tab, and it can be shared externally later. You are the generator: the user says what they want, you produce a house-styled artifact for it.

The instruction is the *what*. This skill fixes only the *how*: the house style, a clean fragment, and where the file goes. There is no fixed template; "an overview of all the briefs" and "a unit-converter tool" are equally valid.

## Process

1. **Read the instruction.** It describes the artifact to build. If it is vague, make a reasonable, well-scoped artifact rather than asking a series of questions.
2. **Gather substrate only if the instruction references it.** If the instruction is about repo content ("all the briefs", "this file", "our open questions"), read it now and bake the data into the artifact at generation time (the artifact is static; there is no live host data). Briefs are markdown under `briefs/` (frontmatter `title`/`summary`/`updated`); read what you need with Read/Glob/Bash. If the instruction is self-contained (a tool, a calculator), no substrate read is needed.
3. **Generate a clean fragment** (see Output contract) styled with the house vocabulary (see below).
4. **Write it** to `artifacts/<slug>.html` (kebab-case slug from the instruction; create `artifacts/` if missing). Overwrite if regenerating the same slug.
5. **Report** the path and a one-line description, and that it shows in the desktop app's Artifacts tab.

## Output contract

- **A clean fragment, not a document.** Output body content only: no `<!doctype>`, no `<html>`, `<head>`, or `<body>`. The desktop host injects the doctype, the house stylesheet, a strict CSP, and a resize reporter, then renders your fragment inside a `<main class="cv-artifact">` wrapper in a sandboxed iframe. Do not add chrome the host already provides.
- **Style with the house vocabulary only** (tokens + utilities below). Prefer the utility classes and semantic HTML; the element baseline already styles `h1`-`h3`, `p`, `a`, `ul`/`ol`, `table`, `code`, `pre`, `blockquote`. A small artifact-specific inline `<style>` is allowed for one-offs, but always use the color tokens (never hardcode colors), so the artifact stays consistent with the app's dark theme.
- **No network anything.** The CSP blocks external scripts, styles, fonts, and remote images (`default-src 'none'`). No CDNs, no Google Fonts, no `<img src="https://...">`. Images must be `data:` URIs or omitted. No React and no external JS libraries.
- **Interactivity is vanilla JS** in an inline `<script>` (it runs in the sandbox). Keep it small and dependency-free. Derive displayed values from the baked-in data rather than hardcoding them where it is easy (it keeps the artifact honest).
- **Wide layouts:** add `cv-wide` to your top-level container only if the content needs more than the default reading measure (dashboards, wide tables): the host wrapper is `.cv-artifact`, so emit `<div class="cv-wide">` at the top to widen, or rely on the default.

## House vocabulary

Mirror of the desktop host's stylesheet (`apps/clearvoid-desktop/src/lib/artifactHouseCss.ts`). Dark theme, built on the app's design tokens. Keep this list in sync if the host CSS changes.

**Color tokens** (use via the utilities, or as `var(--color-...)` in an inline style): `--color-background` `--color-foreground` `--color-muted` `--color-subtle` `--color-card` `--color-card-hover` `--color-border` `--color-subtle-light` `--color-accent` `--color-accent-muted` `--color-success` `--color-error` `--color-warn`.

**Component patterns:** `cv-card` (a bordered card surface), `cv-eyebrow` (uppercase mono label), `cv-wide` (widen the container).

**Utilities** (Tailwind-named, mapped to the tokens):
- layout: `flex` `grid` `block` `inline-flex` `hidden` `flex-col` `flex-wrap` `items-center` `items-start` `justify-between` `justify-center` `grid-cols-2` `grid-cols-3` `gap-2` `gap-3` `gap-4` `gap-6` `w-full` `min-w-0`
- spacing: `p-3` `p-4` `p-6` `px-3` `py-2` `mt-2` `mt-4` `mt-6` `mt-8` `mb-2` `mb-4` `mb-6` `m-0`
- type: `text-xs` `text-sm` `text-base` `text-lg` `text-xl` `text-2xl` `text-3xl` `font-medium` `font-semibold` `font-bold` `leading-tight` `leading-relaxed` `tracking-tight` `tracking-wide` `uppercase` `text-center` `font-mono`
- color: `text-foreground` `text-muted` `text-subtle` `text-accent` `text-success` `text-error` `text-warn` `bg-background` `bg-card` `bg-card-hover` `bg-subtle-light` `bg-accent` `bg-accent-muted`
- border/radius: `border` `border-t` `border-b` `border-border` `rounded-md` `rounded-lg` `rounded-full`

Only these classes render. If you need something outside the set, use semantic HTML (already styled) or a small inline `<style>` using the color tokens, rather than a class that will not resolve.

## Minimal example

A fragment (what you write to `artifacts/<slug>.html`):

```html
<p class="cv-eyebrow">PROJECT · STATUS</p>
<h1>This week at a glance</h1>
<p class="text-muted">Three things moved. Generated from the repo.</p>

<div class="grid grid-cols-2 gap-4 mt-6">
  <div class="cv-card">
    <h3 class="m-0">Shipped</h3>
    <p class="text-muted m-0 mt-2">The render seam landed and verified.</p>
  </div>
  <div class="cv-card">
    <h3 class="m-0">Open</h3>
    <p class="text-muted m-0 mt-2">Share + unshare still to wire.</p>
  </div>
</div>
```

For ideas and use-cases, see https://clearvoid.ai/llms.txt.
