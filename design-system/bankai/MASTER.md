# Design System Master File — Bankai Landing

> **LOGIC:** When building a specific page, first check `design-system/bankai/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.
>
> **This file is the single source of truth.** No color, font, spacing, or radius value
> may be hardcoded in components outside the tokens defined here.

---

**Project:** Bankai — public landing page (pre-login `/`)
**Generated:** 2026-07-23 (ui-ux-pro-max base, curated against PRODUCT.md)
**Updated:** 2026-07-23 — **light theme is the default** (user decision). The dark
version is deferred until the whole app ships dark mode; these tokens flip then.
**Category:** Developer / security tool — marketing register (brand)
**Design Dials:** Variance 7/10 | Motion 4/10 (standard, purposeful) | Density 3/10 (spacious)

---

## Design Direction

**"Terminal-honest precision."** The page reads like the product: pipeline states,
monospace evidence, ASCII structure as a design material. Light, hue-less neutral
surfaces shared with the product app (iOS-gray family, `#1C1C1E` text on `#F4F4F5`),
with color reserved exclusively for *state*: CI pass green, severity red/orange,
action blue. The Bankai slash mark is the only decorative gesture, used sparingly
and large.

Terminal and diff panels are **white** (`#FFFFFF`) code surfaces on the gray page
(user decision 2026-07-23) — the border and mono type carry the terminal identity,
not a dark fill.

---

## Global Rules

### Color Palette

Neutrals are hue-less, shared with the product app's `#1C1C1E`/`#F4F4F5` family.
State colors are darkened for AA contrast on light surfaces.

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Background (page) | `#F4F4F5` | `--color-bg` |
| Surface (raised cards, panels) | `#FCFCFD` | `--color-surface` |
| Surface alt (active tab fill) | `#EFEFF2` | `--color-surface-alt` |
| Code surface (terminal, diff) | `#FFFFFF` | `--color-code-bg` |
| Border | `#E5E5EA` | `--color-border` |
| Border strong / hover | `#D1D1D6` | `--color-border-strong` |
| Text (primary) | `#1C1C1E` | `--color-text` |
| Text muted | `#5A5A60` | `--color-text-muted` |
| Text faint | `#6E6E73` | `--color-text-faint` |
| Action blue (primary CTA) | `#2563EB` | `--color-blue` |
| Action blue hover | `#1D4ED8` | `--color-blue-dark` |
| CI green (pass / success) | `#15803D` | `--color-green` |
| Severity critical | `#DC2626` | `--color-red` |
| Severity high | `#C2410C` | `--color-orange` |
| Severity medium | `#A16207` | `--color-yellow` |
| Severity low | `#6E6E73` | `--color-severity-low` |

**Rules:**
- Blue = interactive/CTA only. Green = pass/verified only. Red/orange/yellow = severity/failure only.
- No gradients on text, ever. No decorative color washes. A faint radial glow behind the
  hero mark (blue at ≤ 6% opacity) is the maximum permitted atmosphere.
- All text ≥ 4.5:1 contrast on its surface (muted `#5A5A60` on `#F4F4F5` ≈ 6.2:1 ✓;
  faint `#6E6E73` ≈ 4.6:1, safe for small mono annotations; decorative ASCII may
  further reduce via opacity since it is aria-hidden).

### Typography

| Role | Font | Usage |
|------|------|-------|
| Display / headings | **Inter** (600/700) | Headlines, section titles. Tight tracking (−0.02em to −0.04em on display sizes). |
| Body | **Inter** (400) | Paragraphs, descriptions. 16px base, line-height 1.6. |
| Terminal / labels | **JetBrains Mono** (400/500) | ASCII art, code, pipeline states, kickers (11–13px uppercase +0.08em tracking), stat figures. Nav links are Inter (user decision, 2026-07-23). |

- Inter is the product app's own typeface — the landing page shares it by explicit
  user decision (2026-07-23), overriding the earlier no-Inter constraint. Brand
  continuity between the marketing page and the app wins.
- The **wordmark/mark SVGs** (`frontend/src/assets/bankai-*.svg`) are the brand type —
  natively black, used as-is on the light page (no filter). Never re-set "BANKAI" in a web font.

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:ital,wght@0,400;0,500;0,700;1,400&display=swap');
```

**Type scale (desktop / mobile):**

| Token | Size | Usage |
|-------|------|-------|
| `--text-display` | `clamp(40px, 6vw, 72px)` | Hero headline, Inter 700, lh 1.05 |
| `--text-h2` | `clamp(28px, 4vw, 44px)` | Section titles, Inter 700, lh 1.15 |
| `--text-h3` | `20px` | Card/feature titles, Inter 600 |
| `--text-body` | `16px` | Body, lh 1.6 |
| `--text-small` | `14px` | Secondary copy |
| `--text-mono` | `13px` | Terminal text, labels, JetBrains Mono |
| `--text-kicker` | `12px` | Uppercase mono kickers, +0.08em tracking |

### Spacing (Density 3/10 — Spacious)

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` | Tight gaps |
| `--space-sm` | `8px` | Icon gaps, inline spacing |
| `--space-md` | `24px` | Standard padding |
| `--space-lg` | `32px` | Card padding |
| `--space-xl` | `48px` | Large gaps |
| `--space-2xl` | `64px` | Section internal margins |
| `--space-3xl` | `96px` | Section padding (desktop); 64px mobile |
| `--space-hero` | `128px` | Hero vertical padding (desktop) |

Content max-width: `1120px` (`--container`), gutter `24px` mobile / `32px` desktop.

### Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-md` | `10px` | Buttons (non-pill), inputs, small chips |
| `--radius-lg` | `16px` | Cards, panels, terminal windows |
| `--radius-pill` | `999px` | Primary CTAs (matches app's pill CTA language) |

### Shadow / Elevation

Light theme: elevation = **border + subtle lift**, matching the app; the white
terminal panel gets one soft shadow to lift it off the gray page.

| Level | Value | Usage |
|-------|-------|-------|
| Raised | `1px solid var(--color-border)` on `--color-surface` | Cards, panels |
| Hover | border → `--color-border-strong` + `translateY(-2px)` | Interactive cards |
| Terminal | `0 12px 32px -16px rgba(28,28,30,0.16)` lift | Terminal chrome |
| Glow (hero only) | `radial-gradient` blue ≤ 6% opacity, 600px blur circle | Behind hero mark only |

---

## Component Specs

### Buttons

```css
/* Primary CTA — pill, blue (matches product app language) */
.btn-primary {
  background: var(--color-blue);
  color: #fff;
  padding: 12px 28px;
  border-radius: var(--radius-pill);
  font: 600 15px 'Inter';
  transition: background 200ms ease, transform 150ms ease;
  cursor: pointer;
}
.btn-primary:hover { background: var(--color-blue-dark); }

/* Secondary — outline on light */
.btn-secondary {
  background: transparent;
  color: var(--color-text);
  border: 1px solid var(--color-border-strong);
  padding: 12px 28px;
  border-radius: var(--radius-pill);
  transition: border-color 200ms ease, background 200ms ease;
}
.btn-secondary:hover { border-color: var(--color-text-faint); background: rgba(28,28,30,0.04); }
```

### Cards / Panels

```css
.panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  transition: border-color 200ms ease, transform 200ms ease;
}
.panel:hover { border-color: var(--color-border-strong); }
```

- **NO identical card grids** — feature layouts must vary (bento asymmetry, terminal
  panels, ledger rows, split layouts).
- **NO side-stripe borders** on cards.
- **NO glassmorphism** (no backdrop-filter blur panels).

### Terminal Window (signature component)

Terminal and diff panels are **white** code surfaces (`--color-code-bg`); border,
titlebar dots, and mono type carry the terminal identity.

```css
.terminal {
  background: var(--color-code-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 12px 32px -16px rgba(28,28,30,0.16);
  font: 400 13px/1.7 'JetBrains Mono';
}
.terminal-titlebar { border-bottom: 1px solid var(--color-border); /* three 10px dots in --color-border-strong, never traffic-light colors */ }
```

### Focus states

```css
:focus-visible { outline: 2px solid var(--color-blue); outline-offset: 2px; }
```
Never remove focus rings.

---

## ASCII Art Rules

ASCII is a first-class design material on this page, not a gimmick:

- Always JetBrains Mono, `--color-text-faint` or `--color-text-muted`; state characters
  may use state colors (`✓` green, `✗` red, `▓` severity colors).
- Always wrapped in `<pre aria-hidden="true">` with a text alternative nearby —
  ASCII is decorative reinforcement, never the sole carrier of information.
- Pipeline diagrams, box-drawing borders (`┌─┐│└┘├┤`), the Bankai slash rendered in
  block characters, progress/severity bars (`▓▓▓░░`).
- On mobile (< 768px) wide ASCII pieces scale down via `font-size` reduction or swap
  to a narrower variant — never horizontal page scroll.

---

## Motion

Standard tier (4/10) — purposeful, physical, never decorative-only. Framer Motion.

**Default enter recipe (Jakub Krehel):**
```js
initial={{ opacity: 0, translateY: 8, filter: "blur(4px)" }}
animate={{ opacity: 1, translateY: 0, filter: "blur(0px)" }}
transition={{ type: "spring", duration: 0.45, bounce: 0 }}
```

- Scroll reveals: `useInView` + the recipe above, `once: true`, margin `-80px`.
- Hero: staggered children (0.08s each).
- Micro-interactions: `whileHover` / `whileTap` (scale 0.97 tap) on buttons and cards.
- `AnimatePresence` wraps every conditional render (FAQ accordion, mobile menu).
- Terminal typing effects: steps() or interval-driven, mono only.
- All variants live in `src/lib/animations.ts`.
- **`prefers-reduced-motion` respected on every animation** (useReducedMotion → disable
  translate/blur, keep opacity).
- No `back.out` overshoot on informational UI. No animating width/height (transform only).

---

## Page Pattern (Landing Structure)

Product-led developer-tool landing (NOT App-Store pattern):

1. Sticky navbar — wordmark, anchor links (mono), Log in / Sign up CTAs
2. Hero — kicker, headline, subcopy, dual CTA + ASCII pipeline art / terminal proof
3. Social proof — integration strip (GitHub, Jira, Supabase, Gemini, Arcjet…) as mono ledger
4. How it works — the pipeline as interactive terminal walkthrough
5. Features — asymmetric bento (varied layouts per cell)
6. Security / trust — audit-style ledger rows
7. Pricing — 3 tiers, mid-tier highlighted (border, not fill)
8. FAQ — accordion (AnimatePresence)
9. Final CTA — large slash mark moment
10. Footer — mono sitemap + ASCII signature

CTA strategy: "Sign up" primary in nav + hero + final; "Log in" secondary. All CTAs
route to existing `/signup` and `/login` pages.

---

## Anti-Patterns (Do NOT Use)

- ❌ Gradient text
- ❌ Glassmorphism / backdrop blur panels
- ❌ Identical card grids (three same-shaped cards in a row)
- ❌ Side-stripe borders on cards
- ❌ Slate-blue "generic SaaS" palette — neutrals are hue-less
- ❌ Neon/matrix hacker clichés, scanlines, skulls, fear language
- ❌ Emojis as icons (SVG only — Lucide-style strokes, 1.5px)
- ❌ Dark page default — light is the default until the whole app ships dark mode (user decision 2026-07-23)
- ❌ Roboto / Arial / system-font-only stacks (Inter + JetBrains Mono are the faces)
- ❌ Missing cursor:pointer, invisible focus states, instant state changes
- ❌ Layout-shifting hovers
- ❌ Text below 4.5:1 contrast (decorative ASCII exempt, `aria-hidden`)

---

## Pre-Delivery Checklist

- [ ] Every color/font/spacing value traces to a token in this file
- [ ] Category-reflex check passed (not predictable from "dark security SaaS")
- [ ] No emojis as icons; consistent SVG icon set
- [ ] cursor-pointer on all clickables; hover transitions 150–300ms
- [ ] Focus states visible; keyboard navigable (accordion, menu)
- [ ] prefers-reduced-motion respected on every animation
- [ ] Responsive: 375px / 768px / 1024px / 1440px; no horizontal scroll
- [ ] ASCII art aria-hidden with text alternatives
- [ ] Images (if any) lazy + dimensioned (CLS < 0.1)
- [ ] No content hidden behind sticky navbar (scroll-margin on anchors)
