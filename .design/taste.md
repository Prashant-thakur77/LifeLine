# Lifeline: taste profile

The filter for every design decision. Derived from the project, not from a conversation: the assumptions are marked, and Prashant can overrule any of them.

## Personality

The site IS:

- **Steady.** Calm under pressure. Large, unhurried type; heavy, slow motion that settles instead of bouncing; generous space around the one number that matters.
- **Vigilant.** Always watching. Live readouts that tick, a steady 5-second pulse, tick-marked instrument scales, one signal colour that means "Lifeline is acting".
- **Candid.** Shows its working. Real numbers, real transaction hashes, the simulation labelled as one, refusals shown as proudly as rescues. Data before decoration.

It must NEVER feel:

- **Casino.** No neon, confetti, rockets, "to the moon", glowing coins, slot-machine counters.
- **Corporate bank.** No stock photos, padlock icons, blue-to-purple gradients, "enterprise-grade security" language.
- **Frantic.** No flashing red, shaking, sirens, countdown panic. Danger is shown clearly and quietly.

## Audience taste

- Hyperliquid traders use dark trading terminals, Telegram bots and on-chain explorers. Trust for them is tabular numbers that update, explorer links, and open source. They distrust marketing copy and anything that hides fees.
- Judges skim. They want to see the thing work in the first screen and then find proof (transactions, tests, attestation) one click away.
- Global crypto audience, English. Orange reads as rescue and safety everywhere, not as danger; red stays reserved for liquidation.

## Brand anchors

| Anchor | Now | Verdict |
| --- | --- | --- |
| Lifebuoy mark (paper ring, four orange quarters) | `Shell.tsx` | Keep. It is the most ownable thing we have. |
| Signal orange `#ff7a3d` | Main buttons, rescue zone | Keep, and use it even more strictly: only where Lifeline acts. |
| Night-water ink navy | Backgrounds | Evolve toward real sea depth: a darker, greener abyss with a visible surface. |
| Paper text `#f5f1e8` | Headlines | Keep. |
| Health colours (sea green, amber, red) and simulation violet | Gauge, badges | Keep: they carry meaning the tool pages rely on. |
| Fraunces display serif | Headlines | Replace on the landing page with a condensed, stencil-like or grotesque display that feels painted on a hull. Assumption. |
| IBM Plex Sans / Mono | Body and numbers | Keep Mono for numbers. Body can stay or move to a sharper grotesque. |
| Copy voice: plain, factual, from the user's side | Everywhere | Keep. |

## Feel in motion

- Heavy and precise. Water and levels move slowly: 900–1600 ms, a long ease-in-out with no overshoot.
- The rescue is the one fast thing: a throw line snaps out in about 220 ms with a sharp ease-out, pulls taut, and the water drops back over about 1.2 s.
- Readouts tick like instruments: digits roll or step, never fade.
- Base rhythm: the keeper's 5-second poll, shown as a quiet sonar-style ping.
- Entrances are restrained: content is readable at once, motion adds to it after.

## Material and texture

Deep water at night seen from the surface; painted hull steel with stencilled markings; enamel safety signage; wet rope; instrument glass with fine tick marks; monospaced readouts. Fine grain is welcome; glossy glass is not.

## Taste anchors

- The load line (Plimsoll mark) stencilled on a ship's hull: an authoritative scale that says how deep is safe. It is our warn, trigger and liquidation levels.
- Coast-guard and lifeboat livery: high-vis orange against white and dark blue, with a bold diagonal stripe. Confident, unmistakable, never decorative.
- Marine depth sounders and tide-gauge charts: one moving line against a fixed scale, read at a glance.
- Engineering manuals with precise callouts and labelled diagrams: every element named, nothing vague.
- Trading terminals: tabular figures, dense when it helps, no ornament on numbers.

## Lines not to cross

- No fake data: every moving number or line on the landing page comes from the live sim keeper or is clearly a diagram.
- The simulation is always labelled.
- No red flashing or alarm motion, even at liquidation.
- No 3D coins, token logos as decoration, or chain-logo walls.
- No custom cursor or smooth-scroll hijacking on the tool pages.
- Motion never delays reading a number or pressing a button.
- No copy that promises liquidation can't happen.
