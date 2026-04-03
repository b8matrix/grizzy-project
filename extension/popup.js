document.addEventListener('DOMContentLoaded', async () => {
  const groqKeyInput = document.getElementById('groq-key');
  const saveGroqBtn = document.getElementById('save-groq-key');
  const groqKeyStatus = document.getElementById('groq-key-status');

  chrome.storage.sync.get(['groqApiKey'], (res) => {
    if (res.groqApiKey) groqKeyInput.value = res.groqApiKey;
  });

  saveGroqBtn.addEventListener('click', () => {
    const key = groqKeyInput.value.trim();
    chrome.storage.sync.set({ groqApiKey: key }, () => {
      groqKeyStatus.textContent = key ? 'Saved.' : 'Cleared.';
      groqKeyStatus.classList.remove('hidden');
      setTimeout(() => groqKeyStatus.classList.add('hidden'), 2500);
    });
  });

  const loadingEl = document.getElementById('state-loading');
  const errorEl = document.getElementById('state-error');
  const readyEl = document.getElementById('state-ready');
  const errorMsg = document.getElementById('error-msg');
  const titleEl = document.getElementById('video-title');
  const chaptersRadio = document.getElementById('mode-chapters');
  const chaptersLabel = document.getElementById('mode-chapters-label');
  const timeRadio = document.getElementById('mode-time');
  const noChaptersMsg = document.getElementById('no-chapters-msg');
  const startBtn = document.getElementById('start-btn');

  // Query the active tab's content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
      show(errorEl, 'Navigate to a YouTube video page first.');
      loadingEl.classList.add('hidden');
      return;
    }

    const info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_VIDEO_INFO' });

    if (!info || info.error) {
      show(errorEl, info?.error || 'Could not connect to content script. Reload the YouTube page.');
      loadingEl.classList.add('hidden');
      return;
    }

    // Video detected
    titleEl.textContent = info.title;

    if (!info.hasChapters) {
      chaptersRadio.disabled = true;
      chaptersLabel.style.opacity = '0.4';
      chaptersLabel.style.pointerEvents = 'none';
      timeRadio.checked = true;
      noChaptersMsg.classList.remove('hidden');
    }

    loadingEl.classList.add('hidden');
    readyEl.classList.remove('hidden');

    // Load saved question count
    const qCountInput = document.getElementById('question-count');
    chrome.storage.local.get(['questionCount', 'quizDifficulty'], (res) => {
      if (res.questionCount) {
        qCountInput.value = res.questionCount;
      }
      const d = res.quizDifficulty === 'easy' || res.quizDifficulty === 'hard' || res.quizDifficulty === 'medium'
        ? res.quizDifficulty
        : 'medium';
      const diffInput = document.querySelector(`input[name="difficulty"][value="${d}"]`);
      if (diffInput) diffInput.checked = true;
    });

    // Start button
    startBtn.addEventListener('click', async () => {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      const difficulty = document.querySelector('input[name="difficulty"]:checked')?.value || 'medium';

      let qCount = parseInt(qCountInput.value, 10);
      if (isNaN(qCount) || qCount < 1) qCount = 1;
      if (qCount > 20) qCount = 20;

      chrome.storage.local.set({ questionCount: qCount, quizDifficulty: difficulty });

      await chrome.tabs.sendMessage(tab.id, {
        type: 'START_TEST',
        mode,
        questionCount: qCount,
        difficulty
      });
      window.close();
    });

  } catch (e) {
    show(errorEl, 'Could not connect. Reload the YouTube page and try again.');
    loadingEl.classList.add('hidden');
  }

  function show(el, msg) {
    errorMsg.textContent = msg;
    el.classList.remove('hidden');
  }
});
