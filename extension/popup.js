document.addEventListener('DOMContentLoaded', async () => {
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

    // Start button
    startBtn.addEventListener('click', async () => {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      await chrome.tabs.sendMessage(tab.id, { type: 'START_TEST', mode });
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
