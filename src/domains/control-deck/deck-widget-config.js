const types = [
  "now-playing",
  "queue",
  "next-request",
  "stream",
  "audience",
  "viewers",
  "followers",
  "subscribers",
  "clips",
  "markers",
  "obs",
  "rewards",
  "connections",
  "clock",
];
const fail = () => {
  throw Object.assign(Error("control_deck_widgets_invalid"), {
    code: "control_deck_widgets_invalid",
  });
};
module.exports = function widgetsConfig(input = { enabled: true, columns: 3, items: [] }) {
  if (
    !input ||
    Object.keys(input).some((k) => !["enabled", "columns", "items", "fullscreen"].includes(k)) ||
    typeof input.enabled !== "boolean" ||
    (input.fullscreen !== undefined && typeof input.fullscreen !== "boolean") ||
    !Number.isInteger(input.columns) ||
    input.columns < 1 ||
    input.columns > 6 ||
    !Array.isArray(input.items) ||
    input.items.length > 24
  )
    fail();
  const ids = new Set();
  return {
    enabled: input.enabled,
    fullscreen: input.fullscreen ?? true,
    columns: input.columns,
    items: input.items.map((row) => {
      if (
        !row ||
        Object.keys(row).some(
          (k) =>
            ![
              "id",
              "type",
              "title",
              "span",
              "size",
              "surface",
              "showTitle",
              "color",
              "artwork",
              "progress",
              "requester",
              "next",
              "details",
              "rows",
              "clock24",
              "utc",
            ].includes(k),
        ) ||
        typeof row.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(row.id) ||
        ids.has(row.id) ||
        !types.includes(row.type)
      )
        fail();
      ids.add(row.id);
      const value = {
        id: row.id,
        type: row.type,
        title: row.title ?? "",
        span: row.span ?? 1,
        size: row.size ?? "compact",
        surface: row.surface ?? "transparent",
        showTitle: row.showTitle ?? !!row.title,
        color: row.color ?? "#a90036",
        artwork: row.artwork ?? row.type === "now-playing",
        progress: row.progress ?? row.type === "now-playing",
        requester: row.requester ?? true,
        next: row.next ?? true,
        details: row.details ?? false,
        rows: row.rows ?? 1,
        clock24: row.clock24 ?? true,
        utc: row.utc ?? false,
      };
      if (
        typeof value.title !== "string" ||
        value.title.length > 80 ||
        !Number.isInteger(value.span) ||
        value.span < 1 ||
        value.span > 6 ||
        !["compact", "normal", "large"].includes(value.size) ||
        typeof value.color !== "string" ||
        !/^#[a-f0-9]{6}$/i.test(value.color) ||
        !Number.isInteger(value.rows) ||
        value.rows < 1 ||
        value.rows > 10 ||
        !["glass", "plain", "transparent"].includes(value.surface) ||
        ["showTitle", "artwork", "progress", "requester", "next", "details", "clock24", "utc"].some(
          (k) => typeof value[k] !== "boolean",
        )
      )
        fail();
      return value;
    }),
  };
};
module.exports.types = types;
