/**
 * Station console behaviour: progressive enhancement over the server-rendered
 * markup in components/Console.astro. No framework; every dynamic string goes
 * through textContent. Logic lives in src/lib (unit-tested); this file only
 * wires it to the DOM.
 */
import { ConsoleApi, ConsoleApiError } from "../lib/stations/api-client";
import {
  addStation,
  loadStations,
  removeStation,
  replaceKey,
  saveStations,
  type StoredStation,
} from "../lib/stations/store";
import {
  type ConsoleStation,
  describeLastReading,
  describeReadingResult,
  formatMetrics,
  mergeStations,
  setupInstructions,
} from "../lib/stations/view-model";
import type { StationStatus, StationType } from "../lib/stations/types";
import { parseReadingInput, parseRegisterInput } from "../lib/stations/validators";
import { parseThemePreference, resolveDark, THEME_KEY } from "../lib/theme";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function init(): void {
  const root = document.getElementById("console-root");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "1";

  const ingestHost = root.dataset.ingestHost ?? "weather.mukoko.com";
  const api = new ConsoleApi();
  const q = <T extends HTMLElement>(sel: string, from: ParentNode = document) => from.querySelector<T>(sel);

  const list = q<HTMLUListElement>("#station-list")!;
  const empty = q<HTMLElement>("#station-empty")!;
  const template = q<HTMLTemplateElement>("#station-template")!;
  const errorBox = q<HTMLElement>("#console-error")!;
  const credsBox = q<HTMLElement>("#credentials")!;
  const form = q<HTMLFormElement>("#register-form")!;

  let local: StoredStation[] = loadStations(storage());
  let stations: ConsoleStation[] = mergeStations([], local);
  const statuses = new Map<string, StationStatus>();

  const showError = (message: string | null) => {
    errorBox.hidden = message === null;
    const text = q<HTMLElement>("[data-error-text]", errorBox);
    if (text) text.textContent = message ?? "";
  };

  const handleFailure = (err: unknown, fallback: string): string => {
    if (err instanceof ConsoleApiError && err.status === 401) {
      window.location.assign("/auth/signin");
      return "Signing you in again";
    }
    return err instanceof Error && err.message ? err.message : fallback;
  };

  const persist = (next: StoredStation[]) => {
    local = next;
    saveStations(storage(), local);
  };

  function paint(li: HTMLElement, s: ConsoleStation) {
    const status = statuses.get(s.stationId);
    q("[data-station-last]", li)!.textContent = describeLastReading(status?.lastObservationAt ?? null);
    q("[data-station-metrics]", li)!.textContent = formatMetrics(status?.latestMetrics ?? null);
  }

  function render() {
    list.replaceChildren();
    empty.hidden = stations.length > 0;
    for (const s of stations) {
      const li = (template.content.cloneNode(true) as DocumentFragment).querySelector<HTMLElement>("[data-station]")!;
      li.dataset.stationId = s.stationId;
      q("[data-station-name]", li)!.textContent = s.name;
      q("[data-station-id]", li)!.textContent = s.stationId;
      q("[data-station-type]", li)!.textContent = s.stationType === "manual" ? "Analog" : "Digital";
      q("[data-station-access]", li)!.textContent = s.access === "owner" ? "Owned by you" : "Key on this device";
      const readingForm = q<HTMLFormElement>("[data-reading-form]", li)!;
      readingForm.setAttribute("aria-label", `Log a manual reading for ${s.name}`);
      // Ids must be unique across cloned cards.
      for (const input of readingForm.querySelectorAll<HTMLInputElement>("[data-reading-input]")) {
        const unique = `${s.stationId}-${input.name}`;
        const label = readingForm.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
        input.id = unique;
        label?.setAttribute("for", unique);
      }
      // Rotation is an owner action; a key alone cannot rotate itself.
      if (s.access === "key") q("[data-action=rotate]", li)!.setAttribute("hidden", "");
      paint(li, s);
      list.append(li);
    }
  }

  async function refreshStatus(s: ConsoleStation) {
    try {
      const status = await api.status(s.stationId, s.access === "key" ? s.key : undefined);
      statuses.set(s.stationId, status);
      const li = list.querySelector<HTMLElement>(`[data-station-id="${s.stationId}"]`);
      if (li) paint(li, s);
    } catch (err) {
      if (err instanceof ConsoleApiError && err.status === 401) handleFailure(err, "");
      // A failed status read leaves the card as it was.
    }
  }

  async function loadAll() {
    try {
      const server = await api.list();
      stations = mergeStations(server, local);
    } catch (err) {
      stations = mergeStations([], local);
      showError(handleFailure(err, "Could not load your stations from the server."));
    }
    render();
    await Promise.all(stations.map(refreshStatus));
  }

  function showCredentials(stationId: string, ingestKey: string) {
    const ins = setupInstructions(ingestHost, stationId);
    q("[data-cred-id]", credsBox)!.textContent = stationId;
    q("[data-cred-key]", credsBox)!.textContent = ingestKey;
    q("[data-cred-wunderground]", credsBox)!.textContent = ins.wunderground;
    q("[data-cred-ecowitt]", credsBox)!.textContent = ins.ecowitt;
    credsBox.hidden = false;
    credsBox.querySelector<HTMLElement>("h2")?.setAttribute("tabindex", "-1");
    credsBox.querySelector<HTMLElement>("h2")?.focus();
  }

  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(null);
    const type = (form.querySelector<HTMLInputElement>('input[name="stationType"]:checked')?.value ?? "digital") as StationType;
    const parsed = parseRegisterInput({
      name: field("name").value,
      lat: field("lat").value,
      lon: field("lon").value,
      stationType: type,
      hardware: field("hardware").value,
    });
    if (!parsed.ok) return showError(parsed.error);

    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const issued = await api.register(parsed.value);
      persist(addStation(local, { stationId: issued.stationId, key: issued.ingestKey, name: parsed.value.name, stationType: parsed.value.stationType }));
      showCredentials(issued.stationId, issued.ingestKey);
      form.reset();
      await loadAll();
    } catch (err) {
      showError(handleFailure(err, "Registration failed"));
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });

  root.addEventListener("click", async (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    const li = target.closest<HTMLElement>("[data-station]");
    const station = li ? stations.find((s) => s.stationId === li.dataset.stationId) : undefined;

    if (action === "dismiss-credentials") {
      credsBox.hidden = true;
      q("[data-cred-key]", credsBox)!.textContent = "";
    } else if (action === "use-gps") {
      if (!navigator.geolocation) return showError("GPS is not available. Enter coordinates manually.");
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          field("lat").value = pos.coords.latitude.toFixed(5);
          field("lon").value = pos.coords.longitude.toFixed(5);
          showError(null);
        },
        () => showError("Could not read GPS. Enter coordinates manually."),
      );
    } else if (action === "refresh" && station) {
      await refreshStatus(station);
    } else if (action === "remove" && station) {
      persist(removeStation(local, station.stationId));
      stations = stations.filter((s) => s.stationId !== station.stationId || s.access === "owner");
      const result = q("[data-station-result]", li!);
      if (station.access === "owner") {
        station.key = undefined;
        if (result) result.textContent = "Key removed from this device. The station stays registered to you.";
      } else {
        render();
      }
    } else if (action === "rotate" && station && li) {
      if (!window.confirm(`Rotate the ingest key for ${station.name}? The old key stops working.`)) return;
      try {
        const issued = await api.rotateKey(station.stationId);
        persist(
          local.some((s) => s.stationId === station.stationId)
            ? replaceKey(local, station.stationId, issued.ingestKey)
            : addStation(local, { stationId: station.stationId, key: issued.ingestKey, name: station.name, stationType: station.stationType }),
        );
        station.key = issued.ingestKey;
        showCredentials(issued.stationId, issued.ingestKey);
      } catch (err) {
        showError(handleFailure(err, "Could not rotate the key"));
      }
    }
  });

  list.addEventListener("submit", async (e) => {
    const formEl = (e.target as HTMLElement).closest<HTMLFormElement>("[data-reading-form]");
    if (!formEl) return;
    e.preventDefault();
    const li = formEl.closest<HTMLElement>("[data-station]")!;
    const station = stations.find((s) => s.stationId === li.dataset.stationId);
    const result = q("[data-station-result]", li)!;
    if (!station) return;

    const raw: Record<string, string> = {};
    for (const input of formEl.querySelectorAll<HTMLInputElement>("[data-reading-input]")) raw[input.name] = input.value;
    const parsed = parseReadingInput(raw);
    if (!parsed.ok) {
      result.textContent = parsed.error;
      return;
    }
    const button = formEl.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    button.disabled = true;
    result.textContent = "Saving";
    try {
      const res = await api.submitReading(station.stationId, parsed.value, station.access === "key" ? station.key : undefined);
      result.textContent = describeReadingResult(res);
      if (res.qcStatus === "validated") formEl.reset();
      await refreshStatus(station);
    } catch (err) {
      result.textContent = handleFailure(err, "Submit failed");
    } finally {
      button.disabled = false;
    }
  });

  // Theme: class-based dark mode, preference kept in localStorage.
  const store = storage();
  const saved = parseThemePreference(store?.getItem(THEME_KEY));
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="theme"]');
  for (const r of radios) {
    r.checked = r.value === saved;
    r.addEventListener("change", () => {
      const pref = parseThemePreference(r.value);
      try {
        store?.setItem(THEME_KEY, pref);
      } catch {
        // Preference just won't persist.
      }
      document.documentElement.classList.toggle("dark", resolveDark(pref, matchMedia("(prefers-color-scheme: dark)").matches));
    });
  }

  void loadAll();
}

init();
document.addEventListener("astro:page-load", init);
