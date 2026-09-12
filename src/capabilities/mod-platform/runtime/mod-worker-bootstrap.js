#!/usr/bin/env node

const prefix = "--ravelink-mod-config=";
const argument = process.argv.slice(2).find(value => value.startsWith(prefix));
if (!argument) throw new Error("mod_boot_config_missing");
const config = JSON.parse(Buffer.from(argument.slice(prefix.length), "base64url").toString("utf8"));
config.identityField = "modId";
process.argv.push(`--ravelink-workload-config=${Buffer.from(JSON.stringify(config), "utf8").toString("base64url")}`);
require("../../supervised-runtime/runtime/worker-bootstrap");
