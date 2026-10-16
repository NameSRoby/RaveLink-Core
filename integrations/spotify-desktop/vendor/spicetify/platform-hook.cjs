// SPDX-License-Identifier: LGPL-2.1-only
// Adapted from Spicetify's Expose PlatformAPI patch; see NOTICE.md and LICENSE.
// This module contains only the platform-capture pattern, not Spicetify's loader.
exports.transform = function transform(source) {
  if (typeof source !== 'string' || source.length > 64 * 1024 * 1024) return { ok: false, error: 'spotify_asset_invalid' };
  if (source.includes('__ravelinkSpotify')) return { ok: false, error: 'spotify_asset_already_patched', code: source };
  if (/\b(?:window|globalThis)\.Spicetify\b|\bSpicetify\.(?:_platform|Platform|Player)\b|spicetifyWrapper/.test(source)) return { ok: false, error: 'spotify_foreign_companion_detected', code: source };
  // Upstream's platform marker, narrowed to the first candidate after each marker.
  const pattern = /((?:setTitlebarHeight|registerFactory)[\w(){}<>:.,&$!=;"?!#%/\- ]+?)(\{version:[a-zA-Z_$][\w$]*,)/g;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) return { ok: false, error: matches.length ? 'spotify_platform_hook_ambiguous' : 'spotify_platform_hook_unavailable', code: source };
  const match = matches[0], at = match.index + match[1].length;
  return { ok: true, platformHooks: 1, code: source.slice(0, at) + '(globalThis.__ravelinkSpotify||{}).capturePlatform=' + source.slice(at) };
};
