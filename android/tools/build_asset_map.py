#!/usr/bin/env python3
"""Build the deterministic local-image -> GameKee source URL map (stdlib only)."""
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
BUILD = ROOT / "data" / "build"
OUTPUT = ROOT / "android" / "app" / "src" / "main" / "assets" / "asset-map.json"


def load_json(path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def main():
    expected = {
        path.relative_to(WEB).as_posix()
        for directory in ("avatars", "img", "portraits")
        for path in (WEB / directory).iterdir()
        if path.is_file()
    }
    mapped = {}

    for source, url_to_hash in (
        ("img", load_json(BUILD / "imgmap.json")),
        ("portraits", load_json(BUILD / "portraitmap.json")),
    ):
        extension = "png" if source == "img" else "jpg"
        for url, image_hash in url_to_hash.items():
            path = f"{source}/{image_hash}.{extension}"
            if path in expected:
                mapped[path] = url

    for student_file in (BUILD / "students").glob("*.json"):
        student = load_json(student_file)
        url = student.get("avatarRemote")
        path = f"avatars/{student_file.stem}.jpg"
        if url and path in expected:
            mapped[path] = url

    missing = sorted(expected - mapped.keys())
    extra = sorted(mapped.keys() - expected)
    if missing or extra or len(mapped) != len(expected):
        print(f"Asset map mismatch: files={len(expected)}, mapped={len(mapped)}", file=sys.stderr)
        for label, paths in (("missing", missing), ("extra", extra)):
            for path in paths[:50]:
                print(f"{label}: {path}", file=sys.stderr)
            if len(paths) > 50:
                print(f"{label}: ... and {len(paths) - 50} more", file=sys.stderr)
        return 1

    invalid = [path for path, url in mapped.items() if urlparse(url).scheme != "https" or not urlparse(url).netloc]
    if invalid:
        print("Invalid source URL for: " + ", ".join(invalid[:20]), file=sys.stderr)
        return 1

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(mapped, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    OUTPUT.write_text(payload, encoding="utf-8", newline="")
    print(f"entries: {len(mapped)}")
    print(f"bytes: {OUTPUT.stat().st_size}")
    print(f"output: {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
