# Publix Bike Commuter

Bicycle routes, travel times and turn-by-turn directions from **Club Cortile
Circle, Kissimmee FL** to every Publix in the surrounding district — as an
offline-capable web app you can install on an Android phone.

![app icon](icons/icon-192.png)

## What it does

- **Map of every store**, each pin labelled with its real Publix store number
  (your home store **#1607 Sunrise City Plaza** is picked out in red).
- **Tap a store → the route draws itself**, with distance, ride time and an
  arrival clock time.
- **Two routes per store.** *Balanced* is the sensible everyday line;
  *Quieter roads* trades distance for calmer streets.
- **"What you're riding on."** Every route is broken down by road class —
  bike path, residential, arterial, trunk highway — with the mileage and
  whether there's a bike lane. This is Florida; a five-minute saving that puts
  you on US‑192 with no shoulder is not a saving.
- **Pace slider.** Times re-scale to how fast *you* actually ride.
- **Turn-by-turn directions** with real street names.
- **Navigate mode** follows your GPS, counts down to the next turn, and
  re-routes if you come off the line.
- **Hand off to Google Maps** at any point, passing waypoints from the planned
  route so Google follows roughly the same path.
- **Works with no signal.** All district routes, directions and store details
  are baked in; map tiles cache as you view them.

## Install it on your phone

The app is a PWA, so it installs from the browser — no Play Store, no sideloading.

1. Push to `main` (or run the **Deploy to GitHub Pages** workflow by hand from
   the Actions tab). It turns Pages on for the repo itself and publishes; the
   run's summary shows the published URL.
2. Open that URL in **Chrome on your Android phone**.
3. Menu (⋮) → **Add to Home screen** / **Install app**.

If the deploy fails with `Get Pages site failed`, the workflow could not enable
Pages on its own — set it manually under **Settings → Pages → Source: GitHub
Actions**, then re-run the workflow.

It then launches full-screen with its own icon, keeps working offline, and can
use GPS for navigation.

> Location and install both require HTTPS. GitHub Pages provides it; opening
> `index.html` off the filesystem will not work.

### Want a real APK?

Point [PWABuilder](https://www.pwabuilder.com/) at the published URL, or run
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap), to wrap this
manifest into a signed Android package. Nothing in the app needs to change.

## Run it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

A plain static server is all it needs — there is no build step.

## Where the data comes from

| Data | Source |
|---|---|
| Store numbers, names, addresses, hours, phone | Publix's own store locator (`services.publix.com`) — the same directory publix.com uses |
| Store building positions | OpenStreetMap |
| Roads, bike lanes, surfaces | OpenStreetMap |
| Bicycle routing and durations | [BRouter](https://brouter.de), cycling profiles over OSM data |
| Map tiles | OpenStreetMap standard tiles |

Store data © Publix Super Markets. Map data © OpenStreetMap contributors, ODbL.

## Regenerating the data

```bash
python3 tools/fetch_stores.py     # refresh the store list  -> data/stores.json
python3 tools/build_routes.py     # recompute every route   -> data/routes.json
python3 tools/make_chart.py       # rebuild the time chart  -> docs/ROUTES.md
```

`tools/make_icons.mjs` regenerates the app icons (needs `npm i playwright`).

### Changing the home address or the store set

Both live at the top of `tools/fetch_stores.py`:

```python
START = (28.328194, -81.464348)   # Club Cortile Circle
DISTRICT_RADIUS_KM = 15.0         # what counts as "the district"
MAP_RADIUS_KM = 30.0              # also shown, routed live on demand
```

Change them, re-run both scripts, and the app picks it up. Stores outside the
district radius still appear on the map (tap the layers button) and get routed
live from BRouter when you select one.

## About "the district"

Publix's internal district rosters aren't published anywhere I can read, so
**the store set here is geographic, not official**: every Publix within 15 km
straight-line of Club Cortile Circle, which comes to 20 stores across
Kissimmee, Celebration, Hunter's Creek and south Orlando.

If your actual district roster differs, the fix is a one-line edit — adjust
`DISTRICT_RADIUS_KM`, or hard-code the store numbers you want in
`tools/build_routes.py` via `--refs`:

```bash
python3 tools/build_routes.py --refs 1607 1431 812 1194 707
```

## The travel times

Durations come from BRouter's cycling model, which already accounts for turns,
surfaces and gradient, then get re-scaled to the pace you pick in the app
(default 10 mph / 16 km/h). They **exclude** long waits at signalised
intersections — on routes that cross US‑192 or John Young Parkway, add a couple
of minutes.

Full chart of every store: **[docs/ROUTES.md](docs/ROUTES.md)**.

## The standalone map

`docs/district-map.html` is a single self-contained file — the same stores,
routes, times and directions, drawn on a vector map built from the real road
network. It has no tile server and no routing API behind it, so it opens from a
phone, a USB stick or an email attachment and keeps working with no connection
at all. Open it in any browser; nothing to install.

## Ride safe

Several of these routes use trunk-class highways because Osceola County's grid
leaves no alternative. The app flags every such stretch and tells you whether a
bike lane is mapped. Check the "What you're riding on" panel before committing
to a route you haven't ridden, and prefer the quieter option where the detour
is small.
