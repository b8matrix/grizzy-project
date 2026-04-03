"""
Speech-to-Text Engine — Whisper + yt-dlp based audio transcription.
Downloads audio from YouTube and transcribes it using OpenAI Whisper.
"""

import whisper
import tempfile
import os
import subprocess
import json

# Lazy-loaded; reload if model_size changes
_whisper_model = None
_whisper_model_size: str | None = None


def _get_model(model_size: str = "base"):
    """Lazy-load the Whisper model; reload when model_size changes."""
    global _whisper_model, _whisper_model_size
    if _whisper_model is None or _whisper_model_size != model_size:
        print(f"[STT] Loading Whisper model '{model_size}'...")
        _whisper_model = whisper.load_model(model_size)
        _whisper_model_size = model_size
        print("[STT] Whisper model loaded.")
    return _whisper_model


def _check_ffmpeg() -> None:
    try:
        r = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if r.returncode != 0:
            raise RuntimeError("ffmpeg returned non-zero")
    except FileNotFoundError as e:
        raise RuntimeError(
            "ffmpeg is not on PATH. yt-dlp needs ffmpeg to extract audio. "
            "Install ffmpeg (e.g. winget install ffmpeg) and restart the terminal."
        ) from e


def download_audio(video_id: str, output_dir: str) -> str:
    """
    Download audio from a YouTube video using yt-dlp.
    Returns the path to an audio file Whisper can read (prefer .wav).
    """
    _check_ffmpeg()

    url = f"https://www.youtube.com/watch?v={video_id}"
    # yt-dlp requires %(ext)s in the output template; a bare .wav path is unreliable.
    output_template = os.path.join(output_dir, f"{video_id}.%(ext)s")

    cmd = [
        "yt-dlp",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "-o",
        output_template,
        "--force-overwrites",
        "--no-part",
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        url,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.returncode != 0:
            raise RuntimeError(f"yt-dlp failed: {result.stderr[:800]}")
    except FileNotFoundError:
        raise RuntimeError(
            "yt-dlp is not installed or not on PATH. Install: pip install yt-dlp"
        ) from None

    for name in sorted(os.listdir(output_dir)):
        path = os.path.join(output_dir, name)
        if not os.path.isfile(path):
            continue
        if name.startswith("."):
            continue
        low = name.lower()
        if low.endswith((".wav", ".webm", ".m4a", ".opus", ".mp3", ".ogg", ".flac")):
            return path

    raise RuntimeError(f"No audio file found in {output_dir} after yt-dlp")


def transcribe_audio_file(audio_path: str, model_size: str = "base") -> list[dict]:
    """
    Transcribe an audio file using Whisper.
    Returns a list of segments: [{ start, end, text }]
    """
    model = _get_model(model_size)

    result = model.transcribe(
        audio_path,
        verbose=False,
        fp16=False  # CPU-safe
    )

    transcript = []
    for segment in result.get("segments", []):
        text = segment.get("text", "").strip()
        if text:
            transcript.append({
                "start": round(segment["start"], 2),
                "end": round(segment["end"], 2),
                "text": text
            })

    return transcript


def generate_transcript_for_video(video_id: str, model_size: str = "base") -> list[dict]:
    """
    Full pipeline: download audio → transcribe → return segments.
    Cleans up temp files after completion.
    """
    temp_dir = tempfile.mkdtemp(prefix="Grizzy_stt_")

    try:
        # Step 1: Download audio
        audio_path = download_audio(video_id, temp_dir)

        # Step 2: Transcribe
        transcript = transcribe_audio_file(audio_path, model_size)

        return transcript

    finally:
        # Cleanup temp files
        try:
            for f in os.listdir(temp_dir):
                os.unlink(os.path.join(temp_dir, f))
            os.rmdir(temp_dir)
        except Exception:
            pass


async def transcribe_audio_bytes(audio_bytes: bytes) -> dict:
    """
    Backwards-compatible shim for the old transcribe router.
    Accepts raw audio bytes, writes to temp file, transcribes with Whisper.
    """
    if not audio_bytes:
        return {
            "text": "",
            "language": "en",
            "duration_seconds": 0.0,
            "error": "No audio data provided.",
        }

    temp_dir = tempfile.mkdtemp(prefix="Grizzy_raw_")
    temp_path = os.path.join(temp_dir, "audio.webm")

    try:
        with open(temp_path, "wb") as f:
            f.write(audio_bytes)

        model = _get_model("base")
        result = model.transcribe(temp_path, verbose=False, fp16=False)

        return {
            "text": result.get("text", ""),
            "language": result.get("language", "en"),
            "duration_seconds": result.get("duration", 0.0),
        }
    except Exception as e:
        return {
            "text": "",
            "language": "en",
            "duration_seconds": 0.0,
            "error": str(e),
        }
    finally:
        try:
            os.unlink(temp_path)
            os.rmdir(temp_dir)
        except Exception:
            pass

