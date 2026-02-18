"use client";

import "./leaflet-css";
import "./leaflet-icon-fix";
import { MapContainer, TileLayer, Marker } from "react-leaflet";

interface LeafletMapPreviewProps {
  lat: number;
  lon: number;
}

export default function LeafletMapPreview({
  lat,
  lon,
}: LeafletMapPreviewProps) {
  return (
    <MapContainer
      center={[lat, lon]}
      zoom={7}
      scrollWheelZoom={false}
      dragging={false}
      zoomControl={false}
      attributionControl={false}
      style={{ height: "100%", width: "100%" }}
    >
      {/* Base map only — weather overlay tiles load on the full map page */}
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <Marker position={[lat, lon]} />
    </MapContainer>
  );
}
