# Lifeline web: design brief

## Subject

Lifeline tops up a trader's Hyperliquid margin before liquidation. The trader funds a reserve on NEAR from any chain through NEAR Intents (1Click). A keeper reads their account health every 5 seconds, and when health falls below the trigger they set, it asks a NEAR vault contract to pay a signed 1Click quote that delivers USDC to their own Hyperliquid perps balance. The vault checks every rule on chain, including 1Click's signature, so a hacked keeper can't redirect the money.

## Audience

1. Hackathon judges: AI screeners (Claude Code, Codex) that read the README and open the demo, then a human jury that gives each entry a few minutes. They need to see a rescue happen and believe the safety claim, fast.
2. Perps traders on Hyperliquid. They live in dark trading terminals, read tabular numbers quickly, and trust on-chain proof, explorer links and open source over copy.
3. NEAR builders: they look for real use of Intents, function-call keys and TEE attestation.

## The one job

Show a liquidation being prevented, live, on the first screen, and make the "a hacked keeper still can't steal it" claim believable.

- Primary CTA: **Watch the live demo** (no wallet, no funds) → `/position?user=demo.near`
- Secondary CTA: **Protect my position** → `/start`

## The subject's world

- Sea rescue: lifebuoys (white ring, four orange quarters), a throw line uncoiling through the air, a body of water that rises and falls, coast-guard livery (high-vis orange, white, a diagonal stripe), stencilled hull markings.
- The load line (Plimsoll mark) painted on every ship's hull: a circle crossed by a bar and a ladder of lines that shows how deep a ship may safely sit. Our warn, trigger and liquidation levels are a load line.
- Marine instruments: depth sounders, tide gauges, sonar pings, instrument glass, tick-marked dials.
- Trading: live prices, maintenance margin, liquidation price, tabular figures, terminals.
- Motion in this world: water rises slowly and heavily; a throw line snaps out fast and pulls taut; an instrument pings on a steady beat (the keeper's 5 s poll); a rescued thing settles, it doesn't bounce.
- Sound: sonar ping, rope whip (none by default; no audio planned).

## Dials (v2, 2026-11-09)

- CRAZINESS 8 on the landing page; 5 on the tool pages, which must stay fast to read.
- MOTION 8.
- DENSITY 4 on the landing page; 6 on the tool pages.
- v2 brief from Prashant: a full redesign of every page, bright daylight palette, printed illustration plus paper cut-out art, kinetic type and motion, easy navigation, "high class professional". No 3D models.

## Hard constraints

- Stack: Next.js 16 App Router, **static export** (no server code), React 19, Tailwind 4, served as Cloudflare Workers static assets. Wallet via `@hot-labs/near-connect`.
- Pages: `/`, `/position`, `/history`, `/ledger`, `/fund`, `/start`, `/telegram`, 404. Accounts come in `?user=`.
- Must appear on the landing page: live demo health from the sim keeper, keeper stats, the NEAR AI attestation result, how it works, the safety guarantees, links to the ledger and the source.
- Honesty: anything from the simulation is labelled as simulation (violet). No decorative chart may look like real data. Nothing may promise that liquidation can't happen.
- Performance: Lighthouse mobile performance 85+, accessibility 95+, CLS < 0.1. Works from 360 px to 1920 px, keyboard usable, `prefers-reduced-motion` respected.
- New dependencies only where the design needs them (GSAP is fine for the kinetic type and paper parallax). No WebGL scene library.
- Deadline: submission by 14 Nov 2026, 20:00 IST. The redesign must not risk the live demo.
- No credits or reference names anywhere in the repo or the site.
