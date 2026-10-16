function tidalErrorMessage(error) {
  if (error.message === 'song_timed_out') return 'This track is temporarily blocked. Try again after its timeout ends.';
  if (error.message === 'song_blocked') return 'This track is banned from song requests.';
  if (error.message === 'tidal_current_changed') return 'The playing track changed. Refresh Now Playing and choose the action again.';
  const code = error.code || error.message;
  const time = value => { const seconds = Math.floor(Number(value) / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  if (code === 'duration_limit') {
    const details = error.details;
    return details ? `${details.title || 'Track'} is ${time(details.durationMs)}; your limit is ${time(details.maxDurationMs)}. Increase Maximum song length under Request limits, save, then try again.`
      : 'This track exceeds your maximum song length. Adjust Request limits, save, then try again.';
  }
  if (code === 'tidal_search_version_filtered') return 'Matching tracks were blocked by your version filters. Name the version you want (such as live or remaster), or adjust your search filters.';
  if (code === 'tidal_search_no_results') return 'TIDAL returned no tracks. Try the artist and song title, or a direct TIDAL track link.';
  if (code === 'tidal_search_no_eligible_match') return 'TIDAL returned tracks, but none matched closely enough. Try a clearer artist and song title, or a direct track link.';
  if (code === 'tidal_search_rate_limited') return 'Too many searches. Wait a minute, then try again.';
  if (code === 'tidal_catalog_setup_required' || code === 'tidal_oauth_sign_in_required' || code === 'tidal_oauth_refresh_rejected') return 'Sign in with TIDAL to search for songs, or use a direct track link.';
  if (code === 'tidal_api_credentials_rejected') return 'TIDAL rejected the account authorization. Disconnect and sign in again.';
  if (code === 'tidal_catalog_credentials_invalid') return 'Enter a valid public application client ID in Developer tools.';
  if (code === 'tidal_catalog_country_invalid') return 'Choose a supported country from the catalog country list.';
  if (code === 'tidal_catalog_access_denied') return 'TIDAL has not allowed song lookup for this app or account. Try reconnecting, or use a direct track link.';
  if (code === 'tidal_oauth_exchange_rejected') return 'TIDAL could not finish sign-in. Please try again, or use a direct track link.';
  if (code === 'tidal_oauth_scope_missing') return 'Song lookup permission was not granted. Sign in again and allow song lookup.';
  if (code === 'tidal_oauth_denied') return 'TIDAL sign-in was cancelled. You can try again.';
  if (code === 'tidal_oauth_state_invalid' || code === 'tidal_oauth_session_expired') return 'This sign-in expired or does not match. Start a new sign-in.';
  if (code === 'tidal_track_not_playable') return 'TIDAL could not validate this track as playable in your account. Try another recording or check its availability in TIDAL.';
  if (code === 'tidal_catalog_timeout' || code === 'tidal_metadata_timeout') return 'TIDAL lookup timed out. Try again shortly.';
  if (code === 'tidal_catalog_unavailable' || code === 'tidal_catalog_busy') return 'The TIDAL catalog API is unavailable right now. Retry shortly, or use a direct track link.';
  if (code === 'tidal_companion_rejected') return 'The desktop companion could not resolve this track. Update/reinstall the companion, then try again.';
  if (code === 'tidal_companion_update_required') return 'Open Setup and update the desktop companion, then reopen TIDAL to enable queue removal, skipping and moderation.';
  if (code === 'tidal_remove_unconfirmed') return 'TIDAL did not confirm removal. Check its queue, then retry this request’s removal if needed.';
  if (code === 'tidal_remove_unavailable') return 'TIDAL cannot skip or remove this request in its current playback state. Check the desktop player.';
  if (code === 'tidal_native_queue_full') return 'TIDAL already has 10 upcoming requests. This song will be sent automatically when a slot opens.';
  if (code === 'tidal_delivery_retry_required') return 'This request is held. Check its delivery status before choosing Retry in TIDAL.';
  if (code === 'tidal_handoff_needs_review') return 'Review this request in the song list. Only allow a retry after confirming it is absent from TIDAL’s queue and playback history.';
  if (code === 'tidal_local_queue_required') return 'Play music on this PC in TIDAL Desktop, rather than a remote device, then refresh the connection.';
  if (code === 'tidal_initialized_queue_required' || code === 'tidal_cloud_queue_required') return 'Open TIDAL Desktop and play a song to initialize its queue, then refresh and try Add to queue again.';
  if (code === 'tidal_append_unconfirmed' || code === 'tidal_companion_timeout') return 'TIDAL did not confirm the insertion. Check its queue and playback history before allowing a retry in the song list.';
  if (code === 'tidal_catalog_vault_write_failed' || code === 'tidal_catalog_vault_invalid') return 'Core could not read or save the secure account connection on this PC. Restart Core and sign in again.';
  if (/^tidal_/.test(code)) return 'TIDAL could not complete this action. Refresh the connection and try again.';
  return error.message;
}

function playerNativeErrorMessage(error) {
  return ({ spotify_queue_removal_unsupported: 'The Spotify official API cannot remove an individual queued song. The restriction is saved for future requests.', spotify_current_changed: 'The playing song changed. Refresh and choose the action again.', spotify_account_or_app_access_required: 'Check Premium and your Spotify app allowed users in Setup.' })[error.message] || tidalErrorMessage(error);
}
