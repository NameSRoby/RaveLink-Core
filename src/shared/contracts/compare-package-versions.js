/** SemVer precedence shared by optional package updates and Core compatibility gates. */
function compareVersions(leftRaw, rightRaw) {
  const parse = (raw) => {
    const version = String(raw || "").split("+")[0];
    const divider = version.indexOf("-");
    const core = divider < 0 ? version : version.slice(0, divider);
    const suffix = divider < 0 ? "" : version.slice(divider + 1);
    return {
      core: core.split(".").map(Number),
      suffix: suffix ? suffix.split(".") : [],
    };
  };
  const left = parse(leftRaw);
  const right = parse(rightRaw);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index])
      return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (!left.suffix.length && right.suffix.length) return 1;
  if (left.suffix.length && !right.suffix.length) return -1;
  for (let index = 0; index < Math.max(left.suffix.length, right.suffix.length); index += 1) {
    if (left.suffix[index] === undefined) return -1;
    if (right.suffix[index] === undefined) return 1;
    if (left.suffix[index] === right.suffix[index]) continue;
    const leftNumeric = /^\d+$/.test(left.suffix[index]);
    const rightNumeric = /^\d+$/.test(right.suffix[index]);
    if (leftNumeric && rightNumeric)
      return Number(left.suffix[index]) > Number(right.suffix[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left.suffix[index].localeCompare(right.suffix[index]);
  }
  return 0;
}
module.exports = compareVersions;
