function installActionFeedback() {
  if (window.RaveLinkFeedback) return window.RaveLinkFeedback;
  let gesture = null, serial = 0, hideTimer;
  const handlers = new Set();
  const style = document.createElement('style');
  style.textContent = '#actionFeedback{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:2147483000;max-width:min(580px,calc(100vw - 32px));padding:13px 18px;border:1px solid var(--edge,#53627c);border-left:5px solid var(--accent,#b31132);border-radius:9px;background:var(--panel,#101724);color:var(--text,#fff);box-shadow:0 8px 30px #0008;font:600 14px/1.5 Segoe UI,Arial,sans-serif;overflow-wrap:anywhere}#actionFeedback[hidden]{display:none}#actionFeedback[data-state=error]{border-left-color:var(--bad,#ff6b72)}#actionFeedback[data-state=success]{border-left-color:var(--ok,#57d487)}button[data-action-state=working]{outline:2px solid var(--accent,#b31132);outline-offset:2px}button[data-action-state=working]::after{content:" …"}button[data-action-state=success]{box-shadow:inset 0 -3px var(--ok,#57d487)}button[data-action-state=error]{box-shadow:inset 0 -3px var(--bad,#ff6b72)}';
  document.head.append(style);
  const notice = document.createElement('div'); notice.id = 'actionFeedback'; notice.hidden = true; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); notice.setAttribute('aria-atomic', 'true'); document.body.append(notice);
  function show(message, state = 'success') {
    clearTimeout(hideTimer); notice.hidden = parent !== window; notice.textContent = String(message).slice(0, 240); notice.dataset.state = state;
    if (parent !== window) parent.postMessage({ channel: 'ravelink-feature-ui-v1', type: 'action-feedback', message: notice.textContent, state }, '*');
    if (state !== 'working') hideTimer = setTimeout(() => { notice.hidden = true; }, state === 'error' ? 10000 : 5000);
  }
  function finish(action, failed, value) {
    action.pending--; action.failed ||= failed;
    action.value = value || action.value;
    if (action.pending || action.handlerPending) return;
    action.button.removeAttribute('aria-busy'); action.button.dataset.actionState = action.failed ? 'error' : 'success';
    setTimeout(() => { if (action.button.dataset.actionId === String(action.id)) delete action.button.dataset.actionState; }, 5000);
    const ongoing = ['reading', 'matching', 'writing'].includes(action.value?.job?.state);
    show(action.label + (action.failed ? ': could not complete. Check the details in this view.' : ongoing ? ': started. Progress is shown in this view.' : ': confirmed.'), action.failed ? 'error' : 'success');
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
    if (!button || button.disabled || button.matches('[role=tab],[aria-pressed],[aria-expanded],[data-tab],[data-task],[data-theme],[data-view]') || button.closest('nav')) return;
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
