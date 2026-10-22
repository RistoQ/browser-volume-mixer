#!/usr/bin/env python
"""Sanity-check the extension.

Covers the manifest, the files it references, the PNG icons, JS syntax shape,
and that popup.js and popup.html agree about element ids and the 5 % step.

Usage:  python tools/validate.py [extension_root]
Exit code 0 = all checks passed.
"""
from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent

errors: list[str] = []
checks = 0


def check(ok: bool, msg: str) -> None:
    global checks
    checks += 1
    if not ok:
        errors.append(msg)


def png_size(path: Path) -> tuple[int, int]:
    """Return (width, height) from a PNG IHDR chunk, raising on a bad file."""
    with path.open("rb") as fh:
        head = fh.read(33)
    if len(head) < 33 or head[:8] != b"\x89PNG\r\n\x1a\n" or head[12:16] != b"IHDR":
        raise ValueError("not a PNG or missing IHDR")
    return struct.unpack(">II", head[16:24])


# --- manifest -----------------------------------------------------------------
manifest_path = ROOT / "manifest.json"
check(manifest_path.is_file(), f"missing {manifest_path}")
if manifest_path.is_file():
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"manifest.json is not valid JSON: {exc}")
        manifest = None
else:
    manifest = None

if manifest:
    check(
        manifest.get("manifest_version") in (2, 3),
        "manifest_version must be 2 or 3",
    )
    for key in ("name", "version", "description"):
        check(bool(manifest.get(key)), f"manifest is missing '{key}'")

    referenced: set[str] = set()
    referenced.update(manifest.get("icons", {}).values())
    referenced.update(manifest.get("browser_action", {}).get("default_icon", {}).values())
    referenced.update(manifest.get("action", {}).get("default_icon", {}).values())
    referenced.add(manifest.get("browser_action", {}).get("default_popup", ""))
    referenced.add(manifest.get("action", {}).get("default_popup", ""))
    referenced.update(manifest.get("background", {}).get("scripts", []))
    for cs in manifest.get("content_scripts", []):
        referenced.update(cs.get("js", []))
        referenced.update(cs.get("css", []))
    for name in sorted(filter(None, referenced)):
        check((ROOT / name).is_file(), f"manifest references a missing file: {name}")

    # Icons must be real PNGs whose size matches the manifest key.
    for size, name in sorted(manifest.get("icons", {}).items()):
        path = ROOT / name
        if not path.is_file():
            continue
        try:
            w, h = png_size(path)
        except ValueError as exc:
            errors.append(f"{name}: {exc}")
            continue
        check(
            (w, h) == (int(size), int(size)),
            f"{name}: manifest declares {size}px but the file is {w}x{h}",
        )

# --- everything else ----------------------------------------------------------
def strip_js_noise(text: str) -> str:
    """Remove comments and string/template literals so that bracket counting
    is not thrown off by prose like "(cross-origin)" inside a comment."""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            while i < n and text[i] != "\n":
                i += 1
        elif ch == "/" and nxt == "*":
            i += 2
            while i < n and not (text[i] == "*" and i + 1 < n and text[i + 1] == "/"):
                i += 1
            i += 2
        elif ch in ("'", '"', "`"):
            quote = ch
            i += 1
            while i < n:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    i += 1
                    break
                i += 1
        else:
            out.append(ch)
            i += 1
    return "".join(out)


for js in sorted(ROOT.glob("**/*.js")):
    if "node_modules" in js.parts:
        continue
    raw = js.read_text(encoding="utf-8", errors="replace")
    check(bool(raw.strip()), f"{js.relative_to(ROOT)} is empty")
    # Balanced braces/parens is a cheap proxy for "not obviously truncated".
    text = strip_js_noise(raw)
    for open_ch, close_ch in (("{", "}"), ("(", ")"), ("[", "]")):
        check(
            text.count(open_ch) == text.count(close_ch),
            f"{js.relative_to(ROOT)} has unbalanced {open_ch}{close_ch}",
        )

# --- popup: HTML and JS must agree -------------------------------------------
popup_html = ROOT / "popup" / "popup.html"
popup_js = ROOT / "popup" / "popup.js"
if popup_html.is_file() and popup_js.is_file():
    html = popup_html.read_text(encoding="utf-8")
    js = popup_js.read_text(encoding="utf-8")

    html_ids = set(re.findall(r'id="([^"]+)"', html))
    used_ids = set(re.findall(r"""getElementById\(['"]([^'"]+)['"]\)""", js))
    for used in sorted(used_ids):
        check(
            used in html_ids,
            f"popup.js reads #{used} but popup.html defines no such id",
        )
    for orphan in sorted(html_ids - used_ids):
        check(False, f"popup.html defines #{orphan} but popup.js never reads it")

    for asset in ("popup.css", "popup.js", "../shared.js"):
        check(asset in html, f"popup.html does not load {asset}")

    # 5 % stepping is a requirement, in the markup and in the script.
    check(
        "var STEP_PERCENT = 5;" in js,
        "popup.js no longer defines STEP_PERCENT = 5",
    )
    # popup.html holds the master slider; the per-tab rows are built in JS.
    for kind in ("range", "number"):
        steps = re.findall(r'type="%s"[^>]*step="(\d+)"' % kind, html)
        check(
            steps == ["5"],
            f'expected the master {kind} input to declare step="5", found {steps}',
        )
    check(
        js.count("String(STEP_PERCENT)") >= 2,
        "popup.js does not give the row slider/number input the STEP_PERCENT step",
    )
    check(
        js.count("STEP_PERCENT + '%'") >= 2,
        "popup.js does not build both -5%/+5% button labels from STEP_PERCENT",
    )

# --- message protocol: MSG.<KEY> used anywhere must exist in shared.js --------
shared_js = ROOT / "shared.js"
if shared_js.is_file():
    defined = set(
        re.findall(r"^\s*([A-Z_]+):\s*'", shared_js.read_text(encoding="utf-8"), re.M)
    )
    check(bool(defined), "shared.js defines no MSG keys")
    for js in sorted(ROOT.glob("**/*.js")):
        if "node_modules" in js.parts or js.name == "shared.js":
            continue
        text = js.read_text(encoding="utf-8", errors="replace")
        for used in sorted(set(re.findall(r"MSG\.([A-Z_]+)", text))):
            check(
                used in defined,
                f"{js.relative_to(ROOT)} uses MSG.{used}, which shared.js does not define",
            )

print(f"{checks} checks run in {ROOT}")
if errors:
    print(f"\n{len(errors)} problem(s):")
    for err in errors:
        print(f"  - {err}")
    sys.exit(1)
print("OK - no problems found")
