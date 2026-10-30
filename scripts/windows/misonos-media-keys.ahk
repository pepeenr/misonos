; MiSonos media keys, for AutoHotkey v1.1 (AutoHotkey v2 runs it too, through its
; v1 launcher). The keyboard's volume knob or keys, mute, and play/pause, next and
; previous control the Sonos room selected in MiSonos (the last one picked in the
; app, on any device) instead of this PC. Hold Ctrl with a key to use it for this
; PC as usual. Setup: README.md next to this script.
#NoEnv
#SingleInstance Force
#UseHook

; MiSonos on the home network. The public address sits behind Cloudflare Access,
; which a script can't sign in to.
global MISONOS_URL := "http://192.168.178.84:6173"
; Sonos volume change per knob click (Windows steps its own volume by 2).
global VOLUME_STEP := 2
; false leaves play/pause, next and previous to this PC; the volume keys still go to Sonos.
global TRANSPORT_KEYS := true

global pendingDelta := 0
Menu, Tray, Tip, MiSonos media keys
return

Volume_Up::QueueVolume(VOLUME_STEP)
Volume_Down::QueueVolume(-VOLUME_STEP)
Volume_Mute::ToggleMute()

#If TRANSPORT_KEYS
Media_Play_Pause::Transport("playpause")
Media_Next::Transport("next")
Media_Prev::Transport("previous")
#If

; Clicks that arrive while a request is on its way add up and go in the next one,
; so a fast turn of the knob doesn't queue a request per click.
QueueVolume(delta) {
    pendingDelta += delta
    SetTimer, SendVolume, -30
}

SendVolume() {
    delta := pendingDelta
    pendingDelta := 0
    if (delta = 0)
        return
    ShowVolume(Post("/api/selected/volume", "{""delta"":" delta "}"))
}

ToggleMute() {
    ShowVolume(Post("/api/selected/volume", "{""toggleMute"":true}"))
}

Transport(action) {
    Post("/api/selected/transport", "{""action"":""" action """}")
}

; The bridge answers with the room's volume: {"id":"...","volume":24,"muted":false}.
ShowVolume(response) {
    if !RegExMatch(response, """volume"":(\d+)", match)
        return
    muted := InStr(response, """muted"":true") ? " (muted)" : ""
    Notify("Sonos volume " match1 muted)
}

Post(path, body) {
    try {
        request := ComObjCreate("WinHttp.WinHttpRequest.5.1")
        request.Open("POST", MISONOS_URL . path, false)
        request.SetTimeouts(2000, 2000, 5000, 10000)
        request.SetRequestHeader("Content-Type", "text/plain;charset=UTF-8")
        request.Send(body)
        if (request.Status >= 400)
            throw Exception(request.Status " " request.ResponseText)
        return request.ResponseText
    } catch error {
        message := error.Message
        ; WinHttp errors name the problem on a "Description:" line of a longer dump.
        if RegExMatch(message, "Description:\s*([^\r\n]+)", description)
            message := description1
        Notify("MiSonos: " Trim(message))
        return ""
    }
}

Notify(text) {
    ToolTip, %text%
    SetTimer, HideToolTip, -1500
}

HideToolTip() {
    ToolTip
}
