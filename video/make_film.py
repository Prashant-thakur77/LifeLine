#!/usr/bin/env python3
"""Writes film/film.json (the whole film as data) from the storyboard below.

  python make_film.py     # structure; scene durations come from narration/timeline.json once vo_timeline.py has run
Run order: make_film.py -> tools/vo_timeline.py narration.json narration/takes --film film/film.json --write -> make_film.py

Numbers are not typed here: the seven attacks and the vault's answers are read from apps/keeper/src/attack-lab.ts,
the backtest from research/backtest/RESULTS.md, the testnet delivery time from research/tidepool/RESULTS.md.
"""
import json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
# VARIANT=full builds the long cut (film-full/), with the extra beats below; the default is the 2:20 cut for X.
FULL = os.environ.get("VARIANT") == "full"
SUFFIX = "_full" if FULL else ""
TL_PATH = os.path.join(HERE, f"narration{SUFFIX}/timeline.json")
TL = json.load(open(TL_PATH)) if os.path.exists(TL_PATH) else None
NARR = {l["id"]: l for l in json.load(open(os.path.join(HERE, f"narration{SUFFIX}.json")))}
lines = {l["id"]: l for l in TL["lines"]} if TL else {}
scene_start = {s["id"]: s["start"] for s in TL["scenes"]} if TL else {}
FILM = os.path.join(HERE, "film-full/film.json" if FULL else "film/film.json")
old = {s["id"]: s for s in json.load(open(FILM))["scenes"]} if os.path.exists(FILM) else {}


def word_at(line_id, word, fallback):
    """Seconds from the start of the line's scene to `word` in the line (proportional within the take)."""
    if not TL or line_id not in lines:
        return fallback
    ln = lines[line_id]
    text = NARR[line_id]["caption"]
    i = text.lower().find(word.lower())
    if i < 0:
        return fallback
    frac = i / max(1, len(text))
    return round(ln["start"] + frac * (ln["end"] - ln["start"]) - scene_start[NARR[line_id]["scene"]], 2)


# ---- sourced data ----
lab = open(os.path.join(REPO, "apps/keeper/src/attack-lab.ts")).read()
ATTACKS = [{"title": t, "answer": a} for t, a in re.findall(r'title: "([^"]+)",\s*move: "[^"]*",\s*expect: "([^"]+)"', lab)]
assert len(ATTACKS) == 7, ATTACKS
bt = open(os.path.join(REPO, "research/backtest/RESULTS.md")).read()
m = re.search(r"\| All \| ([\d.]+)% \| ([\d.]+)% \|", bt)
NO_PROT, WITH = float(m.group(1)), float(m.group(2))
POS = re.search(r"On ([\d,]+) random BTC, ETH and SOL positions", bt).group(1)
tp = open(os.path.join(REPO, "research/tidepool/RESULTS.md")).read()
DELIVERY = re.search(r"Deposit to balance on Hyperliquid: ([\d.]+) s", tp).group(1)

LIVE = "live site · lifeline.prashantthakur.dev"
scenes = [
    {"id": "cold", "type": "sea", "mode": "fall", "sky": "night", "from": 1.62, "to": 1.07, "clock": "3:07", "clockTo": "3:09",
     "label": {"text": "illustration · the night the price falls"}, "min": 5},
    {"id": "scale", "type": "kinetic", "kicker": "Hyperliquid perps traders · October 2025 · source: The Block", "lines": ["$7.4 billion", "of Hyperliquid positions,", "wiped out in one cascade."],
     "emphasis": ["$7.4"], "waterOut": True, "min": 5},
    {"id": "hook", "type": "screen", "src": "captures/L1.mp4", "trimBefore": 0.4, "zooms": [{"at": 1.2, "dur": 30, "box": {"x": 140, "y": 420, "w": 1180, "h": 664}}], "full": True, "ground": "paper", "waterIn": True,
     "label": {"text": "live site · vault on NEAR, funded from any chain via NEAR Intents · replay of a simulated rescue"}},
    {"id": "fund", "type": "screen", "src": "captures/F1.mp4", "trimBefore": 0.5, "zooms": [{"at": 1.0, "dur": 30, "box": {"x": 240, "y": 240, "w": 1200, "h": 675}}], "full": True, "ground": "paper",
     "label": {"text": f"{LIVE}/fund · NEAR Intents (1Click)"}},
    {"id": "rules", "type": "screen", "src": "captures/S1.mp4", "trimBefore": 1.2, "zooms": [{"at": 0.6, "dur": 30, "box": {"x": 330, "y": 470, "w": 1100, "h": 619}}], "full": True, "ground": "paper", "label": {"text": f"{LIVE}/start · your policy"}},
    {"id": "health", "type": "screen", "src": "captures/P1.mp4", "trimBefore": 1.5, "zooms": [{"at": 0.4, "dur": 30, "box": {"x": 250, "y": 520, "w": 900, "h": 506}}], "full": True, "ground": "paper",
     "label": {"text": f"{LIVE}/position · demo account, live keeper"}},
    {"id": "rescue", "type": "sea", "mode": "rescue", "sky": "day", "from": 1.44, "to": 2.01, "throwAt": word_at("n08", "vault", 3.0),
     "amount": "+3.47 USDC", "tag": "Reserve · vault on NEAR", "label": {"text": "the demo keeper's rescue · simulated position, real 1Click quote"}},
    {"id": "speed", "type": "kinetic", "kicker": "NEAR testnet → Hyperliquid testnet · 13 Nov 2026", "lines": [f"{DELIVERY} seconds", "deposit to margin."],
     "emphasis": [DELIVERY]},
    {"id": "wake", "type": "screen", "src": "captures/G1.mp4", "trimBefore": 4.0, "zooms": [{"at": 0.3, "dur": 30, "box": {"x": 260, "y": 420, "w": 1100, "h": 619}}], "full": True, "ground": "paper", "label": {"text": f"{LIVE}/ledger · public audit log"}},
    {"id": "threat", "type": "kinetic", "lines": ["Assume the bot", "gets hacked."], "emphasis": ["hacked."], "waterOut": True},
    {"id": "lab", "type": "screen", "src": "captures/A1.mp4", "trimBefore": 3.2, "full": True, "ground": "paper", "waterIn": True,
     "zooms": [{"at": 2.6, "dur": 3.4, "box": {"x": 200, "y": 300, "w": 1100, "h": 620}}],
     "label": {"text": f"{LIVE}/attack · a real transaction on NEAR testnet"}},
    {"id": "refuse", "type": "screen", "src": "captures/A1.mp4", "trimBefore": 9.6, "full": True, "ground": "paper",
     "zooms": [{"at": 0.0, "dur": 6.5, "box": {"x": 250, "y": 340, "w": 880, "h": 495}}],
     "label": {"text": "the vault's answer, on chain · read back by the browser"}},
    {"id": "montage", "type": "trickwall", "items": ATTACKS, "start": 0.2, "each": 0.62, "drift": True},
    {"id": "verify", "type": "screen", "src": "captures/V1.mp4", "trimBefore": 12.5, "zooms": [{"at": 0.3, "dur": 30, "box": {"x": 250, "y": 380, "w": 1300, "h": 731}}], "full": True, "ground": "paper",
     "label": {"text": f"{LIVE}/verify · checked in the browser"}},
    {"id": "arch", "type": "arch3d", "title": "Under the hood", "min": 9,
     "layers": [
         {"id": "hl", "label": "Hyperliquid", "sub": "health every 5 s"},
         {"id": "policy", "label": "Policy engine", "sub": "16 rules, no network"},
         {"id": "vault", "label": "Vault on NEAR", "sub": "Rust · checks 1Click's signature"},
         {"id": "intents", "label": "NEAR Intents", "sub": "1Click moves the USDC"},
     ],
     "satellites": [{"id": "ai", "label": "NEAR AI Cloud"}],
     "cues": {"hl": 0.3, "policy": word_at("n16", "sixteen", 1.5), "vault": word_at("n16", "Rust", 3.0), "intents": word_at("n16", "Intents", 4.5)},
     "traces": [{"from": "policy", "to": "ai", "at": word_at("n16", "NEAR AI", 6.5)}]},
    {"id": "proof", "type": "proof", "ground": "night", "title": "Liquidated within 7 days", "metric": "share of positions liquidated", "unit": "%", "better": "lower",
     "rows": [{"label": "No protection", "value": NO_PROT}, {"label": "With Lifeline", "value": WITH, "ours": True}],
     "footnote": f"{POS} BTC, ETH and SOL positions · real Hyperliquid 4h candles, Jul 2024 – Nov 2026 · research/backtest", "min": 7},
    {"id": "close", "type": "sea", "mode": "calm", "sky": "night", "from": 2.01, "to": 2.01, "clock": "3:12", "waterIn": True, "min": 4.5},
    {"id": "end", "type": "endcard", "name": "Lifeline", "tagline": "Topped up before liquidation. Funded from any chain, on NEAR.",
     "links": ["lifeline.prashantthakur.dev", "/attack", "/verify"], "duration": 4.5},
]
if FULL:
    import datetime
    CAP = os.path.join(HERE, "film/public/captures")
    rc = json.load(open(os.path.join(HERE, "film/public/data/rescues.json")))
    rows = [{"at": datetime.datetime.fromtimestamp(int(r["at"]) / 1e9, datetime.timezone.utc).strftime("%d %b %Y %H:%M UTC"),
             "amount": f"{int(r['amount']) / 1e6:.2f} USDC", "quote": r["quote_id"], "deposit": r["deposit_address"]} for r in rc["rescues"]][::-1]
    t1 = [e["t"] for e in json.load(open(os.path.join(CAP, "T1.events.json")))["events"] if e["type"] == "click"]
    FLASH = float(re.search(r"those become [\d.]+%, ([\d.]+)%", bt).group(1))
    readme = open(os.path.join(REPO, "README.md")).read()
    TS = re.search(r"\| ([\d,]+) TypeScript, (\d+) vault unit, (\d+) vault sandbox", readme)
    connected = os.path.exists(os.path.join(CAP, "C1.mp4"))
    extra = {
        "rules": [{"id": "owner", "type": "screen", "src": "captures/C1.mp4" if connected else "captures/S1.mp4", "trimBefore": 1.0 if connected else 4.0, "full": True, "ground": "paper",
                   "zooms": [{"at": 0.3, "dur": 30, "box": {"x": 200, "y": 160, "w": 1400, "h": 788}}],
                   "label": {"text": "testnet dashboard · wallet connected · the policy, read from the vault" if connected else f"{LIVE}/start · your policy, signed by your wallet"}}],
        "wake": [{"id": "history", "type": "chainlist", "user": rc["user"], "vault": rc["vault"], "count": rc["count"], "rows": rows, "drift": False,
                  "label": {"text": "real rescues on NEAR testnet · read live from the vault"}}],
        "verify": [{"id": "aiproof", "type": "screen", "src": "captures/T2.mp4", "trimBefore": 17.6, "full": True, "ground": "paper",
                    "zooms": [{"at": 0.3, "dur": 30, "box": {"x": 260, "y": 150, "w": 1160, "h": 652}}], "label": {"text": f"{LIVE}/verify · NEAR AI Cloud, checked in your browser"}}],
        "proof": [{"id": "stress", "type": "proof", "ground": "night", "title": "One-minute crash test", "metric": "every adverse move within one minute", "unit": "%", "better": "lower",
                   "rows": [{"label": "No protection", "value": NO_PROT}, {"label": "With Lifeline", "value": FLASH, "ours": True}],
                   "footnote": "same positions · each 4h candle's move squeezed into one minute · research/backtest", "min": 6},
                  {"id": "tests", "type": "kinetic", "kicker": "pnpm test · CI on every pull request", "lines": [f"{TS.group(1)} TypeScript tests", f"{int(TS.group(2)) + int(TS.group(3))} contract tests"], "emphasis": [TS.group(1)]}],
    }
    before = {
        "arch": [{"id": "compare", "type": "board", "mode": "compare", "kicker": "WHY LIFELINE", "title": "Not another exchange switch",
                  "left": "EXCHANGE AUTO TOP-UP", "right": "LIFELINE",
                  "rows": [{"left": "Inside one exchange", "right": "Your own wallet, funded from any chain"},
                           {"left": "Isolated margin only", "right": "Protects your cross-margin account"},
                           {"left": "You trust the exchange", "right": "Even our keeper can't take the money"}],
                  "start": 1.4, "each": 2.6},
                 {"id": "near", "type": "board", "mode": "pillars", "kicker": "WHY NEAR", "title": "It only works on NEAR",
                  "cards": [{"name": "NEAR Intents", "does": "move the money from any chain in one step"},
                            {"name": "Function-call key", "does": "the keeper can call rescue, and nothing else"},
                            {"name": "On-chain checks", "does": "the vault verifies 1Click's signature itself"},
                            {"name": "NEAR AI", "does": "explains every rescue from verified hardware"}],
                  "start": 1.6, "each": 2.6}],
    }
    out = []
    for sc in scenes:
        out += before.get(sc["id"], [])
        out.append(sc)
        out += extra.get(sc["id"], [])
    scenes = out
    if os.path.exists(os.path.join(CAP, "C2.mp4")):
        for sc in scenes:
            if sc["id"] == "fund":
                sc.update({"src": "captures/C2.mp4", "trimBefore": 1.0, "label": {"text": "testnet dashboard · wallet connected · reserve read from the vault"}})

for s in scenes:
    s.setdefault("duration", old.get(s["id"], {}).get("duration", 5.0))
    if s["type"] == "sea":
        s.setdefault("drift", False)
    if s["type"] == "trickwall":
        s["each"] = round((s["duration"] - 1.6) / len(s["items"]), 3)

film = {
    "title": "Lifeline",
    "fps": 30, "width": 1920, "height": 1080,
    "theme": {"bg": "#0a1230", "surface": "#142257", "fg": "#fff7ea", "muted": "#b7c2e6", "accent": "#ff5a1f", "accent2": "#ffc93c",
              "good": "#19c79a", "bad": "#e5243b"},
    "captions": (f"captions{SUFFIX}/captions.json" if os.path.exists(os.path.join(HERE, ("film-full" if FULL else "film") + f"/public/captions{SUFFIX}/captions.json")) else None),
    "scenes": scenes,
}
if film["captions"] is None:
    del film["captions"]
if os.path.exists(FILM):
    os.remove(FILM)  # film-full is hard-linked from film: never write through a shared file
json.dump(film, open(FILM, "w"), indent=1, ensure_ascii=False)
print(len(scenes), "scenes,", round(sum(s["duration"] for s in scenes), 1), "s")
