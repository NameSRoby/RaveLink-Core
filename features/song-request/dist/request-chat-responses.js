// Community submissions recurse through the operation layer. Only the outer
// request boundary owns chat output and desktop announcement tracking.
module.exports = async function requestChatResponses(request, result, send, desktopChat) {
  const providers = ['song.tidal.experimental.v1','song.spotify.player.v1','song.soundcloud.player.v1'];
  const responseRequest = providers.includes(request.capability) && request.method === 'submit-query' ? { ...request, method: 'submit' } : request;
  if (['song.queue.submit.v1','song.queue.admin.v1','song.playback.driver.v1',...providers].includes(request.capability)) send(responseRequest, result);
  if (responseRequest.method === 'submit' && result?.ok && request.payload?.notifyChat === true) await desktopChat.record(result.entry);
  if (request.capability === 'song.playback.observe.v1' && result?.ok) await desktopChat.observe(request.payload);
};
