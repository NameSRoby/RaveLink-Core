// Bounded presentation and label retention for local Song Request restrictions.
exports.page = function restrictionPage({ blocked, timed, labels, recent, page, integer, maximum }) {
  const keys = [...new Set([...blocked, ...Object.keys(timed)])];
  const offset = integer(page.moderationOffset, 0, maximum * 2, 0);
  const limit = integer(page.moderationLimit, 1, 25, 25);
  return {
    restrictedRequesters: (page.moderationOnly === true ? keys.slice(offset, offset + limit) : []).map(key => ({
      requesterKey: key,
      displayName: labels[key]?.displayName || recent.find(row => row.requesterKey === key)?.displayName || `Previous requester (${key.slice(-8)})`,
      blocked: blocked.includes(key), timedOutUntil: Number(timed[key] || 0)
    })),
    restrictionsPage: { offset, limit, total: keys.length, hasMore: offset + limit < keys.length }
  };
};

exports.remember = function rememberRestriction({ labels, blocked, timed, key, payload, recent, text }) {
  const activeKeys = new Set([...blocked, ...Object.keys(timed), key]);
  const next = Object.fromEntries(Object.entries(labels).filter(([id]) => activeKeys.has(id)));
  next[key] = { displayName: recent.find(row => row.requesterKey === key)?.displayName
    || labels[key]?.displayName || text(payload.requesterName, 80) || `Previous requester (${key.slice(-8)})` };
  return next;
};

exports.restore = function restoreRestrictionLabels({ snapshot, blocked, timed, recent, text }) {
  return Object.fromEntries([...new Set([...blocked, ...Object.keys(timed)])].map(key => [key, {
    displayName: text(snapshot.restrictedRequesterLabels?.[key]?.displayName || recent.find(row => row.requesterKey === key)?.displayName, 80) || `Previous requester (${key.slice(-8)})`
  }]));
};
