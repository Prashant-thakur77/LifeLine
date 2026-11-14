#!/usr/bin/env python3
"""Speeds a rendered film up scene by scene, cutting nothing: each scene gets its own factor, picture and voice
together, so lip sync holds. Music is then rebuilt for the new scene lengths, and the mix runs as usual.

  python tools/speed_cut.py speed.json

speed.json: {"film": "film-full/film.json", "video": "film-full/out/film.mp4", "vo": "narration_full/vo_full.wav",
  "sfx": "audio/sfx_track_full.wav", "mix": "mix_full.json", "out": "final_full.mp4", "default": 1.2,
  "factors": {"me1": 1.08, ...}}
Writes <film>_fast.json (scaled durations, for music.py), the sped picture, voice and effects, mix_fast.json, and
runs music.py and mix.py.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*a):
    subprocess.run(a, check=True, cwd=HERE)


def tempo(k):
    """atempo chain for factor k (each stage must be within 0.5..2)."""
    parts = []
    while k > 2:
        parts.append("atempo=2"); k /= 2
    parts.append(f"atempo={k:.6f}")
    return ",".join(parts)


def segments(scenes, cfg):
    t, out = 0.0, []
    for s in scenes:
        k = cfg["factors"].get(s["id"], cfg["default"])
        out.append((t, t + s["duration"], k))
        t += s["duration"]
    return out


def speed_video(src, dst, segs):
    chains = [f"[0:v]trim=start={a:.4f}:end={b:.4f},setpts=(PTS-STARTPTS)/{k}[v{i}]" for i, (a, b, k) in enumerate(segs)]
    fc = ";".join(chains) + ";" + "".join(f"[v{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=1:a=0,fps=30[v]"
    run("ffmpeg", "-v", "error", "-y", "-i", src, "-filter_complex", fc, "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "16",
        "-preset", "medium", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", dst)


def speed_audio(src, dst, segs):
    chains = [f"[0:a]atrim=start={a:.4f}:end={b:.4f},asetpts=PTS-STARTPTS,{tempo(k)}[a{i}]" for i, (a, b, k) in enumerate(segs)]
    fc = ";".join(chains) + ";" + "".join(f"[a{i}]" for i in range(len(segs))) + f"concat=n={len(segs)}:v=0:a=1[a]"
    run("ffmpeg", "-v", "error", "-y", "-i", src, "-filter_complex", fc, "-map", "[a]", "-ar", "48000", dst)


def main():
    cfg = json.load(open(os.path.join(HERE, sys.argv[1])))
    film_path = os.path.join(HERE, cfg["film"])
    film = json.load(open(film_path))
    segs = segments(film["scenes"], cfg)
    fast = dict(film)
    fast["scenes"] = [dict(s, duration=round((b - a) / k, 4)) for s, (a, b, k) in zip(film["scenes"], segs)]
    total = sum(s["duration"] for s in fast["scenes"])
    fast_film = film_path.replace(".json", "_fast.json")
    json.dump(fast, open(fast_film, "w"), indent=1, ensure_ascii=False)
    base = lambda p: os.path.splitext(p)[0]
    vid, vo, sfx = base(cfg["video"]) + "_fast.mp4", base(cfg["vo"]) + "_fast.wav", base(cfg["sfx"]) + "_fast.wav"
    speed_video(cfg["video"], vid, segs)
    speed_audio(cfg["vo"], vo, segs)
    speed_audio(cfg["sfx"], sfx, segs)
    music = base(cfg["mix"]).replace("mix", "audio/music") + "_fast.wav"
    run("python3", "music.py", "--film", os.path.relpath(fast_film, HERE), "--out", music)
    mix = json.load(open(os.path.join(HERE, cfg["mix"])))
    mix.update(duration=round(total, 3), vo=vo)
    mix["music"][0].update(file=music, end=round(total, 3))
    mix["sfx"][0]["file"] = sfx
    mix_fast = base(cfg["mix"]) + "_fast.json"
    json.dump(mix, open(os.path.join(HERE, mix_fast), "w"), indent=1)
    run("python3", "tools/mix.py", mix_fast, "--mux", vid, cfg["out"])
    print(f"{total:.1f}s -> {cfg['out']}")


if __name__ == "__main__":
    main()
