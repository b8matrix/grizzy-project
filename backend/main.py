"""
Grizzy Backend — FastAPI Entry Point
=========================================
The intelligence engine that powers the Grizzy Chrome extension.

Endpoints:
  POST /syllabus/upload        — Upload a university syllabus PDF
  GET  /syllabus/{id}          — Retrieve extracted topics
  POST /assessment/generate    — Generate Two-Source RAG assessment
  POST /assessment/evaluate    — Evaluate a student's answer
  POST /transcribe/audio       — Transcribe audio (Phase 3)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import init_db
from routers import syllabus, assessment, transcribe, transcript_fetch, stt_fallback

# ── Initialize App ──
app = FastAPI(
    title="Grizzy API",
    description="Turning the entire internet into a mandatory, high-retention classroom.",
    version="1.0.0",
)

# ── CORS — Allow the Chrome extension to talk to us ──
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, restrict to chrome-extension://<id>
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Register Routers ──
app.include_router(syllabus.router)
app.include_router(assessment.router)
app.include_router(transcribe.router)
app.include_router(transcript_fetch.router)
app.include_router(stt_fallback.router)


# ── Startup Event ──
@app.on_event("startup")
def on_startup():
    """Initialize the SQLite database on server start."""
    init_db()
    print("\n🎓 Grizzy Backend is LIVE!")
    print("   Docs: http://localhost:8000/docs")
    print("   Ready to turn passive watching into active learning.\n")


# ── Health Check ──
@app.get("/", tags=["Health"])
async def root():
    return {
        "status": "active",
        "project": "Grizzy",
        "tagline": "Turning the entire internet into a mandatory, high-retention classroom.",
        "endpoints": {
            "upload_syllabus": "POST /syllabus/upload",
            "get_topics": "GET /syllabus/{syllabus_id}",
            "generate_assessment": "POST /assessment/generate",
            "evaluate_answer": "POST /assessment/evaluate",
            "transcribe_audio": "POST /transcribe/audio",
            "get_transcript": "POST /get-transcript",
            "generate_transcript_stt": "POST /generate-transcript",
            "transcript_status": "GET /transcript-status",
        },
    }
