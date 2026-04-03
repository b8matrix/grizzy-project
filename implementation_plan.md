# Grizzy: Technical Implementation Plan

This document outlines the technical architecture and step-by-step roadmap for building the Grizzy Chrome Extension and its backend intelligence layer for your hackathon.

## Technical Architecture

The project will be split into two main components:
1. **The Chrome Extension (Frontend):** Injected directly into the browser to monitor video playing, extract subtitles/audio, and overlay the quizzes.
2. **The FastAPI Backend (Intelligence):** A Python server that handles the heavy lifting (parsing PDFs, generating quizzes via LLM, and storing progress).

### 1. Chrome Extension (Manifest V3)
*   **`manifest.json`:** Grants permissions for active tabs, scripting, and storage.
*   **Background Service Worker (`background.js`):** Acts as the middleman. It intercepts network requests (like YouTube subtitle files) or communicates with the backend API.
*   **Content Script (`content.js`):** This is the core workhorse. It injects into the web page (e.g., YouTube), finds the `<video>` element, tracks time, and triggers `video.pause()`. It also injects the Shadow DOM overlay to block the video and show the quiz/assessment.
*   **Popup UI (`popup.html` / `popup.js`):** The small menu when you click the extension icon. Here, the student can toggle "Mandatory Mode", view stats, and upload their Syllabus PDF.

### 2. FastAPI Backend
*   **Syllabus Processor (`/upload-syllabus`):** Receives the PDF, extracts text using PyPDF2, and uses an LLM to categorize the main concepts.
*   **Assessment Generator (`/generate-assessment`):** Receives the current video context (subtitles or STT transcript) and the user's syllabus concepts. Prompts the LLM (like Gemini or OpenAI API) to generate an interactive task or multiple-choice question.
*   **Resource Matcher (`/get-resources`):** Recommends links or other videos based on the extracted syllabus topics.

## User Review Required

> [!IMPORTANT]  
> Before we start writing the code, please review the proposed technology stack and architecture. Let me know your preference on a few key technical decisions.

## Proposed Setup Roadmap

### Phase 1: Extension Plumbing & Video Control
- [ ] Create `manifest.json` with appropriate permissions.
- [ ] Build a basic `content.js` that detects when a YouTube video hits a certain timestamp (e.g., 2 minutes) and pauses it.
- [ ] Inject a basic CSS-styled overlay over the video that cannot be closed until a button gets clicked.

### Phase 2: Backend & AI Integration
- [ ] Initialize Python virtual environment and FastAPI server.
- [ ] Create an endpoint that receives text context and uses an LLM API to return a structured JSON assessment.
- [ ] Connect the Chrome Extension to call this API when the video is paused.

### Phase 3: Syllabus & Resources
- [ ] Build the file upload UI in the extension's popup.
- [ ] Add PDF parsing and syllabus logic to the backend.

## Open Questions

> [!WARNING]  
> To begin generating the code, I need to know:
> 1.  **AI Provider:** Which AI API do you want to use for generating the assessments? (e.g., Google Gemini, OpenAI, Claude). Have your API key ready!
> 2.  **Workspace:** Can I start scaffolding the extension and backend code right now in your `c:\crafthon` directory?
> 3.  **Transcripts vs Audio:** For the Hackathon MVP, do you want to rely on YouTube's hidden text transcripts (very easy, fast) or build real-time audio capture (harder, but works on any site)? My recommendation for a 3-day hackathon is to start with YouTube transcripts first!

## Verification Plan
We will test locally:
*   Load the Unpacked extension into Chrome (`chrome://extensions`).
*   Run the FastAPI server locally (`uvicorn main:app --reload`).
*   Open a YouTube video and verify the video automatically pauses and the UI overlay appears with AI-generated content.
