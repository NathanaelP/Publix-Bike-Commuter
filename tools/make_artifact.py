#!/usr/bin/env python3
"""Build docs/district-map.html: a single self-contained interactive map.

Unlike the app, this has no network access at all — no tile server, no routing
API. Everything it draws (the road network behind the routes, the routes
themselves, the directions) is embedded in the file, so it opens anywhere and
keeps working forever.

    python3 tools/make_artifact.py [--basemap tools/.cache/basemap_raw.json]
"""
import argparse
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "tools" / "artifact_template.html"

# Only these road classes are drawn as the backdrop, weighted by importance.
BASEMAP_CLASSES = {
    "motorway": 3, "trunk": 3, "primary": 2, "secondary": 1, "tertiary": 0,
}


def rdp(points, eps):
    """Ramer-Douglas-Peucker, so the embedded geometry stays small."""
    if len(points) < 3:
        return points
    start, end = points[0], points[-1]
    dx, dy = end[0] - start[0], end[1] - start[1]
    norm = math.hypot(dx, dy)
    worst_i, worst_d = 0, -1.0
    for i in range(1, len(points) - 1):
        px, py = points[i][0] - start[0], points[i][1] - start[1]
        d = abs(px * dy - py * dx) / norm if norm else math.hypot(px, py)
        if d > worst_d:
            worst_i, worst_d = i, d
    if worst_d <= eps:
        return [start, end]
    return (rdp(points[:worst_i + 1], eps)[:-1] + rdp(points[worst_i:], eps))


def round_pts(points, nd=5):
    out = []
    for p in points:
        q = [round(p[0], nd), round(p[1], nd)]
        if not out or q != out[-1]:
            out.append(q)
    return out


def build_basemap(path, bbox):
    """Roads inside the drawn area only — anything off-canvas is dead weight."""
    if not path or not pathlib.Path(path).exists():
        print("  no basemap source; the map will show routes only")
        return []
    min_lon, min_lat, max_lon, max_lat = bbox
    raw = json.load(open(path))
    lines, clipped = [], 0
    for el in raw.get("elements", []):
        tags = el.get("tags", {})
        hw = tags.get("highway")
        if hw not in BASEMAP_CLASSES or not el.get("geometry"):
            continue
        pts = [[p["lon"], p["lat"]] for p in el["geometry"]]
        if not any(min_lon <= q[0] <= max_lon and min_lat <= q[1] <= max_lat
                   for q in pts):
            clipped += 1
            continue
        pts = round_pts(rdp(pts, 0.00025), 5)   # ~25 m
        if len(pts) < 2:
            continue
        lines.append([BASEMAP_CLASSES[hw], tags.get("name", ""), pts])
    lines.sort(key=lambda l: l[0])
    print(f"  basemap: {len(lines)} road lines kept, {clipped} outside the view")
    return lines


def view_bbox(stores, routes, stores_doc, pad=0.012):
    lons = [stores_doc["start"]["lon"]] + [s["lon"] for s in stores]
    lats = [stores_doc["start"]["lat"]] + [s["lat"] for s in stores]
    for entry in routes.values():
        for seg in entry["balanced"]["segs"]:
            for q in seg["p"]:
                lons.append(q[0])
                lats.append(q[1])
    return (min(lons) - pad, min(lats) - pad, max(lons) + pad, max(lats) + pad)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--basemap", default=str(ROOT / "tools" / ".cache" / "basemap_raw.json"))
    ap.add_argument("--count", type=int, default=30,
                    help="how many of the nearest stores to embed (default 30)")
    args = ap.parse_args()

    stores_doc = json.load(open(ROOT / "data" / "stores.json"))
    routes_doc = json.load(open(ROOT / "data" / "routes-index.json"))
    detail_dir = ROOT / "data" / "routes"

    by_key = {}
    for s in stores_doc["stores"]:
        by_key[s["ref"] or s["osm"].replace("/", "_")] = s

    # The standalone file embeds everything, so it only carries the nearest
    # stores; the app covers the full radius.
    nearest = sorted(
        (k for k in routes_doc["routes"] if k in by_key),
        key=lambda k: routes_doc["routes"][k]["balanced"]["distance_m"],
    )[:args.count]

    stores, routes = [], {}
    for key in nearest:
        s = by_key[key]
        detail_path = detail_dir / f"{key}.json"
        if not detail_path.exists():
            continue
        entry = json.load(open(detail_path))
        stores.append({
            "ref": s["ref"], "name": s["branch"], "street": s["street"],
            "city": s["city"], "zip": s["zip"], "phone": s["phone"],
            "hours": s["hours"], "lat": s["lat"], "lon": s["lon"],
        })
        out = {}
        for label in ("balanced", "quiet"):
            r = entry[label]
            out[label] = {
                "m": r["distance_m"],
                "s": r["duration_s"],
                "kmh": r["implied_kmh"],
                "roads": [{"l": x["label"], "r": x["rating"], "m": x["m"],
                           "bl": x.get("bike_lane_m", 0)} for x in r["roads"]],
                "steps": [{"v": x["verb"], "i": x["icon"], "st": x["street"],
                           "d": x["from_prev_m"]} for x in r["steps"]],
                "segs": [{"r": x["rating"], "p": round_pts(rdp(x["coords"], 0.00012), 5)}
                         for x in r["segments"]],
            }
        routes[key] = out
    stores.sort(key=lambda s: routes[s["ref"]]["balanced"]["m"])

    payload = {
        "start": stores_doc["start"],
        "generated": routes_doc["generated"],
        "stores": stores,
        "routes": routes,
        "basemap": build_basemap(args.basemap, view_bbox(stores, routes, stores_doc)),
    }

    blob = json.dumps(payload, separators=(",", ":"))
    html = TEMPLATE.read_text().replace('"__DATA__"', blob)
    out_path = ROOT / "docs" / "district-map.html"
    out_path.write_text(html)
    print(f"wrote {out_path.relative_to(ROOT)} "
          f"({out_path.stat().st_size / 1024:.0f} KB, {len(stores)} stores)")


if __name__ == "__main__":
    main()
