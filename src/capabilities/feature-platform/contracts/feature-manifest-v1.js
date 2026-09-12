const { isSafePackagePath } = require("../../../shared/packages/package-directory-integrity");
const { RESOURCE_LIMITS } = require("../../supervised-runtime/resource-limits-v1");

const MANIFEST_SCHEMA_VERSION = 1;
const FEATURE_API_MAJOR = 1;
const ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]*$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
const PAGE_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const TOP_KEYS = new Set(["schemaVersion", "id", "name", "description", "version", "publisher", "entry", "engine", "consumes", "provides", "contracts", "permissions", "resources", "integrity", "contributes"]);
const REQUIRED = ["schemaVersion", "id", "name", "version", "publisher", "entry", "engine", "consumes", "provides", "contracts", "permissions", "resources", "integrity"];

const record = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const error = (errors, path, code) => errors.push({ path, code });

function strings(value, path, errors, options = {}) {
  if (!Array.isArray(value) || value.length > options.maximum) { error(errors, path, "invalid_list"); return []; }
  const out = [];
  const seen = new Set();
  value.forEach((raw, index) => {
    const item = typeof raw === "string" ? raw.trim() : "";
    const identity = options.identity ? options.identity(item) : item;
    if (!item || item.length > (options.length || 120) || seen.has(identity) || !options.valid(item)) error(errors, `${path}[${index}]`, "invalid_item");
    seen.add(identity);
    out.push(item);
  });
  return out;
}

function apiCompatible(value) {
  const match = String(value || "").match(/^[~^]?(\d+)(?:\.\d+){0,2}$/);
  return Boolean(match && Number(match[1]) === FEATURE_API_MAJOR);
}

function validateFeatureManifestV1(input) {
  const errors = [];
  if (!record(input)) return { ok: false, value: null, errors: [{ path: "$", code: "invalid_type" }] };
  Object.keys(input).forEach(key => { if (!TOP_KEYS.has(key)) error(errors, `$.${key}`, "unknown_field"); });
  REQUIRED.forEach(key => { if (!Object.hasOwn(input, key)) error(errors, `$.${key}`, "required"); });
  if (input.schemaVersion !== MANIFEST_SCHEMA_VERSION) error(errors, "$.schemaVersion", "unsupported_schema");
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!ID_RE.test(id)) error(errors, "$.id", "invalid_id");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) error(errors, "$.name", "invalid_name");
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description.length > 500) error(errors, "$.description", "invalid_description");
  const version = typeof input.version === "string" ? input.version.trim() : "";
  if (!SEMVER_RE.test(version)) error(errors, "$.version", "invalid_version");
  if (input.publisher !== "ravelink") error(errors, "$.publisher", "publisher_not_first_party");
  const entry = typeof input.entry === "string" ? input.entry.trim() : "";
  if (!isSafePackagePath(entry) || !/\.(?:js|cjs|mjs)$/.test(entry)) error(errors, "$.entry", "unsafe_entry");

  const engine = record(input.engine) ? input.engine : {};
  if (!record(input.engine) || Object.keys(engine).some(key => !["featureApi", "node"].includes(key))) error(errors, "$.engine", "invalid_engine");
  if (!apiCompatible(engine.featureApi)) error(errors, "$.engine.featureApi", "incompatible_api");
  if (typeof engine.node !== "string" || !/^[0-9A-Za-z.*^~<>=| -]{1,40}$/.test(engine.node)) error(errors, "$.engine.node", "invalid_range");

  const consumes = strings(input.consumes, "$.consumes", errors, { maximum: 32, valid: value => CAPABILITY_RE.test(value.replace(/\?$/, "")), identity: value => value.replace(/\?$/, "") });
  const provides = strings(input.provides, "$.provides", errors, { maximum: 32, valid: value => CAPABILITY_RE.test(value) });
  if (!provides.length) error(errors, "$.provides", "provided_capability_required");
  const consumedCapabilities = new Set(consumes.map(value => value.replace(/\?$/, "")));
  provides.forEach((capability, index) => { if (consumedCapabilities.has(capability)) error(errors, `$.provides[${index}]`, "capability_overlap"); });
  const contracts = strings(input.contracts, "$.contracts", errors, { maximum: 16, length: 240, valid: value => isSafePackagePath(value) && value.endsWith(".json") });
  if (!contracts.length) error(errors, "$.contracts", "contract_required");

  const permissions = record(input.permissions) ? input.permissions : {};
  if (!record(input.permissions) || Object.keys(permissions).some(key => !["network", "storage", "secrets", "process", "hardware"].includes(key))) error(errors, "$.permissions", "invalid_permissions");
  const network = strings(permissions.network || [], "$.permissions.network", errors, { maximum: 16, length: 253, valid: value => HOST_RE.test(value) && !value.includes("*") && !value.endsWith(".local") });
  const secrets = strings(permissions.secrets || [], "$.permissions.secrets", errors, { maximum: 16, length: 80, valid: value => /^[a-z][a-z0-9._-]*$/.test(value) });
  const hardware = strings(permissions.hardware || [], "$.permissions.hardware", errors, { maximum: 16, length: 80, valid: value => /^[a-z][a-z0-9._-]*$/.test(value) });
  for (const flag of ["storage", "process"]) if (permissions[flag] !== undefined && typeof permissions[flag] !== "boolean") error(errors, `$.permissions.${flag}`, "invalid_flag");

  const resources = record(input.resources) ? input.resources : {};
  if (!record(input.resources) || Object.keys(resources).some(key => !Object.hasOwn(RESOURCE_LIMITS, key))) error(errors, "$.resources", "invalid_resources");
  for (const [key, [minimum, maximum, kind]] of Object.entries(RESOURCE_LIMITS)) {
    const value = resources[key];
    if (typeof value !== "number" || !Number.isFinite(value) || (kind === "integer" && !Number.isInteger(value)) || value < minimum || value > maximum) error(errors, `$.resources.${key}`, "resource_limit");
  }
  if (Number(resources.activeRssMiB) < Number(resources.idleRssMiB)) error(errors, "$.resources.activeRssMiB", "resource_order");

  const contributes = record(input.contributes) ? input.contributes : {};
  if (input.contributes !== undefined && (!record(input.contributes) || Object.keys(contributes).some(key => key !== "pages"))) error(errors, "$.contributes", "invalid_contributes");
  const pages = [];
  if (contributes.pages !== undefined) {
    if (!Array.isArray(contributes.pages) || contributes.pages.length > 8) error(errors, "$.contributes.pages", "invalid_list");
    else {
      const pageIds = new Set();
      contributes.pages.forEach((raw, index) => {
        const page = record(raw) ? raw : {};
        const pagePath = `$.contributes.pages[${index}]`;
        if (!record(raw) || Object.keys(page).some(key => !["id", "title", "entry", "surface", "embedHosts", "imageHosts", "capabilities"].includes(key))) error(errors, pagePath, "invalid_page");
        const pageId = typeof page.id === "string" ? page.id.trim() : "";
        const title = typeof page.title === "string" ? page.title.trim() : "";
        const pageEntry = typeof page.entry === "string" ? page.entry.trim() : "";
        const surface = page.surface === "overlay" ? "overlay" : page.surface === "panel" ? "panel" : "";
        if (!PAGE_ID_RE.test(pageId) || pageIds.has(pageId)) error(errors, `${pagePath}.id`, "invalid_id");
        if (!title || title.length > 80) error(errors, `${pagePath}.title`, "invalid_title");
        if (!isSafePackagePath(pageEntry) || !pageEntry.endsWith(".html")) error(errors, `${pagePath}.entry`, "unsafe_entry");
        if (!surface) error(errors, `${pagePath}.surface`, "invalid_surface");
        const embedHosts = strings(page.embedHosts || [], `${pagePath}.embedHosts`, errors, { maximum: 4, length: 253, valid: value => HOST_RE.test(value) && !value.includes("*") && !value.endsWith(".local") });
        const imageHosts = strings(page.imageHosts || [], `${pagePath}.imageHosts`, errors, { maximum: 4, length: 253, valid: value => HOST_RE.test(value) && !value.includes("*") && !value.endsWith(".local") });
        const pageCapabilities = strings(page.capabilities || [], `${pagePath}.capabilities`, errors, { maximum: 16, length: 100, valid: value => CAPABILITY_RE.test(value) && provides.includes(value) });
        pageIds.add(pageId);
        pages.push({ id: pageId, title, entry: pageEntry, surface, embedHosts: Object.freeze(embedHosts), imageHosts: Object.freeze(imageHosts), capabilities: Object.freeze(pageCapabilities) });
      });
    }
  }

  const integrity = record(input.integrity) ? input.integrity : {};
  if (!record(input.integrity) || integrity.algorithm !== "sha256" || !record(integrity.files)) error(errors, "$.integrity", "invalid_integrity");
  const integrityFiles = {};
  const integrityRows = Object.entries(integrity.files || {});
  if (integrityRows.length < 1 || integrityRows.length > 2048) error(errors, "$.integrity.files", "integrity_file_count");
  for (const [file, hash] of integrityRows) {
    if (!isSafePackagePath(file) || !HASH_RE.test(String(hash))) error(errors, `$.integrity.files.${file}`, "invalid_integrity_entry");
    integrityFiles[file] = hash;
  }
  if (!Object.hasOwn(integrityFiles, entry)) error(errors, "$.integrity.files", "entry_not_hashed");
  contracts.forEach(file => { if (!Object.hasOwn(integrityFiles, file)) error(errors, "$.integrity.files", "contract_not_hashed"); });
  pages.forEach(page => { if (!Object.hasOwn(integrityFiles, page.entry)) error(errors, "$.integrity.files", "page_not_hashed"); });
  if (errors.length) return { ok: false, value: null, errors };
  return { ok: true, errors: [], value: Object.freeze({
    schemaVersion: 1, id, name, description, version, publisher: "ravelink", entry,
    engine: Object.freeze({ featureApi: engine.featureApi, node: engine.node }),
    consumes: Object.freeze(consumes), provides: Object.freeze(provides), contracts: Object.freeze(contracts),
    permissions: Object.freeze({ network: Object.freeze(network), storage: permissions.storage === true, secrets: Object.freeze(secrets), process: permissions.process === true, hardware: Object.freeze(hardware) }),
    resources: Object.freeze({ ...resources }),
    contributes: Object.freeze({ pages: Object.freeze(pages.map(page => Object.freeze(page))) }),
    integrity: Object.freeze({ algorithm: "sha256", files: Object.freeze(integrityFiles) })
  }) };
}

module.exports = { FEATURE_API_MAJOR, MANIFEST_SCHEMA_VERSION, validateFeatureManifestV1 };
