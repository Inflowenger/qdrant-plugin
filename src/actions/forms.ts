// Every form the plugin serves, built with formkit so each field's JSON Schema and
// JSON Forms UI Schema are declared once and stay in step. Fields that carry
// structured data Qdrant needs (a vector, a payload, a filter, a point list) are
// multi-line text the user fills with JSON; the handlers parse and validate it
// (see registry.ts). Keep each form in step with the matching input type there.

import { formkit } from "@inflowenger/node-plugin-sdk";

const { form, text, secret, integer, number, bool, textArea, enumOf } = formkit;

/** A multi-line field the user pastes JSON into. */
function json(name: string, title: string): ReturnType<typeof textArea> {
  return textArea(name, title);
}

// The settings profile: where Qdrant is and how to authenticate. Stored by the
// platform as a named profile and folded into every call as body.settings — the
// plugin never persists it. The "Test connection" button calls the
// qdrant.meta.ping meta function while the dialog is open.
export const settingsForm = form("Qdrant connection")
  .describe("Point this node at a Qdrant instance. The API key is optional (Qdrant Cloud and secured deployments require it).")
  .add(
    text("url", "Qdrant URL")
      .required()
      .default("http://localhost:6333")
      .help("Base REST URL, e.g. http://localhost:6333 or https://xyz.cloud.qdrant.io:6333")
      .lookup("qdrant.meta.ping", "Test connection"),
    secret("apiKey", "API key").help("Sent as the api-key header. Leave empty for an unsecured local instance."),
  )
  .build();

// Collection name is required by nearly every action; declared once and reused.
const collectionField = () =>
  text("collection", "Collection").required().help("Name of the Qdrant collection to act on.");

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
  .add(
    collectionField(),
    json("points", "Points (JSON array)")
      .required()
      .help('Array of points, e.g. [{"id":1,"vector":[0.1,0.2],"payload":{"tag":"a"}}]'),
    bool("wait", "Wait for completion").default(true).help("Return only once the write is applied."),
  )
  .build();

export const searchForm = form("Vector search")
  .add(
    collectionField(),
    json("vector", "Query vector (JSON array)").required().help("Array of numbers, e.g. [0.1, 0.2, 0.3]"),
    integer("limit", "Limit").default(10).min(1),
    json("filter", "Filter (JSON object, optional)").help('Qdrant filter, e.g. {"must":[{"key":"tag","match":{"value":"a"}}]}'),
    number("scoreThreshold", "Score threshold (optional)").help("Only return points scoring at or above this value."),
    bool("withPayload", "Include payload").default(true),
    bool("withVector", "Include vector").default(false),
  )
  .build();

export const retrieveForm = form("Retrieve points")
  .add(
    collectionField(),
    json("ids", "Point IDs (JSON array)").required().help('e.g. [1, 2, 3] or ["a1b2..."]'),
    bool("withPayload", "Include payload").default(true),
    bool("withVector", "Include vector").default(false),
  )
  .build();

export const scrollForm = form("Scroll points")
  .describe("Page through points by filter, without a query vector.")
  .add(
    collectionField(),
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
    collectionField(),
    json("ids", "Point IDs (JSON array, optional)").help('e.g. [1, 2, 3]'),
    json("filter", "Filter (JSON object, optional)").help('e.g. {"must":[{"key":"tag","match":{"value":"old"}}]}'),
    bool("wait", "Wait for completion").default(true),
  )
  .build();
