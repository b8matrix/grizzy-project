# Grizzy 

Turn YouTube videos into interactive practice tests.

Grizzy is a **Chrome Extension (Manifest V3)** + a **FastAPI (Python) backend**:

- The **extension** runs on YouTube watch pages, extracts the transcript (with multiple fallbacks), generates questions using AI, and renders an in-page quiz UI.
- The **backend** supports transcript fallback + STT (Whisper), syllabus PDF processing, assessment endpoints, and caching via SQLite.

## Features

- Transcript extraction with a fallback chain:
  - YouTube timedtext
  - `ytInitialPlayerResponse` caption tracks
  - Backend transcript fallback (`youtube-transcript-api`)
  - STT fallback (download audio via `yt-dlp` + transcribe with Whisper)
- AI-generated quizzes (Groq OpenAI-compatible API, Llama model)
- Difficulty modes: easy / medium / hard
- Question count selection (1–20)
- Local caching:
  - Extension: `chrome.storage.local`
  - Backend: SQLite database (`backend/activelens.db`)

## Project Structure

- `extension/`
  - `manifest.json` — MV3 manifest
  - `popup.html`, `popup.js` — popup UI
  - `content.js` — main orchestrator on the YouTube page
  - `transcript.js` — transcript extraction + fallbacks
  - `quiz-ui.js` + `styles/quiz.css` — quiz overlay UI
  - `background.js` — service worker (AI calls + caching + backend calls)

- `backend/`
  - `main.py` — FastAPI app entry point
  - `routers/` — API routes (assessment, syllabus, transcript, STT, integrity)
  - `services/` — AI engine, PDF parsing, STT engine
  - `database.py` — SQLite helpers

## Requirements

### Accounts / Keys

- **Groq API Key** (required for quiz generation)
  - Set it inside the extension popup UI, or
  - Set `GROQ_API_KEY` in `backend/.env` for backend AI endpoints.

### Local tools (for STT fallback only)

STT fallback requires:

- `yt-dlp`
- `ffmpeg` available on PATH

If you only use videos that already have captions, you can run without STT.

## Setup (Backend)

1. Create a virtual environment (recommended).
2. Install dependencies:

```bash
pip install -r backend/requirements.txt
```

3. Create `backend/.env`:

```env
GROQ_API_KEY=your_groq_api_key_here
```

4. Run the API server (port must match the extension config):

```bash
uvicorn main:app --reload --port 8001
```

Open docs:

- `http://localhost:8001/docs`

## Setup (Chrome Extension)

1. Open Chrome and go to:

- `chrome://extensions`

2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` folder.

## How to Use

1. Start the backend (recommended; required for transcript/STT fallbacks).
2. Open any YouTube video.
3. Click the **Grizzy** extension icon.
4. Choose:
   - Mode (Chapters or 10-minute intervals)
   - Difficulty
   - Question count
5. Click **Start Test**.

## Notes

- The extension expects the backend at `http://localhost:8001` (see `extension/background.js`).
- In production you should restrict CORS and host permissions (currently permissive for local development).

## Contributors

- Bhagirath
- Tanay Sagar
- Aditya Nair
