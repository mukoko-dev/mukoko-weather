// A stand-in for Google's gtag.js, for the first-screen lab harness (#551).
//
// Why it exists. `first-screen.mjs` answers every host that is not the app's
// own itself (`mockNetwork` in memory-harness.mjs), and for the Google tag that
// answer used to be a refusal, so the largest third-party cost of the page was
// invisible in every number: the tag for the app's GA4 property is 181 KB
// gzipped and 542 KB decoded (measured 2026-11-13), and a phone has to fetch it
// over the same link as the app's own files and then parse it on the main
// thread. This file makes the lab pay that cost too.
//
// What it is. A generated script, never a committed file (the real tag is
// Google's, changes without notice, and is half a megabyte): minified-looking
// code of about the real file's decoded size (542 KB) that gzips to about the
// real file's wire size (181 KB), so the transfer and the parse are the right
// size. Deterministic (a seeded generator), so two runs of the harness ship
// the same bytes. Parsing it costs little (most of it is function bodies a
// browser skips until they are called), and the real tag costs far more than
// its parse: measured 2026-11-13 on the Pixel 5 profile (4x CPU), it runs two
// long tasks of 170 to 310 ms each (350 to 500 ms in all), the first when it
// arrives and the second about 200 ms later. The stand-in runs two bursts of
// arithmetic of that length (`BURST_ITERATIONS`, set so that each is about
// 190 ms at 4x CPU on the machine that measured the real tag), the second from
// a timer, so a measurement that includes it blocks the main thread as the
// real tag does. They are a stand-in for the real tag's work, not a copy of it.
// `GTAG_FILE` serves a file you saved from the real tag instead, for a
// comparison on your own machine.
//
// What it does not model: the DNS lookup and TLS handshake to Google's host (the
// stand-in is served from the machine under test), a visitor whose browser
// already holds the real file in its HTTP cache (Playwright's request
// interception turns that cache off, so every open fetches it, as a first
// visit would), and a visitor who blocks it.
import http from "node:http";
import zlib from "node:zlib";
import { readFile } from "node:fs/promises";

/** The host the app loads the tag from (GoogleAnalytics.tsx). */
export const GTAG_HOST = "www.googletagmanager.com";
/** The real tag, measured 2026-11-13: decoded and gzipped sizes in bytes. */
export const REAL_GTAG = { decoded: 541_884, gzip: 181_652 };
/** Loop iterations of each of the two bursts of work (see the header). */
export const BURST_ITERATIONS = 36_000_000;

/** mulberry32: a small seeded generator, so the stand-in is the same every run. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789_";

/**
 * The script's text, `decodedBytes` long (to within one statement).
 *
 * `noise` is the share of operands that are random string literals, which do
 * not compress: it sets the gzip ratio. 0.04 gives about 3:1, the real tag's
 * ratio (its 542 KB gzip to 181 KB).
 */
export function gtagStandInSource({
  decodedBytes = REAL_GTAG.decoded,
  seed = 551,
  noise = 0.04,
  burst = BURST_ITERATIONS,
} = {}) {
  const rand = seeded(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const int = (n) => Math.floor(rand() * n);
  const word = (min, max) => {
    let s = pick([...LETTERS]);
    for (let n = min + int(max - min + 1); n > 1; n--) s += pick([...ALNUM]);
    return s;
  };
  // A vocabulary of names, used with a skewed pick so some repeat often (as
  // property names in real code do) and some rarely.
  const names = Array.from({ length: 700 }, () => word(2, 9));
  const name = () => names[Math.floor(rand() ** 2.2 * names.length)];
  const literal = () => {
    let s = "";
    for (let n = 8 + int(40); n > 0; n--) s += pick([...ALNUM]);
    return `"${s}"`;
  };
  const operand = () => {
    const r = rand();
    if (r < noise) return literal();
    if (r < noise + 0.15) return String(int(5000));
    return `${pick(["a", "b", "c", "d", "e"])}.${name()}`;
  };
  const statement = () => {
    switch (int(6)) {
      case 0:
        return `var ${pick(["e", "f", "g", "h"])}=${operand()}||${operand()};`;
      case 1:
        return `if(${operand()}&&${operand()}!==void 0){${pick(["a", "b"])}.${name()}=${operand()}}`;
      case 2:
        return `for(var i=0;i<${pick(["a", "b"])}.length;i++){${pick(["c", "d"])}.${name()}(${operand()},i)}`;
      case 3:
        return `${pick(["a", "b", "c"])}.${name()}(${operand()},${operand()});`;
      case 4:
        return `try{${pick(["c", "d"])}.${name()}=${operand()}}catch(j){${pick(["a", "b"])}.${name()}(j)}`;
      default:
        return `${pick(["e", "f"])}=${operand()}?${operand()}:${operand()};`;
    }
  };
  const lines = [
    "// stand-in for gtag.js (scripts/browser-check/gtag-standin.mjs): generated, not Google's",
    "(function(){",
    "var w=window;w.__gtagStandIn=true;",
  ];
  let size = lines.join("\n").length;
  const tail = "\n})();\n";
  let count = 0;
  while (size < decodedBytes - tail.length) {
    const body = Array.from({ length: 3 + int(8) }, statement).join("");
    const line = `function ${word(2, 3)}${count++}(a,b,c,d){var e,f,g,h;${body}return a}`;
    lines.push(line);
    size += line.length + 1;
  }
  // What runs: two bursts of arithmetic, the second from a timer.
  lines.push(
    `function burst(n){var h=2166136261;for(var i=0;i<n;i++){h=Math.imul(h^i,16777619)}return h}`,
    `w.__gtagStandInSum=burst(${burst});`,
    `setTimeout(function(){w.__gtagStandInSum=burst(${burst})},120);`,
  );
  return lines.join("\n") + tail;
}

/** The bytes the harness serves: `{ body, gzip, fromFile }`. */
export async function gtagBytes({ file = process.env.GTAG_FILE } = {}) {
  const body = file
    ? await readFile(file)
    : Buffer.from(gtagStandInSource(), "utf8");
  return { body, gzip: zlib.gzipSync(body, { level: 6 }), fromFile: !!file };
}

/**
 * Serve the stand-in on `host` (the machine's own address, as the app is), on a
 * free port. It is served for real, over the network the throttle applies to:
 * a response a test tool writes itself (Playwright's `route.fulfill`) does not
 * pass through Chromium's throttled network stack and would arrive for free.
 *
 * Returns `{ origin, requests, decodedKB, gzipKB, fromFile, close }`;
 * `requests` counts the files served, so a run can say when the page never
 * asked for it.
 */
export async function serveGtag({ host, file } = {}) {
  const bytes = await gtagBytes({ file });
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith("/gtag/js")) {
      res.writeHead(404).end();
      return;
    }
    state.requests++;
    const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"]));
    res.writeHead(200, {
      "content-type": "application/javascript; charset=UTF-8",
      // The headers of the real file; `private` so a shared cache keeps out.
      "cache-control": "private, max-age=900",
      "access-control-allow-origin": "*",
      // Without this a cross-origin script reports a size of 0 in the page's
      // resource timing, which is what hid the real one from the numbers.
      "timing-allow-origin": "*",
      vary: "Accept-Encoding",
      ...(gzip ? { "content-encoding": "gzip" } : {}),
    });
    res.end(gzip ? bytes.gzip : bytes.body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const { port } = server.address();
  return {
    origin: `http://${host}:${port}`,
    get requests() {
      return state.requests;
    },
    decodedKB: Math.round(bytes.body.length / 1024),
    gzipKB: Math.round(bytes.gzip.length / 1024),
    fromFile: bytes.fromFile,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Send the page's request for the Google tag to `served` (a `serveGtag`
 * result) with a redirect: the redirect itself is answered here, at once, and
 * the page then fetches the stand-in from a real server through the throttled
 * network. Register it after `mockNetwork` (the route registered last is asked
 * first); it matches only the tag's own URL, so every other request goes on
 * to `mockNetwork` as before.
 */
export async function routeGtag(context, served) {
  await context.route(
    (url) => url.hostname === GTAG_HOST && url.pathname.startsWith("/gtag/js"),
    (route) =>
      route.fulfill({
        status: 302,
        headers: {
          location: `${served.origin}/gtag/js`,
          "timing-allow-origin": "*",
        },
      }),
  );
}
