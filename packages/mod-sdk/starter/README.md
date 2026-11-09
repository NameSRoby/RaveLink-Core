# Button mod starter

This dependency-free example contributes a toggle button to the Dashboard action
library. It changes only its own in-memory enabled state. It does not mute an app,
control a device, connect to an account or store data. State resets on activation.

Copy this folder, change the publisher/ID/capability consistently, implement your
handler and update the SHA-256 inventory after editing. From a source checkout:

```powershell
Copy-Item packages/mod-sdk/starter runtime/my-first-mod -Recurse
npm.cmd run mod:validate -- runtime/my-first-mod
npm.cmd run mod:package -- runtime/my-first-mod runtime/my-first-mod.zip
```

Drop the folder or packaged ZIP into `mods/`, then confirm Activate in Mods.
No special startup mode or installer option is needed. Current Windows network isolation requires an explicit reduced
isolation confirmation for community code. The test harness is available without
running a real mod worker or granting desktop/network access.

See the [author guide](https://github.com/NameSRoby/RaveLink-Core/blob/main/docs/MOD_AUTHOR_GUIDE.md)
and [API reference](https://github.com/NameSRoby/RaveLink-Core/blob/main/docs/MOD_API_REFERENCE.md).
