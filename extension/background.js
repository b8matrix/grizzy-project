/**
 * background.js — ActiveLens Service Worker
 * Handles Gemini API calls, question generation, caching, and retry logic.
 */

// ┌──────────────────────────────────────────────────────────────┐
// │  GROQ API KEY (Free Tier)                                  │
// │  Get one here: https://console.groq.com/keys               │
// └──────────────────────────────────────────────────────────────┘
const OPENAI_API_KEY = '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';
const OPENAI_MODEL = 'llama-3.3-70b-versatile';
const OPENAI_URL = `https://api.groq.com/openai/v1/chat/completions`;

const BACKEND_URL = 'http://localhost:8000';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_QUESTIONS') {
    const { videoId, segmentIndex, text, title, seed, count } = message.data;
    getCachedOrGenerate(videoId, segmentIndex, text, title, seed, count)
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

async function getCachedOrGenerate(videoId, segmentIndex, text, title, seed, count) {
  // Add seed to cacheKey to avoid hard-caching across sessions
  const cacheKey = `quiz_${videoId}_seg${segmentIndex}_${seed}_c${count}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) return cached[cacheKey];

  const questions = await generateQuestionsWithRetry(text, title, count, seed);
  await chrome.storage.local.set({ [cacheKey]: questions });
  return questions;
}

async function generateQuestionsWithRetry(text, title, count, seed, maxRetries = 2) {
  let lastError;
  let acceptedQuestions = [];
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const remainingCount = count - acceptedQuestions.length;
      if (remainingCount <= 0) break;
      
      const q = await callOpenAI(text, title, remainingCount, seed + "_" + attempt);
      
      if (Array.isArray(q)) {
        // [MANDATORY FILTER] Remove visually-reliant or vague questions
        const invalidKeywords = ["diagram", "figure", "image", "graph", "chart", "shown above", "illustration", "picture", "what is this"];
        const validBatch = q.filter(item => {
          if (!item.question) return false;
          const qText = item.question.trim().toLowerCase();
          // Filter out short/vague
          if (qText.split(/\s+/).length < 7) return false;
          // Filter out visual words
          return !invalidKeywords.some(word => qText.includes(word));
        });
        
        acceptedQuestions.push(...validBatch);
        
        if (acceptedQuestions.length >= count) {
          return acceptedQuestions.slice(0, count);
        }
        
        throw new Error(`Insufficient valid questions: Got ${acceptedQuestions.length}, Need ${count}`);
      }
      throw new Error(`Invalid format returned, expected Array`);
    } catch (err) {
      lastError = err;
      console.warn(`ActiveLens: OpenAI attempt ${attempt + 1} failed`, err.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  
  // Return however many valid ones we got if we ran out of retries
  if (acceptedQuestions.length > 0) return acceptedQuestions.slice(0, count); 
  throw new Error('Failed to generate valid questions after retries: ' + lastError.message);
}

async function callOpenAI(transcriptText, segmentTitle, count, seed) {
  const trimmedText = transcriptText.substring(0, 6000);

  const prompt = `You are a strict educational quiz generator. ONLY generate questions based on the provided transcript text.
DO NOT refer to diagrams, images, charts, or visuals unless explicitly described in text.
If no clear concept is present, DO NOT create vague questions. Avoid generic or meaningless questions.
Each question must directly reference specific information from the transcript and be answerable using ONLY the given text.

CRITICAL INSTRUCTIONS FOR LENGTH:
- Generate EXACTLY ${count} questions.
- Do NOT generate more or fewer than ${count}.
- Return output in a strict JSON array of length ${count}.

CRITICAL RANDOMIZATION INSTRUCTIONS:
- Randomization seed: ${seed}
- Generate UNIQUE questions every time.
- Avoid repeating previously generated questions.
- Use different phrasing and structure for questions.
- Shuffle concepts and vary difficulty randomly.

SEGMENT TITLE: ${segmentTitle || 'Video Segment'}

TRANSCRIPT:
"""
${trimmedText}
"""

Use a mix: at least 2 MCQ and at least 1 short-answer (if count allows).

Return ONLY a valid JSON array (no markdown fences, no explanation):
[
  {
    "type": "mcq",
    "question": "Specific question directly tied to the transcript content",
    "options": ["A) First option", "B) Second option", "C) Third option", "D) Fourth option"],
    "correct": "A",
    "explanation": "Brief explanation referencing the transcript directly natively"
  },
  {
    "type": "short_answer",
    "question": "Question requiring a brief text answer directly verifiable from transcript",
    "correct": "Expected answer (1-3 sentences)",
    "explanation": "Brief explanation"
  }
]

Rules:
- Questions must be specific to the transcript content shown above
- MCQ distractors should be plausible but clearly wrong based on transcript
- Keep questions focused and educational
- "correct" for MCQ must be just the letter: "A", "B", "C", or "D"`;

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.85,  // increased for variation
      top_p: 0.9,         // added as requested
      max_tokens: 2048
    })
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await response.json();

  if (!data.choices || !data.choices[0]?.message?.content) {
    throw new Error('Empty response from OpenAI');
  }

  const raw = data.choices[0].message.content;
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  try {
    const questions = JSON.parse(cleaned);
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('Parsed result is not a valid array');
    }
    return questions;
  } catch (parseErr) {
    throw new Error('Failed to parse OpenAI response as JSON: ' + parseErr.message);
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
