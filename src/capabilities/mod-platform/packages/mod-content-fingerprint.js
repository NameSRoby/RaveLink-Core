/** Review identity includes code inventories, not only the permission grant. */
const crypto = require("node:crypto");
module.exports = (manifest) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(manifest, (_key, value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, value[key]]),
            )
          : value,
      ),
    )
    .digest("hex");
