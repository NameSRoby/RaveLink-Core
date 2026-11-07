/** Resolve current source instances. All-scenes toggles use one shared destination state. */
module.exports = function visibility({ cache, sceneItems }) {
  const containers = () => [
    ...cache.scenes.map((r) => ({ name: r.sceneName, group: false })),
    ...(cache.groups || []).map((name) => ({ name, group: true })),
  ];
  const matching = (target, parent, rows) =>
    rows
      .filter(
        (r) =>
          r.sourceName === target.sourceName &&
          (target.scope === "all" || r.sceneItemId === target.sceneItemId),
      )
      .map((r) => ({ ...r, sceneName: parent.name, group: parent.group }));
  const parents = (t) =>
    t.scope === "all" ? containers() : [{ name: t.sceneName, group: t.group }];
  return {
    cached(t) {
      return parents(t).flatMap((p) =>
        matching(t, p, cache.items.get((p.group ? "group:" : "scene:") + p.name) || []),
      );
    },
    async read(t, force = false) {
      const rows = [];
      const locations = parents(t);
      for (let i = 0; i < locations.length; i += 3) {
        const batch = await Promise.all(
          locations
            .slice(i, i + 3)
            .map(async (p) => matching(t, p, await sceneItems(p.name, p.group, force))),
        );
        rows.push(...batch.flat());
      }
      return rows;
    },
  };
};
