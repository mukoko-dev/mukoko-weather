# Suggested CLAUDE.md wording for the in-app notifications centre (#289)

Do not apply from the PR (CLAUDE.md is development guidance and is edited
by the owner's agent). Suggested edits, in the order they appear in CLAUDE.md.

## Project Structure (add under `src/components/`, next to `layout/`)

```
│   │   ├── notifications/            # The notifications centre (#289): what the header's bell and the phone menu's Notifications row open
│   │   │   ├── NotificationsCentre.tsx   # The container: ONE component, two shells. A bottom sheet on phones (the shared DetailSheet), a popover under the bell from `sm`; the settings always in the sheet. Mounted only while `notificationsOpen`, lazily loaded by Header
│   │   │   ├── NotificationsPanel.tsx    # The alerts list (store-free `NotificationsPanelView`): alert cards, honest empty state, "Report flooding" / "Report wildfire", link to the settings
│   │   │   ├── NotificationSettings.tsx  # The settings (store-free `NotificationSettingsView`): Frost / Lightning / Wildfire / Flooding switches, quiet hours, Delivery (in the app, push, Telegram and Campfire "Coming soon")
│   │   │   └── notifications.test.ts, entry-points.test.ts
```

and under `src/components/weather/`: `ToggleRow.tsx` (the one on/off switch row, `.bushbuck` + `role="switch"`, shared by the settings).

And under `src/lib/`:

```
│   │   ├── alerts.ts              # In-app alerts (pure): frost / lightning / flooding advisories from a stored forecast, flooding / wildfire from community reports; ALERT_THRESHOLDS (untuned, tune with data); the wording rules
│   │   ├── alerts-source.ts       # Where the alerts read from on the device: the device store (readPlaces, read-only) + the shared Worker store (peekSettled only). Never a request per place
│   │   ├── alerts-watch.ts        # watchAlerts: event-driven (place stored, reports changed, places/choices changed, tab visible); no timer. Loaded on demand
│   │   ├── use-alerts.ts          # useAlertSnapshot / useAlertBadge (the bell's dot, after the first idle moment)
│   │   ├── notification-prefs.ts  # The person's choices (kinds, quiet hours on their own clock), defaults, sanitising; RxDB `preferences.notificationPrefs` (schema v4, device-local)
│   │   ├── notification-delivery.ts # pushRow(): the honest state of "Push on this device"; the Delivery rows
│   │   ├── use-device-push.ts     # The push row wired to push/client.ts; the permission prompt only follows the tap
│   │   └── use-media-query.ts     # useMediaQuery / PHONE_QUERY
```

## A new section after "Header & My Weather Modal"

### Notifications centre (alerts for your places, #289)

The header's bell and the phone menu's Notifications row open the SAME centre
(`openNotifications()` in the store; `notificationsOpen`, `notificationsView`
`"list" | "settings"`). My Weather's Settings tab ("Notification settings") and
`/profile` ("Notifications" row) open the settings view. A phone gets the shared
`DetailSheet`; from `sm` the list is a popover under the bell and the settings a
sheet. Mounted on demand, never in a page's first-load JavaScript; the bell's dot
is computed after the first idle moment.

- **Where alerts come from (honestly).** Frost, lightning and flooding are ADVISORIES
  derived on the device from the forecast already stored (`weather_places`, read-only
  through `readPlaces`, which does not touch the LRU stamp): "Frost advisory", "from the
  forecast, not an official warning", "possible" / "likely", never "will" or
  "guaranteed", with "Forecast as of HH:MM (Place time)" in the PLACE's time zone.
  Flooding and wildfire are also read from community reports (`weather.weather_reports`,
  last 24 h) and shown as "Community report, unverified" (unverified reports never rank
  above "high"). There is NO model-derived wildfire alert: a wildfire exists in the list only
  because someone reported one. No emergency numbers are ever written ("call your local
  emergency services").
- **Thresholds** are one table, `ALERT_THRESHOLDS` in `src/lib/alerts.ts`, marked untuned.
  Frost is the app's own rule (`isFrostHour` / `checkFrostRisk`); lightning is 40 / 70 % of the
  thunderstorm insight (trusted for an hour after the fetch) or 1 / 3 thunderstorm-code hours
  in the next 24 h (a hail code is high); flooding is 40 / 70 mm over the next 24 h or a
  heaviest hour at the radar legend's "Very heavy" / "Intense" bands (24 / 47 mm/h). A forecast
  older than 6 h is not used.
- **No fan-out, no polling.** Alerts read what the app already holds. `watchAlerts` looks
  again only on an event: a place stored, the held reports changed, the places or choices
  changed, the tab visible again. The one added request: opening the centre reads the
  community reports for the place ON SCREEN through the shared store (deduped with the
  report lane and card, kept a minute); never one per saved place.
- **Settings** (RxDB `preferences.notificationPrefs`, schema v4, migration v3 to v4; the
  Worker's device-profile sync does not carry it yet): Frost, Lightning, Wildfire, Flooding
  (all ON by default), quiet hours (off by default, whole hours on the person's own clock;
  in this version they pause the bell's dot, the list still shows alerts), and Delivery:
  "In the app" always on, "Push on this device" (honest states: unsupported, iOS needs Add
  to Home Screen, blocked, "Not switched on yet", on, error; behind `FLAGS.web_push`, off
  until the alert service is live; no button unless it can act; the permission prompt only
  follows a tap), Telegram and Campfire "Coming soon" (no control, no backend).
- **Reporting from an alert.** `openReportModal({ reportType, locationSlug })` opens the
  wizard on the type and the alert's place (the centre closes first: one dialog at a time).
  "Report wildfire" appears only when `REPORT_TYPES` has `wildfire` (the Workers' allowlist
  and `report-types.test.ts` pin the two lists together), "Report flooding" today.
- Guards: `src/components/notifications/notifications.test.ts`, `src/lib/alerts.test.ts`
  (every branch of every rule and the wording rules), `alerts-watch.test.ts` (no polling),
  `scripts/browser-check/notifications.mjs` (real browser).
