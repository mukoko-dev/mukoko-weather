// An in-memory stand-in for a MongoDB collection, implementing exactly the
// operators the stores use ($in, $gte, $gt, $ne, equality; $set with dotted
// paths, $setOnInsert, $addToSet, $inc; upsert), plus unique-index emulation
// and a log of every call, so tests can assert the queries as well as results.
import type { Coll, Doc } from "../src/stores";

type Call = { op: string; filter?: Doc; update?: Doc; options?: unknown };

function get(doc: Doc, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o && typeof o === "object" ? (o as Doc)[k] : undefined),
      doc,
    );
}

function set(doc: Doc, path: string, value: unknown): void {
  const keys = path.split(".");
  let o = doc;
  for (const k of keys.slice(0, -1)) {
    if (typeof o[k] !== "object" || o[k] === null) o[k] = {};
    o = o[k] as Doc;
  }
  o[keys[keys.length - 1]!] = value;
}

const same = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : JSON.stringify(a) === JSON.stringify(b);

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    const v = get(doc, k);
    if (
      cond &&
      typeof cond === "object" &&
      !(cond instanceof Date) &&
      !Array.isArray(cond)
    ) {
      return Object.entries(cond as Doc).every(([op, arg]) => {
        switch (op) {
          case "$in":
            return (arg as unknown[]).some((x) => same(x, v));
          case "$gte":
            return (v as Date) >= (arg as Date);
          case "$lte":
            return (v as Date) <= (arg as Date);
          case "$gt":
            return (v as Date) > (arg as Date);
          case "$ne":
            return Array.isArray(v)
              ? !v.some((x) => same(x, arg))
              : !same(v, arg);
          default:
            throw new Error(`fake: unsupported operator ${op}`);
        }
      });
    }
    return same(v, cond);
  });
}

function apply(doc: Doc, update: Doc, inserting: boolean): void {
  for (const [op, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields as Doc)) {
      switch (op) {
        case "$set":
          set(doc, path, structuredClone(value));
          break;
        case "$setOnInsert":
          if (inserting) set(doc, path, structuredClone(value));
          break;
        case "$addToSet": {
          const list = (get(doc, path) as unknown[] | undefined) ?? [];
          if (!list.some((x) => same(x, value))) list.push(value);
          set(doc, path, list);
          break;
        }
        case "$inc":
          set(
            doc,
            path,
            ((get(doc, path) as number | undefined) ?? 0) + (value as number),
          );
          break;
        default:
          throw new Error(`fake: unsupported update operator ${op}`);
      }
    }
  }
}

export class FakeColl implements Coll {
  docs: Doc[] = [];
  calls: Call[] = [];
  private next = 1;
  /** Field names with a unique index. */
  constructor(private unique: string[] = []) {}

  private clash(doc: Doc): boolean {
    return this.unique.some((f) =>
      this.docs.some((d) => d !== doc && same(d[f], doc[f])),
    );
  }

  async findOne(filter: Doc): Promise<Doc | null> {
    this.calls.push({ op: "findOne", filter });
    const d = this.docs.find((x) => matches(x, filter));
    return d ? structuredClone(d) : null;
  }

  async insertOne(doc: Doc): Promise<{ insertedId: unknown }> {
    this.calls.push({ op: "insertOne", update: doc });
    const stored = structuredClone(doc);
    stored._id = (this.next++).toString(16).padStart(24, "0");
    this.docs.push(stored);
    return { insertedId: stored._id };
  }

  async findOneAndUpdate(
    filter: Doc,
    update: Doc,
    options: { upsert?: boolean },
  ): Promise<Doc | null> {
    this.calls.push({ op: "findOneAndUpdate", filter, update, options });
    let d = this.docs.find((x) => matches(x, filter));
    if (!d) {
      if (!options.upsert) return null;
      d = { _id: (this.next++).toString(16).padStart(24, "0") };
      for (const [k, v] of Object.entries(filter))
        if (typeof v !== "object") d[k] = v;
      apply(d, update, true);
      if (this.clash(d))
        throw Object.assign(new Error("E11000"), { code: 11000 });
      this.docs.push(d);
    } else {
      apply(d, update, false);
    }
    return structuredClone(d);
  }

  async updateOne(
    filter: Doc,
    update: Doc,
  ): Promise<{ modifiedCount: number }> {
    this.calls.push({ op: "updateOne", filter, update });
    const d = this.docs.find((x) => matches(x, filter));
    if (!d) return { modifiedCount: 0 };
    apply(d, update, false);
    return { modifiedCount: 1 };
  }

  async findMany(
    filter: Doc,
    options: { projection: Doc; sort: Doc; limit: number },
  ): Promise<Doc[]> {
    this.calls.push({ op: "findMany", filter, options });
    const [[field, dir]] = Object.entries(options.sort) as [[string, number]];
    const key = (x: Doc): number | string => {
      const v = x[field];
      return v instanceof Date ? v.getTime() : (v as string);
    };
    return this.docs
      .filter((x) => matches(x, filter))
      .sort((a, b) => dir * (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
      .slice(0, options.limit)
      .map((x) => {
        const out: Doc = {};
        for (const k of Object.keys(options.projection))
          if (options.projection[k] === 1) out[k] = structuredClone(x[k]);
        return out;
      });
  }

  async insertIfAbsent(
    items: { filter: Doc; doc: Doc }[],
  ): Promise<{ inserted: number }> {
    this.calls.push({ op: "insertIfAbsent", options: items });
    let inserted = 0;
    for (const { filter, doc } of items) {
      if (this.docs.some((x) => matches(x, filter))) continue;
      const stored: Doc = { ...structuredClone(doc) };
      for (const [k, v] of Object.entries(filter)) stored[k] = v;
      this.docs.push(stored);
      inserted++;
    }
    return { inserted };
  }
}
