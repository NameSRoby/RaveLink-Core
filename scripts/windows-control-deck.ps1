# Core-owned desktop adapter. JSON requests arrive on stdin; text is never code.
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms
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
function Is-Discord($Element) {
  try { $process = Get-Process -Id $Element.Current.ProcessId -ErrorAction Stop; return $process.ProcessName -match '^Discord(?:Canary|PTB)?$' } catch { return $false }
}
function Is-MuteButton($Element) {
  try {
    if (!(Is-Discord $Element)) { return $false }
    $type = $Element.Current.ControlType
    if ($type -ne [Windows.Automation.ControlType]::Button -and $type -ne [Windows.Automation.ControlType]::CheckBox) { return $false }
    return $Element.Current.Name -match '(?i)\b(?:unmute|mute|microphone|microfone|mikrofon)\b'
  } catch { return $false }
}
function Find-MuteButton([bool]$Bind = $false) {
  if (!$Bind -and $script:DiscordElement) {
    try { if (Is-MuteButton $script:DiscordElement) { return $script:DiscordElement } } catch {}
  }
  if ($Bind) {
    $point = [Windows.Forms.Cursor]::Position
    $cursor = [Windows.Automation.AutomationElement]::FromPoint((New-Object Windows.Point($point.X, $point.Y)))
    for ($i = 0; $i -lt 5 -and $cursor; $i++) {
      if (Is-MuteButton $cursor) { $script:DiscordElement = $cursor; return $cursor }
      $cursor = [Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cursor)
    }
    $focus = [Windows.Automation.AutomationElement]::FocusedElement
    if ($focus -and (Is-MuteButton $focus)) { $script:DiscordElement = $focus; return $focus }
  }
  $apps = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^Discord(?:Canary|PTB)?$' -and $_.MainWindowHandle -ne [IntPtr]::Zero })
  if (!$apps.Count) { throw 'discord_not_running' }
  $candidates = @()
  foreach ($app in $apps) {
    $window = [Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
    $condition = New-Object Windows.Automation.OrCondition(
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)),
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::CheckBox))
    )
    foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)) {
      if (Is-MuteButton $element) { $candidates += $element }
      if ($candidates.Count -gt 8) { break }
    }
  }
  if ($candidates.Count -ne 1) { throw 'discord_mute_button_not_found' }
  $script:DiscordElement = $candidates[0]
  return $script:DiscordElement
}
function Read-DiscordMute($Element) {
  $pattern = $null
  if ($Element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
    $value = $pattern.Current.ToggleState
    if ($value -eq [Windows.Automation.ToggleState]::On) { return $true }
    if ($value -eq [Windows.Automation.ToggleState]::Off) { return $false }
  }
  $name = $Element.Current.Name
  if ($name -match '(?i)\bunmute\b') { return $true }
  if ($name -match '(?i)\bmute\b') { return $false }
  throw 'discord_state_unavailable'
}
function Discord-Action([string]$Operation) {
  $element = Find-MuteButton ($Operation -eq 'discord.bind')
  $before = Read-DiscordMute $element
  if ($Operation -eq 'discord.toggle') {
    $pattern = $null
    if ($element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle() }
    elseif ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke() }
    else { throw 'discord_button_not_invokable' }
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 80
      try { $after = Read-DiscordMute (Find-MuteButton); if ($after -ne $before) { return @{available=$true;muted=$after} } } catch {}
    }
    throw 'discord_mute_unconfirmed'
  }
  return @{available=$true;muted=$before}
}
function Find-DiscordControl([string]$Kind) {
  $names = switch ($Kind) {
    'deafen' { '(?i)\b(?:undeafen|deafen)\b' }
    default { throw 'discord_control_invalid' }
  }
  $owner = Find-MuteButton
  $ownerId = $owner.Current.ProcessId
  $apps = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^Discord(?:Canary|PTB)?$' -and $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.Id -eq $ownerId })
  if (!$apps.Count) { throw 'discord_not_running' }
  $found = @()
  foreach ($app in $apps) {
    $window = [Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
    $condition = New-Object Windows.Automation.OrCondition(
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)),
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::CheckBox))
    )
    foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)) {
      if ($element.Current.Name -match $names) { $found += $element }
    }
  }
  if ($found.Count -eq 0) { throw ('discord_' + $Kind + '_absent') }
  if ($found.Count -ne 1) { throw ('discord_' + $Kind + '_ambiguous') }
  return $found[0]
}
function Read-DiscordControl($Element,[string]$Kind) {
  $pattern = $null
  if ($Element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)) {
    if ($pattern.Current.ToggleState -eq [Windows.Automation.ToggleState]::On) { return $true }
    if ($pattern.Current.ToggleState -eq [Windows.Automation.ToggleState]::Off) { return $false }
  }
  $name = $Element.Current.Name
  if ($Kind -eq 'deafen') {
    if ($name -match '(?i)\bundeafen\b') { return $true }
    if ($name -match '(?i)\bdeafen\b') { return $false }
  }
  throw 'discord_state_unavailable'
}
function Discord-ExtraAction([string]$Operation) {
  $kind = 'deafen'
  $element=Find-DiscordControl $kind
  $before=Read-DiscordControl $element $kind
  if ($Operation -match 'toggle') {
    $pattern=$null
    if ($element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)) {$pattern.Toggle()}
    elseif ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {$pattern.Invoke()}
    else {throw 'discord_button_not_invokable'}
    $confirmed=$false
    for($i=0;$i -lt 20;$i++){Start-Sleep -Milliseconds 80;try{$after=Read-DiscordControl (Find-DiscordControl $kind) $kind;if($after -ne $before){$before=$after;$confirmed=$true;break}}catch{}}
    if(!$confirmed){throw 'discord_control_unconfirmed'}
  }
  return @{available=$true;deafened=$before}
}
if ($SelfTest) {
  # Verify ABI and accessibility loading without injecting input or invoking UI.
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
      {$_ -in @('discord.status','discord.bind','discord.toggle')} { $value = Discord-Action $message.operation }
      {$_ -in @('discord.getdeafenstatus','discord.toggledeafen')} { $value = Discord-ExtraAction $message.operation }
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
