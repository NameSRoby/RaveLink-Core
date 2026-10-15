const fs = require('node:fs');
const path = require('node:path');

const TERMINAL = new Set(['FULFILLED', 'CANCELED']);
const keyOf = row => JSON.stringify([row.broadcasterId, row.rewardId, row.redemptionId]);
const failure = error => ({ ok: false, error, retryable: false });

// First decisions survive restarts. An interrupted action is reviewed, never replayed.
module.exports = function createTransactionJournal(options = {}) {
  const filename = options.filename || '';
  const now = options.now || Date.now;
  const maximum = options.maximum || 1000;
  const flights = new Map();
  let blocked = false;
  let state = { schemaVersion: 1, entries: [] };
  if (filename && fs.existsSync(filename)) {
    try {
      if (fs.statSync(filename).size > 1024 * 1024) throw new Error('oversized');
      const loaded = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (loaded.schemaVersion !== 1 || !Array.isArray(loaded.entries) || loaded.entries.length > maximum) throw new Error('invalid');
      if (loaded.entries.some(row => !identity(row) || !['executing', 'decided', 'sending', 'review', 'confirmed'].includes(row.phase) || !['', ...TERMINAL].includes(row.desiredStatus) || !['', 'UNFULFILLED', ...TERMINAL].includes(row.observedStatus) || !Number.isFinite(row.updatedAt))) throw new Error('invalid');
      if (new Set(loaded.entries.map(keyOf)).size !== loaded.entries.length) throw new Error('invalid');
      state = { schemaVersion: 1, entries: loaded.entries };
      for (const row of state.entries) if (['executing', 'sending'].includes(row.phase)) { row.phase = 'review'; row.error = 'twitch_interrupted_transaction'; }
    } catch { blocked = true; }
  }
  function identity(input = {}) {
    return ['broadcasterId', 'rewardId', 'redemptionId'].every(key => typeof input[key] === 'string' && input[key].trim() && input[key].length <= 160);
  }
  function persist() {
    if (blocked) throw new Error('twitch_journal_unavailable');
    if (!filename) return;
    const temporary = `${filename}.${process.pid}.tmp`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fd = fs.openSync(temporary, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      fs.renameSync(temporary, filename);
    } catch {
      if (fd !== undefined && fd !== null) try { fs.closeSync(fd); } catch {}
      try { fs.rmSync(temporary, { force: true }); } catch {}
      blocked = true; throw new Error('twitch_journal_unavailable');
    }
  }
  function find(input) { return state.entries.find(row => keyOf(row) === keyOf(input)); }
  function create(input, phase) {
    if (blocked) throw new Error('twitch_journal_unavailable');
    if (!identity(input)) throw new Error('twitch_settlement_invalid');
    // Never evict an unresolved transaction to make room for a new action.
    state.entries = state.entries.filter(row => row.phase !== 'confirmed' || now() - row.updatedAt < 7 * 86400000);
    if (state.entries.length >= maximum) throw new Error('twitch_journal_full');
    const row = { broadcasterId: input.broadcasterId, rewardId: input.rewardId, redemptionId: input.redemptionId, phase, desiredStatus: '', observedStatus: '', error: '', updatedAt: now() };
    state.entries.push(row); return row;
  }
  function begin(input) {
    if (blocked) return failure('twitch_journal_unavailable');
    if (!identity(input)) return failure('twitch_settlement_invalid');
    const row = find(input);
    if (row) return { ok: true, duplicate: true, phase: row.phase };
    try { create(input, 'executing'); persist(); return { ok: true, duplicate: false }; }
    catch (error) { return failure(error.message); }
  }
  function decide(input) {
    if (blocked) throw new Error('twitch_journal_unavailable');
    if (!identity(input) || !TERMINAL.has(input.status)) throw new Error('twitch_settlement_invalid');
    const row = find(input) || create(input, 'decided');
    if (row.desiredStatus && row.desiredStatus !== input.status) throw new Error('twitch_settlement_conflict');
    if (!row.desiredStatus) { row.desiredStatus = input.status; row.phase = 'decided'; row.updatedAt = now(); persist(); }
    return row;
  }
  async function send(row, operation) {
    row.phase = 'sending'; row.updatedAt = now(); persist();
    let result;
    try { result = await operation({ ...row, status: row.desiredStatus }); }
    catch { result = failure('twitch_settlement_outcome_unknown'); }
    const confirmed = result?.ok === true && result.status === row.desiredStatus;
    row.phase = confirmed ? 'confirmed' : 'review'; row.observedStatus = confirmed ? result.status : '';
    row.error = confirmed ? '' : String(result?.error || 'twitch_settlement_outcome_unknown').slice(0, 80);
    row.updatedAt = now(); persist();
    return confirmed ? { ok: true, status: row.desiredStatus, redemptionId: row.redemptionId, refunded: row.desiredStatus === 'CANCELED' } : failure('twitch_settlement_review_required');
  }
  async function settle(input, operation) {
    try {
      if (flights.has(keyOf(input)) && !find(input)?.desiredStatus) return failure('twitch_transaction_busy');
      const row = decide(input), key = keyOf(row);
      if (row.phase === 'confirmed') return { ok: true, status: row.desiredStatus, redemptionId: row.redemptionId, refunded: row.desiredStatus === 'CANCELED', duplicate: true };
      if (flights.has(key)) return flights.get(key);
      if (['review', 'sending'].includes(row.phase)) return failure('twitch_settlement_review_required');
      const flight = send(row, operation).catch(error => failure(error.message)).finally(() => flights.delete(key));
      flights.set(key, flight); return flight;
    } catch (error) { return failure(error.message); }
  }
  async function reconcile(input, inspect, operation) {
    if (blocked) return failure('twitch_journal_unavailable');
    const row = find(input);
    if (!row) return failure('twitch_transaction_not_found');
    const key = keyOf(row);
    if (flights.has(key) || row.phase === 'executing') return failure('twitch_transaction_busy');
    if (row.phase === 'confirmed') return { ok: true, status: row.desiredStatus };
    const flight = (async () => {
      const observed = await inspect(row);
      if (!observed?.ok || !['UNFULFILLED', ...TERMINAL].includes(observed.status)) return failure(observed?.error || 'twitch_redemption_inspection_failed');
      row.observedStatus = observed.status; row.updatedAt = now();
      if (TERMINAL.has(observed.status)) {
        if (row.desiredStatus && row.desiredStatus !== observed.status) { row.phase = 'review'; row.error = 'twitch_remote_settlement_conflict'; persist(); return failure(row.error); }
        row.desiredStatus ||= observed.status; row.phase = 'confirmed'; row.error = ''; persist(); return { ok: true, status: observed.status };
      }
      if (!row.desiredStatus) {
        if (!TERMINAL.has(input.status)) { row.phase = 'review'; persist(); return failure('twitch_action_outcome_review_required'); }
        decide({ ...row, status: input.status });
      } else if (input.status && input.status !== row.desiredStatus) return failure('twitch_settlement_conflict');
      return send(row, operation);
    })().catch(error => failure(error.message)).finally(() => flights.delete(key));
    flights.set(key, flight); return flight;
  }
  function reviewExecution(input, error = 'twitch_action_outcome_review_required') {
    const row = find(input);
    if (!row || row.phase !== 'executing') return;
    row.phase = 'review'; row.error = error; row.updatedAt = now(); persist();
  }
  function list(broadcasterId) {
    const entries = state.entries.filter(row => row.broadcasterId === broadcasterId && row.phase !== 'confirmed');
    return { ok: !blocked, error: blocked ? 'twitch_journal_unavailable' : '', total: entries.length, entries: entries.slice(0, 50).map(row => ({ ...row })) };
  }
  return Object.freeze({ begin, settle, reconcile, reviewExecution, list });
};
