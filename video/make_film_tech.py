#!/usr/bin/env python3
"""Writes film-tech/film.json, the technical walkthrough, from narration_tech.json and its timeline.

  python make_film_tech.py
Run order: make_film_tech.py -> tools/vo_timeline.py narration_tech.json narration_tech/takes --film film-tech/film.json --write --out narration_tech -> make_film_tech.py

Code and numbers come from the repo: the vault's rescue checks from contracts/vault/src/lib.rs, the policy engine's
reason codes from packages/shared, the backtest from research/backtest/RESULTS.md, the test counts from README.md,
the testnet delivery time from research/tidepool/RESULTS.md, the attacks from apps/keeper/src/attack-lab.ts.
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
FILM = os.path.join(HERE, "film-tech/film.json")
TL_PATH = os.path.join(HERE, "narration_tech/timeline.json")
TL = json.load(open(TL_PATH)) if os.path.exists(TL_PATH) else None
old = {s["id"]: s for s in json.load(open(FILM))["scenes"]} if os.path.exists(FILM) else {}
dur = {s["id"]: s["duration"] for s in TL["scenes"]} if TL else {}

lib = open(os.path.join(REPO, "contracts/vault/src/lib.rs")).read().splitlines()
start = next(i for i, l in enumerate(lib) if "require!(amount.0 <= policy.max_per_rescue" in l)
stop = next(i for i in range(start, len(lib)) if "quote::check(&quote, &expected)" in lib[i]) + 3
VAULT_CODE = "\n".join(l[8:] for l in lib[start:stop])
sig = next(i for i, l in enumerate(VAULT_CODE.splitlines()) if "quote::is_signed" in l) + 1
consts = open(os.path.join(REPO, "packages/shared/src/constants.ts")).read()
CODES = re.findall(r'"([A-Z_]+)"', consts[consts.index("export const REASON_CODES"):consts.index("] as const", consts.index("export const REASON_CODES"))])
bt = open(os.path.join(REPO, "research/backtest/RESULTS.md")).read()
m = re.search(r"\| All \| ([\d.]+)% \| ([\d.]+)% \|", bt)
NO_PROT, WITH = float(m.group(1)), float(m.group(2))
POS = re.search(r"On ([\d,]+) random BTC, ETH and SOL positions", bt).group(1)
FLASH = float(re.search(r"those become [\d.]+%, ([\d.]+)%", bt).group(1))
readme = open(os.path.join(REPO, "README.md")).read()
TS = re.search(r"\| ([\d,]+) TypeScript, (\d+) vault unit, (\d+) vault sandbox", readme)
tp = open(os.path.join(REPO, "research/tidepool/RESULTS.md")).read()
DELIVERY = re.search(r"Deposit to balance on Hyperliquid: ([\d.]+) s", tp).group(1)
lab = open(os.path.join(REPO, "apps/keeper/src/attack-lab.ts")).read()
TITLES = re.findall(r'title: "([^"]+)",\s*move:', lab)
ev = json.load(open(os.path.join(HERE, "film/public/captures/T1.events.json")))["events"]
CLICKS = [e["t"] for e in ev if e["type"] == "click"]
assert len(CLICKS) == 7 and len(TITLES) == 7

LIVE = "live site · lifeline.prashantthakur.dev"
wall_d = dur.get("t_wall", 9)
step = round(wall_d / 7, 3)
scenes = [
    {"id": "t_intro", "type": "screen", "src": "captures/L1.mp4", "trimBefore": 0.4, "full": True, "ground": "paper",
     "zooms": [{"at": 1.0, "dur": 30, "box": {"x": 140, "y": 420, "w": 1180, "h": 664}}], "label": {"text": f"{LIVE} · technical walkthrough"}},
    {"id": "t_health", "type": "kinetic", "kicker": "cross margin · from Hyperliquid's clearinghouseState", "lines": ["health =", "account value ÷ maintenance margin"], "emphasis": ["health"]},
    {"id": "t_watch", "type": "screen", "src": "captures/P1.mp4", "trimBefore": 1.5, "full": True, "ground": "paper",
     "zooms": [{"at": 0.4, "dur": 30, "box": {"x": 250, "y": 520, "w": 900, "h": 506}}], "label": {"text": f"{LIVE}/position · demo account, live keeper"}},
    {"id": "t_size", "type": "kinetic", "kicker": "rescue size", "lines": ["target × margin − value", "+ 1Click's flat fee", "capped by your limits and reserve"], "emphasis": ["target"]},
    {"id": "t_quote", "type": "kinetic", "kicker": "USDC on NEAR → Hyperliquid perps · NEAR Intents", "lines": ["1Click quote", "signature checked first"], "emphasis": ["signature"]},
    {"id": "t_policy", "type": "code", "title": "The policy engine's refusal codes", "file": "packages/shared/src/constants.ts",
     "code": "export const REASON_CODES = [\n" + "\n".join(f'  "{c}",' for c in CODES) + "\n];"},
    {"id": "t_vault", "type": "code", "title": "The vault checks it again, on chain", "file": "contracts/vault/src/lib.rs · rescue()", "code": VAULT_CODE, "highlight": [[sig, sig]]},
    {"id": "t_key", "type": "screen", "src": "captures/T2.mp4", "trimBefore": 6.0, "full": True, "ground": "paper",
     "zooms": [{"at": 0.3, "dur": 30, "box": {"x": 200, "y": 560, "w": 900, "h": 506}}], "label": {"text": f"{LIVE}/verify · the keeper's keys, read from NEAR testnet"}},
    {"id": "t_lab", "type": "screen", "src": "captures/T1.mp4", "trimBefore": round(CLICKS[0] - 2.0, 2), "full": True, "ground": "paper",
     "zooms": [{"at": 1.6, "dur": 30, "box": {"x": 200, "y": 300, "w": 1100, "h": 620}}], "label": {"text": f"{LIVE}/attack · real transactions on NEAR testnet"}},
    {"id": "t_wall", "type": "montage", "items": [{"src": "captures/T1.mp4", "from": round(c + 3.2, 2), "line": t, "at": round(i * step, 3)} for i, (c, t) in enumerate(zip(CLICKS, TITLES))],
     "label": {"text": "all seven, refused on chain · one live take"}},
    {"id": "t_verify", "type": "screen", "src": "captures/T2.mp4", "trimBefore": 9.0, "full": True, "ground": "paper",
     "zooms": [{"at": 0.3, "dur": 30, "box": {"x": 200, "y": 300, "w": 1400, "h": 788}}], "label": {"text": f"{LIVE}/verify · checked in your browser"}},
    {"id": "t_repro", "type": "screen", "src": "captures/V1.mp4", "trimBefore": 12.2, "full": True, "ground": "paper",
     "zooms": [{"at": 0.2, "dur": 30, "box": {"x": 660, "y": 60, "w": 1060, "h": 596}}], "label": {"text": "cargo near build reproducible-wasm · commit 37e98488"}},
    {"id": "t_ai", "type": "screen", "src": "captures/T2.mp4", "trimBefore": 17.6, "full": True, "ground": "paper",
     "zooms": [{"at": 0.3, "dur": 30, "box": {"x": 260, "y": 150, "w": 1160, "h": 652}}], "label": {"text": f"{LIVE}/verify · NEAR AI Cloud, checked in your browser"}},
    {"id": "t_money", "type": "kinetic", "kicker": "NEAR testnet → Hyperliquid testnet · 13 Nov 2026", "lines": [f"{DELIVERY} seconds", "signed quote → deposit → margin"], "emphasis": [DELIVERY]},
    {"id": "t_arch", "type": "arch3d", "title": "Under the hood", "min": 9,
     "layers": [{"id": "hl", "label": "Hyperliquid", "sub": "health every 5 s"}, {"id": "policy", "label": "Policy engine", "sub": f"{len(CODES)}+ refusal codes, no network"},
                {"id": "vault", "label": "Vault on NEAR", "sub": "Rust · checks 1Click's signature"}, {"id": "intents", "label": "NEAR Intents", "sub": "1Click moves the USDC"}],
     "satellites": [{"id": "ai", "label": "NEAR AI Cloud"}], "traces": [{"from": "policy", "to": "ai", "at": 6.0}]},
    {"id": "t_proof", "type": "proof", "title": "Liquidated within 7 days", "metric": "share of positions liquidated", "unit": "%", "better": "lower",
     "rows": [{"label": "No protection", "value": NO_PROT}, {"label": "With Lifeline", "value": WITH, "ours": True}],
     "footnote": f"{POS} positions · real Hyperliquid 4h candles, Jul 2024 – Nov 2026 · research/backtest", "min": 7},
    {"id": "t_stress", "type": "proof", "title": "One-minute crash test", "metric": "every adverse move within one minute", "unit": "%", "better": "lower",
     "rows": [{"label": "No protection", "value": NO_PROT}, {"label": "With Lifeline", "value": FLASH, "ours": True}],
     "footnote": "same positions · each 4h candle's move squeezed into one minute · research/backtest", "min": 6},
    {"id": "t_tests", "type": "kinetic", "kicker": "pnpm test · CI on every pull request", "lines": [f"{TS.group(1)} TypeScript tests", f"{int(TS.group(2)) + int(TS.group(3))} contract tests"], "emphasis": [TS.group(1)]},
    {"id": "t_close", "type": "sea", "mode": "calm", "sky": "night", "from": 2.01, "to": 2.01, "clock": "3:12", "waterIn": True, "min": 6},
    {"id": "end", "type": "endcard", "name": "Lifeline", "tagline": "Topped up before liquidation. Funded from any chain, on NEAR.",
     "links": ["lifeline.prashantthakur.dev", "/attack", "/verify"], "duration": 4.5},
]
for s in scenes:
    s.setdefault("duration", old.get(s["id"], {}).get("duration", 6.0))
    if s["type"] == "sea":
        s.setdefault("drift", False)
film = {"title": "Lifeline: technical walkthrough", "fps": 30, "width": 1920, "height": 1080,
        "theme": {"bg": "#0a1230", "surface": "#142257", "fg": "#fff7ea", "muted": "#b7c2e6", "accent": "#ff5a1f", "accent2": "#ffc93c", "good": "#19c79a", "bad": "#e5243b"},
        "scenes": scenes}
if os.path.exists(os.path.join(HERE, "film-tech/public/captions-tech/captions.json")):
    film["captions"] = "captions-tech/captions.json"
if os.path.exists(FILM):
    os.remove(FILM)  # film-tech is hard-linked from film: never write through a shared file
json.dump(film, open(FILM, "w"), indent=1, ensure_ascii=False)
print(len(scenes), "scenes,", round(sum(s["duration"] for s in scenes), 1), "s")
