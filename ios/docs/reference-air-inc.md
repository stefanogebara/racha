# Reference: air.inc

Captured 2026-09-05 through the session proxy (Chromium fulfilling every request
via curl; the browser's own tunnel was reset). Desktop 1440×900 and phone
390×844 @2x, seven scroll stops each, plus the nine stylesheets, the font files,
and the demo imagery pulled from Storyblok. Rendered values below are computed
styles read from the live DOM, not guesses from the CSS.

## What it is

One continuous atmosphere, not a page of sections. The homepage is a deep cobalt
sky — `#0563e9` "altitude" at the bottom brightening from near-black at the top
— with volumetric cloud photography drifting at the edges. Sections have no
backgrounds of their own; `Section_root_background:before` feathers a 200px
gradient so they bleed into each other. White ink throughout. The cream
`--page-bg: #fff8dc` in `:root` is the sub-page default and never appears on
the homepage; sub-pages switch per section with `--theme: dark|light` and a
`--fg/--bg` pair.

The hero is a 3D glass tube spelling "Air" in the brand cursive — refraction,
a thin cyan specular edge, the sky visible through it. Dimensional but
transparent.

## Type

One family, "Control", in four cuts. That is the whole system.

| role | face | rendered | notes |
|---|---|---|---|
| poster | Control Compressed 900 | 259px / lh 0.85, uppercase; 200px for single words; ~110px on phone | "AIR DOES THE TASKS. YOU DO THE WORK." flush-left, three lines, the width of the viewport |
| headline | Control TNT 400 | 56px / lh 1.0 (h1), 40px / lh 1.0 (h2), 32px / 1.1 (h3, w500) | tight, `letter-spacing: -.045rem` on the small cut |
| card title | Control 500 | 20px / 28 | |
| body | Control 500 | 16px / 24 · 14px · 12px | secondary at ~80% white |
| accent | Control Cursive 300 italic | inline in headlines | "A creative library that *organizes itself*", "space to *breathe*" — the emotional phrase gets the cursive |
| nav / fallback | PP Neue Montreal 400/500 | 16px | |
| serif accent | Riccione Serial ExtraLight 200 | sub-pages | |
| ticker | Dot Matrix | | a receipt-printer voice |

Scale contrast is the defining move: 259px display against 16px body is 16:1 on
desktop, roughly 7:1 on phone. A single word — UNDERSTAND, ORGANIZE, SCALE —
gets an entire viewport, centred, with the paragraph set *over* the bottom
third of the word at 70% opacity.

## Spacing

`--row-margin: 24px` is the unit. Section padding is 5× (120px) on desktop and
2.5× (60px) on phone; the gap inside a section is 2× (48px); grid gutter 24px;
content width 1150 in a 1600 page, 12 columns. Whitespace is used as pace: the
Understand/Organize/Scale section is 1020px tall; the whole page is 13.7k.

## Layering — the part worth studying

Depth comes from six layers, none of which is a drop shadow:

1. **Atmosphere** — the sky gradient plus soft cloud imagery.
2. **Glass** — cards with a 1px border at `rgba(255,255,255,.2–.35)`,
   `backdrop-filter: blur(4px)`, an inner wash of `linear-gradient(to bottom,
   rgba(bg,.05), rgba(bg,.1))`, radius 16px on phone. No shadow on the dark
   theme. The active card's border is an `AnimatedBorder`: a rotating conic
   gradient stroke, `rgba(fg,.66) → .1 → .66`, so the border is luminous.
3. **Ghost UI** — the product's own interface re-rendered as a low-contrast blue
   duotone (translucent frames, a dotted-grid backdrop), anchored to the card's
   bottom edge and cropped by it, so it reads as peeking up into the card
   (`object-position: center bottom`, `border-radius: 0 0 11px 11px`).
4. **Content** — real, full-colour, physical-world material placed *on top* of
   the ghost UI at slight rotations, overlapping like prints on a table: a
   chartreuse brand card, product photographs, a line-drawn oil bottle. This is
   the only saturated colour in the frame, and it is always the customer's
   content, never Air's chrome.
5. **Chrome accents** — crisp 1px selection brackets in cyan and orange over a
   photograph; frosted-glass pills for search terms and captions.
6. **Wordmark** — the glass tube, refracting the sky.

The chart demo follows the same logic: bars are 1px translucent outlines with
the value inside at the top, and a row of full-colour photo thumbnails runs
along the axis. Data viz as ghost outline plus real thumbnails.

## Components

- **Buttons** — 38px tall, 8px radius, 1px border in `--fg`. Primary: white
  fill, black text. Secondary: outlined. Hover: a skewed radial-gradient sweep
  over 1s. Icon 16px. On phone the same pair sits in the nav at ~36px with a
  hamburger pill beside it.
- **Eyebrow** — "Coming soon": frosted pill, rounded-full, 1px border,
  4px 8px padding, 24px below it.
- **Input** — frosted glass fill (~20% white), a brighter 1px border, 16px
  radius, tall (44px on phone), then a full-width solid white pill button.
- **Card** — 1px border, 16px radius, 32px padding (24 on phone), title
  20/28 white, body 16/24 at 60–80%.
- **Icons** — Phosphor regular at 23px, white.
- **Logo row** — customer marks at ~40% white.
- **Form** — the one solid white card on the page, grey inputs, 16px radius.

## Motion

`cubic-bezier(.22,1,.36,1)` — an ease-out-quint — at 0.6–2s, everywhere. Reveal
is scroll-gated (`u-animation-paused` until in view). Also present:
`cubic-bezier(.34,2.56,.64,1)` for one overshoot, `.65,0,.35,1` for symmetric
moves.

## Voice

Short declaratives with no adjectives. "Air does the tasks. You do the work."
"Air keeps track. So you keep creating." "Make it once. Run it everywhere."

## What transfers to Racha, and what does not

Not the sky. That is Air's brand, and a bar tab is not weather.

What transfers is the system:

- **Scale.** The hero figure becomes a poster: a compressed black cut at
  ~120px on a 390px screen, line-height 0.85. Ours has been 52px, which is a
  large number, not a headline.
- **One family, many cuts.** A variable grotesk with a width axis gives a
  compressed 900 for the poster figure, a tight medium for headings, and a
  regular for body — one voice at three widths, as Air does with Control. The
  serif survives as the *accent*, the way Air uses its cursive: for the spoken
  line ("o Pedro chegou depois, só bebeu"), not for the body.
- **Atmosphere over paper.** Racha's equivalent of Air's sky is the bar at
  night: a dark, warm canvas with a low light source, and the cream comanda as
  the one light surface on it — the same role Air's solid white form card
  plays. The woodcut prints the natural way for dark stock: cream ink, the
  inverse block.
- **Glass over hairlines.** Cards with 1px translucent borders and backdrop
  blur; the active racha's border luminous; ghosted low-contrast rows behind
  full-strength figures.
- **24px.** One spacing unit, and enough of it that a single figure can own a
  third of the screen.
- **Ease-out-quint at 0.6–1s** for everything that is not the spring-driven
  morph.
