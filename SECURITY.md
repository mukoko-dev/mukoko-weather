# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | Yes                |

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

- The `ANTHROPIC_API_KEY` is a server-side environment variable and is never exposed to the client
- The AI API route (`/api/ai`) is a server-side POST endpoint — the key never leaves the server

### External APIs

- **Open-Meteo** — public API, no authentication required, no user data transmitted
- **Anthropic Claude** — server-side only, weather data is the only payload (no PII)

### Data Privacy

- mukoko weather does **not** collect, store, or transmit personal user data
- Browser geolocation is requested via the standard Geolocation API and is only used client-side to determine the nearest Zimbabwe location
- No cookies, analytics trackers, or third-party scripts are loaded (apart from Google Fonts)
- Cloudflare KV caching stores only AI-generated weather summaries keyed by location slug — no user data

### Content Security

- CORS headers are restricted to API and embed routes only
- All external links use `rel="noopener noreferrer"`
- No user-generated content is rendered (all weather data comes from trusted APIs)

## Dependencies

We keep dependencies minimal and up to date. The production dependency footprint is:
- `next` — framework
- `react` / `react-dom` — UI
- `@anthropic-ai/sdk` — AI summaries (server-side only)
- `zustand` — client-side state
