# Dashboard button deck

Choose **Dashboard > Button deck** to switch from the overview. Your pages and
mode are saved on this PC. Localhost, the desktop window and an enabled LAN
browser use the same controls and current state.

Saved **Light profiles** appear automatically in the action library. Their default
bulb buttons show one backlight LED per included fixture, using the profile's
saved colors, white temperature, brightness and power. This appearance follows
profile edits. Customize the backlight normally to override it, or enable
**Use profile colors for the backlight** to restore automatic lighting.

New decks start with a **Quick Access** page containing playback, player volume,
request intake, quick song and requester bans, lighting, rewards,
Discord and broadcast clipping, plus a separate **Audio mixer** page. Older saved
decks acquire that mixer page once; removing it later keeps it removed. Add your own pages when useful; page tabs appear
only when there is more than one page. Existing saved layouts are retained.
Unavailable controls explain which connection, package or permission is needed.
Playback and moderation retain the existing owners and current-track checks.
Auto-Rave and Music lights each use a single toggle. Labels and LEDs follow the
current automation or light-session owner, including changes from another device.
Explicit start/stop and enable/disable actions remain available for macros that
need a fixed outcome.

Buttons are saved configuration backed by the action library. Starter buttons can
be edited or removed; they do not contain a particular user's account, network
address, OBS scene or audio device. Each Windows installation discovers its own
devices, apps, rewards and OBS objects. System audio and microphone controls follow
that computer's current default devices. Specific device/source buttons must be
selected again if their target is missing on another PC; they never silently
control a different target. Account authorization and OBS
connection setup belong to the Windows installation hosting Core. LAN devices
operate that host through the same action library.

## Make it yours

Choose the **+** tile, find an app or mod action, then save. **Edit** lets you drag
buttons into order with a floating preview and live insertion position, tap them to customize, or remove them. **Undo** restores the
last layout change. Add pages with **+ Page**, and choose a folder behavior to
open another page. Editing a button never executes its action.

The Edit toolbar offers **Display** and **Buttons per row** directly. Row changes
apply to the current phone, tablet or desktop size. **Auto fit** keeps icon and
text together when they fit, alternates them when crowded, and uses the icon on
very small tiles. Choose icon/image only, text only, icon + text, or an eight-second
icon/text cycle yourself. **Each button's setting** uses its individual display
choice. Reduced-motion mode keeps alternating buttons on text. Volume sliders
keep their interactive control visible.

In Edit, drag anywhere on a button to reorder it with mouse, touch or pen; a tap
opens its settings. Drag near the top or bottom edge to scroll a long deck.
Scroll the page from outside the buttons. Focus the move grip and use an arrow key to move
one position with a keyboard. Undo restores the last layout change.

- Run ordered action sequences with optional delays.
- Alternate between two sequences on successive successful presses.

Choose **Create a toggle** or **Toggle · first / second press** to build your own.
Use **Add library action to** to choose the first or second press, then select
actions. Each sequence can contain several functions and delays. Set the initial
state and the state after the first press with separate labels, icons and LED
colors. Only a successful press advances it; failures, holds and cancelled actions
keep the prior state. Connected screens share this state. Custom toggles track
RaveLink's successful commands, not changes made in other apps, and start at the
first press after Core restarts. Built-in owner-confirmed toggles read the actual
service state instead.

- Add a separate hold action; Shift+Enter also runs it with a keyboard.
- Use a volume slider for an action that declares a slider control.
- Customize symbols, titles, image-only, image plus text, or text-only display.
- Upload PNG, JPEG or animated GIF images and choose static or cycling backlight tints.
- Press **Choose from icon library** for 250 bundled icons across audio, media,
  streaming, lighting, chat, moderation, clips, devices and navigation. Search by
  name or purpose, filter by category, choose an icon color and press **Use icon**.
  Save the button to keep it. Icons work offline and from LAN browsers; selection
  never executes the button. Custom symbols, images and GIFs remain available.

Images, layouts and macro parameters stay in the private runtime directory.
Button presses are single-flight. **Stop running actions** cancels future steps;
completed external actions retain their result. Failures stop a sequence.
Open-target, hotkey, typing and media-key actions run on the Windows PC hosting
Core, including when pressed from a phone. Keyboard actions target its current
desktop/application; provider controls use their dedicated owners.

## Style and presets

Open **Button settings > Style & presets** and choose whether to style **All
buttons**, the **Current page** or one named button. Five presets are available:
**Crimson glow**, **Ice blue**, **Warm amber**, **Aurora color cycle** and
**Backlight off**. Custom style controls adjust backlight color, brightness,
steady light or a slow three-color cycle, and cycle duration from 1-30 seconds.

**Keep current colors & effects** is selected when the panel opens. Choose a
preset or custom setting, then **Apply style** to save it. Actions, pictures,
animated GIFs and labels are preserved; Undo is available on the deck.
The **Individual buttons** tab lists your controls and opens their existing
editor for actions, picture/GIF, symbols, text, colors and effects. It also offers
**+ Add a button**.

## Layout and fullscreen

Buttons start with the Square shape, 28px corners and a cranberry backlight.
A recessed LED source sits under a separate clear acrylic face, with a raised
edge and pressed-down response. Each button's **Backlight brightness** runs from
0-100%; its static or cycling **Backlight color** tints the light behind the face.
**Master backlight** in Layout adjusts the whole deck from 0-100%. Zero switches
the LED off; text, images and actions remain available.

The LED also reports live status: green means active/ready, amber means paused,
muted or waiting for confirmation, red means unavailable or a confirmed failure,
and slate means inactive or unknown. Approved mods can provide their own status
colors. Status overrides the resting color cycle and updates when the owner
changes, including from another device. One-shot completion lights green for about
700 ms, then restores the normal backlight without waiting for another status update;
failure feedback expires after eight seconds. A pending clip stays amber until
Twitch confirms it. Multi-action macros combine their steps' feedback, and a lost
status connection becomes neutral instead of retaining a stale green light.

Use **Layout** and **Page settings** in the top control bar; the bar stays visible
while editing a long deck. Open **Layout** for separate desktop, tablet and phone row counts (1-12), spacing,
corner radius, label size, shape and status labels. Preview changes before saving;
closing the panel discards the preview. Reset previews the defaults. Dense rows
scroll horizontally when necessary to keep controls usable.

Choose **Fullscreen** to show the current page of buttons and enabled status widgets. The small exit
control or Escape returns to the dashboard. The user gesture requests native
fullscreen when supported and permitted. If unavailable or denied, the button
view fills the available viewport; browser or desktop window chrome can remain
visible in that fallback.

## Reward and light controls

**Windows controls** opens direct controls for system output and apps with audio
sessions. Choose **Microphone** for the current Windows input. Specific connected
devices are also available from the action library. Adjust
volume or mute in the popup. Each **+** menu can pin a volume slider, mute toggle
or a button that reopens that target's popup. App pins follow the executable name
across process restarts; if the app has no audio session, the button says so.
An app with several sessions shows mixed levels honestly, and changing its level
applies to all current sessions for that app. Default system and microphone pins
follow Windows' current default devices; individual device pins stay tied to that
device.

Microphone controls change the Windows input device, while Discord mute affects
Discord only. Media previous/play-pause/next/stop commands are available in the
same panel and can also be pinned. These are working controls on the Core PC;
they also work through the enabled LAN browser. Pinning or opening a popup never
changes audio. Changes in Windows are reflected in the panel and pinned controls.

Rewards support three arrangements: an individual managed-reward toggle, one
toggle for all managed rewards, or a **Reward controls** button that opens a
compact panel. The action library lists the current managed rewards by name.
Inside the panel, **+** pins an individual reward toggle to the current deck page.
The button stays tied to that reward; removing it from Twitch makes the action
unavailable. Controls retain current owner state, and song rewards remain paused
while request intake is closed or unavailable. The Overview also uses one
pause/resume control for all managed rewards.

Lights support a saved command for one fixture, a command for all enabled lights,
or a **Quick light controls** button that opens a compact panel. Choose a light
or **All lights**, set color and brightness, then press **Apply**. **Turn off**
sends an explicit off command. These manual commands take over the selected
lights from an active effect. Changing fields alone sends no light command.
**+ Add this setting to deck** saves a button for the selected target, color and
brightness; it applies the setting only when that new button is pressed.

## Keyboard buttons

Choose **+ ? Keyboard key** or add a **Keyboard shortcut** action to any macro.
Pick a rare key from **F13?F24**, optionally combined with Ctrl+Shift, or enter
another valid key combination. Input runs on the RaveLink PC, including from LAN.
The optional delayed Send button lets you focus another app before sending a key.
It cancels if the editor is closed. Saving a button never sends input.

Existing Discord microphone/deafen buttons migrate to F13/F14 macros while keeping
their appearance and position. These report key execution, not the other app's
state. The legacy accessibility mod is disabled by default. RaveLink does not
launch, restart or close Discord.

## OBS buttons

Press **OBS connection** at the top of the Dashboard to connect or manage OBS.
For scene, source and filter buttons, press **+ Add button → Create an OBS button**.
OBS Studio 28 and newer includes
the required WebSocket server; there is no separate plugin to install.

In OBS, open **Tools → WebSocket Server Settings**, enable the server and press
**Apply**. Keep authentication enabled. In RaveLink, press **Refresh OBS list**,
then **Connect this PC’s OBS**. This explicitly imports the existing local
connection without editing OBS settings or restarting OBS. For OBS on another
PC, expand connection details and enter its private IPv4 address, port and password.
Passwords are protected for the Windows user and never returned to LAN browsers.

The builder reads **When this button is pressed → choose an object → choose an
action**. Select a source first, then choose show/hide, audio or one of its actual
filters. Options adapt to the selected object. Visibility can target one scene/group
and source instance, or **All scenes and groups**. An all-scenes toggle shows every
matching instance if any are hidden; otherwise it hides them all. Filter and audio
controls already apply to the shared source across scenes. Give the button a label and
add it to the current deck page. Available objects include program scenes, Studio preview
scenes and transitions; source/camera visibility inside a scene or group;
microphone mute and volume; individual filter enable/disable; Studio Mode,
streaming, recording, virtual camera and replay saving where supported by OBS.
These are user-created controls; opening the builder and adding buttons does not
run them. Pinned OBS actions also appear in the normal macro action library.

**Preview selected scene** requests a small snapshot without switching scenes.
Optionally use that snapshot as the button image. It is a captured image, not a
continuous video feed. Existing button image/text, color, backlight and layout
settings still apply. Use Edit to customize the result. Hiding a camera source
affects that scene instance; it does not power off the camera or mute its microphone.

Buttons follow OBS events for feedback and use the same Core connection from
localhost, the desktop app and LAN phones/tablets. Missing sources, disconnected
OBS and different scene collections stay explicit. Connection recovery never
replays an uncertain command. RaveLink does not start or stop the OBS application.
See the [OBS remote-control guide](https://obsproject.com/kb/remote-control-guide)
and [official WebSocket protocol](https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md).

## Twitch clips

Open **Twitch Connection**, select **Create stream clips**, then complete **Start
device login** or **Update Twitch access** and check authorization. The setup
shortcut opens the same permission chooser. Clip access uses the broadcaster
connection with the additional `clips:edit` scope. A selected checkbox is a choice
for the next authorization; the **Granted** badge confirms current access.
**Clip broadcast** requests a clip from the current channel. The button stays
pending until Twitch confirms the clip, then shows success or failure.

**Allow !clip in chat** defaults off. When enabled, viewers can use `!clip` or a
title such as `!clip 3k on tracer`. Choose everyone or broadcaster/moderators.
Chat commands also need **Read chat commands**; posting the clip link needs **Send
chat replies**. Chat and button requests share a cooldown
and duplicate protection; uncertain requests are not blindly retried. Clips need
a live broadcast and clipping enabled on the channel.

In **Connections → Twitch → Clip title moderation**, title filtering is on by
default. The offline English profanity filter replaces matching words with
exactly `****` before a custom title is sent to Twitch. It covers both button/mod
titles and `!clip` titles. Add blocked words or phrases in any language and allowed
exceptions, one per line. Custom entries match whole words/phrases without regard
to case; allowed exceptions override matches inside that phrase. Each list allows
128 entries of up to 64 characters. The English filter also detects common
disguised spellings; use **Test filter** to check your choices without making a
clip. Choose **Reject the clip request** to block the request instead of masking,
or explicitly switch filtering off. Press **Save title filter** to apply changes.
Rejected titles never create a clip or consume the shared cooldown. An empty
title continues to use Twitch's broadcast title; existing clips are not edited.

## Custom mod functions

Visible decks share one live status feed. Fast controls refresh up to twice a
second, while slower external checks run independently; confirmed action results
appear immediately. Unchanged views send no updates and hidden decks disconnect.
Opening more LAN screens does not start more polling loops.

The two included mods work without enabling community packages. Install your own
mods through the optional community-mod platform. A mod contributes an action
that names an existing provided capability method, parameter schema and defaults,
plus an optional state method for live feedback. Those functions appear in the
button library with the mod's symbol and title.

Mods retain normal permission approval and runtime limits. Changing requested
or provided capabilities requires approval again. Installing a package or editing
a button does not grant account, capture or hardware permission. See the mod SDK's
`contributes.actions` contract; browser scripts are never evaluated as functions.

## Status widgets

In the button deck, press **Edit, then + Add widget**, or choose a starter set.
Widgets appear above the buttons. Defaults use small text, compact cover art,
thin progress bars and a transparent background. Nothing is added automatically.

**Current requester** shows the person whose request is playing, or **No requester**
when the playback owner has no confirmed requester. **Next requested song** is a
separate widget: it shows the next queued request and its requester, or **No song**.
Neither replaces the independent **Now playing** widget. The **Music & requests**
starter set adds all three. Optional extra details show the current request's title
or the upcoming song's artist; cover art is optional for the upcoming song.

Move widgets with the arrows or drag them while editing; remove them with the remove button.
Choose a maximum number per row; narrow screens use fewer columns automatically.
Each widget has its own title, width, size, surface, color and relevant details.
Cover art, progress, requester and next-song information can be switched separately.
Extra lists and richer surfaces are optional. Enabled widgets appear in fullscreen
by default; switch off **Show in fullscreen** to hide them there.

Available widgets cover music, requests, stream elapsed/start time, viewers,
followers, subscribers, clips, timestamps, OBS, rewards, connections and a clock.
Music clocks advance locally; account totals share cached reads across LAN screens.
Subscriber totals and recent follower names need their optional Twitch access
groups under Connection. Existing authorization choices are preserved.

**Mark moment** saves a local timestamp against a confirmed Twitch or OBS stream,
using the time the button was pressed. Open **Notes & history** to add a description,
review moments or export them as text. VOD links appear when Twitch provides a
matching recording. A **Save stream timestamp** action is also available in the
macro library. Local marks need no extra Twitch write access. The separate Twitch
marker action explicitly requires broadcast-marker access, a live broadcast and
VOD storage; it never substitutes a local success for a failed Twitch write.

## Manual Rave toggle

Choose **Start Rave · until restored** in the action library to add **Rave / restore**.
Press it to start the selected Music-to-Light fixtures and profile; press again to
stop and restore their previous states. It continues across track changes without
a song timer. Capture and light-output permissions are still required. The timed
**Start Rave** action remains available separately.

Its default acrylic backlight has one LED per assigned fixture, using the saved
palette while idle and the chosen Rave palette while running. Ambient and off
fixture roles affect LED brightness. The status label confirms whether lights are
running. You can override the backlight in button appearance settings.

## Fullscreen screens and keyboard triggers

In **Edit > Layout**, choose **Fullscreen navigation > Screens** to fit buttons
into separate fullscreen screens. Swipe left/right to change screens, or use the
small Previous/Next controls. Swipe navigation is optional. Widgets stay above
the buttons on every screen; tall widget lists can scroll independently.

Enable **Keyboard screen navigation** to use the selected Previous/Next keys.
Click a key field and press the key or combination you want. **Enable button
keyboard triggers** also lets each button's **Keyboard trigger** run its actions
while RaveLink is focused. A macro can contain any supported action. Triggers
ignore held-key repeats, edit mode, dialogs and text fields. Duplicate triggers
on a button page or conflicts with navigation keys must be changed before saving.
These are browser-focused controls, separate from keyboard-output actions that
send a key to an application on the Windows host.

Swipe navigation changes screens immediately when the gesture ends, with no slide
animation. Complete rows use the available height before overflow moves to another
screen. Navigation also moves between configured deck pages at their boundaries.

## Audio mixer and slider docks

The Audio mixer page presents system output and live Windows app sessions in one
row. The Song Request fader sits beside the selected native music player's fader.
Song Request volume respects its configured output range. If its native companion
is disabled, a uniquely identified Windows music-player session supplies volume;
an ambiguous or unavailable target fails visibly rather than controlling another app.

In **Edit > Layout**, choose vertical or horizontal sliders and their shared dock:
left/right for vertical, top/bottom for horizontal. Alternatively, keep sliders on
the Audio mixer page. Dock placement applies to the deck, including edit mode;
individual buttons do not need placement rules. Acrylic button-style faders remain
an appearance choice. Changes paint locally during a drag while writes coalesce;
older status updates cannot pull the thumb back during the interaction.

On touchscreens, drag in a fader's direction to adjust volume; sideways screen
swipes over vertical faders leave volume unchanged. In fullscreen paging mode,
hold a horizontal fader briefly before dragging it so ordinary page swipes can
pass across it. Keyboard and mouse range controls remain available.

The action library also offers **Next song**, **Previous song**, and **Media player
play / pause**. These target the selected native TIDAL, Spotify or Apple Music
session on the host, including from a phone or tablet. They never fall back to a
global key that could reach another app. Embedded players retain their request
controls. **Skip request** separately moderates the current
managed request and requires an identified request.

Enable **Snap sliders to the chosen increment** in Layout and choose 1–100% steps.
With snapping off, native audio has its normal 1% resolution. Individual fader
buttons can inherit this setting, use Smooth, or set their own snap increment in
the button editor. Endpoints remain reachable even when the chosen step does not
divide 100. Changing this preference never changes the actual volume by itself.

## Shared button screen

In **Edit > Layout > Button screen background**, select a private PNG, JPEG or GIF
up to 8 MiB, or a muted MP4/WebM up to 16 MiB. Choose fit and brightness, then save.
One media surface spans the button faces and respects rounded corners and gaps.
Video pauses when hidden and releases playback when removed. This media remains
local runtime data and is excluded from source and release archives.
