"""
STT Fallback Router — /generate-transcript and /transcript-status
Handles async transcript generation for videos without captions.
Uses yt-dlp + Whisper under the hood.
"""

from fastapi import APIRouter, BackgroundTasks
from pydantic import BaseModel
import json
import traceback

from database import get_db
from services.stt_engine import generate_transcript_for_video

router = APIRouter(tags=["STT Fallback"])


# ── Request / Response Models ──

class GenerateTranscriptRequest(BaseModel):
    video_id: str
    model_size: str = "base"  # "tiny", "base", "small"


class TranscriptStatusResponse(BaseModel):
    status: str  # "processing", "completed", "error"
    transcript: list | None = None
    error: str | None = None


# ── DB helpers for STT transcript cache ──

def _init_stt_table():
    """Create the stt_transcripts table if it doesn't exist."""
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stt_transcripts (
            video_id TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'processing',
            transcript_json TEXT,
            error TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()


def _get_stt_record(video_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM stt_transcripts WHERE video_id = ?", (video_id,)
    ).fetchone()
    conn.close()
    if row:
        return dict(row)
    return None


def _set_stt_processing(video_id: str):
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO stt_transcripts (video_id, status) VALUES (?, 'processing')",
        (video_id,)
    )
    conn.commit()
    conn.close()


def _set_stt_completed(video_id: str, transcript: list):
    conn = get_db()
    conn.execute(
        "UPDATE stt_transcripts SET status = 'completed', transcript_json = ?, completed_at = CURRENT_TIMESTAMP WHERE video_id = ?",
        (json.dumps(transcript), video_id)
    )
    conn.commit()
    conn.close()


def _set_stt_error(video_id: str, error: str):
    conn = get_db()
    conn.execute(
        "UPDATE stt_transcripts SET status = 'error', error = ?, completed_at = CURRENT_TIMESTAMP WHERE video_id = ?",
        (error, video_id)
    )
    conn.commit()
    conn.close()


# ── Background task worker ──

def _run_stt_pipeline(video_id: str, model_size: str):
    """Background task that downloads audio and runs Whisper."""
    try:
        print(f"🎙️ STT Pipeline started for video: {video_id}")
        transcript = generate_transcript_for_video(video_id, model_size)

        if not transcript or len(transcript) == 0:
            _set_stt_error(video_id, "Whisper produced no output for this video.")
            return

        _set_stt_completed(video_id, transcript)
        print(f"🎙️ STT Pipeline completed for video: {video_id} ({len(transcript)} segments)")

    except Exception as e:
        error_msg = f"{type(e).__name__}: {str(e)}"
        print(f"🎙️ STT Pipeline FAILED for video: {video_id} — {error_msg}")
        traceback.print_exc()
        _set_stt_error(video_id, error_msg)


# ── Endpoints ──

@router.post("/generate-transcript")
async def generate_transcript(req: GenerateTranscriptRequest, background_tasks: BackgroundTasks):
    """
    Kick off async transcript generation for a video without captions.
    Returns immediately with status = "processing" or cached result.
    """
    _init_stt_table()

    # Check if we already have a result cached
    existing = _get_stt_record(req.video_id)

    if existing:
        if existing["status"] == "completed" and existing["transcript_json"]:
            return {
                "status": "completed",
                "transcript": json.loads(existing["transcript_json"])
            }
        elif existing["status"] == "processing":
            return {"status": "processing"}
        elif existing["status"] == "error":
            # Allow retry: reset and re-queue
            pass

    # Mark as processing and kick off background task
    _set_stt_processing(req.video_id)
    background_tasks.add_task(_run_stt_pipeline, req.video_id, req.model_size)

    return {"status": "processing"}


@router.get("/transcript-status")
async def transcript_status(videoId: str):
    """
    Poll endpoint to check if STT transcript generation is complete.
    """
    _init_stt_table()

    record = _get_stt_record(videoId)

    if not record:
        return {"status": "not_found", "error": "No transcript generation in progress for this video."}

    if record["status"] == "completed" and record["transcript_json"]:
        return {
            "status": "completed",
            "transcript": json.loads(record["transcript_json"])
        }

    if record["status"] == "error":
        return {
            "status": "error",
            "error": record.get("error", "Unknown error during transcription.")
        }

    return {"status": "processing"}
