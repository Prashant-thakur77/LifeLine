# Lifeline web: design system (v2, bright daylight)

Direction: **Paper sea, printed in daylight.** Your account health is the level of a sea made of cut paper, against a load line printed on an orange hull. Falling health is rising water; a rescue throws a line from the reserve and a lifebuoy lands. Minimal: one idea per section, one primary action per screen.

## Taste (from taste.md; it decides every call)

- IS: **bright** (warm paper, sea blue, signal orange, sunshine, mint), **crafted** (riso print, cut paper, kinetic type, all made for Lifeline), **candid** (real numbers, the simulation labelled, proof one click away), **minimal** (overrides the rest: every graphic has a job).
- NEVER: childish, casino, template, cluttered.
- Motion: paper moves like paper (700–1100 ms, ease-out, no bounce); the throw is the one fast thing (≈260 ms); type reveals are readable within half a second.
- Material: uncoated paper, riso ink overprinting slightly out of register, halftone dots, cut edges with soft shadows, fine grain.
- Lines not to cross: no number the keeper didn't read; the simulation always labelled; AA contrast for text; no custom cursor or scroll hijacking; nothing promises liquidation can't happen.

## Tokens (`apps/web/src/app/globals.css`, Tailwind 4 `@theme`)

| Token | Value | Use |
| --- | --- | --- |
| `paper` / `paper-2` / `card` / `shade` | #fff7ea / #fbeedb / #fffcf5 / #f2e6d1 | Page, alternate fills, cards and inputs, skeletons |
| `ink` / `ink-2` / `body` / `muted` | #0b1533 / #24305a / #3b4568 / #5e6684 | Headlines, strong text, body copy, secondary text (all ≥ 5:1 on paper) |
| `line` / `line-strong` | ink at 13 % / 32 % | Hairlines |
| `sea` / `sea-deep` / `sea-light` | #1d4bff / #0e2fb3 / #8fb0ff | The sea, the safety notice, the footer, focus rings |
| `rescue` | #ff5a1f | Where Lifeline acts: the hull, the primary button, the pen line |
| `sun` | #ffc93c | The stats band, the printed sun, selection, hover |
| `safe` / `warn` / `danger` | #19c79a / #f5a100 / #e5243b | Health only |
| `sim` | #7b5cff | The simulation, and nothing else |
| `*-ink` variants | rescue #c2410c, safe #08805f, warn #9a5b00, danger #c0182c, sim #5b3fd9 | The same accents as small text on paper (AA) |
| Type | Archivo (OFL, `wdth` 62–125), Martian Mono (OFL), IBM Plex Mono (OFL) | Headlines at `wdth` 70 weight 800 uppercase; body Archivo 100; readouts Martian Mono; tables Plex Mono |
| Radii | 4 / 6 / 8 / 12 / 16 px | Paper corners |

Borders are 2 px ink. **Offset ink shadows (`3px 3px 0 ink`) mark what you can click**: buttons press into them; static cards have none.

Scale: hero headline `clamp(52px, 7.6vw, 122px)` / leading 0.84; section titles `clamp(40px, 5.6vw, 84px)`; page titles `clamp(40px, 6vw, 76px)`; hero readout `clamp(56px, 7vw, 112px)` Martian Mono light; body 15–17 px.

## Motion

| Name | Value | Where |
| --- | --- | --- |
| kin-rise | 760 ms, cubic-bezier(.2,.8,.2,1), lines staggered 90 ms | Hero headline lines rise out of masks |
| buoy-roll | 1100 ms, delay 300 ms | The lifebuoy O rolls into LIQUIDATION |
| listing | 900 ms transition | Headline lines tilt (−1.4°, 1°, −0.8°) while health is in the rescue zone, level otherwise |
| pen-draw | 900 ms, delay 900 ms | The one pen line under "your own Hyperliquid address" |
| water | critically damped spring, ω 4.2 | The paper sea's level |
| wave-drift | 36–58 s linear, alternate directions | Each paper sheet drifts sideways |
| throw | 260 ms ease-out, then 700 ms to taut; splash 620 ms | The rescue line, buoy and paper splash |
| scene loops | lighthouse beam 5 s (the keeper's pace), coin drop 2.8 s, buoy bob 3.2 s | How-it-works scenes |
| how-slide | CSS scroll timeline, section pinned for 290vh, range contain 4–96 % | Desktop: the four scenes slide sideways as you scroll, a rope fills underneath. Phones, reduced motion and browsers without scroll timelines get the plain grid |
| smooth scroll | Lenis 1.3.25, lerp 0.11, landing page only, fine pointers only | The landing glides; tool pages keep native scrolling |
| page-in | 520 ms, transform only | Every route change |

Reduced motion: every animation and transition is cut to its end state; no smooth scrolling, no pinned slide; the sea sits still; no auto-replay; levels jump; the log shows every line.

## Signature moment

The hero's paper sea (`components/Waterline.tsx`, `components/HeroWater.tsx`): health sets the level of four drifting paper sheets against a load line printed on an orange hull, under a printed sun. On load the last rescue replays from the audit log: warning level, trigger level, the line thrown from "Reserve · vault (simulated)" to a lifebuoy tagged with the amount and the Hyperliquid address, a paper splash, the refill level; the ink log ticket steps through the same records. Mobile: the scale stops at 2.4 so the panel has no empty deep water; labels shorten.

## Components

- Header: lifebuoy mark and condensed wordmark; nav items as ink tabs (active filled ink, hover sunshine); primary "Connect wallet".
- Page header: ink eyebrow tag, condensed uppercase title, a strip of three paper waves underneath.
- Cards: 2 px ink border on card paper. Buttons: pressable, offset ink shadow. Badges: printed tags with an ink edge. Notices: tinted paper with an ink edge.
- Landing: hero (headline with the lifebuoy O, one paragraph, two buttons), the paper sea with the readout and the log ticket, the sunshine stats band, four paper scenes, the blue safety notice with the refusal receipt, the inspection panel, one orange closing step.
- Footer: paper-wave strip into deep sea, big wordmark, navigation, network and source.
- Position page: the same paper sea in a card (`size="panel"`).
