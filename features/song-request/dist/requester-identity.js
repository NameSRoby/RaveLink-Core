/** Keep saved requester hashes and role normalization identical across migrations. */
const crypto = require("node:crypto");
const requesterKey = (value) =>
  `req_${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
const requesterRole = (value) => (["moderator", "vip"].includes(value) ? value : "viewer");
module.exports = { requesterKey, requesterRole };
