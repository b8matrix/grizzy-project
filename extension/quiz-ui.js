/**
 * quiz-ui.js — Floating Quiz Panel (Shadow DOM isolated)
 * Creates and manages the right-side quiz overlay on YouTube.
 */

let _panelHost = null;
let _shadow = null;

let _globalKeyBlocker = null;

function createQuizPanel() {
  removeQuizPanel();

  _panelHost = document.createElement('div');
  _panelHost.id = 'Grizzy-panel-host';
  
  // Full-Screen Click Blocker Layer (Pure CSS Approach)
  _panelHost.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483647;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.75);
  `;
  
  // Lock the YouTube background interaction
  document.body.style.overflow = "hidden";
  document.body.style.pointerEvents = "none";

  _shadow = _panelHost.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  _shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.id = 'al-panel';
  wrapper.className = 'al-panel';
  _shadow.appendChild(wrapper);

  document.body.appendChild(_panelHost);
  
  // [ISSUE 1 FIX]: Keyboard Leak Prevention
  _globalKeyBlocker = (e) => {
    if (!_panelHost) return;
    
    const isInsidePanel = e.composedPath().includes(_panelHost);
    const blockedKeys = [" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "k", "j", "l", "m", "f", "c", "Escape"];

    if (isInsidePanel) {
      // If typing inside the extension, stop YouTube from catching it
      e.stopPropagation();
      // NO preventDefault() so input fields still work normally
    } else if (blockedKeys.includes(e.key)) {
      // Hard block YouTube shortcuts if user randomly clicked away
      e.preventDefault();
      e.stopPropagation();
    }
  };
  
  document.addEventListener("keydown", _globalKeyBlocker, true);
  document.addEventListener("keyup", _globalKeyBlocker, true);
  
  return _shadow;
}

function removeQuizPanel() {
  if (_panelHost && _panelHost.parentNode) {
    _panelHost.parentNode.removeChild(_panelHost);
  }
  
  if (_globalKeyBlocker) {
    document.removeEventListener("keydown", _globalKeyBlocker, true);
    document.removeEventListener("keyup", _globalKeyBlocker, true);
    _globalKeyBlocker = null;
  }
  
  // Restore YouTube background interaction
  document.body.style.overflow = "";
  document.body.style.pointerEvents = "";

  _panelHost = null;
  _shadow = null;
}

function getPanelRoot() {
  if (!_shadow) return null;
  return _shadow.getElementById('al-panel');
}

function renderLoading(message) {
  const panel = getPanelRoot();
  if (!panel) return;
  panel.innerHTML = `
    <div class="al-header">
      <span class="al-logo">Grizzy</span>
      <span class="al-badge">Loading</span>
    </div>
    <div class="al-body al-center">
      <div class="al-spinner"></div>
      <p class="al-loading-text">${message || 'Processing...'}</p>
    </div>
  `;
}

function renderError(message) {
  const panel = getPanelRoot();
  if (!panel) return;
  panel.innerHTML = `
    <div class="al-header">
      <span class="al-logo">Grizzy</span>
      <button class="al-close-btn" id="al-close">✕</button>
    </div>
    <div class="al-body al-center">
      <div class="al-error-icon">⚠️</div>
      <p class="al-error-text">${message}</p>
      <button class="al-btn al-btn-secondary" id="al-close2">Close</button>
    </div>
  `;
  _shadow.getElementById('al-close').onclick = removeQuizPanel;
  _shadow.getElementById('al-close2').onclick = removeQuizPanel;
}

function renderQuestion(state, onSubmit, onNext, onExit) {
  const panel = getPanelRoot();
  if (!panel) return;

  const seg = state.segments[state.currentSegment];
  const q = seg.questions[state.currentQuestion];
  const totalQ = seg.questions.length;
  const totalSeg = state.segments.length;
  const progressPct = Math.round(
    ((state.currentSegment * totalQ + state.currentQuestion) /
      (totalSeg * totalQ)) * 100
  );

  const diffRaw = state.difficulty || 'medium';
  const diffLabel = { easy: 'Easy', medium: 'Medium', hard: 'Hard' }[diffRaw] || 'Medium';

  let inputHTML = '';
  if (q.type === 'mcq' && q.options) {
    inputHTML = q.options.map((opt, i) => {
      const letter = opt.charAt(0);
      return `<label class="al-option">
        <input type="radio" name="al-answer" value="${letter}">
        <span>${opt}</span>
      </label>`;
    }).join('');
  } else {
    inputHTML = `<textarea class="al-textarea" id="al-answer-text"
      placeholder="Type your answer here (pasting is disabled)..." rows="3" spellcheck="true"></textarea>`;
  }

  const integrityRow =
    q.type === 'mcq'
      ? ''
      : `<div class="al-integrity al-hidden" id="al-integrity-msg" role="status"></div>`;

  panel.innerHTML = `
    <div class="al-header">
      <div class="al-header-left">
        <span class="al-logo">Grizzy</span>
        <span class="al-diff-badge">${diffLabel}</span>
      </div>
      <button class="al-close-btn" id="al-exit-x">✕</button>
    </div>
    <div class="al-progress-bar">
      <div class="al-progress-fill" style="width:${progressPct}%"></div>
    </div>
    <div class="al-meta">
      <span>Segment ${state.currentSegment + 1} / ${totalSeg}</span>
      <span>Q ${state.currentQuestion + 1} / ${totalQ}</span>
    </div>
    <div class="al-segment-title">${seg.title}</div>
    <div class="al-body">
      <p class="al-question-text">${q.question}</p>
      <div class="al-options-area">${inputHTML}</div>
      ${integrityRow}
      <div class="al-feedback al-hidden" id="al-feedback"></div>
      <button class="al-btn al-btn-primary" id="al-submit">Submit Answer</button>
      <button class="al-btn al-btn-success al-hidden" id="al-next">Next →</button>
    </div>
    <div class="al-footer">
      <button class="al-btn al-btn-ghost" id="al-exit">Exit Test</button>
    </div>
  `;

  const ta = _shadow.getElementById('al-answer-text');
  if (ta) {
    const blockPaste = (e) => {
      e.preventDefault();
      const msg = _shadow.getElementById('al-integrity-msg');
      if (msg) {
        msg.textContent = 'Pasting is disabled. Type your answer in your own words.';
        msg.classList.remove('al-hidden');
      }
    };
    ta.addEventListener('paste', blockPaste);
    ta.addEventListener('drop', blockPaste);
  }

  // Bind events
  _shadow.getElementById('al-submit').addEventListener('click', async () => {
    const submitBtn = _shadow.getElementById('al-submit');
    const intMsg = _shadow.getElementById('al-integrity-msg');
    if (intMsg) {
      intMsg.classList.add('al-hidden');
      intMsg.textContent = '';
    }

    let answer = '';
    if (q.type === 'mcq') {
      const checked = _shadow.querySelector('input[name="al-answer"]:checked');
      if (!checked) return;
      answer = checked.value;
      onSubmit(answer, q);
      return;
    }

    answer = (ta?.value || '').trim();
    if (!answer) return;

    submitBtn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CHECK_AI_TEXT', text: answer });
      if (!res.success) {
        if (intMsg) {
          intMsg.textContent =
            res.error ||
            'Could not verify your answer. Start the Grizzy backend (localhost) and try again.';
          intMsg.classList.remove('al-hidden');
        }
        return;
      }
      if (typeof res.ai_likelihood_percent === 'number' && res.ai_likelihood_percent > 40) {
        if (intMsg) {
          intMsg.textContent =
            'This answer looks machine-generated (over 40% AI-likelihood). Type your own explanation without using AI.';
          intMsg.classList.remove('al-hidden');
        }
        return;
      }
      onSubmit(answer, q);
    } finally {
      submitBtn.disabled = false;
    }
  });

  _shadow.getElementById('al-next').addEventListener('click', onNext);
  _shadow.getElementById('al-exit').addEventListener('click', onExit);
  _shadow.getElementById('al-exit-x').addEventListener('click', onExit);
}

function showFeedback(isCorrect, explanation, correctAnswer) {
  if (!_shadow) return;

  const fb = _shadow.getElementById('al-feedback');
  const submitBtn = _shadow.getElementById('al-submit');
  const nextBtn = _shadow.getElementById('al-next');

  if (!fb) return;

  fb.className = isCorrect ? 'al-feedback al-correct' : 'al-feedback al-wrong';
  fb.innerHTML = isCorrect
    ? `<strong>✓ Correct!</strong><br>${explanation}`
    : `<strong>✗ Incorrect.</strong><br>${explanation}<br><br><em>Correct answer: ${correctAnswer}</em>`;

  submitBtn.classList.add('al-hidden');
  nextBtn.classList.remove('al-hidden');

  // Disable inputs
  _shadow.querySelectorAll('input[name="al-answer"]').forEach(r => r.disabled = true);
  const ta = _shadow.getElementById('al-answer-text');
  if (ta) ta.disabled = true;
}

function renderComplete(state, onExit) {
  const panel = getPanelRoot();
  if (!panel) return;

  const total = state.answers.length;
  const correct = state.answers.filter(a => a.isCorrect).length;
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

  panel.innerHTML = `
    <div class="al-header">
      <span class="al-logo">Grizzy</span>
    </div>
    <div class="al-progress-bar">
      <div class="al-progress-fill" style="width:100%"></div>
    </div>
    <div class="al-body al-center">
      <div class="al-complete-icon">🎉</div>
      <h2 class="al-complete-title">Test Complete!</h2>
      <div class="al-score-ring">
        <span class="al-score-number">${pct}%</span>
      </div>
      <p class="al-score-detail">${correct} / ${total} correct</p>
      <button class="al-btn al-btn-primary" id="al-done">Close</button>
    </div>
  `;

  _shadow.getElementById('al-done').addEventListener('click', onExit);
}

/* ──────────────────────────────────────────── */
/* Inline CSS for Shadow DOM isolation          */
/* ──────────────────────────────────────────── */
const PANEL_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .al-panel {
    position: absolute; top: 100px; right: 20px;
    width: 380px; max-height: calc(100vh - 120px);
    pointer-events: auto;
    background: #0f0f0f; color: #e8e8e8;
    border: 1px solid #2a2a2a; border-radius: 12px;
    font-family: 'Segoe UI', 'Inter', Arial, sans-serif;
    font-size: 14px; z-index: 2147483646;
    display: flex; flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    overflow: hidden;
    animation: alSlideIn 0.3s ease-out;
  }
  @keyframes alSlideIn {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  .al-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 14px 16px; border-bottom: 1px solid #2a2a2a;
    background: #161616;
  }
  .al-header-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .al-logo { font-weight: 800; font-size: 16px; color: #4A90E2; }
  .al-diff-badge {
    font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
    padding: 3px 8px; border-radius: 4px; background: #2a2a2a; color: #aaa; border: 1px solid #3a3a3a;
  }
  .al-badge {
    font-size: 11px; padding: 3px 8px; border-radius: 4px;
    background: #4A90E2; color: white; font-weight: 600;
  }
  .al-close-btn {
    background: none; border: none; color: #888; font-size: 18px;
    cursor: pointer; padding: 4px;
  }
  .al-close-btn:hover { color: #fff; }
  .al-progress-bar {
    height: 3px; background: #222; width: 100%;
  }
  .al-progress-fill {
    height: 100%; background: linear-gradient(90deg, #4A90E2, #7B61FF);
    transition: width 0.4s ease;
  }
  .al-meta {
    display: flex; justify-content: space-between;
    padding: 8px 16px; font-size: 11px; color: #888;
  }
  .al-segment-title {
    padding: 0 16px 10px; font-weight: 600; font-size: 13px;
    color: #aaa; border-bottom: 1px solid #1e1e1e;
  }
  .al-body {
    padding: 16px; overflow-y: auto; flex: 1;
  }
  .al-center { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .al-question-text {
    font-size: 15px; line-height: 1.5; margin-bottom: 16px;
    color: #fff; font-weight: 500;
  }
  .al-options-area { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .al-option {
    display: flex; align-items: flex-start; gap: 10px;
    background: #1a1a1a; padding: 12px; border-radius: 8px;
    border: 1px solid #333; cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
  }
  .al-option:hover { border-color: #4A90E2; background: #1e1e2e; }
  .al-option input { margin-top: 3px; accent-color: #4A90E2; }
  .al-option span { flex: 1; line-height: 1.4; }
  .al-textarea {
    width: 100%; background: #1a1a1a; color: #e8e8e8;
    border: 1px solid #333; border-radius: 8px;
    padding: 12px; font-size: 13px; font-family: inherit;
    resize: vertical; margin-bottom: 16px;
  }
  .al-textarea:focus { outline: none; border-color: #4A90E2; }
  .al-integrity {
    color: #e74c3c; font-size: 12px; line-height: 1.4; margin-bottom: 8px; padding: 8px 10px;
    border-radius: 6px; background: rgba(231,76,60,0.08); border: 1px solid rgba(231,76,60,0.25);
  }
  .al-feedback {
    padding: 12px; border-radius: 8px; margin-bottom: 14px;
    font-size: 13px; line-height: 1.5;
  }
  .al-correct { background: rgba(46,204,113,0.1); border: 1px solid rgba(46,204,113,0.3); color: #2ecc71; }
  .al-wrong { background: rgba(231,76,60,0.1); border: 1px solid rgba(231,76,60,0.3); color: #e74c3c; }
  .al-hidden { display: none !important; }
  .al-btn {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    font-size: 14px; font-weight: 600; cursor: pointer;
    transition: opacity 0.2s;
  }
  .al-btn:hover { opacity: 0.85; }
  .al-btn-primary { background: #4A90E2; color: #fff; }
  .al-btn-success { background: #2ecc71; color: #fff; }
  .al-btn-secondary { background: #333; color: #e8e8e8; }
  .al-btn-ghost { background: transparent; color: #888; border: 1px solid #333; }
  .al-footer { padding: 10px 16px; border-top: 1px solid #2a2a2a; }
  .al-spinner {
    width: 36px; height: 36px; border: 3px solid #222;
    border-top-color: #4A90E2; border-radius: 50%;
    animation: alSpin 0.8s linear infinite; margin-bottom: 14px;
  }
  @keyframes alSpin { to { transform: rotate(360deg); } }
  .al-loading-text { color: #888; font-size: 13px; }
  .al-error-icon { font-size: 40px; margin-bottom: 10px; }
  .al-error-text { color: #e74c3c; margin-bottom: 16px; line-height: 1.5; }
  .al-complete-icon { font-size: 48px; margin-bottom: 12px; }
  .al-complete-title { font-size: 20px; font-weight: 700; color: #fff; margin-bottom: 16px; }
  .al-score-ring {
    width: 90px; height: 90px; border-radius: 50%;
    border: 4px solid #4A90E2; display: flex;
    align-items: center; justify-content: center; margin-bottom: 8px;
  }
  .al-score-number { font-size: 26px; font-weight: 800; color: #4A90E2; }
  .al-score-detail { color: #aaa; margin-bottom: 20px; }
`;
