/**
 * content.js — ActiveLens Main Orchestrator
 * Coordinates transcript extraction, quiz generation, and UI rendering.
 * Loaded after transcript.js and quiz-ui.js.
 */

let alState = null;

// ── Initialization ──────────────────────────────────
function initActiveLens() {
  const videoId = getVideoId();
  if (!videoId) return;
  console.log('🎓 ActiveLens: Ready on video', videoId);
  tryResumeState(videoId);
}

// Re-init on YouTube SPA navigation
document.addEventListener('yt-navigate-finish', () => {
  alState = null;
  removeQuizPanel();
  initActiveLens();
});

// First load
if (getVideoId()) initActiveLens();

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
    startTest(msg.mode, msg.questionCount || 5);
    sendResponse({ started: true });
    return;
  }
});

// ── Core test flow ──────────────────────────────────
async function startTest(mode, questionCount) {
  const videoId = getVideoId();
  if (!videoId) return;

  createQuizPanel();
  renderLoading('Extracting transcript...');

  // Listen for STT progress updates from transcript.js
  const sttProgressHandler = (e) => {
    if (e.detail && e.detail.message) {
      renderLoading(e.detail.message);
    }
  };
  window.addEventListener('activelens-stt-progress', sttProgressHandler);

  // 1. Extract transcript
  const transcript = await extractTranscript(videoId);
  
  // Cleanup STT listener
  window.removeEventListener('activelens-stt-progress', sttProgressHandler);
  
  if (!transcript || transcript.length === 0) {
    renderError('Unable to generate transcript for this video. No captions available and audio transcription failed.');
    return;
  }

  // 2. Simplify Transcript Usage (No segmentation logic for now)
  const transcriptText = transcript
    .map(t => t.text)
    .join(" ")
    .slice(0, 3000);

  const segments = [{
    title: "Full Video",
    startTime: 0,
    endTime: 999999,
    text: transcriptText,
    questions: null
  }];

  // 3. Generate ALL questions at once from the full transcript
  const totalQuestions = questionCount;
  const sessionSeed = Math.random().toString(36).substring(7);

  renderLoading('Generating questions...');
  const allQuestions = await requestFullQuiz(videoId, transcriptText, totalQuestions);
  if (!allQuestions) return; // error already rendered

  // 4. Distribute questions evenly across segments
  distributeQuestions(allQuestions, segments, questionCount);

  // 5. Initialize state
  alState = {
    videoId,
    mode,
    questionCount,
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

/**
 * Sends a single GENERATE_QUIZ message and returns all questions.
 */
async function requestFullQuiz(videoId, transcriptText, totalQuestions) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GENERATE_QUIZ',
      data: {
        videoId,
        transcriptText,
        totalQuestions
      }
    });
    if (resp.success) return resp.questions;
    renderError('AI generation failed: ' + (resp.error || 'Unknown error.'));
    return null;
  } catch (e) {
    renderError('Could not connect to background service: ' + e.message);
    return null;
  }
}

/**
 * Distributes questions evenly across segments.
 * Each segment receives `perSegment` questions from the pool.
 */
function distributeQuestions(allQuestions, segments, perSegment) {
  let idx = 0;
  for (const seg of segments) {
    seg.questions = allQuestions.slice(idx, idx + perSegment);
    idx += perSegment;
  }
  // If there are leftover questions (from rounding), give them to the last segment
  if (idx < allQuestions.length) {
    segments[segments.length - 1].questions.push(...allQuestions.slice(idx));
  }
  // Safety: ensure every segment has at least one question
  for (const seg of segments) {
    if (!seg.questions || seg.questions.length === 0) {
      seg.questions = [allQuestions[0]]; // fallback
    }
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

  // Move to next segment (questions already loaded)
  if (alState.currentSegment + 1 < alState.segments.length) {
    alState.currentSegment++;
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
  await chrome.storage.local.set({ activelens_state: alState });
}

async function clearState() {
  alState = null;
  await chrome.storage.local.remove('activelens_state');
}

async function tryResumeState(videoId) {
  const data = await chrome.storage.local.get('activelens_state');
  const saved = data.activelens_state;
  if (saved && saved.videoId === videoId && saved.status === 'active') {
    alState = saved;
    createQuizPanel();
    showCurrentQuestion();
  }
}
