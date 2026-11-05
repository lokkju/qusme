import type { JsonObject, JsonValue } from './validate.ts';

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Spec 10.2's rules below the top level: objects merge, `null` removes, the rest replaces. */
function mergeObjects(base: JsonObject, override: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === null) delete out[key];
    else {
      const current = out[key];
      out[key] = isObject(current) && isObject(value) ? mergeObjects(current, value) : value;
    }
  }
  return out;
}

/** `fields` merges by `name`: a known name merges over that field, a new one is appended. */
function mergeFields(base: JsonValue[], override: JsonValue[]): JsonValue[] {
  const out = [...base];
  for (const entry of override) {
    const name = isObject(entry) ? entry.name : undefined;
    const at = typeof name === 'string' ? out.findIndex((f) => isObject(f) && f.name === name) : -1;
    const current = out[at];
    if (at !== -1 && isObject(current) && isObject(entry)) out[at] = mergeObjects(current, entry);
    else out.push(entry);
  }
  return out;
}

/**
 * The effective site definition (spec 10.2): the official definition with a destination's
 * `override` merged over it. Objects merge key by key, recursively; a scalar replaces; `null`
 * removes the key; arrays replace whole, except `fields`, whose entries merge by `name`. With no
 * official definition (a custom destination) the override is the whole definition. Returns JSON
 * for {@link readSiteDefinition} to validate, or undefined when there is neither.
 */
export function mergeSiteOverride(
  official: JsonObject | undefined,
  override: JsonObject | null | undefined
): JsonObject | undefined {
  if (override === null || override === undefined) return official;
  if (official === undefined) return mergeObjects({}, override);
  const { fields, ...rest } = override;
  const merged = mergeObjects(official, rest);
  if (fields === undefined) return merged;
  const base = official.fields;
  if (Array.isArray(base) && Array.isArray(fields)) merged.fields = mergeFields(base, fields);
  else if (fields === null) delete merged.fields;
  else merged.fields = fields;
  return merged;
}
