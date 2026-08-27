// Every form the plugin serves, built with formkit so each field's JSON Schema and
// JSON Forms UI Schema are declared once and stay in step. Fields that carry
// structured data Qdrant needs (a vector, a payload, a filter, a point list) are
// multi-line text the user fills with JSON; the handlers parse and validate it
// (see registry.ts). Keep each form in step with the matching input type there.

import { formkit } from "@inflowenger/node-plugin-sdk";

const { form, text, secret, integer, number, bool, textArea, enumOf, choice, custom } = formkit;

/** A multi-line field the user pastes JSON into. */
function json(name: string, title: string): ReturnType<typeof textArea> {
  return textArea(name, title);
}

// An add/remove list of key/value rows — the renderer draws a "+"/"-" row per
// entry. It arrives at the handler as [{ key, value }, …]. Both halves accept a
// {{$.path}} JsonPath token, resolved against the flow scope before use, so a tag
// or filter value can come from upstream data. Used for payload tags (Upsert) and
// payload filters (Vector search) so neither needs hand-written JSON.
function keyValueList(name: string, title: string): ReturnType<typeof custom> {
  return custom(name, title, {
    type: "array",
    items: {
      type: "object",
      properties: {
        key: { type: "string", title: "Key" },
        value: { type: "string", title: "Value" },
      },
      required: ["key"],
    },
  });
}

// The settings profile: where Qdrant is and how to authenticate. Stored by the
// platform as a named profile and folded into every call as body.settings — the
// plugin never persists it. The "Test connection" button calls the
// qdrant.meta.ping meta function while the dialog is open.
export const settingsForm = form("Qdrant connection")
  .describe("Point this node at a Qdrant instance, and optionally at an embedding provider so Upsert and Vector search can take plain text instead of hand-built vectors.")
  .group(
    "Qdrant",
    text("url", "Qdrant URL")
      .required()
      .default("http://localhost:6333")
      .help("Base REST URL, e.g. http://localhost:6333 or https://xyz.cloud.qdrant.io:6333")
      .lookup("qdrant.meta.ping", "Test connection"),
    secret("apiKey", "API key").help("Sent as the api-key header. Leave empty for an unsecured local instance."),
  )
  .group(
    "Embeddings (optional)",
    choice(
      "embeddingProvider",
      "Provider",
      { value: "none", label: "None — I provide vectors myself" },
      { value: "openai", label: "OpenAI" },
      { value: "gemini", label: "Google Gemini" },
      { value: "cohere", label: "Cohere" },
      { value: "custom", label: "Custom (OpenAI-compatible: Ollama, LM Studio, vLLM…)" },
    )
      .default("none")
      .help("Choose a provider to embed text in Upsert and Vector search. With None, both actions require a raw vector."),
    text("embeddingModel", "Model")
      .hideWhen("embeddingProvider", "none")
      .help(
        "OpenAI: text-embedding-3-small (1536) / -3-large (3072). " +
          "Gemini: text-embedding-004 (768). " +
          "Cohere: embed-english-v3.0 (1024) / embed-v4.0. " +
          "Custom: whatever your endpoint serves. Blank uses the provider default.",
      )
      .lookup("qdrant.meta.embed", "Test embedding"),
    secret("embeddingApiKey", "API key")
      .hideWhen("embeddingProvider", "none")
      .help("Key for the embedding provider (not the Qdrant key). Optional for a local, unsecured custom endpoint."),
    text("embeddingBaseUrl", "Base URL")
      .hideWhen("embeddingProvider", "none")
      .help("Required for Custom, e.g. http://localhost:11434 (Ollama). Optional override for the hosted providers."),
  )
  .build();

// Collection name is required by nearly every action; declared once and reused.
// `pickForm` is the action method whose form the "List" button rebuilds with the
// collection field turned into a drop-down of the instance's collections (served
// by the qdrant.meta.collections meta). Omit it where a live list makes no sense
// — Create collection names a new one.
const collectionField = (pickForm?: string) => {
  const f = text("collection", "Collection")
    .required()
    .help("Name of the Qdrant collection to act on.");
  if (pickForm) f.lookup("qdrant.meta.collections", "List").picks(pickForm);
  return f;
};

export const createCollectionForm = form("Create collection")
  .add(
    text("collection", "Collection name").required(),
    integer("size", "Vector size").required().min(1).help("Dimensionality of the vectors this collection stores."),
    enumOf("distance", "Distance", "Cosine", "Dot", "Euclid", "Manhattan").required().default("Cosine"),
    bool("onDiskPayload", "Store payload on disk").default(false).help("Keep payloads on disk instead of RAM (larger, cheaper collections)."),
  )
  .build();

export const listCollectionsForm = form("List collections")
  .describe("Return the names of every collection on the instance. No input.")
  .build();

export const upsertForm = form("Upsert points")
  .describe("Insert one point from a text (embedded with the configured provider) plus payload tags, or paste a Points JSON array below to write a batch. Tag values accept {{$.path}} tokens resolved from the flow.")
  .add(collectionField("qdrant.points.upsert"))
  .group(
    "Point",
    text("text", "Text to embed")
      .help("Embedded with the configured provider and stored under payload.text so search results carry the source. Accepts {{$.path}} tokens. Leave blank to supply a raw vector instead."),
    keyValueList("tags", "Payload tags (key/value)")
      .help(
        "Stored on the point's payload, e.g. sku → B1, tag → a. Filter on these later in Vector search. " +
          'Keys and values accept {{$.path}} tokens; a value like 42 or true is stored as a number/boolean — quote it ("42") to force a string.',
      ),
    text("id", "Point ID (optional)")
      .help("Number or UUID string. A UUID is generated when left blank."),
    json("vector", "Vector (JSON array, optional)")
      .help("Give an explicit vector instead of Text to embed, e.g. [0.1, 0.2, 0.3]."),
  )
  .group(
    "Batch (advanced)",
    json("points", "Points (JSON array)")
      .help(
        'Overrides the single point above. With an embedding provider: [{"text":"a red bicycle","payload":{"sku":"B1"}}]. ' +
          'Without one, or to bypass embedding: [{"id":1,"vector":[0.1,0.2],"payload":{"tag":"a"}}].',
      ),
    bool("wait", "Wait for completion").default(true).help("Return only once the write is applied."),
  )
  .build();

export const searchForm = form("Vector search")
  .describe("Search by text (embedded with the configured provider) or by a raw query vector, optionally narrowed by payload filters. Provide exactly one of text/vector.")
  .add(
    collectionField("qdrant.points.search"),
    text("text", "Query text").help("Embedded with the configured provider and searched. Leave blank to search by a raw vector instead. Accepts {{$.path}} tokens."),
    json("vector", "Query vector (JSON array)").help("Array of numbers, e.g. [0.1, 0.2, 0.3]. Used only when Query text is blank."),
    keyValueList("filters", "Payload filters (key/value)")
      .help(
        "Each row narrows results to points whose payload key equals the value (Qdrant must-match), e.g. tag → a. " +
          'Keys and values accept {{$.path}} tokens; 42 or true match a number/boolean — quote it ("42") to match a string.',
      ),
    integer("limit", "Limit").default(10).min(1),
    json("filter", "Filter (JSON object, advanced)").help('Raw Qdrant filter merged with the rows above, e.g. {"must":[{"key":"tag","match":{"value":"a"}}]}'),
    number("scoreThreshold", "Score threshold (optional)").help("Only return points scoring at or above this value."),
    bool("withPayload", "Include payload").default(true),
    bool("withVector", "Include vector").default(false),
  )
  .build();

export const retrieveForm = form("Retrieve points")
  .add(
    collectionField("qdrant.points.retrieve"),
    json("ids", "Point IDs (JSON array)").required().help('e.g. [1, 2, 3] or ["a1b2..."]'),
    bool("withPayload", "Include payload").default(true),
    bool("withVector", "Include vector").default(false),
  )
  .build();

export const scrollForm = form("Scroll points")
  .describe("Page through points by filter, without a query vector.")
  .add(
    collectionField("qdrant.points.scroll"),
    integer("limit", "Limit").default(50).min(1),
    json("filter", "Filter (JSON object, optional)").help('e.g. {"must":[{"key":"tag","match":{"value":"a"}}]}'),
    json("offset", "Offset (optional)").help("The next_page_offset from a previous scroll, as JSON (a number, string, or id)."),
    bool("withPayload", "Include payload").default(true),
    bool("withVector", "Include vector").default(false),
  )
  .build();

export const deleteForm = form("Delete points")
  .describe("Delete points by an explicit ID list, or by a payload filter. Provide exactly one.")
  .add(
    collectionField("qdrant.points.delete"),
    json("ids", "Point IDs (JSON array, optional)").help('e.g. [1, 2, 3]'),
    json("filter", "Filter (JSON object, optional)").help('e.g. {"must":[{"key":"tag","match":{"value":"old"}}]}'),
    bool("wait", "Wait for completion").default(true),
  )
  .build();
