#!/usr/bin/env python3
"""
Batch-generate all voice-over clips from tts-script.txt using the local
ComfyUI ChatterBox voice-cloning workflow
("chatter-box-voice-cloning-tts-cd398cebf8f2_slower speed").

Each '--- header ---' section in tts-script.txt becomes <header>.mp3,
written next to this file. Existing .mp3 files are skipped unless --force.

Usage:
  python generate_tts.py                  # all sections (skips existing)
  python generate_tts.py --force          # regenerate everything
  python generate_tts.py s1-orient.hs_01 quiz-1_01   # only named headers
"""
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "tts-script.txt"
COMFY = Path(r"C:\Users\jmarti77\AppData\Roaming\uv\tools\comfy-cli\Scripts\comfy.exe")
WORKFLOW = Path(
    "D:/Comfy-Desktop/ComfyUI-Installs/Comfy_v01/ComfyUI/user/default/workflows/"
    "chatter-box-voice-cloning-tts-cd398cebf8f2_slower speed.json"
)
COMFY_OUT = Path(r"D:\Comfy-Desktop\ComfyUI-Shared\output")
TEXT_SLOT, PREFIX_SLOT, KEEP_SLOT = "4.text", "5.filename_prefix", "4.keep_model_loaded"
HEAD_RE = re.compile(r"^\s*---\s*(\S+)\s*---\s*$")


def parse_sections():
    """Return (order, {header: text}) from the script's --- header --- blocks."""
    order, sections, header, buf = [], {}, None, []
    for line in SCRIPT.read_text(encoding="utf-8").splitlines():
        m = HEAD_RE.match(line)
        if m:
            if header is not None:
                sections[header] = "\n".join(buf).strip()
                order.append(header)
            header, buf = m.group(1), []
        elif header is not None:
            buf.append(line)
    if header is not None:
        sections[header] = "\n".join(buf).strip()
        order.append(header)
    return order, sections


def comfy(*args):
    r = subprocess.run([str(COMFY), *args], capture_output=True, text=True)
    try:
        env = json.loads(r.stdout or "{}")
    except json.JSONDecodeError:
        raise RuntimeError(f"comfy {args[0]} returned no JSON: {r.stdout[:200]} {r.stderr[:200]}")
    if r.returncode != 0 or not env.get("ok", True):
        err = (env.get("error") or {}).get("message") or r.stderr.strip() or r.stdout.strip()
        raise RuntimeError(f"comfy {' '.join(args[:2])} failed: {err}")
    return env["data"]


def gen(header, text):
    """Run the workflow once for one section; move result to <header>.mp3."""
    tmp = HERE / f".tts-wf-{header}.json"
    d = comfy(
        "workflow", "set-slot", str(WORKFLOW),
        f"{TEXT_SLOT}={json.dumps(text)}",
        f"{PREFIX_SLOT}=tts/{header}",
        f"{KEEP_SLOT}=true",
        "--stdout",
    )
    tmp.write_text(json.dumps(d["workflow_json"]), encoding="utf-8")
    try:
        d = comfy("run", "--workflow", str(tmp), "--no-notify")
        d = comfy("jobs", "wait", d["prompt_id"], "--timeout", "600")
        job = d["jobs"][0]
        if job["status"] != "completed" or not job.get("ok"):
            raise RuntimeError(f"job {job['status']} for {header}: {job}")
        url = job["outputs"][0]
        q = parse_qs(urlparse(url).query)
        src = COMFY_OUT / q["subfolder"][0] / q["filename"][0]
        if not src.exists():
            raise RuntimeError(f"output file missing: {src}")
        dst = HERE / f"{header}.mp3"
        shutil.move(str(src), str(dst))
        return dst
    finally:
        tmp.unlink(missing_ok=True)


def main():
    args = sys.argv[1:]
    force = "--force" in args
    wanted = [a for a in args if not a.startswith("--")]
    order, sections = parse_sections()
    if wanted:
        unknown = set(wanted) - set(order)
        if unknown:
            print(f"unknown headers: {sorted(unknown)}", file=sys.stderr)
            sys.exit(2)
    sel = [h for h in order if not wanted or h in wanted]
    todo = [h for h in sel if force or not (HERE / f"{h}.mp3").exists()]
    skipped = [h for h in sel if h not in todo]
    print(f"sections={len(order)} selected={len(sel)} todo={len(todo)} skipped(existing)={len(skipped)}")
    t0 = time.time()
    failures = []
    for i, h in enumerate(todo, 1):
        t1 = time.time()
        print(f"[{i}/{len(todo)}] {h} ...", flush=True)
        try:
            dst = gen(h, sections[h])
            print(f"    -> {dst.name} ({dst.stat().st_size / 1024:.0f} KB, {time.time() - t1:.0f}s)", flush=True)
        except Exception as e:
            print(f"    !! FAILED {h}: {e}", file=sys.stderr, flush=True)
            failures.append(h)
    print(f"done: ok={len(todo) - len(failures)} failed={len(failures)} total={time.time() - t0:.0f}s")
    if failures:
        print(f"failed: {failures}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
