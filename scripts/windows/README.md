# MiSonos media keys (Windows)

`misonos-media-keys.ahk` makes the keyboard's volume knob or keys, mute, and play/pause, next and previous control Sonos instead of this PC. Hold Ctrl with a key to use it for the PC as usual.

- **Which room:** the one last selected in MiSonos, on any device. Grouped rooms move together, like the main volume slider.
- **Volume:** 2 per knob click. Volume stays under the cap set in Settings, and turning it while muted unmutes. A tooltip shows the new volume.
- **Network:** it talks to MiSonos on the home network. The public address is behind Cloudflare Access, which a script can't sign in to.

## Setup

1. Install [AutoHotkey](https://www.autohotkey.com/). The script is written for v1.1, and v2 runs it too.
2. If MiSonos isn't at `http://192.168.178.84:6173`, change `MISONOS_URL` at the top of the script. `VOLUME_STEP` and `TRANSPORT_KEYS` (false leaves play/pause, next and previous to the PC) are there too.
3. Double-click the script. It runs in the tray.
4. To start it with Windows: press Win+R, enter `shell:startup`, and put a shortcut to the script in the folder that opens.

If the knob still changes the PC's volume, AutoHotkey isn't seeing it. Right-click the tray icon → Open → View → Key history, turn the knob, press F5, and check whether `Volume_Up` or `Volume_Down` appears.
