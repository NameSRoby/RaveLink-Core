/**
 * Narrow loopback exception for top-level OAuth redirects.
 * Cross-site navigation is necessary here, so ordinary same-origin middleware
 * would reject real sign-ins. Require the actual local socket and canonical
 * loopback Host instead. The provider still validates single-use PKCE state.
 * Never cache callback codes or allow this response to be framed/referrer data.
 */
module.exports = function localOAuthCallback(req, res, next) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  if (
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) ||
    req.headers.host !== `127.0.0.1:${req.socket.localPort}`
  ) {
    return res.status(403).send("Local callback required.");
  }
  next();
};
