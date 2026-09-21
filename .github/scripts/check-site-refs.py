#!/usr/bin/env python3
"""Verify every local href/src in the landing page resolves to a real file.

A Pages deploy that 404s its own stylesheet is worse than a failed deploy:
it publishes, looks broken, and nothing in the build log says so. This is the
cheapest place to catch a renamed or missing asset, and it runs identically
in CI and on a laptop.
"""

import os
import re
import sys

SITE = os.path.join(os.path.dirname(__file__), "..", "..", "site")
SITE = os.path.normpath(SITE)

EXTERNAL = ("http://", "https://", "#", "mailto:", "data:", "//")


def main() -> int:
    index = os.path.join(SITE, "index.html")
    with open(index, encoding="utf-8") as fh:
        html = fh.read()

    refs = re.findall(r'(?:href|src)="([^"]+)"', html)
    local = [r for r in refs if not r.startswith(EXTERNAL)]

    missing = [r for r in local if not os.path.isfile(os.path.join(SITE, r.lstrip("/")))]

    for r in local:
        mark = "MISSING" if r in missing else "ok"
        print(f"  {mark:>7}  {r}")

    print(f"{len(refs)} references, {len(local)} local, {len(missing)} missing")

    if missing:
        print("FAIL: unresolved local asset references", file=sys.stderr)
        return 1
    print("PASS: all local asset references resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
