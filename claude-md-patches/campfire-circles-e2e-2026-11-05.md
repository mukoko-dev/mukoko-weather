# Suggested CLAUDE.md additions (owner, 2026-11-05, later) — apply by hand; agents never edit CLAUDE.md

This supersedes `owner-conventions-2026-11-05.md` where it names Telegram.

## Messaging
Mukoko builds its own messaging; **Telegram is not used** ("Not telegram, we build our own"). **Campfire** (chats) and **Circles** (people in the same region talking about weather) are backends served on all three gateways (Nyuchi API, Nyuchi Servers API, Mukoko API), built in Rust, with Rust Workers serving the different platform apps. Messages are **end-to-end encrypted** (MLS, RFC 9420). Alerts are pushed through Campfire from a verified first-party sender; the person can stop them in their notification setup. In the weather app Campfire opens from the account (avatar) menu, and the account and My Location icons swap places on phones. Tracking: nyuchi/nyuchi-api#484.

Where to put it: Tech Stack and the Header & My Weather Modal section (replace "Telegram and Campfire" wording in the notification delivery notes; v0.27.0 release note is history and stays).

## AI models
Every model that writes an answer is a **GLM** model (`@cf/zai-org/glm-*`); anything else falls back to `DEFAULT_MODEL`. See `glm-only.md`. Decision models (Cloudflare Clef) are a separate role, tracked in mukoko-dev/mukoko-weather (Clef issue).
