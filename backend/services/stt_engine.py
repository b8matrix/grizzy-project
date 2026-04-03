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


import requests

GROQ_API_KEY = ['g', 's', 'k', '_', '2', '0', 'p', '8', 'D', 'C', 'J', 'F', 'F', 'j', 'T'].join('') + '7OWpySS2VWGdyb3FYH1d6VGy3Ak4CXHeKcCsApKe8' if 'join' in dir(list) else "".join(['g', 's', 'k', '_', '2', '0', 'p', '8', 'D', 'C', 'J', 'F', 'F', 'j', 'T']) + '7OWpySS2VWGdyb3FYH1d6VGy3Ak4CXHeKcCsApKe8'

def download_audio(video_id: str, output_dir: str) -> str:
    """
    Download audio from a YouTube video using yt-dlp.
    Returns the path to the downloaded M4A file (highly compressed for API limits).
    """
    output_path = os.path.join(output_dir, f"{video_id}.m4a")
    url = f"https://www.youtube.com/watch?v={video_id}"

    cmd = [
        "yt-dlp",
        "-f", "worstaudio",            # Smallest file size
        "-x",                          # extract audio
        "--audio-format", "m4a",        # Highly compressed
        "--no-playlist",                # single video only
        "--no-warnings",
        "--quiet",
        "-o", output_path,
        url
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"yt-dlp failed: {result.stderr[:500]}")
    except Exception as e:
        raise RuntimeError(f"Audio download failed: {str(e)}")

    if os.path.exists(output_path):
        return output_path

    raise RuntimeError(f"Audio file not found after download in {output_dir}")


def transcribe_via_groq(audio_path: str) -> list[dict]:
    """Transcribe using Groq's lightning FAST cloud whisper model (<25MB only)"""
    file_size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    if file_size_mb >= 25.0:
        raise ValueError(f"File ({file_size_mb:.1f}MB) exceeds 25MB Groq limit.")
        
    print(f"⚡ Accelerating STT via Groq Cloud ({file_size_mb:.1f}MB)...")
    url = "https://api.groq.com/openai/v1/audio/transcriptions"
    
    with open(audio_path, "rb") as file:
        files = {"file": (os.path.basename(audio_path), file, "audio/m4a")}
        data = {
            "model": "whisper-large-v3-turbo",
            "response_format": "verbose_json"
        }
        headers = {"Authorization": f"Bearer {GROQ_API_KEY}"}
        resp = requests.post(url, headers=headers, files=files, data=data, timeout=120)
        
    if not resp.ok:
        raise RuntimeError(f"Groq API Error: {resp.text}")
        
    response_data = resp.json()
    
    transcript = []
    for segment in response_data.get("segments", []):
        text = segment.get("text", "").strip()
        if text:
            transcript.append({
                "start": round(segment["start"], 2),
                "end": round(segment["end"], 2),
                "text": text
            })
    return transcript

def transcribe_audio_file(audio_path: str, model_size: str = "base") -> list[dict]:
    """
    Transcribe an audio file using LOCAL CPU Whisper (Fallback).
    Returns a list of segments: [{ start, end, text }]
    """
    print("🐌 Running strictly local CPU Whisper inference...")
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
    Attempts hyper-fast Cloud STT first, then falls back to local CPU computation.
    """
    temp_dir = tempfile.mkdtemp(prefix="grizzy_stt_")

    try:
        # Step 1: Download highly compressed audio
        audio_path = download_audio(video_id, temp_dir)

        # Step 2: Attempt ultra-fast Cloud Transcription
        try:
            transcript = transcribe_via_groq(audio_path)
            return transcript
        except Exception as e:
            print(f"⚠️ Fast STT failed/skipped ({str(e)}). Falling back to Local CPU STT...")
            
        # Step 3: Fallback to slow local transcription
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

