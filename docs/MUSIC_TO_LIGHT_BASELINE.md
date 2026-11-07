# Music-to-Light baseline and settings

Core's **Color-led audio** preset uses brightness for measured musical energy
and color changes for measured rhythmic attacks. Quiet passages retain prompt
hit detection. The portable artistic reference is
[`accepted-color-led-v1.json`](../integrations/music-to-light/profiles/accepted-color-led-v1.json).
Device bindings, capture grants, mixer identities and calibration stay private.

Brightness uses the full calibrated range, bounded by the operator's minimum and
maximum. The former 75% artistic multiplier and per-song brightness override are
retired in native Core: they cannot impose a second ceiling. Normal brightness
rise is 35 ms and fall 100 ms. Distinct upward changes, including quieter impacts,
shorten the rise toward 20 ms; smaller fluctuations retain their smoothing. This
follows measured RMS alone, without an onset pulse, added gain or reserved headroom.
Short measured peaks survive to the next available light update and are consumed
once represented. A bounded recent window prevents a backlog of old impacts.

The response maps measured RMS **power** between the fixed quiet/loud references.
It does not spread decibel values evenly across brightness: that earlier mapping
made compressed buildups almost as bright as their drops. Six decibels below the
loud reference is roughly one quarter of its power. The reference stays fixed;
a quiet passage cannot normalize itself toward full brightness. Alternative
energy and frequency color styles retain their measured mappings.

A mild contrast curve lowers softer measured levels and lifts stronger ones,
while preserving the midpoint, both output endpoints and the existing timing.
Beat colors alternate neighboring palette colors for four measured hits before
advancing to the next pair. Every hit changes color, including phrase boundaries.
An 80 ms fade smooths the reversals into a controlled vibration; the sequence
never redraws colors during a run.

Beat colors use an 80 ms fade and no secondary filter. Quiet and loud measured
hits use the same timing; falling below the brightness reference cannot hide a
color hit. First-party log-spectral attacks reveal quieter drums independently
of the retired Expressive switch, with classic analysis as a compatibility fallback.
There is no loudness-dependent waiting interval or guessed beat clock.

Fresh samples update intent promptly. Preview and physical fixture writes remain
capped at 12 Hz, with separate per-fixture deadlines. Held targets renew ownership
without spending a physical output slot, and newly arrived audio is rechecked
when an in-flight hold completes. Color events cannot pulse brightness.

## Settings audit

| Setting group | Current behavior |
| --- | --- |
| Minimum and maximum brightness | The output range. No separate artistic multiplier reserves brightness. Device-representable limits remain enforced. |
| Normal brightness rise and fall | One audio-sample-clock envelope. Distinct rises accelerate without lifting beyond the measured target; ordinary fluctuations and falls keep their smoothing. Changes apply live, including locked color recipes and saved looks. |
| Audio reference and auto audio follow | Fixed calibration with matching app-mixer compensation. Ordinary color/preset edits preserve the latest reference. Only explicit reference edits or calibration change it. |
| Output rate | Preview and physical writes are capped at 12 Hz. Held checks cannot consume a physical slot. Experimental adaptive cadence remains separate; its controls are disabled in steady mode. |
| Color attacks | Every qualified rhythmic attack can select the next palette target within the detector/transport bound. Quiet hits receive the same response timing as loud hits. No guessed beats or queued old events. |
| Quiet-hit detection | Log-spectral analysis remains independent of brightness and Expressive. The brightness floor dims quiet audio without freezing its measured color changes. |
| Beat color fade | Same fade for quiet and loud hits, scaled only by the chosen color pace. Zero selects immediate steps. An interrupted fade starts at the color already reached. |
| Transition vividness | Color interpolation only. Disabled where a static color or warm/cool mapping makes it inapplicable. |
| Static, energy, frequency and flow colors | Static holds a color. Energy follows measured level; frequency follows band balance. Flow advances with actual audio activity instead of a free-running silent-room clock. |
| Color pace | Changes color timing only. It cannot alter brightness attack/release or raise the output cap. |
| Color separation and room position | Palette offsets and audio-driven color flow. They do not attenuate brightness or add a brand synchronization delay. |
| Shared/group/fixture palettes | Supported independently of color style. Palettes and assignments stay locked during a run; history avoids recent repeats. |
| Coordinated or mixed fixture assignments | Choose color jobs: audio attacks, frequency colors, energy colors or audio flow. All use the shared envelope; the selected profile may deliberately distribute its measured brightness between lead and ambient lights. |
| Random numerical variation | Only color fade and transition vividness. Pulse, brightness-envelope, calibration and transport parameters cannot be randomized. Inapplicable ranges are skipped. |
| Color-led audio and Smart random | Use the same brightness baseline. Smart random varies compatible color choices without restoring an older response model. |
| Palette choices | Change colors independently of brightness smoothing, audio mapping, calibration and limits. |
| Saved looks and older imports | Converted through Core's native response policy before rendering. Old storage IDs remain readable but cannot re-enable pulses. |
| Opening/ending animations | Explicit lifecycle transitions, off in the baseline. Background dim/steady/off jobs and exact restoration retain their separate rules. |
| Auto-Rave, songs and viewer permissions | Keep their own enablement, source/grant, route and duration checks. Removing old response scenarios does not silently enable a blocked request. |
| Source priority and missing spectral detail | Source selection remains explicit. A color frequency focus does not block valid brightness while spectral detail warms up. |

## Effect profiles and the creator

The reference response above is shared by ten profiles. Choreography adds bounded
fixture emphasis after the measured envelope; it cannot invent an impact or exceed
the configured range. Companions remain responsive at an ambient share instead of
receiving artificial brightness pulses. Scene jobs bypass profile choreography.

| Profile | Distinct behavior | Best with |
| --- | --- | --- |
| Color-led audio | Accepted room-wide brightness and alternating beat colors | 1+ lights |
| Counterpoint | Opposing palette positions with shared dynamics | 2+ |
| Beat relay | The lead advances around the room on measured hits | 2+ |
| Ricochet | The lead bounces from one room end to the other | 3+ |
| Call & response | Two room halves exchange lead and ambient roles | 2+ |
| Bass & detail | Alternating bass and treble energy emphasis | 2+ |
| Spectrum room | Three frequency ranges across the room | 3+ |
| Mirror dialogue | Symmetric pairs exchange focus outside-in | 3+ |
| Rising tide | Measured intensity progressively fills fixture positions | 2+ |
| Phrase weave | Interleaved teams alternate lead with offset colors | 2+ |

Each has a matching palette. Custom palettes are retained separately, and fresh
random palettes override matching colors without changing the selected profile.
With one light, spatial emphasis falls back to the shared brightness response.
Frequency roles use FFT band energy; they do not isolate vocals or instruments.

The Play / Create split keeps playback compact. Create holds the profile's
applicable controls, brightness smoothing, color rules, intro/outro and the local
saved-effect library. A saved effect captures the actual resolved profile and
palettes, not instructions to reshuffle them. Rave profile shuffle uses a bounded
activation-only history, visits all ten and avoids repeats at bag boundaries.
It applies to manual/viewer/song Rave; continuous playback retains its selection.

Intros reveal the room forward, center-out or in reverse by blending the acquired
native state into current measured audio. They do not add a bright decorative
sweep over quiet music. Outros offer a shared soft return, room sweep or center-out
return, ending with exact native restoration. Manual takeover and failure cleanup
retain priority; background jobs keep their own behavior.

## Retired controls

Pulse decay/bed, regular/strong pulse depth, Pulse-led/steady/loudness brightness
switches, Expressive brightness, old spatial brightness masks, and random pulse
parameters are absent from native controls. Artistic intensity and per-song
brightness multipliers are also retired; old stored values cannot cap Core's
reactive brightness. The former movement axis is replaced
by color styles and color frequency focus. Secondary brightness/output filters
cannot stack on top of the accepted envelope.

Legacy mathematical renderers and storage identifiers remain for compatibility
tests and old-file decoding. Core's response policy applies to initial settings,
manual edits, saved looks and viewer/automation starts, so those legacy paths are
not selectable native response engines.

## Verification

Regression coverage checks brightness invariance across native presets, color
paces, frequency roles and mixed color jobs; equal quiet/loud hit timing and
visible colors below the brightness floor; live smoothing edits; calibration preservation; held output ownership;
transport caps; short loud impacts, full-range sustained brightness, preserved
small-signal smoothing, growing three-hit builds, immediate writes after holds,
short-peak consumption without replay; and exact native restoration. Browser tests exercise the actual
Core routes at desktop and phone sizes. Hardware delivery counters are adapter
receipts, not optical measurements or a guarantee that every palette suits a room.
