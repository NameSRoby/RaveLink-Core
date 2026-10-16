function installActionFeedback() {
  if (window.RaveLinkFeedback) return window.RaveLinkFeedback;
  let gesture = null, serial = 0, hideTimer, workingTimer;
  const handlers = new Set();
  const style = document.createElement('style');
  style.textContent = '#actionFeedback{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:2147483000;max-width:min(520px,calc(100vw - 24px));padding:8px 12px;border:1px solid var(--edge,#53627c);border-radius:6px;background:var(--panel,#101724);color:var(--text,#fff);font:400 12px/1.45 Segoe UI,Arial,sans-serif;overflow-wrap:anywhere;pointer-events:none}#actionFeedback[hidden]{display:none}#actionFeedback[data-state=error]{border-color:var(--bad,#ff6b72)}button[data-action-state=working]{cursor:progress;opacity:.75}button[data-action-state=success]{outline:1px solid var(--muted,#9ba8bf);outline-offset:1px}button[data-action-state=error]{outline:1px solid var(--bad,#ff6b72);outline-offset:1px}';
  document.head.append(style);
  const notice = document.createElement('div'); notice.id = 'actionFeedback'; notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); notice.setAttribute('aria-atomic', 'true'); document.body.append(notice);
  function show(message, state = 'success') {
    clearTimeout(hideTimer); clearTimeout(workingTimer); notice.hidden = parent !== window; notice.textContent = String(message).slice(0, 240); notice.dataset.state = state;
    if (parent !== window) parent.postMessage({ channel: 'ravelink-feature-ui-v1', type: 'action-feedback', message: notice.textContent, state }, '*');
    if (!notice.textContent) { notice.hidden = true;return; }
    if (state === 'working') { notice.hidden = true;workingTimer = setTimeout(() => { notice.hidden = parent !== window; }, 650); }
    else hideTimer = setTimeout(() => { notice.hidden = true; }, state === 'error' ? 8000 : 1200);
  }
  function finish(action, failed, value) {
    action.pending--; action.failed ||= failed;
    action.value = value || action.value;
    if (action.pending || action.handlerPending) return;
    action.button.removeAttribute('aria-busy'); action.button.dataset.actionState = action.failed ? 'error' : 'success';
    setTimeout(() => { if (action.button.dataset.actionId === String(action.id)) delete action.button.dataset.actionState; }, action.failed ? 2500 : 650);
    const ongoing = ['reading', 'matching', 'writing'].includes(action.value?.job?.state);
    if (action.failed || ongoing) show(action.label + (action.failed ? ': could not complete. Check the details in this view.' : ': started. Progress is shown in this view.'), action.failed ? 'error' : 'success');
    else { clearTimeout(workingTimer);clearTimeout(hideTimer);notice.hidden = true;notice.textContent = action.label + ': done.';if (parent !== window) parent.postMessage({ channel: 'ravelink-feature-ui-v1', type: 'action-feedback', message: '', state: 'success' }, '*'); }
  }
  function track(promise, fallback) {
    const action = gesture || fallback;
    if (!action) return promise;
    action.observed = true;
    action.pending++; action.button.dataset.actionId = action.id; action.button.dataset.actionState = 'working'; action.button.setAttribute('aria-busy', 'true'); show(action.label + ': working...', 'working');
    return Promise.resolve(promise).then(value => { finish(action, value?.ok === false || value?.value?.ok === false, value); return value; }, error => { finish(action, true); throw error; });
  }
  document.addEventListener('click', event => {
    const button = event.target.closest?.('button');
    if (!button || button.disabled || button.matches('[role=tab],[aria-pressed],[aria-expanded],[data-tab],[data-task],[data-theme],[data-view],[data-choice-value]') || button.closest('nav,[role=tablist],[data-choice-for]')) return;
    gesture = { id: ++serial, button, label: (button.getAttribute('aria-label') || button.textContent || 'Action').trim().replace(/\s+/g, ' ').slice(0, 90), pending: 0, failed: false };
    const action = gesture;
    const handler = button.onclick;
    if (typeof handler === 'function') button.onclick = function (...args) {
      button.onclick = handler;
      const result = handler.apply(this, args);
      if (result && typeof result.then === 'function') {
        action.handlerPending = true;
        handlers.add(action);
        Promise.resolve(result).then(() => { handlers.delete(action); action.handlerPending = false; if (!action.pending && action.observed) { action.pending++; finish(action, false); } }, () => { handlers.delete(action); action.handlerPending = false; action.pending++; finish(action, true); });
      }
      return result;
    };
    setTimeout(() => { if (gesture === action) gesture = null; }, 0);
  }, true);
  // Existing feature pages share this broker entry point; background polling has no gesture.
  if (typeof window.call === 'function') { const original = window.call; window.call = function (...args) {
    const background = ['status', 'read', 'get', 'pull'].includes(args[1]) || ['status', 'account', 'list_exports'].includes(args[2]?.action);
    return track(original.apply(this, args), background ? null : [...handlers].at(-1));
  }; }
  if (navigator.clipboard?.writeText) { const write = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (...args) => track(write(...args)); }
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function (...args) {
    const action = gesture, result = originalFetch.apply(this, args);
    if (!action) return result;
    const checked = result.then(async response => { const body = await response.clone().json().catch(() => ({})); return { ...body, ok: response.ok && body.ok !== false }; });
    void track(checked).catch(() => {}); return result;
  };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || ![...document.querySelectorAll('iframe')].some(frame => frame.contentWindow === event.source)) return;
    const data = event.data;
    if (data?.channel === 'ravelink-feature-ui-v1' && data.type === 'action-feedback' && ['working', 'success', 'error'].includes(data.state) && typeof data.message === 'string') show(data.message, data.state);
  });
  return window.RaveLinkFeedback = { show, track };
}
if (typeof module !== 'undefined' && module.exports) module.exports = installActionFeedback;
else installActionFeedback();
