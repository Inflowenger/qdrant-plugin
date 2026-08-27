// Resolve {{$...}} JsonPath tokens in an action's inputs against the flow scope,
// so a payload tag, a filter value, or a query text can reference upstream data
// the same way. Ported from the clickhouse/postgres plugins' vars, and extended
// to walk the key/value rows the Upsert and Vector search forms collect.

import type { Job } from "@inflowenger/node-plugin-sdk";

// {{ $.a.b }} — capture the JSON path inside the mustaches.
const VAR_RE = /\{\{\s*(\$[^}]+?)\s*\}\}/g;

const decoder = new TextDecoder();

/**
 * A per-call resolver for {{$...}} tokens. It holds a cache so each distinct path
 * is fetched from the runtime only once, however many fields reference it.
 */
export class VarResolver {
  private readonly cache = new Map<string, string>();

  constructor(private readonly job: Job) {}

  /**
   * Substitute every {{$...}} token in the string. Tokens the scope can't supply
   * are left verbatim so nothing is silently dropped.
   */
  async resolve(text: string): Promise<string> {
    if (!text.includes("{{")) return text;
    const matches = [...text.matchAll(VAR_RE)];
    let out = text;
    for (const m of matches) {
      const path = m[1].trim();
      let value = this.cache.get(path);
      if (value === undefined) {
        value = await this.fetch(path);
        this.cache.set(path, value);
      }
      out = out.replace(m[0], value);
    }
    return out;
  }

  // fetch reads a JSON path from the flow context. The reply is JSON: a JSON
  // string is unwrapped to its value, anything else is returned raw so it can be
  // inlined into the field.
  private async fetch(jsonPath: string): Promise<string> {
    let raw: Uint8Array;
    try {
      raw = await this.job.cmdGetScope(jsonPath);
    } catch {
      return `{{${jsonPath}}}`; // leave the token in place
    }
    if (!raw || raw.length === 0) return `{{${jsonPath}}}`;
    const text = decoder.decode(raw);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed;
    } catch {
      // not JSON — return the raw bytes as text
    }
    return text;
  }
}

/**
 * Walk a decoded action input and rewrite {{$...}} tokens in every string it
 * holds, at any depth, sharing one resolver so a path referenced more than once
 * is fetched once. This is the single place JsonPath resolution is turned on:
 * because it descends into strings, arrays, and nested objects alike, every
 * text-bearing form field an action carries is resolvable — a collection name, a
 * query text, the halves of a key/value row, and the tokens inside a JSON
 * textarea (filter, ids, vector, points, offset) whether that field arrives as
 * raw text or already parsed. Non-string leaves (numbers, booleans, null) pass
 * through untouched, and a value with no `{{` never hits the runtime, so this is
 * safe to run over every action's input.
 */
export async function resolveInputVars<T extends Record<string, unknown>>(
  job: Job,
  input: T,
  resolver: VarResolver = new VarResolver(job),
): Promise<void> {
  for (const key of Object.keys(input)) {
    input[key as keyof T] = (await resolveValue(input[key], resolver)) as T[keyof T];
  }
}

// resolveValue rewrites tokens in one value, recursing to any depth: a string
// directly, an array element-wise, and an object property-wise (so nested
// objects and the values of a {key,value} row are covered). Numbers, booleans
// and null pass through untouched.
async function resolveValue(value: unknown, resolver: VarResolver): Promise<unknown> {
  if (typeof value === "string") return resolver.resolve(value);
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = await resolveValue(value[i], resolver);
    return out;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) obj[k] = await resolveValue(obj[k], resolver);
    return obj;
  }
  return value;
}
