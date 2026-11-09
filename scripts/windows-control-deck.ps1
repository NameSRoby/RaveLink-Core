# Core-owned desktop adapter. JSON requests arrive on stdin; text is never code.
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$null = Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RaveLinkDeckInput {
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION data; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public KEYBDINPUT key; [FieldOffset(0)] public MOUSEINPUT mouse; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int x, y; public uint mouseData, flags, time; public UIntPtr extra; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  static INPUT Key(ushort code, bool up, bool unicode) {
    var value = new INPUT(); value.type = 1;
    value.data.key.vk = unicode ? (ushort)0 : code;
    value.data.key.scan = unicode ? code : (ushort)0;
    value.data.key.flags = (up ? 2u : 0u) | (unicode ? 4u : 0u);
    return value;
  }
  static void Deliver(INPUT[] events) {
    if (SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(INPUT))) != events.Length) throw new Exception("desktop_input_blocked");
  }
  public static void Keys(ushort[] keys) {
    if (keys == null || keys.Length < 1 || keys.Length > 5) throw new Exception("desktop_hotkey_invalid");
    foreach (int modifier in new int[] {16,17,18,91,92})
      if ((GetAsyncKeyState(modifier) & 0x8000) != 0) throw new Exception("desktop_keys_busy");
    var events = new List<INPUT>();
    foreach (ushort key in keys) events.Add(Key(key, false, false));
    for (int i = keys.Length - 1; i >= 0; i--) events.Add(Key(keys[i], true, false));
    try { Deliver(events.ToArray()); }
    catch {
      var release = new List<INPUT>();
      for (int i = keys.Length - 1; i >= 0; i--) release.Add(Key(keys[i], true, false));
      SendInput((uint)release.Count, release.ToArray(), Marshal.SizeOf(typeof(INPUT)));
      throw;
    }
  }
  public static void Text(string text) {
    if (String.IsNullOrEmpty(text) || text.Length > 1000) throw new Exception("desktop_text_invalid");
    var events = new List<INPUT>();
    foreach (char value in text) { events.Add(Key(value, false, true)); events.Add(Key(value, true, true)); }
    Deliver(events.ToArray());
  }
  public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }
}
'@

function Write-Result($Value) { [Console]::WriteLine(($Value | ConvertTo-Json -Depth 8 -Compress)) }
if ($SelfTest) {
  # Verify the input ABI without injecting keyboard input.
  Write-Result @{ok=$true;inputSize=[RaveLinkDeckInput]::InputSize();pointerSize=[IntPtr]::Size}
  exit 0
}
Write-Result @{ready=$true}
while ($null -ne ($line = [Console]::ReadLine())) {
  $message = $null
  try {
    if ($line.Length -gt 16384) { throw 'desktop_request_invalid' }
    $message = $line | ConvertFrom-Json
    if ("$($message.id)" -notmatch '^\d{1,12}$') { throw 'desktop_request_invalid' }
    $value = @{ok=$true}
    switch ($message.operation) {
      'keys' { [RaveLinkDeckInput]::Keys([uint16[]]$message.payload.keys) }
      'text' { [RaveLinkDeckInput]::Text([string]$message.payload.text) }
      'open' {
        $target = [string]$message.payload.target
        if ($target.Length -gt 2048 -or $target -match '[\x00-\x1f]' -or ($target -notmatch '^https?://' -and $target -notmatch '^[a-zA-Z]:[\\/]')) { throw 'desktop_target_invalid' }
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $target; $info.UseShellExecute = $true
        $null = [Diagnostics.Process]::Start($info)
      }
      default { throw 'desktop_action_invalid' }
    }
    Write-Result @{id="$($message.id)";ok=$true;value=$value}
  } catch {
    $taskException = $_.Exception
    while ($taskException.InnerException) { $taskException = $taskException.InnerException }
    $code = $taskException.Message
    if ($code -notmatch '^[a-z][a-z0-9_]{1,79}$') { $code = 'desktop_action_failed' }
    Write-Result @{id="$($message.id)";ok=$false;code=$code}
  }
}
