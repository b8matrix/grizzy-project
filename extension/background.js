/**
 * background.js — Grizzy Service Worker
 * Groq (Llama) for quiz generation; backend for transcripts / STT.
 * Set your Groq API key in the extension popup (stored in chrome.storage.sync).
 */

const OPENAI_MODEL = 'llama-3.3-70b-versatile';
const OPENAI_URL = `https://api.groq.com/openai/v1/chat/completions`;

const BACKEND_URL = 'http://localhost:8001';

function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if anchor is a contiguous substring of transcript (after normalize). */
function transcriptContainsAnchor(transcript, anchor) {
  const t = normalizeForMatch(transcript);
  const a = normalizeForMatch(anchor);
  if (a.length < 14) return false;
  return t.includes(a);
}

/** Fallback when anchor missing: several significant words from the question must appear in transcript. */
function questionTextuallyGrounded(questionText, transcriptText) {
  const tWords = new Set(normalizeForMatch(transcriptText).split(' ').filter((w) => w.length > 3));
  const qWords = normalizeForMatch(questionText).split(' ').filter((w) => w.length > 4);
  if (qWords.length < 2) return false;
  let hits = 0;
  for (const w of qWords) {
    if (tWords.has(w)) hits++;
  }
  const minHits = Math.max(2, Math.ceil(qWords.length * 0.35));
  return hits >= minHits;
}

const GENERIC_QUESTION_PATTERNS = [
  /\bmain (idea|point|theme|takeaway|message)\b/i,
  /\bwhy (is|are|was|were|do|does) .{0,50} important\b/i,
  /\bwhat (is|are) the (key )?(benefits|advantages|reasons)\b/i,
  /\b(in general|generally speaking|broadly)\b/i,
  /\boverall\b/i,
  /\bhow does this (relate|connect|help)\b/i,
  /\bsummarize (the )?(entire )?(video|segment|talk)\b/i,
  /\bwhat did you learn\b/i,
  /\bwhat is the (video|speaker) (about|trying)\b/i,
];

function looksGenericQuestion(qText) {
  return GENERIC_QUESTION_PATTERNS.some((re) => re.test(qText));
}

function isTextualQuestionItem(item, transcriptText) {
  if (!item || !item.question) return false;
  const q = item.question.trim();
  const words = q.split(/\s+/);
  if (words.length < 10) return false;
  if (looksGenericQuestion(q)) return false;

  const invalidKeywords = ['diagram', 'figure', 'image', 'graph', 'chart', 'shown above', 'illustration', 'picture', 'what is this'];
  const ql = q.toLowerCase();
  if (invalidKeywords.some((word) => ql.includes(word))) return false;

  if (item.transcript_anchor && transcriptContainsAnchor(transcriptText, item.transcript_anchor)) {
    return true;
  }
  return questionTextuallyGrounded(q, transcriptText);
}

async function getGroqApiKey() {
  const { groqApiKey } = await chrome.storage.sync.get(['groqApiKey']);
  return (groqApiKey && String(groqApiKey).trim()) || '';
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GENERATE_QUESTIONS') {
    const { videoId, segmentIndex, text, title, seed, count, difficulty } = message.data;
    getCachedOrGenerate(videoId, segmentIndex, text, title, seed, count, difficulty)
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

  if (message.type === 'STT_GENERATE_TRANSCRIPT') {
    triggerSTTGeneration(message.videoId, message.force)
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

  if (message.type === 'CHECK_AI_TEXT') {
    scoreStudentAnswerText(message.text)
      .then((pct) => sendResponse({ success: true, ai_likelihood_percent: pct }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

function normalizeDifficulty(d) {
  const x = String(d || 'medium').toLowerCase();
  if (x === 'easy' || x === 'hard' || x === 'medium') return x;
  return 'medium';
}

function difficultyPromptBlock(diff) {
  switch (diff) {
    case 'easy':
      return `DIFFICULTY LEVEL: EASY
- Prioritize recall: exact terminology, numbers, names, and straightforward facts stated verbatim or nearly verbatim in the transcript.
- Stems should ask what was said, which term applies, or which claim matches the audio—avoid multi-hop reasoning.
- MCQ: one option should align clearly with the transcript; wrong options should be clearly inconsistent with the text.
- Short answers: the expected answer can be a short phrase that appears in or directly mirrors the transcript.`;
    case 'hard':
      return `DIFFICULTY LEVEL: HARD
- Prioritize analysis and tight reasoning that still uses ONLY the transcript: implications, contrasts between two specific statements, limits of a claim, or multi-step "if…then" that both parts ground in the text.
- Stems must remain textual (transcript_anchor) but demand careful listening—subtle distinctions, not trivia.
- MCQ: distractors should be subtle and tempting unless the student matches fine details from the transcript.
- Short answers: require precise wording or combining two ideas from the segment; do not give away the answer in the question stem.`;
    default:
      return `DIFFICULTY LEVEL: MEDIUM
- Balance recall and understanding: "why" or "how" questions whose answers are explicit or lightly implied in the transcript.
- Compare two ideas the speaker linked, or apply a rule they stated to an example from the segment.
- MCQ: plausible wrong answers that misquote or partially invert what was said.
- Short answers: one or two sentences justified by the transcript, not single generic words.`;
  }
}

async function getCachedOrGenerate(videoId, segmentIndex, text, title, seed, count, difficulty) {
  const diff = normalizeDifficulty(difficulty);
  const cacheKey = `quiz_${videoId}_seg${segmentIndex}_${seed}_c${count}_d${diff}`;
  const cached = await chrome.storage.local.get(cacheKey);
  if (cached[cacheKey]) return cached[cacheKey];

  const questions = await generateQuestionsWithRetry(text, title, count, seed, diff);
  await chrome.storage.local.set({ [cacheKey]: questions });
  return questions;
}

async function generateQuestionsWithRetry(text, title, count, seed, difficulty, maxRetries = 2) {
  let lastError;
  let acceptedQuestions = [];
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const remainingCount = count - acceptedQuestions.length;
      if (remainingCount <= 0) break;
      
      const q = await callOpenAI(text, title, remainingCount, seed + "_" + attempt, difficulty);
      
      if (Array.isArray(q)) {
        const validBatch = q.filter((item) => isTextualQuestionItem(item, text));
        
        acceptedQuestions.push(...validBatch);
        
        if (acceptedQuestions.length >= count) {
          return acceptedQuestions.slice(0, count);
        }
        
        throw new Error(`Insufficient valid questions: Got ${acceptedQuestions.length}, Need ${count}`);
      }
      throw new Error(`Invalid format returned, expected Array`);
    } catch (err) {
      lastError = err;
      console.warn(`Grizzy: OpenAI attempt ${attempt + 1} failed`, err.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  
  // Return however many valid ones we got if we ran out of retries
  if (acceptedQuestions.length > 0) return acceptedQuestions.slice(0, count); 
  throw new Error('Failed to generate valid questions after retries: ' + lastError.message);
}

async function fetchTranscriptAiScore(text) {
  const t = (text || '').trim();
  if (t.length < 80) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(`${BACKEND_URL}/integrity/ai-score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t.slice(0, 8000) }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (typeof data.ai_likelihood_percent === 'number') return data.ai_likelihood_percent;
  } catch (e) {
    console.warn('Grizzy: transcript AI score unavailable', e);
  }
  return null;
}

async function scoreStudentAnswerText(text) {
  const t = (text || '').trim();
  if (t.length < 20) return 0;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const resp = await fetch(`${BACKEND_URL}/integrity/ai-score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: t.slice(0, 12000) }),
    signal: controller.signal
  });
  clearTimeout(timeoutId);
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(errText.substring(0, 200) || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return typeof data.ai_likelihood_percent === 'number' ? data.ai_likelihood_percent : 0;
}

async function callOpenAI(transcriptText, segmentTitle, count, seed, difficulty) {
  const apiKey = await getGroqApiKey();
  if (!apiKey) {
    throw new Error(
      'Groq API key not set. Open the Grizzy popup and paste your key under Settings (https://console.groq.com/keys).'
    );
  }

  const diff = normalizeDifficulty(difficulty);
  const diffBlock = difficultyPromptBlock(diff);
  const tempByDiff = { easy: 0.62, medium: 0.68, hard: 0.74 };
  const topPByDiff = { easy: 0.85, medium: 0.88, hard: 0.9 };
  const temperature = tempByDiff[diff] ?? 0.68;
  const top_p = topPByDiff[diff] ?? 0.88;

  const trimmedText = transcriptText.substring(0, 6000);

  let integrityNote = '';
  const transcriptAiPct = await fetchTranscriptAiScore(trimmedText);
  if (transcriptAiPct != null && transcriptAiPct > 40) {
    integrityNote = `
INTEGRITY NOTE (for Groq): This transcript segment is estimated ${Math.round(transcriptAiPct)}% likely to be machine-generated or synthetic (threshold: 40%).
Still base every question strictly on the words below, but do not assume a human student wrote the source; prefer questions that test recall of stated facts.
`;
  }

  const prompt = `You write quiz questions that are TEXTUAL and transcript-specific: every question must lock onto exact wording, terms, examples, numbers, contrasts, or steps that appear in the TRANSCRIPT below.

FORBIDDEN (reject these patterns):
- Generic prompts that could apply to almost any video (e.g. "main idea", "why is X important", "key benefits", "what is this about", "summarize the video").
- Questions that do not name or paraphrase something concrete the speaker said.
- Vague "in general" or "overall" questions.

REQUIRED (every question):
- Ground the stem in a specific claim, term, example, number, or comparison from the transcript.
- Include a "transcript_anchor" field: copy a SHORT contiguous phrase (12–40 words) taken VERBATIM from the TRANSCRIPT block below (same words, same order). This proves the question is about this text.
- The question stem should be at least 10 words and must reference something only a listener of THIS segment would know.
- MCQ: three wrong options must contradict or misapply the transcript in specific ways; avoid filler distractors.
- Explanations must cite what the transcript says (paraphrase OK).

Do NOT refer to diagrams, images, charts, or visuals unless explicitly described in text.

CRITICAL LENGTH:
- Generate EXACTLY ${count} questions.
- Return a JSON array of length ${count} only.

VARIATION (seed ${seed}):
- Cover different sentences/ideas from the segment; vary question style (definition, contrast, consequence, "what did they say about…", "according to the speaker…").

${diffBlock}

SEGMENT TITLE: ${segmentTitle || 'Video Segment'}
${integrityNote}
TRANSCRIPT:
"""
${trimmedText}
"""

If ${count} >= 3: include at least 2 "mcq" and at least 1 "short_answer". If ${count} is 1 or 2, use mcq and/or short_answer as appropriate.

Return ONLY valid JSON array (no markdown, no commentary):
[
  {
    "type": "mcq",
    "transcript_anchor": "exact quote 12-40 words copied from TRANSCRIPT above",
    "question": "At least 10 words; must hinge on vocabulary or claims from this segment only",
    "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "correct": "A",
    "explanation": "One sentence tying the answer to the transcript"
  },
  {
    "type": "short_answer",
    "transcript_anchor": "exact quote 12-40 words copied from TRANSCRIPT above",
    "question": "At least 10 words; answer must be checkable against the transcript",
    "correct": "Expected answer using transcript wording",
    "explanation": "Brief explanation referencing the transcript"
  }
]

Rules:
- "transcript_anchor" MUST be a verbatim copy from the TRANSCRIPT block (substring).
- "correct" for MCQ is only the letter A, B, C, or D.`;

  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      top_p,
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

// ─── STT Fallback Pipeline ─────────────────────────────────

async function triggerSTTGeneration(videoId, force = false) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  const resp = await fetch(`${BACKEND_URL}/generate-transcript`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: videoId, force: !!force }),
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`STT trigger failed ${resp.status}: ${errText.substring(0, 200)}`);
  }

  return await resp.json();
}

async function pollSTTStatus(videoId) {
  const resp = await fetch(`${BACKEND_URL}/transcript-status?videoId=${videoId}`);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`STT poll failed ${resp.status}: ${errText.substring(0, 200)}`);
  }

  return await resp.json();
}
