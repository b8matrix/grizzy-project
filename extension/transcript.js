/**
 * transcript.js — Multi-Strategy YouTube Transcript Extraction
 * MINIMAL BASELINE
 *
 * Strategy 1: YouTube timedtext API (direct URL)
 * Strategy 3: Backend API using youtube-transcript-api
 * Strategy 4: STT Backend Whisper + yt-dlp
 */

const TRANSCRIPT_TIMEOUT_MS = 15000;
const TRANSCRIPT_RETRIES = 1;

function getVideoId() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('v');
  } catch (_) {
    return null;
  }
}

async function extractTranscript(videoId) {
  if (!videoId) return getFallbackTranscript();

  const cacheKey = `transcript_${videoId}`;
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey] && cached[cacheKey].length > 0) {
      return cached[cacheKey];
    }
  } catch (_) {}

  let transcript = null;

  // ── Strategy 1: YouTube timedtext API ──
  transcript = await fetchTranscriptPrimary(videoId);
  if (transcript && transcript.length > 0) {
    await cacheTranscript(cacheKey, transcript);
    return transcript;
  }

  // ── Strategy 3: Backend fallback ──
  transcript = await fetchTranscriptFallback(videoId);
  if (transcript && transcript.length > 0) {
    await cacheTranscript(cacheKey, transcript);
    return transcript;
  }

  // ── Strategy 4: STT Fallback (Whisper + yt-dlp) ──
  transcript = await fetchTranscriptSTT(videoId);
  if (transcript && transcript.length > 0) {
    await cacheTranscript(cacheKey, transcript);
    return transcript;
  }

  // ── ALL FAILED ──
  return getFallbackTranscript();
}

function getFallbackTranscript() {
  return [{ start: 0, end: 10, text: 'Transcript unavailable for this video.' }];
}

async function cacheTranscript(key, data) {
  try {
    await chrome.storage.local.set({ [key]: data });
  } catch (_) {}
}

// ─── Strategy 1: YouTube Timedtext API ──────────────────────

async function fetchTranscriptPrimary(videoId) {
  try {
    const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`;
    const listResp = await fetchWithRetry(listUrl, TRANSCRIPT_RETRIES, TRANSCRIPT_TIMEOUT_MS);
    if (!listResp.ok) return null;

    const listXml = await listResp.text();
    const tracks = parseTrackListXML(listXml);

    if (!tracks || tracks.length === 0) return null;

    const track =
      tracks.find(t => t.langCode === 'en' && !t.kind) ||
      tracks.find(t => t.langCode === 'en') ||
      tracks.find(t => t.langCode?.startsWith('en')) ||
      tracks[0];

    if (!track) return null;

    let fetchUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.langCode}`;
    if (track.kind) fetchUrl += `&kind=${track.kind}`;
    if (track.name) fetchUrl += `&name=${encodeURIComponent(track.name)}`;

    const transcriptResp = await fetchWithRetry(fetchUrl, TRANSCRIPT_RETRIES, TRANSCRIPT_TIMEOUT_MS);
    if (!transcriptResp.ok) return null;

    const transcriptXml = await transcriptResp.text();
    return parseTimedTextXML(transcriptXml);
  } catch (err) {
    return null;
  }
}

function parseTrackListXML(xmlText) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const trackEls = doc.querySelectorAll('track');
    return Array.from(trackEls).map(el => ({
      langCode: el.getAttribute('lang_code'),
      name: el.getAttribute('name') || '',
      kind: el.getAttribute('kind') || '',
      langOriginal: el.getAttribute('lang_original') || ''
    }));
  } catch (_) {
    return [];
  }
}

function parseTimedTextXML(xmlText) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const textEls = doc.querySelectorAll('text');
    return Array.from(textEls)
      .map(el => {
        const start = parseFloat(el.getAttribute('start') || '0');
        const dur = parseFloat(el.getAttribute('dur') || '0');
        const tmp = document.createElement('span');
        tmp.innerHTML = el.textContent || '';
        const text = tmp.textContent.replace(/\n/g, ' ').trim();
        return { start, duration: dur, end: start + dur, text };
      })
      .filter(e => e.text.length > 0);
  } catch (_) {
    return [];
  }
}

// ─── Strategy 3: Backend Fallback ───────────────────────────

async function fetchTranscriptFallback(videoId) {
  try {
    const resp = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Backend timeout')), 15000);
      chrome.runtime.sendMessage(
        { type: 'FETCH_TRANSCRIPT_FALLBACK', videoId },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        }
      );
    });

    if (resp && resp.success && resp.transcript) {
      return standardizeTranscript(resp.transcript);
    }
    return null;
  } catch (err) {
    return null;
  }
}

function standardizeTranscript(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      const start = item.start || 0;
      const dur = item.duration || 0;
      const text = (item.text || '').replace(/\n/g, ' ').trim();
      return { start, duration: dur, end: start + dur, text };
    })
    .filter(e => e.text.length > 0);
}

// ─── Strategy 4: STT Generation Fallback ────────────────────

async function fetchTranscriptSTT(videoId) {
  const MAX_POLLS = 60;
  const POLL_INTERVAL = 5000;

  try {
    const triggerResp = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('STT trigger timeout')), 15000);
      chrome.runtime.sendMessage(
        { type: 'STT_GENERATE_TRANSCRIPT', videoId },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        }
      );
    });

    if (!triggerResp) return null;
    if (triggerResp.status === 'completed' && triggerResp.transcript) {
      return standardizeTranscript(triggerResp.transcript);
    }
    if (triggerResp.status === 'error') return null;

    if (triggerResp.status === 'processing') {
      window.dispatchEvent(new CustomEvent('grizzy-stt-progress', {
        detail: { message: 'Generating transcript from audio (this may take a few minutes)...' }
      }));
      for (let i = 0; i < MAX_POLLS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        const pollResp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: 'STT_POLL_STATUS', videoId },
            (response) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(response);
            }
          );
        });
        if (!pollResp) continue;
        if (pollResp.status === 'completed' && pollResp.transcript) {
          return standardizeTranscript(pollResp.transcript);
        }
        if (pollResp.status === 'error') return null;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

// ─── Shared Utilities ───────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'include' });
    clearTimeout(timeoutId);
    return response;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

async function fetchWithRetry(url, retries = 1, timeoutMs = 15000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ─── Chapter Detection ──────────────────────────────────────

function detectChaptersFromDOM() {
  const markers = document.querySelectorAll('.ytp-chapter-hover-container, ytd-macro-markers-list-item-renderer');
  return markers.length > 1;
}

async function extractChapters(videoId) {
  try {
    const domChapters = extractChaptersFromDOMElements();
    if (domChapters.length >= 3) return domChapters;

    const resp = await fetchWithRetry(`https://www.youtube.com/watch?v=${videoId}`, 1, 10000);
    const html = await resp.text();
    const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (descMatch) {
      const desc = descMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const parsed = parseChaptersFromText(desc);
      if (parsed.length >= 3) return parsed;
    }
  } catch (_) {}
  return [];
}

function extractChaptersFromDOMElements() {
  const chapters = [];
  const items = document.querySelectorAll('ytd-macro-markers-list-item-renderer');
  items.forEach(item => {
    const titleEl = item.querySelector('#details h4, #details .macro-markers');
    const timeEl = item.querySelector('#time, .timestamp');
    if (titleEl && timeEl) {
      const seconds = parseTimestamp(timeEl.textContent.trim());
      if (seconds !== null) chapters.push({ start: seconds, title: titleEl.textContent.trim() });
    }
  });
  if (chapters.length >= 3 && chapters[0].start === 0) {
    for (let i = 0; i < chapters.length - 1; i++) chapters[i].end = chapters[i + 1].start;
    return chapters;
  }
  return [];
}

function parseChaptersFromText(text) {
  const lines = text.split('\n');
  const chapters = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:(\d+):)?(\d+):(\d{2})\s+[-–—]?\s*(.+)/);
    if (match) {
      const h = parseInt(match[1] || '0'), m = parseInt(match[2]), s = parseInt(match[3]);
      chapters.push({ start: h * 3600 + m * 60 + s, title: match[4].trim() });
    }
  }
  if (chapters.length >= 3 && chapters[0].start === 0) {
    for (let i = 0; i < chapters.length - 1; i++) chapters[i].end = chapters[i + 1].start;
    return chapters;
  }
  return [];
}

function parseTimestamp(str) {
  const parts = str.split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

// ─── Segmentation ───────────────────────────────────────────

function mapTranscriptToChapters(transcript, chapters) {
  return chapters.map((ch, idx) => {
    const endTime = ch.end || (idx < chapters.length - 1 ? chapters[idx + 1].start : Infinity);
    const items = transcript.filter(t => t.start >= ch.start && t.start < endTime);
    return {
      title: ch.title,
      startTime: ch.start,
      endTime: endTime,
      text: items.map(t => t.text).join(' '),
      questions: null
    };
  }).filter(s => s.text.trim().length > 30);
}

function segmentByTime(transcript, intervalSeconds) {
  if (!transcript || transcript.length === 0) return [];
  const maxTime = transcript[transcript.length - 1].end || transcript[transcript.length - 1].start + 10;
  const segments = [];
  let segStart = 0;
  let segIdx = 1;
  while (segStart < maxTime) {
    const segEnd = segStart + intervalSeconds;
    const items = transcript.filter(t => t.start >= segStart && t.start < segEnd);
    const text = items.map(t => t.text).join(' ');
    if (text.trim().length > 30) {
      segments.push({
        title: `Part ${segIdx} (${Math.floor(segStart / 60)}:00 – ${Math.floor(Math.min(segEnd, maxTime) / 60)}:00)`,
        startTime: segStart, endTime: segEnd,
        text, questions: null
      });
      segIdx++;
    }
    segStart = segEnd;
  }
  return segments;
}
