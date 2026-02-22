# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in mukoko weather, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email: **legal@nyuchi.com**

Include:
- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide an update within 7 days.

## Security Considerations

### API Keys

- **`ANTHROPIC_API_KEY`** — server-side environment variable, never exposed to the client. Used only in `POST /api/ai` (server-side route)
- **Tomorrow.io API key** — stored in MongoDB (`api_keys` collection via `getApiKey`/`setApiKey` in `src/lib/db.ts`), never in environment variables or client-side code. Seeded via `POST /api/db-init`
- **`DB_INIT_SECRET`** — optional server-side environment variable protecting the `/api/db-init` endpoint in production (via `x-init-secret` header)

### External APIs

- **Tomorrow.io** — server-side only; weather data is the only payload (no PII). API key stored in MongoDB, not environment variables
- **Open-Meteo** — public API, no authentication required, no user data transmitted
- **Anthropic Claude** — server-side only; weather data is the only payload (no PII)

### Data Privacy

- mukoko weather does **not** collect, store, or transmit personal user data on its own servers
- Browser geolocation is requested via the standard Geolocation API and is only used client-side to determine the nearest Zimbabwe location — coordinates are not stored or transmitted to our servers
- User preferences (theme and selected activities) are stored locally in the browser via `localStorage` — they never leave the device
- MongoDB stores only weather cache data, AI-generated summaries, historical weather records, and location metadata — no user data

### Analytics

- **Google Analytics 4** (GA4) is used for anonymised page views, visitor counts, and navigation patterns
- GA4 uses cookies — this is disclosed in the [privacy policy](/privacy)
- No personally identifiable information (PII) is collected
- GA4 error exception events are used for client-side error monitoring (error boundaries, error pages)
- Users can opt out via browser settings or the Google Analytics opt-out extension

### Shamwari AI Chatbot (`/api/explore`)

The Shamwari chatbot endpoint has layered security controls:

- **Rate limiting** — 20 requests/hour/IP via MongoDB-backed rate limiter; IP required (rejects requests with no identifiable client). **Deployment constraint:** the rate limiter trusts the first entry in `x-forwarded-for` (Vercel prepends the real client IP). If deployed behind a proxy that does not manage `x-forwarded-for`, the rate limiter can be bypassed by spoofing the header
- **Input validation** — message must be a non-empty string, max 2000 characters; history capped at 10 messages, each truncated to 2000 characters; activities array capped at 10 items
- **Structured messages API** — the Anthropic Messages API sends each turn as a separate object with an explicit role. Legacy boundary markers (`\n\nHuman:`, `\n\nAssistant:`) have no special meaning and cannot inject new turns
- **System prompt guardrails** — DATA GUARDRAILS in the system prompt constrain Claude's response scope to weather-related topics
- **Circuit breaker** — all Anthropic API calls are wrapped in `anthropicBreaker` (3 failures / 5min cooldown); `CircuitOpenError` returns a user-friendly "temporarily unavailable" message
- **Tool execution timeouts** — each tool call has a 15-second timeout (`withToolTimeout`); tool loop bounded at 5 iterations
- **Server-controlled tool output** — Claude never sees raw weather API responses; tool implementations validate inputs (type-checked, string-validated) and return structured data
- **Singleton Anthropic client with key-rotation** — module-level client reused across warm Vercel function invocations; automatically recreated when the API key changes in MongoDB (via db-init key rotation)
- **Tool result caps** — `list_locations_by_tag` capped to 20 results to prevent unbounded context injection; search results capped to 10
- **Client-side error isolation** — `MarkdownErrorBoundary` wraps ReactMarkdown rendering in the chatbot UI; malformed markdown from Claude degrades to plain text instead of crashing the chat

### Content Security

- CORS headers are restricted to `/api/*` and `/embed/*` routes only (configured in `next.config.ts`)
- All external links use `rel="noopener noreferrer"`
- No user-generated content is rendered — all weather data comes from trusted APIs
- AI-generated summaries are rendered via `react-markdown` with default sanitisation

### Error Handling & Observability

- Structured error logging (`src/lib/observability.ts`) outputs JSON to stdout for Vercel Log Drains
- Error logs contain only technical context (error source, severity, location slug, error message) — no user data
- Client-side errors are reported to GA4 as anonymised exception events

## Dependencies

We keep dependencies minimal and up to date. Key production dependencies:

- `next` — framework
- `react` / `react-dom` — UI
- `@anthropic-ai/sdk` — AI summaries (server-side only)
- `mongodb` — database client
- `zustand` — client-side state
- `radix-ui` — accessible UI primitives (via shadcn/ui)
- `chart.js` + `react-chartjs-2` — Canvas 2D chart rendering
- `react-markdown` — markdown rendering (AI summaries)

GitHub Dependabot and CodeQL are enabled for automated vulnerability scanning.
