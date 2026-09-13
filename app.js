/* Publix Bike Commuter — Leaflet map, precomputed BRouter routes, live GPS nav.
 *
 * Routes for district stores ship in data/routes.json so the app opens
 * instantly and works with no signal. Anything else (a store outside the
 * district, or a re-route once you are already rolling) is fetched live from
 * BRouter, which allows cross-origin requests.
 */
'use strict';

var BROUTER = 'https://brouter.de/brouter';
var PROFILE_NAMES = { balanced: 'trekking', quiet: 'safety' };
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
  routes: {},
  start: null,
  selected: null,
  profile: 'balanced',
  paceKmh: 16,
  imperial: true,
  showFar: false,
  navigating: false,
  me: null,            // {lat, lon, accuracy}
  watchId: null,
  liveRoute: null,     // live re-route result, overrides the baked one
  sheet: 'half'
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
  s = Math.max(0, Math.round(s));
  var h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
  return Math.max(1, m) + ' min';
}

function fmtSpeed(kmh) {
  return S.imperial ? Math.round(kmh / 1.609344) + ' mph' : kmh + ' km/h';
}

function fmtClock(secFromNow) {
  var d = new Date(Date.now() + secFromNow * 1000);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/* Scale BRouter's own duration to the rider's chosen pace. BRouter's profiles
 * already account for turns, surfaces and climb, so scaling its estimate keeps
 * that nuance instead of replacing it with flat distance/speed. */
function rideSeconds(route) {
  var base = route.implied_kmh || 19;
  return route.duration_s * (base / S.paceKmh);
}

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
  if (S.liveRoute && S.liveRoute.key === storeKey(store)) return S.liveRoute.route;
  var r = S.routes[storeKey(store)];
  if (!r) return null;
  var route = r[profile || S.profile];
  if (route && !route.geometry) route.geometry = joinSegments(route.segments);
  return route;
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
  S.selected = store;
  S.liveRoute = null;
  el.listView.hidden = true;
  el.detailView.hidden = false;
  if (openSheet) setSheet('half');
  highlightMarker();

  var route = routeFor(store, S.profile);
  if (route) {
    renderDetail(store, route);
  } else {
    renderDetail(store, null);
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
  renderSteps(route);
  drawRoute(route);
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
    var onto = s.street ? ' onto <b>' + escapeHtml(s.street) + '</b>' : '';
    var verb = s.icon === 'arrive' || s.icon === 'straight'
      ? escapeHtml(s.verb) + (s.street && s.icon === 'straight' ? ' on <b>' + escapeHtml(s.street) + '</b>' : '')
      : escapeHtml(s.verb) + onto;
    return '<li>' + svg + '<span class="step-main">' +
           '<span class="step-verb">' + verb + '</span><br>' +
           '<span class="step-dist">' + fmtDist(s.from_prev_m) +
           (s.at_m ? ' · ' + fmtDistShort(s.at_m) + ' in' : '') + '</span>' +
           '</span></li>';
  }).join('');
}

/* ------------------------------------------------------------ live routing */

function fetchLiveRoute(store, profile, fromLat, fromLon) {
  var o = (fromLat != null) ? [fromLat, fromLon] : [S.start.lat, S.start.lon];
  var url = BROUTER + '?lonlats=' + o[1] + ',' + o[0] + '|' + store.lon + ',' + store.lat +
            '&profile=' + (PROFILE_NAMES[profile] || 'trekking') +
            '&alternativeidx=0&format=geojson&timode=2';
  return fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (doc) {
      var route = parseBrouter(doc, store);
      S.liveRoute = { key: storeKey(store), route: route };
      if (S.selected && storeKey(S.selected) === storeKey(store)) {
        renderDetail(store, route);
        renderList();
      }
      return route;
    })
    .catch(function (err) {
      toast('Could not reach the routing service — ' +
            (navigator.onLine ? 'try again' : 'you appear to be offline') + '.');
      if (S.selected && storeKey(S.selected) === storeKey(store)) {
        el.dSteps.innerHTML = '<li><span class="step-main">No route available offline. ' +
          'Tap Google Maps, or connect and retry.</span></li>';
        el.dTime.textContent = '—'; el.dDist.textContent = '—'; el.dArrive.textContent = '—';
      }
      console.warn('live route failed', err);
      return null;
    });
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
    footway: ['Sidewalk / footway', 'good'], pedestrian: ['Pedestrian street', 'good'],
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

  return {
    profile: 'live', distance_m: dist, duration_s: dur,
    ascend_m: parseInt(p['filtered ascend'] || 0, 10),
    implied_kmh: dur ? Math.round(dist / 1000 / (dur / 3600) * 10) / 10 : 19,
    roads: roads, steps: steps, segments: segments, geometry: coords
  };
}

/* --------------------------------------------------------- Google Maps out */

/* Hand the route to Google Maps. Sampling a few of our own turn points as
 * waypoints nudges Google onto roughly the path we planned rather than letting
 * it pick its own. */
function openInGoogleMaps(store, route) {
  var dest = store.lat + ',' + store.lon;
  var origin = S.navigating && S.me
    ? S.me.lat.toFixed(6) + ',' + S.me.lon.toFixed(6)
    : S.start.lat + ',' + S.start.lon;
  var url = 'https://www.google.com/maps/dir/?api=1&travelmode=bicycling' +
            '&origin=' + origin + '&destination=' + dest;

  if (route && route.geometry && route.geometry.length > 12) {
    var g = route.geometry, want = 6, wp = [];
    for (var i = 1; i <= want; i++) {
      var c = g[Math.round(i * (g.length - 1) / (want + 1))];
      wp.push(c[1].toFixed(5) + ',' + c[0].toFixed(5));
    }
    url += '&waypoints=' + encodeURIComponent(wp.join('|'));
  }
  window.open(url, '_blank', 'noopener');
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
  el.navBanner.hidden = true;
  el.sheet.classList.remove('has-nav');
  setSheet('half');
  var r = S.selected && routeFor(S.selected, S.profile);
  if (r) drawRoute(r);
}

var lastReroute = 0;

function onPosition(pos) {
  S.me = { lat: pos.coords.latitude, lon: pos.coords.longitude,
           accuracy: pos.coords.accuracy };
  showMe();
  if (!S.navigating || !S.selected) return;

  var route = routeFor(S.selected, S.profile);
  if (!route) return;

  var proj = projectOnRoute(route.geometry, S.me.lat, S.me.lon);
  map.setView([S.me.lat, S.me.lon], Math.max(map.getZoom(), 16), { animate: true });

  // Drifted off the line for real? Ask BRouter for a fresh route from here.
  if (proj.offRouteM > OFF_ROUTE_M + (S.me.accuracy || 0) &&
      Date.now() - lastReroute > 20000) {
    lastReroute = Date.now();
    el.navVerb.textContent = 'Off route — recalculating…';
    fetchLiveRoute(S.selected, S.profile, S.me.lat, S.me.lon).then(function (r) {
      if (r) { drawRoute(r); toast('Route updated from your position.'); }
    });
    return;
  }

  var next = null;
  for (var i = 0; i < route.steps.length; i++) {
    if (route.steps[i].at_m > proj.alongM + 8) { next = route.steps[i]; break; }
  }
  if (!next) next = route.steps[route.steps.length - 1];

  var toTurn = Math.max(0, next.at_m - proj.alongM);
  el.navDist.textContent = fmtDist(toTurn);
  el.navVerb.textContent = next.verb + (next.street ? ' onto ' + next.street : '');
  var paths = (STEP_ICONS[next.icon] || STEP_ICONS.straight).split('|');
  el.navIcon.innerHTML = paths.map(function (p) { return '<path d="' + p + '"/>'; }).join('');

  var remainM = Math.max(0, (proj.totalM || route.distance_m) - proj.alongM);
  var remainS = remainM / 1000 / S.paceKmh * 3600;
  el.navRemaining.textContent = fmtDistShort(remainM) + ' left · ' +
    fmtDur(remainS) + ' · arrive ' + fmtClock(remainS);

  if (remainM < 40) {
    el.navDist.textContent = 'Arrived';
    el.navVerb.textContent = S.selected.name;
  }
}

function showMe() {
  if (!S.me) return;
  if (!meMarker) {
    meMarker = L.marker([S.me.lat, S.me.lon], {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>',
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
  });
}

function cycleSheet() {
  setSheet(S.sheet === 'peek' ? 'half' : S.sheet === 'half' ? 'full' : 'peek');
}

function wireSheetDrag() {
  var startY = null, startH = 0;
  el.grab.addEventListener('pointerdown', function (e) {
    startY = e.clientY; startH = sheetPx();
    el.sheet.style.transition = 'none';
    el.grab.setPointerCapture(e.pointerId);
  });
  el.grab.addEventListener('pointermove', function (e) {
    if (startY == null) return;
    var h = Math.min(window.innerHeight - 100, Math.max(90, startH - (e.clientY - startY)));
    el.sheet.style.height = h + 'px';
    document.documentElement.style.setProperty('--sheet-h', h + 'px');
  });
  el.grab.addEventListener('pointerup', function (e) {
    if (startY == null) return;
    var moved = Math.abs(e.clientY - startY);
    var h = sheetPx();
    el.sheet.style.transition = '';
    el.sheet.style.height = '';
    if (moved < 6) { cycleSheet(); startY = null; return; }
    var vh = window.innerHeight;
    setSheet(h < vh * 0.28 ? 'peek' : h < vh * 0.66 ? 'half' : 'full');
    startY = null;
  });
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
    el.paceOut.textContent = fmtSpeed(S.paceKmh);
    refresh();
  });

  el.pace.addEventListener('input', function () {
    S.paceKmh = +el.pace.value;
    el.paceOut.textContent = fmtSpeed(S.paceKmh);
    localStorage.setItem('pbc.pace', String(S.paceKmh));
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
    toast(S.showFar ? 'Showing all Publix within 30 km — tap any for a live route.'
                    : 'Showing district stores only.');
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
    if (S.navigating) stopNav(); else startNav();
  });
  el.btnStopNav.addEventListener('click', stopNav);
  el.btnGmaps.addEventListener('click', function () {
    if (S.selected) openInGoogleMaps(S.selected, routeFor(S.selected, S.profile));
  });

  wireSheetDrag();
  window.addEventListener('resize', function () { setSheet(S.sheet); });
}

function showList() {
  el.detailView.hidden = true;
  el.listView.hidden = false;
  S.selected = null;
  drawRoute(null);
  highlightMarker();
  renderList();
}

function refresh() {
  renderList();
  if (S.selected) {
    var r = routeFor(S.selected, S.profile);
    if (r) renderDetail(S.selected, r);
  }
}

/* -------------------------------------------------------------------- boot */

function boot(storesDoc, routesDoc) {
  S.stores = storesDoc.stores;
  S.start = storesDoc.start;
  S.routes = routesDoc.routes;

  S.imperial = localStorage.getItem('pbc.imperial') !== '0';
  S.paceKmh = +(localStorage.getItem('pbc.pace') || 16);
  S.profile = localStorage.getItem('pbc.profile') || 'balanced';

  ['map', 'search', 'btnUnits', 'btnLocate', 'btnFit', 'btnLayer', 'sheet', 'grab',
   'listView', 'detailView', 'listCount', 'storeList', 'pace', 'paceOut', 'btnBack',
   'dStore', 'dAddr', 'dTime', 'dDist', 'dArrive', 'dRoadBar', 'dRoadLegend', 'dWarn',
   'dSteps', 'dStepCount', 'dHours', 'btnNav', 'btnGmaps', 'btnCall', 'navBanner',
   'navIcon', 'navDist', 'navVerb', 'navRemaining', 'btnStopNav', 'toast', 'startLabel'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  el.startLabel.textContent = 'from ' + S.start.name;
  el.btnUnits.textContent = S.imperial ? 'mi' : 'km';
  el.pace.value = S.paceKmh;
  el.paceOut.textContent = fmtSpeed(S.paceKmh);
  [].forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
    b.classList.toggle('is-on', b.dataset.profile === S.profile);
  });

  initMap();
  wire();
  renderList();
  setSheet('half');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function (e) {
      console.warn('service worker registration failed', e);
    });
  }
}

Promise.all([
  fetch('data/stores.json').then(function (r) { return r.json(); }),
  fetch('data/routes.json').then(function (r) { return r.json(); })
]).then(function (res) { boot(res[0], res[1]); })
  .catch(function (err) {
    document.body.insertAdjacentHTML('afterbegin',
      '<p style="padding:20px;font:15px system-ui">Could not load store data. ' +
      'If you opened this file directly, serve the folder over HTTP instead ' +
      '(<code>python3 -m http.server</code>).</p>');
    console.error(err);
  });
