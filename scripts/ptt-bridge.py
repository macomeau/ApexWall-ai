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
  PTT_MIC  - substring of the mic device name (or numeric index) to use.
             Defaults to the system default input device.

Requires: pip install pygame sounddevice
"""
import sys
import os
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
            pygame.joystick.init()
            try:
                pygame.event.set_allowed(None)  # we only poll; no event queue needed
            except Exception:
                pass
            pygame_ok = True
        # (Re)enumerate — handles hotplug between races
        joysticks = []
        joy_names = []
        count = pygame.joystick.get_count()
        for i in range(count):
            try:
                j = pygame.joystick.Joystick(i)
                j.init()
                joysticks.append(j)
                joy_names.append(j.get_name())
            except Exception:
                pass
        return True
    except Exception as e:
        log_status(ok=False, error=f"pygame unavailable: {e}")
        return False

def poll_buttons():
    """Return set of 'joy:btn' ids currently pressed."""
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
    except Exception:
        pass
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
    recorder = None
    recording = False
    rec_mapped_snapshot = set()

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
            log_status(ok=True, mapped=sorted(mapped))
        elif cmd == "learn_start":
            learning = True
            learn_deadline = time.time() + 15
            log_status(ok=True, learning=True)
        elif cmd == "learn_stop":
            learning = False
            log_status(ok=True, learning=False)

    log_status(ok=True, note="ptt-bridge ready; send {\"cmd\":\"map\",...}")

    while True:
        # Drain pending stdin commands
        try:
            while True:
                handle_cmd(cmd_queue.get_nowait())
        except queue.Empty:
            pass

        now = time.time()
        # Re-enumerate joysticks every 5s (hotplug)
        if now - last_reenum > 5:
            last_reenum = now
            init_joysticks()

        pressed = poll_buttons()

        if learning:
            if now > learn_deadline:
                learning = False
                log_status(ok=True, learning=False, note="learn timeout")
            elif pressed:
                btn = sorted(pressed)[0]
                learning = False
                log_event({"type": "ptt_learned", "button": btn})
                log_status(ok=True, learning=False)
        elif mic_rate and mapped:
            hit = pressed & mapped
            if hit and not recording:
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
