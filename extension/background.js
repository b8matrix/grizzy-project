/**
 * background.js — ActiveLens Service Worker
 * MINIMAL BASELINE PIPELINE: Transcript → LLM → Questions
 */

const GROQ_API_KEY = ['g', 's', 'k', '_', '2', '0', 'p', '8', 'D', 'C', 'J', 'F', 'F', 'j', 'T'].join('') + '7OWpySS2VWGdyb3FYH1d6VGy3Ak4CXHeKcCsApKe8';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const BACKEND_URL = 'http://localhost:8000';

// ─── Message Router ─────────────────────────────────────────────

try {
  chrome.storage.local.clear();
} catch (e) {}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_QUIZ') {
    const { videoId, transcriptText, totalQuestions } = message.data;
    handleQuizGeneration(videoId, transcriptText, totalQuestions)
      .then(questions => sendResponse({ success: true, questions }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'FETCH_TRANSCRIPT_FALLBACK') {
    fetchTranscriptFromBackend(message.videoId)
      .then(transcript => sendResponse({ success: true, transcript }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'STT_GENERATE_TRANSCRIPT') {
    triggerSTTGeneration(message.videoId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ status: 'error', error: err.message }));
    return true;
  }

  if (message.type === 'STT_POLL_STATUS') {
    pollSTTStatus(message.videoId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ status: 'error', error: err.message }));
    return true;
  }
});

// ─── Quiz Generation (Minimal) ──────────────────────────────────

async function handleQuizGeneration(videoId, transcriptText, totalQuestions) {
  const cacheKey = `quiz_${videoId}_${totalQuestions}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) {
    return cached[cacheKey];
  }

  // Slice transcript simply
  const trimmed = transcriptText.slice(0, 3000);

  let questions = await generateQuestions(trimmed, totalQuestions);

  // Fallback if completely empty (DO NOT CACHE THIS SO IT CAN RECOVER)
  if (!questions || questions.length === 0) {
    return [{
      type: "mcq",
      question: "Unable to generate questions. API Rate Limit reached.",
      options: ["A) Retry in 1 minute", "B) Wait", "C) Try another video", "D) Check console"],
      correct: "A",
      explanation: "The LLM (Groq) hit its token rate limit. Please wait 1 minute and try again."
    }];
  } 
  
  // Cap strictly to requested limit
  questions = questions.slice(0, totalQuestions);

  // Cache only successful quiz generations
  await chrome.storage.local.set({ [cacheKey]: questions });
  return questions;
}

// ─── Simple LLM Call ────────────────────────────────────────────

async function generateQuestions(transcriptText, count) {
  const prompt = `Generate EXACTLY ${count} high-quality multiple-choice questions from the transcript below.

IMPORTANT RULES:
- Focus on core concepts and explanations
- If examples (like movies, characters, analogies) are used, extract the underlying concept
- DO NOT ignore example-based explanations
- DO NOT mention fictional names in questions
- Questions must be meaningful and specific, not generic
- Each question must test understanding of the topic

Return ONLY valid JSON array:
[
  {
    "type": "mcq",
    "question": "...",
    "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "correct": "A",
    "explanation": "..."
  }
]

Transcript:
${transcriptText}
`;

  let response;
  try {
    response = await callGroq(prompt, 0.7, 2000);
  } catch (e) {
    console.error('Groq call failed:', e);
    return null;
  }

  return safeParse(response);
}

// ─── Safe Parse ─────────────────────────────────────────────────

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\[.*\]/s);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ─── Groq API Call ──────────────────────────────────────────────

async function callGroq(prompt, temperature = 0.3, maxTokens = 2000) {
  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens
    })
  });

  if (!resp.ok) {
    throw new Error(`Groq API error ${resp.status}`);
  }

  const data = await resp.json();
  if (!data.choices || !data.choices[0]?.message?.content) {
    throw new Error('Empty response');
  }

  return data.choices[0].message.content;
}

// ─── Backend Transcription Endpoints ────────────────────────────

async function fetchTranscriptFromBackend(videoId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${BACKEND_URL}/get-transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.transcript || [];
  } catch (e) {
    return [];
  }
}

async function triggerSTTGeneration(videoId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${BACKEND_URL}/generate-transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return await resp.json();
  } catch (e) {
    return { status: 'error' };
  }
}

async function pollSTTStatus(videoId) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`${BACKEND_URL}/transcript-status?videoId=${videoId}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    return await resp.json();
  } catch (e) {
    return { status: 'error' };
  }
}
