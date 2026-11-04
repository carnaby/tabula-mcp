#!/usr/bin/env python3
"""Transcribe one WAV file with faster-whisper on an NVIDIA GPU, for `tabula worker`.

Options arrive as JSON (UTF-8) on stdin:
  {"wav": "<path>", "model": "large-v3", "language": "sk" or null, "device": "cuda",
   "compute_type": "float16", "initial_prompt": "<text>" or null, "beam_size": 5}
The result goes to stdout as JSON (ASCII-escaped):
  {"language": "sk", "duration_ms": 4200, "segments": [{"start_ms": 0, "end_ms": 1500, "text": "..."}]}
`transcribe.py --check` prints the Python, faster-whisper and CTranslate2 versions and the CUDA devices instead.

Exit codes: 0 done; 1 this recording failed; 3 the environment is unusable (no CUDA device, missing packages or
libraries): the worker then gives the job back instead of counting a failed attempt.
There is no fallback to the CPU: large-v3 is far too slow there.
"""
import glob
import json
import os
import re
import site
import sys
import time

ENVIRONMENT = 3

# Running out of GPU memory (a game is running) is a failure of the moment, not of the setup: that job is retried later.
OUT_OF_MEMORY = re.compile(r"out of memory|CUDA_ERROR_OUT_OF_MEMORY|ALLOC_FAILED", re.IGNORECASE)
# Failures of the GPU setup rather than of this recording.
LIBRARY_ERROR = re.compile(r"cublas|cudnn|cuda driver|no cuda|cuda.*(not available|unavailable)|\.dll", re.IGNORECASE)


def setup_streams():
    # Windows pipes default to a legacy code page; the worker reads UTF-8.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")


def add_cuda_dlls():
    """CTranslate2 on Windows finds cuBLAS and cuDNN of the nvidia-* wheels only when their bin folders are added."""
    if os.name != "nt":
        return
    roots = list(site.getsitepackages())
    user = site.getusersitepackages()
    if isinstance(user, str):
        roots.append(user)
    for root in roots:
        for folder in glob.glob(os.path.join(root, "nvidia", "*", "bin")):
            os.add_dll_directory(folder)
            os.environ["PATH"] = folder + os.pathsep + os.environ.get("PATH", "")


def fail(code, message):
    print(f"transcribe.py: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def exit_code_for(message):
    """1 for an ordinary failure (including out of memory), 3 when the GPU setup itself is broken."""
    if OUT_OF_MEMORY.search(message):
        return 1
    return ENVIRONMENT if LIBRARY_ERROR.search(message) else 1


def import_whisper():
    try:
        import ctranslate2
        import faster_whisper
    except Exception as e:  # ImportError, or a library that fails to load
        fail(ENVIRONMENT, f"faster-whisper does not load in this Python ({sys.executable}): {e}; run tabula worker setup")
    return ctranslate2, faster_whisper


def check():
    ctranslate2, faster_whisper = import_whisper()
    info = {"python": sys.version.split()[0], "faster_whisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__}
    try:
        info["cuda_devices"] = ctranslate2.get_cuda_device_count()
        info["compute_types"] = sorted(ctranslate2.get_supported_compute_types("cuda")) if info["cuda_devices"] else []
    except Exception as e:
        info.update(cuda_devices=0, compute_types=[], cuda_error=str(e))
    print(json.dumps(info))


def load_wav(path):
    """The plain 16 kHz mono WAV that ffmpeg made. Read with wave and numpy: PyAV inside faster-whisper 1.2.1 failed."""
    import wave

    import numpy as np

    with wave.open(path, "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            fail(1, f"expected a 16 kHz mono 16-bit WAV, got {w.getframerate()} Hz, {w.getnchannels()} channel(s), {8 * w.getsampwidth()}-bit")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(opts):
    ctranslate2, faster_whisper = import_whisper()
    device = opts.get("device") or "cuda"
    if device == "cuda" and ctranslate2.get_cuda_device_count() == 0:
        fail(ENVIRONMENT, "CUDA is not available (no NVIDIA GPU or driver found); the worker never falls back to the CPU")
    audio = load_wav(opts["wav"])
    started = time.time()
    try:
        model = faster_whisper.WhisperModel(
            opts.get("model") or "large-v3", device=device, compute_type=opts.get("compute_type") or "float16"
        )
        pieces, info = model.transcribe(
            audio,
            language=opts.get("language") or None,
            beam_size=int(opts.get("beam_size") or 5),
            vad_filter=True,
            initial_prompt=opts.get("initial_prompt") or None,
        )
        # Segments are produced lazily: the work happens while iterating.
        segments = [{"start_ms": round(s.start * 1000), "end_ms": round(s.end * 1000), "text": s.text.strip()} for s in pieces]
    except Exception as e:  # also ImportError from a lazily loaded DLL; fail() exits with SystemExit and is not caught here
        fail(exit_code_for(str(e)), f"{type(e).__name__}: {e}")
    print(f"transcribed {len(audio) / 16000:.1f} s of audio in {time.time() - started:.1f} s", file=sys.stderr, flush=True)
    return {"language": info.language, "duration_ms": round(len(audio) / 16), "segments": segments}


def main():
    setup_streams()
    add_cuda_dlls()
    if sys.argv[1:] == ["--check"]:
        check()
        return
    try:
        opts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except ValueError as e:
        fail(1, f"the options on stdin are not JSON: {e}")
    out = sys.stdout
    # Whatever a library prints must not end up in the JSON on stdout.
    sys.stdout = sys.stderr
    result = transcribe(opts)
    out.write(json.dumps(result))
    out.flush()


if __name__ == "__main__":
    main()
