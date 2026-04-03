"""AI Engine — Multi-step controlled question generation pipeline.

Pipeline stages (all use the same LLM):
  Step 1: Extract key concepts from transcript
  Step 2: Generate questions ONLY from concepts
  Step 3: Self-validate and filter bad questions
  Step 4: Retry to meet exact count
"""

import os
import json
import logging
from openai import AsyncOpenAI
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("activelens.ai_engine")

# ── Configure LLM client (Groq / LLaMA) ──
client = AsyncOpenAI(
    api_key=os.getenv("GROQ_API_KEY"),
    base_url="https://api.groq.com/openai/v1"
)
model_name = "llama-3.3-70b-versatile"


import asyncio

# ═══════════════════════════════════════════════════════════════
#  LOW-LEVEL LLM CALL WITH RATE LIMITING
# ═══════════════════════════════════════════════════════════════

async def call_ai(prompt: str, temperature: float = 0.3) -> str:
    """Send a prompt to the LLM and return the text response with retry logic."""
    delay_time = 2.0
    retries = 3

    for idx in range(retries + 1):
        try:
            response = await client.chat.completions.create(
                model=model_name,
                messages=[{"role": "user", "content": prompt}],
                temperature=temperature,
                max_tokens=500,  # Strict token limit to prevent TPM overflow
            )
            # Artificial delay between successful calls to control rate
            await asyncio.sleep(2.0)
            return response.choices[0].message.content
        except Exception as e:
            # Handle rate limits
            if "429" in str(e) or getattr(e, 'status_code', None) == 429:
                if idx == retries:
                    raise
                logger.warning(f"[429] Rate limit hit. Retrying in {delay_time}s...")
                await asyncio.sleep(delay_time)
                delay_time *= 2
            else:
                if idx == retries:
                    raise
                logger.warning(f"Attempt {idx + 1} failed: {e}. Retrying in {delay_time}s...")
                await asyncio.sleep(delay_time)
                delay_time *= 2


def _clean_json_response(raw: str) -> str:
    """Strip markdown code fences from LLM response."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else cleaned[3:]
    if cleaned.endswith("```"):
        cleaned = cleaned[:-3]
    return cleaned.strip()


# ═══════════════════════════════════════════════════════════════
#  SYLLABUS TOPIC EXTRACTION (unchanged)
# ═══════════════════════════════════════════════════════════════

async def extract_topics_from_syllabus(syllabus_text: str) -> list[str]:
    """Use AI to extract structured topic list from raw syllabus text."""
    from services.pdf_parser import extract_topics_prompt

    prompt = extract_topics_prompt(syllabus_text)
    raw_response = await call_ai(prompt)
    cleaned = _clean_json_response(raw_response)

    try:
        topics = json.loads(cleaned)
        if isinstance(topics, list):
            return [str(t) for t in topics]
    except json.JSONDecodeError:
        pass

    # Fallback: split by newlines
    return [line.strip("- •").strip() for line in raw_response.strip().split("\n") if line.strip()]


# ═══════════════════════════════════════════════════════════════
#  PIPELINE STEP 1: Extract Key Concepts (Chunked & Sequential)
# ═══════════════════════════════════════════════════════════════

def chunk_transcript(transcript: str, max_length: int = 1500) -> list[str]:
    chunks = []
    current = ""
    for sentence in transcript.split("."):
        if len(current + sentence) > max_length:
            if current:
                chunks.append(current.strip())
            current = sentence + "."
        else:
            current += sentence + "."
    if current.strip():
        chunks.append(current.strip())
    return chunks

async def extract_concepts(transcript: str) -> list[str]:
    """Extract ONLY core concepts/definitions from transcript sequentially."""
    
    # Take at most the first 6 chunks of the transcript to prevent massive operations
    chunks = chunk_transcript(transcript, 1500)[:6]
    all_concepts = []

    for idx, chunk in enumerate(chunks):
        prompt = f"""You are an expert academic content analyst.

Analyze the following transcript chunk. Extract the core concepts, definitions, and important ideas being taught.

If the explanation uses examples, analogies, or pop-culture references (like movies or characters):
- DO NOT ignore them.
- Instead, abstract them and extract the underlying generalized concept.
- Convert example-based explanations into academic/technical forms.
- Example: "Tony Stark builds a suit to protect himself" -> Concept: "protective systems / engineering design / problem-solving".

If the transcript is mostly examples, infer the main topic and extract that as the concept.

TRANSCRIPT CHUNK:
\"\"\"
{chunk}
\"\"\"

Return ONLY a valid JSON array of strings (e.g. ["concept 1", "concept 2"]).
Extract 2 to 5 concepts. Concise phrases (5-20 words)."""

        try:
            raw_response = await call_ai(prompt, temperature=0.2)
            cleaned = _clean_json_response(raw_response)
            concepts = json.loads(cleaned)
            if isinstance(concepts, list):
                all_concepts.extend([str(c).strip() for c in concepts if str(c).strip()])
        except Exception as e:
            logger.warning(f"Failed to extract concepts for chunk {idx}: {e}")

        # Stop early if we have enough concepts to build a quiz
        if len(all_concepts) >= 10:
            break

    # Deduplicate and limit to 15
    unique_concepts = list(dict.fromkeys(all_concepts))
    return unique_concepts[:15]


# ═══════════════════════════════════════════════════════════════
#  PIPELINE STEP 2: Generate Questions from Concepts
# ═══════════════════════════════════════════════════════════════

async def generate_questions_from_concepts(
    concepts: list[str],
    count: int = 3,
    difficulty: str = "medium",
    syllabus_topics: list[str] | None = None,
    video_title: str | None = None,
) -> list[dict]:
    """Generate questions anchored ONLY to extracted concepts."""

    concept_list = "\n".join(f"  - {c}" for c in concepts)

    syllabus_context = ""
    if syllabus_topics:
        topics_str = "\n".join(f"  - {t}" for t in syllabus_topics)
        syllabus_context = f"""
UNIVERSITY SYLLABUS TOPICS (anchor questions to these where possible):
{topics_str}
"""

    difficulty_map = {
        "easy": "Bloom's Level: RECALL/REMEMBER. Ask factual questions about definitions and concepts.",
        "medium": "Bloom's Level: UNDERSTAND/APPLY. Ask 'why' and 'how' questions that require reasoning.",
        "hard": "Bloom's Level: ANALYZE/CREATE. Give a real-world scenario and ask the student to apply concepts.",
    }
    difficulty_instruction = difficulty_map.get(difficulty, difficulty_map["medium"])

    video_context = f'Video Title: "{video_title}"\n' if video_title else ""

    prompt = f"""You are ActiveLens, a strict but fair university examiner.

{video_context}
KEY CONCEPTS (the ONLY source material for questions):
{concept_list}

{syllabus_context}

DIFFICULTY: {difficulty_instruction}

Using ONLY the key concepts listed above, generate exactly {count} questions. If the concepts seem entirely example-based, infer the most likely general topic and generate basic conceptual questions based on that.

ABSOLUTE RULES:
- Generate generic, concept-based questions. Focus on understanding, not storytelling.
- Do NOT mention examples, analogies, characters, movies, or pop-culture references.
- Do NOT reference diagrams, images, charts, or visuals.
- Questions must be clear, specific, and directly answerable from the concept or inferred topic.
- Each question must test understanding of a DIFFERENT concept

Return ONLY valid JSON (no markdown fences) in this exact format:
{{
  "questions": [
    {{
      "id": 1,
      "type": "mcq | short_answer | coding_task",
      "question": "The question text",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correct_answer": "The correct answer",
      "explanation": "Why this is correct, referencing the concept",
      "syllabus_topic": "Which syllabus topic this maps to (or null)",
      "blooms_level": "recall | understand | apply | analyze"
    }}
  ],
  "transcript_summary": "A 2-sentence summary of the key concepts covered",
  "matched_syllabus_topics": ["List of syllabus topics matched"]
}}

Rules:
- For "easy": use MCQs.
- For "medium": mix of MCQ and short_answer.
- For "hard": at least one coding_task or scenario-based question.
- "options" should be null for short_answer and coding_task types.
- Make questions specific to the concepts, not generic."""

    raw_response = await call_ai(prompt, temperature=0.7)
    cleaned = _clean_json_response(raw_response)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        raise ValueError(f"Failed to parse question generation response as JSON")


# ═══════════════════════════════════════════════════════════════
#  PIPELINE STEP 3: Self-Validation
# ═══════════════════════════════════════════════════════════════

async def validate_questions(assessment: dict, concepts: list[str]) -> dict:
    """Ask the same LLM to review and filter out bad questions."""

    if not assessment.get("questions"):
        return assessment

    concept_list = "\n".join(f"  - {c}" for c in concepts)
    questions_json = json.dumps(assessment["questions"], indent=2)

    prompt = f"""You are a strict academic quality reviewer.

Review the following quiz questions and REMOVE any that fail quality checks.

KEY CONCEPTS (the ONLY valid source material):
{concept_list}

QUESTIONS TO REVIEW:
{questions_json}

REMOVE a question if it:
- Directly references examples, characters, movies, or pop-culture
- Is vague, unclear, or unanswerable from the concepts
- Is not concept-based (tests trivia or storytelling instead of understanding)
- References diagrams, images, charts, or visual content
- Is a duplicate or too similar to another question
- Has fewer than 7 words in the question text
- Tests trivial or surface-level knowledge (e.g., "What was mentioned in the lecture?")

Return ONLY the questions that PASS all checks, in the same JSON array format.
If ALL questions pass, return them all unchanged.
If NO questions pass, return an empty array: []

Return ONLY the JSON array — no markdown fences, no commentary."""

    raw_response = await call_ai(prompt, temperature=0.1)
    cleaned = _clean_json_response(raw_response)

    try:
        validated = json.loads(cleaned)
        if isinstance(validated, list):
            # Re-number IDs
            for i, q in enumerate(validated):
                q["id"] = i + 1
            assessment["questions"] = validated
    except json.JSONDecodeError:
        logger.warning("Validation response could not be parsed. Keeping original questions.")

    return assessment


# ═══════════════════════════════════════════════════════════════
#  PIPELINE ORCHESTRATOR
# ═══════════════════════════════════════════════════════════════

async def generate_assessment(
    transcript: str,
    syllabus_topics: list[str] | None,
    difficulty: str = "medium",
    video_title: str | None = None,
) -> dict:
    """Generate an assessment using the 3-step pipeline: Extract → Generate → Validate."""

    MAX_RETRIES = 2

    # ── STEP 1: Extract key concepts ──
    logger.info("Pipeline Step 1: Extracting concepts...")
    concepts = await extract_concepts(transcript)

    if not concepts:
        logger.warning("No concepts extracted. Falling back to direct generation.")
        concepts = ["General content from the video transcript"]

    logger.info(f"Pipeline Step 1 complete: {len(concepts)} concepts extracted.")

    target_count = 3  # default question count for backend assessments

    for attempt in range(MAX_RETRIES + 1):
        # ── STEP 2: Generate questions from concepts ──
        logger.info(f"Pipeline Step 2 (attempt {attempt + 1}): Generating questions...")
        try:
            result = await generate_questions_from_concepts(
                concepts=concepts,
                count=target_count,
                difficulty=difficulty,
                syllabus_topics=syllabus_topics,
                video_title=video_title,
            )
        except (ValueError, json.JSONDecodeError) as e:
            logger.warning(f"Step 2 failed: {e}")
            if attempt < MAX_RETRIES:
                continue
            # Final fallback
            return _fallback_assessment()

        # ── STEP 3: Self-validate ──
        logger.info("Pipeline Step 3: Validating questions...")
        result = await validate_questions(result, concepts)

        if result.get("questions") and len(result["questions"]) > 0:
            logger.info(
                f"Pipeline complete: {len(result['questions'])} valid questions."
            )
            return result

        logger.warning(f"All questions removed by validation (attempt {attempt + 1}).")

    return _fallback_assessment()


def _fallback_assessment() -> dict:
    """Return a safe fallback assessment when the pipeline fails."""
    return {
        "questions": [
            {
                "id": 1,
                "type": "short_answer",
                "question": "Summarize the key concepts discussed in the video segment you just watched.",
                "options": None,
                "correct_answer": "Student should reference the main topics from the transcript.",
                "explanation": "This is a fallback question generated because the AI pipeline could not produce validated questions.",
                "syllabus_topic": None,
                "blooms_level": "understand",
            }
        ],
        "transcript_summary": "Pipeline fallback — validated questions could not be generated.",
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
