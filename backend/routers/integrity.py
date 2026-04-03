"""AI-likelihood scoring for transcript and student answers (Groq)."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.ai_engine import score_ai_likelihood_percent

router = APIRouter(prefix="/integrity", tags=["Integrity"])


class AiScoreRequest(BaseModel):
    text: str = Field(..., max_length=12000)


class AiScoreResponse(BaseModel):
    ai_likelihood_percent: float


@router.post("/ai-score", response_model=AiScoreResponse)
async def ai_score(body: AiScoreRequest):
    """Return 0–100 estimate of how likely the text is machine-generated."""
    if not body.text.strip():
        return AiScoreResponse(ai_likelihood_percent=0.0)
    try:
        pct = await score_ai_likelihood_percent(body.text)
        pct = max(0.0, min(100.0, float(pct)))
        return AiScoreResponse(ai_likelihood_percent=pct)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
