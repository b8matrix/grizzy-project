"""Assessment Router — The RAG engine that merges Syllabus + Transcript to generate assessments."""

import hashlib
from fastapi import APIRouter, HTTPException
from models.schemas import AssessmentRequest, AssessmentResponse, EvaluateRequest, EvaluateResponse
from services.ai_engine import generate_assessment, evaluate_answer
from database import get_syllabus, get_cached_assessment, save_assessment_cache

router = APIRouter(prefix="/assessment", tags=["Assessment"])


@router.post("/generate", response_model=AssessmentResponse)
async def generate(req: AssessmentRequest):
    """
    Generate a personalized assessment by merging:
    - Source A: The student's university syllabus topics
    - Source B: The video transcript they just watched

    This is the core "Two-Source RAG" engine.
    """
    if not req.transcript or len(req.transcript.strip()) < 50:
        raise HTTPException(
            status_code=400,
            detail="Transcript too short. Need at least 50 characters of video content.",
        )

    # Fetch syllabus topics if provided
    syllabus_topics = None
    if req.syllabus_id:
        syllabus = get_syllabus(req.syllabus_id)
        if not syllabus:
            raise HTTPException(status_code=404, detail="Syllabus not found. Please re-upload.")
        syllabus_topics = syllabus["topics"]

    # Check cache first (to save API costs and time)
    transcript_hash = hashlib.md5(req.transcript.strip().encode()).hexdigest()
    cached = get_cached_assessment(transcript_hash, req.syllabus_id, req.difficulty)
    if cached:
        return AssessmentResponse(**cached)

    # Generate fresh assessment via AI
    result = await generate_assessment(
        transcript=req.transcript,
        syllabus_topics=syllabus_topics,
        difficulty=req.difficulty,
        video_title=req.video_title,
    )

    # Cache for future use
    save_assessment_cache(transcript_hash, req.syllabus_id, req.difficulty, result)

    return AssessmentResponse(**result)


@router.post("/evaluate", response_model=EvaluateResponse)
async def evaluate(req: EvaluateRequest):
    """
    Evaluate a student's answer.
    - MCQs: Simple string comparison.
    - Short answers / Coding tasks: AI-powered grading with partial credit.
    """
    result = await evaluate_answer(
        question=req.question,
        student_answer=req.student_answer,
        correct_answer=req.correct_answer,
        question_type=req.question_type,
    )

    return EvaluateResponse(**result)
