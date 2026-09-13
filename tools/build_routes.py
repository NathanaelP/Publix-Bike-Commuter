#!/usr/bin/env python3
"""Precompute bicycle routes from the home base to every district store.

Routes come from BRouter (https://brouter.de), which routes on OpenStreetMap
data using cycling-specific profiles. Two profiles are computed per store:

    balanced  (BRouter "trekking") - sensible mix of speed and road quality
    quiet     (BRouter "safety")   - avoids fast traffic, even if longer

For each route we keep the geometry, distance, climb, BRouter's own duration,
a turn-by-turn instruction list, and a breakdown of how many metres are spent
on each class of road. That last one matters here: a route that saves five
minutes by putting you on a 55 mph trunk road is not actually a better route.

Usage:
    python3 tools/build_routes.py              # all district stores
    python3 tools/build_routes.py --refs 1607 1431
"""
import argparse
import json
import math
import pathlib
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"

BROUTER = "https://brouter.de/brouter"
PROFILES = {"balanced": "trekking", "quiet": "safety"}

# Be a good citizen on a free public routing service.
REQUEST_DELAY_S = 1.5

# BRouter voice-hint command IDs -> (verb, short code)
COMMANDS = {
    1: ("Continue straight", "straight"),
    2: ("Turn left", "left"),
    3: ("Bear left", "slight-left"),
    4: ("Sharp left", "sharp-left"),
    5: ("Turn right", "right"),
    6: ("Bear right", "slight-right"),
    7: ("Sharp right", "sharp-right"),
    8: ("Keep left", "slight-left"),
    9: ("Keep right", "slight-right"),
    10: ("Make a U-turn", "uturn"),
    11: ("Make a U-turn", "uturn"),
    12: ("Leave the route", "straight"),
    13: ("Enter the roundabout", "roundabout"),
    14: ("Enter the roundabout", "roundabout"),
    15: ("Head toward the destination", "straight"),
}

# How each OSM highway class rides on a bike. Florida arterials are genuinely
# dangerous, so they get called out rather than silently folded into the total.
ROAD_CLASSES = {
    "cycleway": ("Bike path", "great"),
    "path": ("Path", "great"),
    "footway": ("Sidewalk / footway", "good"),
    "pedestrian": ("Pedestrian street", "good"),
    "track": ("Track", "good"),
    "living_street": ("Living street", "great"),
    "residential": ("Residential street", "great"),
    "service": ("Service road / parking aisle", "good"),
    "unclassified": ("Minor road", "good"),
    "tertiary": ("Tertiary road", "ok"),
    "tertiary_link": ("Tertiary road", "ok"),
    "secondary": ("Secondary road", "busy"),
    "secondary_link": ("Secondary road", "busy"),
    "primary": ("Major arterial", "busy"),
    "primary_link": ("Major arterial", "busy"),
    "trunk": ("Highway (trunk)", "avoid"),
    "trunk_link": ("Highway ramp", "avoid"),
    "motorway": ("Interstate", "avoid"),
    "motorway_link": ("Interstate ramp", "avoid"),
    "steps": ("Steps", "ok"),
}


def haversine_m(a, b):
    r = 6371008.8
    p1, p2 = math.radians(a[1]), math.radians(b[1])
    dp = p2 - p1
    dl = math.radians(b[0] - a[0])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def get_json(url, timeout=90, tries=4):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "PublixBikeCommuter/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as fh:
                return json.load(fh)
        except Exception as exc:  # noqa: BLE001 - retry any transport failure
            last = exc
            print(f"    attempt {attempt + 1} failed: {exc}", file=sys.stderr)
            time.sleep(2 ** attempt)
    raise RuntimeError(f"request failed after {tries} tries: {last}")


def brouter(start, dest, profile):
    qs = urllib.parse.urlencode({
        "lonlats": f"{start[1]},{start[0]}|{dest[1]},{dest[0]}",
        "profile": profile,
        "alternativeidx": 0,
        "format": "geojson",
        "timode": 2,
    })
    return get_json(f"{BROUTER}?{qs}")


# ---------------------------------------------------------------- road names

def fetch_road_names(bbox):
    """Named road geometry in the bbox, so turns can be described by street."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / "roads.json"
    if cached.exists():
        return json.load(open(cached))

    query = (
        "[out:json][timeout:300];"
        'way["highway"]["name"](%f,%f,%f,%f);' % bbox + "out geom;"
    )
    body = urllib.parse.urlencode({"data": query}).encode()
    endpoints = [
        "https://overpass.private.coffee/api/interpreter",
        "https://overpass-api.de/api/interpreter",
    ]
    for endpoint in endpoints:
        for attempt in range(4):
            try:
                req = urllib.request.Request(
                    endpoint, data=body,
                    headers={"User-Agent": "PublixBikeCommuter/1.0"})
                with urllib.request.urlopen(req, timeout=300) as fh:
                    raw = json.load(fh)
                roads = [
                    {"name": el["tags"]["name"],
                     "geom": [(p["lon"], p["lat"]) for p in el["geometry"]]}
                    for el in raw.get("elements", [])
                    if el.get("geometry") and el.get("tags", {}).get("name")
                ]
                cached.write_text(json.dumps(roads))
                print(f"  cached {len(roads)} named roads")
                return roads
            except Exception as exc:  # noqa: BLE001
                print(f"  road-name fetch attempt {attempt + 1}: {exc}",
                      file=sys.stderr)
                time.sleep(2 ** attempt)
    print("  WARNING: no street names available; directions will omit them",
          file=sys.stderr)
    return []


class RoadIndex:
    """Coarse grid index for 'what street is this point on?' lookups."""

    CELL = 0.01  # ~1.1 km

    def __init__(self, roads):
        self.cells = {}
        for road in roads:
            pts = road["geom"]
            for i in range(len(pts) - 1):
                seg = (pts[i], pts[i + 1], road["name"])
                for key in self._keys(pts[i], pts[i + 1]):
                    self.cells.setdefault(key, []).append(seg)

    def _keys(self, a, b):
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        keys = set()
        xi = math.floor(x0 / self.CELL)
        while xi <= math.floor(x1 / self.CELL):
            yi = math.floor(y0 / self.CELL)
            while yi <= math.floor(y1 / self.CELL):
                keys.add((xi, yi))
                yi += 1
            xi += 1
        return keys

    def nearest_name(self, pt, max_m=30.0):
        key = (math.floor(pt[0] / self.CELL), math.floor(pt[1] / self.CELL))
        best, best_d = None, max_m
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for a, b, name in self.cells.get((key[0] + dx, key[1] + dy), ()):
                    d = self._point_seg_m(pt, a, b)
                    if d < best_d:
                        best, best_d = name, d
        return best

    @staticmethod
    def _point_seg_m(p, a, b):
        # Work in local metres so the projection maths stays simple.
        scale_x = 111320.0 * math.cos(math.radians(p[1]))
        scale_y = 110540.0
        px, py = 0.0, 0.0
        ax = (a[0] - p[0]) * scale_x
        ay = (a[1] - p[1]) * scale_y
        bx = (b[0] - p[0]) * scale_x
        by = (b[1] - p[1]) * scale_y
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return math.hypot(ax, ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        return math.hypot(ax + t * dx, ay + t * dy)


# ------------------------------------------------------------------ assembly

def road_breakdown(props):
    """Metres ridden per road class, from BRouter's per-segment way tags."""
    msgs = props.get("messages") or []
    if len(msgs) < 2:
        return []
    header = msgs[0]
    i_dist, i_tags = header.index("Distance"), header.index("WayTags")
    totals = {}
    for row in msgs[1:]:
        tags = dict(
            kv.split("=", 1) for kv in row[i_tags].split() if "=" in kv)
        hw = tags.get("highway", "unknown")
        label, rating = ROAD_CLASSES.get(hw, (hw.replace("_", " ").title(), "ok"))
        entry = totals.setdefault(label, {"label": label, "rating": rating, "m": 0})
        entry["m"] += int(row[i_dist])
        if tags.get("cycleway", "").endswith(("lane", "track")):
            entry["bike_lane_m"] = entry.get("bike_lane_m", 0) + int(row[i_dist])
    return sorted(totals.values(), key=lambda e: -e["m"])


def cumulative(coords):
    out = [0.0]
    for i in range(1, len(coords)):
        out.append(out[-1] + haversine_m(coords[i - 1], coords[i]))
    return out


def directions(props, coords, index, dest_name):
    hints = props.get("voicehints") or []
    cum = cumulative(coords)
    times = props.get("times") or []
    steps = []
    prev_m = 0.0
    for hint in hints:
        idx, cmd = int(hint[0]), int(hint[1])
        if idx >= len(coords):
            continue
        verb, code = COMMANDS.get(cmd, ("Continue", "straight"))
        here = cum[idx]
        street = index.nearest_name((coords[idx][0], coords[idx][1])) if index else None
        steps.append({
            "verb": verb,
            "icon": code,
            "street": street,
            "at_m": round(here),
            "from_prev_m": round(here - prev_m),
            "at_s": round(times[idx]) if idx < len(times) else None,
            "lat": round(coords[idx][1], 6),
            "lon": round(coords[idx][0], 6),
        })
        prev_m = here
    steps.append({
        "verb": f"Arrive at {dest_name}",
        "icon": "arrive",
        "street": None,
        "at_m": round(cum[-1]),
        "from_prev_m": round(cum[-1] - prev_m),
        "at_s": round(times[-1]) if times else None,
        "lat": round(coords[-1][1], 6),
        "lon": round(coords[-1][0], 6),
    })
    return steps


def simplify(coords, tol_deg=0.00002):
    """Drop near-collinear points; keeps routes.json a sane size for mobile."""
    if len(coords) < 3:
        return coords
    out = [coords[0]]
    for pt in coords[1:-1]:
        a, b = out[-1], pt
        if abs(a[0] - b[0]) > tol_deg or abs(a[1] - b[1]) > tol_deg:
            out.append(pt)
    out.append(coords[-1])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refs", nargs="*", help="only these store numbers")
    ap.add_argument("--all", action="store_true",
                    help="route every store on the map, not just the district")
    args = ap.parse_args()

    stores_doc = json.load(open(ROOT / "data" / "stores.json"))
    start = (stores_doc["start"]["lat"], stores_doc["start"]["lon"])
    targets = [s for s in stores_doc["stores"] if args.all or s["district"]]
    if args.refs:
        targets = [s for s in targets if s["ref"] in args.refs]
    if not targets:
        raise SystemExit("no stores matched")

    lats = [start[0]] + [s["lat"] for s in targets]
    lons = [start[1]] + [s["lon"] for s in targets]
    pad = 0.04
    bbox = (min(lats) - pad, min(lons) - pad, max(lats) + pad, max(lons) + pad)
    print("fetching street names for turn directions...")
    index = RoadIndex(fetch_road_names(bbox))

    routes = {}
    for n, store in enumerate(targets, 1):
        key = store["ref"] or store["osm"].replace("/", "_")
        print(f"[{n}/{len(targets)}] #{key} {store['branch'] or store['street']}")
        entry = {}
        for label, profile in PROFILES.items():
            doc = brouter(start, (store["lat"], store["lon"]), profile)
            feat = doc["features"][0]
            props = feat["properties"]
            coords = [(round(c[0], 6), round(c[1], 6))
                      for c in feat["geometry"]["coordinates"]]
            dist_m = int(props["track-length"])
            dur_s = int(props["total-time"])
            entry[label] = {
                "profile": profile,
                "distance_m": dist_m,
                "duration_s": dur_s,
                "ascend_m": int(props.get("filtered ascend") or 0),
                "implied_kmh": round(dist_m / 1000 / (dur_s / 3600), 1) if dur_s else None,
                "roads": road_breakdown(props),
                "steps": directions(props, coords, index,
                                    store["name"] or "the store"),
                "geometry": simplify(coords),
            }
            print(f"      {label:8} {dist_m/1000:5.2f} km  {dur_s//60:2}m{dur_s%60:02}s"
                  f"  ({len(entry[label]['geometry'])} pts)")
            time.sleep(REQUEST_DELAY_S)
        routes[key] = entry

    out = {
        "start": stores_doc["start"],
        "profiles": PROFILES,
        "generated": time.strftime("%Y-%m-%d"),
        "attribution": "Routing by BRouter on OpenStreetMap data (ODbL)",
        "routes": routes,
    }
    path = ROOT / "data" / "routes.json"
    path.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    print(f"\nwrote {path.relative_to(ROOT)} "
          f"({path.stat().st_size / 1024:.0f} KB, {len(routes)} stores)")


if __name__ == "__main__":
    main()
