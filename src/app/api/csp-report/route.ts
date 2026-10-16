import { NextRequest } from "next/server";
import { logWarn } from "@/lib/observability";
import {
  MAX_REPORT_BYTES,
  createReportGate,
  parseCspReports,
} from "@/lib/csp-report";

/**
 * CSP violation collector (report-only rollout, B05). Checks Content-Length
 * before reading the body, keeps only directive + blocked host + coarsened
 * page path, drops browser-extension noise, dedupes and rate-limits per
 * instance, and always answers 204. Stores nothing.
 */
const gate = createReportGate();

export async function POST(request: NextRequest): Promise<Response> {
  const done = () => new Response(null, { status: 204 });
  try {
    const declared = Number(request.headers.get("content-length"));
    if (
      !Number.isFinite(declared) ||
      declared <= 0 ||
      declared > MAX_REPORT_BYTES
    )
      return done();
    const text = await request.text();
    if (text.length > MAX_REPORT_BYTES) return done();
    for (const entry of parseCspReports(JSON.parse(text))) {
      if (!gate.allow(entry)) continue;
      logWarn({
        source: "client-render",
        message: "csp-report-only violation",
        meta: { ...entry },
      });
    }
  } catch {
    /* malformed report: ignore */
  }
  return done();
}
