/** Build the isolated first-party proof; never replace Core/installer assets. */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const root = path.resolve(__dirname, "..");
if (process.platform !== "win32")
  throw Error("The capture proof currently builds for Windows only.");
const compiler = spawnSync("rustc", ["--version"], {
  encoding: "utf8",
  shell: false,
  windowsHide: true,
});
if (compiler.status !== 0 || !/^rustc 1\.94\.0\b/.test(compiler.stdout || ""))
  throw Error("Use Rust 1.94.0 for this reproducible capture proof build.");
// Encoded arguments preserve paths containing spaces without shell interpolation.
// Strip local checkout/cache names from compiler-embedded source locations.
const flags = [
  `--remap-path-prefix=${root}=/ravelink-core`,
  `--remap-path-prefix=${process.env.CARGO_HOME || path.join(os.homedir(), ".cargo")}=/cargo`,
];
const result = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--locked",
    "--manifest-path",
    "integrations/music-to-light/native/Cargo.toml",
    "--target-dir",
    "runtime/music-to-light/cargo",
  ],
  {
    cwd: root,
    shell: false,
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
  },
);
if (result.error || result.status !== 0) process.exitCode = 1;
else
  console.log("Audio proof built under runtime/music-to-light/cargo/release. Core is unchanged.");
