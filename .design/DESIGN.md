# Lifeline web: design system

Direction: **Load line.** Your account health is a sea level painted against a ship's load line. Falling health is rising water; a rescue throws a line from the reserve and the water drops back.

## Taste (from taste.md; it decides every call)

- IS: **steady** (calm under pressure, heavy motion that settles), **vigilant** (live readings, a ping on every real read), **candid** (real numbers, the simulation labelled, refusals shown as proudly as rescues).
- NEVER: casino, corporate bank, frantic.
- Feel in motion: water is heavy and slow; the throw is the one fast thing; readouts step, they don't fade.
- Material: night water, painted hull steel, stencilled markings, wet rope, instrument glass, monospaced readouts.
- Lines not to cross: no number on screen that the keeper didn't read; the simulation is always labelled; no red flashing; no custom cursor or scroll hijacking; motion never delays reading a number or pressing a button; nothing promises liquidation can't happen.

## Tokens (`apps/web/src/app/globals.css`, Tailwind 4 `@theme`)

| Token | Value | Use |
| --- | --- | --- |
| `--color-ink-950…500` | #060b10 → #34495a | Hull and sea at night: backgrounds, rules, borders |
| `--color-mist-400…100` | #6c8090 → #e3eaef | Secondary text |
| `--color-paper` | #f5f1e8 | Headlines, the certificate panel |
| `--color-rescue` | #ff7a3d | Only where Lifeline acts: the trigger line, the thrown line, the primary button, refusal codes |
| `--color-safe` / `warn` / `danger` | #3ed3a2 / #f4b63f / #ff5266 | Health zones only |
| `--color-sim` | #a99bff | The simulation, and nothing else |
| `--font-stencil`, `--font-display` | Saira Stencil (OFL), condensed to 84 % by default | h1 and h2 only, the load-line labels, the wordmark. Never h3: smaller titles are Plex Sans 600 in sentence case, so the stencil keeps its authority |
| `--font-readout` | Martian Mono (OFL) | Big readouts, the status line, the keeper's log |
| `--font-sans` / `--font-mono` | IBM Plex Sans / Mono (OFL) | Body copy, tables, figures in the tool pages |
| `--radius-md…3xl` | 4 / 5 / 6 / 8 / 10 px | Hull plating: corners stay tight at every size |

Type scale: hero headline `clamp(50px, 6.6vw, 104px)`, leading 0.86, uppercase, stretch 78 %. Section titles `clamp(34px, 4.6vw, 64px)`, uppercase. Hero readout `clamp(52px, 6.4vw, 104px)` Martian Mono light. Readout rail `clamp(26px, 2.9vw, 42px)` at stretch 80 %. Body 15–17 px Plex Sans.

Layout: content in `max-w-6xl` with 16/24 px gutters; the hero and the livery stripe bleed to the viewport edges. Sections are separated by space and hairlines (`border-ink-600`), not by cards. Cards remain only in the tool pages.

## Motion

| Name | Value | Where |
| --- | --- | --- |
| water | critically damped spring, ω = 4.2 (about 1 s to settle), never overshoots | The sea level (`settle` in `lib/waterline.ts`) |
| throw | 240 ms, cubic ease-out, then 700 ms from slack to taut | The rescue line |
| land | 380 ms after the throw, the refill's level takes over | Replay beats |
| ping | 1.3 s, elliptical ring fading out | One per real reading that arrives |
| sea state | wave amplitude × 0.55 safe, 0.85 warn, 1.2 rescue, 1.3 liquidation, eased over ~1 s | Waves follow stress, never frantic |
| step | 300 ms opacity | Log lines appearing with their beats; hidden lines keep their space |
| lead fill | CSS scroll timeline (`view()`), entry 20 % → cover 70 % | The how-it-works line; full and still where unsupported or reduced |

Reduced motion: no waves, no ping, no auto-replay; levels jump straight to the reading; the line, if a replay is asked for, appears whole and fades after 2.6 s; the log shows every line. One animation loop per waterline, paused off screen and in hidden tabs, DPR capped at 2.

## Signature moment: the waterline (`components/Waterline.tsx`, `components/HeroWater.tsx`)

- Trigger: on load, once the sim keeper's audit log arrives, the last finished rescue replays (`lastRescueStory`, `replayBeats`). It replays again whenever a newer rescue lands while the page is open, and on "Replay the last rescue".
- Timeline: warning level (recorded) → 2.4 s → trigger level (recorded) → 0.5 s → the line is thrown, `+amount` tag → 0.38 s → the restored level (recorded) → 2.6 s hold → live reading.
- The readout only ever shows recorded or live values; the water moves smoothly between them.
- Untrusted or missing readings: the water stays where it was, hatched and dashed, never lowered toward "safe".
- The line is thrown from a labelled point at the top of the load line's spine ("Reserve · vault (simulated)") and ends at a lifebuoy on the surface, tagged with the amount and the Hyperliquid address it paid. Its sag hangs left of the spine, so it never crosses the labels. The disc is orange and labelled "Your trigger".
- Over the text column the surface line drops to 16 % and the level hairlines start after the column, so the water never slices the copy.
- Mobile: kicker, headline, then the water as its own 42svh panel with the scale cut at 2.4 (no empty deep water), then the buttons, the paragraph and the log. The disc is hidden; marks read inline ("Liq. 1.00").
- The position page uses the same instrument in a card (`size="panel"`): a ping on each reading, the line thrown when a newer rescue lands.

## Components

- Header: stencil wordmark beside the lifebuoy mark; the active page is marked with a 3 px orange bar, like a load-line mark.
- Hero: kicker in mono, stencil headline, one paragraph, two buttons, the instrument panel (status line + the keeper's log) at the bottom of the left column.
- Readout rail: five readings between hairlines, no cards.
- Sounding line: how a rescue happens as four lifebuoy marks on a rope (orange with a paper twist) that fills on scroll.
- Certificate: the attestation result on a paper panel with an upright status plate in the result's colour.
- Livery stripe: one orange band and a paper pinstripe at −3°, the turn into the safety section.
- Spec sheet: what a hacked keeper can't do, with the contract's refusal codes, beside a receipt of the real on-chain refusal (from, called, answer, time, transaction), held equal to `scripts/attack-proof-testnet.json` by a test.
- Order below the hero: readouts, how a rescue happens, the livery stripe, what a hacked keeper can't do, then the certificate.
- Tool pages keep their layouts and cards; they inherit the tokens, the stencil titles and the tight corners.
