// The routes, as pure functions over the stores: a method, a path, a query
// and a parsed body in; a status and a JSON body out. No Request, no
// Response, no driver, so they run (and are tested) anywhere.
//
//   POST /devices           {deviceId?, preferences?}   → 201 profile (existing id: that profile)
//   GET  /devices/{id}                                  → 200 profile | 404
//   PATCH /devices/{id}     a partial preferences obj.  → 200 profile | 404 | 400
//   POST /reports           a validated report          → 201 {id, verified, expiresIn}
//   GET  /reports?slug=..[&slug=..][&hours=][&limit=]   → 200 {reports}
//   POST /reports/upvote    {reportId, voter}           → 200 {upvoted[, reason]}
//
// Errors use the Workers' envelope: {error, error_description}.

import type { DeviceStore, ReportStore } from "./stores";
import {
  isRecord,
  ttlSeconds,
  validDeviceId,
  validatePatch,
  validatePreferences,
  validateListQuery,
  validateReport,
  validateUpvote,
} from "./validate";

export interface Stores {
  devices: DeviceStore;
  reports: ReportStore;
}

export interface Result {
  status: number;
  body: unknown;
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  /** The parsed JSON body; `undefined` when there was none. */
  body: unknown;
}

export interface Deps {
  stores: Stores;
  now: () => Date;
  randomId: () => string;
}

export function fail(status: number, code: string, description: string): Result {
  return { status, body: { error: code, error_description: description } };
}

const badRequest = (detail: string): Result => fail(400, "invalid_request", detail);

/** Whether a path is one this Worker serves (so `/health` never opens a connection). */
export function needsStores(path: string): boolean {
  return path === "/devices" || path.startsWith("/devices/") || path === "/reports" || path === "/reports/upvote";
}

export async function route(call: Call, deps: Deps): Promise<Result> {
  const { method, path } = call;
  if (path === "/devices") {
    return method === "POST" ? createDevice(call, deps) : notAllowed("POST /devices");
  }
  if (path.startsWith("/devices/")) {
    const id = path.slice("/devices/".length);
    if (id.includes("/")) return fail(404, "not_found", "No such route.");
    if (method === "GET") return getDevice(id, deps);
    if (method === "PATCH") return patchDevice(id, call, deps);
    return notAllowed("GET or PATCH /devices/{id}");
  }
  if (path === "/reports") {
    if (method === "POST") return submitReport(call, deps);
    if (method === "GET") return listReports(call, deps);
    return notAllowed("POST or GET /reports");
  }
  if (path === "/reports/upvote") {
    return method === "POST" ? upvoteReport(call, deps) : notAllowed("POST /reports/upvote");
  }
  return fail(404, "not_found", "No such route.");
}

function notAllowed(use: string): Result {
  return fail(405, "method_not_allowed", `Use ${use}.`);
}

async function createDevice(call: Call, deps: Deps): Promise<Result> {
  const body = call.body;
  if (!isRecord(body)) return fail(422, "invalid_request", "The body is not a valid device profile.");
  const supplied = body.deviceId;
  let deviceId: string;
  if (supplied === undefined || supplied === null || supplied === "") {
    deviceId = deps.randomId();
  } else if (typeof supplied === "string" && validDeviceId(supplied)) {
    deviceId = supplied;
  } else {
    return badRequest("Invalid device id");
  }
  const prefs = validatePreferences(body.preferences);
  if (!prefs.ok) return badRequest(prefs.detail);
  const profile = await deps.stores.devices.create(deviceId, prefs.value, deps.now());
  return { status: 201, body: profile };
}

async function getDevice(id: string, deps: Deps): Promise<Result> {
  if (!validDeviceId(id)) return fail(404, "not_found", "Device profile not found");
  const profile = await deps.stores.devices.find(id);
  return profile ? { status: 200, body: profile } : fail(404, "not_found", "Device profile not found");
}

async function patchDevice(id: string, call: Call, deps: Deps): Promise<Result> {
  if (!isRecord(call.body)) {
    return fail(422, "invalid_request", "The body is not a valid preferences update.");
  }
  if (!validDeviceId(id)) return fail(404, "not_found", "Device profile not found");
  const set = validatePatch(call.body);
  if (!set.ok) return badRequest(set.detail);
  const profile = await deps.stores.devices.patch(id, set.value, deps.now());
  return profile ? { status: 200, body: profile } : fail(404, "not_found", "Device profile not found");
}

async function submitReport(call: Call, deps: Deps): Promise<Result> {
  if (!isRecord(call.body)) return fail(422, "invalid_request", "The body is not a valid report.");
  const report = validateReport(call.body);
  if (!report.ok) return badRequest(report.detail);
  const now = deps.now();
  const ttl = ttlSeconds(report.value.severity);
  const id = await deps.stores.reports.insert(report.value, now, new Date(now.getTime() + ttl * 1000));
  return { status: 201, body: { id, verified: report.value.verified, expiresIn: ttl } };
}

async function listReports(call: Call, deps: Deps): Promise<Result> {
  const q = validateListQuery(call.query);
  if (!q.ok) return badRequest(q.detail);
  const now = deps.now();
  const cutoff = new Date(now.getTime() - q.value.hours * 3_600_000);
  const reports = await deps.stores.reports.recent(q.value.keys, cutoff, now, q.value.limit);
  return { status: 200, body: { reports } };
}

async function upvoteReport(call: Call, deps: Deps): Promise<Result> {
  if (!isRecord(call.body)) return fail(422, "invalid_request", "The body is not a valid upvote.");
  const vote = validateUpvote(call.body);
  if (!vote.ok) return badRequest(vote.detail);
  const added = await deps.stores.reports.upvote(vote.value.reportId, vote.value.voter);
  return {
    status: 200,
    body: added ? { upvoted: true } : { upvoted: false, reason: "Already upvoted or report not found" },
  };
}
