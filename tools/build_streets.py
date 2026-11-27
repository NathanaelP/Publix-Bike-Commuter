#!/usr/bin/env python3
"""Build data/streets.json: the named roads along the district's routes.

The app uses it to put street names on turns ("Turn left onto Blake
Boulevard") for every route it shows: the baked ones, the live re-routes
BRouter returns while riding (BRouter's output has no street names), and the
reversed route home used offline. Shipping it keeps names working with no
signal.

Only roads within about a kilometre of a baked route are kept, which covers
re-routes near the planned line while keeping the file small.

    python3 tools/build_streets.py            # uses cached tiles, fetches missing
    python3 tools/build_streets.py --offline  # cached tiles only

Run it after tools/build_routes.py, since it reads data/routes/.
"""
import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
OUT = ROOT / "data" / "streets.json"

TILE = 0.05           # degrees per Overpass request
CELL = 0.005          # corridor grid, ~500 m
CORRIDOR_CELLS = 2    # keep roads within this many cells of a route (~1 km)
Q = 1e5               # coordinate quantisation: 1e-5 deg, about 1 m

ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]


def fetch_tile(box):
    key = CACHE / ("streets_%.2f_%.2f_%.2f_%.2f.json" % box)
    if key.exists():
        return json.load(open(key))
    bb = "%f,%f,%f,%f" % box
    query = ("[out:json][timeout:60];"
             f'(way["highway"]["name"]({bb});way["highway"]["ref"]({bb}););'
             "out tags geom;")
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(4):
        for endpoint in ENDPOINTS:
            try:
                req = urllib.request.Request(
                    endpoint, data=body, headers={"User-Agent": "PublixBikeCommuter/1.0"})
                with urllib.request.urlopen(req, timeout=75) as fh:
                    raw = json.load(fh)
                ways = []
                for el in raw.get("elements", []):
                    t = el.get("tags", {})
                    if not el.get("geometry"):
                        continue
                    ways.append({
                        "name": t.get("name"), "ref": t.get("ref"),
                        "hw": t.get("highway"),
                        "geom": [(p["lon"], p["lat"]) for p in el["geometry"]],
                    })
                key.write_text(json.dumps(ways))
                return ways
            except Exception as exc:  # noqa: BLE001 - try the next mirror
                print(f"    {endpoint.split('/')[2]}: {exc}", file=sys.stderr)
                time.sleep(2)
        time.sleep(5 * (attempt + 1))
    return None


def route_cells():
    """Grid cells within CORRIDOR_CELLS of any baked route, plus the bbox."""
    cells = set()
    lats, lons = [], []
    for f in sorted((ROOT / "data" / "routes").glob("*.json")):
        doc = json.load(open(f))
        for route in doc.values():
            if not isinstance(route, dict):
                continue
            for seg in route.get("segments") or []:
                pts = seg["coords"]
                for i, (lon, lat) in enumerate(pts):
                    lats.append(lat)
                    lons.append(lon)
                    cells.add((math.floor(lon / CELL), math.floor(lat / CELL)))
                    if i:  # fill gaps on long straight segments
                        plon, plat = pts[i - 1]
                        n = int(max(abs(lon - plon), abs(lat - plat)) / CELL)
                        for k in range(1, n + 1):
                            t = k / (n + 1)
                            cells.add((math.floor((plon + t * (lon - plon)) / CELL),
                                       math.floor((plat + t * (lat - plat)) / CELL)))
    grown = set()
    r = CORRIDOR_CELLS
    for cx, cy in cells:
        for dx in range(-r, r + 1):
            for dy in range(-r, r + 1):
                grown.add((cx + dx, cy + dy))
    bbox = (min(lats) - 0.02, min(lons) - 0.02, max(lats) + 0.02, max(lons) + 0.02)
    return grown, bbox


def label(way):
    name, ref = way.get("name"), way.get("ref")
    if name and ref and ref not in name:
        return f"{name} ({ref.replace(';', ' / ')})"
    return name or (ref.replace(";", " / ") if ref else None)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--offline", action="store_true", help="use cached tiles only")
    args = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)

    cells, (s, w, n, e) = route_cells()
    tiles = []
    lat = math.floor(s / TILE) * TILE
    while lat < n:
        lon = math.floor(w / TILE) * TILE
        while lon < e:
            box = (round(lat, 2), round(lon, 2), round(lat + TILE, 2), round(lon + TILE, 2))
            # Skip tiles no route comes near.
            if any((cx, cy) in cells
                   for cx in range(math.floor(box[1] / CELL), math.floor(box[3] / CELL) + 1)
                   for cy in range(math.floor(box[0] / CELL), math.floor(box[2] / CELL) + 1)):
                tiles.append(box)
            lon += TILE
        lat += TILE
    print(f"{len(tiles)} tiles along the routes, {len(cells)} corridor cells")

    if not args.offline:
        # Fetch a few tiles at once; each is cached, so the loop below reads them.
        from concurrent.futures import ThreadPoolExecutor
        todo = [b for b in tiles
                if not (CACHE / ("streets_%.2f_%.2f_%.2f_%.2f.json" % b)).exists()]
        print(f"fetching {len(todo)} tiles")
        with ThreadPoolExecutor(max_workers=3) as pool:
            for k, _ in enumerate(pool.map(fetch_tile, todo), 1):
                if k % 10 == 0:
                    print(f"  {k}/{len(todo)} fetched", flush=True)

    names, name_id, ways, missing, seen = [], {}, [], 0, set()
    for i, box in enumerate(tiles, 1):
        key = CACHE / ("streets_%.2f_%.2f_%.2f_%.2f.json" % box)
        if args.offline and not key.exists():
            missing += 1
            continue
        got = fetch_tile(box)
        if got is None:
            missing += 1
            print(f"  tile {i}/{len(tiles)}: unavailable", file=sys.stderr)
            continue
        print(f"  tile {i}/{len(tiles)}: {len(got)} ways")
        for way in got:
            text = label(way)
            if not text:
                continue
            # Keep the runs of the way that lie in the corridor.
            run = []
            runs = []
            for lon, lat in way["geom"]:
                if (math.floor(lon / CELL), math.floor(lat / CELL)) in cells:
                    run.append((lon, lat))
                else:
                    if len(run) > 1:
                        runs.append(run)
                    run = []
            if len(run) > 1:
                runs.append(run)
            for run in runs:
                q = [(round(lon * Q), round(lat * Q)) for lon, lat in run]
                sig = (text, q[0], q[-1], len(q))
                if sig in seen:      # ways crossing tile edges come back twice
                    continue
                seen.add(sig)
                if text not in name_id:
                    name_id[text] = len(names)
                    names.append(text)
                flat = [q[0][0], q[0][1]]
                for (x0, y0), (x1, y1) in zip(q, q[1:]):
                    flat += [x1 - x0, y1 - y0]
                ways.append([name_id[text], flat])

    doc = {
        "note": "Named roads near the district routes, for turn-by-turn street names. "
                "Coordinates are lon,lat in 1e-5 degrees: the first pair absolute, "
                "then deltas. Built by tools/build_streets.py from OpenStreetMap.",
        "attribution": "© OpenStreetMap contributors",
        "names": names,
        "ways": ways,
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(names)} names, {len(ways)} ways, "
          f"{OUT.stat().st_size / 1e6:.2f} MB"
          + (f" — {missing} tiles missing, re-run to fill" if missing else ""))
    if missing:
        sys.exit(1)


if __name__ == "__main__":
    main()
