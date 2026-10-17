/**
 * Data contract compiler.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#supervised-workers-contracts-and-packages
 */
const fs = require("node:fs");
const path = require("node:path");

const CAPABILITY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/;
const METHOD_RE = /^[a-z][a-z0-9._-]{0,79}$/;
const PROPERTY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,79}$/;
const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "const",
  "enum",
  "required",
  "additionalProperties",
  "properties",
  "items",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
]);
const ALLOWED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 512;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateSchemaShape(schema, state, depth = 0) {
  if (!isRecord(schema) || depth > MAX_SCHEMA_DEPTH || ++state.nodes > MAX_SCHEMA_NODES)
    return false;
  if (Object.keys(schema).some((key) => !ALLOWED_SCHEMA_KEYS.has(key))) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.some((type) => !ALLOWED_TYPES.has(type))) return false;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
  )
    return false;
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    return false;
  if (schema.properties !== undefined) {
    if (
      !isRecord(schema.properties) ||
      Object.entries(schema.properties).some(
        ([key, child]) => !PROPERTY_RE.test(key) || !validateSchemaShape(child, state, depth + 1),
      )
    )
      return false;
  }
  if (schema.items !== undefined && !validateSchemaShape(schema.items, state, depth + 1))
    return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length > 64))
    return false;
  return true;
}

const { validateValue } = require("../../../shared/contracts/bounded-json-schema");

async function compileFeatureContracts(packageRoot, manifest) {
  const contracts = new Map();
  for (const relative of manifest.contracts) {
    let document;
    try {
      document = JSON.parse(
        await fs.promises.readFile(path.join(packageRoot, ...relative.split("/")), "utf8"),
      );
    } catch {
      return { ok: false, error: "contract_invalid_json", file: relative };
    }
    if (
      !isRecord(document) ||
      document.schemaVersion !== 1 ||
      !Array.isArray(document.contracts) ||
      Object.keys(document).some((key) => !["schemaVersion", "contracts"].includes(key))
    ) {
      return { ok: false, error: "contract_document_invalid", file: relative };
    }
    for (const descriptor of document.contracts) {
      if (
        !isRecord(descriptor) ||
        !CAPABILITY_RE.test(descriptor.capability) ||
        Object.keys(descriptor).some((key) => !["capability", "methods", "events"].includes(key)) ||
        contracts.has(descriptor.capability)
      ) {
        return {
          ok: false,
          error: "contract_descriptor_invalid",
          file: relative,
        };
      }
      const methods = new Map();
      const events = new Map();
      for (const [name, pair] of Object.entries(descriptor.methods || {})) {
        if (
          !METHOD_RE.test(name) ||
          !isRecord(pair) ||
          !isRecord(pair.request) ||
          !isRecord(pair.response) ||
          Object.keys(pair).some((key) => !["request", "response"].includes(key))
        )
          return {
            ok: false,
            error: "contract_method_invalid",
            file: relative,
          };
        if (
          !validateSchemaShape(pair.request, { nodes: 0 }) ||
          !validateSchemaShape(pair.response, { nodes: 0 })
        )
          return {
            ok: false,
            error: "contract_schema_invalid",
            file: relative,
          };
        methods.set(name, {
          request: (value) => validateValue(pair.request, value),
          response: (value) => validateValue(pair.response, value),
        });
      }
      for (const [name, schema] of Object.entries(descriptor.events || {})) {
        if (!METHOD_RE.test(name) || !validateSchemaShape(schema, { nodes: 0 }))
          return { ok: false, error: "contract_event_invalid", file: relative };
        events.set(name, (value) => validateValue(schema, value));
      }
      if (!methods.size && !events.size)
        return { ok: false, error: "contract_empty", file: relative };
      contracts.set(descriptor.capability, { methods, events });
    }
  }
  const provided = new Set(manifest.provides);
  if (
    contracts.size !== provided.size ||
    [...provided].some((capability) => !contracts.has(capability))
  )
    return { ok: false, error: "contract_capability_mismatch" };
  return { ok: true, contracts };
}

module.exports = { compileFeatureContracts, validateValue };
