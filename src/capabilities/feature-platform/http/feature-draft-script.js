// Runs in the trusted wrapper, never in the opaque-origin contribution.
function featureDraftHost(featureId, pageId, surface) {
  const channel = 'ravelink-feature-ui-v1';
  const prefix = 'ravelink-ui-draft-v1:';
  const key = prefix + featureId + ':' + pageId;
  const frame = document.getElementById('surface');
  function beforeUnload(event) { event.preventDefault(); event.returnValue = ''; }
  function dirty(value) {
    window.ravelinkDraftDirty = value;
    window.removeEventListener('beforeunload', beforeUnload);
    if (value) window.addEventListener('beforeunload', beforeUnload);
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== frame.contentWindow || message?.channel !== channel || message.type !== 'draft') return;
    event.stopImmediatePropagation();
    if (surface !== 'panel' || typeof message.id !== 'string' || message.id.length > 80) return;
    let value = null, error;
    try {
      if (message.operation === 'read') {
        value = sessionStorage.getItem(key);
        if (value?.length > 32768) { sessionStorage.removeItem(key); value = null; }
        dirty(value !== null);
      } else if (message.operation === 'write') {
        if (message.value === null) { sessionStorage.removeItem(key); dirty(false); }
        else {
          dirty(true);
          if (typeof message.value !== 'string' || message.value.length > 32768) throw new Error('draft_too_large');
          let total = message.value.length, count = 1;
          for (let i = 0; i < sessionStorage.length; i++) {
            const other = sessionStorage.key(i);
            if (other !== key && other.startsWith(prefix)) { total += sessionStorage.getItem(other).length; count++; }
          }
          if (total > 131072 || count > 16) throw new Error('draft_storage_full');
          sessionStorage.setItem(key, message.value);
        }
      } else throw new Error('invalid_draft_operation');
    } catch (failure) { error = failure.message || 'draft_storage_unavailable'; }
    frame.contentWindow.postMessage({ channel, type: 'response', id: message.id, ok: !error, value, error }, '*');
  }, true);
}

module.exports = (featureId, pageId, surface) => `(${featureDraftHost.toString()})(${JSON.stringify(featureId)},${JSON.stringify(pageId)},${JSON.stringify(surface)});`;
