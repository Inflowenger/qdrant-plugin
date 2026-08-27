// A thin typed wrapper over Qdrant's REST API. One instance is built per job from
// the settings profile (base URL + optional API key) that arrives as
// `body.settings` — the plugin stores nothing. Every method is a single HTTP
// round-trip; errors are surfaced as Error with the message Qdrant returned so a
// failed action reads clearly on the canvas.
//
// REST reference: https://api.qdrant.tech/api-reference

export interface QdrantSettings {
  /** Base URL of the Qdrant instance, e.g. http://localhost:6333 */
  url: string;
  /** Optional API key, sent as the `api-key` header (Qdrant Cloud / secured). */
  apiKey?: string;
}

/** Distance metrics Qdrant supports for a vector configuration. */
export type Distance = "Cosine" | "Dot" | "Euclid" | "Manhattan";

export class Qdrant {
  private readonly base: string;
  private readonly apiKey?: string;

  constructor(settings: QdrantSettings) {
    const url = (settings.url ?? "").trim();
    if (url === "") {
      throw new Error("Qdrant URL is not set — fill it in the node's settings");
    }
    // Normalise: no trailing slash, so `${base}/collections/...` is well formed.
    this.base = url.replace(/\/+$/, "");
    this.apiKey = settings.apiKey?.trim() || undefined;
  }

  // request performs one call and returns the parsed `result` field of Qdrant's
  // envelope. Qdrant answers `{ result, status, time }` on success and
  // `{ status: { error }, time }` on failure; both HTTP-error and body-error
  // shapes are turned into a thrown Error.
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(this.base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["api-key"] = this.apiKey;

    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`cannot reach Qdrant at ${this.base}: ${String(e)}`);
    }

    const raw = await resp.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      // Non-JSON body (e.g. a proxy error page) — surface it verbatim.
      if (!resp.ok) throw new Error(`Qdrant ${resp.status}: ${raw.slice(0, 500)}`);
      return raw as unknown as T;
    }

    const env = parsed as { result?: T; status?: unknown };
    if (!resp.ok || isErrorStatus(env.status)) {
      throw new Error(`Qdrant ${resp.status}: ${statusMessage(env.status) ?? raw.slice(0, 500)}`);
    }
    return env.result as T;
  }

  // ---------------------------------------------------------- collections --

  /** GET /collections — names of every collection. */
  listCollections(): Promise<{ collections: { name: string }[] }> {
    return this.request("GET", "/collections");
  }

  /** GET /collections/{name} — full info for one collection. */
  getCollection(name: string): Promise<unknown> {
    return this.request("GET", `/collections/${encodeURIComponent(name)}`);
  }

  /**
   * PUT /collections/{name} — create a collection with a single unnamed vector
   * config. `onDiskPayload` stores payloads on disk rather than in RAM.
   */
  createCollection(
    name: string,
    size: number,
    distance: Distance,
    onDiskPayload?: boolean,
  ): Promise<boolean> {
    return this.request("PUT", `/collections/${encodeURIComponent(name)}`, {
      vectors: { size, distance },
      on_disk_payload: onDiskPayload,
    });
  }

  /** DELETE /collections/{name}. */
  deleteCollection(name: string): Promise<boolean> {
    return this.request("DELETE", `/collections/${encodeURIComponent(name)}`);
  }

  // --------------------------------------------------------------- points --

  /**
   * PUT /collections/{name}/points — insert or overwrite points. `wait=true`
   * makes Qdrant answer only once the change is applied, so a following read is
   * consistent.
   */
  upsert(name: string, points: unknown[], wait = true): Promise<unknown> {
    return this.request(
      "PUT",
      `/collections/${encodeURIComponent(name)}/points`,
      { points },
      { wait },
    );
  }

  /** POST /collections/{name}/points — retrieve points by id. */
  retrieve(
    name: string,
    ids: (string | number)[],
    withPayload: boolean,
    withVector: boolean,
  ): Promise<unknown> {
    return this.request("POST", `/collections/${encodeURIComponent(name)}/points`, {
      ids,
      with_payload: withPayload,
      with_vector: withVector,
    });
  }

  /**
   * POST /collections/{name}/points/search — nearest-neighbour search for one
   * query vector, optionally narrowed by a payload filter.
   */
  search(
    name: string,
    vector: number[],
    limit: number,
    opts: { filter?: unknown; withPayload?: boolean; withVector?: boolean; scoreThreshold?: number } = {},
  ): Promise<unknown> {
    return this.request("POST", `/collections/${encodeURIComponent(name)}/points/search`, {
      vector,
      limit,
      filter: opts.filter,
      with_payload: opts.withPayload ?? true,
      with_vector: opts.withVector ?? false,
      score_threshold: opts.scoreThreshold,
    });
  }

  /**
   * POST /collections/{name}/points/scroll — page through points by filter (no
   * query vector). Returns `{ points, next_page_offset }`.
   */
  scroll(
    name: string,
    limit: number,
    opts: { filter?: unknown; offset?: unknown; withPayload?: boolean; withVector?: boolean } = {},
  ): Promise<unknown> {
    return this.request("POST", `/collections/${encodeURIComponent(name)}/points/scroll`, {
      limit,
      filter: opts.filter,
      offset: opts.offset,
      with_payload: opts.withPayload ?? true,
      with_vector: opts.withVector ?? false,
    });
  }

  /**
   * POST /collections/{name}/points/delete — delete points, selected either by
   * an explicit id list or by a payload filter.
   */
  deletePoints(
    name: string,
    selector: { points?: (string | number)[]; filter?: unknown },
    wait = true,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/collections/${encodeURIComponent(name)}/points/delete`,
      selector,
      { wait },
    );
  }
}

// isErrorStatus / statusMessage read Qdrant's `status` field, which is the string
// "ok" on success and `{ error: "..." }` on failure.
function isErrorStatus(status: unknown): boolean {
  return typeof status === "object" && status !== null && "error" in status;
}

function statusMessage(status: unknown): string | undefined {
  if (isErrorStatus(status)) {
    const err = (status as { error: unknown }).error;
    return typeof err === "string" ? err : JSON.stringify(err);
  }
  return undefined;
}
