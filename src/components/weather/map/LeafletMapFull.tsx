"use client";

import "./leaflet-css";
import "./leaflet-icon-fix";
import { MapContainer, TileLayer, Marker } from "react-leaflet";

interface LeafletMapFullProps {
  lat: number;
  lon: number;
  layer: string;
}

export default function LeafletMapFull({
  lat,
  lon,
  layer,
}: LeafletMapFullProps) {
  return (
    <MapContainer
      center={[lat, lon]}
      zoom={8}
      scrollWheelZoom={true}
      zoomControl={true}
      style={{ height: "100%", width: "100%" }}
    >
      {/* Base map — OpenStreetMap */}
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
      />
      {/* Weather overlay via tile proxy */}
      <TileLayer
        url={`/api/py/map-tiles?z={z}&x={x}&y={y}&layer=${layer}`}
        opacity={0.6}
      />
      <Marker position={[lat, lon]} />
    </MapContainer>
  );
}
