#!/usr/bin/env python3
"""Build the compact GEOGLAM crop-calendar table that ships with the backend.

Source: GEOGLAM Crop Monitor Sub-National Crop Calendars, Crop Monitor for
Early Warning, v1.3 (Becker-Reshef et al., Zenodo, doi:10.5281/zenodo.15850408),
licensed CC BY 4.0. The archive is a 554 MB zipped shapefile; this script
streams it once over HTTP range reads, never stores the 845 MB .shp, and
keeps only:

* per (country, region): a simplified outline (Douglas-Peucker, 0.02 degrees,
  coordinates rounded to 3 decimals) and its bounding box, for
  point-in-region lookup;
* per (country, region, crop): the day-of-year starts of the five GEOGLAM
  stages (planting, vegetative, harvest, end of season, out of season).

Rows with no calendar (all stages 0, the "minimal production" rows) are
dropped. Output: api/py/data/geoglam_cm4ew_v1_3.json.gz

    python3 -I scripts/build_geoglam_calendars.py            # writes the file
    python3 -I scripts/build_geoglam_calendars.py --check    # rebuild, compare only
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import struct
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

URL = "https://zenodo.org/records/15850408/files/GEOGLAM_CM4EW_Calendars_V1.3.zip?download=1"
MD5 = "6aa1bd4312091169c5116bc73305bd23"  # published on the Zenodo record
STEM = "GEOGLAM_CM4EW_Calendars_V1.3/GEOGLAM_CM4EW_Calendars_V1.3"
OUT = Path(__file__).resolve().parent.parent / "api" / "py" / "data" / "geoglam_cm4ew_v1_3.json.gz"
TOLERANCE_DEG = 0.02
MIN_RING_AREA = 0.0004  # square degrees (~5 km x 5 km at the equator); smaller islands are dropped


class _HttpFile(io.RawIOBase):
    """Seekable read-only view of a remote file through HTTP range requests."""

    def __init__(self, url: str):
        self.url, self.pos = url, 0
        head = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60)
        self.size = int(head.headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def readinto(self, buf):
        if self.pos >= self.size:
            return 0
        end = min(self.size, self.pos + len(buf)) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        for attempt in range(6):
            try:
                data = urllib.request.urlopen(req, timeout=300).read()
                break
            except OSError:
                if attempt == 5:
                    raise
                time.sleep(2 ** attempt)
        buf[: len(data)] = data
        self.pos += len(data)
        return len(data)


def _dbf_rows(raw: bytes) -> list[dict]:
    n = struct.unpack("<I", raw[4:8])[0]
    header_len, rec_len = struct.unpack("<HH", raw[8:12])
    fields, off = [], 32
    while raw[off] != 0x0D:
        d = raw[off: off + 32]
        fields.append((d[:11].split(b"\0")[0].decode(), d[16]))
        off += 32
    rows = []
    for i in range(n):
        rec = raw[header_len + i * rec_len: header_len + (i + 1) * rec_len]
        pos, row = 1, {}
        for name, length in fields:
            row[name] = rec[pos: pos + length].decode("utf-8", "replace").strip()
            pos += length
        rows.append(row)
    return rows


def _iter_shp(stream):
    """Yield the parts (rings) of each polygon record, in file order."""
    stream.read(100)  # file header
    while True:
        head = stream.read(8)
        if len(head) < 8:
            return
        _, words = struct.unpack(">ii", head)
        body = stream.read(words * 2)
        shape_type = struct.unpack("<i", body[:4])[0]
        if shape_type == 0:
            yield []
            continue
        num_parts, num_points = struct.unpack("<ii", body[36:44])
        parts = list(struct.unpack(f"<{num_parts}i", body[44: 44 + 4 * num_parts]))
        pts_off = 44 + 4 * num_parts
        flat = struct.unpack(f"<{2 * num_points}d", body[pts_off: pts_off + 16 * num_points])
        points = list(zip(flat[0::2], flat[1::2]))
        parts.append(num_points)
        yield [points[parts[k]: parts[k + 1]] for k in range(num_parts)]


def _dp(points, tol):
    """Douglas-Peucker, iterative."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm if norm else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol and idx > 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def _area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def build() -> dict:
    zf = zipfile.ZipFile(io.BufferedReader(_HttpFile(URL), buffer_size=32 << 20))
    rows = _dbf_rows(zf.read(f"{STEM}.dbf"))
    regions: dict[str, dict] = {}
    calendars: list[dict] = []
    with zf.open(f"{STEM}.shp") as shp:
        for row, rings in zip(rows, _iter_shp(shp)):
            stages = [int(row[k] or 0) for k in ("planting", "vegetative", "harvest", "endofseaso", "outofseaso")]
            key = f"{row['country']}|{row['region']}"
            if key not in regions and rings:
                simple = []
                for ring in rings:
                    if _area(ring) < MIN_RING_AREA:
                        continue
                    s = [(round(x, 3), round(y, 3)) for x, y in _dp(ring, TOLERANCE_DEG)]
                    if len(s) >= 4:
                        simple.append(s)
                if simple:
                    xs = [x for r in simple for x, _ in r]
                    ys = [y for r in simple for _, y in r]
                    regions[key] = {
                        "country": row["country"],
                        "region": row["region"],
                        "bbox": [min(xs), min(ys), max(xs), max(ys)],
                        "rings": simple,
                    }
            if not any(stages[:4]):
                continue  # minimal-production row: no calendar
            calendars.append({"key": key, "crop": row["crop"], "doy": stages})
    return {
        "source": "GEOGLAM Crop Monitor Sub-National Crop Calendars (CM4EW) v1.3",
        "doi": "10.5281/zenodo.15850408",
        "license": "CC-BY-4.0",
        "regions": list(regions.values()),
        "calendars": [c for c in calendars if c["key"] in regions],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="rebuild and compare with the committed file")
    args = ap.parse_args(argv)
    payload = json.dumps(build(), separators=(",", ":"), sort_keys=True).encode()
    if args.check:
        current = gzip.decompress(OUT.read_bytes()) if OUT.exists() else b""
        same = hashlib.sha256(current).digest() == hashlib.sha256(payload).digest()
        print("up to date" if same else "differs from the committed file")
        return 0 if same else 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(gzip.compress(payload, mtime=0))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
