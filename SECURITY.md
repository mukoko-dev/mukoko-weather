# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in mukoko weather, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **<security@nyuchi.com>**

Include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide an update within 7 days.

## Security Considerations

### API Keys

- **Model access** — there is no model API key in this repository's deployments. Every model call is a native Workers AI binding call in the AI Worker through the `shamwari` AI Gateway, so no Cloudflare AI or third-party model token exists on Vercel or in the browser. The Workers' secrets live in the Cloudflare Secrets Store
- **Provider API keys (Tomorrow.io, CheckWX, ...)** — Worker secrets in the Cloudflare Secrets Store, read by the Workers only, never in the client or the repository. The legacy MongoDB copy (`weather.api_keys`, still written by `setApiKey` via `POST /api/db-init`) was read only by the deleted Python backend; nothing reads it now, and removing that write path and the collection is a tracked follow-up
- **`DB_INIT_SECRET`** — optional server-side environment variable protecting the `/api/db-init` endpoint in production (via `x-init-secret` header)

### External APIs

- **Tomorrow.io** — server-side only; weather data is the only payload (no PII). The API key is a Worker secret
- **Open-Meteo** — public API, no authentication required, no user data transmitted
- **Workers AI (open-weights models)** — server-side only, in the AI Worker; weather data is the only payload, and prompts carrying personal data are refused (`422 personal_data_detected`)

### Data Privacy

- mukoko weather does **not** collect, store, or transmit personally identifiable information (PII)
- Browser geolocation is requested via the standard Geolocation API — coordinates are sent to the server only to find/create the nearest location and are not stored against any user identity
- User preferences (theme, selected activities, selected location) are stored locally in the browser via `localStorage` and synced to a server-side device profile keyed by a random UUID — no personal identity is attached
- Device profiles (`device_profiles` collection) store only preferences (theme, location slug, activity IDs) — no IP addresses, emails, or personal data
- MongoDB stores weather cache data, AI-generated summaries, historical weather records, location metadata, and anonymous device profiles — no user data beyond preferences

### Analytics

- **Google Analytics 4** (GA4) is used for anonymised page views, visitor counts, and navigation patterns
- GA4 uses cookies — this is disclosed in the [privacy policy](/privacy)
- No personally identifiable information (PII) is collected
- GA4 error exception events are used for client-side error monitoring (error boundaries, error pages)
- Users can opt out via browser settings or the Google Analytics opt-out extension

### Shamwari AI Chat (`POST /v1/ai/chat`, the AI Worker)

The chat runs on the Rust AI Worker (`workers/ai`), reached through `mukoko-weather-api`; the Python `/api/py/chat` was deleted. Its security controls:

- **Rate limiting** — 10 requests a minute per client (the Worker's rate-limit binding, keyed by the visitor's address as the public API passes it on). The Python route's 20 requests an hour has no equivalent here.
- **Input validation** — message must be a non-empty string, max 2000 characters; history capped at 10 turns, each cut to 2000 characters, roles limited to `user` and `assistant`; activity ids are shape-checked before they reach a prompt
- **Personal data** — a message or history turn with an email address, phone number or card number is refused (`422 personal_data_detected`) before any model call
- **Guardrails** — the Nyuchi API's compiled guardrails block goes first in the system prompt; without one the Worker answers `503` and never calls the model. The `shamwari` AI Gateway adds Guardrails and DLP, and a block is answered with a polite refusal
- **No tools** — the model cannot call anything; the weather for the places named is fetched by the Worker and put in the prompt
- **Client-side error isolation** — `MarkdownErrorBoundary` wraps markdown rendering in the chatbot UI; malformed markdown degrades to plain text instead of crashing the chat

### Rate Limiting

The Python backend and its MongoDB-backed IP rate limiter are deleted (#333). The Workers' hourly limits (the report routes here) are kept in D1 `rate_events`, per client address hash:

| Endpoint               | Limit       |
| ---------------------- | ----------- |
| `/v1/reports` (submit) | 5 req/hour  |
| `/v1/reports/clarify`  | 10 req/hour |

The routes on the Rust Workers keep their limits in the Workers' own D1 table `rate_events` (`weather_core::budget`; the client is a SHA-256 of the visitor's address, never the address). The AI location search (`/v1/ai/explore/search`, 15 an hour per client) and the AI history analysis (`/v1/ai/history/analyze`, 10 an hour per client) fail closed: when the budget cannot be read, the model is not called. The signed-in app's model routes (the summary, the follow-up chat and the agriculture explanation, on the AI Worker's `/internal/*` paths, reached only through the app's WorkOS-checked `/api/ai` proxy and `mukoko-weather-internal`) are counted per person instead, 30 model calls an hour each (a cached answer is free), and fail closed the same way. See `workers/README.md`.

### Circuit Breakers

`weather_core::breaker` — Netflix Hystrix-inspired circuit breaker for external API resilience, per provider and per Worker isolate, so a failing provider is not hammered (Open-Meteo: 5 failures in 5 minutes open it for 5; Tomorrow.io and the other providers: 3 failures in 5 minutes open it for 2; SoilGrids 3 in 10 for 15). Only a 5xx, a 429, a transport error, a timeout or an unreadable body counts as a failure.

### Content Security

- CORS headers are restricted to `https://weather.mukoko.com` and `http://localhost:3000` (not wildcard)
- All external links use `rel="noopener noreferrer"`
- No user-generated content is rendered — all weather data comes from trusted APIs
- AI-generated summaries are rendered via `react-markdown` with default sanitisation
- Community weather reports are structured data (type + severity + optional notes) — not free-form HTML

### Error Handling & Observability

- Structured error logging (`src/lib/observability.ts`) outputs JSON to stdout for Vercel Log Drains
- Error logs contain only technical context (error source, severity, location slug, error message) — no user data
- Client-side errors are reported to GA4 as anonymised exception events

## Dependencies

We keep dependencies minimal and up to date. Key production dependencies:

- `next` — framework
- `react` / `react-dom` — UI
- `mongodb` — database client (TypeScript, used by db-init and OG routes)
- `zustand` — client-side state
- `radix-ui` — accessible UI primitives (via shadcn/ui)
- `chart.js` + `react-chartjs-2` — Canvas 2D chart rendering
- `react-markdown` — markdown rendering (AI summaries)
- the Rust Workers' crates (`worker`, `serde`, `futures`, ...) — the backend, server-side only; see `workers/Cargo.toml` and `workers/Cargo.lock`

GitHub Dependabot and CodeQL are enabled for automated vulnerability scanning.
