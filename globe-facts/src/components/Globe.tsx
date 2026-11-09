import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';

export interface GlobeTap {
  lat: number;
  lon: number;
  zoom: number;
}

export interface GlobeHandle {
  /** Drop the pin and ease the camera toward a point, leaving room for the card. */
  focus(lat: number, lon: number, cardHeightPx: number): void;
  clearPin(): void;
  resumeSpin(): void;
}

interface Props {
  onTap(tap: GlobeTap): void;
  onTapSpace(): void;
  onInteract?(): void;
}

// Satellite imagery. Default: Esri World Imagery (free for prototypes with attribution;
// check Esri's terms before production). Override with VITE_SATELLITE_TILES, e.g. MapTiler:
// https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=YOUR_KEY
const TILES =
  (import.meta.env.VITE_SATELLITE_TILES as string | undefined) ??
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ATTRIBUTION =
  (import.meta.env.VITE_SATELLITE_ATTRIBUTION as string | undefined) ??
  'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const style: StyleSpecification = {
  version: 8,
  projection: { type: 'globe' },
  sources: {
    satellite: { type: 'raster', tiles: [TILES], tileSize: 256, maxzoom: 19, attribution: ATTRIBUTION },
  },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite', paint: { 'raster-fade-duration': 250 } }],
  sky: {
    'sky-color': '#0b2350',
    'horizon-color': '#9cc8ff',
    'fog-color': '#cfe4ff',
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.8,
    // Atmosphere glow when zoomed out, fading as you zoom in.
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 4, 0.9, 7, 0],
  },
  light: { anchor: 'map', position: [1.5, 210, 30], intensity: 0.4 },
};

const SPIN_DEG_PER_SEC = 3;
const RESUME_SPIN_AFTER_MS = 25000;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

export const Globe = forwardRef<GlobeHandle, Props>(function Globe({ onTap, onTapSpace, onInteract }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const pinRef = useRef<maplibregl.Marker | null>(null);
  const spin = useRef({ on: true, lastInteract: 0, allowResume: true });
  const cb = useRef({ onTap, onTapSpace, onInteract });
  cb.current = { onTap, onTapSpace, onInteract };

  useEffect(() => {
    const isSmall = window.innerWidth < 600;
    const map = new maplibregl.Map({
      container: el.current!,
      style,
      center: [-30, 22],
      zoom: isSmall ? 0.6 : 1.4,
      minZoom: 0,
      maxZoom: 18,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 0,
      fadeDuration: 200,
    });
    mapRef.current = map;
    // Attribution is required by the imagery provider; keep it tiny and out of the card's way.
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-left');
    map.once('load', () =>
      el.current?.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'),
    );
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();

    // --- gentle auto-rotate until the user touches the globe
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const s = spin.current;
      if (!s.on && s.allowResume && s.lastInteract && now - s.lastInteract > RESUME_SPIN_AFTER_MS) s.on = true;
      if (s.on && !map.isMoving() && map.getZoom() < 4) {
        const c = map.getCenter();
        const speed = SPIN_DEG_PER_SEC * (1 - map.getZoom() / 5);
        map.jumpTo({ center: [c.lng + speed * dt, c.lat] });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const stopSpin = () => {
      spin.current.on = false;
      spin.current.lastInteract = performance.now();
      cb.current.onInteract?.();
    };
    map.on('mousedown', stopSpin);
    map.on('touchstart', stopSpin);
    map.on('wheel', stopSpin);

    // --- taps. Delay a little so a double-tap (zoom) doesn't also ask for a fact.
    let pending: ReturnType<typeof setTimeout> | null = null;
    map.on('click', (e) => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        const p = map.project(e.lngLat);
        const onGlobe = Math.hypot(p.x - e.point.x, p.y - e.point.y) < 6;
        if (!onGlobe) return cb.current.onTapSpace();
        cb.current.onTap({ lat: e.lngLat.lat, lon: e.lngLat.wrap().lng, zoom: map.getZoom() });
      }, 230);
    });
    map.on('dblclick', () => {
      if (pending) clearTimeout(pending);
      pending = null;
    });

    return () => {
      cancelAnimationFrame(raf);
      if (pending) clearTimeout(pending);
      map.remove();
    };
  }, []);

  useImperativeHandle(ref, () => ({
    focus(lat, lon, cardHeightPx) {
      const map = mapRef.current;
      if (!map) return;
      spin.current.on = false;
      spin.current.allowResume = false;

      if (!pinRef.current) {
        const dot = document.createElement('div');
        dot.className = 'pin';
        dot.innerHTML = '<span class="pin-ring"></span><span class="pin-dot"></span>';
        pinRef.current = new maplibregl.Marker({ element: dot });
      }
      const pinEl = pinRef.current.getElement();
      pinEl.classList.remove('pin-drop');
      void pinEl.offsetWidth; // restart the drop animation
      pinEl.classList.add('pin-drop');
      pinRef.current.setLngLat([lon, lat]).addTo(map);

      // Fly gently toward the point: a small zoom-in, and keep the pin above the card.
      const z = map.getZoom();
      const nextZoom = Math.min(16, z < 2 ? z + 0.5 : z < 6 ? z + 0.35 : z + 0.2);
      map.easeTo({
        center: [lon, lat],
        zoom: nextZoom,
        offset: [0, -Math.min(cardHeightPx, window.innerHeight * 0.5) / 2],
        duration: 1100,
        easing: easeOutCubic,
        essential: true,
      });
    },
    clearPin() {
      pinRef.current?.remove();
      spin.current.allowResume = true;
      spin.current.lastInteract = performance.now();
    },
    resumeSpin() {
      spin.current.allowResume = true;
    },
  }));

  return <div ref={el} className="globe" />;
});
