#!/usr/bin/env python3
"""Lifeline's score, synthesised here in numpy: no samples, nothing licensed, nothing Content ID can match.

One theme at 96 bpm, A minor resolving to C major at the close. Its identity is the keeper's watch: a soft sonar
ping, the 5-second look at your account, sparse and lonely in the night, a steady pulse under the product.
  ping    sine ping with a long tail, on the keeper's rhythm
  pad     warm detuned pad on the chords (Am F C G), dark at night, open from the turn
  pluck   a short arpeggio on the chord tones under the product
  bass    soft sub on the roots; a kick-like thump on 1 and 3 from the turn
Arc from the real scene starts (film/film.json): pings + low pad under the cold open -> chords at the hook ->
pull back for the scale -> riser into the turn -> steady under the product -> near silence under "assume the bot
gets hacked" -> pulse back for the lab and the refusals -> light under the 3D -> riser into the proof -> C major
over the close and end card.

  python3 video/music.py [--out PATH]
"""
from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000
HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else HERE / "audio" / "music.wav"
BPM = 96
BEAT = 60 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(5)

film = json.load(open(HERE / (sys.argv[sys.argv.index("--film") + 1] if "--film" in sys.argv else "film/film.json")))
starts, t = {}, 0.0
for s in film["scenes"]:
    starts[s["id"]] = t
    t += s["duration"]
TOTAL = t + 1.5
N = int(TOTAL * SR)


def midi(n: float) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def env(n: int, a: float, r: float) -> np.ndarray:
    t = np.arange(n) / SR
    return np.minimum(1, t / max(a, 1e-3)) * np.exp(-t / r)


def ping(n_note: int, dur=2.4, vel=0.35):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = midi(n_note)
    y = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.08)
    return vel * y * env(n, 0.004, 0.55)


def pad(notes, dur, vel=0.12, bright=0.3):
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for m in notes:
        for d in (-0.07, 0.0, 0.08):
            f = midi(m + d)
            y += np.sin(2 * np.pi * f * t) + bright * 0.5 * np.sin(2 * np.pi * 2 * f * t + 0.3)
    a = np.minimum(1, t / 0.9) * np.minimum(1, (dur - t) / 0.9)
    return vel * y / (3 * len(notes)) * np.clip(a, 0, 1)


def pluck(m, dur=0.5, vel=0.18):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = midi(m)
    y = sum((1 / k) * np.sin(2 * np.pi * k * f * t) * np.exp(-t * (6 + 5 * k)) for k in range(1, 6))
    return vel * y * env(n, 0.003, 0.25)


def thump(vel=0.5):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 95 * np.exp(-t * 18) + 42
    return vel * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def sub(m, dur, vel=0.18):
    n = int(dur * SR)
    t = np.arange(n) / SR
    a = np.minimum(1, t / 0.05) * np.minimum(1, (dur - t) / 0.1)
    return vel * np.sin(2 * np.pi * midi(m) * t) * np.clip(a, 0, 1)


def riser(dur, vel=0.18):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    k = np.exp(np.linspace(-4, 0, n))
    # a rough band-limited swell: smoothed noise plus a rising tone
    sm = np.convolve(noise, np.ones(40) / 40, mode="same")
    tone = np.sin(2 * np.pi * np.cumsum(220 + 660 * (t / dur) ** 2) / SR)
    return vel * k * (0.6 * sm + 0.4 * tone)


mix = np.zeros(N)


def put(y, at):
    i = int(at * SR)
    if i >= N:
        return
    j = min(N, i + len(y))
    mix[i:j] += y[: j - i]


CH = {"Am": ([57, 60, 64], 45), "F": ([53, 57, 60], 41), "C": ([55, 60, 64], 48), "G": ([55, 59, 62], 43)}
PROG_MIN = ["Am", "F", "C", "G"]
PROG_MAJ = ["C", "G", "Am", "F"]


def section(a, b, *, chords=PROG_MIN, pad_vel=0.12, pings_every=None, ping_vel=0.3, plucks=False, drums=False, bass=False, ping_note=81):
    t, k = a, 0
    while t < b - 0.05:
        name = chords[k % len(chords)]
        notes, root = CH[name]
        d = min(BAR, b - t)
        if pad_vel:
            put(pad(notes + [notes[0] + 12], d + 0.6, pad_vel), t)
        if bass:
            put(sub(root - 12 + 12, d * 0.95, 0.16), t)
        for beat in range(4):
            bt = t + beat * BEAT
            if bt >= b:
                break
            if drums and beat in (0, 2):
                put(thump(0.42), bt)
            if plucks:
                for e, frac in enumerate((0, 0.5)):
                    m = notes[(beat * 2 + e) % 3] + 12
                    put(pluck(m, 0.45, 0.12), bt + frac * BEAT)
        t += BAR
        k += 1
    if pings_every:
        t = a + 0.2
        while t < b:
            put(ping(ping_note, vel=ping_vel), t)
            t += pings_every


S = starts
end = TOTAL
if "t_intro" in S:
    # the technical walkthrough: one steady arc, lighter, with the keeper's ping every 5 s
    order = [k for k in S]
    section(S["t_intro"], S["t_lab"], pad_vel=0.1, plucks=True, bass=True, pings_every=5.0, ping_vel=0.14)
    put(riser(1.8, 0.13), S["t_lab"] - 1.8)
    section(S["t_lab"], S["t_verify"], pad_vel=0.11, plucks=True, drums=True, bass=True)
    section(S["t_verify"], S["t_proof"], pad_vel=0.1, plucks=True, bass=True, pings_every=5.0, ping_vel=0.13)
    put(riser(2.2, 0.15), S["t_proof"] - 0.4)
    section(S["t_proof"], S["t_close"], pad_vel=0.12, plucks=True, drums=True, bass=True)
    section(S["t_close"], end, chords=PROG_MAJ, pad_vel=0.13, bass=True, pings_every=5.0, ping_vel=0.2, ping_note=84)
else:
    # cold open: the keeper's lonely watch at night, the pings quicken as the water rises
    section(S["cold"], S["scale"], chords=["Am", "Am"], pad_vel=0.07, pings_every=None)
    for k, tt in enumerate(np.cumsum([0.3, 1.6, 1.3, 1.05, 0.9])):
        put(ping(81, vel=0.22 + 0.02 * k), S["cold"] + tt)
    # the scale: low and dark, one hit on the number
    section(S["scale"], S["hook"], chords=["Am", "F"], pad_vel=0.09, pings_every=None, bass=True)
    put(thump(0.6), S["scale"] + 0.3)
    put(riser(1.8, 0.14), S["hook"] - 1.8)
    # hook: Lifeline, on NEAR: the chords arrive with the product
    section(S["hook"], S["fund"], pad_vel=0.12, plucks=True, bass=True, pings_every=BAR)
    # product: steady pulse, the keeper's ping every 5 s
    section(S["fund"], S["threat"], pad_vel=0.12, plucks=True, drums=True, bass=True, pings_every=5.0, ping_vel=0.18)
    # threat: near silence, one ping
    section(S["threat"], S["lab"], chords=["Am"], pad_vel=0.06)
    put(ping(76, vel=0.3), S["threat"] + 0.3)
    put(riser(1.8, 0.13), S["lab"] - 1.8)
    # the lab, the refusals, the wall: pulse back, driving
    section(S["lab"], S["verify"], pad_vel=0.11, plucks=True, drums=True, bass=True)
    section(S["verify"], S["proof"], pad_vel=0.1, plucks=True, bass=True, pings_every=5.0, ping_vel=0.15)
    put(riser(2.6, 0.17), S["proof"] - 0.4)
    section(S["proof"], S["close"], pad_vel=0.12, plucks=True, drums=True, bass=True)
    # close and end card: C major, open and calm
    section(S["close"], end, chords=PROG_MAJ, pad_vel=0.13, plucks=False, bass=True, pings_every=5.0, ping_vel=0.2, ping_note=84)


# gentle tape-ish saturation and a final normalisation (the mix sets the level)
mix = np.tanh(mix * 1.4) / 1.4
fade = np.ones(N)
fn = int(1.4 * SR)
fade[-fn:] = np.linspace(1, 0, fn)
mix *= fade
mix /= np.max(np.abs(mix)) + 1e-9
mix *= 0.7
stereo = np.stack([mix, np.roll(mix, int(0.011 * SR))], axis=1)
OUT.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(OUT), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((stereo * 32767).astype(np.int16).tobytes())
print(f"{OUT} {TOTAL:.1f}s")
