"""Syllabus Router — Handles PDF upload and topic extraction."""

import uuid
from fastapi import APIRouter, UploadFile, File, HTTPException
from models.schemas import SyllabusUploadResponse, SyllabusTopics
from services.pdf_parser import extract_text_from_pdf
from services.ai_engine import extract_topics_from_syllabus
from database import save_syllabus, get_syllabus

router = APIRouter(prefix="/syllabus", tags=["Syllabus"])


@router.post("/upload", response_model=SyllabusUploadResponse)
async def upload_syllabus(file: UploadFile = File(...)):
    """
    Upload a university syllabus PDF.
    Extracts text, uses AI to identify learning topics, and stores them.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_bytes = await file.read()

    if len(file_bytes) > 10 * 1024 * 1024:  # 10 MB limit
        raise HTTPException(status_code=400, detail="File too large. Maximum size is 10 MB.")

    # Extract raw text from PDF
    try:
        raw_text = extract_text_from_pdf(file_bytes)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Use AI to extract structured topics
    topics = await extract_topics_from_syllabus(raw_text)

    if not topics:
        raise HTTPException(status_code=422, detail="Could not extract any topics from this syllabus.")

    # Store in database
    syllabus_id = str(uuid.uuid4())[:8]
    save_syllabus(syllabus_id, file.filename, raw_text, topics)

    return SyllabusUploadResponse(
        syllabus_id=syllabus_id,
        topics=topics,
        message=f"Successfully extracted {len(topics)} topics from '{file.filename}'.",
    )


@router.get("/{syllabus_id}", response_model=SyllabusTopics)
async def get_syllabus_topics(syllabus_id: str):
    """Retrieve the extracted topics for a previously uploaded syllabus."""
    syllabus = get_syllabus(syllabus_id)

    if not syllabus:
        raise HTTPException(status_code=404, detail="Syllabus not found. Please upload again.")

    return SyllabusTopics(
        syllabus_id=syllabus["id"],
        topics=syllabus["topics"],
    )
