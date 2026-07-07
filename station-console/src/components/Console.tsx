"use client";

import { useEffect, useState } from "react";
import {
  API_BASE,
  loadStations,
  saveStations,
  registerStation,
  fetchStatus,
  submitManualReading,
  type RegisteredStation,
  type StationStatus,
} from "@/lib/api";

interface Credentials {
  stationId: string;
  ingestKey: string;
}

export function Console({
  userEmail,
  userId,
}: {
  userEmail: string;
  userId: string;
}) {
  const [stations, setStations] = useState<RegisteredStation[]>([]);
  const [statuses, setStatuses] = useState<Record<string, StationStatus>>({});
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Register form state
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [stationType, setStationType] = useState<"digital" | "manual">(
    "digital",
  );
  const [hardware, setHardware] = useState("");

  useEffect(() => {
    const list = loadStations();
    setStations(list);
    list.forEach((s) =>
      fetchStatus(s)
        .then((st) => setStatuses((prev) => ({ ...prev, [s.stationId]: st })))
        .catch(() => undefined),
    );
  }, []);

  const useGps = () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(5));
        setLon(pos.coords.longitude.toFixed(5));
      },
      () => setError("Could not read GPS — enter coordinates manually."),
    );
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await registerStation({
        name,
        lat: parseFloat(lat),
        lon: parseFloat(lon),
        stationType,
        hardware: hardware || undefined,
      });
      const entry: RegisteredStation = {
        stationId: result.stationId,
        key: result.ingestKey,
        name,
        stationType,
      };
      const next = [...stations, entry];
      setStations(next);
      saveStations(next);
      setCreds({ stationId: result.stationId, ingestKey: result.ingestKey });
      setName("");
      setLat("");
      setLon("");
      setHardware("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Mukoko Weather Stations</h1>
          <p className="dove">Signed in as {userEmail}</p>
        </div>
        <a href="/auth/signout" className="impala">
          Sign out
        </a>
      </header>

      {error && (
        <p role="alert" className="baobab" style={undefined}>
          <span className="text-[var(--color-severity-severe)]">{error}</span>
        </p>
      )}

      {/* One-time credentials after registration */}
      {creds && (
        <section className="baobab space-y-2" aria-label="Station credentials">
          <h2 className="giraffe">
            Save these credentials — the key is shown ONCE
          </h2>
          <p className="dove">
            Station ID: <code>{creds.stationId}</code>
          </p>
          <p className="dove break-all">
            Ingest key: <code>{creds.ingestKey}</code>
          </p>
          <div className="space-y-1 text-sm">
            <p className="giraffe">Point your station console at:</p>
            <p className="dove">
              Wunderground protocol — server <code>weather.mukoko.com</code>,
              path <code>/api/py/stations/ingest</code>, ID = station ID,
              PASSWORD = ingest key
            </p>
            <p className="dove">
              Ecowitt protocol — server <code>weather.mukoko.com</code>, path{" "}
              <code>/api/py/stations/ingest</code>, PASSKEY ={" "}
              <code>
                {creds.stationId}:{"<key>"}
              </code>
            </p>
          </div>
          <button className="impala" onClick={() => setCreds(null)}>
            I have saved them
          </button>
        </section>
      )}

      {/* Register */}
      <section className="baobab space-y-3" aria-label="Register a station">
        <h2 className="giraffe">Register a station</h2>
        <form onSubmit={handleRegister} className="space-y-3">
          <input
            className="field"
            required
            minLength={2}
            placeholder="Station name (e.g. Marondera High School)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className="field"
              required
              placeholder="Latitude"
              inputMode="decimal"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
            />
            <input
              className="field"
              required
              placeholder="Longitude"
              inputMode="decimal"
              value={lon}
              onChange={(e) => setLon(e.target.value)}
            />
            <button type="button" className="impala shrink-0" onClick={useGps}>
              Use GPS
            </button>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={stationType === "digital"}
                onChange={() => setStationType("digital")}
              />
              Digital (uploads automatically)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={stationType === "manual"}
                onChange={() => setStationType("manual")}
              />
              Analog (manual readings)
            </label>
          </div>
          <input
            className="field"
            placeholder="Hardware (optional, e.g. Ecowitt WS2910)"
            value={hardware}
            onChange={(e) => setHardware(e.target.value)}
          />
          <button type="submit" className="kudu w-full" disabled={busy}>
            {busy ? "Registering…" : "Register station"}
          </button>
        </form>
      </section>

      {/* My stations */}
      <section className="space-y-3" aria-label="My stations">
        <h2 className="giraffe">My stations</h2>
        {stations.length === 0 && (
          <p className="dove">No stations on this device yet.</p>
        )}
        {stations.map((s) => (
          <StationCard
            key={s.stationId}
            station={s}
            status={statuses[s.stationId]}
            onRemove={() => {
              const next = stations.filter((x) => x.stationId !== s.stationId);
              setStations(next);
              saveStations(next);
            }}
          />
        ))}
      </section>

      <footer className="dove">
        API: {API_BASE} · Owner: {userId}
      </footer>
    </main>
  );
}

function StationCard({
  station,
  status,
  onRemove,
}: {
  station: RegisteredStation;
  status?: StationStatus;
  onRemove: () => void;
}) {
  const [reading, setReading] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const payload: Record<string, number> = {};
      for (const [k, v] of Object.entries(reading)) {
        if (v !== "") payload[k] = parseFloat(v);
      }
      const res = await submitManualReading(station, payload);
      setResult(
        res.qcStatus === "validated"
          ? `Saved — ${res.accepted} measurement(s) accepted`
          : "Rejected by quality checks",
      );
      setReading({});
    } catch (err) {
      setResult(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  };

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setReading((prev) => ({ ...prev, [k]: e.target.value }));

  return (
    <article className="baobab space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="giraffe">{station.name}</h3>
          <p className="dove">
            {station.stationId} ·{" "}
            {station.stationType === "manual" ? "Analog" : "Digital"} ·{" "}
            {status?.lastObservationAt
              ? `Last reading ${new Date(status.lastObservationAt).toLocaleString()}`
              : "No readings yet"}
          </p>
        </div>
        <button className="impala" onClick={onRemove}>
          Remove
        </button>
      </div>

      {status?.latestMetrics && (
        <p className="dove">
          {Object.entries(status.latestMetrics)
            .map(
              ([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${v}`,
            )
            .join(" · ")}
        </p>
      )}

      <form onSubmit={submit} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <input
          className="field"
          placeholder="Temp °C"
          inputMode="decimal"
          value={reading.temperatureC ?? ""}
          onChange={set("temperatureC")}
        />
        <input
          className="field"
          placeholder="Rain mm"
          inputMode="decimal"
          value={reading.rainfallMm ?? ""}
          onChange={set("rainfallMm")}
        />
        <input
          className="field"
          placeholder="Humidity %"
          inputMode="decimal"
          value={reading.humidityPercent ?? ""}
          onChange={set("humidityPercent")}
        />
        <input
          className="field"
          placeholder="Pressure hPa"
          inputMode="decimal"
          value={reading.pressureHpa ?? ""}
          onChange={set("pressureHpa")}
        />
        <input
          className="field"
          placeholder="Wind km/h"
          inputMode="decimal"
          value={reading.windKph ?? ""}
          onChange={set("windKph")}
        />
        <button type="submit" className="kudu" disabled={busy}>
          {busy ? "Saving…" : "Log reading"}
        </button>
      </form>
      {result && (
        <p className="dove" role="status">
          {result}
        </p>
      )}
    </article>
  );
}
