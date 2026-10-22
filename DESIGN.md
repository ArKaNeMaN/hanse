# hanse Design System - The Chart Room

> Status: visual contract for the from-scratch web UI redesign. Stage 1 defined the system and
> verified its primitives. Stage 2 applied it to the authenticated shell, login, overview, projects,
> project detail, and handoffs inbox. Stage 3 implements the chat workspace on the same contract.
>
> Implementation: `src/http/styles.css` (tokens + bespoke component layer), showcase at
> `docs/design/showcase.html`, evidence at `docs/design/artifacts/`.
>
> **No UI code may introduce a color, size, space, radius, shadow, or motion value that is not
> named in this file. Extend this file first.**

---

## 0. Research Log

- **Embedded references:** shortlisted `linear.app` (dense operations shell, luminance stepping,
mono metadata), `warp` (terminal-native blocks), and `wired` (ink-blue editorial ledger). Picked
`taste-skill.md` (Layer A, operational execution discipline) + `linear.app.md` (Layer B, shell and
density grammar) because hanse is a dense, dark-native operator workbench, not a marketing page.
`warp` was rejected for carrying no app-shell grammar beyond the terminal; `wired` was rejected as
a magazine surface with no task-app structure. Linear's indigo accent, Inter typography, and glass
card treatment were **not** carried over: the direction replaces them with brass, system serif,
humanist sans, and opaque tonal surfaces.
- **StyleGallery spatial patterns:** fetched `CATALOG.md` plus `fixed-sidenav-shell`,
`scroll-body-shell`, `supporting-pane`, `main-with-rail`, and `list-detail`. Adopted
`fixed-sidenav-shell` + `scroll-body-shell` for the app frame (sidebar fixed, one named scroll
container per region), `list-detail` for the chat session rail, and `supporting-pane` for the chat
handoff panel. Scroll ownership is recorded in Section 4.
- **ui-ux-db:** ran a color-domain lookup for a dark operations dashboard. It returned generic
slate/emerald dashboard palettes; used only as a structural sanity check, not as a source. The
ink/brass palette is bespoke and contrast-checked in Section 2.
- **Lazyweb:** skipped. The owner supplied the direction and product context; the lane would only
harvest generic SaaS screens, and the spatial grammar was already supplied by StyleGallery.
- **Imagen drafts:** skipped. No image generation tool is available in this session, and the
direction is carried by type, ruled surfaces, and a chart ground rather than a hero image.
- **Screenshot lane:** real Playwright Chromium, 390 / 768 / 1440, dark and light, plus
`:focus-visible`, open dialog, toast, tooltip, and mobile-drawer captures. Evidence list in
Section 8.3. Contrast pairs were measured from the rendered page in both themes.

**Design read (taste-skill):** an operational workbench for one technical operator, with a Hanseatic
chart-room and paper-ledger language, leaning toward a bespoke Tailwind v4 token layer with a dense
fixed-sidebar shell, serif page titles, and mono machine data.

**Dials:** `DESIGN_VARIANCE 5` (asymmetric where it carries meaning: fixed rail, manifest rows,
supporting pane), `MOTION_INTENSITY 2` (feedback only, no decorative motion), `VISUAL_DENSITY 8`
(cockpit density in ledgers and chat, but a readable 68ch measure for prose).

---

## 1. Atmosphere & Identity

**A night watch room for a working fleet.** Deep ink-blue surfaces sit in low, even light; a single
brass signal is the only warm thing in the room. The interface reads like a ship's ledger: ruled
rows, stamped states, identifiers in mono, page titles in a bookish serif. It is calm and dense at
the same time, with generous margins only at the edges and compact, exact rows inside.

**Signature material:** the *plotted route*. Every handoff is drawn as a hairline route between an
origin and a destination application, with a brass state seal and a mono handoff id. The same
material recurs in the shell: a fine 32px chart grid aligned to the spacing system, visible only in
the page ground and login plate, never under dense data.

**Color story:** ink, steel, and brass. No violet, no neon, no gradient text, no glass. Status color
is semantic and always paired with a glyph.

**The one memorable moment:** the handoff manifest. A row or card that reads at a glance as a route
between two applications, with the state stamped on the line rather than floating in a generic pill
soup. It must survive next to GitHub Dark Dimmed: same darkness, warmer signal, no glare.

---

## 2. Color

### 2.1 Primitive palette

Primitives exist so semantic tokens can be re-pointed per theme. Components use the semantic tokens
only.

| Primitive | Dark | Light | Note |
|---|---|---|---|
| `--ink-950` | `#05080D` | - | inset wells, code |
| `--ink-900` | `#070B11` | - | page canvas |
| `--ink-850` | `#0B1119` | - | panel surface |
| `--ink-800` | `#0F1721` | - | raised surface |
| `--ink-750` | `#15202B` | - | dialog, popover |
| `--ink-700` | `#1B2834` | - | hover on raised |
| `--steel-600` | `#2B3B48` | - | strong hairline |
| `--steel-500` | `#3D5060` | - | icon muted |
| `--steel-400` | `#5F7280` | - | disabled text |
| `--steel-300` | `#7C8B97` | - | tertiary text |
| `--steel-200` | `#A9B7C2` | - | secondary text |
| `--steel-100` | `#D6DFE5` | - | strong secondary |
| `--paper-50` | `#E9EEF1` | - | primary text |
| `--brass-700` | `#7A5B18` | - | light-theme accent |
| `--brass-600` | `#B8913F` | - | accent border |
| `--brass-500` | `#D2AC5F` | - | dark-theme accent |
| `--brass-400` | `#E3C27C` | - | dark hover / focus |
Status colors are a semantic family defined directly in Section 2.3; they are not re-pointed
through primitives.

### 2.2 Semantic tokens

Dark is the default. `[data-theme="light"]` re-points the same semantic names, so every component
works in both themes with no per-theme overrides.

| Role | Token | Dark | Light | Usage |
|---|---|---|---|---|
| Canvas | `--canvas` | `#070B11` | `#E9EDEA` | Page ground |
| Surface 1 | `--surface-1` | `#0B1119` | `#F4F6F3` | Sidebar, top bar, panels |
| Surface 2 | `--surface-2` | `#0F1721` | `#FBFCFA` | Cards, table headers |
| Surface 3 | `--surface-3` | `#15202B` | `#FFFFFF` | Dialogs, popovers, hovered cards |
| Inset | `--inset` | `#05080D` | `#E1E6E2` | Code, wells, skeletons |
| Line | `--line` | `#1E2B36` | `#CBD4D0` | Default hairline |
| Line strong | `--line-strong` | `#2B3B48` | `#B4C1BC` | Input edges, selected edges |
| Text 1 | `--text-1` | `#E9EEF1` | `#12202A` | Titles, body |
| Text 2 | `--text-2` | `#A9B7C2` | `#455A66` | Secondary, labels |
| Text 3 | `--text-3` | `#7C8B97` | `#556872` | Metadata, hints, placeholders |
| Brass | `--brass` | `#D2AC5F` | `#7A5B18` | Single signal accent |
| Brass hover | `--brass-hover` | `#E3C27C` | `#634A12` | Hover on brass |
| Brass ink | `--brass-ink` | `#1B1408` | `#FBF7EA` | Text on brass fills |
| Focus | `--focus` | `#E3C27C` | `#7A5B18` | `:focus-visible` ring |
| Selection | `--selection` | `#3A3020` | `#E7DFC8` | Text selection |
| Wash 1 | `--wash-1` | `rgba(233,238,241,.045)` | `rgba(18,32,42,.035)` | Hover |
| Wash 2 | `--wash-2` | `rgba(233,238,241,.075)` | `rgba(18,32,42,.065)` | Pressed / active |
| Wash 3 | `--wash-3` | `rgba(233,238,241,.11)` | `rgba(18,32,42,.10)` | Selected wash |
| Grid line | `--grid-line` | `rgba(169,183,194,.06)` | `rgba(18,32,42,.055)` | Chart ground |
| Scrim | `--scrim` | `rgba(3,6,10,.74)` | `rgba(18,32,42,.42)` | Dialog / drawer scrim |
| Shadow | `--shadow-overlay` | `0 24px 64px -24px rgba(0,0,0,.8), 0 2px 8px rgba(0,0,0,.45)` | `0 20px 48px -24px rgba(18,32,42,.35), 0 2px 8px rgba(18,32,42,.08)` | Overlays only |

### 2.3 Status tokens

Status is a semantic family. Every status is rendered as a pill **and** a glyph, never color alone.
Pills use the status ink at 10-12% over the local surface with a 28-32% border.

| State | Token | Dark | Light | Glyph |
|---|---|---|---|---|
| queued | `--status-queued` | `#8FA3B3` | `#4E6573` | clock |
| awaiting_approval | `--status-awaiting` | `#D9B368` | `#6E4F0E` | stamp / alert |
| dispatching | `--status-dispatching` | `#86A9CC` | `#2F5F86` | send / arrow |
| in_progress | `--status-in-progress` | `#7BB8AD` | `#23665C` | spinner-stop / activity |
| delivered | `--status-delivered` | `#86B98A` | `#2F6B37` | check |
| rejected | `--status-rejected` | `#D08C78` | `#8A4535` | x |
| failed | `--status-failed` | `#E08573` | `#8C2F26` | alert-triangle |
| expired | `--status-expired` | `#B9A173` | `#6A5425` | hourglass |
| cancelled | `--status-cancelled` | `#8A939B` | `#5A6770` | slash |

General semantic aliases: `--danger` = status failed, `--success` = status delivered,
`--info` = status dispatching, `--warning` = status awaiting.

### 2.4 Color rules

- **One accent.** Brass marks the single most likely action on a screen (primary button fill),
current nav state, focus, and the handoff seal. Nothing decorative carries brass.
- Status hues are semantic, not accents. They never appear as large fills or borders on cards.
  Awaiting approval intentionally sits in the brass family because it is the attention state; the
  pill form, uppercase label, and stamp glyph separate it from a primary action.
- No colored side-stripe borders for selected, active, or focused rows. State is a wash plus a
glyph. `focus-visible` rings are the only colored edge.
- Never use pure black or pure white as a surface or text value. The tokens above are the floor
and ceiling.
- Text selection uses `--selection`; `::selection` is defined globally.
- Contrast floor: 4.5:1 body, 3:1 large text and control edges, verified in both themes.
- High-contrast mode (`prefers-contrast: more`) is an accessibility override, not a new role:
  dark `--line` -> `--steel-500`, `--line-strong` -> `--steel-400`, `--text-3` -> `--steel-200`;
  light `--line` -> `#8E9F99`, `--line-strong` -> `#6B7F78`, `--text-3` -> `#3F525C`.

---

## 3. Typography

### 3.1 Families

System stacks only. No external font or CDN request.

| Token | Stack | Job |
|---|---|---|
| `--font-display` | `"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, "DejaVu Serif", Georgia, serif` | Brand, page titles, dialog titles, empty-state headlines |
| `--font-sans` | `Ubuntu, "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif` | All UI, body, labels, buttons |
| `--font-mono` | `"Ubuntu Mono", "SFMono-Regular", "Cascadia Mono", "DejaVu Sans Mono", ui-monospace, monospace` | ids, paths, timestamps, counts, code, tool output |

Three families are justified by distinct jobs: serif for the ledger identity, sans for human reading
and controls, mono for machine-owned data. Serif is never used for body copy, buttons, or controls.
Mono is never used for prose.

### 3.2 Scale

| Token | Size | Line height | Weight | Tracking | Usage |
|---|---|---|---|---|---|
| `--text-brand` | `1.375rem` (22px) | 1.1 | 600 serif | -0.02em | Sidebar wordmark |
| `--text-brand-sm` | `1.125rem` (18px) | 1.2 | 600 serif | -0.02em | Top bar wordmark |
| `--text-display` | `clamp(2rem, 1.55rem + 1.9vw, 2.625rem)` (32-42px) | 1.08 | 600 serif | -0.02em | Login brand, major page title |
| `--text-h1` | `1.75rem` (28px) | 1.15 | 600 serif | -0.015em | Page header |
| `--text-h2` | `1.3125rem` (21px) | 1.25 | 600 serif | -0.01em | Section title |
| `--text-h3` | `1rem` (16px) | 1.35 | 600 sans | 0 | Card and panel title |
| `--text-h4` | `1.25rem` (20px) | 1.25 | 600 serif | -0.01em | Empty-state title |
| `--text-metric` | `1.5rem` (24px) | 1.2 | 400 mono | 0 | Watch-strip values |
| `--text-body-lg` | `1rem` (16px) | 1.55 | 400 sans | 0 | Lead paragraph, login copy |
| `--text-body` | `0.875rem` (14px) | 1.55 | 400 sans | 0 | Default UI text |
| `--text-chat` | `0.9375rem` (15px) | 1.65 | 400 sans | 0 | Chat message body |
| `--text-sm` | `0.8125rem` (13px) | 1.45 | 400 sans | 0 | Secondary metadata |
| `--text-caption` | `0.75rem` (12px) | 1.4 | 500 sans | 0.01em | Captions, table meta |
| `--text-overline` | `0.6875rem` (11px) | 1.3 | 600 sans | 0.14em | Ruled section labels, uppercase |
| `--text-mono` | `0.75rem` (12px) | 1.5 | 400 mono | 0 | Ids, paths, timestamps |
| `--text-mono-sm` | `0.6875rem` (11px) | 1.45 | 400 mono | 0.02em | Dense table ids |
| `--text-micro` | `0.625rem` (10px) | 1.4 | 500 sans | 0.02em | Table headers, nav counts, route meta |
| `--text-status` | `0.65625rem` (10.5px) | 1 | 600 sans | 0.06em | Status pills, kbd |

At 390px, `--text-body` becomes `0.9375rem` (15px) via the responsive block. Body never drops below
14px on desktop or 15px on phone. Headings wrap by `max-inline-size` and `text-wrap: balance`, never
by hard breaks.

### 3.3 Rules

- Page titles are serif. Panel and card titles are sans weight 600. Never reverse this.
- Overline labels are rationed: at most one per page header and one per major section. They name
the region in plain language (`WORKBENCH`, `HANDOFFS`); no numbering, no decorative eyebrows.
- Numeric, id, path, and timestamp content uses mono. Human counts in prose use sans.
- No thin weights. Weights are 400, 500, 600 only.
- `font-variant-numeric: tabular-nums` on tables, counts, and timestamps.
- Serif display uses `text-wrap: balance` and `leading` from the scale; never `leading-none` with
descenders.

---

## 4. Spacing, Layout & Shell Grammar

### 4.1 Space scale

Base 4px. Every gap, padding, and margin in product CSS uses one of these tokens.

| Token | Value | Token | Value |
|---|---|---|---|
| `--space-1` | 4px | `--space-8` | 32px |
| `--space-2` | 8px | `--space-10` | 40px |
| `--space-3` | 12px | `--space-12` | 48px |
| `--space-4` | 16px | `--space-16` | 64px |
| `--space-5` | 20px | `--space-20` | 80px |
| `--space-6` | 24px | `--space-24` | 96px |

Browser mechanics stay raw: `minmax(min(18rem, 100%), 1fr)`, `clamp()`, `min-content`, and
`scrollbar-gutter: stable` are mechanics, not tokens.

Control optical inset: `--control-pad-y: 6px` and `--control-pad-x: 12px`. These are component
insets for text baselines, not layout rhythm; all layout gaps use the 4px scale above.

### 4.2 Frame dimensions

| Token | Value | Usage |
|---|---|---|
| `--sidebar-w` | `14.5rem` (232px) | Full sidebar at >= 1200px |
| `--sidebar-w-mid` | `13.25rem` (212px) | 1024-1199px |
| `--topbar-h` | `3.5rem` (56px) | Top bar |
| `--content-max` | `90rem` (1440px) | Page content limiter |
| `--gutter` | `2rem` (32px) | Page inline padding >= 1024px |
| `--gutter-md` | `1.5rem` (24px) | 768-1023px |
| `--gutter-sm` | `1rem` (16px) | < 768px |
| `--reading-measure` | `68ch` | Prose and handoff spec |
| `--chat-sessions` | `16rem` (256px) | Chat session rail |
| `--chat-context` | `20rem` (320px) | Chat handoff panel |
| `--pane-drawer-w` | `20rem` (320px) | Mobile drawer / context sheet |

Breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`, `2xl 1536`.

### 4.3 App shell

The showcase itself uses this shell; stage 2 must use the same markup skeleton.

```html
<body class="app-body">
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="app-shell" data-nav="closed">
    <aside class="sidebar" id="sidebar" aria-label="Primary">
      <div class="sidebar__head">
        <a class="wordmark" href="/">hanse</a>
        <span class="sidebar__kicker">coordinator</span>
      </div>
      <nav class="sidebar__nav">
        <p class="nav-label">Workbench</p>
        <a class="nav-item is-active" href="/" aria-current="page">[icon] Overview <span class="nav-item__mark">[check]</span></a>
        <a class="nav-item" href="/projects">[icon] Projects</a>
        <a class="nav-item" href="/handoffs">[icon] Handoffs <span class="nav-item__count">3</span></a>
        <p class="nav-label">Agents</p>
        ...
      </nav>
      <div class="sidebar__foot">
        <span class="avatar avatar--sm">OP</span>
        <span class="sidebar__operator">operator</span>
        <button class="btn btn-ghost btn-icon" aria-label="Settings">[icon]</button>
      </div>
    </aside>
    <div class="shell-main">
      <header class="topbar">
        <button class="btn btn-ghost btn-icon nav-toggle" data-nav-toggle aria-label="Open navigation" aria-expanded="false">[menu]</button>
        <nav class="breadcrumb" aria-label="Breadcrumb">...</nav>
        <div class="topbar__actions">...</div>
      </header>
      <main class="page" id="main" tabindex="-1">
        <header class="page-header">...</header>
        <div class="page__body">...</div>
      </main>
    </div>
    <div class="scrim" data-nav-close hidden></div>
  </div>
</body>
```

**Geometry**

- Desktop `>= 1200`: grid columns `var(--sidebar-w) minmax(0, 1fr)`. Sidebar is fixed to the shell,
full `100dvb`, its nav is the sidebar's scroll owner. The main column is a grid of
`auto minmax(0, 1fr)`: top bar stays, `.page` scrolls. `min-block-size: 0` is mandatory on
`.page`.
- `1024-1199`: sidebar narrows to `--sidebar-w-mid`; content gutters drop to `--gutter-md`.
- `< 1024`: sidebar leaves the grid and becomes a fixed off-canvas drawer
(`translateX(-100%)`, `visibility: hidden` so it leaves the tab order), opened by the top bar menu
button, with a scrim. `data-nav="open"` on `.app-shell` reveals it. Escape and scrim click close it;
focus returns to the toggle.
- `< 768`: top bar keeps the menu button, wordmark, and one primary action. Page gutters are
`--gutter-sm`. Content is one column; tables use `.table--stack`. Below 640 the breadcrumb is
hidden because the page header already names the route.

**Sidebar anatomy**

- `--sidebar-w` wide, `--surface-1` ground, 1px `--line` inline-end border.
- Head: wordmark in serif 22px, `coordinator` in overline mono-ish caption below, 16px top and
12px bottom padding; a double hairline rule under the head (the chart title block).
- Nav: `.nav-label` overline 11px uppercase `--text-3`, 24px top margin, 8px bottom. `.nav-item`
32px min height (44px at < 768), 8px inline padding, 8px gap, `.icon` 16px. Default `--text-2`; hover
`--wash-1`; active `--wash-2` + `--text-1` + trailing check glyph 12px in `--brass`;
  pressed `--wash-3`. No side stripes.
- Foot: 48px, hairline top, operator avatar + name in caption, settings icon button.
- Mobile drawer: `.btn.sidebar__close` (icon X) sits at the head's inline-end; scrim click and
Escape also close it. Focus opens on the first nav item and returns to the menu toggle on close.

**Top bar**

- 56px, solid `--surface-1`, 1px bottom `--line`. Left: mobile menu (only `< 1024`), breadcrumb.
Right: `.topbar__actions` with max one primary button, icon buttons for IDE/external and theme.
- Breadcrumb: 12px sans, `--text-3`, separator chevron 12px, current item `--text-1`, no
underline until hover. Ancestors truncate first; the current page never truncates. Below 640px
the breadcrumb is hidden because the page header already names the route.

**Page**

- `.page` is the scroll owner (`overflow: auto; min-block-size: 0`), with the chart ground as a
static background, masked to fade under content.
- `.page-header`: breadcrumb (optional), serif h1, one-line description in `--text-2`, meta row in
mono, actions trailing. Max inline `--content-max`, centered, padding
`--space-8 var(--gutter) var(--space-6)`.
- `.page__body`: same limiter and gutters, bottom padding `--space-16`.

**Chart ground**

- 32px square grid, `--grid-line`, aligned to the 4px system, with a radial mask that fades it out
below the page header. It is static, never animated. Never place it under dense tables; the
surfaces are opaque and cover it.

### 4.4 Page archetypes

1. **Login.** `.cover` grid `auto 1fr auto`, `min-block-size: 100dvb`, chart ground, centered
`.login-plate` (max 380px) with wordmark serif 34px, one sentence, labeled token field, primary
button, and a caption. No hero illustration. The plate is `--surface-1`, 1px `--line`, radius
`--radius-lg`, 1px inner top highlight (no glow).
2. **Overview / dashboard.** Page header with title and one primary action. A `.watch-strip` of 3
plain metrics separated by vertical hairlines (no cards). Then the project ledger as ruled rows
(not card soup): project name serif 18px, path mono, app count, last activity, handoff state
mix, trailing chevron. A side rail (>= 1280) holds "Handoffs waiting" with route lines.
3. **Projects index.** Page header, search/filter cluster, `.table` of projects. Empty state
teaches how to add `.hanse/project.yaml`.
4. **Project detail.** Breadcrumb, serif title, meta (root path mono, app count), actions: Open IDE
(secondary), New handoff (primary). Main column: app ledger table (app key, kind, path, chat and
IDE links). Right rail 320px: handoff route manifest with states and approve/reject. At < 1024
the rail moves below the table, full width.
5. **Handoffs inbox.** Page header with a `.segmented` filter (All / Waiting / Active / Closed) and
a search input. Rows are `.handoff-row` with route line + summary + mono id + state + actions.
Awaiting rows expose Approve (primary) and Reject (danger ghost) inline; approval opens a
`.dialog` with the spec excerpt and a reason field. On mobile rows stack with the route line
above the summary.
6. **Chat workspace.** Three panes at >= 1360: session rail 256px (`list-detail` list), thread
`minmax(0,1fr)` (the scroll owner), handoff context 320px (`supporting-pane`). The page itself
never scrolls; the thread owns the only vertical scroll and the composer is a fixed footer inside
it. At 1024-1359 and 768-1023 the session rail stays static and the context pane becomes a
right-side drawer opened from the top bar, with scrim, Escape, and focus return. Below 768 the
layout is one column; sessions and context are full-height drawers, opened from the thread pane
head and the top-bar context toggle. The top bar holds the app selector, new-session action,
runtime pill, and the context/IDE actions. No chart ground sits under the chat. The global sidebar
follows its normal shell behavior.
7. **Embedded IDE.** Opens in a new tab at `/ide/`; no hanse chrome is injected. GitHub Dark Dimmed
is the reference; hanse's ink/brass does not clash because it shares the same luminance band and
avoids bright chrome.
8. **Application page.** Header with `Open chat`, `Terminal`, and a `More actions` disclosure; a
two-cell state strip (`Runtime`, `Settings`); the git workbench as the main column (Repository,
Changes) and a 320px rail (Image, SSH access, Remotes, Last commit). The only page primary is
`Commit all`; the Image card uses status pills and disclosures, not a full-width block.
9. **Settings.** A sticky scope/section nav, four section cards (`Agent`, `Web tools`, `Git`,
`Restart & pending`), and one collapsed `.setting-row` per setting. Only effective value and source
are visible at rest; editor, scope history, warnings, and actions are inside the row disclosure.
10. **Operator terminal.** Full-height route with no page header. A 48px toolbar (title, runtime and
connection pills, Copy/Reconnect/Close), an in-flow banner, and an xterm host that owns the remaining
viewport and its own scrollback. No chart ground.

### 4.5 Scroll ownership

| Region | Owner | Notes |
|---|---|---|
| App shell | none | `100dvb`, grid; no document scroll |
| Sidebar nav | `.sidebar__nav` | only when nav exceeds height |
| Page | `.page` | one scroll container for the route |
| Chat thread | `.chat-thread` | messages scroll; composer fixed in the same pane |
| Chat session rail | `.chat-sessions` | independent, named job |
| Chat context | `.chat-context` | independent, named job |
| Dialog | `.dialog__body` | only when content exceeds viewport |
| Drawers | panel itself | scrim blocks the page behind |

`min-block-size: 0` on every scroll child. `100dvh`, never `100vh`.

### 4.6 Content stress contract

Every archetype must survive: empty (no projects, no apps, no handoffs, no sessions), a 40-character
app name, an unbroken 120-character repo path (`overflow-wrap: anywhere`), a 20-line handoff spec
(reading measure 68ch), a 9-state status row, and 390px reflow with no horizontal scroll of primary
content. Tables use `.table--stack` below 768px.

---

## 5. Components & Primitives

All classes below are implemented in `src/http/styles.css`. Markup examples are the contract.

### 5.1 Buttons

```html
<button class="btn btn-primary">Approve handoff</button>
<button class="btn btn-secondary">Open IDE</button>
<button class="btn btn-ghost">Cancel</button>
<button class="btn btn-danger">Reject</button>
<button class="btn btn-primary btn-sm">Approve</button>
<button class="btn btn-primary btn-lg">Sign in</button>
<button class="btn btn-primary" aria-busy="true" disabled>
  <span class="spinner" aria-hidden="true"></span>
  <span class="btn__label">Signing in</span>
</button>
<button class="btn btn-ghost btn-icon" aria-label="Copy handoff id">[icon]</button>
```

- **Structure:** `<button>` or `<a class="btn">`; optional leading `.icon`, optional
`.btn__label`, optional `.spinner`.
- **Variants:** `.btn-primary` (brass fill, brass ink), `.btn-secondary` (surface 2, hairline,
text 1), `.btn-ghost` (transparent, text 2, hover wash), `.btn-danger` (transparent with danger
text and danger border at 45%; hover danger wash). Sizes: default 32px, `.btn-sm` 28px,
`.btn-lg` 40px, `.btn-xs` 24px (legacy compatibility). `.btn-block`, `.btn-icon` (square).
- **States:** default, hover (wash/brass hover), active (`translateY(1px)`), focus-visible (2px
`--focus` ring, 2px offset), disabled (`--text-3`, 55% opacity, no pointer), loading
(`aria-busy`, spinner, label unchanged width).
- **Accessibility:** button text is an outcome verb; icon-only buttons require `aria-label`;
disabled is never the only signal for loading (use `aria-busy`).
- **Motion:** 110ms ease-out on background, border, transform. No scale bounce.
- **Layout:** inline-flex, 8px gap, `white-space: nowrap`; never wraps at desktop. At < 768 all
  button sizes resolve to a 44px touch height.

### 5.2 Fields

```html
<div class="field">
  <label class="label" for="project-name">Project name</label>
  <input class="input" id="project-name" name="name" placeholder="northbank"
         aria-describedby="project-name-hint">
  <p class="hint" id="project-name-hint">Lowercase, used in paths and URLs.</p>
</div>

<div class="field" data-invalid="true">
  <label class="label" for="token">Operator token</label>
  <input class="input" id="token" type="password" aria-invalid="true"
         aria-describedby="token-error">
  <p class="field-error" id="token-error">[alert] Token rejected. Check the value and try again.</p>
</div>
```

- **Variants:** `.input`, `.select`, `.textarea`; `.select-wrap` with a trailing chevron icon.
- **States:** default, hover (`--line-strong`), focus-visible (brass ring + line-strong), invalid
(`--danger` border + error text), disabled (`--surface-1`, `--line` edge, `--text-3` at 75%), read-only.
- **Anatomy:** label above, hint below, error replaces hint below, 8px gap. Placeholder is a format
example, never the only label. Textarea min-height 88px, padding 8px 12px, vertical resize.
- **Accessibility:** every input has a `<label for>`; errors use `aria-invalid` and
`aria-describedby`; required is visible in the label, not color-only.
- **Motion:** border/focus 110ms; no layout shift when an error appears (reserve the hint row with
`min-block-size` in product forms).

### 5.3 Checkbox, radio, switch

```html
<label class="check">
  <input class="checkbox" type="checkbox" checked>
  <span>Wake the target agent after approval</span>
</label>
```

Native inputs with `accent-color: var(--brass)`, 16px box, 8px gap, 44px touch row on mobile.
Focus-visible ring on the input. Switch is not part of stage 1; use a checkbox until a real binary
setting needs it.

### 5.4 Status pills and badges

```html
<span class="status" data-state="awaiting_approval">
  [stamp glyph] Awaiting approval
</span>
<span class="badge">app</span>
<span class="badge badge--mono">gateway</span>
```

- `.status` is a 22px pill, 2px radius, 10.5px uppercase 600 sans, letter-spacing .06em, 6px gap,
1px border from the status ink, background from the status ink at 10%.
- `data-state` values: `queued`, `awaiting_approval`, `dispatching`, `in_progress`, `delivered`,
`rejected`, `failed`, `expired`, `cancelled`. Each has a required glyph; color alone is not
allowed.
- `.badge` is neutral: surface 2, hairline, 12px sans, 20px height, 4px radius. `.badge--mono` for
app keys. Badges never carry status semantics.

### 5.5 Handoff route (signature)

```html
<article class="route-card" data-state="awaiting_approval">
  <div class="route-card__head">
    <span class="mono">HS-8F2A-1C</span>
    <span class="status" data-state="awaiting_approval">[stamp] Awaiting approval</span>
  </div>
  <div class="route" aria-label="Handoff from gateway to ledger">
    <span class="route__end"><span class="route__app">gateway</span><span class="route__meta">origin</span></span>
    <span class="route__track" aria-hidden="true">
      <span class="route__node"></span>
      <span class="route__seal">[stamp]</span>
      <span class="route__node"></span>
    </span>
    <span class="route__end route__end--to"><span class="route__app">ledger</span><span class="route__meta">target</span></span>
  </div>
  <p class="route-card__summary">Add an idempotency key to invoice sync.</p>
</article>
```

- Hairline track in `--line-strong`, 4px nodes, 24px brass seal centered on the line. The seal
contains the state glyph. No animation.
- At < 768px the route stacks: origin row, a vertical brass track with the seal, target row.
Summary sits below. The track is decorative (`aria-hidden`); the `aria-label` carries the route.

### 5.6 Cards and panels

```html
<section class="card">
  <header class="card__head">
    <h2 class="card__title">Agent runtime</h2>
    <span class="mono">2 apps</span>
  </header>
  <div class="card__body">...</div>
  <footer class="card__foot">...</footer>
</section>
```

- Surface 1 or 2, 1px `--line`, radius `--radius-md` (6px), no shadow at rest. Header 48px with a
bottom hairline; body 16px; foot 12px top hairline.
- Cards are for genuinely bounded objects (a handoff, a runtime panel), never for every metric.
Metrics use `.watch-strip` with vertical rules.
- Hover lift is not used. Only clickable cards get `--wash-1` and `cursor: pointer`, plus a
focus-visible ring.

### 5.7 Tables and ledgers

```html
<div class="table-wrap">
  <table class="table table--stack">
    <thead><tr><th scope="col">Application</th><th scope="col">Kind</th><th scope="col">Path</th><th scope="col"></th></tr></thead>
    <tbody>
      <tr aria-selected="true">
        <td data-label="Application"><span class="table__check">[check]</span><strong>gateway</strong></td>
        <td data-label="Kind"><span class="badge badge--mono">api</span></td>
        <td data-label="Path"><span class="mono">apps/gateway</span></td>
        <td data-label=""><a class="btn btn-ghost btn-sm" href="/chat?app=gateway">Open chat</a></td>
      </tr>
    </tbody>
  </table>
</div>
```

- 40px rows, 32px header, `--text-micro` uppercase 600 header in `--text-3`, one hairline per row
(`border-block-end`), no vertical rules. Hover `--wash-1`. Selected `--wash-2` plus a check
glyph in the first cell; no accent border.
- `.mono` cells use `--font-mono`, `--text-mono-sm`, `--text-2`, and `overflow-wrap: anywhere`.
- `.table--stack` at < 768: header hidden, each row is a label/value flex block
(`td::before { content: attr(data-label) }` at a fixed 7rem label column), one hairline between
rows. The primary summary wraps full width. `.table__actions` hides its label and starts at the
row edge. `.table__nowrap` protects ids and route strings. `.table--handoffs` widens the id column
at >= 768 so the selected check stays inline. No horizontal scroll.
- Empty tables are replaced by `.empty-state`, not an empty `<table>`.

### 5.8 Tabs and segmented control

```html
<div class="segmented" role="group" aria-label="Handoff filter">
  <button class="segmented__item" type="button" aria-pressed="true">Waiting</button>
  <button class="segmented__item" type="button" aria-pressed="false">Active</button>
  <button class="segmented__item" type="button" aria-pressed="false">Closed</button>
</div>
```

- 32px height, 2px radius, `--inset` ground, 2px padding, 1px `--line`; each item 8px inline
padding, 12px sans 500. Active: `--surface-2`, `--text-1`, and a 4px brass diamond glyph before
the label. Hover: `--wash-1`. Focus-visible ring on the item.
- The glyph is required so active state is not color-only. Do not use an accent bottom border.
- The filter uses `aria-pressed`, not `role="tab"` without a tabpanel. If a real tab set is needed,
  pair `role="tab"` with `aria-controls` and a `role="tabpanel"`. Arrow-key navigation is expected
  in stage 2; the showcase demonstrates selection.

### 5.9 Navigation

`.nav-item` is defined in Section 4.3. States: default, hover, active (`is-active` or
`aria-current="page"`), focus-visible. Active mark: trailing check glyph 12px brass; count badge
(`.nav-item__count`) is mono 11px in `--text-3`. No left accent bar.

### 5.10 Breadcrumb

`.breadcrumb` is a `<nav>` with an ordered list or inline links, 12px sans, 12px chevron
separators in `--text-3`. The last item is `--text-1` with `aria-current="page"`. No underline at
rest; hover underline on ancestors. Truncate ancestors with ellipsis, never the current page.

### 5.11 Dialog

```html
<dialog class="dialog" id="approve-dialog" aria-labelledby="approve-title">
  <div class="dialog__frame">
    <header class="dialog__head">
      <h2 class="dialog__title" id="approve-title">Approve handoff</h2>
      <p class="dialog__meta mono">HS-8F2A-1C</p>
    </header>
    <div class="dialog__body">...</div>
    <footer class="dialog__foot">
      <button class="btn btn-ghost" data-dialog-close>Cancel</button>
      <button class="btn btn-primary">Approve handoff</button>
    </footer>
  </div>
</dialog>
```

- Native `<dialog>` with `showModal()`. Panel 520px max, `--surface-3`, 1px `--line-strong`,
radius `--radius-lg`, `--shadow-overlay`, 24px padding. Backdrop `--scrim`.
- Entry: opacity + 6px translate, 180ms; exit is immediate on close (native). Reduced motion:
opacity only.
- Always a visible Cancel plus an outcome-verb primary. Destructive option uses `.btn-danger` and
is never the default action. Focus is trapped by the native dialog; Escape closes; focus returns
to the trigger.

### 5.12 Toast

```html
<div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="false"></div>

<div class="toast" data-tone="success" role="status">
  <span class="toast__icon">[check]</span>
  <div class="toast__copy"><strong>Handoff approved</strong><span>HS-8F2A-1C is dispatching.</span></div>
  <button class="btn btn-ghost btn-icon btn-sm" aria-label="Dismiss">[x]</button>
</div>
```

- Fixed bottom-right (bottom center < 640), 360px max, surface 3, hairline, shadow, 6px radius,
12px padding. Tone is carried by the glyph and a 1px tinted border, never a side stripe.
- Only for outcomes not visible in place. Routine success is shown by the changed row state.
Auto-dismiss after 6s; errors persist until dismissed. `aria-live` region is polite; errors use
`role="alert"`.

### 5.13 Tooltip

```html
<span class="tooltip-wrap">
  <button class="btn btn-ghost btn-icon" aria-describedby="tip-copy" aria-label="Copy id">[copy]</button>
  <span class="tooltip" role="tooltip" id="tip-copy">Copy handoff id</span>
</span>
```

- Surface 3, 1px `--line-strong`, 4px radius, 6px 8px padding, 12px sans, shadow, max 240px.
Appears on hover and `:focus-within`, above the trigger, 8px offset. No arrow required.
Tooltips are an enhancement: every icon-only control also has `aria-label`.

### 5.14 Kbd, avatar, mono, rule

- `.kbd`: 20px min, `--surface-2`, 1px `--line-strong`, 2px bottom border (physical key), 4px
radius, mono 10.5px, 4px inline padding.
- `.avatar`: initials, 28px default, 20px `.avatar--sm`, 40px `.avatar--lg`; `--surface-2` ground,
1px `--line`, 2px radius, 11px 600 sans. Never a fake photo.
- `.mono`: `--font-mono`, `--text-mono`, `--text-2`, tabular numbers, `overflow-wrap: anywhere`.
- `.rule`: 1px `--line` horizontal; `.rule--strong` uses `--line-strong`; `.rule--double` is a
1px line, 3px gap, 1px line (the chart title block).

### 5.15 Empty, loading, error

```html
<div class="empty-state">
  <span class="empty-state__mark">[inbox]</span>
  <h3 class="empty-state__title">No handoffs waiting</h3>
  <p class="empty-state__body">Requests from sibling agents arrive here for review.</p>
  <a class="btn btn-secondary btn-sm" href="/projects">Open a project</a>
</div>

<div class="skeleton-stack" aria-hidden="true">
  <span class="skeleton skeleton--title"></span>
  <span class="skeleton"></span>
  <span class="skeleton skeleton--short"></span>
</div>

<div class="error-state" role="alert">
  <span class="error-state__mark">[alert]</span>
  <div><h3 class="error-state__title">Agent runtime unavailable</h3>
  <p class="error-state__body">The gateway instance did not start. Retry, or check the runtime log.</p>
  <p class="mono">ref 7c1e-4a90</p>
  <button class="btn btn-secondary btn-sm">Retry</button></div>
</div>
```

- Empty state: centered, 48px icon plate with 1px hairline, serif 20px title, 14px body max 46ch,
one next action. No illustration.
- Loading: skeleton blocks match final geometry; shimmer is an opacity pulse (not background
position), 1.6s, paused under reduced motion. Spinner is a 14px rotating arc, only for waits
past ~1s.
- Error: inline next to the failing object, states what happened and what to do; mono reference id
for the operator. Toast is not a substitute.
- Offline: an error-state variant with a `cloud-off` glyph and "Coordinator unreachable" copy,
  placed at the page level; retry is offered when the network returns. Do not show a toast for a
  sustained offline state.

### 5.16 Chat primitives

- `.chat-thread`: two-row grid (`minmax(0,1fr) auto`) so the thread scrolls and the composer stays. `.chat-thread__scroll` owns the scroll; `.chat-thread__inner` is a 20px stack with a 76ch measure.
- `.message`: role label (mono caption, `operator` or app key), body `.message__body` at
`--text-chat`; user messages get `--wash-1` background and a 1px `--line`; agent messages are
transparent. No bubbles with tails, no avatars on every row.
- `.tool-call`: `<details>` with a 32px summary row, mono tool name, `.tool-call__path`
  (flex 1, ellipsis for long paths), state badge, and an inset `<pre>` for output. Hover
  `--wash-1`. No accent side stripe.
- `.tool-diff` / `.tool-code`: inset mono surfaces inside an open `.tool-call`. One
  `.tool-diff__scroll` / `.tool-code__scroll` owns both axes (`max-block-size: 24rem`,
  `overscroll-behavior: contain`, `scrollbar-gutter: stable`, inset focus-visible ring) and is the
  only horizontal scroller at 390px. `.tool-diff__head` / `.tool-code__head` are sticky file
  headers (ellipsis path, type, line counts); `.tool-diff__hunk-head` is a non-sticky `--wash-1`
  band. `.diff-line` grids old/new numbers, sign, and code (`3.25rem 3.25rem 1.25rem minmax(0,1fr)`;
  `2.5rem 2.5rem 1rem minmax(0,1fr)` below 48rem); `.code-line` uses one number column
  (`3.25rem` / `2.5rem`) plus the remaining width. Code never wraps. Add/delete rows mix
  `--success`/`--danger` at 9% with visible signs and tabular numbers; `data-kind="meta"` is italic
  `--text-3`. `.tool-diff__diagnostics` is a capped, pre-wrap footer; `.tool-diff__file-list` is a
  capped ellipsis list for patch-only parts. No animations or hover-only affordances.
- **Diff/code token theme:** scoped to `.tool-diff .token` / `.tool-code .token`, so Prism class
  names never escape into chat prose. comment/prolog/doctype/cdata `--text-3` italic; punctuation
  `--text-2`; keyword/atrule/selector `--brass`; string/char/attr-value/inserted `--success`;
  number/boolean/constant/symbol `--warning`; function/class-name/builtin `--info`;
  property/tag/attr-name/deleted `--danger`; variable/parameter `--text-1`; operator `--info`;
  regex `--warning`; important `--warning` bold; bold 600, italic italic. The `+`/`-` sign and
  `data-kind` carry add/delete meaning, never color alone.
- `.composer`: 1px top hairline, 12px padding, textarea + send button, 8px gap, hint row with
`Enter to send - Shift+Enter for a new line` in caption. Composer is inside the thread pane and
never scrolls away.
- `.chat-context`: 320px supporting pane, sections separated by `.rule`; handoff routes stacked at
12px gap. `.chat-context__section` groups the app card, handoffs, and shortcuts; `.context-handoff`
is a compact link with a mono id, state pill, summary, and route.
- `.session-item`: full-width list button, title plus mono short id/time; hover wash, active
`--wash-2` plus a brass check and `aria-current`.
- `.chat-thread__meta`: session title, mono short id, live status, message count, working indicator,
and stream retry. `.chat-live` carries a status dot plus text (`Live`, `Reconnecting`, `Paused`,
`Starting agent...`); `.chat-working` is a spinner plus label. `.chat-new-messages` floats above the
composer only when the reader is away from the bottom.
- `.page--chat` / `.page__body--chat`: a non-scrolling page shell for the workspace; no chart ground.
`.chat-shell--workspace` is the three-pane grid. `.chat-scrim` is the drawer scrim; drawer state is
`data-chat-sessions="open"` and `data-chat-context="open"` on the chat shell.
- `.message__body` renders a safe markdown subset: paragraphs, headings (`h3`-`h5`, serif display),
lists, blockquotes, fenced code, inline code, links, strong/em, and rules. The thread is
`role="log" aria-live="polite"`. Tool, reasoning, and patch parts use `.tool-call` details; errors
auto-open.

### 5.17 Git panel

The application page's git panel is server-rendered and hydrated by `assets/git.js`. Full states,
copy, and behavior live in [the git workbench design](docs/design/git-workbench.md).

- **Classes:** `.git-status__row` (branch/upstream block plus state pill), `.git-branch` (branch glyph
  and mono name), `.git-actions` (wrapping action bar), `.git-switch` (branch select plus Switch,
  stacked below 768), `.git-group` / `.git-group__head` (file group heading and count),
  `.git-file-list` / `.git-file` / `.git-file__path` / `.git-file__code` (wrapping path rows and
  visual-only porcelain code), `.git-commit` / `.git-commit__foot` (message form and wrapping
  footer), and `.git-notice` (inline result with `data-tone="success|warning|error"`).
- **Status mapping:** Clean `delivered` (check), Changes `awaiting_approval` (stamp), Conflicts
  `failed` (alert-triangle), Detached `cancelled` (slash), In progress `in_progress` (activity).
  Every state is glyph + text + color, never color alone; ahead/behind use `.badge badge--mono`.
- **File groups:** Staged, Unstaged, Untracked, Conflicted. Each `.git-group__head` pairs an
  `.overline` heading with a mono count; conflicted groups add an alert glyph. Rows show the mono
  path (`old → new` for renames) and the porcelain code, with a `.sr-only` full change label.
- **Responsive:** the action bar and commit footer wrap; `.git-switch` stacks below 768 and all
  controls keep the 44px phone target; paths use `overflow-wrap: anywhere`; no horizontal overflow
  at 390px.

### 5.18 Typography utilities

`.display`, `.h1`, `.h2`, `.h3`, `.body-lg`, `.body`, `.small`, `.caption`, `.overline`, `.mono`.
These map exactly to Section 3. No other font sizes are allowed in product CSS.

### 5.19 Interactive prompts, plan, and policy warnings

- **Prompt dock:** `.prompt-dock` is an in-flow row directly above `.composer` inside the chat
  thread, so it never covers messages and the thread keeps page scroll ownership. The single visible
  `.prompt-dock__card` is capped at 76ch, surface 1 with a hairline; `.prompt-dock__head` carries the
  `QUESTION`/`PERMISSION` overline, position or risk chip, queue count, and collapse control.
  `.prompt-dock__body` is the only scroll region inside the dock (`min(45dvh, 30rem)` desktop,
  `min(50dvh, 22rem)` at < 768).
- **Question anatomy:** `.prompt-dock__tabs` (>= 768) and `.prompt-dock__stepper` (< 768) are mutually
  exclusive; `.prompt-question` is a native `<fieldset>` with an uppercase `legend`, question text,
  `.prompt-option` native radio/checkbox rows (label plus description), and `.prompt-custom` for the
  `Other` input. `.prompt-review` lists answers for the Review step. Selection is wash 2 plus the
  native control, never an accent edge; focus stays on the native input.
- **Permission anatomy:** `.risk-chip` pairs a word, glyph, and 3-tick meter so risk is never
  color-only. `.prompt-scope` states `This request:`/`Always grants:` with mono patterns and the
  v1/v2 scope sentence (`For this app instance until restart.` / `Saved for this project until
  revoked.`). `.prompt-caveat` carries the `*`, external-directory, and bash-glob explanations.
  `.prompt-evidence` renders only fields the request provides (command, filepath/diff, URL, patterns,
  tool/input) in a label/value grid; `.prompt-evidence__pre` scrolls and wraps. `.prompt-confirm`
  holds inline Always/Deny confirmations with the cascade warning and optional feedback.
- **Actions:** Deny is a danger ghost at the start of `.prompt-dock__foot`; Always allow and Allow once
  are at the end. Buttons are `btn-sm` on desktop and resolve to the 44px mobile target. Submitting
  labels the primary action `Sending answer…` / `Sending reply…` and disables the dock controls.
- **Top bar and queue:** `.chat-input-needed` shows a mono count pill for requests in other sessions;
  `.chat-queue` is a non-modal popover at >= 640 and a bottom sheet below, opened from that control.
  `.policy-chip` is the compact post-dismissal warning control; `.chat-waiting` is the meta-strip
  `Waiting for you` stamp.
- **Policy warning:** `.policy-warning` is a full-width in-flow banner below the meta strip with a
  text-only `.policy-warning__list` and a Dismiss action. It uses surface 2 plus a hairline, not a
  colored side stripe, and is `role="status"`.
- **Plan (Todo):** `.chat-plan-section` sits in the context rail after Application and before Handoffs.
  `.chat-plan__item` is a read-only 3-column row: `.chat-plan__status` (glyph + `Pending`/`Now`/`Done`/
  `Dropped`/`Unknown`), `.chat-plan__content`, and `.chat-plan__priority` (3-tick meter; the text
  label is visually hidden). Only the first `in_progress` row gets `aria-current="step"`. The list is
  capped at `14rem` with contained scroll; `.chat-plan__empty` carries empty/loading/error/paused
  states. `.chat-plan-chip` shows `Plan N/M` in the thread meta only below 1360 and opens the drawer
  at the Plan heading.
- **Saved permissions:** `.chat-saved` lists durable v2 grants as `.chat-saved__row` with mono action,
  resource, and upstream project id, plus an inline-confirmed Revoke action. The section is hidden
  when empty; `.chat-saved__actions`, `.chat-saved__action`, `.chat-saved__resource`,
  `.chat-saved__project` name the row parts. A new grant briefly shows the `New` badge.
- **Session flag:** `.session-item__flag` marks a rail row with a waiting count. It is glyph + text;
  the count is duplicated in the top-bar control.
- **Accessibility and motion:** prompt text, options, metadata, and plan rows are `textContent` only;
  no markdown or links. The dock is a labelled region, questions use `<fieldset>`/`<legend>`, tabs use
  roving tabindex with `aria-controls`, errors use `role="alert"`, and `#chat-announcer` is the single
  polite live region for arrivals and outcomes. Reduced motion changes opacity only.

### 5.20 UX polish components (application, settings, terminal)

- **Application state strip:** `.state-strip` is a two-column ruled strip
  (`border-block: 1px solid var(--line)`), `.state-strip__cell`, `.state-strip__label`,
  `.state-strip__value`, `.state-strip__actions`. Below 768 it stacks with a block-start hairline.
  The Settings cell is the only pending-restart statement on the page.
- **Overflow menu:** `<details class="menu">` with a `.btn.btn-ghost.btn-icon` summary, a
  `.menu__panel` (surface 3, hairline, radius md, overlay shadow, `--z-sticky`), and `.menu__item`
  links. Outside click/Escape close it and return focus to the summary.
- **Disclosure:** `.disclosure` is a native `<details>` with a `--space-8` summary row and a
  `.disclosure__chevron` that rotates when open. Used for Image details, Build logs, provider keys,
  and scope details. No custom ARIA menu/tab roles.
- **Settings nav and rows:** `.settings-nav` is sticky under the top bar with
  `.settings-nav__scopes`, `.settings-nav__sections`, `.settings-nav__link`, and
  `aria-current="page"` on the current scope. `.settings-section` uses the card shell.
  `.setting-row` is a native `<details>` separated by hairlines; `.setting-row__summary` is a
  `minmax(0,1fr) auto` grid (title, effective value + source, optional status, chevron), and
  `.setting-row__body`, `.setting-row__form`, `.setting-row__actions`, `.setting-row__reason` hold
  the open editor. `.scope-details`/`.scope-list` replace per-setting tables with a compact
  definition list (`Set`/`Cleared`/`Inherited`). Disabled Inherit/Clear controls always carry a
  visible reason. Saves are live: the client swaps the affected section HTML from the server
  (provider/model/web changes also refresh warnings and restart state), preserving open rows,
  other-row drafts, focus, scroll, and the URL hash; it does not navigate.
- **Terminal:** `.page--terminal`, `.page__body--terminal`, `.terminal-shell`,
  `.terminal-toolbar`, `.terminal-toolbar__title`, `.terminal-toolbar__meta`,
  `.terminal-toolbar__status`, `.terminal-toolbar__actions`, `.terminal-banner`, `.terminal-host`,
  `.terminal-empty`. The xterm viewport background is `--inset`; the terminal theme maps ANSI to the
  status tokens and updates with `data-theme`.
- **Runtime vocabulary:** `starting` -> `dispatching`/`Starting`; `running` ->
  `in_progress`/`Running`; `stopped` -> `queued`/`Stopped`; `error` (legacy `failed`) ->
  `failed`/`Error`. Every state keeps a glyph and text. Container `Running` is not the same as an
  active turn or chat `Ready`.
- **Image vocabulary:** `missing` -> `queued`/`Not built`; `building` -> `in_progress`/`Building`;
  `ready` -> `delivered`/`Built`; `stale` -> `expired`/`Out of date`; `error` ->
  `failed`/`Build failed`; `default` -> `cancelled`/`Default image`. Image never uses `Ready`, which
  is reserved for chat's agent status.
- **Status rules:** status remains glyph + text + color; no new status colors. Runtime error is
  `Error`, not `Failed`; image "Built" is not runtime readiness; pending restart is shown once per
  route.

### 5.21 SSH operator console

The SSH page is a scoped operator console rather than a table-plus-form page. It uses the existing
shell, page header, watch strip, sticky nav, card, status, badge, table, empty-state, and dialog
primitives; no new color, type, spacing, radius, or shadow token is introduced.

- **Sticky nav:** `.ssh-nav` extends `.settings-nav`; `.ssh-nav__scope`,
  `.ssh-nav__scope-label`, and `.ssh-nav__select` hold the single application-scope picker. Anchor
  links and the scope picker are canonicalized to `/ssh?target=projectId:appKey`, while legacy
  `project`/`app` query links keep working.
- **Health strip:** `.ssh-watch` spaces the four-cell `.watch-strip--4` beneath the nav.
- **Host grid:** `.ssh-grid` is a responsive auto-fill grid; `.ssh-host` is a card with a 2px
  inline-start state rail (`data-pin="pinned|unpinned|mismatch"`) that is always paired with a
  text-and-glyph status pill, so state is never color-only. This state rail is the documented
  exception to the general no-side-stripe rule; it identifies host-key pin state, not row selection.
  `.ssh-host__body`, `__head`, `__ident`, `__name`, `__addr`, `__facts`, `__fact`, `__access`,
  `__grant`, `__key`, and `__actions` carry the card anatomy.
- **Inline results:** `.ssh-test`, `__head`, `__note`, and `__facts` render a test or prepare-re-pin
  result inside the affected host card. `.ssh-warning` carries the out-of-band verification warning.
- **Dialogs:** `.ssh-dialog` hosts the add and per-host edit forms; `.ssh-form__group` (with
  `--danger`), `.ssh-form__grid`, `.ssh-form__full`, `.ssh-public-key`, `.ssh-key-meta`, and
  `.ssh-fingerprint` compose connection, write-only key, access policy, host key, and danger-zone
  groups. `.ssh-fingerprint` is mono and wraps safely.
- **Access:** `.ssh-panel` and `.ssh-panel--flush` hold the allowlist and tables; `.ssh-allowlist`
  is the host checkbox grid; `.ssh-subtitle` names the grants sub-section.
- **Approvals and audit:** `.ssh-approvals` and `.ssh-approval` (+ `__head`, `__ident`, `__title`,
  `__meta`, `__foot`) are spacious request rows with a mono command block. `.ssh-audit__command`
  wraps long previews; `.ssh-note` carries the recency note.
- **Responsive behavior:** host cards and form grids collapse to one column; the scope picker wraps
  below 768px; approval actions stack below 639px; tables use `.table--stack`; no horizontal page
  overflow at 360px.

---

## 6. Motion & Interaction

### 6.1 Timing

| Type | Duration | Easing | Usage |
|---|---|---|---|
| Micro | 110ms | `cubic-bezier(.2,.8,.25,1)` | Button hover/press, input border, nav wash |
| Standard | 180ms | `cubic-bezier(.4,0,.2,1)` | Dialog, toast, drawer, context panel |
| Emphasis | 320ms | `cubic-bezier(.16,1,.3,1)` | Reserved for route-level transitions in stage 3 |

Tokens: `--dur-micro`, `--dur-standard`, `--dur-emphasis`, `--ease-out`, `--ease-standard`,
`--ease-emphasis`.

### 6.2 Feedback thresholds

| Event | Feedback | Timing |
|---|---|---|
| Press | 1px translate + wash | Same frame |
| Hover | Wash or brass hover | 110ms |
| Focus | 2px ring, 2px offset | Immediate |
| Async start | `aria-busy`, disabled, spinner only past 1s | Immediate state |
| Success | Row state changes in place | Immediate; toast only if off-screen |
| Failure | Inline error next to object | Immediate |

### 6.3 Rules

- Motion serves feedback or state change only. No entrance animations on page load, no decorative
loops, no marquee, no parallax, no hover that changes nothing.
- Animate `transform`, `opacity`, and color/border transitions only. Never width, height, top,
left, margin, or padding.
- Drawers and context panels use `transform` + opacity. Dialog uses opacity + 6px translate.
- `prefers-reduced-motion: reduce`: positional and scale motion becomes a cross-fade; fades and
progress/spinners stay; skeleton pulse becomes static. No animation is required to operate.
- The signature handoff route is static. It earns attention through typography and material, not
motion.

---

## 7. Depth, Surface & Materials

**Strategy: mixed tonal-shift + hairline borders.** Dark surfaces step up through luminance
(`--canvas` -> `--surface-1` -> `--surface-2` -> `--surface-3`); light surfaces step up to white.
Hairlines define edges. Shadows are reserved for true overlays (dialog, toast, drawer), never for
cards. There is no glass, no blur panel, no glow.

- **At rest:** surface + 1px `--line`; no shadow.
- **Raised interactive:** `--wash-1` hover, `--wash-2` press/selected, `--line-strong` edge.
- **Overlay:** `--surface-3` + `--line-strong` + `--shadow-overlay` + `--scrim`.
- **Inset:** code, skeletons, and wells use `--inset` with a 1px `--line` and no inner glow.
- **Chart ground:** 32px `--grid-line` grid with a radial fade. Static. It is the only texture.
- **Radius scale:** `--radius-xs 2px` (pills, badges), `--radius-sm 4px` (inputs, buttons, kbd,
segmented), `--radius-md 6px` (cards, panels), `--radius-lg 8px` (dialog, login plate),
`--radius-pill 999px` (avatars only). Nested corners are concentric: inner radius is outer
radius minus padding.

**Banned materials:** glassmorphism, gradient text, outer glows, neon, pure black, card shadows at
rest, colored side-stripe state borders, rounded-2xl card soup.

---

## 8. Accessibility Constraints & Accepted Debt

### 8.1 Constraints

- WCAG 2.2 AA floor: 4.5:1 body text, 3:1 large text and control edges, in both themes. Token pairs
in Section 2 are chosen to clear these; re-check if a token changes.
- `:focus-visible` ring on every interactive element: 2px `--focus`, 2px offset, radius follows the
control. Never remove focus outlines.
- Full keyboard reachability: skip link first, logical DOM order, Escape closes dialog/drawer,
Enter submits the non-destructive default, dialog focus returns to its trigger.
- Every form control has a visible `<label for>`; errors use `aria-invalid` + `aria-describedby`.
- Status is color + glyph + text. Active nav is wash + glyph + `aria-current`. Selected rows use
`aria-selected` + check glyph.
- Icon-only controls have `aria-label`; decorative icons are `aria-hidden="true"`.
- Motion respects `prefers-reduced-motion` (Section 6). No flashing, no auto-playing media.
- Touch targets: all buttons, nav items, segmented items, and fields resolve to 44px at < 768.
  32px is the desktop control height; icon buttons are square at the control height.
- Charts/figures are out of scope for stage 1; when added, no color-only encoding.
- The chart ground is decorative and `pointer-events: none`; under `forced-colors` it is hidden.

### 8.2 Accepted debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| 3 font families (serif + sans + mono) | Global | Functional split: identity, UI, machine data. No webfonts allowed; system stacks vary by OS. | Design lead; revisit only if system stacks render poorly on the owner's LAN clients. |
| System font rendering varies by OS | Global | Offline/LAN constraint forbids webfonts; Ubuntu/Palatino/DejaVu are the practical stacks. | Accepted for pre-alpha. |
| Chat session/context drawers do not trap focus | `assets/chat.js` | Secondary panes stay reachable by Tab and close with Escape, scrim click, or an explicit close button; focus returns to the opener. Native dialogs elsewhere use trapped focus. | Revisit only if the drawers become destructive or modal. |
| `dialog`, drawer, toast, theme, and busy-state JS live in `assets/app.js` | `assets/app.js` | A single shared, dependency-free progressive-enhancement file serves every product page. Pages remain server-rendered and forms work without it; the drawer, dialogs, theme toggle, toast dismissal, and submit busy state need it. Chat-specific behavior lives in `assets/chat.js`; the shell helpers stay shared. | Split only if the shell lifecycle changes. |
| Embedded IDE is not themed | `/ide/` | Third-party code-server surface; hanse must not restyle it. | Permanently out of scope; compatibility checked by eye. |
| Legacy compatibility classes remain | `src/http/styles.css` | The daisyUI-era product pages have been replaced; the aliases remain as a low-risk compatibility shim for old cached markup and are no longer used by new pages. daisyUI is not imported. | Remove in a dedicated cleanup with visual regression. |
| Chat renders every message in a session with no virtualization | `assets/chat.js` | One operator and short handoff sessions do not justify a virtual list; the thread keeps the existing message list and scroll preservation. | Add windowing only for sessions large enough to jank. |
| Chat markdown is a deliberate safe subset | `assets/chat.js` | Tables, images, embeds, and raw HTML are not rendered. This keeps untrusted agent output safe without an HTML sanitizer dependency. | Extend the DOM renderer; never switch to innerHTML. |
| Chat session/message timestamps depend on opencode shapes | `assets/chat.js` | Relative/absolute times are derived from `session.time`, `session.updatedAt`, and `info.time.created` when present; missing times are omitted rather than fabricated. | Revisit if opencode changes its response schema. |
| Showcase inline JS is excluded from Biome | `docs/design/showcase.html` | Static documentation harness with inline ES5 toggles, not product code. Product TypeScript and the capture script remain fully linted. | Remove the exclusion if the harness gains a build step. |
| System display serif varies by OS | Global | DejaVu Serif on this Linux host; Iowan/Palatino/Georgia on macOS/Windows. No webfonts are permitted. | Accepted; the stack is documented and tested on the host. |
| Theme control is two-state in the product shell | `src/http/ui.ts`, `assets/app.js` | Dark is the default; `data-theme` toggles light/dark and persists in `localStorage["hanse-theme"]`. A system-follow third state is not implemented. | Add only if the owner asks for system-follow. |
| Settings forms without JS lose values on validation | `src/http/settings.ts`, `assets/settings.js` | The JS path saves live via server-rendered section fragments; without JS, non-Git forms still submit and redirect, and Git credential forms are JSON-only with a visible `<noscript>`. | Revisit if no-JS usage is real. |
| Terminal reconnect starts a new shell | `assets/terminal.js` | PTYs are ephemeral Docker execs; there is no persistent multiplexer. | Add only as a separate feature. |
| No terminal search or web-links addon | `assets/vendor/xterm/` | The base terminal is complete without them; adding them needs a new vendored bundle and licence/checksum review. | Add only with a separate allowlist review. |
| Pre-v10 running instances show `Applied state unknown` | `src/opencode/manager.ts`, migration v10 | The applied hash was not persisted before this pass; the UI shows `Restart required` instead of guessing. | One-time; a restart records the values. |
| Chat runtime polling can lag up to 10s | `assets/chat.js` | The runtime endpoint is a cheap DB read; there is no runtime SSE. | Add runtime SSE only if state changes often enough to matter. |
| Terminal clipboard uses `execCommand` on insecure HTTP | `assets/terminal.js` | `navigator.clipboard` requires a secure context; the fallback keeps copy/paste usable on a LAN. | Revisit when TLS/reverse proxy is standard. |

### 8.3 Showcase harness and evidence

The showcase is a static document, not a production route.

```bash
npm run build:css          # compile src/http/styles.css -> assets/app.css
npm run design:showcase    # serve the repo at http://localhost:4173
# open http://localhost:4173/docs/design/showcase.html
node docs/design/capture.mjs   # regenerate docs/design/artifacts/*.png
```

Query parameters: `?theme=dark|light`, `?capture=1` (document-flow capture mode), `?focus=1`
(focus the project-name input for focus-visible evidence).

Evidence: `docs/design/artifacts/showcase-{390,768,1440}-{dark,light}.png`,
`shell-{1440,390}-{dark,light}.png`, `shell-390-drawer-dark.png`,
`focus-visible-1440-dark.png`, `dialog-1440-{dark,light}.png`,
`toast-1440-{dark,light}.png`, `tooltip-1440-dark.png`.

The Playwright script resolves an installed Playwright module and Chromium build; it adds no
dependency to the product. On hosts where Chromium needs `libasound`, the script prepends
`~/.local/lib` to `LD_LIBRARY_PATH` for the browser process.

---

## 9. Stage 2 Class & Token Contract (short form)

Stage 2 must compose product screens from:

- Shell: `.app-shell`, `.sidebar`, `.sidebar__head`, `.sidebar__nav`, `.sidebar__foot`, `.wordmark`,
`.sidebar__kicker`, `.sidebar__operator`, `.sidebar__close`, `.nav-label`, `.nav-item`,
`.nav-item__count`, `.nav-item__mark`, `.shell-main`, `.topbar`, `.topbar__brand`,
`.topbar__actions`, `.breadcrumb`, `.page`, `.page-header`, `.page__body`, `.scrim`,
`.nav-toggle`, `.btn.nav-toggle`.
- Content: `.card`, `.card__head`, `.card__title`, `.card__body`, `.card__body--flush`, `.card__foot`,
`.table`, `.table--stack`, `.table--handoffs`, `.table--inbox`, `.table-wrap`, `.table__check`, `.table__nowrap`,
`.table__route`, `.table__inline-form`, `.table__action-group`, `.table__actions`, `.table__primary`,
`.table__num`, `.watch-strip`, `.watch-strip--4`, `.watch`, `.route-card`, `.route`, `.route__end`,
`.route__app`, `.route__track`, `.route__node`, `.route__seal`, `.route__meta`,
`.route-card__summary`, `.route-card__foot`.
- Page composition: `.workbench-grid` (2fr/1fr at >=1280, rail below under that),
`.workbench-grid--detail` (main + 320px rail at >=1280), `.rail-stack`,
`.toolbar`, `.search-input`, `.summary-row`, `.stack--tight`, `.prose--pre`, `.cover`,
`.login-plate`, `.login-plate__head`, `.login-plate__brand`, `.login-plate__foot`, `.field__control`,
`.nav-item__label`, `.theme-toggle`, and the `[data-theme-icon]` / `[data-password-icon]`
visibility rules. These compose existing tokens only: they add no color, type size, radius, or
spacing value.
- Controls: `.btn` + variants/sizes, `.input`, `.select`, `.select-wrap`, `.textarea`, `.field`,
`.label`, `.hint`, `.field-error`, `.check`, `.checkbox`, `.segmented`, `.segmented__item`,
`.status`, `.badge`, `.status` state tokens, `.kbd`, `.avatar`, `.tooltip-wrap`, `.tooltip`,
`.dialog`, `.toast-region`, `.toast`.
- Feedback: `.empty-state`, `.error-state`, `.skeleton`, `.skeleton-stack`, `.spinner`.
- Chat: `.page--chat`, `.page__body--chat`, `.chat-shell--workspace`, `.chat-sessions`,
`.chat-sessions__tools`, `.chat-sessions__list`, `.chat-sessions__skeleton`, `.session-item`,
`.session-item__top`, `.session-item__title`, `.session-item__meta`, `.chat-sessions-close`,
`.chat-sessions-toggle`, `.chat-thread`, `.chat-thread__viewport`, `.chat-thread__scroll`,
`.chat-thread__inner`, `.chat-thread__meta`, `.chat-session-title`, `.chat-live`, `.chat-working`,
`.chat-new-messages`, `.chat-context`, `.chat-context__body`, `.chat-context__section`,
`.context-handoff`, `.context-handoff__head`, `.context-handoff__summary`, `.context-handoff__route`,
`.chat-context-close`, `.chat-context-toggle`, `.chat-scrim`, `.chat-app-select`, `.chat-runtime`,
`.chat-action-label`, `.chat-retry`, `.chat-empty`, `.chat-error`, `.chat-pane-head`, `.message`,
`.message__meta`, `.message__role`, `.message__time`, `.message__body`, `.tool-call`,
`.tool-call__path`, `.tool-diff`, `.tool-diff__scroll`, `.tool-diff__file`, `.tool-diff__head`,
`.tool-diff__hunks`, `.tool-diff__hunk`, `.tool-diff__hunk-head`, `.tool-diff__diagnostics`,
`.tool-diff__file-list`, `.diff-line`, `.diff-line__num`, `.diff-line__sign`, `.diff-line__code`,
`.tool-code`, `.tool-code__head`, `.tool-code__scroll`, `.code-line`, `.code-line__num`,
`.code-line__code`, and the scoped `.tool-diff .token*` / `.tool-code .token*` theme,
`.composer`, `.composer__row`, `.composer__hint`. Markdown descendants of
`.message__body` (`p`, `h3`-`h5`, `ul`, `ol`, `li`, `blockquote`, `pre`, `code`, `a`, `hr`, `strong`,
`em`) are part of the message surface and use existing type/space tokens.
- Interactive prompts and plan: `.chat-input-needed`, `.chat-input-needed__count`, `.policy-chip`,
`.chat-waiting`, `.chat-plan-chip`, `.policy-warning`, `.policy-warning__lead`,
`.policy-warning__mark`, `.policy-warning__label`, `.policy-warning__list`,
`.policy-warning__dismiss`, `.prompt-dock`, `.prompt-dock__card`, `.prompt-dock__head`,
`.prompt-dock__identity`, `.prompt-dock__count`, `.prompt-dock__queue-count`, `.prompt-dock__body`,
`.prompt-dock__title`, `.prompt-dock__copy`, `.prompt-dock__tabs`, `.prompt-dock__tab`,
`.prompt-dock__stepper`, `.prompt-dock__step-label`, `.prompt-question`, `.prompt-question__header`,
`.prompt-question__text`, `.prompt-options`, `.prompt-option`, `.prompt-option__body`,
`.prompt-option__label`, `.prompt-option__desc`, `.prompt-custom`, `.prompt-dock__review`,
`.prompt-review-list`, `.prompt-review`, `.prompt-review__body`, `.prompt-review__header`,
`.prompt-review__answer`, `.prompt-dock__foot`, `.prompt-confirm`, `.prompt-confirm__text`,
`.prompt-confirm__body`, `.prompt-dock__error`, `.risk-chip`, `.risk-chip__meter`, `.risk-chip__tick`,
`.prompt-scope`, `.prompt-scope__row`, `.prompt-scope__label`, `.prompt-scope__list`,
`.prompt-scope__note`, `.prompt-scope__action`, `.prompt-caveat`, `.prompt-evidence`, `.prompt-evidence__grid`,
`.prompt-evidence__label`, `.prompt-evidence__value`, `.prompt-evidence__pre`,
`.prompt-evidence__diff`, `.prompt-evidence__details`, `.prompt-feedback`, `.chat-queue`,
`.chat-queue__head`, `.chat-queue__list`, `.chat-queue__row`, `.chat-queue__kind`,
`.chat-queue__title`, `.chat-queue__session`, `.chat-queue__empty`, `.session-item__flag`,
`.chat-plan-section`, `.chat-plan__list`, `.chat-plan__item`, `.chat-plan__status`, `.chat-plan__body`,
`.chat-plan__content`, `.chat-plan__priority`, `.chat-plan__tick`, `.chat-plan__empty`, `.chat-saved`,
`.chat-saved__row`, `.chat-saved__meta`, `.chat-saved__action`, `.chat-saved__resource`,
`.chat-saved__project`, `.chat-saved__actions`.
- Utilities: `.display`, `.h1`, `.h2`, `.h3`, `.body-lg`, `.body`, `.small`, `.caption`,
`.overline`, `.mono`, `.rule`, `.rule--strong`, `.rule--double`, `.sr-only`, `.skip-link`,
`.chart-ground`.
- UX polish: `.state-strip`, `.state-strip__cell`, `.state-strip__label`, `.state-strip__value`,
`.state-strip__actions`, `.menu`, `.menu__panel`, `.menu__item`, `.disclosure`,
`.disclosure__chevron`, `.settings-nav`, `.settings-nav__scopes`, `.settings-nav__sections`,
`.settings-nav__link`, `.settings-section`, `.setting-row`, `.setting-row__summary`,
`.setting-row__title`, `.setting-row__effective`, `.setting-row__source`, `.setting-row__state`,
`.setting-row__chevron`, `.setting-row__body`, `.setting-row__form`, `.setting-row__actions`,
`.setting-row__reason`, `.setting-row__affordance`, `.scope-details`, `.scope-list`,
`.scope-list__row`, `.scope-list__state`, `.settings-warning`, `.provider-add`,
`.settings-noscript`, `.page--terminal`, `.page__body--terminal`, `.terminal-shell`,
`.terminal-toolbar`, `.terminal-toolbar__title`, `.terminal-toolbar__meta`,
`.terminal-toolbar__status`, `.terminal-toolbar__actions`, `.terminal-banner`, `.terminal-host`,
`.terminal-empty`.

No product screen may introduce a new hex, px font size, radius, or spacing value. If a new pattern
is needed twice, add it here and to `styles.css` first.
