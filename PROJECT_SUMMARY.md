# 🌟 Grizzy: Detailed Project & Architecture Summary

## 📖 Executive Summary
Grizzy is a sophisticated, non-intrusive Chrome Extension that augments the YouTube learning experience by overlaying context-aware, multiple-choice quizzes directly onto the video player. By combining edge-computing in the browser with powerful asynchronous backend fallbacks, the system guarantees 100% video coverage. Grizzy automatically scrapes or transcribes the video payload, passes it through an ultra-fast Large Language Model (Groq LLaMA-3.3-70B), and tests the user's comprehension of the content completely dynamically.

---

## 🎯 Core Features & Flow
1. **Zero-Friction Trigger:** The user simply clicks the extension icon while watching any YouTube video.
2. **Context Aggregation:** Grizzy invisibly strips the transcript/closed captions from the video.
3. **AI Generation:** An advanced Large Language Model analyzes the text, parsing out analogies and focusing solely on core principles to build an educational quiz.
4. **Interactive UI:** A highly polished "Glassmorphic" UI renders inside the YouTube player, allowing users to answer multiple-choice questions with immediate grading and explanations.
5. **Caching:** Previously generated quizzes are aggressively cached via Chrome's Local Storage so returning to a video loads instantly and saves API bandwidth.

---

## 🏗️ Technical Implementation Breakdown

### 1. The Frontend Overlays (`content.js` & `quiz-ui.js`)
Rather than relying on popups, Grizzy injects itself as a living DOM application directly above the YouTube HTML5 player. 
* Uses **Vanilla JS** combined with deep DOM selector logic (`ytd-app`, `ytd-player`) to anchor the overlay seamlessly.
* Manages the "State" of the user's progress through the quiz, tracking metrics like correct answers and the current video segment.

### 2. The Service Worker Logic (`background.js`)
Operating entirely in the background, this script isolates heavy computational/network logic away from the main thread.
* **Orchestrator:** Intercepts message requests from the frontend and delegates out API calls.
* **LLM Prompter:** Interfaces directly with **Groq Cloud API** using `llama-3.3-70b-versatile` to harness zero-shot reasoning.
* **Strict RegEx Policing:** Features a custom `safeParse()` engine. LLMs notoriously append trailing characters or markdown (e.g., ````json`). The parser ensures that the raw payload is safely scraped, filtered, and transformed into an exact array of Question JSON objects, preventing rendering crashes.

### 3. The Extraction Engine (`transcript.js`)
YouTube fights against bot scraping aggressively. Grizzy mitigates this via a cascading fallback strategy:
* **Strategy A (The API):** Pulls silently from YouTube's internal `timedtext` API to grab the closed captions directly.
* **Strategy B (The Failsafe):** If YouTube blocks the request (e.g., age restriction, CORS, explicit blocking), the extension bridges to a **Python FastAPI Backend**, which utilizes the `youtube-transcript-api` to bypass browser-level blocks.

### 4. The Last Resort AI Transcriber (Backend STT)
What if the video has absolutely no subtitles or is independently uploaded? This is where the Python FastAPI Backend steps in:
* The extension sends the `videoId` to `localhost:8000/generate-transcript`.
* The server uses `yt-dlp` to download only the ultra-lightweight `.m4a` audio stream.
* It passes this audio to **Faster/Whisper**, a hyper-optimized machine-learning transcription model. Whisper "listens" to the video, generating high-accuracy timestamps and text payload.
* The frontend uses Long-Polling (`setInterval`) to routinely check the backend status until the new transcript is successfully ripped, decoded, and ready for questioning.

---

## 🔒 Security & Performance Features
* **Manifest V3 Compliant:** Completely eliminates dangerous inline `<script>` injections.
* **Stateless API:** The extension relies solely on deterministic outputs instead of maintaining vulnerable global variables.
* **Rate Limit Protection:** Features hard stops and fail-safes. If the Groq API fails or limits traffic, the UI gracefully renders a single dummy question (e.g., `"API limit reached. Try reloading."`) instead of completely breaking the extension state.

Grizzy successfully turns passive consumption into focused, engaged micro-learning without leaving the platform.
