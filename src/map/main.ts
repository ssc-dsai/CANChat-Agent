// The map workspace — a single persistent Leaflet map in its own tab. The
// background service worker (mapClient.ts) drives it with chrome.runtime
// messages carrying target:'map'; this page applies each command to the ONE map
// instance and replies with the result + current state. State is mirrored to
// chrome.storage.session so an accidental reload restores the same view/markers.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { MapResponse, MapState } from '../shared/messages';
import { clampZoom, toLatLng } from '../shared/geo';

interface Basemap {
  url: string;
  attribution: string;
}
const BASEMAPS: Record<string, Basemap> = {
  osm: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors' },
  'carto-light': {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  'carto-dark': {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '© OpenStreetMap contributors © CARTO',
  },
};

const DEFAULT_CENTER: [number, number] = [45.4215, -75.6972]; // Ottawa
const PIN = L.divIcon({ className: 'cm-pin', html: '📍', iconSize: [24, 24], iconAnchor: [12, 24] });

const map = L.map('map').setView(DEFAULT_CENTER, 5);
let basemapKey = 'osm';
let tiles = L.tileLayer(BASEMAPS.osm.url, { attribution: BASEMAPS.osm.attribution }).addTo(map);

interface MarkerMeta {
  marker: L.Marker;
  label?: string;
  popup?: string;
}
const markers = new Map<string, MarkerMeta>();
const shapes = new Map<string, L.Layer>();
let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

function setBasemap(key: string, custom?: Basemap): void {
  const def = custom ?? BASEMAPS[key];
  if (!def) throw new Error(`Unknown basemap "${key}". Try: ${Object.keys(BASEMAPS).join(', ')}, or pass url.`);
  map.removeLayer(tiles);
  tiles = L.tileLayer(def.url, { attribution: def.attribution }).addTo(map);
  basemapKey = custom ? 'custom' : key;
}

function addMarker(args: Record<string, unknown>): string {
  const ll = toLatLng(args);
  if (!ll) throw new Error('add_marker needs a valid lat/lng.');
  const id = typeof args.id === 'string' && args.id ? args.id : nextId('m');
  const marker = L.marker(ll, { icon: PIN }).addTo(map);
  const label = typeof args.label === 'string' ? args.label : undefined;
  const popup = typeof args.popup === 'string' ? args.popup : label;
  if (popup) marker.bindPopup(popup);
  if (args.openPopup && popup) marker.openPopup();
  markers.get(id)?.marker.remove(); // replace any prior marker with this id
  markers.set(id, { marker, label, popup });
  return id;
}

function addShape(args: Record<string, unknown>): string {
  const id = typeof args.id === 'string' && args.id ? args.id : nextId('s');
  const shape = String(args.shape ?? '');
  const opts = (args.options as L.PathOptions) ?? {};
  let layer: L.Layer;
  if (shape === 'circle') {
    const c = toLatLng(args);
    if (!c) throw new Error('circle needs a center lat/lng.');
    layer = L.circle(c, { radius: Number(args.radiusMeters) || 1000, ...opts });
  } else if (shape === 'polyline' || shape === 'polygon') {
    const coords = (args.coords as unknown[])?.map((c) => toLatLng(c)).filter(Boolean) as [number, number][];
    if (!coords?.length) throw new Error(`${shape} needs a coords array of lat/lng.`);
    layer = shape === 'polyline' ? L.polyline(coords, opts) : L.polygon(coords, opts);
  } else if (shape === 'rectangle') {
    const b = args.bounds as [[number, number], [number, number]];
    if (!Array.isArray(b)) throw new Error('rectangle needs bounds [[s,w],[n,e]].');
    layer = L.rectangle(b, opts);
  } else {
    throw new Error(`Unknown shape "${shape}". Use circle | polyline | polygon | rectangle.`);
  }
  layer.addTo(map);
  shapes.get(id)?.remove();
  shapes.set(id, layer);
  return id;
}

function animateMarker(args: Record<string, unknown>): void {
  const id = String(args.id ?? '');
  const meta = markers.get(id);
  if (!meta) throw new Error(`No marker "${id}" to animate.`);
  const path = (args.path as unknown[])?.map((c) => toLatLng(c)).filter(Boolean) as [number, number][];
  if (!path?.length) throw new Error('animate needs a path of lat/lng points.');
  const durationMs = Math.max(200, (Number(args.durationSec) || 2) * 1000);
  const start = performance.now();
  const from = meta.marker.getLatLng();
  const pts: [number, number][] = [[from.lat, from.lng], ...path];
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    const seg = t * (pts.length - 1);
    const i = Math.min(pts.length - 2, Math.floor(seg));
    const f = seg - i;
    const lat = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f;
    const lng = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
    meta.marker.setLatLng([lat, lng]);
    if (t < 1) requestAnimationFrame(step);
    else void saveState();
  };
  requestAnimationFrame(step);
}

function clear(what: string): void {
  if (what === 'all' || what === 'markers') {
    markers.forEach((m) => m.marker.remove());
    markers.clear();
  }
  if (what === 'all' || what === 'shapes') {
    shapes.forEach((s) => s.remove());
    shapes.clear();
  }
}

function getState(): MapState {
  const c = map.getCenter();
  const round = (n: number) => Math.round(n * 1e5) / 1e5;
  return {
    center: [round(c.lat), round(c.lng)],
    zoom: map.getZoom(),
    basemap: basemapKey,
    markers: [...markers.entries()].map(([id, m]) => {
      const ll = m.marker.getLatLng();
      return { id, lat: round(ll.lat), lng: round(ll.lng), label: m.label };
    }),
    shapes: shapes.size,
  };
}

/** Apply one command to the single map. Throws on bad input (caught by the handler). */
function apply(command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case 'ping':
      return null;
    case 'set_view': {
      const ll = toLatLng(args) ?? map.getCenter();
      map.setView(ll as L.LatLngExpression, clampZoom(args.zoom, map.getZoom()), { animate: Boolean(args.animate) });
      return null;
    }
    case 'fly_to': {
      const ll = toLatLng(args);
      if (!ll) throw new Error('fly_to needs a valid lat/lng.');
      map.flyTo(ll, clampZoom(args.zoom, map.getZoom()), { duration: Number(args.durationSec) || 1.5 });
      return null;
    }
    case 'set_basemap':
      setBasemap(
        String(args.basemap ?? ''),
        typeof args.url === 'string'
          ? { url: args.url, attribution: String(args.attribution ?? '') }
          : undefined,
      );
      return null;
    case 'add_marker':
      return { id: addMarker(args) };
    case 'add_geojson': {
      const id = typeof args.id === 'string' && args.id ? args.id : nextId('g');
      const layer = L.geoJSON(args.geojson as GeoJSON.GeoJsonObject);
      layer.addTo(map);
      shapes.get(id)?.remove();
      shapes.set(id, layer);
      if (args.fit) {
        try {
          map.fitBounds(layer.getBounds());
        } catch {
          /* empty geometry */
        }
      }
      return { id };
    }
    case 'add_shape':
      return { id: addShape(args) };
    case 'animate':
      animateMarker(args);
      return null;
    case 'fit_bounds': {
      if (Array.isArray(args.bounds)) {
        map.fitBounds(args.bounds as L.LatLngBoundsExpression);
      } else {
        const layers: L.Layer[] = [...markers.values()].map((m) => m.marker);
        shapes.forEach((s) => layers.push(s));
        if (layers.length) map.fitBounds(L.featureGroup(layers).getBounds());
      }
      return null;
    }
    case 'clear':
      clear(String(args.what ?? 'all'));
      return null;
    case 'get_state':
      return null;
    default:
      throw new Error(`Unknown map command: ${command}`);
  }
}

// ----- persistence (best-effort) -----
interface Saved {
  center: [number, number];
  zoom: number;
  basemap: string;
  markers: Array<{ id: string; lat: number; lng: number; label?: string; popup?: string }>;
}
async function saveState(): Promise<void> {
  try {
    const s = getState();
    const saved: Saved = {
      center: s.center,
      zoom: s.zoom,
      basemap: basemapKey,
      markers: [...markers.entries()].map(([id, m]) => {
        const ll = m.marker.getLatLng();
        return { id, lat: ll.lat, lng: ll.lng, label: m.label, popup: m.popup };
      }),
    };
    await chrome.storage.session.set({ map_state: saved });
  } catch {
    /* session storage unavailable — view simply won't persist across reload */
  }
}
async function restoreState(): Promise<void> {
  try {
    const r = await chrome.storage.session.get('map_state');
    const s = r.map_state as Saved | undefined;
    if (!s) return;
    if (s.basemap && s.basemap !== 'custom') setBasemap(s.basemap);
    map.setView(s.center, s.zoom);
    for (const m of s.markers ?? []) addMarker(m as Record<string, unknown>);
  } catch {
    /* nothing to restore */
  }
}

function handleCommand(message: { command?: string; args?: Record<string, unknown> }): MapResponse {
  try {
    const result = apply(String(message.command), message.args ?? {});
    void saveState();
    return { ok: true, result, state: getState() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), state: getState() };
  }
}

// Restore the prior view BEFORE we start accepting commands, then begin
// listening — otherwise an async restore could land after the first command and
// clobber it.
void (async () => {
  await restoreState();
  map.on('moveend', () => void saveState());
  chrome.runtime.onMessage.addListener(
    (
      message: { target?: string; type?: string; command?: string; args?: Record<string, unknown> },
      _sender,
      sendResponse,
    ) => {
      if (message?.target !== 'map' || message.type !== 'map_command') return undefined;
      sendResponse(handleCommand(message));
      return undefined; // responded synchronously
    },
  );
})();
