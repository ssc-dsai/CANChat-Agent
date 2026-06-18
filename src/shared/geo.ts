// Pure geometry/validation helpers for the map workspace, kept free of `chrome`
// and Leaflet so they can be unit-tested and shared between the map page and the
// background.

/** Leaflet's zoom range; clamp so a bad value can't break the map. */
export function clampZoom(zoom: unknown, fallback = 5): number {
  const z = Number(zoom);
  if (!Number.isFinite(z)) return fallback;
  return Math.max(0, Math.min(22, Math.round(z)));
}

/** A finite [lat, lng] in range, or null. Accepts {lat,lng}, [lat,lng], or {center}. */
export function toLatLng(input: unknown): [number, number] | null {
  let lat: unknown;
  let lng: unknown;
  if (Array.isArray(input) && input.length >= 2) {
    [lat, lng] = input;
  } else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    if (Array.isArray(o.center)) return toLatLng(o.center);
    lat = o.lat;
    lng = o.lng;
  }
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return [la, ln];
}
