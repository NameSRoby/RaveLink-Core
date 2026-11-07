/** Read-only Helix dashboard queries plus explicit, never-blindly-retried markers. */
module.exports = function dashboardApi({ request, text, base }) {
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  const time = (v) => (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
  const fail = (r, code) => ({
    ok: false,
    status: r.status || 0,
    error:
      r.error ||
      {
        401: "twitch_reauthorization_required",
        403: "twitch_dashboard_access_denied",
        429: "twitch_rate_limited",
      }[r.status] ||
      code,
  });
  async function call(input, route, query = {}, body) {
    const c = input.credentials || {};
    if (!/^\d{1,80}$/.test(c.userId || "") || !c.accessToken || !c.clientId)
      return { ok: false, status: 0, error: "twitch_not_connected" };
    return request(
      base + route + (Object.keys(query).length ? "?" + new URLSearchParams(query) : ""),
      {
        headers: {
          Authorization: "Bearer " + c.accessToken,
          "Client-Id": c.clientId,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      },
    );
  }
  return {
    async dashboardStream(input = {}) {
      const r = await call(input, "/streams", { user_id: input.credentials?.userId, first: "1" });
      if (!r.ok) return fail(r, "twitch_stream_lookup_failed");
      const row = r.body.data?.[0];
      if (!row) return { ok: true, live: false };
      if (!/^\d{1,80}$/.test(row.id) || !time(row.started_at))
        return { ok: false, error: "twitch_stream_data_invalid" };
      return {
        ok: true,
        live: true,
        id: row.id,
        startedAt: time(row.started_at),
        title: text(row.title, 200),
        category: text(row.game_name, 100),
        viewers: count(row.viewer_count),
      };
    },
    async dashboardFollowers(input = {}) {
      const r = await call(input, "/channels/followers", {
        broadcaster_id: input.credentials?.userId,
        first: "5",
      });
      if (!r.ok) return fail(r, "twitch_followers_unavailable");
      return {
        ok: true,
        total: count(r.body.total),
        recent: (r.body.data || [])
          .slice(0, 5)
          .map((row) => ({ name: text(row.user_name, 80), at: time(row.followed_at) })),
      };
    },
    async dashboardSubscribers(input = {}) {
      const r = await call(input, "/subscriptions", {
        broadcaster_id: input.credentials?.userId,
        first: "1",
      });
      if (!r.ok) return fail(r, "twitch_subscribers_unavailable");
      return { ok: true, total: count(r.body.total), points: count(r.body.points) };
    },
    async dashboardVod(input = {}) {
      const r = await call(input, "/videos", {
        user_id: input.credentials?.userId,
        type: "archive",
        first: "20",
      });
      if (!r.ok) return fail(r, "twitch_vod_unavailable");
      const wanted = input.streamIds || [input.streamId],
        videos = (r.body.data || [])
          .filter((row) => wanted.includes(row.stream_id) && /^\d{1,80}$/.test(row.id))
          .map((row) => ({ streamId: row.stream_id, videoId: row.id }));
      return { ok: true, videos };
    },
    async dashboardClips(input = {}) {
      let cursor = "",
        rows = [];
      for (let page = 0; page < 3; page++) {
        const r = await call(input, "/clips", {
          broadcaster_id: input.credentials?.userId,
          first: "100",
          started_at: new Date(input.startedAt || Date.now() - 86400000).toISOString(),
          ...(cursor ? { after: cursor } : {}),
        });
        if (!r.ok) return fail(r, "twitch_clips_unavailable");
        for (const row of (r.body.data || []).slice(0, 100)) {
          if (!/^[A-Za-z0-9_-]{1,200}$/.test(row.id) || !time(row.created_at)) continue;
          rows.push({
            id: row.id,
            title: text(row.title, 140),
            creator: text(row.creator_name, 80),
            at: time(row.created_at),
            url: "https://clips.twitch.tv/" + row.id,
            views: count(row.view_count),
          });
        }
        cursor = text(r.body.pagination?.cursor, 256);
        if (!cursor) break;
      }
      rows = [...new Map(rows.map((row) => [row.id, row])).values()].sort((a, b) => b.at - a.at);
      return { ok: true, count: rows.length, complete: !cursor, recent: rows.slice(0, 10) };
    },
    async createStreamMarker(input = {}) {
      if (typeof input.description !== "string" || input.description.length > 140)
        return { ok: false, error: "twitch_marker_invalid" };
      const r = await call(
        input,
        "/streams/markers",
        {},
        { user_id: input.credentials?.userId, description: input.description },
      );
      if (!r.ok) return fail(r, "twitch_marker_not_confirmed");
      const row = r.body.data?.[0];
      if (
        !row ||
        !text(row.id, 100) ||
        count(row.position_seconds) === null ||
        !time(row.created_at)
      )
        return { ok: false, error: "twitch_marker_not_confirmed" };
      return {
        ok: true,
        id: text(row.id, 100),
        positionSeconds: row.position_seconds,
        createdAt: time(row.created_at),
        description: text(row.description, 140),
      };
    },
  };
};
