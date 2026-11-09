/** Discover Core's existing public action catalog; never expose service objects.
 * New first-party controls become available without a second mod action list.
 */
const { validateValue } = require("../../../shared/contracts/bounded-json-schema");
const capability = "ravelink.controls.v1";
module.exports = function bindAppControls(registry, actions) {
  if (!actions) return;
  const empty = (v) =>
    v === null || (v && typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  const object = (v) => v && typeof v === "object" && !Array.isArray(v);
  const pageValid = (v) =>
    empty(v) ||
    validateValue(
      {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0, maximum: 4096 },
          limit: { type: "integer", minimum: 1, maximum: 32 },
        },
        additionalProperties: false,
      },
      v,
    );
  const failure = (code) => ({
    ok: false,
    error: { code, message: code.replaceAll("_", " "), retryable: false },
  });
  const controls = () =>
    actions
      .catalog()
      .filter(
        (a) => !a.id.startsWith("mod:") && !a.id.startsWith("view.") && a.kind !== "navigation",
      );
  registry.registerCapabilityContract({
    capability,
    methods: {
      catalog: { validateRequest: pageValid, validateResponse: object },
      status: { validateRequest: pageValid, validateResponse: object },
      execute: {
        validateRequest: (v) =>
          object(v) &&
          Object.keys(v).every((k) => ["actionId", "params"].includes(k)) &&
          typeof v.actionId === "string" &&
          v.actionId.length <= 256 &&
          object(v.params),
        validateResponse: object,
      },
    },
  });
  registry.registerHostCapability({
    providerId: "ravelink.controls",
    capability,
    async invoke(_capability, method, payload, options = {}) {
      if (options.signal?.aborted) throw Error("request_cancelled");
      if (method === "catalog" || method === "status") await actions.refreshLive?.();
      if (method === "catalog" || method === "status") {
        const all = controls(),
          offset = payload?.offset || 0,
          limit = payload?.limit || 16;
        const page = all.slice(offset, offset + limit);
        return {
          ok: true,
          total: all.length,
          offset,
          nextOffset: offset + limit < all.length ? offset + limit : null,
          ...(method === "catalog"
            ? { actions: page }
            : {
                states: Object.fromEntries(
                  page.map((a) => [a.id, actions.feedback()[a.id] || null]),
                ),
              }),
        };
      }
      const action = controls().find((a) => a.id === payload.actionId);
      if (!action?.available) return failure("app_action_unavailable");
      if (!validateValue(action.parameters || {}, payload.params))
        return failure("app_action_parameters_invalid");
      const value = await actions.execute(
        action.id,
        payload.params,
        options.signal || new AbortController().signal,
      );
      return value?.ok === false ? failure("app_action_failed") : { ok: true, value: value ?? {} };
    },
  });
};
