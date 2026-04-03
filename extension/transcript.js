/**
 * transcript.js — Multi-Strategy YouTube Transcript Extraction
 *
 * Strategy 1 (Primary):   YouTube timedtext API (direct URL)
 * Strategy 2 (Secondary): ytInitialPlayerResponse page injection
 * Strategy 3 (Fallback):  Backend API using youtube-transcript-api
 *
 * All methods output: [{ start, end, text }]
 */

const TRANSCRIPT_TIMEOUT_MS = 5000;
const TRANSCRIPT_RETRIES = 2;

// ─── Public API ─────────────────────────────────────────────

function getVideoId() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('v');
  } catch (_) {
    return null;
  }
}

/**
 * Main entry point. Tries all 3 strategies in order with caching.
 * Returns [{ start, end, text }] or null.
 */
async function extractTranscript(videoId) {
  if (!videoId) return null;

  // ── Check cache first ──
  const cacheKey = `transcript_${videoId}`;
  try {
    const cached = await chrome.storage.local.get(cacheKey);
    if (cached[cacheKey] && cached[cacheKey].length > 0) {
      console.log('🎓 ActiveLens: Using cached transcript');
      return cached[cacheKey];
    }
  } catch (_) { /* storage may fail in rare cases */ }

  let transcript = null;

  // ── Strategy 1: YouTube timedtext API ──
  console.log('🎓 ActiveLens: Trying Strategy 1 (timedtext API)...');
  transcript = await fetchTranscriptPrimary(videoId);
  if (transcript && transcript.length > 0) {
    console.log(`🎓 ActiveLens: Strategy 1 succeeded (${transcript.length} segments)`);
    await cacheTranscript(cacheKey, transcript);
    return transcript;
  }

  // ── Strategy 2: ytInitialPlayerResponse ──
  console.log('🎓 ActiveLens: Trying Strategy 2 (page player response)...');
  transcript = await fetchTranscriptSecondary(videoId);
  if (transcript && transcript.length > 0) {
    console.log(`🎓 ActiveLens: Strategy 2 succeeded (${transcript.length} segments)`);
    await cacheTranscript(cacheKey, transcript);
    return transcript;
  }

  // ── Strategy 3: Backend fallback ──
  console.log('🎓 ActiveLens: Trying Strategy 3 (backend fallback)...');
  transcript = await fetchTranscriptFallback(videoId);
  if (transcript && transcript.length > 0) {
    console.log(`🎓 ActiveLens: Strategy 3 succeeded (${transcript.length} segments)`);
    await cacheTranscript(cacheKey, transcript);
    return transcript;
  }

  console.warn('🎓 ActiveLens: All transcript strategies failed');
  return null;
}

async function cacheTranscript(key, data) {
  try {
    await chrome.storage.local.set({ [key]: data });
  } catch (_) { /* ignore storage errors */ }
}

// ─── Strategy 1: YouTube Timedtext API ──────────────────────

async function fetchTranscriptPrimary(videoId) {
  try {
    // Step 1: Get the list of available caption tracks
    const listUrl = `https://www.youtube.com/api/timedtext?type=list&v=${videoId}`;
    const listResp = await fetchWithRetry(listUrl, TRANSCRIPT_RETRIES, TRANSCRIPT_TIMEOUT_MS);
    if (!listResp.ok) return null;

    const listXml = await listResp.text();
    const tracks = parseTrackListXML(listXml);

    if (!tracks || tracks.length === 0) return null;

    // Step 2: Pick best track (prefer English manual, then English ASR, then first)
    const track =
      tracks.find(t => t.langCode === 'en' && !t.kind) ||
      tracks.find(t => t.langCode === 'en') ||
      tracks.find(t => t.langCode?.startsWith('en')) ||
      tracks[0];

    if (!track) return null;

    // Step 3: Fetch the actual transcript
    let fetchUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${track.langCode}`;
    if (track.kind) fetchUrl += `&kind=${track.kind}`;
    if (track.name) fetchUrl += `&name=${encodeURIComponent(track.name)}`;

    const transcriptResp = await fetchWithRetry(fetchUrl, TRANSCRIPT_RETRIES, TRANSCRIPT_TIMEOUT_MS);
    if (!transcriptResp.ok) return null;

    const transcriptXml = await transcriptResp.text();
    return parseTimedTextXML(transcriptXml);

  } catch (err) {
    console.warn('Strategy 1 error:', err.message);
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
        // Decode HTML entities
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

// ─── Strategy 2: ytInitialPlayerResponse (Page Injection) ───

async function fetchTranscriptSecondary(videoId) {
  try {
    // Method A: Inject into MAIN world to access JS variables
    const captionTracks = await injectAndExtractCaptionTracks();

    // Method B: If injection failed, fetch page HTML and parse
    const tracks = captionTracks || await fetchAndParseCaptionTracks(videoId);

    if (!tracks || tracks.length === 0) return null;

    // Pick best track
    const track =
      tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr') ||
      tracks.find(t => t.languageCode === 'en') ||
      tracks.find(t => t.languageCode?.startsWith('en')) ||
      tracks[0];

    if (!track || !track.baseUrl) return null;

    // Fetch transcript using the baseUrl
    let url = track.baseUrl.replace(/\\u0026/g, '&');
    if (!url.includes('fmt=json3')) {
      url += '&fmt=json3';
    }

    const resp = await fetchWithRetry(url, TRANSCRIPT_RETRIES, TRANSCRIPT_TIMEOUT_MS);
    if (!resp.ok) return null;

    const data = await resp.json();
    return parseJSON3Transcript(data);

  } catch (err) {
    console.warn('Strategy 2 error:', err.message);
    return null;
  }
}

/**
 * Inject a script into the MAIN world to read ytInitialPlayerResponse.
 * Communicates back via window.postMessage.
 */
function injectAndExtractCaptionTracks() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);

    function handler(event) {
      if (event.data?.type === 'ACTIVELENS_CAPTION_TRACKS') {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        try {
          resolve(event.data.tracks ? JSON.parse(event.data.tracks) : null);
        } catch (_) {
          resolve(null);
        }
      }
    }
    window.addEventListener('message', handler);

    const script = document.createElement('script');
    script.textContent = `
      (function() {
        var tracks = null;
        try {
          // Try ytInitialPlayerResponse (set on initial page load)
          if (window.ytInitialPlayerResponse) {
            var ct = window.ytInitialPlayerResponse.captions;
            if (ct && ct.playerCaptionsTracklistRenderer) {
              tracks = ct.playerCaptionsTracklistRenderer.captionTracks;
            }
          }
          // Try movie_player API  (works after SPA navigations)
          if (!tracks) {
            var player = document.getElementById('movie_player');
            if (player && typeof player.getPlayerResponse === 'function') {
              var resp = player.getPlayerResponse();
              if (resp && resp.captions && resp.captions.playerCaptionsTracklistRenderer) {
                tracks = resp.captions.playerCaptionsTracklistRenderer.captionTracks;
              }
            }
          }
        } catch(e) {}
        window.postMessage({
          type: 'ACTIVELENS_CAPTION_TRACKS',
          tracks: tracks ? JSON.stringify(tracks) : null
        }, '*');
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();
  });
}

/**
 * Fetch page HTML and parse captionTracks from embedded JSON.
 */
async function fetchAndParseCaptionTracks(videoId) {
  try {
    const resp = await fetchWithRetry(
      `https://www.youtube.com/watch?v=${videoId}`,
      1,
      TRANSCRIPT_TIMEOUT_MS
    );
    if (!resp.ok) return null;
    const html = await resp.text();

    const marker = '"captionTracks":';
    const startIdx = html.indexOf(marker);
    if (startIdx === -1) return null;

    const jsonStart = startIdx + marker.length;
    let depth = 0;
    let i = jsonStart;
    for (; i < html.length && i < jsonStart + 10000; i++) {
      if (html[i] === '[') depth++;
      else if (html[i] === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return null;

    const jsonStr = html.substring(jsonStart, i + 1).replace(/\\u0026/g, '&');
    return JSON.parse(jsonStr);
  } catch (_) {
    return null;
  }
}

function parseJSON3Transcript(data) {
  if (!data || !data.events) return [];
  return data.events
    .filter(e => e.segs && e.segs.length > 0)
    .map(e => {
      const start = (e.tStartMs || 0) / 1000;
      const dur = (e.dDurationMs || 0) / 1000;
      const text = e.segs.map(s => s.utf8 || '').join('').replace(/\n/g, ' ').trim();
      return { start, duration: dur, end: start + dur, text };
    })
    .filter(e => e.text.length > 0);
}

// ─── Strategy 3: Backend Fallback ───────────────────────────

async function fetchTranscriptFallback(videoId) {
  try {
    const resp = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Backend timeout')), TRANSCRIPT_TIMEOUT_MS);
      chrome.runtime.sendMessage(
        { type: 'FETCH_TRANSCRIPT_FALLBACK', videoId },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        }
      );
    });

    if (resp && resp.success && resp.transcript) {
      return standardizeTranscript(resp.transcript);
    }
    return null;
  } catch (err) {
    console.warn('Strategy 3 error:', err.message);
    return null;
  }
}

/**
 * Standardize transcript from backend (youtube-transcript-api format)
 * into our { start, end, text } format.
 */
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

// ─── Shared Utilities ───────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      credentials: 'include'
    });
    clearTimeout(timeoutId);
    return response;
  } catch (e) {
    clearTimeout(timeoutId);
    throw e;
  }
}

async function fetchWithRetry(url, retries = 2, timeoutMs = 5000) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, timeoutMs);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

// ─── Chapter Detection (unchanged) ──────────────────────────

function detectChaptersFromDOM() {
  const markers = document.querySelectorAll(
    '.ytp-chapter-hover-container, ytd-macro-markers-list-item-renderer'
  );
  return markers.length > 1;
}

async function extractChapters(videoId) {
  try {
    const domChapters = extractChaptersFromDOMElements();
    if (domChapters.length >= 3) return domChapters;

    const resp = await fetchWithRetry(
      `https://www.youtube.com/watch?v=${videoId}`, 1, TRANSCRIPT_TIMEOUT_MS
    );
    const html = await resp.text();
    const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (descMatch) {
      const desc = descMatch[1]
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
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
      const title = titleEl.textContent.trim();
      const seconds = parseTimestamp(timeEl.textContent.trim());
      if (seconds !== null) chapters.push({ start: seconds, title });
    }
  });
  if (chapters.length >= 3 && chapters[0].start === 0) {
    for (let i = 0; i < chapters.length - 1; i++) {
      chapters[i].end = chapters[i + 1].start;
    }
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
      const h = parseInt(match[1] || '0');
      const m = parseInt(match[2]);
      const s = parseInt(match[3]);
      chapters.push({ start: h * 3600 + m * 60 + s, title: match[4].trim() });
    }
  }
  if (chapters.length >= 3 && chapters[0].start === 0) {
    for (let i = 0; i < chapters.length - 1; i++) {
      chapters[i].end = chapters[i + 1].start;
    }
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

// ─── Segmentation (unchanged) ───────────────────────────────

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
      const startMin = Math.floor(segStart / 60);
      const endMin = Math.floor(Math.min(segEnd, maxTime) / 60);
      segments.push({
        title: `Part ${segIdx} (${startMin}:00 – ${endMin}:00)`,
        startTime: segStart, endTime: segEnd,
        text, questions: null
      });
      segIdx++;
    }
    segStart = segEnd;
  }
  return segments;
}
