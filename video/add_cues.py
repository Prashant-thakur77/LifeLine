#!/usr/bin/env python3
"""Adds this film's own effect cues to sfx_cues.json (run after tools/cues_from_film.py, which rewrites it):
the water wipes, each REFUSED stamp on the trick wall, the rescue throw and splash, the vault's refusal."""
import json, sys

FILM = sys.argv[1] if len(sys.argv) > 1 else "film/film.json"
CUES = sys.argv[2] if len(sys.argv) > 2 else "sfx_cues.json"
film = json.load(open(FILM))
c = json.load(open(CUES))
add, t = [], 0.0
for s in film["scenes"]:
    a = t
    if s.get("waterOut"):
        add.append({"t": round(a + s["duration"] - 0.3, 3), "sfx": "whoosh_heavy", "db": -14})
    if s.get("waterIn"):
        add.append({"t": round(a + 0.15, 3), "sfx": "whoosh", "db": -16})
    if s["type"] == "trickwall":
        for i in range(len(s["items"])):
            add.append({"t": round(a + s.get("start", 0.3) + i * s.get("each", 0.55) + 9 / 30, 3), "sfx": "hit", "db": -13})
    if s["type"] == "sea" and s["mode"] == "rescue":
        add += [{"t": round(a + s["throwAt"] + 0.2, 3), "sfx": "whoosh", "db": -12},
                {"t": round(a + s["throwAt"] + 0.45, 3), "sfx": "shimmer", "db": -14},
                {"t": round(a + s["throwAt"] + 0.75, 3), "sfx": "chime", "db": -14}]
    if s["id"] == "refuse":
        add.append({"t": round(a + 0.4, 3), "sfx": "hit", "db": -10})
    t += s["duration"]
c["cues"] = sorted(c["cues"] + add, key=lambda x: x["t"])
json.dump(c, open(CUES, "w"), indent=1)
print(len(c["cues"]), "cues")
