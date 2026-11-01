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

- **`ANTHROPIC_API_KEY`** — server-side environment variable, never exposed to the client. Used only in Python backend endpoints (`api/py/_ai.py`, etc.)
- **Tomorrow.io API key** — stored in MongoDB (`api_keys` collection via `getApiKey`/`setApiKey` in `src/lib/db.ts`), never in environment variables or client-side code. Seeded via `POST /api/db-init`
- **`DB_INIT_SECRET`** — optional server-side environment variable protecting the `/api/db-init` endpoint in production (via `x-init-secret` header)

### External APIs

- **Tomorrow.io** — server-side only; weather data is the only payload (no PII). API key stored in MongoDB, not environment variables
- **Open-Meteo** — public API, no authentication required, no user data transmitted
- **Anthropic Claude** — server-side only via Python FastAPI; weather data is the only payload (no PII)

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

All rate-limited endpoints use a MongoDB-backed IP rate limiter (`check_rate_limit` in `api/py/_db.py`) with atomic `findOneAndUpdate` and TTL index:

| Endpoint                   | Limit       |
| -------------------------- | ----------- |
| `/api/py/ai/followup`      | 30 req/hour |
| `/api/py/locations/add`    | 5 req/hour  |
| `/api/py/reports` (submit) | 5 req/hour  |
| `/api/py/reports/clarify`  | 10 req/hour |

The routes on the Rust Workers keep their limits in the Workers' own D1 table `rate_events` (`weather_core::budget`; the client is a SHA-256 of the visitor's address, never the address). The AI location search (`/v1/ai/explore/search`, 15 an hour per client) and the AI history analysis (`/v1/ai/history/analyze`, 10 an hour per client) fail closed: when the budget cannot be read, the model is not called. See `workers/README.md`.

### Circuit Breaker System

`api/py/_circuit_breaker.py` — Netflix Hystrix-inspired circuit breaker for external API resilience. Per-provider singleton breakers prevent cascade failures:

- `tomorrow_breaker` — Tomorrow.io API (3 failures / 2min cooldown)
- `open_meteo_breaker` — Open-Meteo API (5 failures / 5min cooldown)
- `anthropic_breaker` — Anthropic Claude API (3 failures / 5min cooldown)

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
- `fastapi` + `pymongo` + `anthropic` + `httpx` — Python backend (server-side only)

GitHub Dependabot and CodeQL are enabled for automated vulnerability scanning.
