// Turns text into vectors so the Qdrant actions can store and search *content*,
// not hand-typed embeddings. One embedding provider is configured per account on
// the node's settings profile (provider + model + API key, and a base URL for
// self-hosted / OpenAI-compatible endpoints) and arrives folded into every call
// as body.settings, exactly like the Qdrant connection — the plugin stores
// nothing.
//
// Every provider here is a single HTTP round-trip that takes a batch of texts and
// returns one vector per text, in the same order. Errors carry the provider's own
// message so a failed action reads clearly on the canvas.

/** The embedding backends the node knows how to call. */
export type EmbeddingProvider = "openai" | "gemini" | "cohere" | "custom";

/**
 * How the text is used, which some providers must be told: a stored document vs.
 * a query. It changes the request (Cohere `input_type`, Gemini `taskType`) so the
 * two sides land in a comparable space; providers that do not care ignore it.
 */
export type EmbedPurpose = "document" | "query";

export interface EmbeddingSettings {
  /** Which backend to call. Absent/"none" means the node embeds nothing. */
  provider?: EmbeddingProvider;
  /** Model id, e.g. "text-embedding-3-small". Falls back to the provider default. */
  model?: string;
  /** API key. Sent as the provider expects (Bearer, api-key, or ?key=). */
  apiKey?: string;
  /**
   * Base URL override. Required for "custom" (an OpenAI-compatible endpoint such
   * as Ollama / LM Studio / vLLM); optional for the hosted providers, for proxies
   * or gateways.
   */
  baseUrl?: string;
}

/**
 * A short catalogue of well-known models and the vector size each produces, so a
 * Create-collection form can be filled with the right `size` and the settings
 * form can guide the model field. It is documentation, not a gate: the true size
 * is whatever the API returns, and unknown model ids are allowed.
 */
export const KNOWN_MODELS: Record<EmbeddingProvider, { model: string; dim: number; note?: string }[]> = {
  openai: [
    { model: "text-embedding-3-small", dim: 1536 },
    { model: "text-embedding-3-large", dim: 3072 },
    { model: "text-embedding-ada-002", dim: 1536 },
  ],
  gemini: [
    { model: "text-embedding-004", dim: 768 },
    { model: "gemini-embedding-001", dim: 3072, note: "supports 768/1536/3072 via output size" },
  ],
  cohere: [
    { model: "embed-english-v3.0", dim: 1024 },
    { model: "embed-multilingual-v3.0", dim: 1024 },
    { model: "embed-v4.0", dim: 1536, note: "configurable output size" },
  ],
  custom: [],
};

/** The model used when the settings leave the model field blank. */
const DEFAULT_MODEL: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  gemini: "text-embedding-004",
  cohere: "embed-english-v3.0",
  custom: "", // no sensible default — the user must name their model
};

/** The default host for each hosted provider; overridden by settings.baseUrl. */
const DEFAULT_BASE: Record<EmbeddingProvider, string> = {
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  cohere: "https://api.cohere.com",
  custom: "", // required from the user
};

/**
 * embedTexts turns a batch of texts into one vector each, in order, using the
 * configured provider. Returns [] for an empty batch. Throws a clear Error when
 * the provider is unset, misconfigured, or answers with an error — the caller
 * turns that into a failed job.
 */
export async function embedTexts(
  settings: EmbeddingSettings | undefined,
  texts: string[],
  purpose: EmbedPurpose,
): Promise<number[][]> {
  const provider = settings?.provider;
  if (!provider || (provider as string) === "none") {
    throw new Error(
      "no embedding provider is configured — set one in the node's settings, or pass a raw vector instead of text",
    );
  }
  if (texts.length === 0) return [];

  const model = (settings?.model || "").trim() || DEFAULT_MODEL[provider];
  const apiKey = (settings?.apiKey || "").trim() || undefined;
  const base = normaliseBase((settings?.baseUrl || "").trim() || DEFAULT_BASE[provider], provider);

  let vectors: number[][];
  switch (provider) {
    case "openai":
    case "custom":
      vectors = await embedOpenAI(base, model, apiKey, texts, provider);
      break;
    case "gemini":
      vectors = await embedGemini(base, model, apiKey, texts, purpose);
      break;
    case "cohere":
      vectors = await embedCohere(base, model, apiKey, texts, purpose);
      break;
    default:
      throw new Error(`unknown embedding provider "${String(provider)}"`);
  }

  if (vectors.length !== texts.length) {
    throw new Error(
      `embedding provider returned ${vectors.length} vectors for ${texts.length} inputs`,
    );
  }
  return vectors;
}

// --------------------------------------------------------------- providers --

// OpenAI and every OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, gateways)
// share this shape: POST {base}/v1/embeddings, Bearer key, { model, input }, and
// a { data: [{ index, embedding }] } answer that must be sorted by index.
async function embedOpenAI(
  base: string,
  model: string,
  apiKey: string | undefined,
  texts: string[],
  provider: EmbeddingProvider,
): Promise<number[][]> {
  if (model === "") {
    throw new Error("no embedding model is set — name your model in the node's settings");
  }
  if (provider === "custom" && base === "") {
    throw new Error("a custom embedding provider needs a base URL — set it in the node's settings");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const json = await postJson(`${base}/v1/embeddings`, headers, { model, input: texts }, provider);
  const data = (json as { data?: { index?: number; embedding?: number[] }[] }).data;
  if (!Array.isArray(data)) throw new Error(`${provider}: unexpected embeddings response`);
  const rows = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((r, i) => asVector(r.embedding, provider, i));
}

// Gemini's Generative Language API: batchEmbedContents, key in the query string,
// one request per text, taskType steering document vs. query. Model ids may be
// given bare or as "models/…"; normalise to the "models/…" the API wants.
async function embedGemini(
  base: string,
  model: string,
  apiKey: string | undefined,
  texts: string[],
  purpose: EmbedPurpose,
): Promise<number[][]> {
  if (!apiKey) throw new Error("gemini needs an API key — set it in the node's settings");
  const name = model.startsWith("models/") ? model : `models/${model}`;
  const taskType = purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const url = `${base}/v1beta/${name}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
  const requests = texts.map((t) => ({
    model: name,
    content: { parts: [{ text: t }] },
    taskType,
  }));

  const json = await postJson(url, { "Content-Type": "application/json" }, { requests }, "gemini");
  const embeddings = (json as { embeddings?: { values?: number[] }[] }).embeddings;
  if (!Array.isArray(embeddings)) throw new Error("gemini: unexpected embeddings response");
  return embeddings.map((e, i) => asVector(e.values, "gemini", i));
}

// Cohere v2 embed: POST {base}/v2/embed, Bearer key, input_type required (and the
// reason document/query is threaded through here), float embeddings requested
// explicitly so the answer is { embeddings: { float: number[][] } }.
async function embedCohere(
  base: string,
  model: string,
  apiKey: string | undefined,
  texts: string[],
  purpose: EmbedPurpose,
): Promise<number[][]> {
  if (!apiKey) throw new Error("cohere needs an API key — set it in the node's settings");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  const body = {
    model,
    texts,
    input_type: purpose === "query" ? "search_query" : "search_document",
    embedding_types: ["float"],
  };

  const json = await postJson(`${base}/v2/embed`, headers, body, "cohere");
  const float = (json as { embeddings?: { float?: number[][] } }).embeddings?.float;
  if (!Array.isArray(float)) throw new Error("cohere: unexpected embeddings response");
  return float.map((v, i) => asVector(v, "cohere", i));
}

// ---------------------------------------------------------------- helpers --

// postJson performs one embedding call and returns the parsed JSON body, turning
// both transport failures and API-level error bodies into a thrown Error carrying
// the provider's message.
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  who: string,
): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error(`cannot reach ${who} embeddings endpoint: ${String(e)}`);
  }

  const raw = await resp.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${who} ${resp.status}: ${raw.slice(0, 500)}`);
  }

  if (!resp.ok) {
    throw new Error(`${who} ${resp.status}: ${providerError(parsed) ?? raw.slice(0, 500)}`);
  }
  return parsed;
}

// providerError digs the human message out of the various error envelopes:
// OpenAI/compatible `{ error: { message } }` or `{ error: "…" }`, Cohere/Gemini
// `{ message }`.
function providerError(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  const err = o.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  if (typeof o.message === "string") return o.message;
  return undefined;
}

// asVector validates that one entry of the response really is a numeric vector.
function asVector(v: unknown, who: string, i: number): number[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((n) => typeof n === "number")) {
    throw new Error(`${who}: missing or malformed embedding for input ${i}`);
  }
  return v as number[];
}

// normaliseBase strips a trailing slash, and for OpenAI-compatible endpoints also
// tolerates a base that already includes the "/v1" suffix so both forms work.
function normaliseBase(url: string, provider: EmbeddingProvider): string {
  let b = url.replace(/\/+$/, "");
  if ((provider === "openai" || provider === "custom") && b.endsWith("/v1")) {
    b = b.slice(0, -"/v1".length);
  }
  return b;
}
