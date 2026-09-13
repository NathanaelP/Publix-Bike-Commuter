#!/usr/bin/env python3
"""Build data/stores.json: every Publix within range of the home base.

Two sources, each used for what it is best at:

  Publix store locator  - authoritative store numbers, store names, phone and
                          hours. This is the same directory the publix.com
                          store finder uses.
  OpenStreetMap         - precise building coordinates, which is what the
                          router needs to put you at the right door.

Publix coordinates are used when OSM has no matching building nearby.

Usage:
    python3 tools/fetch_stores.py
    python3 tools/fetch_stores.py --osm-raw cached-overpass.json
"""
import argparse
import html
import json
import math
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Home base: Club Cortile Circle, Kissimmee FL 34746
START = (28.328194, -81.464348)
START_NAME = "Club Cortile Circle"
START_CITY = "Kissimmee, FL 34746"

DISTRICT_RADIUS_KM = 15.0   # treated as the commutable district
MAP_RADIUS_KM = 30.0        # still shown on the map, routable on demand

PUBLIX_API = "https://services.publix.com/api/v1/storelocation"
UA = ("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Mobile Safari/537.36")

OVERPASS_ENDPOINTS = [
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
OSM_BBOX = (27.95, -81.90, 28.70, -81.05)


def haversine_km(a, b):
    r = 6371.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


# ------------------------------------------------------------ Publix locator

def probe_points():
    """The locator returns ~25 stores per query, so sweep a ring of probes."""
    pts = [START]
    for radius_km, count in ((12.0, 6), (24.0, 8)):
        for i in range(count):
            ang = 2 * math.pi * i / count
            dlat = radius_km / 111.32
            dlon = radius_km / (111.32 * math.cos(math.radians(START[0])))
            pts.append((START[0] + dlat * math.sin(ang),
                        START[1] + dlon * math.cos(ang)))
    return pts


def fetch_publix():
    found = {}
    for n, (lat, lon) in enumerate(probe_points(), 1):
        qs = urllib.parse.urlencode({
            "latitude": f"{lat:.6f}", "longitude": f"{lon:.6f}",
            "count": 25, "types": "R", "isWebsite": "true",
        })
        try:
            req = urllib.request.Request(f"{PUBLIX_API}?{qs}",
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as fh:
                doc = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            print(f"  probe {n} failed: {exc}", file=sys.stderr)
            continue
        for s in doc.get("Stores", []):
            key = s.get("KEY", "").lstrip("0")
            if not key or key in found:
                continue
            try:
                pos = (float(s["CLAT"]), float(s["CLON"]))
            except (KeyError, TypeError, ValueError):
                continue
            if haversine_km(START, pos) > MAP_RADIUS_KM + 3:
                continue
            found[key] = {
                "ref": key,
                "branch": html.unescape(s.get("NAME", "")).strip(),
                "lat": pos[0], "lon": pos[1],
                "street": html.unescape(s.get("ADDR", "")).strip(),
                "city": html.unescape(s.get("CITY", "")).strip(),
                "state": s.get("STATE", "").strip(),
                "zip": (s.get("ZIP", "") or "").split("-")[0],
                "phone": re.sub(r"[^\d]", "", s.get("PHONE", "")),
                "hours": compact_hours(s.get("STRHOURS", "")),
                "departments": [d for d in
                                html.unescape(s.get("DEPTS", "")).split(",") if d],
            }
        time.sleep(0.4)
    print(f"  Publix locator: {len(found)} stores")
    return found


def compact_hours(raw):
    """'Sun 7:00 AM - 10:00 PM,Mon ...' -> 'Daily 7am-10pm' when uniform."""
    parts = [p.strip() for p in (raw or "").split(",") if p.strip()]
    spans = []
    for p in parts:
        m = re.match(r"^(\w+)\s+(.*)$", p)
        if m:
            spans.append(m.group(2).strip())
    if not spans:
        return ""
    tidy = lambda s: (s.replace(":00", "").replace(" AM", "am")
                       .replace(" PM", "pm").replace(" - ", "-"))
    if len(set(spans)) == 1:
        return "Daily " + tidy(spans[0])
    return tidy(spans[0])


# -------------------------------------------------------------------- OSM

def fetch_osm(raw_path=None):
    if raw_path:
        raw = json.load(open(raw_path))
    else:
        query = ('[out:json][timeout:180];'
                 'nwr["brand:wikidata"="Q672170"](%f,%f,%f,%f);'
                 'out center tags;' % OSM_BBOX)
        body = urllib.parse.urlencode({"data": query}).encode()
        raw = None
        for endpoint in OVERPASS_ENDPOINTS:
            for attempt in range(4):
                try:
                    req = urllib.request.Request(
                        endpoint, data=body, headers={"User-Agent": UA})
                    with urllib.request.urlopen(req, timeout=200) as fh:
                        raw = json.load(fh)
                    break
                except Exception as exc:  # noqa: BLE001
                    print(f"  overpass attempt {attempt + 1}: {exc}",
                          file=sys.stderr)
                    time.sleep(2 ** attempt)
            if raw:
                break
        if not raw:
            print("  WARNING: OSM unavailable; using Publix coordinates only",
                  file=sys.stderr)
            return []

    out = []
    for el in raw.get("elements", []):
        tags = el.get("tags", {})
        if tags.get("shop") != "supermarket":
            continue
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        if lat is None:
            continue
        out.append({"ref": tags.get("ref", ""), "lat": lat, "lon": lon,
                    "osm": f"{el['type']}/{el['id']}"})
    print(f"  OpenStreetMap: {len(out)} supermarket nodes")
    return out


def merge(publix, osm):
    """Prefer OSM's building coordinate when it clearly matches the store."""
    by_ref = {o["ref"]: o for o in osm if o["ref"]}
    used = set()
    for ref, store in publix.items():
        hit = by_ref.get(ref)
        if not hit:
            # No store number in OSM: fall back to the nearest building.
            best, best_km = None, 0.25
            for o in osm:
                if o["osm"] in used:
                    continue
                km = haversine_km((store["lat"], store["lon"]), (o["lat"], o["lon"]))
                if km < best_km:
                    best, best_km = o, km
            hit = best
        if hit:
            used.add(hit["osm"])
            store["lat"] = round(hit["lat"], 6)
            store["lon"] = round(hit["lon"], 6)
            store["osm"] = hit["osm"]
        else:
            store["lat"] = round(store["lat"], 6)
            store["lon"] = round(store["lon"], 6)
            store["osm"] = ""
    return publix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--osm-raw", help="reuse a saved Overpass response")
    args = ap.parse_args()

    print("fetching Publix store directory...")
    publix = fetch_publix()
    if not publix:
        raise SystemExit("Publix locator returned nothing; aborting")

    print("fetching OpenStreetMap building positions...")
    stores = merge(publix, fetch_osm(args.osm_raw))

    rows = []
    for store in stores.values():
        km = haversine_km(START, (store["lat"], store["lon"]))
        if km > MAP_RADIUS_KM:
            continue
        store["crow_km"] = round(km, 2)
        store["district"] = km <= DISTRICT_RADIUS_KM
        store["name"] = f"#{store['ref']} {store['branch']}".strip()
        rows.append(store)
    rows.sort(key=lambda r: r["crow_km"])

    doc = {
        "start": {"name": START_NAME, "city": START_CITY,
                  "lat": START[0], "lon": START[1]},
        "district_radius_km": DISTRICT_RADIUS_KM,
        "generated": time.strftime("%Y-%m-%d"),
        "attribution": ("Store directory © Publix Super Markets; "
                        "positions © OpenStreetMap contributors (ODbL)"),
        "stores": rows,
    }
    path = ROOT / "data" / "stores.json"
    path.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"\nwrote {path.relative_to(ROOT)}: {len(rows)} stores, "
          f"{sum(1 for r in rows if r['district'])} in the district radius")
    for r in rows[:12]:
        print(f"  #{r['ref']:<5} {r['crow_km']:>5} km  {r['branch']}")


if __name__ == "__main__":
    main()
