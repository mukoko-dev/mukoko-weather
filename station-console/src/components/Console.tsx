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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
          <h1 className="font-serif text-xl font-semibold">
            mukoko weather stations
          </h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {userEmail}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href="/auth/signout">Sign out</a>
        </Button>
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* One-time credentials after registration */}
      {creds && (
        <Card aria-label="Station credentials">
          <CardHeader>
            <CardTitle>
              Save these credentials — the key is shown ONCE
            </CardTitle>
            <CardDescription>
              Station ID <code className="font-mono">{creds.stationId}</code> ·
              ingest key{" "}
              <code className="break-all font-mono">{creds.ingestKey}</code>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">
              Point your station console at:
            </p>
            <p>
              Wunderground protocol — server{" "}
              <code className="font-mono">weather.mukoko.com</code>, path{" "}
              <code className="font-mono">/api/py/stations/ingest</code>, ID =
              station ID, PASSWORD = ingest key
            </p>
            <p>
              Ecowitt protocol — server{" "}
              <code className="font-mono">weather.mukoko.com</code>, path{" "}
              <code className="font-mono">/api/py/stations/ingest</code>,
              PASSKEY ={" "}
              <code className="font-mono">
                {creds.stationId}:{"<key>"}
              </code>
            </p>
            <p>
              Step-by-step instructions:{" "}
              <a
                href="https://docs.nyuchi.com/mukoko-weather/weather-stations/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cobalt underline underline-offset-4"
              >
                weather stations guide
              </a>
            </p>
          </CardContent>
          <CardFooter>
            <Button variant="secondary" onClick={() => setCreds(null)}>
              I have saved them
            </Button>
          </CardFooter>
        </Card>
      )}

      {/* Register */}
      <Card aria-label="Register a station">
        <CardHeader>
          <CardTitle>Register a station</CardTitle>
          <CardDescription>
            Digital consoles push readings automatically; analog stations log
            manual readings below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleRegister} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="station-name">Station name</Label>
              <Input
                id="station-name"
                required
                minLength={2}
                placeholder="e.g. Marondera High School"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-32 flex-1 space-y-2">
                <Label htmlFor="station-lat">Latitude</Label>
                <Input
                  id="station-lat"
                  required
                  placeholder="-17.8"
                  inputMode="decimal"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                />
              </div>
              <div className="min-w-32 flex-1 space-y-2">
                <Label htmlFor="station-lon">Longitude</Label>
                <Input
                  id="station-lon"
                  required
                  placeholder="31.05"
                  inputMode="decimal"
                  value={lon}
                  onChange={(e) => setLon(e.target.value)}
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={useGps}
              >
                Use GPS
              </Button>
            </div>
            <RadioGroup
              value={stationType}
              onValueChange={(v) => setStationType(v as "digital" | "manual")}
              className="flex flex-wrap gap-4"
              aria-label="Station type"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="digital" id="type-digital" />
                <Label htmlFor="type-digital">
                  Digital (uploads automatically)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="manual" id="type-manual" />
                <Label htmlFor="type-manual">Analog (manual readings)</Label>
              </div>
            </RadioGroup>
            <div className="space-y-2">
              <Label htmlFor="station-hardware">Hardware (optional)</Label>
              <Input
                id="station-hardware"
                placeholder="e.g. Ecowitt WS2910"
                value={hardware}
                onChange={(e) => setHardware(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Registering…" : "Register station"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* My stations */}
      <section className="space-y-3" aria-label="My stations">
        <h2 className="text-base font-semibold">My stations</h2>
        {stations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No stations on this device yet.
          </p>
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

      <footer className="text-sm text-muted-foreground">
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
    <Card>
      <CardHeader>
        <CardTitle>{station.name}</CardTitle>
        <CardDescription>
          <code className="font-mono">{station.stationId}</code> ·{" "}
          {status?.lastObservationAt
            ? `Last reading ${new Date(status.lastObservationAt).toLocaleString()}`
            : "No readings yet"}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant="secondary">
            {station.stationType === "manual" ? "Analog" : "Digital"}
          </Badge>
          <Button variant="ghost" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {status?.latestMetrics && (
          <p className="text-sm text-muted-foreground">
            {Object.entries(status.latestMetrics)
              .map(
                ([k, v]) =>
                  `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${v}`,
              )
              .join(" · ")}
          </p>
        )}

        <form
          onSubmit={submit}
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          aria-label={`Log a manual reading for ${station.name}`}
        >
          <Input
            placeholder="Temp °C"
            aria-label="Temperature in Celsius"
            inputMode="decimal"
            value={reading.temperatureC ?? ""}
            onChange={set("temperatureC")}
          />
          <Input
            placeholder="Rain mm"
            aria-label="Rainfall in millimetres"
            inputMode="decimal"
            value={reading.rainfallMm ?? ""}
            onChange={set("rainfallMm")}
          />
          <Input
            placeholder="Humidity %"
            aria-label="Relative humidity percent"
            inputMode="decimal"
            value={reading.humidityPercent ?? ""}
            onChange={set("humidityPercent")}
          />
          <Input
            placeholder="Pressure hPa"
            aria-label="Pressure in hectopascals"
            inputMode="decimal"
            value={reading.pressureHpa ?? ""}
            onChange={set("pressureHpa")}
          />
          <Input
            placeholder="Wind km/h"
            aria-label="Wind speed in kilometres per hour"
            inputMode="decimal"
            value={reading.windKph ?? ""}
            onChange={set("windKph")}
          />
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving…" : "Log reading"}
          </Button>
        </form>
        {result && (
          <p className="text-sm text-muted-foreground" role="status">
            {result}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
