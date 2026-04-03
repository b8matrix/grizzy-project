"""
Speech-to-Text Engine — Whisper + yt-dlp based audio transcription.
Downloads audio from YouTube and transcribes it using OpenAI Whisper.
"""

import whisper
import tempfile
import os
import subprocess
import json

# Load model once at module level (lazy singleton)
_whisper_model = None


def _get_model(model_size: str = "base"):
    """Lazy-load the Whisper model to avoid loading on every request."""
    global _whisper_model
    if _whisper_model is None:
        print(f"🎙️ Loading Whisper model '{model_size}'...")
        _whisper_model = whisper.load_model(model_size)
        print("🎙️ Whisper model loaded.")
    return _whisper_model


def download_audio(video_id: str, output_dir: str) -> str:
    """
    Download audio from a YouTube video using yt-dlp.
    Returns the path to the downloaded WAV file.
    """
    output_path = os.path.join(output_dir, f"{video_id}.wav")
    url = f"https://www.youtube.com/watch?v={video_id}"

    cmd = [
        "yt-dlp",
        "-x",                          # extract audio
        "--audio-format", "wav",        # convert to wav
        "--audio-quality", "0",         # best quality
        "--no-playlist",                # single video only
        "--no-warnings",
        "--quiet",
        "-o", output_path,
        url
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300  # 5 min timeout for download
        )
        if result.returncode != 0:
            raise RuntimeError(f"yt-dlp failed: {result.stderr[:500]}")
    except FileNotFoundError:
        raise RuntimeError(
            "yt-dlp is not installed. Install it with: pip install yt-dlp"
        )

    # yt-dlp may add an extra extension, find the actual file
    if os.path.exists(output_path):
        return output_path

    # Check for common variants
    for ext in [".wav", ".wav.wav", ".webm", ".m4a", ".opus"]:
        candidate = os.path.join(output_dir, f"{video_id}{ext}")
        if os.path.exists(candidate):
            return candidate

    raise RuntimeError(f"Audio file not found after download in {output_dir}")


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
    temp_dir = tempfile.mkdtemp(prefix="activelens_stt_")

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

    temp_dir = tempfile.mkdtemp(prefix="activelens_raw_")
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

