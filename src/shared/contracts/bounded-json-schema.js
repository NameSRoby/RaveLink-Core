// Shared JSON Schema subset used by feature and Core client contracts.
const MAX_SCHEMA_DEPTH = 12;
function isRecord(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(schema, value, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(type => matchesType(value, type))) return false;
  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some(item => Object.is(item, value))) return false;
  if (typeof value === "string" && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength))) return false;
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (Array.isArray(value)) {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) return false;
    if (schema.items && value.some(item => !validateValue(schema.items, item, depth + 1))) return false;
  }
  if (isRecord(value)) {
    const properties = schema.properties || {};
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    for (const [key, child] of Object.entries(properties)) if (Object.hasOwn(value, key) && !validateValue(child, value[key], depth + 1)) return false;
  }
  return true;
}

module.exports = { validateValue };
