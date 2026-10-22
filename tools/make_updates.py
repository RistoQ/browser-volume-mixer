#!/usr/bin/env python
"""Record a released version in the Firefox update manifest (updates.json).

A self-distributed add-on gets no updates from addons.mozilla.org: Firefox polls
the URL in `browser_specific_settings.gecko.update_url` instead, which has to
serve this file over HTTPS. Every release therefore appends its version here, and
the file's location is permanent - an installed add-on keeps using the
`update_url` baked into the version it installed, so it can never be moved later
without an enterprise policy override. See README, "Automatic updates".

Usage:
    python tools/make_updates.py                        # version from manifest.json
    python tools/make_updates.py --tag v1.0.1 \
        --xpi web-ext-artifacts/volume-mixer.xpi        # + sha256 of the signed file
    python tools/make_updates.py --min-version 145.0    # offer it only to newer Firefox

The update link defaults to

    https://github.com/<repo>/releases/download/<tag>/volume-mixer.xpi

with <repo> taken from the origin remote, which is exactly what the release
workflow publishes (.github/workflows/release.yml).

Exit code 0 = updates.json was written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ASSET = "volume-mixer.xpi"


def fail(message: str) -> None:
    sys.exit(f"make_updates.py: {message}")


def origin_repo() -> str:
    """OWNER/REPO from the origin remote, so nothing has to be hardcoded here."""
    try:
        url = subprocess.run(
            ["git", "-C", str(ROOT), "remote", "get-url", "origin"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        fail(f"cannot read the origin remote, pass --repo OWNER/REPO ({exc})")
    match = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$", url)
    if not match:
        fail(f"origin is not a GitHub URL that can be parsed: {url!r} - pass --repo OWNER/REPO")
    return f"{match.group(1)}/{match.group(2)}"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version_key(version: str) -> list[tuple[int, int, str]]:
    """Approximate Firefox's version ordering, only so the file stays sorted.

    Numbers compare as numbers, everything else as text, and every element is a
    tuple so no two entries can ever be compared across types.
    """
    parts = re.split(r"([0-9]+)", version)
    return [
        (0, int(part), "") if part.isdigit() else (1, 0, part) for part in parts
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--update-file",
        default=str(ROOT / "updates.json"),
        help="update manifest to edit (default: updates.json next to the manifest)",
    )
    parser.add_argument("--version", help="version to add (default: manifest.json version)")
    parser.add_argument("--tag", help="release tag holding the .xpi (default: v<version>)")
    parser.add_argument("--repo", help="OWNER/REPO hosting the release (default: origin remote)")
    parser.add_argument("--asset", default=DEFAULT_ASSET, help=f"release asset name (default: {DEFAULT_ASSET})")
    parser.add_argument("--xpi", help="signed .xpi to hash into update_hash")
    parser.add_argument(
        "--min-version",
        help="only offer this version to Firefox >= this (writes applications.gecko.strict_min_version)",
    )
    args = parser.parse_args()

    manifest_path = ROOT / "manifest.json"
    if not manifest_path.is_file():
        fail(f"{manifest_path} is missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
    addon_id = gecko.get("id")
    if not addon_id:
        fail("manifest.json has no browser_specific_settings.gecko.id to key the update on")

    version = args.version or manifest.get("version")
    if not version:
        fail("no version given and manifest.json has none")
    tag = args.tag or f"v{version}"
    repo = args.repo or origin_repo()

    entry: dict[str, object] = {
        "version": version,
        "update_link": f"https://github.com/{repo}/releases/download/{tag}/{args.asset}",
    }
    if args.xpi:
        xpi = Path(args.xpi)
        if not xpi.is_file():
            fail(f"{xpi} does not exist - sign the extension first, or drop --xpi")
        entry["update_hash"] = f"sha256:{sha256(xpi)}"
    if args.min_version:
        entry["applications"] = {"gecko": {"strict_min_version": args.min_version}}

    path = Path(args.update_file)
    if path.is_file():
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            fail(f"{path} is not valid JSON: {exc}")
    else:
        document = {"addons": {}}

    addons = document.setdefault("addons", {})
    updates = addons.setdefault(addon_id, {}).setdefault("updates", [])

    replaced = [u for u in updates if u.get("version") == version]
    updates[:] = [u for u in updates if u.get("version") != version]
    updates.append(entry)
    updates.sort(key=lambda u: version_key(str(u.get("version", "0"))))

    path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    verb = "replaced" if replaced else "added"
    print(f"{path}: {verb} {version} for {addon_id} ({len(updates)} version(s) recorded)")
    print(f"  {entry['update_link']}")
    if "update_hash" in entry:
        print(f"  {entry['update_hash']}")


if __name__ == "__main__":
    main()
