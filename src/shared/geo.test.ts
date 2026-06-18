import { describe, expect, it } from 'vitest';
import { clampZoom, toLatLng } from './geo';

describe('clampZoom', () => {
  it('rounds and clamps into [0, 22]', () => {
    expect(clampZoom(5)).toBe(5);
    expect(clampZoom(5.4)).toBe(5);
    expect(clampZoom(-3)).toBe(0);
    expect(clampZoom(99)).toBe(22);
  });
  it('falls back on non-numbers', () => {
    expect(clampZoom('x')).toBe(5);
    expect(clampZoom(undefined, 8)).toBe(8);
  });
});

describe('toLatLng', () => {
  it('accepts {lat,lng}, [lat,lng], and {center}', () => {
    expect(toLatLng({ lat: 45.4, lng: -75.7 })).toEqual([45.4, -75.7]);
    expect(toLatLng([45.4, -75.7])).toEqual([45.4, -75.7]);
    expect(toLatLng({ center: [1, 2] })).toEqual([1, 2]);
  });
  it('rejects out-of-range or non-finite coords', () => {
    expect(toLatLng({ lat: 91, lng: 0 })).toBeNull();
    expect(toLatLng({ lat: 0, lng: 200 })).toBeNull();
    expect(toLatLng({ lat: 'a', lng: 2 })).toBeNull();
    expect(toLatLng(null)).toBeNull();
    expect(toLatLng({})).toBeNull();
  });
});
