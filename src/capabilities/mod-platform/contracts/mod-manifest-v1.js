// [TITLE] Module: capabilities/mod-platform/contracts/mod-manifest-v1.js
// [TITLE] Purpose: validate and normalize untrusted RaveLink mod manifests
// [TITLE] Functionality Index:
// [TITLE] - enforce the closed manifest v1 shape and compatibility range
// [TITLE] - reject unsafe package paths and broad network permissions
// [TITLE] - enforce capability, integrity, and resource declarations

const { isSafePackagePath } = require("../../../shared/packages/package-directory-integrity");
const { RESOURCE_LIMITS } = require("../../supervised-runtime/resource-limits-v1");

const MANIFEST_SCHEMA_VERSION = 1;
const MOD_API_MAJOR = 1;
const MAX_INTEGRITY_FILES = 2048;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/;
const PUBLISHER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/;
const TOKEN_RE = /^[a-z][a-z0-9._-]{0,79}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "id", "name", "description", "version", "publisher",
  "license", "entry", "engine", "activationEvents", "consumes", "provides",
  "permissions", "resources", "integrity", "contributes"
]);
const REQUIRED_TOP_LEVEL_KEYS = [
  "schemaVersion", "id", "name", "version", "publisher", "license", "entry",
  "engine", "activationEvents", "consumes", "provides", "permissions",
  "resources", "integrity"
];
const ENGINE_KEYS = new Set(["ravelinkModApi", "node"]);
const PERMISSION_KEYS = new Set(["network", "storage", "secrets", "ui", "process", "hardware"]);
const CONTRIBUTES_KEYS = new Set(["panels"]);
const PANEL_KEYS = new Set(["id", "title", "entry"]);
function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addError(errors, pathName, code, message) {
  errors.push({ path: pathName, code, message });
}

function checkClosedObject(value, pathName, allowed, errors) {
  if (!isRecord(value)) {
    addError(errors, pathName, "invalid_type", "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, `${pathName}.${key}`, "unknown_field", "field is not supported");
  }
  return true;
}

function checkString(value, pathName, errors, options = {}) {
  if (typeof value !== "string") {
    addError(errors, pathName, "invalid_type", "must be a string");
    return "";
  }
  const text = value.trim();
  if (text.length < Number(options.min || 0)) addError(errors, pathName, "too_short", `must contain at least ${options.min} characters`);
  if (text.length > Number(options.max || Infinity)) addError(errors, pathName, "too_long", `must contain at most ${options.max} characters`);
  if (options.pattern && !options.pattern.test(text)) addError(errors, pathName, "invalid_format", "has an unsupported format");
  return text;
}

function checkUniqueStringList(value, pathName, errors, options = {}) {
  if (!Array.isArray(value)) {
    addError(errors, pathName, "invalid_type", "must be an array");
    return [];
  }
  if (value.length > options.maxItems) addError(errors, pathName, "too_many_items", `must contain at most ${options.maxItems} items`);
  const out = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${pathName}[${index}]`;
    const item = checkString(value[index], itemPath, errors, { min: 1, max: options.maxLength || 100 });
    const identity = options.identity ? options.identity(item) : item;
    if (seen.has(identity)) addError(errors, itemPath, "duplicate_item", "duplicates an earlier item");
    seen.add(identity);
    if (options.validate) options.validate(item, itemPath, errors);
    out.push(item);
  }
  return out;
}

function isCompatibleModApiRange(range, major = MOD_API_MAJOR) {
  const text = String(range || "").trim();
  const exact = text.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (exact) return Number(exact[1]) === major;
  const anchored = text.match(/^[~^](\d+)(?:\.\d+){0,2}$/);
  if (anchored) return Number(anchored[1]) === major;
  const wildcard = text.match(/^(\d+)\.(?:x|\*)$/i);
  if (wildcard) return Number(wildcard[1]) === major;
  const bounded = text.match(/^>=(\d+)\.\d+\.\d+\s+<(\d+)\.\d+\.\d+$/);
  return Boolean(bounded && Number(bounded[1]) === major && Number(bounded[2]) === major + 1);
}

function validateActivationEvent(value, pathName, errors) {
  if (value === "onEnable") return;
  const match = value.match(/^(onCapability|onEvent|onCommand):(.+)$/);
  if (!match || value === "*" || /startup/i.test(value)) {
    addError(errors, pathName, "invalid_activation_event", "must be onEnable or a scoped capability, event, or command activation");
    return;
  }
  if (match[1] === "onCapability" && !CAPABILITY_RE.test(match[2])) {
    addError(errors, pathName, "invalid_activation_event", "capability activation must name a versioned capability");
  } else if (match[1] !== "onCapability" && !TOKEN_RE.test(match[2])) {
    addError(errors, pathName, "invalid_activation_event", "event and command activation tokens must be lowercase identifiers");
  }
}

function validateNetworkHost(value, pathName, errors) {
  if (!HOST_RE.test(value) || value.includes("*") || value === "localhost" || value.endsWith(".local")) {
    addError(errors, pathName, "invalid_network_host", "must be an exact public DNS hostname with an optional port");
    return;
  }
  const portText = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : "";
  if (portText && Number(portText) > 65535) addError(errors, pathName, "invalid_network_port", "port must be between 1 and 65535");
}

function validateManifestV1(input, options = {}) {
  const errors = [];
  if (!checkClosedObject(input, "$", TOP_LEVEL_KEYS, errors)) return { ok: false, errors, value: null };
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) addError(errors, `$.${key}`, "required", "field is required");
  }

  if (input.schemaVersion !== MANIFEST_SCHEMA_VERSION) addError(errors, "$.schemaVersion", "unsupported_schema", "only manifest schema version 1 is supported");
  const id = checkString(input.id, "$.id", errors, { min: 3, max: 64, pattern: ID_RE });
  const name = checkString(input.name, "$.name", errors, { min: 1, max: 80 });
  const description = input.description === undefined ? "" : checkString(input.description, "$.description", errors, { max: 500 });
  const version = checkString(input.version, "$.version", errors, { min: 1, max: 64, pattern: SEMVER_RE });
  const publisher = checkString(input.publisher, "$.publisher", errors, { min: 1, max: 64, pattern: PUBLISHER_RE });
  const license = checkString(input.license, "$.license", errors, { min: 1, max: 80 });
  const entry = checkString(input.entry, "$.entry", errors, { min: 1, max: 240 });
  if (id && publisher && !id.startsWith(`${publisher}.`)) addError(errors, "$.id", "publisher_mismatch", "id must begin with the declared publisher and a dot");
  if (!isSafePackagePath(entry) || !/\.(?:cjs|mjs|js)$/.test(entry)) addError(errors, "$.entry", "unsafe_entry", "must be a normalized relative JavaScript module path");

  let engine = {};
  if (checkClosedObject(input.engine, "$.engine", ENGINE_KEYS, errors)) {
    const apiRange = checkString(input.engine.ravelinkModApi, "$.engine.ravelinkModApi", errors, { min: 1, max: 40 });
    const nodeRange = checkString(input.engine.node, "$.engine.node", errors, { min: 1, max: 40 });
    if (!isCompatibleModApiRange(apiRange, Number(options.modApiMajor || MOD_API_MAJOR))) {
      addError(errors, "$.engine.ravelinkModApi", "incompatible_api", `must accept mod API major ${Number(options.modApiMajor || MOD_API_MAJOR)}`);
    }
    if (!/^[0-9A-Za-z.*^~<>=| -]+$/.test(nodeRange)) addError(errors, "$.engine.node", "invalid_range", "contains unsupported range characters");
    engine = { ravelinkModApi: apiRange, node: nodeRange };
  }

  const activationEvents = checkUniqueStringList(input.activationEvents, "$.activationEvents", errors, {
    maxItems: 16, maxLength: 100, validate: validateActivationEvent
  });
  const consumes = checkUniqueStringList(input.consumes, "$.consumes", errors, {
    maxItems: 32,
    maxLength: 100,
    identity: item => item.replace(/\?$/, ""),
    validate(item, itemPath, listErrors) {
      if (!CAPABILITY_RE.test(item.replace(/\?$/, ""))) addError(listErrors, itemPath, "invalid_capability", "must be a versioned capability with optional ? suffix");
    }
  });
  const provides = checkUniqueStringList(input.provides, "$.provides", errors, {
    maxItems: 32,
    maxLength: 100,
    validate(item, itemPath, listErrors) {
      if (!CAPABILITY_RE.test(item)) addError(listErrors, itemPath, "invalid_capability", "must be a versioned capability");
    }
  });

  const panels = [];
  if (input.contributes !== undefined && checkClosedObject(input.contributes, "$.contributes", CONTRIBUTES_KEYS, errors)) {
    if (!Array.isArray(input.contributes.panels)) {
      addError(errors, "$.contributes.panels", "invalid_type", "must be an array");
    } else if (input.contributes.panels.length > 4) {
      addError(errors, "$.contributes.panels", "too_many_items", "must contain at most 4 panels");
    } else {
      const panelIds = new Set();
      for (let index = 0; index < input.contributes.panels.length; index += 1) {
        const panel = input.contributes.panels[index];
        const panelPath = `$.contributes.panels[${index}]`;
        if (!checkClosedObject(panel, panelPath, PANEL_KEYS, errors)) continue;
        const panelId = checkString(panel.id, `${panelPath}.id`, errors, { min: 1, max: 40, pattern: TOKEN_RE });
        const title = checkString(panel.title, `${panelPath}.title`, errors, { min: 1, max: 60 });
        const panelEntry = checkString(panel.entry, `${panelPath}.entry`, errors, { min: 1, max: 240 });
        if (panelIds.has(panelId)) addError(errors, `${panelPath}.id`, "duplicate_item", "duplicates an earlier panel id");
        panelIds.add(panelId);
        if (!isSafePackagePath(panelEntry) || !panelEntry.endsWith(".html")) {
          addError(errors, `${panelPath}.entry`, "unsafe_entry", "must be a normalized relative HTML file path");
        }
        panels.push({ id: panelId, title, entry: panelEntry });
      }
    }
  }

  const permissions = {};
  if (checkClosedObject(input.permissions, "$.permissions", PERMISSION_KEYS, errors)) {
    permissions.network = checkUniqueStringList(input.permissions.network || [], "$.permissions.network", errors, {
      maxItems: 32, maxLength: 253, validate: validateNetworkHost
    });
    permissions.secrets = checkUniqueStringList(input.permissions.secrets || [], "$.permissions.secrets", errors, {
      maxItems: 32, maxLength: 80,
      validate(item, itemPath, listErrors) { if (!TOKEN_RE.test(item)) addError(listErrors, itemPath, "invalid_secret_handle", "must be a lowercase handle name"); }
    });
    permissions.hardware = checkUniqueStringList(input.permissions.hardware || [], "$.permissions.hardware", errors, {
      maxItems: 16, maxLength: 80,
      validate(item, itemPath, listErrors) { if (!TOKEN_RE.test(item)) addError(listErrors, itemPath, "invalid_hardware_capability", "must be a lowercase capability name"); }
    });
    for (const flag of ["storage", "ui", "process"]) {
      const value = input.permissions[flag] === undefined ? false : input.permissions[flag];
      if (typeof value !== "boolean") addError(errors, `$.permissions.${flag}`, "invalid_type", "must be boolean");
      permissions[flag] = value === true;
    }
    if (panels.length && permissions.ui !== true) addError(errors, "$.permissions.ui", "ui_permission_required", "must be true when UI panels are contributed");
  }

  const resourceKeys = new Set(Object.keys(RESOURCE_LIMITS));
  const resources = {};
  if (checkClosedObject(input.resources, "$.resources", resourceKeys, errors)) {
    for (const [key, [minimum, maximum, kind]] of Object.entries(RESOURCE_LIMITS)) {
      const value = input.resources[key];
      if (typeof value !== "number" || !Number.isFinite(value) || (kind === "integer" && !Number.isInteger(value))) {
        addError(errors, `$.resources.${key}`, "invalid_type", `must be a finite ${kind}`);
      } else if (value < minimum || value > maximum) {
        addError(errors, `$.resources.${key}`, "resource_limit", `must be between ${minimum} and ${maximum}`);
      }
      resources[key] = value;
    }
    if (Number(resources.activeRssMiB) < Number(resources.idleRssMiB)) {
      addError(errors, "$.resources.activeRssMiB", "resource_order", "must be greater than or equal to idleRssMiB");
    }
  }

  const integrity = { algorithm: "", files: {} };
  if (checkClosedObject(input.integrity, "$.integrity", new Set(["algorithm", "files"]), errors)) {
    if (input.integrity.algorithm !== "sha256") addError(errors, "$.integrity.algorithm", "unsupported_integrity", "only sha256 is supported");
    integrity.algorithm = input.integrity.algorithm;
    if (!isRecord(input.integrity.files)) {
      addError(errors, "$.integrity.files", "invalid_type", "must be an object keyed by package-relative path");
    } else {
      const rows = Object.entries(input.integrity.files);
      if (rows.length < 1 || rows.length > MAX_INTEGRITY_FILES) addError(errors, "$.integrity.files", "integrity_file_count", `must contain between 1 and ${MAX_INTEGRITY_FILES} files`);
      for (const [file, hash] of rows) {
        if (!isSafePackagePath(file)) addError(errors, `$.integrity.files.${file}`, "unsafe_integrity_path", "must be a normalized package-relative path");
        if (typeof hash !== "string" || !HASH_RE.test(hash)) addError(errors, `$.integrity.files.${file}`, "invalid_hash", "must be a lowercase sha256 hex digest");
        integrity.files[file] = hash;
      }
      if (entry && !Object.prototype.hasOwnProperty.call(input.integrity.files, entry)) addError(errors, "$.integrity.files", "entry_not_hashed", "must include the manifest entry file");
      for (const panel of panels) {
        if (panel.entry && !Object.prototype.hasOwnProperty.call(input.integrity.files, panel.entry)) {
          addError(errors, "$.integrity.files", "panel_not_hashed", `must include UI panel ${panel.id}`);
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors, value: null };
  return {
    ok: true,
    errors: [],
    value: Object.freeze({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      id, name, description, version, publisher, license, entry,
      engine: Object.freeze(engine),
      activationEvents: Object.freeze(activationEvents),
      consumes: Object.freeze(consumes),
      provides: Object.freeze(provides),
      permissions: Object.freeze({
        network: Object.freeze(permissions.network),
        storage: permissions.storage,
        secrets: Object.freeze(permissions.secrets),
        ui: permissions.ui,
        process: permissions.process,
        hardware: Object.freeze(permissions.hardware)
      }),
      contributes: Object.freeze({ panels: Object.freeze(panels.map(panel => Object.freeze({ ...panel }))) }),
      resources: Object.freeze(resources),
      integrity: Object.freeze({ algorithm: integrity.algorithm, files: Object.freeze({ ...integrity.files }) })
    })
  };
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  MOD_API_MAJOR,
  RESOURCE_LIMITS,
  isCompatibleModApiRange,
  isSafePackagePath,
  validateManifestV1
};
