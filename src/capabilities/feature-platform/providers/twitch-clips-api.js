/** Official Helix live clips only. Credentials enter from the existing Twitch
 * authorization owner and never become part of browser/mod responses.
 */
module.exports = function createClipApi({ request, text, base }) {
  const slug = (value) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
  function authorization(credentials) {
    return {
      Authorization: `Bearer ${text(credentials.accessToken, 2048)}`,
      "Client-Id": text(credentials.clientId, 80),
    };
  }
  function failure(result, fallback) {
    return {
      ok: false,
      status: result.status || 0,
      error:
        result.error ||
        {
          401: "twitch_reauthorization_required",
          403: "twitch_clips_disabled",
          404: "twitch_stream_offline",
          429: "twitch_clip_rate_limited",
        }[result.status] ||
        fallback,
    };
  }
  async function createClip(input = {}) {
    const credentials = input.credentials || {},
      broadcaster = text(credentials.userId, 80);
    const duration = input.duration ?? 30;
    if (
      !/^\d{1,80}$/.test(broadcaster) ||
      !credentials.accessToken ||
      !credentials.clientId ||
      (typeof input.title !== "undefined" &&
        (typeof input.title !== "string" || input.title.length > 100)) ||
      !Number.isFinite(duration) ||
      duration < 5 ||
      duration > 60 ||
      !Number.isInteger(duration * 10)
    )
      return { ok: false, error: "twitch_clip_input_invalid" };
    const query = new URLSearchParams({ broadcaster_id: broadcaster, duration: String(duration) });
    if (input.title?.trim()) query.set("title", input.title.trim());
    const result = await request(`${base}/clips?${query}`, {
      method: "POST",
      headers: authorization(credentials),
    });
    if (!result.ok) return failure(result, "twitch_clip_create_failed");
    const clip = result.body?.data?.[0],
      id = text(clip?.id, 200);
    if (result.status !== 202 || !slug(id))
      return { ok: false, error: "twitch_clip_response_invalid" };
    const url = "https://clips.twitch.tv/" + id;
    let editUrl = "";
    try {
      const edit = new URL(clip.edit_url);
      if (
        edit.protocol === "https:" &&
        ["clips.twitch.tv", "www.twitch.tv"].includes(edit.hostname) &&
        !edit.username &&
        !edit.password
      )
        editUrl = edit.href.slice(0, 1000);
    } catch {
      /* The canonical clip URL remains available. */
    }
    return { ok: true, id, url, editUrl };
  }
  async function getClip(input = {}) {
    const credentials = input.credentials || {},
      id = text(input.id, 200);
    if (!slug(id)) return { ok: false, error: "twitch_clip_input_invalid" };
    const result = await request(`${base}/clips?${new URLSearchParams({ id })}`, {
      headers: authorization(credentials),
    });
    if (!result.ok) return failure(result, "twitch_clip_lookup_failed");
    const rows = Array.isArray(result.body?.data) ? result.body.data : [];
    const clip = rows.find((row) => row.id === id && row.broadcaster_id === credentials.userId);
    return {
      ok: true,
      found: Boolean(clip),
      ...(clip ? { id, url: "https://clips.twitch.tv/" + id, title: text(clip.title, 100) } : {}),
    };
  }
  return { createClip, getClip };
};
