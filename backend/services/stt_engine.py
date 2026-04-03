"""Speech-to-Text Engine — Placeholder for Whisper-based audio transcription (Phase 3)."""


async def transcribe_audio(audio_bytes: bytes) -> dict:
    """
    Transcribe audio bytes to text using OpenAI Whisper.

    This is a Phase 3 feature. For the hackathon MVP, we rely on
    YouTube transcript scraping (Tier 1) in the extension.

    To enable this:
    1. pip install openai-whisper
    2. Uncomment the whisper code below.
    """

    # ── Phase 3 Implementation ──
    # import whisper
    # import tempfile
    # import os
    #
    # # Save audio bytes to a temp file
    # with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
    #     f.write(audio_bytes)
    #     temp_path = f.name
    #
    # try:
    #     model = whisper.load_model("base")  # Use "small" for better accuracy
    #     result = model.transcribe(temp_path)
    #     return {
    #         "text": result["text"],
    #         "language": result.get("language", "en"),
    #         "duration_seconds": result.get("duration", 0.0),
    #     }
    # finally:
    #     os.unlink(temp_path)

    return {
        "text": "",
        "language": "en",
        "duration_seconds": 0.0,
        "error": "Audio transcription is not yet enabled. This is a Phase 3 feature.",
    }
