/**
 * Transform.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#desktop-companions
 */
// SPDX-License-Identifier: MS-PL
// Adapted from Inrixia/TidaLuna's findCreateAction.ts at
// 4b8c306737fb53423d5c0138e24a367f0c268cf0. See LICENSE.TidaLuna and NOTICE.md.
function findCreateActionFunction(code) {
  const match = code.match(/\.payload,\.{3}(?:"|'|`)meta(?:"|'|`)in /);
  if (!match) return null;
  const nested = code.slice(0, match.index).lastIndexOf("{function");
  if (nested < 0) return null;
  const paren = code.slice(0, nested).lastIndexOf("(");
  const start = code.slice(0, paren).lastIndexOf(" ") + 1;
  const name = code.slice(start, paren).trim();
  if (!/^[\w$]+$/.test(name) || code.slice(start - 9, start) !== "function ") return null;
  return { name, start };
}
exports.transform = function transform(code) {
  const action = findCreateActionFunction(code);
  let actionHooks = 0,
    storeHooks = 0;
  if (action) {
    const renamed = "__RaveLinkOriginal_" + action.name;
    code =
      code.slice(0, action.start - 9) +
      `const ${action.name}=globalThis.__ravelinkTidal.wrapAction(${renamed});function ${renamed}` +
      code.slice(action.start + action.name.length);
    actionHooks = 1;
  }
  // Capture middleware-enhanced Redux dispatch, never the bare store dispatch.
  // The exact supported shape was inspected in TIDAL's framework asset on 2026-10-14.
  code = code.replace(/\{\.\.\.([\w$]+),dispatch:([\w$]+)\}/g, (match) => {
    storeHooks += 1;
    return `globalThis.__ravelinkTidal.captureStore(${match})`;
  });
  return { code, actionHooks, storeHooks };
};
