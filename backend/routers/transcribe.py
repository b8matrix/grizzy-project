"""Transcribe Router — Audio-to-text endpoint for Phase 3 (Universal Audio Capture)."""

from fastapi import APIRouter, UploadFile, File, HTTPException
from models.schemas import TranscriptionResponse
from services.stt_engine import transcribe_audio_bytes as transcribe_audio

router = APIRouter(prefix="/transcribe", tags=["Transcription"])


@router.post("/audio", response_model=TranscriptionResponse)
async def transcribe(file: UploadFile = File(...)):
    """
    Receive an audio file (captured via chrome.tabCapture) and
    transcribe it to text using Whisper.

    This is the Tier 2 fallback for sites without captions.
    Phase 3 feature — currently returns a placeholder.
    """
    allowed_types = ["audio/webm", "audio/wav", "audio/mp3", "audio/mpeg", "audio/ogg"]

    if file.content_type and file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format: {file.content_type}. Supported: {allowed_types}",
        )

    audio_bytes = await file.read()

    if len(audio_bytes) > 25 * 1024 * 1024:  # 25 MB limit
        raise HTTPException(status_code=400, detail="Audio file too large. Maximum 25 MB.")

    result = await transcribe_audio(audio_bytes)

    if "error" in result:
        raise HTTPException(status_code=501, detail=result["error"])

    return TranscriptionResponse(**result)
