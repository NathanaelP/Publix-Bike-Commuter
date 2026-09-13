#!/usr/bin/env python3
"""Render docs/ROUTES.md: the travel-time chart for every district store."""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# 16 km/h (10 mph) is the table's headline pace; 20 km/h (12.5 mph) the brisk one.
HEADLINE_KMH = 16
BRISK_KMH = 20

MI = 1609.344


def fmt_time(sec):
    sec = round(sec)
    h, m = divmod(round(sec / 60), 60)
    return f"{h}h {m:02d}m" if h else f"{m} min"


def scaled(route, kmh):
    """BRouter's duration re-based to a chosen pace (see build_routes.py)."""
    return route["duration_s"] * (route.get("implied_kmh") or 19) / kmh


def road_note(route):
    rough = [r for r in route["roads"] if r["rating"] in ("avoid", "busy")]
    if not rough:
        return "quiet roads throughout"
    m = sum(r["m"] for r in rough)
    lane = sum(r.get("bike_lane_m", 0) for r in rough)
    share = 100 * m / max(1, route["distance_m"])
    # Name every busy class present, not just the largest one.
    rough.sort(key=lambda r: -r["m"])
    names = " + ".join(r["label"].lower() for r in rough)
    note = f"{m / MI:.1f} mi ({share:.0f}%) on {names}"
    if lane >= m * 0.8:
        note += ", bike lane most of it"
    elif lane:
        note += f", bike lane only {lane / MI:.1f} mi"
    else:
        note += ", **no bike lane**"
    return note


def main():
    stores = json.load(open(ROOT / "data" / "stores.json"))
    routes = json.load(open(ROOT / "data" / "routes.json"))
    by_ref = {s["ref"] or s["osm"].replace("/", "_"): s for s in stores["stores"]}

    rows = []
    for key, entry in routes["routes"].items():
        store = by_ref.get(key)
        if not store:
            continue
        rows.append((store, entry["balanced"], entry["quiet"]))
    rows.sort(key=lambda r: r[1]["distance_m"])

    out = []
    out.append("# Bike routes from Club Cortile Circle\n")
    out.append(f"Every Publix within {stores['district_radius_km']:.0f} km "
               "(about 9 miles) straight-line of "
               f"**{stores['start']['name']}, {stores['start']['city']}**, with "
               "a bicycle route to each.\n")
    out.append("Times assume a steady **10 mph (16 km/h)** riding pace and come "
               "from BRouter's cycling model, which already accounts for turns, "
               "surfaces and stops. They do **not** include long waits at "
               "signalised intersections on the big arterials. The app has a "
               "pace slider if 10 mph is not your speed.\n")
    out.append(f"_Generated {routes['generated']} · "
               "store directory © Publix Super Markets · "
               "routing and road data © OpenStreetMap contributors_\n")

    out.append("## Balanced routes\n")
    out.append("| Store | Plaza | City | Distance | Time @10 mph | Time @12.5 mph | What you ride on |")
    out.append("|---|---|---|---:|---:|---:|---|")
    for store, bal, _q in rows:
        out.append(
            f"| **#{store['ref']}** | {store['branch']} | {store['city']} "
            f"| {bal['distance_m'] / MI:.1f} mi "
            f"| {fmt_time(scaled(bal, HEADLINE_KMH))} "
            f"| {fmt_time(scaled(bal, BRISK_KMH))} "
            f"| {road_note(bal)} |")

    out.append("\n## Quieter alternative\n")
    out.append("BRouter's `safety` profile, which trades distance for calmer "
               "roads. Worth it where the balanced route puts you on a trunk "
               "highway; not worth it where the detour is enormous.\n")
    out.append("| Store | Quiet distance | Quiet time @10 mph | vs balanced | Verdict |")
    out.append("|---|---:|---:|---:|---|")
    for store, bal, q in rows:
        delta_m = q["distance_m"] - bal["distance_m"]
        delta_t = scaled(q, HEADLINE_KMH) - scaled(bal, HEADLINE_KMH)
        bal_rough = sum(r["m"] for r in bal["roads"] if r["rating"] == "avoid")
        q_rough = sum(r["m"] for r in q["roads"] if r["rating"] == "avoid")
        if delta_m <= 250 and q_rough <= bal_rough:
            verdict = "take it — same length, calmer"
        elif q_rough < bal_rough and delta_t < 480:
            verdict = f"worth it — cuts {(bal_rough - q_rough) / MI:.1f} mi of highway"
        elif delta_m > bal["distance_m"] * 0.5:
            verdict = "detour is too big, stay on balanced"
        elif q_rough >= bal_rough:
            verdict = "no safety gain, stay on balanced"
        else:
            verdict = "judgement call"
        out.append(
            f"| **#{store['ref']}** | {q['distance_m'] / MI:.1f} mi "
            f"| {fmt_time(scaled(q, HEADLINE_KMH))} "
            f"| {'+' if delta_t >= 0 else ''}{round(delta_t / 60)} min "
            f"| {verdict} |")

    out.append("\n## Turn-by-turn\n")
    out.append("Full directions for every store are in the app. Here is the "
               "closest one as a sample.\n")
    store, bal, _ = rows[0]
    out.append(f"### #{store['ref']} {store['branch']} — "
               f"{bal['distance_m'] / MI:.1f} mi, "
               f"{fmt_time(scaled(bal, HEADLINE_KMH))}\n")
    for step in bal["steps"]:
        onto = f" onto **{step['street']}**" if step["street"] else ""
        dist = (f"{step['from_prev_m'] / MI:.1f} mi"
                if step["from_prev_m"] >= 400
                else f"{round(step['from_prev_m'] * 3.28084 / 10) * 10} ft")
        out.append(f"1. {step['verb']}{onto} — _{dist}_")

    path = ROOT / "docs" / "ROUTES.md"
    path.write_text("\n".join(out) + "\n")
    print(f"wrote {path.relative_to(ROOT)} ({len(rows)} stores)")


if __name__ == "__main__":
    main()
