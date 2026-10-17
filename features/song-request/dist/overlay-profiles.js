/**
 * Overlay profiles.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#song-requests-providers-and-playback
 */
const { DEFAULT_OVERLAY, overlayFrom } = require("./overlay-config");
const overlayPresets = require("./overlay-presets");
const { randomUUID } = require("node:crypto");
function createOverlayProfiles({ now, text }) {
  let overlayRevision = 0,
    overlay = overlayFrom(DEFAULT_OVERLAY),
    overlayProfiles = [],
    activeOverlayProfileId = "";
  function overlayStatus() {
    return {
      ok: true,
      revision: overlayRevision,
      config: JSON.parse(JSON.stringify(overlay)),
      activeProfileId: activeOverlayProfileId,
      presets: overlayPresets.list(),
      profiles: overlayProfiles.map(({ id, name, updatedAt }) => ({
        id,
        name,
        updatedAt,
      })),
    };
  }

  function configureOverlay(payload = {}) {
    if (payload.expectedRevision !== undefined && payload.expectedRevision !== overlayRevision)
      return {
        ...overlayStatus(),
        ok: false,
        code: "overlay_revision_conflict",
      };
    overlay = overlayFrom(payload.config, overlay);
    activeOverlayProfileId = "";
    overlayRevision += 1;
    return overlayStatus();
  }

  function overlayProfile(payload = {}) {
    if (!["save", "load", "delete"].includes(payload.action))
      return {
        ...overlayStatus(),
        ok: false,
        code: "overlay_profile_action_invalid",
      };
    const existing = overlayProfiles.find((p) => p.id === payload.id);
    if (payload.action === "load")
      return existing
        ? { ...overlayStatus(), profile: structuredClone(existing) }
        : { ...overlayStatus(), ok: false, code: "overlay_profile_not_found" };
    if (payload.expectedRevision !== undefined && payload.expectedRevision !== overlayRevision)
      return {
        ...overlayStatus(),
        ok: false,
        code: "overlay_revision_conflict",
      };
    if (payload.action === "delete") {
      if (!existing)
        return {
          ...overlayStatus(),
          ok: false,
          code: "overlay_profile_not_found",
        };
      overlayProfiles = overlayProfiles.filter((p) => p !== existing);
      if (activeOverlayProfileId === existing.id) activeOverlayProfileId = "";
      overlayRevision++;
      return { ...overlayStatus(), code: "overlay_profile_deleted" };
    }
    const name = text(payload.name, 64);
    if (!name || !payload.config)
      return {
        ...overlayStatus(),
        ok: false,
        code: "overlay_profile_name_required",
      };
    if (payload.id && !existing)
      return {
        ...overlayStatus(),
        ok: false,
        code: "overlay_profile_not_found",
      };
    if (overlayProfiles.some((p) => p !== existing && p.name.toLowerCase() === name.toLowerCase()))
      return {
        ...overlayStatus(),
        ok: false,
        code: "overlay_profile_name_exists",
      };
    if (!existing && overlayProfiles.length >= 16)
      return { ...overlayStatus(), ok: false, code: "overlay_profile_limit" };
    const profile = {
      id: existing?.id || randomUUID(),
      name,
      config: overlayFrom(payload.config),
      updatedAt: Number(now()),
    };
    if (existing) overlayProfiles = overlayProfiles.map((p) => (p === existing ? profile : p));
    else overlayProfiles.push(profile);
    overlay = profile.config;
    activeOverlayProfileId = profile.id;
    overlayRevision++;
    return {
      ...overlayStatus(),
      profile: structuredClone(profile),
      code: existing ? "overlay_profile_updated" : "overlay_profile_saved",
    };
  }

  function restore(snapshot) {
    overlay = overlayFrom(snapshot.overlay, DEFAULT_OVERLAY);
    const ids = new Set(),
      names = new Set();
    overlayProfiles = [];
    for (const raw of (Array.isArray(snapshot.overlayProfiles)
      ? snapshot.overlayProfiles
      : []
    ).slice(0, 16)) {
      const id = text(raw?.id, 64),
        name = text(raw?.name, 64);
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || !name || ids.has(id) || names.has(name.toLowerCase()))
        continue;
      ids.add(id);
      names.add(name.toLowerCase());
      overlayProfiles.push({
        id,
        name,
        config: overlayFrom(raw.config),
        updatedAt: Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= 0 ? raw.updatedAt : 0,
      });
    }
    activeOverlayProfileId = ids.has(snapshot.activeOverlayProfileId)
      ? snapshot.activeOverlayProfileId
      : "";
    overlayRevision =
      Number.isSafeInteger(snapshot.overlayRevision) && snapshot.overlayRevision >= 0
        ? snapshot.overlayRevision
        : 0;
  }
  return {
    status: overlayStatus,
    configure: configureOverlay,
    profile: overlayProfile,
    restore,
    exportSnapshot: () =>
      structuredClone({
        overlay,
        overlayProfiles,
        activeOverlayProfileId,
        overlayRevision,
      }),
  };
}
module.exports = { createOverlayProfiles };
