"use client";

import "./leaflet-css";
import "./leaflet-icon-fix";
import { MapContainer, TileLayer, Marker } from "react-leaflet";

interface LeafletMapPreviewProps {
  lat: number;
  lon: number;
  layer: string;
}

export default function LeafletMapPreview({
  lat,
  lon,
  layer,
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
      {/* Base map — OpenStreetMap */}
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
      {/* Weather overlay via tile proxy */}
      <TileLayer
        url={`/api/map-tiles?z={z}&x={x}&y={y}&layer=${layer}`}
        opacity={0.6}
      />
      <Marker position={[lat, lon]} />
    </MapContainer>
  );
}
