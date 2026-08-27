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
| `qdrant.points.upsert` | Upsert points | Insert/overwrite points (`id` + `vector` + `payload`). |
| `qdrant.points.search` | Vector search | Nearest-neighbour search, optionally filtered. |
| `qdrant.points.retrieve` | Retrieve points | Fetch points by ID. |
| `qdrant.points.scroll` | Scroll points | Page through points by filter. |
| `qdrant.points.delete` | Delete points | Delete by ID list or by filter. |

Plus the `qdrant.meta.ping` meta function behind the settings dialog's **Test
connection** button.

## Credentials

The node holds **no** credentials. A Qdrant instance is configured per-account in
the node's **settings** (URL + optional API key); the platform stores it as a
named profile and folds it into every call as `body.settings`. Structured inputs
(vector, points, filter, IDs) are entered as **JSON**.

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
