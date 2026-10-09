#!/usr/bin/env python3
"""
ApexWall PTT Bridge sidecar — wheel-button push-to-talk for the race engineer.

- Reads sim-rig wheel/button-box buttons via DirectInput (pygame).
- Records the microphone while a mapped PTT button is held (sounddevice).
- Talks to telemetry-bridge.js over stdin/stdout as JSON lines.

Stdin commands (JSON per line):
  {"cmd": "map", "buttons": ["0:4", "1:4"]}   # joystick_index:button_index pairs to watch
  {"cmd": "learn_start"}                       # capture next pressed button
  {"cmd": "learn_stop"}

Stdout events (JSON per line):
  {"type": "ptt_audio", "wav_b64": "<base64 16kHz mono 16-bit WAV>"}
  {"type": "ptt_learned", "button": "0:4"}
  {"type": "ptt_status", "ok": true, "joysticks": [...], "mic": "..."}
  {"type": "ptt_listening", "active": true}

Env:
  PTT_MIC      - substring of the mic device name (or numeric index) to use.
                 Defaults to the system default input device.
  PTT_SPEAKER  - substring of the output device name (or numeric index) for
                 engineer voice replies. Defaults to system default output.
                 The bridge logs all output devices at startup so you can
                 pick the right name (e.g. your wireless headphones).

Requires: pip install pygame-ce sounddevice
"""
import sys
import os
# Headless video so pygame.event.pump() works without a window — required for
# joystick state updates. Must be set before pygame is first imported.
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
import json
import time
import base64
import io
import wave
import threading
import queue

SAMPLE_RATE = 16000
MAX_SECONDS = 8
MIN_SECONDS = 0.3
POLL_HZ = 50

def log_event(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def log_status(**kw):
    log_event({"type": "ptt_status", **kw})

# ---------------------------------------------------------------- joystick ---
joysticks = []
joy_names = []
pygame_ok = False

def init_joysticks():
    global pygame_ok, joysticks, joy_names
    try:
        import pygame
        if not pygame_ok:
            # Dummy video driver (set at import) lets event.pump() run headless —
            # required for joystick state updates.
            pygame.display.init()
            pygame.joystick.init()
            pygame_ok = True
        # (Re)enumerate — handles hotplug between races
        joysticks = []
        joy_names = []
        count = pygame.joystick.get_count()
        for i in range(count):
            try:
                j = pygame.joystick.Joystick(i)
                # Note: Joystick.init() deprecated since 2.4 — constructor auto-inits
                joysticks.append(j)
                joy_names.append(j.get_name())
            except Exception:
                pass
        return True
    except Exception as e:
        log_status(ok=False, error=f"pygame unavailable: {e}")
        return False

_poll_error_logged = False

def poll_buttons():
    """Return set of 'joy:btn' ids currently pressed."""
    global _poll_error_logged
    pressed = set()
    if not pygame_ok:
        return pressed
    try:
        import pygame
        pygame.event.pump()
        for ji, j in enumerate(joysticks):
            try:
                nb = j.get_numbuttons()
                for b in range(nb):
                    if j.get_button(b):
                        pressed.add(f"{ji}:{b}")
            except Exception:
                pass
    except Exception as e:
        # Log once — silent failures here mean "no buttons ever detected"
        if not _poll_error_logged:
            _poll_error_logged = True
            log_status(ok=False, error=f"button poll failed: {e}")
    return pressed

# ------------------------------------------------------------------- mic ---
sd = None
mic_name = None

def init_mic():
    global sd, mic_name
    try:
        import sounddevice as sdv
        sd = sdv
        want = os.environ.get("PTT_MIC", "").strip()
        if want:
            # numeric index or name substring
            try:
                idx = int(want)
                dev = sd.query_devices(idx)
            except ValueError:
                devs = sd.query_devices()
                match = next((d for d in devs
                              if want.lower() in d["name"].lower()
                              and d["max_input_channels"] > 0), None)
                if match is None:
                    log_status(ok=False, error=f'mic "{want}" not found')
                    return False
                dev = match
                idx = dev["index"] if isinstance(dev, dict) and "index" in dev else None
            sd.default.device = (idx, None)
        devinfo = sd.query_devices(sd.default.device[0], "input")
        mic_name = devinfo["name"]
        # verify the sample rate is supported
        try:
            sd.check_input_settings(device=sd.default.device[0], samplerate=SAMPLE_RATE, channels=1)
            rate = SAMPLE_RATE
        except Exception:
            rate = int(devinfo.get("default_samplerate", 44100))
        log_status(ok=True, mic=mic_name, mic_rate=rate,
                   joysticks=[{"index": i, "name": n} for i, n in enumerate(joy_names)])
        return rate
    except Exception as e:
        log_status(ok=False, error=f"sounddevice unavailable: {e}")
        return 0

def resolve_speaker():
    """Pick the output device for engineer voice replies (PTT_SPEAKER or default)."""
    if sd is None:
        return None
    want = os.environ.get("PTT_SPEAKER", "").strip()
    # Log all audio devices so the user can pick names
    try:
        devs = sd.query_devices()
        outs = [(i, d["name"]) for i, d in enumerate(devs) if d["max_output_channels"] > 0]
        ins = [(i, d["name"]) for i, d in enumerate(devs) if d["max_input_channels"] > 0]
        log_status(ok=True,
                   output_devices=[{"index": i, "name": n} for i, n in outs],
                   input_devices=[{"index": i, "name": n} for i, n in ins])
    except Exception:
        pass
    if not want:
        return None  # system default output
    try:
        try:
            idx = int(want)
            d = sd.query_devices(idx)
            if d["max_output_channels"] <= 0:
                raise ValueError("not an output device")
            log_status(ok=True, speaker=d["name"])
            return idx
        except ValueError:
            pass
        devs = sd.query_devices()
        for i, d in enumerate(devs):
            if want.lower() in d["name"].lower() and d["max_output_channels"] > 0:
                log_status(ok=True, speaker=d["name"])
                return i
        log_status(ok=False, error=f'speaker "{want}" not found, using default output')
    except Exception as e:
        log_status(ok=False, error=f"speaker resolve failed: {e}")
    return None

_speak_lock = threading.Lock()

def speak_text(text, speaker_idx):
    """Render text to WAV via Windows SAPI, then play it on the chosen output."""
    if not text or sd is None:
        return
    if not _speak_lock.acquire(blocking=False):
        return  # already speaking — radio discipline, don't talk over
    try:
        import subprocess
        import tempfile
        short = text[:600]
        b64 = base64.b64encode(short.encode("utf-16-le")).decode("ascii")
        tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        tmp_path = tmp.name
        tmp.close()
        ps = (
            "$t=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('"+b64+"'));"
            "Add-Type -AssemblyName System.Speech;"
            "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "$s.Rate=1;"
            "$s.SetOutputToWaveFile('"+tmp_path.replace("'", "''")+"');"
            "$s.Speak($t)|Out-Null;$s.Dispose()"
        )
        subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                       capture_output=True, timeout=30)
        # Play the WAV on the selected output device
        with wave.open(tmp_path, "rb") as w:
            rate = w.getframerate()
            nch = w.getnchannels()
            sampw = w.getsampwidth()
            raw = w.readframes(w.getnframes())
        import numpy as np
        dtype = {1: np.int8, 2: np.int16, 4: np.int32}[sampw]
        audio = np.frombuffer(raw, dtype=dtype)
        if nch > 1:
            audio = audio.reshape(-1, nch)
        sd.play(audio, samplerate=rate, device=speaker_idx)
        sd.wait()
    except Exception as e:
        log_status(ok=False, error=f"speak failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        _speak_lock.release()

class Recorder:
    def __init__(self, rate):
        self.rate = rate
        self.frames = []
        self.stream = None
        self.start_t = 0

    def start(self):
        self.frames = []
        self.start_t = time.time()
        self.stream = sd.InputStream(samplerate=self.rate, channels=1,
                                    dtype="int16",
                                    callback=lambda indata, n, t, s: self.frames.append(indata.copy()))
        self.stream.start()
        log_event({"type": "ptt_listening", "active": True})

    def stop(self):
        try:
            if self.stream:
                self.stream.stop()
                self.stream.close()
        except Exception:
            pass
        self.stream = None
        log_event({"type": "ptt_listening", "active": False})
        if not self.frames:
            return None
        import numpy as np
        audio = np.concatenate(self.frames, axis=0)
        dur = len(audio) / self.rate
        if dur < MIN_SECONDS:
            return None
        # cap length
        max_n = int(MAX_SECONDS * self.rate)
        audio = audio[:max_n]
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.rate)
            w.writeframes(audio.tobytes())
        return base64.b64encode(buf.getvalue()).decode("ascii")

# ------------------------------------------------------------------ main ---
def main():
    mapped = set()
    learning = False
    learn_deadline = 0
    last_reenum = 0

    if not init_joysticks():
        log_status(ok=False, error="no joystick support; PTT disabled")
        # stay alive for stdin commands anyway
    mic_rate = init_mic()
    speaker_idx = resolve_speaker()
    recorder = None
    recording = False
    rec_mapped_snapshot = set()
    monitor_state = {"active": False, "last_pressed": set()}
    map_armed = {"armed": True}  # set False on new map; requires release before trigger

    # Stdin reader thread (select() doesn't work on stdin under Windows)
    cmd_queue: "queue.Queue[str]" = queue.Queue()

    def stdin_reader():
        try:
            for line in sys.stdin:
                line = line.strip()
                if line:
                    cmd_queue.put(line)
        except Exception:
            pass

    t = threading.Thread(target=stdin_reader, daemon=True)
    t.start()

    def handle_cmd(line):
        nonlocal mapped, learning, learn_deadline
        try:
            msg = json.loads(line)
        except Exception:
            return
        cmd = msg.get("cmd")
        if cmd == "map":
            btns = msg.get("buttons") or []
            mapped = set(str(b) for b in btns)
            # Require all mapped buttons to be released once before arming —
            # prevents immediate trigger if the learn-press is still held.
            map_armed["armed"] = False
            log_status(ok=True, mapped=sorted(mapped))
        elif cmd == "learn_start":
            learning = True
            learn_deadline = time.time() + 15
            log_status(ok=True, learning=True, note="press a wheel button now")
        elif cmd == "learn_stop":
            learning = False
            log_status(ok=True, learning=False)
        elif cmd == "speak":
            text = msg.get("text") or ""
            if text:
                threading.Thread(target=speak_text, args=(text, speaker_idx), daemon=True).start()
        elif cmd == "monitor_start":
            # Diagnostic: log every button press/release to the bridge console
            log_status(ok=True, monitoring=True, note="press wheel buttons — watch for ptt_button events")
            monitor_state["active"] = True
        elif cmd == "monitor_stop":
            monitor_state["active"] = False
            log_status(ok=True, monitoring=False)

    log_status(ok=True, note="ptt-bridge ready; send {\"cmd\":\"map\",...}")

    while True:
        # Drain pending stdin commands
        try:
            while True:
                handle_cmd(cmd_queue.get_nowait())
        except queue.Empty:
            pass

        now = time.time()
        # NOTE: Re-enumeration disabled — joystick indices must stay stable
        # for button mappings. Restart the bridge if devices change.
        # if now - last_reenum > 5:
        #     last_reenum = now
        #     init_joysticks()

        pressed = poll_buttons()

        # Diagnostic monitor: report every button press/release
        if monitor_state["active"]:
            last = monitor_state["last_pressed"]
            for btn in sorted(pressed - last):
                log_event({"type": "ptt_button", "button": btn, "state": "pressed"})
            for btn in sorted(last - pressed):
                log_event({"type": "ptt_button", "button": btn, "state": "released"})
            monitor_state["last_pressed"] = set(pressed)

        if learning:
            if now > learn_deadline:
                learning = False
                log_status(ok=True, learning=False, note="learn timeout — no button press detected")
            elif pressed:
                btn = sorted(pressed)[0]
                learning = False
                log_event({"type": "ptt_learned", "button": btn})
                log_status(ok=True, learning=False)
        elif mic_rate and mapped:
            hit = pressed & mapped
            # Arm only after all mapped buttons have been released once
            if not map_armed["armed"]:
                if not hit:
                    map_armed["armed"] = True
                    log_status(ok=True, note="PTT armed")
            elif hit and not recording:
                recording = True
                rec_mapped_snapshot = set(hit)
                recorder = Recorder(mic_rate)
                try:
                    recorder.start()
                except Exception as e:
                    recording = False
                    log_status(ok=False, error=f"mic start failed: {e}")
            elif recording:
                rec_dur = now - recorder.start_t
                # stop when all pressed mapped buttons released, or cap reached
                if not (pressed & rec_mapped_snapshot) or rec_dur >= MAX_SECONDS:
                    wav_b64 = recorder.stop()
                    recording = False
                    if wav_b64:
                        log_event({"type": "ptt_audio", "wav_b64": wav_b64})

        time.sleep(1.0 / POLL_HZ)

if __name__ == "__main__":
    main()
