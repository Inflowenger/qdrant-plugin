// Wires the plugin's actions (collection + point operations), the settings profile
// that carries the Qdrant connection, and the qdrant.meta.ping meta the settings
// dialog's "Test connection" button calls. Each action decodes its form body,
// builds a Qdrant client from the bound settings, runs one REST call, and finishes
// the job with the result or a clear error. The plugin holds no state between calls.

import {
  castRequestTo,
  formkit,
  type Action,
  type Job,
  type Meta,
  type Request,
  type Response,
  type Settings,
} from "@inflowenger/node-plugin-sdk";

import { randomUUID } from "node:crypto";

import { Qdrant, type Distance, type QdrantSettings } from "../qdrant/client.js";
import {
  embedTexts,
  type EmbeddingProvider,
  type EmbeddingSettings,
} from "../embeddings/provider.js";
import { resolveInputVars } from "./vars.js";
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
    return [
      { method: "qdrant.meta.ping", requestHandler: (req) => this.metaPing(req) },
      { method: "qdrant.meta.embed", requestHandler: (req) => this.metaEmbed(req) },
      { method: "qdrant.meta.collections", requestHandler: (req) => this.metaCollections(req) },
    ];
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
        this.run(job, "Upserting points", async (qc, body, emb) => {
          const name = str(body.collection);
          const points = await buildUpsertPoints(body, emb);
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
        this.run(job, "Searching", async (qc, body, emb) => {
          const name = str(body.collection);
          const vector = await resolveQueryVector(body, emb);
          const limit = int(body.limit ?? 10, "limit");
          const result = await qc.search(name, vector, limit, {
            filter: buildFilter(body.filters, body.filter),
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
            offset: offsetValue(body.offset),
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
    work: (
      qc: Qdrant,
      body: Record<string, unknown>,
      emb: EmbeddingSettings,
    ) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    let body: Record<string, unknown>;
    let settings: QdrantSettings;
    let embedding: EmbeddingSettings;
    try {
      const req = castRequestTo<Record<string, unknown> & { settings?: Record<string, unknown> }>(job.req.data);
      body = { ...(req.body ?? {}) };
      settings = readSettings(body.settings);
      embedding = readEmbedding(body.settings);
      delete body.settings; // the connection travels separately, not as action input
    } catch (e) {
      await job.doneWithError(errText(e));
      return;
    }

    try {
      // Resolve {{$.path}} JsonPath tokens (in text, payload tags, filter values,
      // …) against the flow scope before the action reads any of them.
      await resolveInputVars(job, body);

      const qc = new Qdrant(settings);
      await job.progress(20, { title, content: str(body.collection) || settings.url });
      const out = await work(qc, body, embedding);
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
      // The submit posts the form's values; tolerate either the flat object (as
      // meta calls use) or a { body } envelope.
      const raw = metaInput(req);
      const body = raw.body && typeof raw.body === "object" ? (raw.body as Record<string, unknown>) : raw;
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
      settings = readSettings(metaInput(req));
    } catch (e) {
      return { data: formkit.failure("%s", errText(e)).about("url").patch(null) };
    }
    try {
      const qc = new Qdrant(settings);
      const res = (await qc.listCollections()) as { collections?: { name: string }[] };
      const count = res.collections?.length ?? 0;
      return {
        data: formkit
          .success("Connected — %s collection(s) reachable.", String(count))
          .about("url")
          .patch(null),
      };
    } catch (e) {
      return {
        data: formkit.failure("Cannot reach Qdrant: %s", errText(e)).about("url").patch(null),
      };
    }
  }

  // metaEmbed backs the "Test embedding" button: embed a short probe with the
  // provider configured in the open settings form and report the vector size —
  // the number the user needs for a collection's "Vector size".
  private async metaEmbed(req: Request): Promise<Response> {
    let embedding: EmbeddingSettings;
    try {
      embedding = readEmbedding(metaInput(req));
    } catch (e) {
      return { data: formkit.failure("%s", errText(e)).about("embeddingModel").patch(null) };
    }
    if (embedding.provider === undefined) {
      return {
        data: formkit
          .warning("Pick an embedding provider first, then test.")
          .about("embeddingModel")
          .patch(null),
      };
    }
    try {
      const [vec] = await embedTexts(embedding, ["ping"], "query");
      return {
        data: formkit
          .success(
            "Embedded a probe — %s-dimensional vectors (use %s as the collection's Vector size).",
            String(vec.length),
            String(vec.length),
          )
          .about("embeddingModel")
          .patch(null),
      };
    } catch (e) {
      return {
        data: formkit.failure("Embedding failed: %s", errText(e)).about("embeddingModel").patch(null),
      };
    }
  }

  // metaCollections backs the "List" button on the collection field: list the
  // instance's collections and rebuild the calling form with that field turned
  // into a drop-down. `form` (set by the field's .picks) names which form to
  // rebuild; without a match the names are reported as text instead.
  private async metaCollections(req: Request): Promise<unknown> {
    const call = metaInput(req);
    let settings: QdrantSettings;
    try {
      settings = readSettings(call.settings);
    } catch (e) {
      return formkit.failure("%s", errText(e)).about("collection").patch(null);
    }

    let names: string[];
    try {
      const qc = new Qdrant(settings);
      const res = (await qc.listCollections()) as { collections?: { name: string }[] };
      names = (res.collections ?? []).map((c) => c.name).filter((n) => n);
    } catch (e) {
      return formkit.failure("Cannot list collections: %s", errText(e)).about("collection").patch(null);
    }
    if (names.length === 0) {
      return formkit.warning("No collections on %s yet.", settings.url).about("collection").patch(null);
    }

    const options = names.map((n) => ({ value: n, label: n }));
    const target = str(call.targetField) || "collection";
    const heading = formkit.success("%s collection(s) on %s — pick one.", String(names.length), settings.url);
    const owner = collectionForms[str(call.form)];
    if (!owner) {
      // Nothing to rebuild into a drop-down — list what we found as text.
      return formkit.info("Collections on %s:\n%s", settings.url, formkit.lines(options)).about(target).patch(null);
    }
    return formkit.choose(owner, target, options, formkit.formData(call), heading);
  }
}

// collectionForms maps an action method to the form its collection "List" button
// rebuilds. Kept beside the meta that reads it so a new action with a collection
// picker is wired in one place — the method here must match the .picks() the
// field carries in forms.ts.
const collectionForms: Record<string, typeof upsertForm> = {
  "qdrant.points.upsert": upsertForm,
  "qdrant.points.search": searchForm,
  "qdrant.points.retrieve": retrieveForm,
  "qdrant.points.scroll": scrollForm,
  "qdrant.points.delete": deleteForm,
};

// ---------------------------------------------------------------- helpers --

// metaInput decodes a lookup-button (meta) request. Unlike an action execution,
// which arrives as the { _registry, body } envelope castRequestTo expects, a meta
// call posts the open form's current values as a flat object — the connection and
// embedding fields at the top level (alongside `settings`, `value`, `targetField`).
// readSettings/readEmbedding pick the keys they need and ignore the rest.
function metaInput(req: Request): Record<string, unknown> {
  const parsed = JSON.parse(decoder.decode(req.data)) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

// readSettings extracts and validates the Qdrant connection from a settings map
// (either the raw settings form body, or body.settings folded into an action).
function readSettings(raw: unknown): QdrantSettings {
  const s = (raw as Record<string, unknown>) ?? {};
  const url = str(s.url);
  if (url === "") throw new Error("Qdrant URL is not set — fill it in the node's settings");
  return { url, apiKey: str(s.apiKey) || undefined };
}

// readEmbedding extracts the optional embedding-provider config from the same
// settings map that carries the Qdrant connection. Absent or "none" means the
// node embeds nothing; the actions then require a raw vector, and this is not an
// error until text is actually supplied.
function readEmbedding(raw: unknown): EmbeddingSettings {
  const s = (raw as Record<string, unknown>) ?? {};
  const provider = str(s.embeddingProvider) as EmbeddingProvider | "none" | "";
  if (provider === "" || provider === "none") return { provider: undefined };
  return {
    provider: provider as EmbeddingProvider,
    model: str(s.embeddingModel) || undefined,
    apiKey: str(s.embeddingApiKey) || undefined,
    baseUrl: str(s.embeddingBaseUrl) || undefined,
  };
}

// resolvePoints turns the user's points array into what Qdrant's upsert wants.
// A point may carry an explicit `vector`, or a `text` that is embedded here (and
// kept under payload.text so search results carry the original content). An `id`
// is generated when omitted. All texts across the batch are embedded in one call.
async function resolvePoints(
  raw: unknown[],
  emb: EmbeddingSettings,
): Promise<Record<string, unknown>[]> {
  const points = raw.map((p, i) => {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new Error(`"points"[${i}] must be an object`);
    }
    return { ...(p as Record<string, unknown>) };
  });

  // Collect the points that need embedding, with their position, so one batch
  // call fills them all in order.
  const toEmbed: { at: number; text: string }[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const hasVector = Array.isArray(p.vector);
    const text = typeof p.text === "string" ? p.text : undefined;
    if (!hasVector && text === undefined) {
      throw new Error(`"points"[${i}] needs a "vector" or a "text" to embed`);
    }
    if (!hasVector && text !== undefined) {
      if (text.trim() === "") throw new Error(`"points"[${i}].text is empty`);
      toEmbed.push({ at: i, text });
    }
  }

  if (toEmbed.length > 0) {
    const vectors = await embedTexts(emb, toEmbed.map((t) => t.text), "document");
    toEmbed.forEach(({ at, text }, k) => {
      const p = points[at];
      p.vector = vectors[k];
      // Keep the source text discoverable in the result unless the caller set it.
      const payload = (typeof p.payload === "object" && p.payload !== null && !Array.isArray(p.payload))
        ? (p.payload as Record<string, unknown>)
        : {};
      if (!("text" in payload)) payload.text = text;
      p.payload = payload;
      delete p.text; // Qdrant's point schema has no "text" field
    });
  }

  // Any remaining points embedded nothing; drop a stray "text" alongside a vector.
  for (const p of points) {
    if ("text" in p && Array.isArray(p.vector)) delete p.text;
    if (p.id === undefined || p.id === null) p.id = randomUUID();
  }
  return points;
}

// resolveQueryVector produces the search vector from either query text (embedded
// as a query) or a raw vector — exactly one of the two.
async function resolveQueryVector(
  body: Record<string, unknown>,
  emb: EmbeddingSettings,
): Promise<number[]> {
  const text = str(body.text).trim();
  const hasVector = body.vector != null && str(body.vector).trim() !== "";
  if (text !== "" && hasVector) {
    throw new Error('provide either "text" or a "vector" to search by, not both');
  }
  if (text !== "") {
    const [vec] = await embedTexts(emb, [text], "query");
    return vec;
  }
  if (hasVector) {
    return numberArray(jsonArray(body.vector, "vector"), "vector");
  }
  throw new Error('provide a query "text" (with an embedding provider) or a raw "vector"');
}

// buildUpsertPoints turns the Upsert form into the points array Qdrant wants. A
// pasted "points" JSON array is the batch path (unchanged). Otherwise one point is
// assembled from the friendly fields: a "text" to embed (or an explicit "vector"),
// the key/value "tags" as its payload, and an optional id. resolvePoints does the
// embedding, the payload.text bookkeeping, and id generation for the single point
// exactly as it does for a batch.
async function buildUpsertPoints(
  body: Record<string, unknown>,
  emb: EmbeddingSettings,
): Promise<Record<string, unknown>[]> {
  const rawPoints = jsonOrUndefined(body.points);
  if (rawPoints !== undefined) {
    return resolvePoints(asArray(rawPoints, "points"), emb);
  }

  const point: Record<string, unknown> = {};
  const id = str(body.id).trim();
  if (id !== "") point.id = coerceId(id);

  const payload = kvToObject(body.tags, "tags");
  if (Object.keys(payload).length > 0) point.payload = payload;

  const text = str(body.text).trim();
  const hasVector = body.vector != null && str(body.vector).trim() !== "";
  if (hasVector) point.vector = numberArray(jsonArray(body.vector, "vector"), "vector");
  if (text !== "") point.text = text;
  if (!hasVector && text === "") {
    throw new Error('provide a "Text to embed", a "Vector", or a "Points" JSON array');
  }
  return resolvePoints([point], emb);
}

// buildFilter combines the key/value "filters" rows (each an exact payload match)
// with any raw Qdrant "filter" JSON. The rows are appended to the filter's `must`,
// so both narrow the results together; either may be absent.
function buildFilter(
  filtersRaw: unknown,
  filterRaw: unknown,
): Record<string, unknown> | undefined {
  const base = jsonObjectOrUndefined(filterRaw, "filter");
  const rows = kvRows(filtersRaw, "filters");
  if (rows.length === 0) return base;
  const conditions = rows.map(({ key, value }) => ({ key, match: { value: coerceValue(value) } }));
  const filter: Record<string, unknown> = base ? { ...base } : {};
  const existing = Array.isArray(filter.must) ? filter.must : filter.must == null ? [] : [filter.must];
  filter.must = [...existing, ...conditions];
  return filter;
}

// kvToObject turns key/value rows into a payload object, coercing each value.
function kvToObject(raw: unknown, field: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of kvRows(raw, field)) out[key] = coerceValue(value);
  return out;
}

// kvRows validates the [{ key, value }, …] shape the key/value list fields submit.
// An empty/absent list is fine (no rows); a row must carry a non-empty key.
function kvRows(raw: unknown, field: string): { key: string; value: string }[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error(`"${field}" must be a list of key/value rows`);
  return raw.map((r, i) => {
    if (typeof r !== "object" || r === null || Array.isArray(r)) {
      throw new Error(`"${field}"[${i}] must be a key/value row`);
    }
    const rec = r as Record<string, unknown>;
    const key = str(rec.key).trim();
    if (key === "") throw new Error(`"${field}"[${i}] has no key`);
    return { key, value: str(rec.value) };
  });
}

// coerceValue reads one key/value string as the type it most plainly denotes:
// true/false → boolean, a bare number → number, everything else the string. A
// value wrapped in double quotes is forced to stay a string ("42" → 42-the-text).
function coerceValue(s: string): string | number | boolean {
  const t = s.trim();
  if (t === "") return s;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      const p = JSON.parse(t);
      if (typeof p === "string") return p;
    } catch {
      // fall through to the raw string
    }
  }
  return s;
}

// coerceId keeps a Qdrant point id valid: a run of digits is an unsigned integer,
// anything else (a UUID) stays a string.
function coerceId(s: string): string | number {
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n)) return n;
  }
  return s;
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

// offsetValue reads a scroll offset, which Qdrant accepts as a number or a point
// id (an integer or a UUID string). A clean JSON value — a number, or a quoted
// string — is taken as-is; anything else is used verbatim as a string id. That
// last case matters most for a {{$.…next_page_offset}} token, which resolves to a
// bare id (e.g. 007 or a UUID) that is not valid standalone JSON.
function offsetValue(v: unknown): unknown {
  if (v == null) return undefined;
  if (typeof v !== "string") return v; // already structured (a number/id)
  const t = v.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
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
