# Suggested CLAUDE.md additions (owner, 2026-11-05) — apply by hand; agents never edit CLAUDE.md

## Messaging channels
Mukoko's own messaging channels are **Telegram** and **Campfire** (Nyuchi's own). Alert delivery is web push, Telegram and Campfire. SMS/WhatsApp through a third-party SDK (for example the `sent` crate) is NOT adopted.

## Pricing
All pricing is shown **in yuan (CNY) by default, converted to ZiG in Zimbabwe and to USD elsewhere**. Applies to any future paid tier (the premium/entitlement work, #238).

## Alerts (in-app)
Four kinds: frost, lightning, wildfire, flooding. Forecast-derived alerts are **advisories** ("from the forecast, not an official warning"); official CAP warnings are a separate, labelled source. Community reports are shown as unverified and never trigger a push to other people. Delivery is best effort and never described as guaranteed.
