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
    startTest(msg.mode);
    sendResponse({ started: true });
    return;
  }
});

// ── Core test flow ──────────────────────────────────
async function startTest(mode) {
  const videoId = getVideoId();
  if (!videoId) return;

  createQuizPanel();
  renderLoading('Extracting transcript...');

  // 1. Extract transcript
  const transcript = await extractTranscript(videoId);
  if (!transcript || transcript.length === 0) {
    renderError('No transcript available for this video. Please try a video with captions enabled.');
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
  const firstQuestions = await requestQuestions(videoId, 0, segments[0]);
  if (!firstQuestions) return; // error already rendered
  segments[0].questions = firstQuestions;

  // 4. Initialize state
  alState = {
    videoId,
    mode,
    status: 'active',
    segments,
    currentSegment: 0,
    currentQuestion: 0,
    answers: []
  };
  await saveState();
  showCurrentQuestion();
}

async function requestQuestions(videoId, segIdx, segment) {
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'GENERATE_QUESTIONS',
      data: {
        videoId,
        segmentIndex: segIdx,
        text: segment.text,
        title: segment.title
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
