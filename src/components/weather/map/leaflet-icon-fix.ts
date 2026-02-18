import L from "leaflet";

// Fix Leaflet default marker icon in bundled environments.
// Webpack/Turbopack cannot resolve the icon URLs that Leaflet
// hardcodes in L.Icon.Default, so we point them to the unpkg CDN.
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;

L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});
