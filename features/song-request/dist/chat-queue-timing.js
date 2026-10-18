/** Read-only queue estimates. Sum the remaining current track and every known
 * predecessor, never the requested track itself. Missing durations, stale clocks
 * and unobserved native entries propagate an unknown ETA to later requests.
 * Estimates describe playback time; a paused player needs an explicit qualifier.
 */
module.exports = function queueTiming({
  rows,
  current,
  observation,
  playback,
  state,
  native,
  now = Date.now(),
}) {
  const duration = (row) => {
    const value = row?.durationMs || row?.candidate?.durationMs;
    return Number.isFinite(value) && value > 0 && value <= 86400000 ? value : null;
  };
  const direct =
    native &&
    Number.isFinite(state?.current?.positionMs) &&
    duration(state.current) !== null &&
    Number.isFinite(state.observedAt || state.lastSeenAt)
      ? {
          ...state.current,
          observedAt: state.observedAt || state.lastSeenAt,
          status: state.current.paused ? "paused" : "playing",
        }
      : null;
  const clock = native ? direct || observation : current;
  const paused =
    clock?.status === "paused" ||
    current?.paused === true ||
    current?.status === "paused" ||
    (!native && playback.control?.paused);
  const age = now - clock?.observedAt;
  const fresh = Number.isFinite(age) && age >= -1000 && age <= 15000;
  const total = duration(clock) || duration(current);
  const position = clock?.positionMs;
  let wait =
    !current && !native
      ? 0
      : fresh &&
          total !== null &&
          Number.isFinite(position) &&
          position >= 0 &&
          position <= total &&
          ["playing", "paused"].includes(clock?.status)
        ? Math.max(0, total - position - (paused ? 0 : Math.max(0, age)))
        : null;
  // Windows observations can trail a desktop song transition. Do not combine
  // the previous song's clock with a newly selected request's duration.
  if (
    native &&
    !direct &&
    current?.candidate?.title &&
    observation?.title &&
    current.candidate.title.normalize("NFKC").toLowerCase() !==
      observation.title.normalize("NFKC").toLowerCase()
  )
    wait = null;
  if (native && state?.queueTimingComplete === false) wait = null;
  if (
    native &&
    Number.isInteger(state?.capacity?.queued) &&
    state.capacity.queued !== (state.queueOrder || []).length
  )
    wait = null;
  const format = (ms) => {
    const seconds = Math.ceil(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  return rows.map((row) => {
    const label =
      wait === null
        ? "ETA unavailable"
        : paused
          ? `~${format(wait)} after resume`
          : `in ~${format(wait)}`;
    const length = duration(row);
    wait = wait === null || length === null ? null : wait + length;
    return label;
  });
};
