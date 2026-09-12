// [TITLE] Module: shared/security/windows-dpapi.js
// [TITLE] Purpose: Windows user-scoped encryption for local secret vaults

const { spawnSync } = require("node:child_process");

function asString(value) {
  return String(value ?? "").trim();
}

function runPowerShellJson(script = "", timeoutMs = 8_000, input = "") {
  const command = asString(script);
  if (!command) return { ok: false, error: "powershell_script_missing" };
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    input: String(input || ""),
    timeout: Math.min(30_000, Math.max(500, Number(timeoutMs) || 8_000)),
    maxBuffer: 256 * 1024,
    windowsHide: true
  });
  if (result.error) return { ok: false, error: asString(result.error?.message || result.error) };
  if (Number(result.status) !== 0) {
    return { ok: false, error: asString(result.stderr || result.stdout || `powershell_exit_${result.status}`) };
  }
  try {
    return { ok: true, data: JSON.parse(asString(result.stdout || "{}") || "{}") };
  } catch {
    return { ok: false, error: "powershell_json_parse_failed" };
  }
}

function protectTextMapWithWindowsDpapi(plainMap = {}) {
  const entries = Object.entries(plainMap && typeof plainMap === "object" ? plainMap : {})
    .map(([key, value]) => [asString(key), asString(value)])
    .filter(([key, value]) => key && value);
  if (!entries.length) return { ok: true, encrypted: {} };
  if (process.platform !== "win32") return { ok: false, error: "windows_dpapi_unavailable" };
  const jsonB64 = Buffer.from(JSON.stringify(Object.fromEntries(entries)), "utf8").toString("base64");
  const result = runPowerShellJson(`
$ErrorActionPreference = 'Stop'
$inputB64 = [Console]::In.ReadToEnd()
$plainMap = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputB64)))
$encrypted = @{}
foreach ($prop in $plainMap.PSObject.Properties) {
  $secure = ConvertTo-SecureString -String ([string]$prop.Value) -AsPlainText -Force
  $cipher = ConvertFrom-SecureString -SecureString $secure
  $encrypted[$prop.Name] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cipher))
}
@{ ok = $true; encrypted = $encrypted } | ConvertTo-Json -Compress
`, 8_000, jsonB64);
  if (!result.ok || !result.data?.encrypted) return { ok: false, error: asString(result.error || "dpapi_encrypt_failed") };
  return { ok: true, encrypted: result.data.encrypted };
}

function unprotectTextMapWithWindowsDpapi(cipherMap = {}) {
  const entries = Object.entries(cipherMap && typeof cipherMap === "object" ? cipherMap : {})
    .map(([key, value]) => [asString(key), asString(value)])
    .filter(([key, value]) => key && value);
  if (!entries.length) return { ok: true, plain: {} };
  if (process.platform !== "win32") return { ok: false, error: "windows_dpapi_unavailable" };
  const jsonB64 = Buffer.from(JSON.stringify(Object.fromEntries(entries)), "utf8").toString("base64");
  const result = runPowerShellJson(`
$ErrorActionPreference = 'Stop'
$inputB64 = [Console]::In.ReadToEnd()
$cipherMap = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($inputB64)))
$plain = @{}
foreach ($prop in $cipherMap.PSObject.Properties) {
  $cipher = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$prop.Value))
  $secure = ConvertTo-SecureString -String $cipher
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $text = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $plain[$prop.Name] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
}
@{ ok = $true; plain = $plain } | ConvertTo-Json -Compress
`, 8_000, jsonB64);
  if (!result.ok || !result.data?.plain) return { ok: false, error: asString(result.error || "dpapi_decrypt_failed") };
  try {
    return {
      ok: true,
      plain: Object.fromEntries(Object.entries(result.data.plain).map(([key, value]) => [key, Buffer.from(asString(value), "base64").toString("utf8")]))
    };
  } catch {
    return { ok: false, error: "dpapi_decrypt_decode_failed" };
  }
}

module.exports = { protectTextMapWithWindowsDpapi, unprotectTextMapWithWindowsDpapi };
