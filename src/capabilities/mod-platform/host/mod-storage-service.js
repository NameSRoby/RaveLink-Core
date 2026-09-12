const createQuotaJsonStorage = require("../../../shared/storage/quota-json-storage");

module.exports = function createModStorageService(options = {}) {
  return createQuotaJsonStorage({
    ...options,
    identityPattern: /^[a-z0-9][a-z0-9-]{0,31}\.[a-z0-9][a-z0-9-]{0,31}$/,
    invalidIdentityError: "invalid_mod_id"
  });
};
