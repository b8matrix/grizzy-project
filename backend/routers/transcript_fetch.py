"""Transcript Fetch Router — Backend fallback using youtube-transcript-api v1.2+."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(tags=["Transcript"])


class TranscriptRequest(BaseModel):
    video_id: str


class TranscriptSegment(BaseModel):
    text: str
    start: float
    duration: float


class TranscriptResponse(BaseModel):
    transcript: list[TranscriptSegment]
    language: str


@router.post("/get-transcript", response_model=TranscriptResponse)
async def get_transcript(req: TranscriptRequest):
    """
    Fetch transcript for a YouTube video using youtube-transcript-api.
    Strategy 3 (backend fallback) for the Chrome extension.
    """
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        raise HTTPException(
            status_code=500,
            detail="youtube-transcript-api not installed. Run: pip install youtube-transcript-api"
        )

    video_id = req.video_id.strip()
    if not video_id:
        raise HTTPException(status_code=400, detail="video_id is required")

    api = YouTubeTranscriptApi()

    # Attempt 1: Fetch English transcript
    try:
        result = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
        segments = [
            TranscriptSegment(text=s.text, start=s.start, duration=s.duration)
            for s in result.snippets
            if s.text.strip()
        ]
        return TranscriptResponse(transcript=segments, language="en")
    except Exception:
        pass

    # Attempt 2: Fetch any available transcript
    try:
        transcript_list = api.list(video_id)
        for t_info in transcript_list:
            try:
                result = api.fetch(video_id, languages=[t_info.language_code])
                segments = [
                    TranscriptSegment(text=s.text, start=s.start, duration=s.duration)
                    for s in result.snippets
                    if s.text.strip()
                ]
                return TranscriptResponse(
                    transcript=segments,
                    language=t_info.language_code
                )
            except Exception:
                continue
    except Exception as e:
        raise HTTPException(
            status_code=404,
            detail=f"No transcript available for video '{video_id}': {str(e)}"
        )

    raise HTTPException(status_code=404, detail="No transcript found")
