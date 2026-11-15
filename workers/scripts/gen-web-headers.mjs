// Writes workers/web/routing/security-headers.json: a snapshot of the table in
// src/lib/security-headers.ts (the security headers the web build sends), so
// the Rust web Worker (workers/web) cannot drift from it. The Rust tests in
// weather-core (`web::headers`) compare their copy of the table to this file;
// CI runs this script with --check, which fails when the snapshot is not what
// the TypeScript produces. Run from the repo root:
//   node --experimental-strip-types workers/scripts/gen-web-headers.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { relative, resolve } from "node:path";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const root = resolve(import.meta.dirname, "..", "..");
const out = resolve(root, "workers/web/routing/security-headers.json");
const load = (f) => import(pathToFileURL(resolve(root, "src/lib", f)).href);

const headers = await load("security-headers.ts");
const bare = await load("bare-origin.ts");

// Inputs the Rust parser must agree with the TypeScript on. Add a vector when
// a case is found that the two could read differently.
const BARE_ORIGIN_INPUTS = [
  "https://api.nyuchi.com",
  "https://api.nyuchi.com/",
  "https://api.nyuchi.com:8443",
  "https://api.nyuchi.com:443",
  "HTTPS://Example.COM:443/",
  "http://localhost:3000",
  "http://127.0.0.1:8787",
  "http://example.com",
  "https://user:pw@example.com",
  "https://example.com/v1",
  "https://example.com?x=1",
  "https://example.com#f",
  "https://example.com:99999",
  "ftp://example.com",
  "api.nyuchi.com",
  "",
  "not a url",
];

const snapshot = {
  generatedBy:
    "workers/scripts/gen-web-headers.mjs from src/lib/security-headers.ts",
  csp: headers.buildCsp(),
  cspReportPath: headers.CSP_REPORT_PATH,
  cspWithExtra: headers.buildCsp(headers.CSP_REPORT_PATH, [
    "https://staging.example.test",
  ]),
  baseline: headers.BASELINE_HEADERS,
  frame: [headers.FRAME_HEADER],
  frameablePaths: headers.FRAMEABLE_PATHS,
  corsOpen: headers.CORS_POLICY.open,
  corsHeaders: headers.CORS_POLICY.headers,
  bareOrigin: BARE_ORIGIN_INPUTS.map((input) => ({
    input,
    origin: bare.parseBareOrigin(input),
  })),
};

const text = `${JSON.stringify(snapshot, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current;
  try {
    current = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    current = null;
  }
  if (JSON.stringify(current) !== JSON.stringify(snapshot)) {
    console.error(
      `${relative(root, out)} is stale: src/lib/security-headers.ts changed.\n` +
        "Run: node --experimental-strip-types workers/scripts/gen-web-headers.mjs\n" +
        "then update workers/crates/weather-core/src/web/headers.rs to match.",
    );
    process.exit(1);
  }
  console.log(`${relative(root, out)} is current`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${relative(root, out)}`);
}
