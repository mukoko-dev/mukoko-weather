/**
 * TEST SUPPORT, not shipped: the pinned `validate_doc_update` of a person's own
 * CouchDB database (`__fixtures__/couch_validate_personal.fn.txt`, a verbatim copy
 * of nyuchi-api `gateway/lib/couch_validate_personal.js`), loaded and run, and the
 * facts the tests need from it read out of its embedded schemas.
 *
 * The validator is EXECUTED, not described: `validateDoc` runs the function as
 * CouchDB would (a server-side `validate_doc_update`: `newDoc`, `oldDoc`,
 * `userCtx` with the database's name, the security document), with the server's
 * clock injectable because the function reads `Date.now()` (a document whose
 * `updatedAt` is more than a day ahead is refused).
 *
 * The facts (`validatorForecastModels()` and friends) are parsed from the schema
 * lines of the pinned file, so the lists the client keeps (`couch-docs.ts`) are
 * tested against the validator and not against a second hand-written copy.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

export type Json = Record<string, unknown>;

export type Validator = (
  newDoc: Json,
  oldDoc: Json | null,
  userCtx: { name: string | null; db?: string; roles: string[] },
  secObj: { members: { names: string[] } },
) => void;

const FIXTURE = join(__dirname, "..", "__fixtures__");

/** The pinned fixture's text: the header, the marker line and the gateway's file. */
export function pinnedFixtureText(): string {
  return readFileSync(join(FIXTURE, "couch_validate_personal.fn.txt"), "utf8");
}

/** The sidecar that says where the fixture came from (commit, date, hashes). */
export function pinnedFixtureSource(): {
  repo: string;
  ref: string;
  path: string;
  lastChangeCommit: string;
  lastChangeDate: string;
  stagingHeadWhenRead: string;
  readOn: string;
  blobSha: string;
  sha256: string;
  nyuchiApiPin: { file: string; dataInfraCommit: string; sha256: string };
  marker: string;
  note: string;
} {
  return JSON.parse(
    readFileSync(join(FIXTURE, "couch_validate_personal.source.json"), "utf8"),
  );
}

/** The gateway's file alone: everything after the marker line. */
export function pinnedGatewayFile(): string {
  const text = pinnedFixtureText();
  const { marker } = pinnedFixtureSource();
  const at = text.indexOf(marker);
  if (at < 0) throw new Error("the fixture has lost its marker line");
  return text.slice(at + marker.length);
}

/**
 * Load the validator. `serverNowMs` stands for the CouchDB server's clock, which
 * the function reads through `Date.now()`: it runs in its own context with that
 * one method replaced and the rest of `Date` as it is.
 */
export function loadValidator(
  serverNowMs: () => number = () => Date.now(),
): Validator {
  const RealDate = Date;
  const ServerDate = new Proxy(RealDate, {
    get(target, prop, receiver) {
      if (prop === "now") return () => serverNowMs();
      return Reflect.get(target, prop, receiver);
    },
  });
  // The pinned fixture is one function expression (a repo file, never input).
  return runInNewContext(`(${pinnedGatewayFile()})`, {
    Date: ServerDate,
  }) as Validator;
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/**
 * Run the validator on one document written by `personId` into their own
 * database `user_<personId>`, as CouchDB would. A refusal is `{ok: false}` with
 * the validator's own reason; a thrown `unauthorized` is reported as one too.
 */
export function validateDoc(
  doc: Json,
  options: {
    personId?: string;
    /** The database the write goes to (default: the person's own). */
    database?: string;
    oldDoc?: Json | null;
    serverNowMs?: () => number;
    validator?: Validator;
  } = {},
): Verdict {
  const personId = options.personId ?? "person-1";
  const validator = options.validator ?? loadValidator(options.serverNowMs);
  try {
    validator(
      doc,
      options.oldDoc ?? null,
      {
        name: personId,
        db: options.database ?? `user_${personId}`,
        roles: [],
      },
      { members: { names: [personId] } },
    );
    return { ok: true };
  } catch (err) {
    const e = err as { forbidden?: string; unauthorized?: string };
    if (e.forbidden !== undefined) return { ok: false, reason: e.forbidden };
    if (e.unauthorized !== undefined) {
      return { ok: false, reason: `unauthorized: ${e.unauthorized}` };
    }
    throw err;
  }
}

/**
 * An envelope the validator accepts for the document `id` (the JWE members in
 * their forms: a protected header `{alg: "dir", enc: "A256GCM", kid}` and the
 * `aad` that names the document). The ciphertext is not one: the validator
 * checks forms, not keys. For tests that need ANOTHER client's encrypted
 * document on the server, which this client must never store or push.
 */
export function envelopeFor(id: string): Json {
  const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
  return {
    protected: b64u(
      '{"alg":"dir","enc":"A256GCM","kid":"mukoko-test-key-0001"}',
    ),
    aad: b64u(id),
    iv: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA",
  };
}

// ---------------------------------------------------------------------------
// Facts read out of the embedded schemas
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

/** The type schemas the function embeds (`var SCHEMAS = {...}`), by type name. */
export function validatorSchemas(): Record<string, Schema> {
  const out: Record<string, Schema> = {};
  for (const line of pinnedGatewayFile().split("\n")) {
    const m = /^ {4}"([A-Za-z]+)": (\{.*\}),?\s*$/.exec(line);
    if (m) out[m[1]] = JSON.parse(m[2]) as Schema;
  }
  return out;
}

/** The `then.properties.preferenceValue` rule the preference schema holds for a key. */
function preferenceValueRule(key: string): Schema | undefined {
  const schema = validatorSchemas().preference as {
    allOf?: {
      if?: { properties?: { preferenceKey?: { const?: string } } };
      then?: { properties?: { preferenceValue?: Schema } };
    }[];
  };
  for (const rule of schema.allOf ?? []) {
    if (rule.if?.properties?.preferenceKey?.const === key) {
      return rule.then?.properties?.preferenceValue;
    }
  }
  return undefined;
}

/** The `preferenceKey` values the validator lists. */
export function validatorPreferenceKeys(): string[] {
  const schema = validatorSchemas().preference as {
    properties: { preferenceKey: { enum: string[] } };
  };
  return schema.properties.preferenceKey.enum;
}

/** The ids of `forecastModel` the validator allows (its enum). */
export function validatorForecastModels(): string[] {
  const rule = preferenceValueRule("forecastModel") as
    | { enum?: string[] }
    | undefined;
  if (!rule?.enum) throw new Error("no forecastModel enum in the validator");
  return rule.enum;
}

/** The `theme` values the validator allows (its enum). */
export function validatorThemeValues(): string[] {
  const rule = preferenceValueRule("theme") as { enum?: string[] } | undefined;
  if (!rule?.enum) throw new Error("no theme enum in the validator");
  return rule.enum;
}

/** The document types the validator accepts. */
export function validatorTypes(): string[] {
  return Object.keys(validatorSchemas());
}
