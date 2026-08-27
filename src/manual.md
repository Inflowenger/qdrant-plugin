# Qdrant

Talk to a [Qdrant](https://qdrant.tech) vector database from a workflow — manage
collections and read and write points.

## Setup

Open the node's **settings**. Under **Qdrant**:

- **Qdrant URL** — e.g. `http://localhost:6333` or your Qdrant Cloud endpoint.
- **API key** — optional; required by Qdrant Cloud and any secured instance.

Press **Test connection** to confirm the instance is reachable before saving. The
plugin stores nothing — the platform keeps the profile and hands it to each action.

### Embeddings (optional)

Qdrant searches **vectors**, not text — so to store or search *content* you must
first turn it into an embedding. Configure a provider under **Embeddings** and the
**Upsert** and **Vector search** actions will do that for you:

- **Provider** — `OpenAI`, `Google Gemini`, `Cohere`, or `Custom` (any
  OpenAI-compatible endpoint: Ollama, LM Studio, vLLM…). Leave it **None** to keep
  supplying vectors yourself.
- **Model** — e.g. `text-embedding-3-small` (OpenAI, 1536), `text-embedding-004`
  (Gemini, 768), `embed-english-v3.0` (Cohere, 1024). Blank uses the provider
  default.
- **API key** — the embedding provider's key (separate from the Qdrant key).
  Optional for a local, unsecured custom endpoint.
- **Base URL** — required for **Custom** (e.g. `http://localhost:11434` for
  Ollama); an optional override for the hosted providers.

Press **Test embedding** to embed a probe and read back the **vector size** — the
number you give a new collection's *Vector size*. A collection's size must match
the model that fills it.

## Actions

| Action | What it does |
|--------|--------------|
| **Create collection** | Create a collection with a vector size and distance metric. |
| **List collections** | Names of every collection on the instance. |
| **Upsert points** | Insert or overwrite points. Give each a `vector`, or a `text` to embed. |
| **Vector search** | Nearest-neighbour search by query `text` (embedded) or a raw `vector`, optionally filtered. |
| **Retrieve points** | Fetch points by their IDs. |
| **Scroll points** | Page through points by filter, no query vector. |
| **Delete points** | Delete by an ID list or by a payload filter. |

Structured fields (vector, points, filter, IDs) are entered as **JSON**. For
example, a search filter:

```json
{ "must": [ { "key": "tag", "match": { "value": "docs" } } ] }
```

### Working with text

With an embedding provider configured, upsert points by content — no `vector`
needed. An `id` is generated when omitted, and the source text is kept under
`payload.text` so it comes back with search hits:

```json
[
  { "text": "A red mountain bike", "payload": { "sku": "B1" } },
  { "text": "A waterproof rain jacket", "payload": { "sku": "J7" } }
]
```

Then search by text:

> **Query text:** `something to ride off-road`

The plugin embeds the query with the same provider and returns the nearest points.
You can still pass a raw `vector` on either action to bypass embedding.

## Test the connection

The button below lists collections using the saved settings profile.

```inflow-meta
qdrant.meta.ping
```
