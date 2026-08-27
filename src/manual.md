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
| **Upsert points** | Insert or overwrite points. Give a `text` to embed (or a `vector`) plus key/value payload tags, or a batch JSON array. |
| **Vector search** | Nearest-neighbour search by query `text` (embedded) or a raw `vector`, narrowed by key/value payload filters. |
| **Retrieve points** | Fetch points by their IDs. |
| **Scroll points** | Page through points by filter, no query vector. |
| **Delete points** | Delete by an ID list or by a payload filter. |

On every point action the **Collection** box has a **List** button (↻) — press it to
pick from the collections already on the instance instead of typing the name.

Structured fields (vector, points, filter, IDs) are entered as **JSON**. For
example, a search filter:

```json
{ "must": [ { "key": "tag", "match": { "value": "docs" } } ] }
```

### Working with text and tags

With an embedding provider configured, **Upsert points** takes plain content — no
JSON, no hand-built vector:

- **Text to embed** — embedded with the provider and kept under `payload.text` so
  it comes back with search hits.
- **Payload tags** — an add/remove list of **key/value** rows stored on the point's
  payload (e.g. `sku` → `B1`, `category` → `bikes`). Filter on these later.
- **Point ID** — optional; a UUID is generated when left blank.

A value that reads as a number or boolean is stored as one (`42`, `true`); wrap it
in quotes (`"42"`) to keep it a string. To write a **batch**, paste a **Points**
JSON array under *Batch (advanced)* instead — it overrides the single-point fields:

```json
[
  { "text": "A red mountain bike", "payload": { "sku": "B1" } },
  { "text": "A waterproof rain jacket", "payload": { "sku": "J7" } }
]
```

Then search by text and narrow with the same tags:

> **Query text:** `something to ride off-road`
> **Payload filters:** `category` → `bikes`

The plugin embeds the query with the same provider and returns the nearest points
whose payload matches every filter row. The **Payload filters** rows are combined
with any raw **Filter** JSON (they are added to its `must`). You can still pass a
raw `vector` on either action to bypass embedding.

### JsonPath tokens

**Every** text and JSON field on every action may contain `{{$.path}}` tokens,
resolved from the flow's context before the action runs — a collection name, a
**Text to embed** or **Query text**, both halves of a **key/value** row, and the
tokens inside a JSON field (**Filter**, **IDs**, **Vector**, **Points**,
**Offset**). Resolution reaches any depth, so a token works wherever it sits, e.g.:

- Payload tag value `{{$.trigger.userId}}` → stores the upstream user id.
- Scroll **Offset** `{{$.scrolled.result.next_page_offset}}` → resumes paging from
  the previous run.
- Filter `{"must":[{"key":"tenant","match":{"value":"{{$.tenant}}"}}]}` → narrows to
  the current tenant.

A token that resolves to a number or boolean is typed as one; tokens the context
can't supply are left in place verbatim, so nothing is silently dropped. (The
node's connection settings are not part of a run and are not resolved.)

## Test the connection

The button below lists collections using the saved settings profile.

```inflow-meta
qdrant.meta.ping
```
