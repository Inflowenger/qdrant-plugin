# Qdrant

Talk to a [Qdrant](https://qdrant.tech) vector database from a workflow — manage
collections and read and write points.

## Setup

Open the node's **settings** and enter:

- **Qdrant URL** — e.g. `http://localhost:6333` or your Qdrant Cloud endpoint.
- **API key** — optional; required by Qdrant Cloud and any secured instance.

Press **Test connection** to confirm the instance is reachable before saving. The
plugin stores nothing — the platform keeps the profile and hands it to each action.

## Actions

| Action | What it does |
|--------|--------------|
| **Create collection** | Create a collection with a vector size and distance metric. |
| **List collections** | Names of every collection on the instance. |
| **Upsert points** | Insert or overwrite points (`id` + `vector` + `payload`). |
| **Vector search** | Nearest-neighbour search for a query vector, optionally filtered. |
| **Retrieve points** | Fetch points by their IDs. |
| **Scroll points** | Page through points by filter, no query vector. |
| **Delete points** | Delete by an ID list or by a payload filter. |

Structured fields (vector, points, filter, IDs) are entered as **JSON**. For
example, a search filter:

```json
{ "must": [ { "key": "tag", "match": { "value": "docs" } } ] }
```

## Test the connection

The button below lists collections using the saved settings profile.

```inflow-meta
qdrant.meta.ping
```
