/* Publix Bike Commuter — Leaflet map, precomputed BRouter routes, live GPS nav.
 *
 * Route data is split so the app opens fast on a phone: data/routes-index.json
 * carries every store's distance, duration and road mix and loads at boot,
 * while data/routes/<store>.json carries that store's geometry and turn list
 * and is fetched when the store is opened. A re-route once you are already
 * rolling goes live to BRouter, which allows cross-origin requests.
 */
'use strict';

var BROUTER = 'https://brouter.de/brouter';
/* Our own profiles, shipped as static files. BRouter's stock profiles refuse
 * untagged footways, which here means refusing the sidewalk network and putting
 * you on US-192 instead; see tools/make_profiles.py. They are uploaded once and
 * the returned id cached, so live re-routes match the baked-in routes. */
var PROFILE_FILES = { balanced: 'profiles/florida-balanced.brf',
                      quiet: 'profiles/florida-calm.brf' };
var PROFILE_FALLBACK = { balanced: 'trekking', quiet: 'safety' };
var OFF_ROUTE_M = 60;       // how far off the line before we re-route
var RATE_COLORS = {
  great: '--rate-great', good: '--rate-good', ok: '--rate-ok',
  busy: '--rate-busy', avoid: '--rate-avoid'
};

var STEP_ICONS = {
  straight: 'M12 20V6M12 6l-4 4M12 6l4 4',
  left: 'M18 20V11a3 3 0 00-3-3H7M7 8l4-4M7 8l4 4',
  right: 'M6 20V11a3 3 0 013-3h8M17 8l-4-4M17 8l-4 4',
  'slight-left': 'M14 20v-7.5a4 4 0 00-1.2-2.9L9 6M9 6h4M9 6v4',
  'slight-right': 'M10 20v-7.5a4 4 0 011.2-2.9L15 6M15 6h-4M15 6v4',
  'sharp-left': 'M17 20v-6a4 4 0 00-4-4H8M8 10l5-4M8 10l5 4',
  'sharp-right': 'M7 20v-6a4 4 0 014-4h5M16 10l-5-4M16 10l-5 4',
  uturn: 'M8 20V11a4 4 0 018 0v3M16 14l-2.5-2.5M16 14l2.5-2.5',
  roundabout: 'M12 20v-5M12 15a4 4 0 104-4h3M19 11l-2.5-2.5M19 11l-2.5 2.5',
  arrive: 'M12 21s6.5-6 6.5-10.5a6.5 6.5 0 10-13 0C5.5 15 12 21 12 21z|M12 10.5h.01'
};

/* ------------------------------------------------------------------ state */

var S = {
  stores: [],
  routes: {},        // summary per store: distance, duration, road mix
  detail: {},        // full geometry + turns, fetched when a store is opened
  detailPending: {},
  brouterProfile: null,
  start: null,
  selected: null,
  profile: 'balanced',
  paceKmh: 10 * 1.609344,      // always the speed actually used for every time shown
  imperial: true,
  showFar: false,
  navigating: false,
  me: null,            // {lat, lon, accuracy}
  watchId: null,
  liveRoute: null,     // live re-route result, overrides the baked one
  sheet: 'half',
  headingUp: true,     // turn the map with the rider while navigating
  trip: 'out',         // 'out' = home → store (the default), 'home' = store → home
  homeRoute: null      // {key, profile, route} while a trip home is active
};

var map, layerRoute, layerHalo, markers = {}, meMarker, homeMarker;
var el = {};

/* ------------------------------------------------------------- formatting */

function fmtDist(m) {
  if (S.imperial) {
    var ft = m * 3.28084;
    if (ft < 800) return Math.round(ft / 10) * 10 + ' ft';
    return (m / 1609.344).toFixed(m < 16093 ? 1 : 0) + ' mi';
  }
  if (m < 950) return Math.round(m / 10) * 10 + ' m';
  return (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
}

function fmtDistShort(m) {
  return S.imperial ? (m / 1609.344).toFixed(1) + ' mi' : (m / 1000).toFixed(1) + ' km';
}

function fmtDur(s) {
  // Round to whole minutes first, then split into hours: splitting first let
  // 1h 59m 40s round its minutes up to "1h 60m".
  var mins = Math.max(1, Math.round(Math.max(0, s) / 60));
  var h = Math.floor(mins / 60), m = mins % 60;
  if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
  return mins + ' min';
}

/* ------------------------------------------------------------------- pace
 * The slider carries the number the rider reads, in the units on screen, so two
 * neighbouring positions can never display the same speed. (It used to run in
 * whole km/h under a label rounded to whole mph, and 8 of its 20 steps repeated
 * the label of the step before while the time changed.) S.paceKmh is always the
 * exact speed behind the label, and every time shown is derived from it. */
var KMH_PER_MPH = 1.609344;
var PACE_UNITS = {
  imperial: { min: 5, max: 18, step: 0.5, name: 'mph',  toKmh: KMH_PER_MPH },
  metric:   { min: 8, max: 30, step: 1,   name: 'km/h', toKmh: 1 }
};

function paceUnits() { return S.imperial ? PACE_UNITS.imperial : PACE_UNITS.metric; }

function fmtPace(valueInUnits) {
  return (Math.round(valueInUnits * 10) / 10) + ' ' + paceUnits().name;
}

/* Nearest slider position, in display units, for a speed in km/h. */
function snapPace(kmh) {
  var u = paceUnits();
  var v = Math.round(kmh / u.toKmh / u.step) * u.step;
  return Math.round(Math.min(u.max, Math.max(u.min, v)) * 100) / 100;
}

/* Point the slider, the label and S.paceKmh at one agreed value. */
function syncPaceControl() {
  var u = paceUnits();
  el.pace.min = u.min; el.pace.max = u.max; el.pace.step = u.step;
  var v = snapPace(S.paceKmh);
  el.pace.value = v;
  S.paceKmh = v * u.toKmh;
  el.paceOut.textContent = fmtPace(v);
  el.pace.setAttribute('aria-valuetext', fmtPace(v));
  el.dTimeLbl.textContent = 'ride @ ' + fmtPace(v);
  try { localStorage.setItem('pbc.pace', String(S.paceKmh)); } catch (e) { /* private mode */ }
}

function fmtClock(secFromNow) {
  var d = new Date(Date.now() + secFromNow * 1000);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* Moving time at the rider's pace: distance divided by speed, nothing else.
 * One function for every time on screen — list, detail and the live ETA while
 * navigating — so they cannot disagree. It does not include waits at signals. */
function secondsFor(distanceM) {
  return distanceM / (S.paceKmh * 1000 / 3600);
}

function rideSeconds(route) { return secondsFor(route.distance_m); }

/* ---------------------------------------------------------------- geometry */

function metersBetween(aLat, aLon, bLat, bLon) {
  var R = 6371008.8, p1 = aLat * Math.PI / 180, p2 = bLat * Math.PI / 180;
  var dp = p2 - p1, dl = (bLon - aLon) * Math.PI / 180;
  var h = Math.sin(dp / 2) * Math.sin(dp / 2) +
          Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* Nearest point on the route to a position, as {offRouteM, alongM}. */
function projectOnRoute(coords, lat, lon) {
  var best = { offRouteM: Infinity, alongM: 0 }, along = 0;
  var kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  for (var i = 0; i < coords.length - 1; i++) {
    var ax = (coords[i][0] - lon) * kx, ay = (coords[i][1] - lat) * ky;
    var bx = (coords[i + 1][0] - lon) * kx, by = (coords[i + 1][1] - lat) * ky;
    var dx = bx - ax, dy = by - ay;
    var segLen = Math.sqrt(dx * dx + dy * dy);
    var t = 0;
    if (segLen > 0) t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
    var px = ax + t * dx, py = ay + t * dy;
    var d = Math.sqrt(px * px + py * py);
    if (d < best.offRouteM) best = { offRouteM: d, alongM: along + segLen * t };
    along += segLen;
  }
  best.totalM = along;
  return best;
}

/* ------------------------------------------------------------------- data */

function storeKey(s) { return s.ref || s.osm.replace('/', '_'); }

function routeFor(store, profile) {
  var key = storeKey(store);
  profile = profile || S.profile;
  if (S.liveRoute && S.liveRoute.key === key) return S.liveRoute.route;
  var full = S.detail[key] && S.detail[key][profile];
  if (full) {
    if (!full.geometry) full.geometry = joinSegments(full.segments);
    return nameRoute(full);
  }
  var brief = S.routes[key];
  return brief ? brief[profile] : null;   // stats only; no geometry yet
}

/* Geometry and turn lists live in one file per store so the app boots on the
 * index alone. Fetch a store's file the first time it is opened. */
function loadDetail(store) {
  var key = storeKey(store);
  if (S.detail[key]) return Promise.resolve(S.detail[key]);
  if (S.detailPending[key]) return S.detailPending[key];
  var job = fetch('data/routes/' + encodeURIComponent(key) + '.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (doc) { S.detail[key] = doc; delete S.detailPending[key]; return doc; })
    .catch(function (err) {
      delete S.detailPending[key];
      console.warn('route detail failed for ' + key, err);
      return null;
    });
  S.detailPending[key] = job;
  return job;
}

/* Route geometry ships split into runs of one road rating; stitch them back
 * into a single line for distance-along and off-route maths. */
function joinSegments(segments) {
  var out = [];
  (segments || []).forEach(function (seg, i) {
    var pts = seg.coords;
    out = out.concat(i === 0 ? pts : pts.slice(1));
  });
  return out;
}

function sortedStores() {
  var list = S.stores.filter(function (s) { return s.district || S.showFar; });
  return list.sort(function (a, b) {
    var ra = S.routes[storeKey(a)], rb = S.routes[storeKey(b)];
    var da = ra ? ra[S.profile].distance_m : a.crow_km * 1000 * 1.35;
    var db = rb ? rb[S.profile].distance_m : b.crow_km * 1000 * 1.35;
    return da - db;
  });
}

/* ------------------------------------------------------------------- map */

function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true })
         .setView([S.start.lat, S.start.lon], 12);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(map);

  layerHalo = L.layerGroup().addTo(map);
  layerRoute = L.layerGroup().addTo(map);

  homeMarker = L.marker([S.start.lat, S.start.lon], {
    icon: L.divIcon({ className: '', html: '<div class="home-pin">🏠</div>',
                      iconSize: [30, 30], iconAnchor: [15, 15] }),
    zIndexOffset: 900, title: 'Home — ' + S.start.name
  }).addTo(map).bindTooltip('Home · ' + S.start.name, { direction: 'top' });

  drawMarkers();
  fitAll();
}

function drawMarkers() {
  Object.keys(markers).forEach(function (k) { map.removeLayer(markers[k]); });
  markers = {};
  S.stores.forEach(function (s) {
    if (!s.district && !S.showFar) return;
    var cls = 'store-pin' + (s.district ? '' : ' is-far') +
              (s.ref === '1607' ? ' is-home' : '');
    var size = s.district ? 34 : 27;
    var m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: '', html: '<div class="' + cls + '">' + (s.ref || '?') + '</div>',
                        iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      title: s.name, zIndexOffset: s.district ? 500 : 100
    }).addTo(map);
    m.bindTooltip(s.name + (s.ref === '1607' ? ' · your home store' : ''),
                  { direction: 'top', offset: [0, -12] });
    m.on('click', function () { selectStore(s, true); });
    markers[storeKey(s)] = m;
  });
  highlightMarker();
}

function highlightMarker() {
  Object.keys(markers).forEach(function (k) {
    var node = markers[k].getElement();
    if (!node) return;
    var pin = node.querySelector('.store-pin');
    if (pin) pin.classList.toggle('is-sel', !!S.selected && k === storeKey(S.selected));
  });
}

function fitAll() {
  var pts = [[S.start.lat, S.start.lon]];
  S.stores.forEach(function (s) {
    if (s.district || S.showFar) pts.push([s.lat, s.lon]);
  });
  map.fitBounds(L.latLngBounds(pts), {
    paddingTopLeft: [40, topPx() + 16],
    paddingBottomRight: [40, sheetPx() + 20]
  });
}

function sheetPx() {
  if (!el.sheet) return 0;
  var r = el.sheet.getBoundingClientRect();
  // On wide screens the sheet is a side panel, so it steals width, not height.
  return window.innerWidth >= 760 ? 0 : r.height;
}

/* Vertical space taken by the floating header, so fitBounds does not tuck
 * markers underneath it. */
function topPx() {
  var bar = S.navigating ? el.navBanner : document.querySelector('.topbar');
  return bar && !bar.hidden ? bar.getBoundingClientRect().bottom : 0;
}

function drawRoute(route) {
  layerRoute.clearLayers();
  layerHalo.clearLayers();
  if (!route) return;
  var latlngs = route.geometry.map(function (c) { return [c[1], c[0]]; });
  var css = getComputedStyle(document.documentElement);

  // White casing under the whole line keeps it readable over any basemap.
  L.polyline(latlngs, { color: '#fff', weight: 10, opacity: .9, lineCap: 'round',
                        lineJoin: 'round' }).addTo(layerHalo);

  // Then each run in the colour of the road it actually uses, so a mile of
  // trunk highway is visible on the map instead of buried in the total.
  var segs = route.segments || [{ rating: 'ok', coords: route.geometry }];
  segs.forEach(function (seg) {
    var c = css.getPropertyValue(RATE_COLORS[seg.rating] || '--rate-ok').trim();
    L.polyline(seg.coords.map(function (p) { return [p[1], p[0]]; }), {
      color: c, weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round'
    }).addTo(layerRoute);
  });

  if (!S.navigating) {
    map.fitBounds(L.latLngBounds(latlngs), {
      paddingTopLeft: [45, topPx() + 16],
      paddingBottomRight: [45, sheetPx() + 20]
    });
  }
}

/* -------------------------------------------------------------- list view */

function renderList() {
  var list = sortedStores();
  el.listCount.textContent = list.length + ' stores';
  el.storeList.innerHTML = '';
  list.forEach(function (s) {
    var r = routeFor(s, S.profile);
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.className = 'storecard';
    b.type = 'button';
    var isHome = s.ref === '1607';
    b.innerHTML =
      '<span class="badge' + (isHome ? ' is-home' : '') + '">' + (s.ref || '—') + '</span>' +
      '<span class="storecard-main">' +
        '<span class="storecard-name">' + escapeHtml(s.branch || s.street) +
          (isHome ? '<span class="pill pill-home">home</span>' : '') +
          (!s.district ? '<span class="pill">outside</span>' : '') + '</span>' +
        '<span class="storecard-sub">' + escapeHtml(s.street + ' · ' + s.city) + '</span>' +
      '</span>' +
      '<span class="storecard-time">' +
        '<b>' + (r ? fmtDur(rideSeconds(r)) : '–') + '</b>' +
        '<span>' + (r ? fmtDistShort(r.distance_m) : 'tap to route') + '</span>' +
      '</span>';
    b.addEventListener('click', function () { selectStore(s, true); });
    li.appendChild(b);
    el.storeList.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

function filterList(q) {
  q = q.trim().toLowerCase();
  [].forEach.call(el.storeList.children, function (li) {
    li.hidden = q && li.textContent.toLowerCase().indexOf(q) < 0;
  });
}

/* ------------------------------------------------------------ detail view */

function selectStore(store, openSheet) {
  if (S.trip === 'home') {
    if (S.navigating) stopNav();
    endTripHome();
  }
  S.selected = store;
  S.liveRoute = null;
  el.listView.hidden = true;
  el.detailView.hidden = false;
  if (openSheet) setSheet('half');
  highlightMarker();

  var route = routeFor(store, S.profile);
  renderDetail(store, route);           // stats land immediately from the index

  if (route && !route.segments) {
    loadDetail(store).then(function (doc) {
      if (!S.selected || storeKey(S.selected) !== storeKey(store)) return;
      if (doc) renderDetail(store, routeFor(store, S.profile));
      else fetchLiveRoute(store, S.profile);
    });
  } else if (!route) {
    fetchLiveRoute(store, S.profile);
  }
}

function renderDetail(store, route) {
  el.dStore.textContent = (store.ref ? '#' + store.ref + '  ' : '') +
                          (store.branch || store.street);
  el.dAddr.textContent = [store.street, store.city, store.state, store.zip]
                           .filter(Boolean).join(', ');
  el.dHours.textContent = store.hours
    ? 'Store hours: ' + store.hours.replace('Mo-Su', 'Daily ').replace(/:00/g, '')
    : '';
  el.btnCall.href = store.phone ? 'tel:' + store.phone.replace(/[^\d+]/g, '') : '#';
  el.btnCall.style.display = store.phone ? '' : 'none';

  if (!route) {
    el.dTime.textContent = '…';
    el.dDist.textContent = '…';
    el.dArrive.textContent = '…';
    el.dSteps.innerHTML = '<li><span class="step-main">Working out a route…</span></li>';
    el.dRoadBar.innerHTML = '';
    el.dRoadLegend.innerHTML = '';
    el.dWarn.hidden = true;
    drawRoute(null);
    return;
  }

  var secs = rideSeconds(route);
  el.dTime.textContent = fmtDur(secs);
  el.dDist.textContent = fmtDistShort(route.distance_m);
  el.dArrive.textContent = fmtClock(secs);

  renderRoads(route);

  if (route.segments || route.geometry) {
    renderSteps(route);
    drawRoute(route);
  } else {
    // Index-only so far: the road mix and times are real, the line is coming.
    el.dStepCount.textContent = '';
    el.dSteps.innerHTML = '<li><span class="step-main">Loading the route…</span></li>';
    drawRoute(null);
  }
}

function renderRoads(route) {
  var roads = route.roads || [];
  var total = roads.reduce(function (a, r) { return a + r.m; }, 0) || 1;
  var css = getComputedStyle(document.documentElement);
  el.dRoadBar.innerHTML = roads.map(function (r) {
    var c = css.getPropertyValue(RATE_COLORS[r.rating] || '--rate-ok').trim();
    return '<i style="width:' + (100 * r.m / total).toFixed(2) + '%;background:' + c + '"></i>';
  }).join('');
  el.dRoadBar.setAttribute('aria-label',
    'Road mix: ' + roads.map(function (r) { return r.label + ' ' + fmtDist(r.m); }).join(', '));

  el.dRoadLegend.innerHTML = roads.map(function (r) {
    var c = css.getPropertyValue(RATE_COLORS[r.rating] || '--rate-ok').trim();
    var lane = r.bike_lane_m ? ' <span class="muted">(bike lane)</span>' : '';
    return '<li><span class="dot" style="background:' + c + '"></span>' +
           '<span class="lg-name">' + escapeHtml(r.label) + lane + '</span>' +
           '<span class="lg-val">' + fmtDist(r.m) + ' · ' +
           Math.round(100 * r.m / total) + '%</span></li>';
  }).join('');

  // Call out high-speed road mileage explicitly — this is Florida.
  var rough = roads.filter(function (r) { return r.rating === 'avoid' || r.rating === 'busy'; });
  var roughM = rough.reduce(function (a, r) { return a + r.m; }, 0);
  var laneM = rough.reduce(function (a, r) { return a + (r.bike_lane_m || 0); }, 0);
  if (roughM > 150) {
    el.dWarn.hidden = false;
    el.dWarn.textContent = '⚠️ ' + fmtDist(roughM) + ' of this route is on ' +
      rough.map(function (r) { return r.label.toLowerCase(); }).join(' / ') +
      '. ' + (laneM >= roughM * 0.8
        ? 'There is a marked bike lane for most of it, but traffic moves fast — lights on, take the lane only when you must.'
        : laneM > 0
          ? 'Only about ' + fmtDist(laneM) + ' of that has a bike lane. Consider the quieter route.'
          : 'No bike lane mapped on that stretch. The quieter route is worth a look.');
  } else {
    el.dWarn.hidden = true;
  }
}

function renderSteps(route) {
  var steps = route.steps || [];
  el.dStepCount.textContent = steps.length ? '· ' + steps.length + ' steps' : '';
  el.dSteps.innerHTML = steps.map(function (s) {
    var paths = (STEP_ICONS[s.icon] || STEP_ICONS.straight).split('|');
    var svg = '<svg class="step-icon" viewBox="0 0 24 24" aria-hidden="true">' +
      paths.map(function (p) { return '<path d="' + p + '"/>'; }).join('') + '</svg>';
    var verb = stepText(s, true);
    return '<li>' + svg + '<span class="step-main">' +
           '<span class="step-verb">' + verb + '</span><br>' +
           '<span class="step-dist">' + (s.start ? 'Start' : fmtDist(s.from_prev_m)) +
           (s.at_m ? ' · ' + fmtDistShort(s.at_m) + ' in' : '') + '</span>' +
           '</span></li>';
  }).join('');
}

/* ----------------------------------------------------------- street names */

/* Street names for turns, for every route the app shows: baked, live
 * re-routes (BRouter returns no names) and the reversed route home. They come
 * from data/streets.json, the named roads along the district's routes
 * (tools/build_streets.py), so they work offline too.
 *
 * A turn is named after what the route rides on just past it: a named road
 * running the same way as the route, or, on a sidewalk or path, "the sidewalk
 * along <road>". A short path across a road is "the crosswalk across <road>". */
var STREETS = null;        // { names, cells: {"x,y": [[ax, ay, bx, by, nameIdx], ...]} }
var STREET_CELL = 0.002;   // ~200 m

function loadStreets() {
  return fetch('data/streets.json')
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (doc) {
      var cells = {};
      doc.ways.forEach(function (w) {
        var name = w[0], f = w[1], x = f[0], y = f[1];
        for (var i = 2; i < f.length; i += 2) {
          var nx = x + f[i], ny = y + f[i + 1];
          var seg = [x / 1e5, y / 1e5, nx / 1e5, ny / 1e5, name];
          var x0 = Math.floor(Math.min(seg[0], seg[2]) / STREET_CELL),
              x1 = Math.floor(Math.max(seg[0], seg[2]) / STREET_CELL),
              y0 = Math.floor(Math.min(seg[1], seg[3]) / STREET_CELL),
              y1 = Math.floor(Math.max(seg[1], seg[3]) / STREET_CELL);
          for (var cx = x0; cx <= x1; cx++) {
            for (var cy = y0; cy <= y1; cy++) {
              (cells[cx + ',' + cy] || (cells[cx + ',' + cy] = [])).push(seg);
            }
          }
          x = nx; y = ny;
        }
      });
      STREETS = { names: doc.names, cells: cells };
    })
    .catch(function (err) { console.warn('street names unavailable', err); });
}

/* Named roads near a point: [{name, distM, bearing}] with the road's bearing
 * at its closest point (0-180, since a road runs both ways). */
function streetsNear(lon, lat, maxM) {
  if (!STREETS) return [];
  var kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  var cx = Math.floor(lon / STREET_CELL), cy = Math.floor(lat / STREET_CELL);
  var best = {};
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      (STREETS.cells[(cx + dx) + ',' + (cy + dy)] || []).forEach(function (g) {
        var ax = (g[0] - lon) * kx, ay = (g[1] - lat) * ky;
        var bx = (g[2] - lon) * kx, by = (g[3] - lat) * ky;
        var vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
        var t = len2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / len2)) : 0;
        var d = Math.hypot(ax + t * vx, ay + t * vy);
        if (d > maxM) return;
        var name = STREETS.names[g[4]];
        if (!best[name] || d < best[name].distM) {
          var brg = (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 180;
          best[name] = { name: name, distM: d, bearing: brg };
        }
      });
    }
  }
  return Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (a, b) { return a.distM - b.distM; });
}

/* Angle between a route bearing (0-360) and a road bearing (0-180). */
function axisDiff(routeBrg, roadBrg) {
  var d = Math.abs(((routeBrg % 180) + 180) % 180 - roadBrg);
  return Math.min(d, 180 - d);
}

/* Geometry helper for one route: cumulative distance and point/bearing at a
 * distance along it, plus the way type (segment label) there. */
function routeTrack(route) {
  var g = route.geometry, cum = [0];
  for (var i = 1; i < g.length; i++) {
    cum.push(cum[i - 1] + metersBetween(g[i - 1][1], g[i - 1][0], g[i][1], g[i][0]));
  }
  var runs = [], at = 0;
  (route.segments || []).forEach(function (sg) {
    var len = 0;
    for (var j = 1; j < sg.coords.length; j++) {
      len += metersBetween(sg.coords[j - 1][1], sg.coords[j - 1][0], sg.coords[j][1], sg.coords[j][0]);
    }
    runs.push({ from: at, to: at + len, label: sg.label || '' });
    at += len;
  });
  function idxAt(m) {
    var lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { var mid = (lo + hi) >> 1; if (cum[mid] <= m) lo = mid; else hi = mid; }
    return lo;
  }
  return {
    total: cum[cum.length - 1],
    pointAt: function (m) {
      m = Math.max(0, Math.min(cum[cum.length - 1], m));
      var i = idxAt(m), seg = (cum[i + 1] - cum[i]) || 1, t = (m - cum[i]) / seg;
      var a = g[i], b = g[Math.min(i + 1, g.length - 1)];
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    },
    bearingAt: function (m) {
      var p = this.pointAt(m - 6), q = this.pointAt(m + 6);
      var kx = 111320 * Math.cos(p[1] * Math.PI / 180);
      return (Math.atan2((q[0] - p[0]) * kx, (q[1] - p[1]) * 110540) * 180 / Math.PI + 360) % 360;
    },
    runAt: function (m) {
      for (var k = 0; k < runs.length; k++) if (m >= runs[k].from && m < runs[k].to) return runs[k];
      return runs[runs.length - 1] || { from: 0, to: cum[cum.length - 1], label: '' };
    },
    // Where a point lies along the route, searching only from `fromM` on so a
    // route that passes the same corner twice is matched in order.
    locate: function (lon, lat, fromM) {
      var bestD = Infinity, bestM = fromM;
      var kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
      for (var i = Math.max(0, idxAt(fromM)); i < g.length - 1; i++) {
        if (cum[i] > fromM + 3000 && bestD < 30) break;
        var ax = (g[i][0] - lon) * kx, ay = (g[i][1] - lat) * ky;
        var bx = (g[i + 1][0] - lon) * kx, by = (g[i + 1][1] - lat) * ky;
        var vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
        var t = l2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / l2)) : 0;
        var d = Math.hypot(ax + t * vx, ay + t * vy);
        if (d < bestD - 0.5) { bestD = d; bestM = cum[i] + t * (cum[i + 1] - cum[i]); }
      }
      return bestM;
    }
  };
}

var OFFROAD = /sidewalk|path|pedestrian|track|steps/i;

/* What the route rides on from `m` metres on: a street name or a phrase like
 * "the sidewalk along US 192". `untilM` caps how far ahead to look. */
function describeAt(track, m, untilM) {
  var run = track.runAt(m + 1);
  var lookTo = Math.min(untilM, m + 45, track.total);
  var votes = {}, samples = 0;
  for (var d = m + 8; d <= lookTo; d += 9) {
    var p = track.pointAt(d), brg = track.bearingAt(d);
    samples++;
    streetsNear(p[0], p[1], OFFROAD.test(run.label) ? 5 : 14).forEach(function (c) {
      if (axisDiff(brg, c.bearing) < 28) votes[c.name] = (votes[c.name] || 0) + (14 - c.distM);
    });
  }
  if (!samples) {
    var p0 = track.pointAt(m + 4), b0 = track.bearingAt(m + 4);
    streetsNear(p0[0], p0[1], OFFROAD.test(run.label) ? 5 : 14).forEach(function (c) {
      if (axisDiff(b0, c.bearing) < 28) votes[c.name] = (votes[c.name] || 0) + (14 - c.distM);
    });
  }
  var top = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; })[0];
  if (top) return top;

  if (!OFFROAD.test(run.label) && !/service|parking/i.test(run.label)) return null;
  var mid = Math.min(run.to, m + 20), pm = track.pointAt(mid), bm = track.bearingAt(mid);
  var near = streetsNear(pm[0], pm[1], 40);
  // A short path across a road is a crosswalk.
  if (OFFROAD.test(run.label) && run.to - run.from < 40) {
    var across = near.filter(function (c) { return axisDiff(bm, c.bearing) > 55 && c.distM < 15; })[0];
    if (across) return 'the crosswalk across ' + across.name;
  }
  var along = near.filter(function (c) { return axisDiff(bm, c.bearing) < 25; })[0];
  var kind = /sidewalk/i.test(run.label) ? 'the sidewalk'
           : /bike path/i.test(run.label) ? 'the bike path'
           : /service|parking/i.test(run.label) ? 'the service road'
           : 'the path';
  // A service road's nearest parallel name is usually a neighbouring drive,
  // not the road it serves, so it is not named after one.
  return along && kind !== 'the service road' ? kind + ' along ' + along.name : kind;
}

/* Name every step of a route, once (and again if the street data arrives
 * later). Drops "continue straight" hints that do not change street, which
 * BRouter emits wherever a way is split, and phrases a fork that keeps to the
 * same road as "to stay on". */
function nameRoute(route) {
  if (!route || !route.geometry || route.geometry.length < 2 || !route.steps) return route;
  if (route.namedWith === !!STREETS) return route;
  if (!route.rawSteps) route.rawSteps = route.steps;
  var track = routeTrack(route);
  var raw = route.rawSteps, out = [], pos = 0, current = null;
  var compass = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

  var firstStreet = describeAt(track, 0, raw[0] ? Math.max(20, raw[0].at_m) : 60);
  current = firstStreet;
  var head = compass[Math.round(track.bearingAt(10) / 45) % 8];
  out.push({ verb: 'Head ' + head, icon: 'straight', street: firstStreet, along: true,
             at_m: 0, from_prev_m: 0, lat: route.geometry[0][1], lon: route.geometry[0][0],
             start: true });

  raw.forEach(function (st, i) {
    if (st.icon === 'arrive') { out.push(Object.assign({}, st)); return; }
    pos = track.locate(st.lon, st.lat, Math.max(0, pos - 5));
    var nextM = raw[i + 1] ? track.locate(raw[i + 1].lon, raw[i + 1].lat, pos) : track.total;
    // At a roundabout, name the road the route leaves on, not the ring.
    var from = st.icon === 'roundabout' ? Math.min(pos + 40, Math.max(pos, nextM - 10)) : pos;
    var name = STREETS ? describeAt(track, from, Math.max(from + 15, nextM)) : st.street;
    if (!name && st.street && !STREETS) name = st.street;
    var step = Object.assign({}, st, { street: name || null, stay: false });
    if (st.icon === 'roundabout' && /^Enter the roundabout/.test(st.verb)) step.verb = 'Go through the roundabout';
    if (name && name === current) {
      if (st.icon === 'straight') return;   // nothing changes here
      if (st.icon === 'roundabout' || /slight|keep/i.test(st.icon + st.verb)) step.stay = true;
    }
    if (st.icon === 'straight' && !name && !current) return;
    if (name) current = name;
    out.push(step);
  });

  // A turn followed within 15 m by "continue straight onto" a new name is a
  // short connector (Interior Street, 11 m): name the turn after where it leads.
  for (var c = 1; c < out.length - 1; c++) {
    if (out[c + 1].icon === 'straight' && out[c + 1].street &&
        out[c + 1].at_m - out[c].at_m < 15) {
      out[c] = Object.assign({}, out[c], { street: out[c + 1].street, stay: false });
      out.splice(c + 1, 1);
    }
  }

  // A "continue straight" right before another instruction adds nothing.
  out = out.filter(function (st, k) {
    var next = out[k + 1];
    return !(st.icon === 'straight' && !st.start && next && next.at_m - st.at_m < 30);
  });

  // "Bear left/right to stay on" in clusters is a sidewalk wiggling round a
  // pole or a kerb, not a decision: drop those, keep a lone same-road fork.
  out = out.filter(function (st, k) {
    if (!st.stay || st.icon === 'roundabout') return true;
    var prev = out[k - 1], next = out[k + 1];
    return !((prev && !prev.start && st.at_m - prev.at_m < 40) ||
             (next && next.icon !== 'arrive' && next.at_m - st.at_m < 40));
  });

  // A quick jog (an unnamed turn with another turn just after it) reads as one
  // instruction: "Turn left, then turn right onto Seven Dwarfs Lane".
  for (var j = 1; j < out.length - 1; j++) {
    var a = out[j], b = out[j + 1];
    if (b.icon === 'arrive' || a.icon === 'straight' || b.icon === 'straight') continue;
    var gap = b.at_m - a.at_m;
    var unnamed = !a.street || a.street === 'the service road';
    if (!(gap <= 20 || (unnamed && gap <= 30))) continue;
    out.splice(j, 2, Object.assign({}, a, {
      verb: (unnamed ? a.verb : stepText(a, false)) + ', then ' +
            b.verb.charAt(0).toLowerCase() + b.verb.slice(1),
      street: b.street, stay: b.stay
    }));
  }

  // Re-measure the gaps after dropping steps.
  for (var k = 1; k < out.length; k++) out[k].from_prev_m = Math.max(0, out[k].at_m - out[k - 1].at_m);
  if (out.length > 1 && out[1].at_m < 15) out.shift();   // first turn is right at the start
  route.steps = out;
  route.namedWith = !!STREETS;
  return route;
}

/* "Turn left onto Blake Boulevard", "Bear right to stay on US 192", "Head
 * east on Club Cortile Circle". html escapes and bolds the street. */
function stepText(s, html) {
  var street = s.street ? (html ? '<b>' + escapeHtml(s.street) + '</b>' : s.street) : '';
  var verb = html ? escapeHtml(s.verb) : s.verb;
  if (!street || s.icon === 'arrive') return verb;
  if (s.start || s.along) return verb + ' on ' + street;
  if (s.stay) return verb + ' to stay on ' + street;
  return verb + ' onto ' + street;
}

/* ------------------------------------------------------------ live routing */

/* Upload a profile to BRouter and keep the id. Cached in localStorage so this
 * costs one request per browser, not one per re-route. */
function brouterProfileId(profile) {
  var cacheKey = 'pbc.profile.' + profile;
  var cached = null;
  try { cached = localStorage.getItem(cacheKey); } catch (e) { /* private mode */ }
  if (cached) return Promise.resolve(cached);

  return fetch(PROFILE_FILES[profile])
    .then(function (r) { if (!r.ok) throw new Error('profile ' + r.status); return r.text(); })
    .then(function (body) {
      return fetch(BROUTER + '/profile', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body
      });
    })
    .then(function (r) { if (!r.ok) throw new Error('upload ' + r.status); return r.json(); })
    .then(function (doc) {
      if (!doc.profileid) throw new Error('no profile id');
      try { localStorage.setItem(cacheKey, doc.profileid); } catch (e) { /* ignore */ }
      return doc.profileid;
    })
    .catch(function (err) {
      // Stock profile is worse here, but a working route beats no route.
      console.warn('custom profile unavailable, falling back', err);
      return PROFILE_FALLBACK[profile] || 'trekking';
    });
}

/* One BRouter request between two points, parsed into our route shape.
 * destName names the destination in the final "Arrive at …" step. */
function brouterRoute(from, to, profile, destName) {
  return brouterProfileId(profile).then(function (pid) {
    var url = BROUTER + '?lonlats=' + from.lon + ',' + from.lat + '|' + to.lon + ',' + to.lat +
              '&profile=' + pid + '&alternativeidx=0&format=geojson&timode=2';
    return fetch(url);
  })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (doc) { return parseBrouter(doc, { name: destName }); });
}

function fetchLiveRoute(store, profile, fromLat, fromLon) {
  var from = (fromLat != null) ? { lat: fromLat, lon: fromLon } : S.start;
  return brouterRoute(from, store, profile, store.name)
    .then(function (route) {
      S.liveRoute = { key: storeKey(store), route: route };
      if (S.selected && storeKey(S.selected) === storeKey(store) && S.trip === 'out') {
        renderDetail(store, route);
        renderList();
      }
      return route;
    })
    .catch(function (err) {
      toast('Could not reach the routing service — ' +
            (navigator.onLine ? 'try again' : 'you appear to be offline') + '.');
      if (S.selected && storeKey(S.selected) === storeKey(store) && S.trip === 'out') {
        el.dSteps.innerHTML = '<li><span class="step-main">No route available offline. ' +
          'Tap Google Maps, or connect and retry.</span></li>';
        el.dTime.textContent = '—'; el.dDist.textContent = '—'; el.dArrive.textContent = '—';
      }
      console.warn('live route failed', err);
      return null;
    });
}

/* ------------------------------------------------------------- trip home */

/* The route the rider is on right now: home → store by default, or store →
 * home after "Go Home". */
function activeRoute() {
  if (!S.selected) return null;
  if (S.trip === 'home') return S.homeRoute ? nameRoute(S.homeRoute.route) : null;
  return routeFor(S.selected, S.profile);
}

/* Plan the ride home. Normally a fresh BRouter route from the store (or from
 * the rider, when re-routing), since one-way streets and turn restrictions
 * make the trip home more than the trip out run backwards. With no signal,
 * fall back to exactly that: the baked route reversed. */
function planHome(store, fromLat, fromLon) {
  var from = fromLat != null ? { lat: fromLat, lon: fromLon } : store;
  return brouterRoute(from, S.start, S.profile, 'home')
    .catch(function (err) {
      console.warn('live route home failed', err);
      if (fromLat != null) return null;     // a re-route; keep the current line
      return loadDetail(store).then(function () {
        var r = routeFor(store, S.profile);
        if (!r || !r.geometry) return null;
        toast('Offline — using your route here in reverse. Watch for one-way streets.');
        return reverseRoute(r);
      });
    });
}

function goHome() {
  var store = S.selected;
  if (!store) return;
  if (S.navigating) stopNav();
  el.btnHome.disabled = true;
  toast('Planning your route home…');
  planHome(store).then(function (route) {
    el.btnHome.disabled = false;
    if (S.selected !== store) return;
    if (!route) { toast('Could not plan a route home. Try Google Maps.'); return; }
    S.trip = 'home';
    S.homeRoute = { key: storeKey(store), profile: S.profile, route: route };
    renderSelected();
    startNav();
  });
}

/* Back to the default direction, home → store. */
function endTripHome() {
  if (S.trip !== 'home') return;
  S.trip = 'out';
  S.homeRoute = null;
  renderSelected();
}

/* The saved route ridden backwards, for when there is no signal. Each turn
 * happens at the same spot but mirrored, and it leads onto the street the
 * trip out came from. */
function reverseRoute(r) {
  var MIRROR = { left: 'right', right: 'left', 'slight-left': 'slight-right',
                 'slight-right': 'slight-left', 'sharp-left': 'sharp-right',
                 'sharp-right': 'sharp-left' };
  var total = r.distance_m;
  var fwd = (r.rawSteps || r.steps || []).filter(function (st) { return st.icon !== 'arrive'; });
  var steps = [], prev = 0;
  for (var i = fwd.length - 1; i >= 0; i--) {
    var st = fwd[i], at = Math.max(0, Math.round(total - st.at_m));
    var verb = st.verb.replace(/\b(left|right)\b/g, function (w) {
      return w === 'left' ? 'right' : 'left';
    });
    steps.push({ verb: verb, icon: MIRROR[st.icon] || st.icon,
                 street: i > 0 ? fwd[i - 1].street : null,
                 at_m: at, from_prev_m: at - prev, lat: st.lat, lon: st.lon });
    prev = at;
  }
  steps.push({ verb: 'Arrive at home', icon: 'arrive', street: null, at_m: total,
               from_prev_m: total - prev, lat: S.start.lat, lon: S.start.lon });
  var rev = {
    profile: r.profile, distance_m: total, duration_s: r.duration_s,
    ascend_m: r.ascend_m, implied_kmh: r.implied_kmh, roads: r.roads, steps: steps,
    geometry: r.geometry.slice().reverse(),
    segments: (r.segments || []).slice().reverse().map(function (sg) {
      return { rating: sg.rating, label: sg.label, coords: sg.coords.slice().reverse() };
    }),
    reversed: true
  };
  return nameRoute(rev);
}

/* Re-draw the detail panel for whichever trip is active. */
function renderSelected() {
  if (!S.selected) return;
  var route = activeRoute();
  if (route) renderDetail(S.selected, route);
  if (S.trip === 'home') {
    el.dStore.textContent = 'Home from ' + el.dStore.textContent;
    el.dAddr.textContent = 'To ' + S.start.name;
  }
}

/* Turn a BRouter geojson response into the same shape as our baked routes. */
function parseBrouter(doc, store) {
  var f = doc.features[0], p = f.properties;
  var coords = f.geometry.coordinates.map(function (c) { return [c[0], c[1]]; });
  var dist = parseInt(p['track-length'], 10);
  var dur = parseInt(p['total-time'], 10);

  var cum = [0];
  for (var i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + metersBetween(coords[i - 1][1], coords[i - 1][0],
                                        coords[i][1], coords[i][0]));
  }

  var VERB = {
    1: ['Continue straight', 'straight'], 2: ['Turn left', 'left'],
    3: ['Bear left', 'slight-left'], 4: ['Sharp left', 'sharp-left'],
    5: ['Turn right', 'right'], 6: ['Bear right', 'slight-right'],
    7: ['Sharp right', 'sharp-right'], 8: ['Keep left', 'slight-left'],
    9: ['Keep right', 'slight-right'], 10: ['Make a U-turn', 'uturn'],
    11: ['Make a U-turn', 'uturn'], 12: ['Leave the route', 'straight'],
    13: ['Enter the roundabout', 'roundabout'], 14: ['Enter the roundabout', 'roundabout'],
    15: ['Head toward the destination', 'straight']
  };
  var steps = [], prev = 0;
  (p.voicehints || []).forEach(function (h) {
    var idx = h[0] | 0, v = VERB[h[1] | 0] || VERB[1];
    if (idx >= coords.length) return;
    steps.push({ verb: v[0], icon: v[1], street: null, at_m: Math.round(cum[idx]),
                 from_prev_m: Math.round(cum[idx] - prev),
                 lat: coords[idx][1], lon: coords[idx][0] });
    prev = cum[idx];
  });
  steps.push({ verb: 'Arrive at ' + (store.name || 'the store'), icon: 'arrive',
               street: null, at_m: Math.round(cum[cum.length - 1]),
               from_prev_m: Math.round(cum[cum.length - 1] - prev),
               lat: coords[coords.length - 1][1], lon: coords[coords.length - 1][0] });

  var CLASS = {
    cycleway: ['Bike path', 'great'], path: ['Path', 'great'],
    footway: ['Sidewalk', 'good'], pedestrian: ['Pedestrian street', 'good'],
    track: ['Track', 'good'], living_street: ['Living street', 'great'],
    residential: ['Residential street', 'great'],
    service: ['Service road / parking aisle', 'good'],
    unclassified: ['Minor road', 'good'], tertiary: ['Tertiary road', 'ok'],
    tertiary_link: ['Tertiary road', 'ok'], secondary: ['Secondary road', 'busy'],
    secondary_link: ['Secondary road', 'busy'], primary: ['Major arterial', 'busy'],
    primary_link: ['Major arterial', 'busy'], trunk: ['Highway (trunk)', 'avoid'],
    trunk_link: ['Highway ramp', 'avoid'], motorway: ['Interstate', 'avoid'],
    motorway_link: ['Interstate ramp', 'avoid'], steps: ['Steps', 'ok']
  };

  // Road mix, from the same per-segment way tags the build script uses.
  var roads = [];
  var msgs = p.messages || [];
  if (msgs.length > 1) {
    var hdr = msgs[0], iD = hdr.indexOf('Distance'), iT = hdr.indexOf('WayTags');
    var acc = {};
    msgs.slice(1).forEach(function (row) {
      var tags = {};
      String(row[iT] || '').split(' ').forEach(function (kv) {
        var j = kv.indexOf('=');
        if (j > 0) tags[kv.slice(0, j)] = kv.slice(j + 1);
      });
      var hw = tags.highway || 'unknown';
      var c = CLASS[hw] || [hw.replace(/_/g, ' '), 'ok'];
      var e = acc[c[0]] || (acc[c[0]] = { label: c[0], rating: c[1], m: 0 });
      e.m += parseInt(row[iD], 10) || 0;
      if (/(lane|track)$/.test(tags.cycleway || '')) {
        e.bike_lane_m = (e.bike_lane_m || 0) + (parseInt(row[iD], 10) || 0);
      }
    });
    roads = Object.keys(acc).map(function (k) { return acc[k]; })
                  .sort(function (a, b) { return b.m - a.m; });
  }

  // Runs for the live case: group consecutive way segments by rating.
  var segments = [];
  if (msgs.length > 1) {
    var hL = msgs[0].indexOf('Longitude'), hA = msgs[0].indexOf('Latitude');
    var hT = msgs[0].indexOf('WayTags'), pos = 0;
    msgs.slice(1).forEach(function (row) {
      var lon = parseInt(row[hL], 10) / 1e6, lat = parseInt(row[hA], 10) / 1e6;
      var end = -1;
      for (var j = pos + 1; j < Math.min(pos + 400, coords.length); j++) {
        if (Math.abs(coords[j][0] - lon) < 2e-6 && Math.abs(coords[j][1] - lat) < 2e-6) {
          end = j; break;
        }
      }
      if (end < 0) return;
      var tg = {};
      String(row[hT] || '').split(' ').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) tg[kv.slice(0, i)] = kv.slice(i + 1);
      });
      var cl = CLASS[tg.highway] || ['Road', 'ok'];
      var last = segments[segments.length - 1];
      if (last && last.rating === cl[1]) last.end = end;
      else segments.push({ rating: cl[1], label: cl[0], start: pos, end: end });
      pos = end;
    });
    segments = segments.map(function (s) {
      return { rating: s.rating, label: s.label, coords: coords.slice(s.start, s.end + 1) };
    }).filter(function (s) { return s.coords.length > 1; });
  }
  if (!segments.length) segments = [{ rating: 'ok', label: 'Route', coords: coords }];

  return nameRoute({
    profile: 'live', distance_m: dist, duration_s: dur,
    ascend_m: parseInt(p['filtered ascend'] || 0, 10),
    implied_kmh: dur ? Math.round(dist / 1000 / (dur / 3600) * 10) / 10 : 19,
    roads: roads, steps: steps, segments: segments, geometry: coords
  });
}

/* --------------------------------------------------------- Google Maps out */

/* Hand the trip to Google Maps as one continuous ride. Google treats every
 * entry in a waypoints list as a stop: it ends guidance at each one and waits
 * for "Next", and its URL scheme has no pass-through points. So send only the
 * destination, from wherever the phone is now, and start turn-by-turn right
 * away. Google then plans its own bike route, which may differ from ours. */
function openInGoogleMaps(dest) {
  var url = 'https://www.google.com/maps/dir/?api=1&travelmode=bicycling' +
            '&dir_action=navigate&destination=' + dest.lat + ',' + dest.lon;
  if (isNativeApp()) {
    // Inside the Android app, a navigation to another site is handed to
    // Android, which opens the Google Maps app. window.open is not reliable
    // in a WebView, so navigate instead; the app page itself stays put.
    window.location.href = url;
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/* True inside the Android app built from apk/ (Capacitor injects this). */
function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform &&
            window.Capacitor.isNativePlatform());
}

/* ------------------------------------------------------------ keep awake */

/* Keep the screen on while navigating, as Google Maps does. In the Android
 * app this is the KeepAwake plugin in apk/ (the WebView has no Wake Lock API);
 * on the website it is the Screen Wake Lock API, which the browser drops
 * whenever the page is hidden, so it is re-requested when the page returns. */
var keepAwakePlugin = null, wakeSentinel = null;

function keepAwake(on) {
  if (isNativeApp() && window.Capacitor.registerPlugin) {
    try {
      if (!keepAwakePlugin) keepAwakePlugin = window.Capacitor.registerPlugin('KeepAwake');
      (on ? keepAwakePlugin.keepAwake() : keepAwakePlugin.allowSleep())
        .catch(function () { webWakeLock(on); });   // an APK built before the plugin
      return;
    } catch (e) { /* fall through to the web API */ }
  }
  webWakeLock(on);
}

function webWakeLock(on) {
  if (!on) {
    if (wakeSentinel) { wakeSentinel.release().catch(function () {}); wakeSentinel = null; }
    return;
  }
  if (!navigator.wakeLock || wakeSentinel) return;
  navigator.wakeLock.request('screen').then(function (sentinel) {
    wakeSentinel = sentinel;
    sentinel.addEventListener('release', function () {
      if (wakeSentinel === sentinel) wakeSentinel = null;
    });
  }).catch(function () { /* not allowed right now (e.g. battery saver) */ });
}

/* ------------------------------------------------------- heading-up map */

/* While navigating, the map turns so the direction of travel points up, like
 * Google Maps. Leaflet cannot rotate, so the map element itself is rotated:
 * it is made a square big enough to cover the screen at any angle, centred on
 * the spot where the rider's dot should sit (in the lower part of the open
 * map, so more of the road ahead is visible), and the map is kept centred on
 * the rider. Labels on the pins are turned back so they stay upright. */
var R = {
  on: false,
  shown: 0,          // rotation applied, unwrapped so it always turns the short way
  heading: null,     // degrees clockwise from north, null until known
  lastFix: null,     // last position used to derive a heading from movement
  layoutKey: ''
};

function enableRotation() {
  if (R.on) return;
  R.on = true;
  el.map.classList.add('is-rotated');
  el.rotAttr.hidden = false;
  // Dragging a rotated map moves it the wrong way, and zooming should keep the
  // rider in place, so: no panning, and zoom about the centre (the rider).
  map.dragging.disable();
  map.options.touchZoom = map.options.scrollWheelZoom = map.options.doubleClickZoom = 'center';
  layoutRotatedMap();
  applyRotation();
}

function disableRotation() {
  if (!R.on) return;
  R.on = false;
  var c = map.getCenter(), z = map.getZoom();
  el.map.classList.remove('is-rotated');
  el.map.style.cssText = '';
  el.rotAttr.hidden = true;
  R.layoutKey = '';
  map.dragging.enable();
  map.options.touchZoom = map.options.scrollWheelZoom = map.options.doubleClickZoom = true;
  map.invalidateSize({ pan: false });
  map.setView(c, z, { animate: false });
  syncCompass();
}

/* Where on screen the rider's dot sits: centred across, about two thirds of
 * the way down the strip of map between the banner and the panel. */
function rotationAnchor() {
  var wide = window.innerWidth >= 760;
  var top = topPx(), bottom = window.innerHeight - sheetPx();
  var w = wide ? window.innerWidth - 416 : window.innerWidth;
  return { x: w / 2, y: top + (bottom - top) * 0.66 };
}

function layoutRotatedMap() {
  if (!R.on) return;
  var a = rotationAnchor(), W = window.innerWidth, H = window.innerHeight;
  var r = Math.ceil(Math.max(Math.hypot(a.x, a.y), Math.hypot(W - a.x, a.y),
                             Math.hypot(a.x, H - a.y), Math.hypot(W - a.x, H - a.y))) + 4;
  var key = [Math.round(a.x), Math.round(a.y), r].join(',');
  if (key === R.layoutKey) return;
  R.layoutKey = key;
  var c = map.getCenter();
  el.map.style.left = (a.x - r) + 'px';
  el.map.style.top = (a.y - r) + 'px';
  el.map.style.width = el.map.style.height = (2 * r) + 'px';
  map.invalidateSize({ pan: false });
  map.setView(S.me ? [S.me.lat, S.me.lon] : c, map.getZoom(), { animate: false });
}

function applyRotation() {
  var target = R.on && R.heading != null ? R.heading : 0;
  var diff = ((target - R.shown) % 360 + 540) % 360 - 180;
  // Ignore jitter of a couple of degrees so the map is not constantly nudging.
  if (Math.abs(diff) >= 3 || target === 0) R.shown += diff;
  var rot = R.on ? R.shown : 0;
  el.map.style.transform = R.on ? 'rotate(' + (-rot) + 'deg)' : '';
  document.documentElement.style.setProperty('--map-unrot', rot + 'deg');
  syncCompass();
}

/* Compass button: the needle always points to north on screen; tapping it
 * switches between heading-up and north-up. */
function syncCompass() {
  if (!el.btnCompass) return;
  var rot = R.on ? R.shown : 0;
  el.btnCompass.querySelector('svg').style.transform = 'rotate(' + (-rot) + 'deg)';
  el.btnCompass.classList.toggle('is-on', S.headingUp);
  el.btnCompass.title = S.headingUp
    ? 'Heading up — tap for north up'
    : 'North up — tap to turn the map with you';
  el.btnCompass.setAttribute('aria-label', el.btnCompass.title);
}

function toggleHeadingUp() {
  S.headingUp = !S.headingUp;
  try { localStorage.setItem('pbc.headingUp', S.headingUp ? '1' : '0'); } catch (e) { /* ignore */ }
  if (S.navigating && S.headingUp) enableRotation();
  else disableRotation();
  if (S.navigating && S.me) map.setView([S.me.lat, S.me.lon], map.getZoom(), { animate: false });
  syncCompass();
}

/* Direction of travel. The GPS course is best while moving; below walking
 * pace it is noise, so fall back to the bearing between fixes at least 10 m
 * apart, and before the first move use the route's direction just ahead.
 * Stopped at a light, the last heading is kept rather than spinning. */
function updateHeading(pos, route, proj) {
  var c = pos.coords, h = null;
  if (c.heading != null && isFinite(c.heading) && (c.speed || 0) > 1.5) {
    h = c.heading;
  } else if (R.lastFix && fixDist(R.lastFix, S.me) > 10 && (S.me.accuracy || 0) < 25) {
    h = fixBearing(R.lastFix, S.me);
  } else if (R.heading == null && route.geometry && proj.offRouteM < 40) {
    h = routeBearingAt(route.geometry, proj.alongM);
  }
  if (!R.lastFix || fixDist(R.lastFix, S.me) > 10) R.lastFix = { lat: S.me.lat, lon: S.me.lon };
  if (h == null) return;
  R.heading = (h + 360) % 360;
  var me = meMarker && meMarker.getElement();
  if (me) {
    me.classList.add('has-heading');
    me.querySelector('.me-head').style.transform = 'rotate(' + R.heading + 'deg)';
  }
  applyRotation();
}

function fixDist(a, b) {
  var kx = 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540);
}

function fixBearing(a, b) {
  var kx = 111320 * Math.cos(a.lat * Math.PI / 180);
  return Math.atan2((b.lon - a.lon) * kx, (b.lat - a.lat) * 110540) * 180 / Math.PI;
}

/* Bearing of the route from the point alongM metres in to 25 m further on,
 * measured the same way projectOnRoute measures distance along it. */
function routeBearingAt(coords, alongM) {
  function pointAt(m) {
    var along = 0;
    for (var i = 0; i < coords.length - 1; i++) {
      var a = { lat: coords[i][1], lon: coords[i][0] };
      var b = { lat: coords[i + 1][1], lon: coords[i + 1][0] };
      var len = fixDist(a, b);
      if (along + len >= m && len > 0) {
        var t = (m - along) / len;
        return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
      }
      along += len;
    }
    var l = coords[coords.length - 1];
    return { lat: l[1], lon: l[0] };
  }
  var p = pointAt(Math.max(0, alongM)), q = pointAt(alongM + 25);
  return fixDist(p, q) < 1 ? null : fixBearing(p, q);
}

/* ------------------------------------------------------------- navigation */

function startNav() {
  if (!S.selected) return;
  if (!navigator.geolocation) { toast('This device has no location support.'); return; }
  S.navigating = true;
  el.navBanner.hidden = false;
  el.sheet.classList.add('has-nav');
  setSheet('peek');
  el.navVerb.textContent = 'Getting your location…';
  el.navDist.textContent = '—';
  el.btnCompass.hidden = false;
  R.heading = null; R.lastFix = null;
  keepAwake(true);
  if (S.headingUp) enableRotation();
  syncCompass();

  S.watchId = navigator.geolocation.watchPosition(onPosition, function (err) {
    toast(err.code === 1
      ? 'Location permission denied — allow it to navigate.'
      : 'Waiting for a GPS fix…');
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
}

function stopNav() {
  S.navigating = false;
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
  keepAwake(false);
  disableRotation();
  el.btnCompass.hidden = true;
  if (meMarker) meMarker.getElement().classList.remove('has-heading');
  el.navBanner.hidden = true;
  el.sheet.classList.remove('has-nav');
  setSheet('half');
  if (S.trip === 'home') {
    endTripHome();          // back to the default, home → store
  } else {
    var r = S.selected && routeFor(S.selected, S.profile);
    if (r) drawRoute(r);
  }
}

var lastReroute = 0;

function onPosition(pos) {
  S.me = { lat: pos.coords.latitude, lon: pos.coords.longitude,
           accuracy: pos.coords.accuracy };
  showMe();
  if (!S.navigating || !S.selected) return;

  var route = activeRoute();
  if (!route || !route.geometry) return;

  var proj = projectOnRoute(route.geometry, S.me.lat, S.me.lon);
  updateHeading(pos, route, proj);
  map.setView([S.me.lat, S.me.lon], Math.max(map.getZoom(), 16), { animate: true });

  // Drifted off the line for real? Ask BRouter for a fresh route from here.
  if (proj.offRouteM > OFF_ROUTE_M + (S.me.accuracy || 0) &&
      Date.now() - lastReroute > 20000) {
    lastReroute = Date.now();
    el.navVerb.textContent = 'Off route — recalculating…';
    if (S.trip === 'home') {
      planHome(S.selected, S.me.lat, S.me.lon).then(function (r) {
        if (!r || S.trip !== 'home') return;
        S.homeRoute.route = r;
        renderSelected();
        toast('Route updated from your position.');
      });
    } else {
      fetchLiveRoute(S.selected, S.profile, S.me.lat, S.me.lon).then(function (r) {
        if (r) { drawRoute(r); toast('Route updated from your position.'); }
      });
    }
    return;
  }

  var next = null;
  for (var i = 0; i < route.steps.length; i++) {
    if (!route.steps[i].start && route.steps[i].at_m > proj.alongM + 8) { next = route.steps[i]; break; }
  }
  if (!next) next = route.steps[route.steps.length - 1];

  var toTurn = Math.max(0, next.at_m - proj.alongM);
  el.navDist.textContent = fmtDist(toTurn);
  el.navVerb.textContent = stepText(next, false);
  var paths = (STEP_ICONS[next.icon] || STEP_ICONS.straight).split('|');
  el.navIcon.innerHTML = paths.map(function (p) { return '<path d="' + p + '"/>'; }).join('');

  // Remaining distance as a share of the route's own stated distance, not a
  // re-measurement of the simplified drawn line: at the start the banner then
  // shows exactly the distance and time the detail view promised.
  var share = proj.totalM ? Math.min(1, Math.max(0, 1 - proj.alongM / proj.totalM)) : 1;
  var remainM = route.distance_m * share;
  var remainS = secondsFor(remainM);
  el.navRemaining.textContent = fmtDistShort(remainM) + ' left · ' +
    fmtDur(remainS) + ' · arrive ' + fmtClock(remainS);

  if (remainM < 40) {
    el.navDist.textContent = 'Arrived';
    el.navVerb.textContent = S.trip === 'home' ? 'Home' : S.selected.name;
  }
}

function showMe() {
  if (!S.me) return;
  if (!meMarker) {
    meMarker = L.marker([S.me.lat, S.me.lon], {
      icon: L.divIcon({ className: 'me-wrap',
                        html: '<div class="me-head"></div><div class="me-dot"></div>',
                        iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 1000, interactive: false
    }).addTo(map);
  } else {
    meMarker.setLatLng([S.me.lat, S.me.lon]);
  }
}

function locateOnce() {
  if (!navigator.geolocation) { toast('This device has no location support.'); return; }
  el.btnLocate.classList.add('is-on');
  navigator.geolocation.getCurrentPosition(function (pos) {
    S.me = { lat: pos.coords.latitude, lon: pos.coords.longitude,
             accuracy: pos.coords.accuracy };
    showMe();
    map.setView([S.me.lat, S.me.lon], 15);
    el.btnLocate.classList.remove('is-on');
  }, function (err) {
    el.btnLocate.classList.remove('is-on');
    toast(err.code === 1 ? 'Location permission denied.' : 'Could not get a GPS fix.');
  }, { enableHighAccuracy: true, timeout: 15000 });
}

/* ------------------------------------------------------------------- sheet */

function setSheet(state) {
  S.sheet = state;
  el.sheet.classList.remove('sheet-peek', 'sheet-half', 'sheet-full');
  el.sheet.classList.add('sheet-' + state);
  requestAnimationFrame(function () {
    var h = sheetPx();
    document.documentElement.style.setProperty('--sheet-h', h + 'px');
    layoutRotatedMap();
  });
}

function cycleSheet() {
  setSheet(S.sheet === 'peek' ? 'half' : S.sheet === 'half' ? 'full' : 'peek');
}

function wireSheetDrag() {
  var startY = null, startH = 0, pid = null;
  function heightFor(y) {
    return Math.min(window.innerHeight - 100, Math.max(90, startH - (y - startY)));
  }
  function finish(e, cancelled) {
    if (startY == null || (pid != null && e.pointerId !== pid)) return;
    var moved = cancelled ? 0 : Math.abs(e.clientY - startY);
    var h = sheetPx();
    startY = null; pid = null;
    el.sheet.style.transition = '';
    el.sheet.style.height = '';
    if (cancelled) {
      // Snap to the nearest stop rather than leaving the sheet stuck mid-drag.
      var vh0 = window.innerHeight;
      setSheet(h < vh0 * 0.28 ? 'peek' : h < vh0 * 0.66 ? 'half' : 'full');
      return;
    }
    if (moved < 6) { cycleSheet(); return; }
    var vh = window.innerHeight;
    setSheet(h < vh * 0.28 ? 'peek' : h < vh * 0.66 ? 'half' : 'full');
  }
  el.grab.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    startY = e.clientY; startH = sheetPx(); pid = e.pointerId;
    el.sheet.style.transition = 'none';
    try { el.grab.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  el.grab.addEventListener('pointermove', function (e) {
    if (startY == null || e.pointerId !== pid) return;
    e.preventDefault();
    var h = heightFor(e.clientY);
    el.sheet.style.height = h + 'px';
    document.documentElement.style.setProperty('--sheet-h', h + 'px');
  });
  el.grab.addEventListener('pointerup', function (e) { finish(e, false); });
  el.grab.addEventListener('pointercancel', function (e) { finish(e, true); });
  el.grab.addEventListener('lostpointercapture', function (e) { finish(e, true); });
  // Taps are handled above; a keyboard press (click with detail 0) toggles here.
  el.grab.addEventListener('click', function (e) { if (e.detail === 0) cycleSheet(); });
}

/* ------------------------------------------------------------------ toast */

var toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.toast.hidden = true; }, 4200);
}

/* ------------------------------------------------------------------- wire */

function wire() {
  el.btnUnits.addEventListener('click', function () {
    S.imperial = !S.imperial;
    el.btnUnits.textContent = S.imperial ? 'mi' : 'km';
    localStorage.setItem('pbc.imperial', S.imperial ? '1' : '0');
    syncPaceControl();       // re-snap to the nearest step in the new units
    refresh();
  });

  el.pace.addEventListener('input', function () {
    S.paceKmh = (+el.pace.value) * paceUnits().toKmh;
    syncPaceControl();
    refresh();
  });

  el.search.addEventListener('input', function () {
    if (!el.listView.hidden) filterList(el.search.value);
    else { showList(); filterList(el.search.value); }
  });

  el.btnLocate.addEventListener('click', locateOnce);
  el.btnFit.addEventListener('click', fitAll);
  el.btnLayer.addEventListener('click', function () {
    S.showFar = !S.showFar;
    el.btnLayer.classList.toggle('is-on', S.showFar);
    drawMarkers();
    renderList();
    toast(S.showFar ? 'Showing every store in range.' : 'Showing the nearest stores.');
  });

  el.btnBack.addEventListener('click', showList);

  [].forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
    b.addEventListener('click', function () {
      [].forEach.call(document.querySelectorAll('.seg-btn'), function (x) {
        x.classList.toggle('is-on', x === b);
      });
      S.profile = b.dataset.profile;
      S.liveRoute = null;
      localStorage.setItem('pbc.profile', S.profile);
      if (S.selected) selectStore(S.selected, false);
      renderList();
    });
  });

  el.btnNav.addEventListener('click', function () {
    if (S.navigating) { stopNav(); return; }
    startNav();
  });
  el.btnHome.addEventListener('click', goHome);
  el.btnStopNav.addEventListener('click', stopNav);
  el.btnCompass.addEventListener('click', toggleHeadingUp);
  el.sheet.addEventListener('transitionend', layoutRotatedMap);
  window.addEventListener('resize', function () { layoutRotatedMap(); });
  document.addEventListener('visibilitychange', function () {
    if (S.navigating && document.visibilityState === 'visible') keepAwake(true);
  });
  el.btnGmaps.addEventListener('click', function () {
    if (S.selected) openInGoogleMaps(S.trip === 'home' ? S.start : S.selected);
  });

  wireSheetDrag();
  window.addEventListener('resize', function () { setSheet(S.sheet); });
}

function showList() {
  if (S.trip === 'home') {
    if (S.navigating) stopNav();
    endTripHome();
  }
  el.detailView.hidden = true;
  el.listView.hidden = false;
  S.selected = null;
  drawRoute(null);
  highlightMarker();
  renderList();
}

function refresh() {
  renderList();
  if (S.selected) renderSelected();
}

/* -------------------------------------------------------------------- boot */

function boot(storesDoc, indexDoc) {
  S.stores = storesDoc.stores;
  S.start = storesDoc.start;
  S.routes = indexDoc.routes;

  S.imperial = localStorage.getItem('pbc.imperial') !== '0';
  var savedPace = parseFloat(localStorage.getItem('pbc.pace'));
  if (isFinite(savedPace) && savedPace > 0) S.paceKmh = savedPace;
  S.profile = localStorage.getItem('pbc.profile') || 'balanced';
  S.headingUp = localStorage.getItem('pbc.headingUp') !== '0';

  ['map', 'search', 'btnUnits', 'btnLocate', 'btnFit', 'btnLayer', 'sheet', 'grab',
   'listView', 'detailView', 'listCount', 'storeList', 'pace', 'paceOut', 'btnBack',
   'dStore', 'dAddr', 'dTime', 'dTimeLbl', 'dDist', 'dArrive', 'dRoadBar', 'dRoadLegend', 'dWarn',
   'dSteps', 'dStepCount', 'dHours', 'btnNav', 'btnGmaps', 'btnCall', 'navBanner',
   'navIcon', 'navDist', 'navVerb', 'navRemaining', 'btnStopNav', 'toast', 'startLabel',
   'btnCompass', 'rotAttr', 'btnHome'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  el.startLabel.textContent = 'from ' + S.start.name;
  el.btnUnits.textContent = S.imperial ? 'mi' : 'km';
  syncPaceControl();
  [].forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
    b.classList.toggle('is-on', b.dataset.profile === S.profile);
  });

  initMap();
  wire();
  // Street names for turns; re-render once they arrive (the app works without).
  loadStreets().then(refresh);
  renderList();
  setSheet('half');

  // The Android app ships every file inside the APK, so a service worker adds
  // nothing there, and its cache could keep serving an old app.js after the
  // APK is updated. Only the website registers one.
  if ('serviceWorker' in navigator && !isNativeApp()) {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('service worker registration failed', e);
    });
  }
}

Promise.all([
  fetch('data/stores.json').then(function (r) { return r.json(); }),
  fetch('data/routes-index.json').then(function (r) { return r.json(); })
]).then(function (res) { boot(res[0], res[1]); })
  .catch(function (err) {
    document.body.insertAdjacentHTML('afterbegin',
      '<p style="padding:20px;font:15px system-ui">Could not load store data. ' +
      'If you opened this file directly, serve the folder over HTTP instead ' +
      '(<code>python3 -m http.server</code>).</p>');
    console.error(err);
  });
