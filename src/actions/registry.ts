// Wires the plugin's actions (collection + point operations), the settings profile
// that carries the Qdrant connection, and the qdrant.meta.ping meta the settings
// dialog's "Test connection" button calls. Each action decodes its form body,
// builds a Qdrant client from the bound settings, runs one REST call, and finishes
// the job with the result or a clear error. The plugin holds no state between calls.

import {
  castRequestTo,
  type Action,
  type Job,
  type Meta,
  type Request,
  type Response,
  type Settings,
} from "@inflowenger/node-plugin-sdk";

import { Qdrant, type Distance, type QdrantSettings } from "../qdrant/client.js";
import {
  createCollectionForm,
  deleteForm,
  listCollectionsForm,
  retrieveForm,
  scrollForm,
  searchForm,
  settingsForm,
  upsertForm,
} from "./forms.js";

const decoder = new TextDecoder();

export class Registry {
  /** Every action the node exposes, in the order the canvas lists them. */
  all(): Action[] {
    return [
      this.createCollection(),
      this.listCollections(),
      this.upsert(),
      this.search(),
      this.retrieve(),
      this.scroll(),
      this.deletePoints(),
    ];
  }

  /** The settings profile: the connection form plus its submit validator. */
  settings(): Settings {
    return { ...settingsForm, submitHandler: (req) => this.settingsSubmit(req) };
  }

  /** The same form for PluginIntro.settings — the plugin set-up dialog reads it. */
  settingsForm() {
    return settingsForm;
  }

  /** Live meta functions the forms can call while open. */
  metas(): Meta[] {
    return [{ method: "qdrant.meta.ping", requestHandler: (req) => this.metaPing(req) }];
  }

  // ------------------------------------------------------------- actions --

  private createCollection(): Action {
    return {
      method: "qdrant.collection.create",
      title: "Create collection",
      description: "Create a Qdrant collection with a vector size and distance metric.",
      icon: { icon: "mdi-database-plus" },
      form: createCollectionForm,
      requestHandler: (job) =>
        this.run(job, "Creating collection", async (qc, body) => {
          const name = str(body.collection);
          const size = int(body.size, "size");
          const distance = str(body.distance || "Cosine") as Distance;
          const ok = await qc.createCollection(name, size, distance, bool(body.onDiskPayload));
          return { created: ok, collection: name };
        }),
    };
  }

  private listCollections(): Action {
    return {
      method: "qdrant.collection.list",
      title: "List collections",
      description: "List the names of every collection on the instance.",
      icon: { icon: "mdi-database-search" },
      form: listCollectionsForm,
      requestHandler: (job) =>
        this.run(job, "Listing collections", async (qc) => {
          const res = (await qc.listCollections()) as { collections?: { name: string }[] };
          return { collections: (res.collections ?? []).map((c) => c.name) };
        }),
    };
  }

  private upsert(): Action {
    return {
      method: "qdrant.points.upsert",
      title: "Upsert points",
      description: "Insert or overwrite points (id + vector + payload) in a collection.",
      icon: { icon: "mdi-database-import" },
      form: upsertForm,
      requestHandler: (job) =>
        this.run(job, "Upserting points", async (qc, body) => {
          const name = str(body.collection);
          const points = jsonArray(body.points, "points");
          const result = await qc.upsert(name, points, bool(body.wait, true));
          return { upserted: points.length, result };
        }),
    };
  }

  private search(): Action {
    return {
      method: "qdrant.points.search",
      title: "Vector search",
      description: "Nearest-neighbour search for a query vector, optionally filtered.",
      icon: { icon: "mdi-vector-triangle" },
      form: searchForm,
      requestHandler: (job) =>
        this.run(job, "Searching", async (qc, body) => {
          const name = str(body.collection);
          const vector = numberArray(jsonArray(body.vector, "vector"), "vector");
          const limit = int(body.limit ?? 10, "limit");
          const result = await qc.search(name, vector, limit, {
            filter: jsonObjectOrUndefined(body.filter, "filter"),
            withPayload: bool(body.withPayload, true),
            withVector: bool(body.withVector),
            scoreThreshold: body.scoreThreshold == null ? undefined : num(body.scoreThreshold, "scoreThreshold"),
          });
          return { result };
        }),
    };
  }

  private retrieve(): Action {
    return {
      method: "qdrant.points.retrieve",
      title: "Retrieve points",
      description: "Fetch points by their IDs.",
      icon: { icon: "mdi-database-export" },
      form: retrieveForm,
      requestHandler: (job) =>
        this.run(job, "Retrieving points", async (qc, body) => {
          const name = str(body.collection);
          const ids = idArray(jsonArray(body.ids, "ids"), "ids");
          const result = await qc.retrieve(name, ids, bool(body.withPayload, true), bool(body.withVector));
          return { result };
        }),
    };
  }

  private scroll(): Action {
    return {
      method: "qdrant.points.scroll",
      title: "Scroll points",
      description: "Page through points by filter (no query vector).",
      icon: { icon: "mdi-format-list-bulleted" },
      form: scrollForm,
      requestHandler: (job) =>
        this.run(job, "Scrolling points", async (qc, body) => {
          const name = str(body.collection);
          const limit = int(body.limit ?? 50, "limit");
          const result = await qc.scroll(name, limit, {
            filter: jsonObjectOrUndefined(body.filter, "filter"),
            offset: jsonOrUndefined(body.offset),
            withPayload: bool(body.withPayload, true),
            withVector: bool(body.withVector),
          });
          return { result };
        }),
    };
  }

  private deletePoints(): Action {
    return {
      method: "qdrant.points.delete",
      title: "Delete points",
      description: "Delete points by an ID list or by a payload filter.",
      icon: { icon: "mdi-database-remove" },
      form: deleteForm,
      requestHandler: (job) =>
        this.run(job, "Deleting points", async (qc, body) => {
          const name = str(body.collection);
          const idsRaw = jsonOrUndefined(body.ids);
          const filter = jsonObjectOrUndefined(body.filter, "filter");
          if (idsRaw === undefined && filter === undefined) {
            throw new Error("provide either an ID list or a filter to select the points to delete");
          }
          if (idsRaw !== undefined && filter !== undefined) {
            throw new Error("provide either an ID list or a filter, not both");
          }
          const selector = idsRaw !== undefined
            ? { points: idArray(asArray(idsRaw, "ids"), "ids") }
            : { filter };
          const result = await qc.deletePoints(name, selector, bool(body.wait, true));
          return { result };
        }),
    };
  }

  // --------------------------------------------------------------- core --

  // run is the shared job handler: decode the body + bound settings, build a
  // client, invoke the action's work, and finish with its result. Any thrown
  // error (bad JSON, unreachable Qdrant, an API error) ends the job cleanly.
  private async run(
    job: Job,
    title: string,
    work: (qc: Qdrant, body: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    let body: Record<string, unknown>;
    let settings: QdrantSettings;
    try {
      const req = castRequestTo<Record<string, unknown> & { settings?: Record<string, unknown> }>(job.req.data);
      body = { ...(req.body ?? {}) };
      settings = readSettings(body.settings);
      delete body.settings; // the connection travels separately, not as action input
    } catch (e) {
      await job.doneWithError(errText(e));
      return;
    }

    try {
      const qc = new Qdrant(settings);
      await job.progress(20, { title, content: str(body.collection) || settings.url });
      const out = await work(qc, body);
      await job.progress(90, { title, content: "done" });
      await job.done(out);
    } catch (e) {
      await job.doneWithError(errText(e));
    }
  }

  // ---------------------------------------------------------- settings --

  // settingsSubmit validates the connection form on save. It does not store
  // anything — the platform keeps the profile and ships it back as body.settings.
  private settingsSubmit(req: Request): Response {
    try {
      const { body } = castRequestTo<Record<string, unknown>>(req.data);
      readSettings(body); // throws if the URL is missing/blank
      return { data: { ok: true } };
    } catch (e) {
      return { data: { ok: false }, error: errText(e) };
    }
  }

  // metaPing backs the "Test connection" button: build a client from what's in
  // the open form and list collections. Answers with a formkit-style notification
  // the dialog can show inline.
  private async metaPing(req: Request): Promise<Response> {
    let settings: QdrantSettings;
    try {
      const { body } = castRequestTo<Record<string, unknown>>(req.data);
      settings = readSettings(body);
    } catch (e) {
      return { error: errText(e) };
    }
    try {
      const qc = new Qdrant(settings);
      const res = (await qc.listCollections()) as { collections?: { name: string }[] };
      const count = res.collections?.length ?? 0;
      return { data: { ok: true, message: `Connected — ${count} collection(s) reachable.` } };
    } catch (e) {
      return { data: { ok: false }, error: errText(e) };
    }
  }
}

// ---------------------------------------------------------------- helpers --

// readSettings extracts and validates the Qdrant connection from a settings map
// (either the raw settings form body, or body.settings folded into an action).
function readSettings(raw: unknown): QdrantSettings {
  const s = (raw as Record<string, unknown>) ?? {};
  const url = str(s.url);
  if (url === "") throw new Error("Qdrant URL is not set — fill it in the node's settings");
  return { url, apiKey: str(s.apiKey) || undefined };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function bool(v: unknown, dflt = false): boolean {
  if (typeof v === "boolean") return v;
  if (v == null) return dflt;
  return v === "true" || v === 1;
}

function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`"${field}" must be a number`);
  return n;
}

function int(v: unknown, field: string): number {
  const n = num(v, field);
  if (!Number.isInteger(n)) throw new Error(`"${field}" must be a whole number`);
  return n;
}

// parseJson decodes a JSON string field, tolerating a value the platform already
// parsed into an object/array. Empty/whitespace yields undefined.
function parseJson(v: unknown, field: string): unknown {
  if (v == null) return undefined;
  if (typeof v !== "string") return v; // already structured
  const t = v.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error(`"${field}" is not valid JSON: ${String(e)}`);
  }
}

function jsonOrUndefined(v: unknown): unknown {
  return parseJson(v, "value");
}

function jsonObjectOrUndefined(v: unknown, field: string): Record<string, unknown> | undefined {
  const parsed = parseJson(v, field);
  if (parsed === undefined) return undefined;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`"${field}" must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function jsonArray(v: unknown, field: string): unknown[] {
  const parsed = parseJson(v, field);
  return asArray(parsed, field);
}

function asArray(parsed: unknown, field: string): unknown[] {
  if (!Array.isArray(parsed)) throw new Error(`"${field}" must be a JSON array`);
  return parsed;
}

function numberArray(arr: unknown[], field: string): number[] {
  return arr.map((x, i) => {
    const n = typeof x === "number" ? x : Number(x);
    if (!Number.isFinite(n)) throw new Error(`"${field}"[${i}] must be a number`);
    return n;
  });
}

// Qdrant point IDs are unsigned integers or UUID strings.
function idArray(arr: unknown[], field: string): (string | number)[] {
  return arr.map((x, i) => {
    if (typeof x === "number" || typeof x === "string") return x;
    throw new Error(`"${field}"[${i}] must be a number or string id`);
  });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
