// Command qdrant is an Inflowenger plugin node for the Qdrant vector database.
//
// It exposes collection and point operations on the workflow canvas — create and
// list collections, upsert points, run a vector search, retrieve by id, scroll by
// filter, and delete. The node holds NO credentials: a Qdrant instance is
// configured per-account in the node's settings dialog (URL + optional API key),
// and every action receives that connection as body.settings and talks to Qdrant's
// REST API directly. One running plugin serves many accounts and many instances.
//
// Runs on any host that speaks inflowv1 — it reaches no host-specific service.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newPlugin, withDotEnv, withTimeout } from "@inflowenger/node-plugin-sdk";
import { Registry } from "./actions/registry.js";

// The manual is authored as Markdown next to this module (src/manual.md, copied to
// dist/manual.md by the build) and rendered on the plugin's page. Read it relative
// to this file so it resolves under both `tsx src` (dev) and `node dist` (prod).
function loadManual(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "manual.md"), "utf8");
  } catch (e) {
    console.warn("qdrant: manual.md not found, serving empty manual:", e);
    return "";
  }
}

// A vector search or a large upsert can take longer than the SDK's 5s default;
// raise the request/reply deadline. REQ_TIMEOUT (env) overrides this at deploy.
const SEND_TIMEOUT_SECONDS = 30;

const version = "v0.1.0";

async function main() {
  const envFile = process.env.INFLOW_ENV_FILE || ".env.inflow";

  // The dotenv carries the platform identity only — PLUGIN_ID, INFRA_CRED,
  // INFRA_URL. No Qdrant configuration ever lives here.
  const p = await newPlugin(withDotEnv(envFile), withTimeout(SEND_TIMEOUT_SECONDS));

  const registry = new Registry();

  p.intro({
    name: "QDRANT",
    author: "inflow Dev. Team",
    version,
    settings: registry.settingsForm(),
    manual: loadManual(),
  });
  p.requiredParams(registry.settings());

  const actions = registry.all();
  p.addAction(...actions);
  p.addMeta(...registry.metas());

  p.start();

  const methods = actions.map((a) => a.method).join(", ");
  console.log(`qdrant plugin ${version} ready with ${actions.length} actions: ${methods}`);

  // start() only wires up subscriptions; the process must stay alive to serve them.
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
