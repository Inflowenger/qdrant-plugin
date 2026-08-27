# Qdrant plugin (Inflowenger node)

An Inflowenger **Plugin node** for the [Qdrant](https://qdrant.tech) vector
database. It exposes collection and point operations on the workflow canvas and
talks directly to Qdrant's REST API. Built on
[`@inflowenger/node-plugin-sdk`](https://github.com/Inflowenger/node-plugin-sdk).

Runs on **any host** that speaks `inflowv1` — it reaches no host-specific service.

## Actions

| Method | Title | Does |
|--------|-------|------|
| `qdrant.collection.create` | Create collection | Create a collection with a vector size + distance metric. |
| `qdrant.collection.list` | List collections | Names of every collection. |
| `qdrant.points.upsert` | Upsert points | Insert/overwrite points; each carries a `vector` or a `text` to embed. |
| `qdrant.points.search` | Vector search | Nearest-neighbour search by query `text` (embedded) or a raw `vector`, optionally filtered. |
| `qdrant.points.retrieve` | Retrieve points | Fetch points by ID. |
| `qdrant.points.scroll` | Scroll points | Page through points by filter. |
| `qdrant.points.delete` | Delete points | Delete by ID list or by filter. |

Plus the `qdrant.meta.ping` (**Test connection**) and `qdrant.meta.embed` (**Test
embedding**) meta functions behind the settings dialog.

## Embeddings

Qdrant searches vectors, not text. Configure an embedding provider in the node's
**settings** (**Embeddings** section) and **Upsert** and **Vector search** accept
plain text, embedding it for you before it reaches Qdrant:

- **Providers**: OpenAI, Google Gemini, Cohere, or **Custom** — any
  OpenAI-compatible endpoint (Ollama, LM Studio, vLLM). Leave it **None** to supply
  vectors yourself.
- On upsert, a point's `text` is embedded and kept under `payload.text`; a missing
  `id` is auto-generated (UUID).
- On search, the query `text` is embedded as a query. A raw `vector` still works on
  either action to bypass embedding.
- A collection's **Vector size** must match the embedding model's dimension — use
  **Test embedding** to read it off.

## Credentials

The node holds **no** credentials. A Qdrant instance is configured per-account in
the node's **settings** (URL + optional API key), alongside the optional embedding
provider (its own key); the platform stores it as a named profile and folds it into
every call as `body.settings`. Structured inputs (vector, points, filter, IDs) are
entered as **JSON**.

## Develop

```bash
cp .env.inflow.example .env.inflow    # fill PLUGIN_ID / INFRA_CRED / INFRA_URL
npm install
npm run dev                           # tsx src/main.ts  (or: npm run build && npm start)
```

`PLUGIN_ID`, `INFRA_CRED` (base64) and `INFRA_URL` are minted by Infra when the
plugin is defined in a space — see
[getting-started](https://github.com/Inflowenger/getting-started). On startup the
SDK logs each subscribed subject; add the node to a flow to exercise it.

Raise `REQ_TIMEOUT` (seconds) at deploy time if your Qdrant is slow to answer.
