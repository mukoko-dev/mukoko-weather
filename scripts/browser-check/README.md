# Real-browser checks

Chromium checks of the production build, for what unit tests cannot see: the service worker, the offline page, in-place place switching and a forecast that does not arrive (issue #414). They read the public weather API through the test browser and refuse every write, so nothing is created in production.

Playwright is not a dependency of this repo. Run them where it is installed, or point `NODE_PATH` at its `node_modules`.

```bash
npm run build && npx next start -p 3100 &
BASE=http://localhost:3100 SHOTS=/tmp/shots node scripts/browser-check/pwa-check.mjs
```

| Script              | What it proves                                                                                                                                                                                                                                                     | Takes |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `pwa-check.mjs`     | The shell, the worker, switching places without a reload, offline launch (a stored place and a never-stored one), and the slow-forecast line (none before 8 s, one calm line and "Try again" after, no layout shift, "Couldn't load" after the retries, recovery). | 90 s  |
| `offline-shell.mjs` | Five fresh browsers launched offline: `/` paints the saved place, `/lagos-ng` shows the "You're offline" page and not the error boundary, with no `/_next/` request failing.                                                                                       | 80 s  |
| `offline-retry.mjs` | The offline page's chunk is refused at install, so it is not stored; one online navigation a minute later stores it (as a script, never as HTML); offline then works.                                                                                              | 90 s  |

`harness.mjs` holds what they share. Exit code 0 is a pass, 1 a failed check, 2 a crash of the harness itself.

Not covered: iOS Safari, Android, a real home-screen install. Those need a device.
