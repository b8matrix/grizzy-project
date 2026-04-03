"""SQLite database setup for caching syllabi and assessment history."""

import sqlite3
import os
import json

DB_PATH = os.path.join(os.path.dirname(__file__), "activelens.db")


def get_db():
    """Get a database connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Initialize the database tables."""
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS syllabi (
            id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            raw_text TEXT NOT NULL,
            topics TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS assessment_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transcript_hash TEXT NOT NULL,
            syllabus_id TEXT,
            difficulty TEXT NOT NULL,
            response_json TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(transcript_hash, syllabus_id, difficulty)
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS student_progress (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            syllabus_id TEXT,
            topic TEXT NOT NULL,
            questions_attempted INTEGER DEFAULT 0,
            questions_correct INTEGER DEFAULT 0,
            last_blooms_level TEXT DEFAULT 'recall',
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    conn.close()


# ── Syllabus helpers ──

def save_syllabus(syllabus_id: str, filename: str, raw_text: str, topics: list[str]):
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO syllabi (id, filename, raw_text, topics) VALUES (?, ?, ?, ?)",
        (syllabus_id, filename, raw_text, json.dumps(topics))
    )
    conn.commit()
    conn.close()


def get_syllabus(syllabus_id: str) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM syllabi WHERE id = ?", (syllabus_id,)).fetchone()
    conn.close()
    if row:
        return {
            "id": row["id"],
            "filename": row["filename"],
            "raw_text": row["raw_text"],
            "topics": json.loads(row["topics"]),
        }
    return None


# ── Cache helpers ──

def get_cached_assessment(transcript_hash: str, syllabus_id: str | None, difficulty: str) -> dict | None:
    conn = get_db()
    row = conn.execute(
        "SELECT response_json FROM assessment_cache WHERE transcript_hash = ? AND syllabus_id IS ? AND difficulty = ?",
        (transcript_hash, syllabus_id, difficulty)
    ).fetchone()
    conn.close()
    if row:
        return json.loads(row["response_json"])
    return None


def save_assessment_cache(transcript_hash: str, syllabus_id: str | None, difficulty: str, response: dict):
    conn = get_db()
    conn.execute(
        "INSERT OR REPLACE INTO assessment_cache (transcript_hash, syllabus_id, difficulty, response_json) VALUES (?, ?, ?, ?)",
        (transcript_hash, syllabus_id, difficulty, json.dumps(response))
    )
    conn.commit()
    conn.close()
