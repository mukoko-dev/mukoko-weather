"use client";

import "./leaflet-css";
import "./leaflet-icon-fix";
import { MapContainer, TileLayer, Marker } from "react-leaflet";
import { useMapStyle } from "./use-map-style";

interface LeafletMapPreviewProps {
  lat: number;
  lon: number;
}

export default function LeafletMapPreview({
  lat,
  lon,
}: LeafletMapPreviewProps) {
  const mapStyle = useMapStyle();

  return (
    <MapContainer
      center={[lat, lon]}
      zoom={7}
      scrollWheelZoom={false}
      dragging={false}
      zoomControl={false}
      style={{ height: "100%", width: "100%" }}
    >
      {/* Base map — Mapbox (proxied to keep API key server-side) */}
      <TileLayer
        url={`/api/py/map-tiles/base?z={z}&x={x}&y={y}&style=${mapStyle}`}
        attribution='&copy; <a href="https://www.mapbox.com/">Mapbox</a> &copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
        tileSize={512}
        zoomOffset={-1}
      />
      <Marker position={[lat, lon]} />
    </MapContainer>
  );
}
