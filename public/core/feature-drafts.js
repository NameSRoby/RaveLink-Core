function hasDraft(featureId) {
  try {
    const prefix = `ravelink-ui-draft-v1:${featureId ? `${featureId}:` : ''}`;
    for (let i = 0; i < sessionStorage.length; i++) {
      if (sessionStorage.key(i).startsWith(prefix)) return true;
    }
  } catch { /* Live wrappers still protect edits when browser storage is blocked. */ }
  return [...document.querySelectorAll('.featurePageFrame')].some(frame => {
    const owner = frame.closest('[data-panel]')?.dataset.panel;
    return (!featureId || owner === `feature:${featureId}`) && frame.contentWindow?.ravelinkDraftDirty;
  });
}

export function confirmFeatureDrafts(featureId) {
  return !hasDraft(featureId) || confirm('This feature has unsaved edits. Continue without saving? Recoverable drafts stay in this browser tab.');
}

window.addEventListener('beforeunload', event => {
  if (hasDraft()) { event.preventDefault(); event.returnValue = ''; }
});
