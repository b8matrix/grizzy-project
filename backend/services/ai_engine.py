"""AI Engine — The core intelligence layer that talks to OpenAI for assessment generation."""

import os
import json
from openai import AsyncOpenAI
from dotenv import load_dotenv

load_dotenv()

# ── Configure OpenAI to use Groq API ──
client = AsyncOpenAI(
    api_key=os.getenv("GROQ_API_KEY"),
    base_url="https://api.groq.com/openai/v1"
)
model_name = "llama-3.3-70b-versatile"

async def call_ai(prompt: str, *, temperature: float = 0.3, max_tokens: int = 2048) -> str:
    """Send a prompt to Groq and return the text response."""
    response = await client.chat.completions.create(
        model=model_name,
        messages=[{"role": "user", "content": prompt}],
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return response.choices[0].message.content


async def score_ai_likelihood_percent(text: str) -> float:
    """Estimate 0–100: how likely the prose is machine-generated vs human-typed."""
    snippet = (text or "").strip()[:6000]
    if not snippet:
        return 0.0

    prompt = f"""Estimate whether the following prose was likely written by a machine (LLM) versus a human.
Signals for machine text: generic tone, perfectly balanced sentences, repetitive transitions, tutorial-list cadence, lack of typos.
Signals for human text: uneven rhythm, casual phrasing, small imperfections, opinionated or fragmented wording.

TEXT:
\"\"\"
{snippet}
\"\"\"

Return ONLY valid JSON, no markdown fences, one object:
{{"ai_likelihood_percent": <number from 0 to 100>}}
100 = almost certainly machine-generated; 0 = almost certainly human."""

    raw = await call_ai(prompt, temperature=0.15, max_tokens=256)
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        data = json.loads(cleaned)
        if isinstance(data, dict) and "ai_likelihood_percent" in data:
            return float(data["ai_likelihood_percent"])
    except (json.JSONDecodeError, TypeError, ValueError):
        pass
    return 0.0


async def extract_topics_from_syllabus(syllabus_text: str) -> list[str]:
    """Use AI to extract structured topic list from raw syllabus text."""
    from services.pdf_parser import extract_topics_prompt

    prompt = extract_topics_prompt(syllabus_text)
    raw_response = await call_ai(prompt)

    # Clean the response — strip markdown code fences if present
    cleaned = raw_response.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        topics = json.loads(cleaned)
        if isinstance(topics, list):
            return [str(t) for t in topics]
    except json.JSONDecodeError:
        pass

    # Fallback: split by newlines
    return [line.strip("- •").strip() for line in raw_response.strip().split("\n") if line.strip()]


async def generate_assessment(
    transcript: str,
    syllabus_topics: list[str] | None,
    difficulty: str = "medium",
    video_title: str | None = None,
) -> dict:
    """Generate an assessment by merging video transcript with syllabus topics (RAG)."""

    syllabus_context = ""
    if syllabus_topics:
        topics_str = "\n".join(f"  - {t}" for t in syllabus_topics)
        syllabus_context = f"""
UNIVERSITY SYLLABUS TOPICS (Source A — the student MUST be tested on these):
{topics_str}

CRITICAL INSTRUCTION: Your questions MUST connect the video content to these syllabus topics.
If the video discusses something NOT in the syllabus, mention it but focus questions on syllabus-relevant material.
"""

    difficulty_map = {
        "easy": "Bloom's Level: RECALL/REMEMBER. Ask factual questions about what was just said.",
        "medium": "Bloom's Level: UNDERSTAND/APPLY. Ask 'why' and 'how' questions that require reasoning.",
        "hard": "Bloom's Level: ANALYZE/CREATE. Give a real-world scenario and ask the student to apply concepts, write code, or design a solution.",
    }

    difficulty_instruction = difficulty_map.get(difficulty, difficulty_map["medium"])

    video_context = f'Video Title: "{video_title}"\n' if video_title else ""

    prompt = f"""You are Grizzy, a strict but fair university examiner.

Your job: Generate an assessment that forces the student to ACTIVELY LEARN from the video they just watched, anchored to their university syllabus.

{video_context}
VIDEO TRANSCRIPT (Source B — what the student just watched):
\"\"\"
{transcript[:6000]}
\"\"\"

{syllabus_context}

DIFFICULTY: {difficulty_instruction}

Generate exactly 3 questions. Return ONLY valid JSON (no markdown fences) in this exact format:
{{
  "questions": [
    {{
      "id": 1,
      "type": "mcq | short_answer | coding_task",
      "question": "The question text",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct_answer": "The correct answer",
      "explanation": "Why this is correct, referencing the video content",
      "syllabus_topic": "Which syllabus topic this maps to (or null)",
      "blooms_level": "recall | understand | apply | analyze"
    }}
  ],
  "transcript_summary": "A 2-sentence summary of what the video segment covered",
  "matched_syllabus_topics": ["List of syllabus topics that this video segment is relevant to"]
}}

Rules:
- For "easy": use MCQs.
- For "medium": mix of MCQ and short_answer.
- For "hard": at least one coding_task or scenario-based question.
- "options" should be null for short_answer and coding_task types.
- Make questions specific to the transcript content, not generic.
"""

    raw_response = await call_ai(prompt)

    # Clean and parse
    cleaned = raw_response.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        # Return a fallback structure
        return {
            "questions": [
                {
                    "id": 1,
                    "type": "short_answer",
                    "question": "Summarize the key concepts discussed in the video segment you just watched.",
                    "options": None,
                    "correct_answer": "Student should reference the main topics from the transcript.",
                    "explanation": "This is a fallback question generated because the AI response could not be parsed.",
                    "syllabus_topic": None,
                    "blooms_level": "understand",
                }
            ],
            "transcript_summary": "Could not parse AI response. Fallback question generated.",
            "matched_syllabus_topics": [],
        }


async def evaluate_answer(question: str, student_answer: str, correct_answer: str, question_type: str) -> dict:
    """Use AI to evaluate a student's answer, especially for open-ended and coding questions."""

    if question_type == "mcq":
        # Simple comparison for MCQs
        is_correct = student_answer.strip().lower().startswith(correct_answer.strip().lower()[:1])
        return {
            "is_correct": is_correct,
            "score": 1.0 if is_correct else 0.0,
            "feedback": "Correct! Well done." if is_correct else f"Incorrect. The correct answer was: {correct_answer}",
            "hint": None if is_correct else "Re-watch the last few minutes of the video and pay attention to the key definitions.",
        }

    # For short_answer and coding_task, use AI evaluation
    prompt = f"""You are grading a student's answer. Be encouraging but accurate.

QUESTION: {question}
EXPECTED ANSWER: {correct_answer}
STUDENT'S ANSWER: {student_answer}

Evaluate the student's response. Return ONLY valid JSON:
{{
  "is_correct": true/false,
  "score": 0.0 to 1.0 (partial credit allowed),
  "feedback": "Specific feedback about what they got right/wrong",
  "hint": "A helpful hint if they got it wrong, or null if correct"
}}
"""

    raw_response = await call_ai(prompt)

    cleaned = raw_response.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {
            "is_correct": False,
            "score": 0.0,
            "feedback": "Could not evaluate your answer automatically. Please review the correct answer.",
            "hint": f"The expected answer was: {correct_answer}",
        }
