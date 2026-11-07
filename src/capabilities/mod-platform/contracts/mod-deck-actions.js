/** Optional declarative buttons. Handlers still execute inside the approved mod
 * supervisor and may call only capabilities granted by its manifest. */
const { validateValue } = require("../../../shared/contracts/bounded-json-schema");
const record = (v) => v && typeof v === "object" && !Array.isArray(v);
const empty = { type: "object", additionalProperties: false, properties: {} };
function schema(value, depth = 0) {
  if (
    depth > 4 ||
    !record(value) ||
    !["object", "array", "string", "number", "integer", "boolean", "null"].includes(value.type)
  )
    return false;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "type",
          "title",
          "description",
          "properties",
          "required",
          "additionalProperties",
          "enum",
          "minimum",
          "maximum",
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "items",
        ].includes(key),
    )
  )
    return false;
  if (
    value.enum &&
    (!Array.isArray(value.enum) ||
      value.enum.length > 64 ||
      value.enum.some((v) => !["string", "number", "boolean"].includes(typeof v)))
  )
    return false;
  if (value.type === "object") {
    if (
      value.additionalProperties !== false ||
      !record(value.properties) ||
      Object.keys(value.properties).length > 32 ||
      !Object.entries(value.properties).every(
        ([key, child]) => /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(key) && schema(child, depth + 1),
      )
    )
      return false;
    if (
      value.required &&
      (!Array.isArray(value.required) ||
        value.required.some((k) => !Object.hasOwn(value.properties, k)))
    )
      return false;
  }
  if (
    value.type === "array" &&
    (!schema(value.items, depth + 1) ||
      !Number.isInteger(value.maxItems) ||
      value.maxItems > 64 ||
      value.maxItems < 0)
  )
    return false;
  return JSON.stringify(value).length <= 8192;
}
function normalize(value = [], provides, errors) {
  const invalid = (at) =>
    errors.push({
      path: "$.contributes.actions" + at,
      code: "invalid_button_action",
      message: "Use a bounded action targeting a provided capability and declared method.",
    });
  if (!Array.isArray(value) || value.length > 32) {
    invalid("");
    return [];
  }
  const ids = new Set(),
    actions = [];
  for (const [index, item] of value.entries()) {
    const parameters = item?.parameters || empty,
      defaults = item?.defaults || {};
    if (
      !record(item) ||
      Object.keys(item).some(
        (k) =>
          ![
            "id",
            "title",
            "description",
            "symbol",
            "capability",
            "method",
            "defaults",
            "parameters",
            "stateMethod",
          ].includes(k),
      ) ||
      !/^[a-z][a-z0-9._-]{0,39}$/.test(item.id || "") ||
      ids.has(item.id) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > 80 ||
      !provides.includes(item.capability) ||
      !/^[a-z][a-zA-Z0-9._-]{0,39}$/.test(item.method || "") ||
      (item.stateMethod !== undefined && !/^[a-z][a-zA-Z0-9._-]{0,39}$/.test(item.stateMethod)) ||
      !schema(parameters) ||
      !record(defaults) ||
      JSON.stringify(defaults).length > 4096 ||
      !validateValue({ ...parameters, required: [] }, defaults) ||
      (item.symbol !== undefined && (typeof item.symbol !== "string" || item.symbol.length > 64)) ||
      (item.description !== undefined &&
        (typeof item.description !== "string" || item.description.length > 240))
    ) {
      invalid(`[${index}]`);
      continue;
    }
    ids.add(item.id);
    actions.push({
      id: item.id,
      title: item.title.trim(),
      description: item.description || "",
      symbol: item.symbol || "✦",
      capability: item.capability,
      method: item.method,
      defaults: structuredClone(defaults),
      parameters: structuredClone(parameters),
      ...(item.stateMethod ? { stateMethod: item.stateMethod } : {}),
    });
  }
  return actions;
}
module.exports = { normalize, schema };
