window.installPlaylistMatchReview = function installPlaylistMatchReview({ refresh, accept }) {
  const tools = document.createElement('section'); tools.id = 'matchReviewTools'; tools.hidden = true;
  tools.innerHTML = '<h3>Review destination matches</h3><p>Scores compare track metadata; they are not a guarantee of the same recording. Your manual choices are kept.</p><div class="band"><label>Minimum match %<input id="matchThreshold" type="number" min="50" max="100" value="95" required></label><div id="matchQuickChoices" class="actions" aria-label="Select matches above a percentage"></div><label>Show tracks<select id="matchReviewFilter"><option value="all">All tracks in source order</option><option value="weakest">Lowest matches first</option><option value="needs_review">Needs review / below threshold</option><option value="unmatched">No candidates found</option></select></label></div><p id="matchSelectionSummary" role="status"></p>';
  $('transferRows').closest('table').before(tools);
  tools.querySelector('.band').append($('acceptMatches'));
  const adaptive = document.createElement('label'); adaptive.id = 'adaptiveMatchingLabel'; adaptive.className = 'switchLabel';
  adaptive.innerHTML = '<input id="adaptiveMatching" type="checkbox" checked>Adaptive SoundCloud search';
  adaptive.title = 'Try an additional title search when the artist/title search is weak, then rank all candidates against the original track and duration.';
  $('matchTidal').after(adaptive);
  for (const percent of [50,60,70,80,90,95]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = percent + '%+'; button.title = 'Select the best candidate for each unreviewed track scoring at least ' + percent + '%'; button.onclick = () => { $('matchThreshold').value = percent; label(); accept(percent); }; $('matchQuickChoices').append(button); }
  function label() { $('acceptMatches').textContent = 'Select matches ' + $('matchThreshold').value + '%+'; }
  $('matchThreshold').onchange = () => { if ($('matchThreshold').reportValidity()) { label(); refresh(); } };
  $('matchReviewFilter').onchange = refresh;
  $('acceptMatches').onclick = () => { if ($('matchThreshold').reportValidity()) accept(Number($('matchThreshold').value)); };
  return { options: () => ({ threshold: Math.max(50, Math.min(100, Number($('matchThreshold').value) || 95)), review: $('matchReviewFilter').value }), adaptive: () => $('adaptiveMatching').checked,
    render(job) { const editable = job?.kind === 'matching' && ['review','canceled'].includes(job.state) && !job.targetLocked; tools.hidden = !editable; adaptive.hidden = $('transferTarget').value !== 'soundcloud'; $('matchSelectionSummary').textContent = job ? job.selected + ' tracks selected. Lower scores remain available for review; skipped rows and different recordings are never bulk-selected.' : ''; label(); }
  };
};
