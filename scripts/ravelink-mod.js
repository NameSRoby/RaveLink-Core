#!/usr/bin/env node
// [TITLE] Script: ravelink-mod.js
// [TITLE] Purpose: validate and reproducibly package RaveLink mods
// [TITLE] Functionality Index:
// [TITLE] - run complete manifest, inventory, hash, path, and budget validation
// [TITLE] - stream verified files into a root-level ZIP with stable metadata
// [TITLE] - round-trip every produced archive through the production extractor

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const yazl = require("yazl");
const {
  verifyPackageDirectory,
} = require("../src/capabilities/mod-platform/packages/mod-package-integrity");
const {
  extractZipArchive,
} = require("../src/capabilities/mod-platform/packages/mod-package-archive");
const { summarizeManifest } = require("../packages/mod-sdk");

async function validate(sourcePath) {
  const verified = await verifyPackageDirectory(path.resolve(String(sourcePath || "")));
  if (!verified.ok) return verified;
  return {
    ok: true,
    root: verified.root,
    manifest: verified.manifest,
    summary: summarizeManifest(verified.manifest),
    files: verified.files,
    totalBytes: verified.totalBytes,
  };
}

async function packageMod(sourcePath, outputPath, options = {}) {
  const verified = await validate(sourcePath);
  if (!verified.ok) return verified;
  const output = path.resolve(String(outputPath || ""));
  if (path.extname(output).toLowerCase() !== ".zip")
    return { ok: false, error: "package_output_must_be_zip" };
  const relativeOutput = path.relative(verified.root, output);
  if (relativeOutput && !relativeOutput.startsWith("..") && !path.isAbsolute(relativeOutput))
    return { ok: false, error: "package_output_inside_source" };
  if (fs.existsSync(output) && options.force !== true)
    return { ok: false, error: "package_output_exists" };
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.${Date.now()}.tmp`;
  const proofRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "ravelink-mod-package-proof-"),
  );
  try {
    const zip = new yazl.ZipFile();
    const stableTime = new Date("1980-01-01T00:00:00.000Z");
    for (const row of [...verified.files].sort((a, b) => a.path.localeCompare(b.path))) {
      zip.addFile(path.join(verified.root, ...row.path.split("/")), row.path, {
        mtime: stableTime,
        mode: 0o100644,
        compress: true,
      });
    }
    zip.end({ forceZip64Format: false });
    await pipeline(zip.outputStream, fs.createWriteStream(temp, { flags: "wx", mode: 0o600 }));
    const extracted = path.join(proofRoot, "extracted");
    const extraction = await extractZipArchive(temp, extracted);
    if (!extraction.ok) return { ...extraction, error: `package_roundtrip_${extraction.error}` };
    const proof = await verifyPackageDirectory(extracted);
    if (
      !proof.ok ||
      proof.manifest.id !== verified.manifest.id ||
      proof.manifest.version !== verified.manifest.version
    ) {
      return {
        ok: false,
        error: "package_roundtrip_verification_failed",
        detail: proof.error || "identity_mismatch",
      };
    }
    if (options.force === true) await fs.promises.rm(output, { force: true });
    await fs.promises.rename(temp, output);
    return {
      ok: true,
      output,
      modId: verified.manifest.id,
      version: verified.manifest.version,
      files: verified.files.length,
    };
  } catch (error) {
    return {
      ok: false,
      error: "package_write_failed",
      detail: String(error?.message || error).slice(0, 200),
    };
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
    await fs.promises.rm(proofRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const [command, source, output] = argv.filter(
    (argument) => argument !== "--json" && argument !== "--force",
  );
  const json = argv.includes("--json");
  let result;
  if (command === "validate") result = await validate(source);
  else if (command === "package")
    result = await packageMod(source, output, {
      force: argv.includes("--force"),
    });
  else
    result = {
      ok: false,
      error: "usage",
      detail:
        "ravelink-mod validate <directory> [--json] | package <directory> <output.zip> [--force] [--json]",
    };
  const printable = json
    ? result
    : result.ok
      ? {
          ok: true,
          modId: result.manifest?.id || result.modId,
          version: result.manifest?.version || result.version,
          files: result.files?.length || result.files,
          output: result.output,
        }
      : result;
  process.stdout.write(`${JSON.stringify(printable, null, json ? 2 : 0)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (require.main === module) void main();

module.exports = { main, packageMod, validate };
