/**
 * background.js — ActiveLens Service Worker
 * Handles Gemini API calls, question generation, caching, and retry logic.
 */

// ┌──────────────────────────────────────────────────────────────┐
// │  GEMINI API KEY — Replace with your own key from            │
// │  https://aistudio.google.com/app/apikey                     │
// └──────────────────────────────────────────────────────────────┘
const GEMINI_API_KEY = 'AIzaSyBtG6WMs1-3UlnKKHpxoVwo-VfpWJOTugQ';
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const BACKEND_URL = 'http://localhost:8000';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_QUESTIONS') {
    const { videoId, segmentIndex, text, title } = message.data;
    getCachedOrGenerate(videoId, segmentIndex, text, title)
      .then(questions => sendResponse({ success: true, questions }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // keep channel open for async
  }

  if (message.type === 'FETCH_TRANSCRIPT_FALLBACK') {
    fetchTranscriptFromBackend(message.videoId)
      .then(transcript => sendResponse({ success: true, transcript }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function getCachedOrGenerate(videoId, segmentIndex, text, title) {
  const cacheKey = `quiz_${videoId}_seg${segmentIndex}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) return cached[cacheKey];

  const questions = await generateQuestionsWithRetry(text, title, 4);
  await chrome.storage.local.set({ [cacheKey]: questions });
  return questions;
}

async function generateQuestionsWithRetry(text, title, count, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callGemini(text, title, count);
    } catch (err) {
      lastError = err;
      console.warn(`ActiveLens: Gemini attempt ${attempt + 1} failed`, err.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw new Error('Failed to generate questions after retries: ' + lastError.message);
}

async function callGemini(transcriptText, segmentTitle, count) {
  const trimmedText = transcriptText.substring(0, 6000);

  const prompt = `You are a strict educational quiz generator. Generate questions ONLY from the provided transcript. Do NOT add any external knowledge — every question must be answerable solely from the transcript text.

SEGMENT TITLE: ${segmentTitle || 'Video Segment'}

TRANSCRIPT:
"""
${trimmedText}
"""

Generate exactly ${count} questions. Use a mix: at least 2 MCQ and at least 1 short-answer.

Return ONLY a valid JSON array (no markdown fences, no explanation):
[
  {
    "type": "mcq",
    "question": "Clear question about the transcript content",
    "options": ["A) First option", "B) Second option", "C) Third option", "D) Fourth option"],
    "correct": "A",
    "explanation": "Brief explanation referencing the transcript"
  },
  {
    "type": "short_answer",
    "question": "Question requiring a brief text answer",
    "correct": "Expected answer (1-3 sentences)",
    "explanation": "Brief explanation"
  }
]

Rules:
- Questions must be specific to the transcript content shown above
- MCQ distractors should be plausible but clearly wrong based on transcript
- Keep questions focused and educational
- "correct" for MCQ must be just the letter: "A", "B", "C", or "D"`;

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048
      }
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await response.json();

  if (!data.candidates || !data.candidates[0]?.content?.parts?.[0]?.text) {
    throw new Error('Empty response from Gemini');
  }

  const raw = data.candidates[0].content.parts[0].text;
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  try {
    const questions = JSON.parse(cleaned);
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('Parsed result is not a valid array');
    }
    return questions;
  } catch (parseErr) {
    throw new Error('Failed to parse Gemini response as JSON: ' + parseErr.message);
  }
}

// ─── Backend Transcript Fallback ────────────────────────────

async function fetchTranscriptFromBackend(videoId, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(`${BACKEND_URL}/get-transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: videoId }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Backend error ${resp.status}: ${errText.substring(0, 100)}`);
      }

      const data = await resp.json();
      return data.transcript || [];
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw new Error('Backend transcript fetch failed: ' + (lastErr?.message || 'Unknown'));
}
