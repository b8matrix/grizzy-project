/**
 * content.js — Grizzy Main Orchestrator
 * Coordinates transcript extraction, quiz generation, and UI rendering.
 * Loaded after transcript.js and quiz-ui.js.
 */

let alState = null;

// ── Initialization ──────────────────────────────────
function initGrizzy() {
  const videoId = getVideoId();
  if (!videoId) return;
  console.log('🎓 Grizzy: Ready on video', videoId);
  tryResumeState(videoId);
}

// Re-init on YouTube SPA navigation
document.addEventListener('yt-navigate-finish', () => {
  alState = null;
  removeQuizPanel();
  initGrizzy();
});

// First load
if (getVideoId()) initGrizzy();

// ── Message handler (from popup) ────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_VIDEO_INFO') {
    const videoId = getVideoId();
    if (!videoId) {
      sendResponse({ error: 'Not on a YouTube video page.' });
      return;
    }
    sendResponse({
      videoId,
      title: document.title.replace(' - YouTube', ''),
      hasChapters: detectChaptersFromDOM()
    });
    return;
  }

  if (msg.type === 'START_TEST') {
    startTest(msg.mode, msg.questionCount || 5, msg.difficulty);
    sendResponse({ started: true });
    return;
  }
});

function normalizeDifficulty(d) {
  const x = String(d || 'medium').toLowerCase();
  if (x === 'easy' || x === 'hard' || x === 'medium') return x;
  return 'medium';
}

// ── Core test flow ──────────────────────────────────
async function startTest(mode, questionCount, difficulty) {
  const videoId = getVideoId();
  if (!videoId) return;
  const quizDifficulty = normalizeDifficulty(difficulty);

  createQuizPanel();
  renderLoading('Extracting transcript...');

  // Listen for STT progress updates from transcript.js
  const sttProgressHandler = (e) => {
    if (e.detail && e.detail.message) {
      renderLoading(e.detail.message);
    }
  };
  window.addEventListener('Grizzy-stt-progress', sttProgressHandler);

  // 1. Extract transcript (includes Strategy 4 STT fallback automatically)
  const transcript = await extractTranscript(videoId);
  
  // Cleanup STT listener
  window.removeEventListener('Grizzy-stt-progress', sttProgressHandler);
  
  if (!transcript || transcript.length === 0) {
    renderError(
      'No transcript available for this video. Captions were not found, and audio transcription (Whisper) did not return text. ' +
        'Run the Grizzy backend on this PC (same port as in the extension), install ffmpeg and yt-dlp on the server, ' +
        'set GROQ_API_KEY in backend/.env, then reload this page and try again. Long videos may take several minutes to transcribe.'
    );
    return;
  }

  // 2. Segment transcript
  let segments;
  if (mode === 'chapters') {
    renderLoading('Detecting chapters...');
    const chapters = await extractChapters(videoId);
    if (!chapters || chapters.length < 3) {
      renderError('No chapters found. Please use "10-minute interval" mode instead.');
      return;
    }
    segments = mapTranscriptToChapters(transcript, chapters);
  } else {
    segments = segmentByTime(transcript, 600);
  }

  if (segments.length === 0) {
    renderError('Video too short to generate meaningful segments.');
    return;
  }

  // 3. Generate questions for first segment
  renderLoading('Generating questions with AI...');
  const sessionSeed = Math.random().toString(36).substring(7);
  const firstQuestions = await requestQuestions(
    videoId,
    0,
    segments[0],
    sessionSeed,
    questionCount,
    quizDifficulty
  );
  if (!firstQuestions) return; // error already rendered
  segments[0].questions = firstQuestions;

  // 4. Initialize state
  alState = {
    videoId,
    mode,
    questionCount,
    difficulty: quizDifficulty,
    status: 'active',
    sessionSeed,
    segments,
    currentSegment: 0,
    currentQuestion: 0,
    answers: []
  };
  await saveState();
  showCurrentQuestion();
}

const seenQuestions = new Set();
function deduplicateQuestions(newQuestions) {
  const unique = [];
  for (const q of newQuestions) {
    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    const qNorm = normalize(q.question);
    
    // Check similarity against seen questions
    let isDuplicate = false;
    for (const seen of seenQuestions) {
      if (seen === qNorm) {
        isDuplicate = true; break;
      }
      // Simple Jaccard similarity for 70%+ overlap
      const setA = new Set(qNorm.match(/.{1,3}/g) || []);
      const setB = new Set(seen.match(/.{1,3}/g) || []);
      const intersection = [...setA].filter(x => setB.has(x)).length;
      const union = new Set([...setA, ...setB]).size;
      if (union > 0 && intersection / union > 0.7) {
        isDuplicate = true; break;
      }
    }
    
    if (!isDuplicate) {
      seenQuestions.add(qNorm);
      unique.push(q);
    }
  }
  // If all were dupes, fallback to returning at least one to not break the UI
  return unique.length > 0 ? unique : newQuestions.slice(0, 1);
}

async function requestQuestions(videoId, segIdx, segment, seed = null, count = 5, difficultyOverride) {
  try {
    const currentSeed = seed || (alState ? alState.sessionSeed : Math.random().toString(36).substring(7));
    const currentCount = alState ? alState.questionCount : count;

    const diff =
      difficultyOverride !== undefined && difficultyOverride !== null
        ? normalizeDifficulty(difficultyOverride)
        : alState
          ? normalizeDifficulty(alState.difficulty)
          : 'medium';

    const resp = await chrome.runtime.sendMessage({
      type: 'GENERATE_QUESTIONS',
      data: {
        videoId,
        segmentIndex: segIdx,
        text: segment.text,
        title: segment.title,
        seed: currentSeed,
        count: currentCount,
        difficulty: diff
      }
    });
    if (resp.success) return deduplicateQuestions(resp.questions);
    renderError('AI generation failed: ' + (resp.error || 'Unknown error.'));
    return null;
  } catch (e) {
    renderError('Could not connect to background service: ' + e.message);
    return null;
  }
}

// ── Question rendering ──────────────────────────────
function showCurrentQuestion() {
  if (!alState) return;
  renderQuestion(alState, handleSubmit, handleNext, handleExit);
}

function handleSubmit(answer, question) {
  let isCorrect = false;

  if (question.type === 'mcq') {
    isCorrect = answer.toUpperCase() === (question.correct || '').toUpperCase();
  } else {
    // For short answer, use simple keyword overlap check
    const studentWords = new Set(answer.toLowerCase().split(/\s+/));
    const correctWords = (question.correct || '').toLowerCase().split(/\s+/);
    const importantWords = correctWords.filter(w => w.length > 3);
    const matchCount = importantWords.filter(w => studentWords.has(w)).length;
    isCorrect = importantWords.length > 0 && (matchCount / importantWords.length) >= 0.4;
  }

  alState.answers.push({
    segmentIdx: alState.currentSegment,
    questionIdx: alState.currentQuestion,
    userAnswer: answer,
    isCorrect
  });

  showFeedback(isCorrect, question.explanation || '', question.correct || '');
  saveState();
}

async function handleNext() {
  if (!alState) return;

  const seg = alState.segments[alState.currentSegment];

  if (alState.currentQuestion + 1 < seg.questions.length) {
    // Next question in same segment
    alState.currentQuestion++;
    showCurrentQuestion();
    await saveState();
    return;
  }

  // Move to next segment
  if (alState.currentSegment + 1 < alState.segments.length) {
    const nextSegIdx = alState.currentSegment + 1;
    const nextSeg = alState.segments[nextSegIdx];

    if (!nextSeg.questions) {
      renderLoading(`Generating questions for: ${nextSeg.title}...`);
      const q = await requestQuestions(alState.videoId, nextSegIdx, nextSeg);
      if (!q) return;
      nextSeg.questions = q;
    }

    alState.currentSegment = nextSegIdx;
    alState.currentQuestion = 0;
    showCurrentQuestion();
    await saveState();
    return;
  }

  // All segments done
  alState.status = 'completed';
  renderComplete(alState, handleExit);
  await saveState();
}

function handleExit() {
  clearState();
  removeQuizPanel();
}

// ── State persistence ───────────────────────────────
async function saveState() {
  if (!alState) return;
  await chrome.storage.local.set({ Grizzy_state: alState });
}

async function clearState() {
  alState = null;
  await chrome.storage.local.remove('Grizzy_state');
}

async function tryResumeState(videoId) {
  const data = await chrome.storage.local.get('Grizzy_state');
  const saved = data.Grizzy_state;
  if (saved && saved.videoId === videoId && saved.status === 'active') {
    alState = saved;
    createQuizPanel();
    showCurrentQuestion();
  }
}
