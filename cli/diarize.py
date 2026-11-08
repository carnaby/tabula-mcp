#!/usr/bin/env python3
"""Recognize who speaks when in one WAV file with pyannote on an NVIDIA GPU, for `tabula worker`.

Options arrive as JSON (UTF-8) on stdin: {"wav": "<path>"} (the 16 kHz mono WAV ffmpeg made).
The result goes to stdout as JSON:
  {"model": "pyannote/speaker-diarization-community-1", "speakers": 2,
   "turns": [{"start_ms": 0, "end_ms": 1500, "speaker": "S1"}]}
Speakers are numbered S1, S2 ... by their first turn; turns never overlap. While it works, stderr gets
"PROGRESS <ms>" at most once a second.
`diarize.py --check` prints the versions, whether PyTorch sees CUDA, whether a Hugging Face token is there (HF_TOKEN
set, or the token file hf auth login saves; never the token itself) and whether the model is in the cache. `diarize.py --load` downloads the model (tabula worker setup
--diarize runs it once) and loads it on the GPU.

Exit codes: 0 done; 1 this recording failed; 3 the environment is unusable (no CUDA, packages that do not load);
4 the model is not available (not downloaded, its conditions not accepted, or no token).
Job runs and --check never go online: the model was downloaded by setup (whose --load stays offline too, through
HF_HUB_OFFLINE=1, once the model is in the cache). pyannote's usage metrics are turned off.
"""
import json
import os
import re
import sys
import time

# Before pyannote is imported: its usage metrics would otherwise be sent to its server.
os.environ["PYANNOTE_METRICS_ENABLED"] = "false"

MODEL = "pyannote/speaker-diarization-community-1"
ENVIRONMENT = 3
MODEL_MISSING = 4
PROGRESS_EVERY_S = 1.0

OUT_OF_MEMORY = re.compile(r"out of memory|CUDA_ERROR_OUT_OF_MEMORY|ALLOC_FAILED", re.IGNORECASE)
LIBRARY_ERROR = re.compile(r"cublas|cudnn|cuda driver|no cuda|cuda.*(not available|unavailable)|\.dll", re.IGNORECASE)


def setup_streams():
    # Windows pipes default to a legacy code page; the worker reads UTF-8.
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")


def fail(code, message):
    print(f"diarize.py: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def exit_code_for(message):
    """1 for an ordinary failure (including out of memory), 3 when the GPU setup itself is broken."""
    if OUT_OF_MEMORY.search(message):
        return 1
    return ENVIRONMENT if LIBRARY_ERROR.search(message) else 1


def import_torch():
    try:
        import torch
    except Exception as e:  # ImportError, or a library that fails to load
        fail(ENVIRONMENT, f"PyTorch does not load in this Python ({sys.executable}): {e}; run tabula worker setup --diarize")
    return torch


def token_saved():
    """Whether a token is there: HF_TOKEN is set, or the token file hf auth login writes exists. Neither is ever
    printed, and the file is never opened."""
    from huggingface_hub import constants

    return bool(os.environ.get("HF_TOKEN")) or os.path.isfile(constants.HF_TOKEN_PATH)


def model_cached():
    from huggingface_hub import try_to_load_from_cache

    return isinstance(try_to_load_from_cache(MODEL, "config.yaml"), str)


def check():
    torch = import_torch()
    info = {"python": sys.version.split()[0], "torch": torch.__version__}
    try:
        import pyannote.audio

        info["pyannote"] = pyannote.audio.__version__
    except Exception as e:
        fail(ENVIRONMENT, f"pyannote.audio does not load in this Python ({sys.executable}): {e}; run tabula worker setup --diarize")
    try:
        info["cuda"] = bool(torch.cuda.is_available())
        info["gpu"] = torch.cuda.get_device_name(0) if info["cuda"] else None
    except Exception as e:
        info.update(cuda=False, gpu=None, cuda_error=str(e))
    info["token"] = token_saved()
    info["model_cached"] = model_cached()
    return info


def pipeline_on_gpu(torch):
    if not torch.cuda.is_available():
        fail(ENVIRONMENT, "CUDA is not available to PyTorch (no NVIDIA GPU or driver, or the CPU build of PyTorch); run tabula worker setup --diarize")
    try:
        from huggingface_hub.errors import HfHubHTTPError, LocalEntryNotFoundError
        from pyannote.audio import Pipeline
    except Exception as e:
        fail(ENVIRONMENT, f"pyannote.audio does not load in this Python ({sys.executable}): {e}; run tabula worker setup --diarize")
    try:
        pipeline = Pipeline.from_pretrained(MODEL)
    except LocalEntryNotFoundError:
        fail(MODEL_MISSING, f"the model {MODEL} is not downloaded: run tabula worker setup --diarize")
    except HfHubHTTPError as e:  # GatedRepoError among them: conditions not accepted, or no (or a wrong) token
        fail(MODEL_MISSING, f"Hugging Face refused {MODEL} ({type(e).__name__}); tabula worker setup --diarize says what to do")
    if pipeline is None:
        fail(MODEL_MISSING, f"the model {MODEL} could not be loaded; tabula worker setup --diarize says what to do")
    try:
        pipeline.to(torch.device("cuda"))
    except Exception as e:
        fail(exit_code_for(str(e)), f"{type(e).__name__}: {e}")
    return pipeline


def load_wav(path):
    """The plain 16 kHz mono WAV that ffmpeg made, read with wave and numpy: PyAV fails on Python 3.14."""
    import wave

    import numpy as np

    with wave.open(path, "rb") as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, 16000):
            fail(1, f"expected a 16 kHz mono 16-bit WAV, got {w.getframerate()} Hz, {w.getnchannels()} channel(s), {8 * w.getsampwidth()}-bit")
        frames = w.readframes(w.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def numbered(tracks):
    """Turns in time order with the speakers renamed S1, S2 ... by their first turn."""
    names = {}
    turns = []
    for start, end, label in sorted(tracks, key=lambda t: (t[0], t[1])):
        if label not in names:
            names[label] = f"S{len(names) + 1}"
        turns.append({"start_ms": round(start * 1000), "end_ms": round(end * 1000), "speaker": names[label]})
    return turns


def diarize(opts):
    torch = import_torch()
    audio = load_wav(opts["wav"])
    duration_ms = round(len(audio) / 16)
    pipeline = pipeline_on_gpu(torch)
    last = [None]

    def hook(step, artifact, file=None, total=None, completed=None):
        # The speaker embeddings take most of the time and report how many batches are done.
        if step != "embeddings" or not total or completed is None:
            return
        now = time.monotonic()
        if last[0] is None or now - last[0] >= PROGRESS_EVERY_S:
            last[0] = now
            print(f"PROGRESS {round(duration_ms * completed / total)}", file=sys.stderr, flush=True)

    started = time.time()
    try:
        # In memory, not by path: pyannote's own decoding goes through PyAV.
        output = pipeline({"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": 16000}, hook=hook)
    except Exception as e:
        fail(exit_code_for(str(e)), f"{type(e).__name__}: {e}")
    # community-1 gives an exclusive diarization (no overlapping turns), the one meant for transcripts.
    annotation = getattr(output, "exclusive_speaker_diarization", None)
    if annotation is None:
        annotation = getattr(output, "speaker_diarization", output)
    turns = numbered((segment.start, segment.end, label) for segment, _, label in annotation.itertracks(yield_label=True))
    speakers = len({t["speaker"] for t in turns})
    print(f"recognized {speakers} speaker(s) in {len(audio) / 16000:.1f} s of audio in {time.time() - started:.1f} s", file=sys.stderr, flush=True)
    return {"model": MODEL, "speakers": speakers, "turns": turns}


def main():
    setup_streams()
    mode = sys.argv[1:]
    if mode not in ([], ["--check"], ["--load"]):
        fail(1, "usage: diarize.py [--check | --load] (options as JSON on stdin)")
    if mode != ["--load"]:
        # Read when huggingface_hub is imported: jobs and checks use what setup downloaded and never go online.
        os.environ["HF_HUB_OFFLINE"] = "1"
    out = sys.stdout
    # Whatever a library prints (pyannote prints its download hints) must not end up in the JSON on stdout.
    sys.stdout = sys.stderr
    if mode == ["--check"]:
        result = check()
    elif mode == ["--load"]:
        pipeline_on_gpu(import_torch())
        result = {"model": MODEL, "loaded": True}
    else:
        try:
            opts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        except ValueError as e:
            fail(1, f"the options on stdin are not JSON: {e}")
        result = diarize(opts)
    out.write(json.dumps(result))
    out.flush()


if __name__ == "__main__":
    main()
