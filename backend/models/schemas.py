"""Pydantic models for ActiveLens API request/response schemas."""

from pydantic import BaseModel, Field
from typing import Optional


# ──────────────────────────────────────────────
# Syllabus
# ──────────────────────────────────────────────
class SyllabusUploadResponse(BaseModel):
    syllabus_id: str
    topics: list[str]
    message: str


class SyllabusTopics(BaseModel):
    syllabus_id: str
    topics: list[str]


# ──────────────────────────────────────────────
# Assessment
# ──────────────────────────────────────────────
class AssessmentRequest(BaseModel):
    transcript: str = Field(..., description="Video transcript text (from YouTube captions or STT)")
    syllabus_id: Optional[str] = Field(None, description="ID of the uploaded syllabus to anchor questions to")
    difficulty: str = Field("medium", description="easy | medium | hard")
    video_title: Optional[str] = Field(None, description="Title of the video being watched")


class QuizQuestion(BaseModel):
    id: int
    type: str = Field(..., description="mcq | short_answer | coding_task")
    question: str
    options: Optional[list[str]] = None  # Only for MCQs
    correct_answer: str
    explanation: str
    syllabus_topic: Optional[str] = None  # Which syllabus topic this maps to
    blooms_level: str = Field("recall", description="recall | understand | apply | analyze")


class AssessmentResponse(BaseModel):
    questions: list[QuizQuestion]
    transcript_summary: str
    matched_syllabus_topics: list[str]


# ──────────────────────────────────────────────
# Evaluate
# ──────────────────────────────────────────────
class EvaluateRequest(BaseModel):
    question: str
    student_answer: str
    correct_answer: str
    question_type: str = Field("mcq", description="mcq | short_answer | coding_task")


class EvaluateResponse(BaseModel):
    is_correct: bool
    score: float = Field(..., description="0.0 to 1.0")
    feedback: str
    hint: Optional[str] = None


# ──────────────────────────────────────────────
# Transcription (Audio fallback)
# ──────────────────────────────────────────────
class TranscriptionResponse(BaseModel):
    text: str
    language: str
    duration_seconds: float
