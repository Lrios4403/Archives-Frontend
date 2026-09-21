> **Status: phases A, B and most of C are implemented.** The site no longer
> loads Tailwind. What is left is 59 file deletions and a `package.json` prune,
> which are handed over rather than done — see "Handover" at the bottom.

# Styling plan — Offline components, and the site-wide token layer

Two phases:

- **A.** A token layer + shared primitives in `globals.css`, applied across all 23
  existing `.module.css` files.
- **B.** Replace Tailwind in `components/Offline/*` with CSS Modules built on that
  layer.

A comes first because B would otherwise invent its own version of everything A
de-duplicates.

**Decisions taken** (from review): hairline weight — apply site-wide, not just
Offline · four `Window` wrappers — fine, page height is not a concern · page
section order — leave as is · `components/Button` — extend with a rest-prop
spread.

---

# Phase A — the token layer

## A1. What the site's design language actually is

I assumed Windows-95 chrome (grey, square, outset borders that press in). **That
is wrong.** `--win95-bg` is declared four times in `app/globals.css` and
referenced by nothing. The real language is a **retro terminal**: monospace
everywhere, warm orange accent, small radii, soft shadows, uppercase chrome text.

| Purpose | Token | Light | Dark |
|---|---|---|---|
| Page ground | `--primary-bg` / `--secondary-bg` | `#f5f5f5` / `#e8e8e8` | `#3d2f26` / `#2a2a2a` |
| Surface | `--window-bg` | `#ffffff` | `#3d2f26` |
| Raised surface | `--primary-bg-light` / `--primary-bg-lighter` | `#ffffff` / `#fafafa` | `#4a3730` / `#573f38` |
| Field | `--input-bg` | `#ffffff` | `#2a2a2a` |
| Accent | `--accent-orange` (+ `-light` / `-dark` / `-darker`) | `#d16b3f` | `#ff9f7a` |
| Text | `--text-primary` / `--text-secondary` / `--text-muted` | `#1a1a1a` / `#4a4a4a` / `#666` | `#fff` / `#ccc` / `#999` |
| Border | `--border-light` / `--border-dark` / `--border-darker` | `#d16b3f` / `#b85a35` / `#a04d2a` | `#ffb899` / `#d16b3f` / `#b85a35` |
| Font | `--font-mono` | JetBrains Mono → Fira Code → Courier New | — |

### Theming reality — read this before testing anything

`[data-theme]` is **never set**. There is no theme toggle anywhere in `app/`,
`components/` or `lib/`; `app/layout.tsx` puts only the font variables on
`<html>`. So the `[data-theme="dark"]` / `[data-theme="light"]` blocks in
`globals.css` are dead code kept for a future toggle, and **the only live switch
is `@media (prefers-color-scheme: dark)`**.

Every new token must therefore be declared in **all four** blocks — `:root`, the
`@media` dark block, `[data-theme="dark"]`, `[data-theme="light"]` — or the future
toggle silently skips it. That is why `Input.module.css` states its light override
twice. It is deliberate; copy it.

To test dark mode: DevTools → Rendering → *Emulate `prefers-color-scheme`*, or flip
the OS setting. Setting `data-theme` by hand also works and is the faster loop.

## A2. What the audit found

Counts are across the 23 `.module.css` files in `app/` and `components/`,
excluding Offline (which has no CSS at all yet).

### The accent tint is hardcoded to the *dark-mode* orange — ~33 places

| Literal | × | What it is |
|---|---|---|
| `rgba(255,159,122,.1)` | **15** | hover tint |
| `rgba(209,107,63,.15)` | 6 | focus ring, *inside light-mode blocks* |
| `rgba(255,159,122,.2)` | 3 | button shadow |
| `rgba(255,159,122,.15)` | 2 | active / selected |
| `.35` `.3` `.28` `.6` `.95` | 5 | pill border, glows, nav ground |

`#ff9f7a` is the **dark-mode** accent. `#d16b3f` is the light one. So every hover
tint, focus ring and glow on the site is a peachy dark-mode wash — *including in
light mode*, where the accent is a darker burnt orange. Someone already hit this
and hand-patched six of them to `rgba(209,107,63,…)` inside
`prefers-color-scheme: light` blocks. That patch is the evidence; tokenising fixes
the other 27 for free.

### The field recipe is declared 11 times

`border: 2px solid var(--border-dark)` + `border-radius: 4px` +
`box-shadow: inset 0 1px 3px rgba(0,0,0,.1)` + mono 12px, in:

`app/not-found`, `app/page`, `ErrorBoundary`, `Input`, `RecentArchives`,
`Search/SearchBar`, `SearchBar/SearchBar`, `SystemStats`, `WarcSearch/Pagination`,
`WarcSearch/WarcSearchInterface`, `Window`.

And the **light-mode `#d0d0d0` override is copy-pasted into 7 of them**, each
stating it twice (`@media` + `[data-theme]`) — 16 occurrences of `#d0d0d0` and 10
of `#e0e0e0`, all meaning "the field border in light mode".

Note `components/SearchBar/SearchBar.tsx` already *wraps*
`components/Search/SearchBar` — but its CSS module redeclares `.searchInput`
wholesale instead of composing it. The component was shared; the styling wasn't.

### Shadows

`rgba(0,0,0,.05)` ×18 and `rgba(0,0,0,.1)` ×15 — two values doing all the inset
and card work, plus `.08 .12 .15 .2 .3 .35` once or twice each. There is already a
`--shadow-color: rgba(0,0,0,.15)` in globals that almost nothing uses.

### Radii

`4px` ×33 · `2px` ×19 · `8px` ×4 · `3px` ×4 · `1px` ×2 · `999px` ×1 · `0 0 2px 2px` ×1.

(My earlier "3px / 4px / 999px" was wrong — **2px is the second most common.**)
Real scale is **2 / 4 / 8 / 999**; the four `3px` and two `1px` are strays.

### No subtle-border token exists

Which is why Offline reached for `border-gray-300` ×18 and `border-gray-200` ×8.
Using the real `--border-light` there would paint 26 solid-orange hairlines.
`PageHeader`'s pill already sets the precedent for the tinted middle ground:
`border: 1px solid rgba(255,159,122,.35)`.

## A3. The tokens

Added to `:root`, then mirrored into all three theme blocks (§A1).

```css
:root {
  /* --- accent tints: replaces ~33 raw rgba() literals, and makes them follow
         the theme instead of being frozen at the dark-mode orange ---------- */
  --accent-tint-weak:   rgba(209, 107, 63, .10);   /* hover                   */
  --accent-tint:        rgba(209, 107, 63, .15);   /* active / selected / ring */
  --accent-tint-strong: rgba(209, 107, 63, .22);   /* button shadow            */
  --accent-tint-border: rgba(209, 107, 63, .35);   /* PageHeader pill border   */
  --accent-glow:        rgba(209, 107, 63, .28);   /* title drop-shadow        */

  /* --- interior hairlines (new; the site had none) --------------------- */
  --border-subtle:   rgba(209, 107, 63, .28);
  --border-hairline: rgba(209, 107, 63, .16);

  /* --- the field border, incl. the light-mode #d0d0d0 dance ------------- */
  --border-field: #d0d0d0;      /* dark blocks override to var(--border-dark) */
  --border-soft:  #e0e0e0;

  /* --- shadows: replaces rgba(0,0,0,.05) ×18 and rgba(0,0,0,.1) ×15 ----- */
  --shadow-inset-soft: inset 0 1px 3px rgba(0, 0, 0, .05);
  --shadow-inset:      inset 0 1px 3px rgba(0, 0, 0, .10);
  --shadow-card:       1px 1px 2px rgba(0, 0, 0, .10);
  --shadow-card-hover: 1px 1px 4px rgba(0, 0, 0, .20);
  --shadow-float:      0 8px 24px rgba(0, 0, 0, .35);

  /* --- radii: 4px ×33, 2px ×19, 8px ×4 ---------------------------------- */
  --r-sm:   2px;
  --r:      4px;
  --r-lg:   8px;
  --r-pill: 999px;

  /* --- status colours, currently hardcoded in WarcRecordItem ------------ */
  --status-ok: #28a745;  --status-warn: #ffc107;
  --status-error: #dc3545;  --status-special: #6f42c1;   /* 5xx */

  --error-bg: rgba(220,53,69,.08);  --error-fg: #b32433;  --error-border: rgba(220,53,69,.30);
  --warn-bg:  rgba(255,193,7,.12);  --warn-fg:  #8a6100;  --warn-border:  rgba(255,193,7,.40);
  --ok-bg:    rgba(40,167,69,.10);  --ok-fg:    #1c7430;  --ok-border:    rgba(40,167,69,.30);

  /* --- Offline geometry (phase B) --------------------------------------- */
  --warc-row-height: 36px;   /* mirrors TREE_ROW_HEIGHT — see B3 */
  --warc-indent:     14px;
}
```

Dark blocks (`@media` + both `[data-theme]`):

```css
--accent-tint-weak:   rgba(255,159,122,.14);
--accent-tint:        rgba(255,159,122,.20);
--accent-tint-strong: rgba(255,159,122,.30);
--accent-tint-border: rgba(255,159,122,.35);
--accent-glow:        rgba(255,159,122,.28);
--border-subtle:      rgba(255,184,153,.28);
--border-hairline:    rgba(255,184,153,.16);
--border-field:       var(--border-dark);
--border-soft:        var(--border-darker);
--error-fg: #ff8b96;  --warn-fg: #ffcf6b;  --ok-fg: #7ddc98;
```

`--border-field` is the important one: it collapses the seven copy-pasted
`@media (prefers-color-scheme: light) { … #d0d0d0 … }` + `[data-theme="light"] { … }`
pairs into a single token that already resolves correctly per theme. Those 14
override blocks get **deleted**, not rewritten.

**Alternative considered:** `color-mix(in srgb, var(--accent-orange) 10%, transparent)`
expresses the tints in one line instead of four blocks and can never drift. It's
baseline-supported (Chrome 111 / Safari 16.2 / Firefox 113). Rejected for now
because the four theme blocks already exist and have to be edited anyway, so the
literal version costs nothing extra and raises no floor. Revisit if the tint
ladder grows.

**Delete `--win95-bg`** (4 declarations, 0 uses).

## A4. `components/shared/primitives.module.css`

One new file holding the recipes that are currently written 11 times. Consumers
`composes:` them, so **no JSX changes** — `Input.module.css`'s `.input` keeps its
name and its call sites.

```css
.field   { background: var(--input-bg);
           border: 2px solid var(--border-field); border-radius: var(--r);
           padding: 10px 12px;
           font-family: var(--font-mono); font-size: 12px; letter-spacing: .5px;
           color: var(--text-primary);
           outline: none; min-height: 40px;
           box-shadow: var(--shadow-inset);
           transition: all .2s ease; }

.field:focus
         { border-color: var(--accent-orange);
           box-shadow: 0 0 0 3px var(--accent-tint), var(--shadow-inset); }

.field::placeholder
         { color: var(--text-muted); font-style: italic; }

.card    { background: var(--window-bg);
           border: 1px solid var(--border-subtle); border-radius: var(--r-sm);
           box-shadow: var(--shadow-card);
           transition: border-color .15s ease, box-shadow .15s ease; }

.card:hover
         { border-color: var(--accent-orange); box-shadow: var(--shadow-card-hover); }

.panel   { background: var(--bg-secondary);
           border: 2px solid var(--nav-border); border-radius: var(--r);
           box-shadow: var(--shadow-float); }

.chrome  { font-family: var(--font-mono); font-weight: 600;
           letter-spacing: .5px; text-transform: uppercase; }
```

Then e.g. `Input.module.css` becomes:

```css
.input { composes: field from '../shared/primitives.module.css'; }
```

…and its two light-mode override blocks are deleted (the token handles it).

`components/SearchBar/SearchBar.module.css` should compose
`Search/SearchBar.module.css`'s `.searchInput` rather than redeclaring it — the
component already delegates, the CSS should too.

## A5. File-by-file, phase A

Mechanical. Each is "repoint literals at tokens, delete the light-mode override
block, compose the field/card recipe where it's duplicated."

| File | Work |
|---|---|
| `app/globals.css` | Add tokens (A3) ×4 blocks; delete `--win95-bg` |
| `components/shared/primitives.module.css` | **New** (A4) |
| `Input` | compose `.field`; drop 2 override blocks, 9 rgba, 2 hex |
| `Search/SearchBar` | compose `.field`; drop 2 override blocks, 8 rgba, 2 hex |
| `SearchBar/SearchBar` | compose `Search/SearchBar`'s classes; drop 9 rgba, 2 hex |
| `WarcSearch/WarcSearchInterface` | 12 rgba, 4 hex — the worst single file |
| `WarcSearch/WarcRecordItem` | 4 rgba, 6 hex → status tokens; card recipe |
| `Navigation` | 9 rgba → `--accent-tint*` |
| `ErrorBoundary` | 6 rgba, 4 hex |
| `RecentArchives` | 3 rgba, 8 hex |
| `PageHeader` | 4 rgba → `--accent-tint-border`, `--accent-glow` |
| `Window` | 4 rgba; `--r`, `--shadow-float` |
| `Button` | 3 rgba → `--accent-tint-strong`; **+ rest-prop spread (B4)** |
| `DesktopIcons`, `TimelineWidget`, `Pagination`, `SystemStats`, `app/not-found`, `app/page`, `app/warcs/view/page` | 1–3 literals each |

Radii sweep in the same pass: fold `3px` ×4 → `var(--r-sm)`, `1px` ×2 →
`var(--r-sm)`, everything else onto `--r-sm` / `--r` / `--r-lg` / `--r-pill`.

Also confirmed while auditing: **`SystemStats` is live**, reached via
`components/archivesFooter.tsx` → `./SystemStats/SystemStatsServer`. A grep for
`components/SystemStats/` misses it. Don't delete it.

## A6. Phase A gate

```bash
cd frontend
# raw accent literals outside globals.css — target 0
grep -rn 'rgba(255, *159, *122\|rgba(209, *107, *63' app components --include=*.module.css | wc -l   # today ~33
# hardcoded field borders — target 0
grep -rn '#d0d0d0\|#e0e0e0' app components --include=*.module.css | wc -l                            # today 26
# stray radii — target 0
grep -rn 'border-radius: *[13]px' app components --include=*.module.css | wc -l                      # today 6
```

Phase A is pure refactor: **the rendered output should be pixel-identical in dark
mode, and slightly more correct in light mode** (the tints stop being peach). Take
before/after screenshots of `/`, `/warcs/search`, `/warcs/view` and diff them.

---

# Phase B — Offline

Scope: 11 `.tsx` files, **148 static `className="…"`** (142 Tailwind-shaped) and
**14 computed `className={…}`**, plus four style constants that exist only to work
around Tailwind.

## B1. What's wrong today, ranked

**1. Dark mode is broken in Offline, and only in Offline.** Every colour is a
hardcoded light-mode Tailwind grey: `bg-white` ×5, `border-gray-300` ×18,
`text-gray-700` ×15, `text-gray-500` ×19, `text-gray-400` ×11, `bg-gray-50`,
`bg-gray-200`. When the rest of the site flips to brown-on-white-text, the offline
viewer stays a white sheet with grey text. A correctness bug, not polish, and the
reason to do this work.

**2. The offline page has no `Window`.** `app/warcs/offline/page.tsx` renders five
bare `<div>`s onto the body gradient. `Window` is used by 11 files elsewhere;
`app/warcs/view/page.tsx` — the direct counterpart — does
`<Window title={originalUrl || "Archived Site"} icon="🌐" flush>`.

**3. The accent is blue.** `bg-blue-500` / `hover:bg-blue-700` on tree rows,
`bg-blue-600` on the parse button, `text-blue-600/700/900`, `bg-blue-50`,
`file:bg-blue-50`, `bg-blue-400`.

**4. Page shell is ad-hoc.** `className="space-y- px-4 pt-40 pb-12"` — `space-y-`
is a typo that compiles to nothing — plus **six literal `<br />`** clearing the
fixed nav. It is also the **only** Tailwind left anywhere in `app/`.

**5. Row geometry is off by 4px per row (live bug — B3).**

## B2. Layout

```
components/Offline/
  Offline.module.css              ← composes shared/primitives, adds Offline-only bits
  {downloadButton,downloadNotification,fileListing,fileUpload,iframe,
   noticeBadge,recordListingTimeline,recordListingTree,
   viewProgressOverlay,viewTimeline}.module.css
app/warcs/offline/page.module.css ← mirrors app/warcs/view/page.module.css
```

camelCase class names (matches `Navigation.module.css`); file names match their
component file — the Offline directory is camelCase, the rest of the site is
PascalCase because its *directories* are. All 11 components are already
`'use client'`, which changes nothing. `composes` must be the first declaration in
its rule.

## B3. `Offline.module.css`

Only what phase A doesn't already give. `.card`, `.panel`, `.field` come from
`shared/primitives.module.css`.

| Class | Replaces | × |
|---|---|---|
| `.chipButton` | `rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-100 disabled:…` | **9** |
| `.panelHeader` | `border-b border-gray-200 px-3 py-2` | 3 |
| `.errorBox` | `rounded border border-red-200 bg-red-50 px-2 py-1.5` | 3 |
| `.progressTrack` / `.progressFill` | `h-1 w-full … bg-gray-200` + `h-full bg-blue-500 transition-[width]` | 3 |
| `.meta` / `.metaDim` | `text-xs text-gray-500` / `text-[11px] text-gray-400` | ~33 |
| `.urlLine` | `truncate font-mono text-xs text-gray-800` | ~8 |
| `.bareButton` | `BARE_BUTTON_BASE` | 2 |
| `.scrollPane` | `max-h-[70vh] overflow-auto rounded border border-gray-200` | 2 |
| `.addressGrid` | `ADDRESS_GRID` | 2 |
| `.truncate` | `truncate` | 15 |
| `.select` | content-type dropdown | 1 |

```css
/* ===========================================================================
 * Offline viewer.
 *
 * No colour in this file may be a literal. The offline viewer is the only part
 * of the site that broke in dark mode, and it broke because it did exactly that.
 * ======================================================================== */

/* ---- text -------------------------------------------------------------- */

.truncate    { min-width: 0; overflow: hidden;
               text-overflow: ellipsis; white-space: nowrap; }

.meta        { font-size: 11px; letter-spacing: .3px; color: var(--text-secondary); }
.metaDim     { font-size: 10px; letter-spacing: .3px; color: var(--text-muted); }

.urlLine     { composes: truncate;
               font-family: var(--font-mono); font-size: 12px;
               color: var(--text-primary); }

.label       { composes: chrome from '../shared/primitives.module.css';
               font-size: 12px; color: var(--text-secondary); }

/* ---- surfaces ---------------------------------------------------------- */

.panelHeader { display: flex; align-items: center; justify-content: space-between;
               gap: 16px; padding: 8px 12px;
               border-bottom: 1px solid var(--border-hairline);
               background: var(--primary-bg-light); }

.scrollPane  { max-height: 70vh; overflow: auto;
               border: 1px solid var(--border-subtle); border-radius: var(--r);
               background: var(--window-bg); }

/* ---- buttons ----------------------------------------------------------- */

/*
 * The small inline action — Download, View, Copy, ←, →, Dismiss.
 * Not components/Button: that is a 40px uppercase filled-orange CTA, these are
 * 22px inline chips.
 */
.chipButton  { display: inline-flex; align-items: center; gap: 6px;
               flex-shrink: 0; padding: 2px 8px;
               border: 1px solid var(--border-subtle); border-radius: var(--r);
               background: transparent; color: var(--text-secondary);
               font-family: var(--font-mono); font-size: 11px;
               letter-spacing: .3px; line-height: 1.6;
               cursor: pointer; transition: all .2s ease; }

.chipButton:hover:not(:disabled)
             { color: var(--accent-orange); border-color: var(--accent-orange);
               background: var(--accent-tint-weak); }

.chipButton:focus-visible
             { outline: none; border-color: var(--accent-orange);
               box-shadow: 0 0 0 3px var(--accent-tint); }

.chipButton:disabled { opacity: .4; cursor: not-allowed; }

/* Carries no chrome of its own — the [+]/[-] toggles and the timeline link. */
.bareButton  { border: none; background: transparent; padding: 0;
               font: inherit; color: inherit;
               cursor: pointer; user-select: none; flex-shrink: 0; }

.bareButton:focus-visible { outline: 1px solid currentColor; outline-offset: 2px; }

/* ---- fields ------------------------------------------------------------ */

.select      { composes: field from '../shared/primitives.module.css';
               flex-shrink: 0; max-width: 180px; cursor: pointer;
               min-height: 0; padding: 6px 30px 6px 10px;   /* clear the arrow */
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.searchField { composes: field from '../shared/primitives.module.css';
               flex: 1; min-width: 0; min-height: 0; padding: 6px 10px; }

/* ---- status boxes ------------------------------------------------------- */

.errorBox    { border: 1px solid var(--error-border); border-radius: var(--r);
               background: var(--error-bg); color: var(--error-fg); padding: 6px 10px; }
.warnBox     { border: 1px solid var(--warn-border);  border-radius: var(--r);
               background: var(--warn-bg);  color: var(--warn-fg);  padding: 6px 10px; }
.okBox       { border: 1px solid var(--ok-border);    border-radius: var(--r);
               background: var(--ok-bg);    color: var(--ok-fg);    padding: 6px 10px; }

/* ---- progress ----------------------------------------------------------- */

.progressTrack { height: 4px; width: 100%; overflow: hidden;
                 border-radius: var(--r-sm); background: var(--secondary-bg);
                 box-shadow: var(--shadow-inset-soft); }

/* Width comes from style={{ '--progress': percent }}. */
.progressFill  { height: 100%; width: calc(var(--progress, 0) * 1%);
                 background: linear-gradient(90deg,
                             var(--accent-orange-dark), var(--accent-orange));
                 transition: width .15s ease; }

.progressFillUnknown
               { height: 100%; width: 33%; background: var(--accent-orange-light);
                 animation: warcSlide 1.2s ease-in-out infinite; }

@keyframes warcSlide { from { margin-left: -33%; } to { margin-left: 100%; } }

@media (prefers-reduced-motion: reduce) {
  .progressFillUnknown { animation: none; }
  .progressFill        { transition: none; }
}

/* ---- address line -------------------------------------------------------
 * Was the ADDRESS_GRID constant in iframe.tsx, shared by the address bar and
 * the trail rows so the two stay aligned. `composes` does that natively.
 * ---------------------------------------------------------------------- */

.addressGrid { display: grid;
               grid-template-columns: .75rem minmax(0, 1fr) 15.5rem max-content;
               column-gap: .75rem; align-items: baseline; }

/* 15.5rem of fixed record-id column is most of a phone. Drop it first — the
 * inline constant had no responsive behaviour at all. */
@media (max-width: 768px) {
  .addressGrid { grid-template-columns: .75rem minmax(0, 1fr) max-content; }
  .addressId   { display: none; }
}

/* ---- tree row ----------------------------------------------------------- */

.rowWrap     { position: relative; height: var(--warc-row-height);
               padding-left: calc(var(--depth, 0) * var(--warc-indent)); }

.rowBox      { display: flex; align-items: center; justify-content: space-between;
               gap: 8px; height: calc(var(--warc-row-height) - 4px);
               padding: 0 12px; overflow: hidden; white-space: nowrap;
               border-radius: var(--r-sm);
               background: var(--accent-orange); color: var(--primary-bg);
               transition: background .2s ease; }

.rowBox:hover { background: var(--accent-orange-dark); }
```

`color: var(--primary-bg)` on an orange ground is what `Window`'s titlebar and
`Button` both do — dark brown on light orange in dark mode, off-white on burnt
orange in light. Consistent by construction.

## B4. The four constants, and the row-height bug

### `ADDRESS_GRID` (iframe.tsx:57) — delete

Fully static; exists only to keep the address line and trail rows in sync, which
is what `composes:` does natively. It also gains a mobile breakpoint it never had.

### `DEPTH_INDENT` (recordListingTree.tsx:164) — delete

A 16-entry table of `{paddingLeft: depth*14}` built to avoid a style object per
row per render. Replace with `style={{ '--depth': depth }}` and
`padding-left: calc(var(--depth) * var(--warc-indent))`. Still one object per row,
but the depth cap disappears — today anything past depth 15 silently stops
indenting — and the indent becomes tunable in one place.

### `ROW_BOX` (recordListingTree.tsx:153) — **live bug**

```ts
const ROW_BOX = { height: TREE_ROW_HEIGHT - 4 } as const;   // 32
```

Its own comment says *"Every row must be TREE_ROW_HEIGHT tall or the window's
arithmetic drifts."* But `TREE_ROW_HEIGHT` is **36** (`tree.ts:720`), the inner box
is **32**, and nothing gives the outer `div.relative` (line 494) or the
`div[role="treeitem"]` (line 679) the missing 4px — no margin, no padding, no gap.

```
scrollHeight = start·36 + (end−start)·32 + (len−end)·36
             = len·36 − (end−start)·4
```

The pane's total height changes as you scroll, and the rendered slice sits ~4px
per visible row above where the scrollbar implies — ~100px of creep at 25 visible
rows. Fix with the height stated once:

```tsx
<div className={s.scrollPane} style={{ '--warc-row-height': `${TREE_ROW_HEIGHT}px` }}>
```

One inline style for the whole pane instead of one per row, and it becomes
structurally impossible for the flattener and the CSS to disagree. (`:export` —
CSS owns 36, JS reads `styles.rowHeight` — is the alternative. Keep TS
authoritative: the arithmetic lives in `tree.ts`.)

### `TONES` (downloadNotification.tsx:29) — delete

Three parallel Tailwind class strings per state, existing **only** because
Tailwind's scanner cannot see runtime-assembled names. Under CSS Modules
`styles[stage]` is an ordinary property lookup, so it collapses to four classes
plus descendant selectors:

```css
.card.running { border-color: var(--accent-orange); }
.card.running .dot   { background: var(--accent-orange); }
.card.running .title { color: var(--accent-orange-dark); }
.card.done    { border-color: var(--ok-border); }
.card.done    .dot   { background: var(--status-ok); }
/* failed → --error-*, cancelled → --border-subtle / --text-muted */
```

`toneOf(session)` becomes `s[session.stage]`. Same for `statusClasses`
(fileListing.tsx:137,151,160) and `statusClass()` (recordListingTimeline.tsx:121).

**Stays inline:** `--progress`, `--depth`, `--warc-row-height`, and the two spacer
heights at lines 676/684 — arithmetic, not style.

## B5. Component reuse

Both read; neither spreads rest props.

```tsx
interface ButtonProps { children; onClick?; type?; disabled?; size?; className? }
interface WindowProps { title; icon?; children; className?; flush? }
```

**Extend `Button`** (decided) — add
`...rest: ButtonHTMLAttributes<HTMLButtonElement>` and forward a `ref`. Do it in
phase A alongside its token repoint, so phase B can use it freely. Even extended,
the 9 chip buttons stay native `<button>` + `.chipButton`: `Button` is a 40px
uppercase filled CTA, wrong shape for a 22px inline action. `fileUpload`'s submit
does become a `Button`.

**`Window` ships three dead controls.** `_`, `□`, `×` render with no `onClick`, no
`type="button"` (so inside a form they'd submit), and full tab stops. Four Offline
wrappers add **12 dead tab stops** to a page whose main interaction is keyboard
tree navigation. Two-line fix, same PR:

```tsx
<button type="button" tabIndex={-1} aria-hidden className={styles.controlButton}>_</button>
```

## B6. Per component

| File | `""` | `{}` | Notes |
|---|---|---|---|
| `viewTimeline` | 4 | 0 | Trivial. `.card` + `.panelHeader` + `.urlLine` + `.meta`. |
| `downloadButton` | 0 | 1 | Only a `className ?? '<default>'` fallback → `s.chipButton`. |
| `viewProgressOverlay` | 8 | 0 | First user of `.progressTrack`. `bg-white/95 backdrop-blur` → `background: var(--bg-secondary); backdrop-filter: blur(10px)` (the `Navigation` recipe). |
| `fileUpload` | 10 | 0 | `file:` variants → `::file-selector-button` (Safari 14.1+). Submit → `Button`. `w-28` → `.field` + `width: 7rem`. |
| `fileListing` | 17 | 3 | `divide-y` → `li + li { border-top: 1px solid var(--border-hairline) }`. Kills `statusClasses`. |
| `noticeBadge` | 18 | 0 | Real table CSS: `thead { position: sticky; top: 0; background: var(--primary-bg-light) }`, `th/td { padding: 6px 12px }`. Amber pill → `PageHeader`'s `.prompt` recipe with `--warn-*`. |
| `downloadNotification` | 25 | 3 | Largest. Kills `TONES`. `ring-1 ring-black/5` → a second `box-shadow` layer, not a border. Keep `w-[22rem] max-w-[calc(100vw-2rem)]` verbatim. |
| `recordListingTimeline` | 29 | 2 | `grid-cols-2 sm:grid-cols-4` → real `@media (min-width: 640px)`. `first:border-t-0` → `li + li`. Kills `statusClass()`. |
| `iframe` | 25 | 3 | Kills `ADDRESS_GRID`. `h-[70vh]` → `view/page.module.css`'s `.viewer` (`aspect-ratio: 16/9; min-height: 480px; border: 0`). **Keep the iframe background literal `#ffffff`** — archived pages assume it; tokenising paints brown behind a transparent-bodied archived page. |
| `recordListingTree` | 12 | 2 | Last. Kills the last three constants, fixes the 4px drift, toolbar composes `.searchField`/`.select`, row accent goes orange. |

**Style isolation:** the viewer is a real `<iframe>`, so page CSS cannot leak into
archived content and archived CSS cannot leak out. Nothing to guard.

## B7. Page shell

`app/warcs/offline/page.tsx` is the only Tailwind left in `app/`. New
`page.module.css`, modelled on `app/warcs/view/page.module.css`:

```css
.container   { min-height: 100vh; padding: 120px 1rem 2rem; }
.mainContent { max-width: 1200px; margin: 0 auto;
               display: flex; flex-direction: column; gap: 24px; }
@media (max-width: 768px) { .container { padding: 76px .5rem 1rem; } }
```

Deletes six `<br />`s and the `space-y-` typo. Section order stays as it is
(decided). Each section wraps in `Window`:

| Component | Window |
|---|---|
| `WarcOfflineIFrameViewer` | `<Window title="Viewer" icon="🌐" flush>` |
| `WarcOfflineViewTimeline` | `<Window title="Current record" icon="📄">` |
| `WarcOfflineFileUploadForm` | `<Window title="Load archives" icon="📂">` |
| `WarcOfflineRecordListingTree` | `<Window title="Records" icon="🗂">` |

`downloadNotification` stays `position: fixed`, outside the shell.

---

# Phase C — remove Tailwind

`components/ui/**` (21 shadcn files) is the only other Tailwind consumer, and
**nothing imports it** — verified by grep across `app/`, `components/`, `lib/`.
After phase B, Tailwind has zero live consumers.

1. Delete `components/ui/`.
2. Delete `styles/globals.css` — confirmed dead: `app/layout.tsx` imports
   `./globals.css`, and nothing references `styles/globals`.
3. From `app/globals.css`: drop `@import "tailwindcss"`, `@import "tw-animate-css"`,
   the `oklch` shadcn `:root`/`.dark` blocks, `@theme inline`, `@layer base`.
4. Delete `postcss.config.mjs` — its only plugin is `@tailwindcss/postcss`, and
   Next needs no postcss config for CSS Modules.
5. From `package.json`: `tailwindcss`, `@tailwindcss/postcss`, `tw-animate-css`,
   `tailwindcss-animate`, `tailwind-merge`, `class-variance-authority`, `clsx`,
   and the 26 `@radix-ui/*` packages.

**Risk — v4 preflight.** Removing it brings back UA defaults. The site's own
`* { margin:0; padding:0; box-sizing:border-box }` covers most of it, but not the
below. Add this **first**, ship it, confirm nothing moves, *then* drop the import
— two commits:

```css
ul, ol                        { list-style: none; }
button, input, select, textarea { font: inherit; color: inherit; }
button                        { background: none; border: none; cursor: pointer; }
img, svg, video, canvas, iframe { display: block; max-width: 100%; }
table                         { border-collapse: collapse; border-spacing: 0; }
h1, h2, h3, h4, h5, h6        { font-size: inherit; font-weight: inherit; }
a                             { color: inherit; text-decoration: inherit; }
hr                            { border-top-width: 1px; }
[hidden]                      { display: none; }
```

Also verify `@layer base { body { background-color: var(--background) } }` is
currently losing to the unlayered retro `body` gradient — it should, unlayered
beats `@layer` — so removing it changes nothing.

---

# Order

| # | Step | Phase |
|---|---|---|
| 1 | `globals.css` tokens ×4 blocks; delete `--win95-bg` | A |
| 2 | `shared/primitives.module.css`; compose from `Input`, both `SearchBar`s | A |
| 3 | Repoint the remaining 18 modules; radii sweep; status tokens into `WarcRecordItem` | A |
| 4 | Extend `Button` with rest props + ref; `Window` control `tabIndex` fix | A |
| 5 | Screenshot diff `/`, `/warcs/search`, `/warcs/view` — must be pixel-identical in dark | A |
| 6 | `Offline.module.css` | B |
| 7 | `viewTimeline`, `downloadButton`, `viewProgressOverlay` — prove the primitives on three small files | B |
| 8 | `fileUpload`, `fileListing` | B |
| 9 | `noticeBadge`, `downloadNotification` — kills `TONES` | B |
| 10 | `recordListingTimeline` — kills `statusClass()` | B |
| 11 | `iframe` — kills `ADDRESS_GRID` | B |
| 12 | `recordListingTree` — kills the last three constants, fixes the 4px drift | B |
| 13 | Page shell + `Window` wrappers | B |
| 14 | Preflight replacement reset, shipped alone | C |
| 15 | Tailwind removal | C |

Steps 7–12 are independently shippable; the app works with a mix of converted and
unconverted components throughout, because the two systems don't interact — a
component either has `className="…"` strings or `className={s.x}`.

# Verification

### Phase A gate — see A6

Three greps to zero, plus screenshot diffs. Phase A must not change dark-mode
rendering at all.

### Phase B gate

```bash
cd frontend && grep -hoE 'className="[^"]*"' components/Offline/*.tsx \
  | grep -cE 'text-|bg-|border|rounded|px-|py-|mt-|mb-|gap-|flex|grid|shrink-|min-w-|max-h-|w-\[|hover:|disabled:|space-y-|divide-|truncate'
```

**Today: 142. Target: 0.** Also
`grep -c 'TONES\|ADDRESS_GRID\|DEPTH_INDENT\|ROW_BOX\|BARE_BUTTON' components/Offline/*.tsx`
→ 0. This is the only way to know the conversion finished rather than mostly
finished.

### Row height

Assert `recordListingTree` sets `--warc-row-height` from `TREE_ROW_HEIGHT` and no
row hardcodes a height. Load `onionfarms.warc` (13,630 nodes), scroll to the very
bottom, confirm the last row is fully reachable and the scrollbar thumb doesn't
jitter — the specific symptom of the B4 drift, and the one thing here a screenshot
won't catch.

### Dark mode

DevTools → Rendering → *Emulate `prefers-color-scheme: dark`*, then walk all four
windows plus a running download card and an error card. Nothing should stay white.
Repeat with `data-theme="dark"` set by hand on `<html>` to confirm the future
toggle would work — that's the check that catches a token declared in only three
of the four blocks.

### Baselines

Backend 29 tsc errors, frontend 14 — unchanged. `next.config.mjs` sets
`typescript.ignoreBuildErrors: true`, so `next build` will **not** catch a
regression; run `tsc --noEmit` explicitly.

### Per step

Load a real WARC and view a page. The flatten/window maths has no unit test, so a
1px row error only shows as scroll drift after ~40 rows.

---

# Implementation log

## What shipped

**Phase A — token layer, applied site-wide.**

- `app/globals.css`: added a theme-invariant block (shadows, the 2/4/8/999 radius
  scale, status colours, the two Offline geometry values) and eleven
  theme-varying tokens declared in **all four** blocks. Deleted `--win95-bg`.
- `components/shared/primitives.module.css` — new. `.field`, `.fieldCompact`,
  `.select`, `.selectCompact`, `.card`, `.cardInteractive`, `.panel`, `.chrome`,
  `.truncate`.
- `Input.module.css` went from 40 lines to one `composes`. `Search/SearchBar`
  and `SearchBar/SearchBar` compose the same field.
- 20 modules repointed, 119 literal substitutions.
- `components/Button` now extends `ComponentProps<'button'>` and forwards
  everything, `ref` included (React 19 — no forwardRef needed).
- `Window`'s three decorative controls got `type="button"` and `tabIndex={-1}`,
  and the group is `aria-hidden`.

**Phase B — Offline.**

- `Offline.module.css` plus eight per-component modules and a page module.
- All 142 Tailwind class attributes gone; **zero literal `className="…"` strings
  remain in the directory.**
- `TONES`, `ADDRESS_GRID`, `DEPTH_INDENT`, `ROW_BOX`, `BARE_BUTTON`,
  `BARE_BUTTON_BASE` and `statusClasses` all deleted.
- The page is four `Window`s inside a `.container` / `.mainContent` shell; the
  six `<br />`s and the `space-y-` typo are gone.

## Three decisions taken during the work

1. **`--shadow-inset` is theme-varying, not invariant.** Seven modules carried a
   light-mode override that existed *only* to change the inset shadow from
   `rgba(0,0,0,.1)` to `.05`. Making the token resolve per theme deleted all
   fourteen override blocks instead of rewriting them.
2. **The Viewer window is not `flush`.** `app/warcs/view` uses `flush` because it
   holds an iframe and nothing else. This one has an address bar, a history
   dropdown and a Save button above the frame, and they want the padding.
3. **`WarcOfflineViewTimeline` is not wrapped in a `Window`.** It returns `null`
   when nothing is being viewed and a `Window` cannot, so wrapping it would leave
   an empty titlebar on screen for the whole time before the reader opens a page.
   It keeps its own `.card`.

## Deliberate visual changes (light mode only)

Phase A was meant to be a pure refactor. Two places are not:

- **`WarcSearchInterface`'s content-type `<select>`** now matches the search
  input beside it. It was `--border-dark` (burnt orange) while the input was
  `#d0d0d0` (grey), because the light-mode override block listed one and not the
  other. They are side by side; they should match.
- **`RecentArchives`' list container** drop shadow is `--shadow-soft` (0.08) in
  both themes rather than 0.1 dark / 0.08 light. A 0.02 alpha delta, not worth a
  fifth token.

Everywhere else the tints get *more* correct in light mode: ~33 `rgba()` literals
were the dark-mode peach `#ff9f7a` regardless of theme.

## Verification run

| Gate | Before | After |
|---|---|---|
| Raw accent literals outside `globals.css` | ~33 | **0** |
| Hardcoded `#d0d0d0` / `#e0e0e0` | 26 | **0** |
| Non-token `border-radius` | 60 | **0** |
| Status hex outside `globals.css` | 4 | **0** |
| Files with a light-mode override block | 7 | **0** |
| Tailwind class attributes in Offline | 142 | **0** |
| Literal `className="…"` in Offline | 148 | **0** |
| The four style constants | 4 | **0** |

Also checked: all 35 stylesheets parse under postcss; all 14 edited `.tsx` files
parse under `@babel/parser` with the typescript + jsx plugins; every `composes`
target resolves to a real top-level class in a real file; every `s.x` /
`shared.x` / `surfaces.x` reference resolves to a class that exists; no `var()`
references an undefined token; all 37 theme-varying tokens are present in all
four theme blocks.

## Not done, and needs you

- **`tsc --noEmit` was never run.** TypeScript is not installed in this
  workspace's `node_modules` and `npm install` cannot write there. `@babel/parser`
  catches syntax errors but not type errors. Run it before merging — the
  frontend baseline is 14. Note `next.config.mjs` sets
  `typescript.ignoreBuildErrors: true`, so `next build` will not tell you.
- **Nothing has been looked at in a browser.** Specifically worth checking:
  1. the tree scrolled to the bottom of `onionfarms.warc` (13,630 nodes) — the
     4px drift fix is the one change here that a screenshot will not show;
  2. dark mode, via DevTools → Rendering → *Emulate `prefers-color-scheme`*;
  3. `::file-selector-button` on the upload input in Safari;
  4. whether the orange tree rows are too loud at 13,000 of them — that was
     `bg-blue-500` before and is now the site accent, which is a lot more
     saturated in bulk.
- **Phase C.** `components/ui/**` is still the only Tailwind consumer left, still
  imported by nothing.

---

# Phase C log

## Done

**The preflight replacement.** Derived by reading
`node_modules/tailwindcss/preflight.css` rather than from memory, and kept as a
subset: the rules covering elements this site actually renders — headings, links,
lists, form controls, `code`/`pre`, tables, `summary`, replaced elements,
`[hidden]`. Dropped as unreachable: `hr`, `textarea`, `sub`/`sup`/`abbr`/`small`,
and the whole `::-webkit-datetime-edit-*` family. An element census confirmed
each of those appears nowhere in `app/` or `components/` outside `components/ui`.

It lives in `@layer base`, which is the part that matters. Preflight is layered,
and that is exactly what makes a reset safe — unlayered CSS beats any layer, so
every component module outranks all of it for free. Unlayered, `font: inherit` on
`button` would be fighting `.chipButton` over the font size.

**Tailwind is gone from the stylesheet.** `@import "tailwindcss"`,
`@import "tw-animate-css"`, the two `oklch` shadcn token blocks, `@theme inline`
and the shadcn `@layer base` are all removed — 123 lines. `globals.css` is 771 →
647 lines despite gaining the reset and the token layer.

Verified before removing: no live file uses a Tailwind utility class, and no live
file uses a `tw-animate-css` class (`animate-in`, `fade-in-*`, `slide-in-*`).

## Handover — not done on purpose

The rest of phase C is 59 file deletions. They are correct, they are what the
plan calls for, and I would rather you saw the diff before it landed than have it
arrive inside a styling change. It is one command:

```bash
cd frontend
git rm -r components/ui          # 57 files, imported by nothing
git rm lib/utils.ts              # the shadcn cn(); only components/ui used it
git rm styles/globals.css        # dead duplicate; layout.tsx imports app/globals.css
git rm postcss.config.mjs        # only plugin is @tailwindcss/postcss
```

Then prune `package.json`: `tailwindcss`, `@tailwindcss/postcss`, `tw-animate-css`,
`tailwindcss-animate`, `tailwind-merge`, `class-variance-authority`, `clsx`, and
the 26 `@radix-ui/*` packages. Then `npm install` to rewrite the lockfile.

**Order matters.** Delete first, prune second. `components/ui` imports `clsx`,
`tailwind-merge`, `class-variance-authority` and Radix; pruning those while the
files are still present turns a clean `tsc --noEmit` into 57 files of missing-module
errors. Nothing is bundled either way — nothing imports them — but the typecheck
would fail.

**Current state is coherent if you stop here.** `postcss.config.mjs` still runs
`@tailwindcss/postcss`, which now finds no directives and does nothing;
`components/ui` still typechecks because its dependencies are still installed.
Everything live is Tailwind-free.

## Final gate suite

| Gate | Result |
|---|---|
| A1 raw accent literals outside `globals.css` | 0 |
| A2 hardcoded `#d0d0d0` / `#e0e0e0` | 0 |
| A3 non-token `border-radius` | 0 |
| A4 status hex outside `globals.css` | 0 |
| A5 files with a light-mode override block | 0 |
| B1 literal `className="…"` anywhere in Offline | 0 |
| B2 the four style constants | 0 |
| C1 live source files using a Tailwind utility | 0 |
| C2 Tailwind directives in any stylesheet | 0 |

35 stylesheets parse under postcss. 121 `.ts` / `.tsx` files parse under
`@babel/parser` with the typescript + jsx plugins. Every `composes` target and
every `s.x` / `shared.x` / `surfaces.x` reference resolves. All 37 theme-varying
tokens are present in all four theme blocks.

`tsc --noEmit` still has not run — TypeScript is not installed here and
`npm install` cannot write to this workspace. It remains the one thing to do
before merging.
