"""PDF Parser Service — Extracts text from syllabus PDFs and uses AI to identify topics."""

import PyPDF2
import io


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract all text content from a PDF file."""
    reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
    text_parts = []

    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text_parts.append(page_text.strip())

    full_text = "\n\n".join(text_parts)

    if not full_text.strip():
        raise ValueError("Could not extract any text from the PDF. The file might be scanned/image-based.")

    return full_text


def extract_topics_prompt(syllabus_text: str) -> str:
    """Build the AI prompt that extracts structured topics from raw syllabus text."""
    return f"""You are an expert academic curriculum analyst.

Analyze the following university syllabus text and extract ALL distinct learning topics/concepts.

Rules:
1. Return ONLY a JSON array of strings — no markdown, no explanation.
2. Each string should be a concise topic name (3-8 words).
3. Group sub-topics under their parent where logical.
4. Preserve the order they appear in the syllabus.
5. Include unit/module numbers if present (e.g., "Unit 3: Database Normalization").
6. Aim for 10-30 topics depending on syllabus length.

SYLLABUS TEXT:
\"\"\"
{syllabus_text[:8000]}
\"\"\"

Return ONLY a valid JSON array like: ["Topic 1", "Topic 2", "Topic 3"]
"""
