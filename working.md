# AI Testing Tools — How It Works

## About the Tool

AI Testing Tools is a Chrome extension (Manifest V3) designed for developers and QA engineers to automate end-to-end (E2E) browser testing using Playwright. It combines **browser interaction recording**, **AI-powered test generation**, **automated happy flow testing**, and **full site auditing** into a single extension — eliminating the need to manually write test scripts from scratch.

The extension runs entirely within your browser as a Chrome extension. It uses a service worker (`background.js`) for coordination, a content script (`content.js`) injected into every page for DOM interaction, and a popup UI (`popup.html`) for the user interface. Video capture is handled via an offscreen document using the Chrome `tabCapture` API.

---

## How to Install

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** using the toggle in the top-right corner
3. Click **Load unpacked** and select the `AI Testing Tools` folder
4. The extension icon will appear in your Chrome toolbar — click it to open the popup

---

## Initial Setup

Before using the extension, configure it via **Settings** (gear icon in the popup header):

| Setting | Purpose |
|---------|---------|
| **GitHub Personal Access Token** | Required. Needs `repo` and `workflow` scopes. Powers AI test generation via GitHub Models API and GitHub Actions integration. |
| **AI Model** | Choose between GPT-4o (recommended), GPT-4o Mini (faster), GPT-4 Turbo, or o1-mini (reasoning). |
| **Default Base URL** | The target URL for generated tests (e.g., `http://localhost:3000`). |
| **Selector Strategy** | How elements are identified — Auto (best available), `data-testid` only, Role-based, or CSS selectors. |
| **Test Timeout** | Maximum time (in ms) to wait for each test action. Default: 30000. |
| **Test User Credentials** | Email & password used by the Login Flow to test authentication. |
| **GitHub Repository** | Owner/repo name for dispatching Playwright CI/CD workflows via GitHub Actions. |

---

## Extension Tabs & How to Use Each Feature

The popup UI is organized into five main tabs:

### 1. Record Tab

**What it does:** Records your real browser interactions (clicks, typing, navigation, form submissions) and converts them into Playwright test scripts.

**How to use:**

1. Navigate to the page you want to test.
2. Open the extension popup and go to the **Record** tab.
3. Click **Start** to begin recording.
4. Interact with the page naturally — every click, keystroke, and navigation is captured as a test step.
5. **Cross-page recording** — recording continues even if you navigate to different pages or close the popup. Reopen the popup anytime to see your steps or stop recording.
6. Click **Stop** when done. The recording (including video) is auto-saved to Reports.
7. Review the recorded steps in the step list — you can **edit** or **remove** individual steps.
8. Click **Preview Code** to see the generated Playwright test script.
9. Click **Download .test.js** or **Playwright .spec.js** to export the test file.
10. If video was captured, click **Download Video** to save the recording.

**Recording Options:**

- **Auto-add assertions** — automatically inserts assertion steps (e.g., visibility checks) as you interact.
- **Smart wait states** — adds intelligent waits between actions to handle async page loading.

**How recording works internally:**

- The content script (`content.js`) listens for DOM events (click, input, change, submit, navigation).
- For each interaction, it generates a resilient selector using a priority-based strategy:
  1. `data-testid` attribute
  2. Role + `aria-label`
  3. Label association (`getByLabel`)
  4. Placeholder text
  5. Text content (`getByText`)
  6. Element ID
  7. CSS class
  8. CSS path (fallback)
- A **visual highlight overlay** shows which element is being targeted in real time.
- The **offscreen document** (`offscreen.js`) captures tab video via `MediaRecorder` and the `tabCapture` API.
- Steps and video segments are stored using Chrome Storage API and IndexedDB respectively.

---

### 2. Tests Tab (Reports & History)

**What it does:** Stores and displays all saved reports from recordings, happy flows, audits, and AI-generated tests.

**How to use:**

1. Open the **Tests** tab to see all saved reports.
2. Use the **search bar** to filter reports by name or type.
3. Click on any report to expand and view its details — including test results, scores, and issues.
4. Reports that include video will have a video playback option.
5. Click **Delete all reports** (trash icon) to clear the history.
6. Open any report in a new tab for a full-page view with **PDF export** (via browser print).

**Report features:**

- Score rings and stat cards for visual summary.
- Page-by-page breakdown for audits.
- Video segments embedded when available.
- Downloadable as a styled PDF.

---

### 3. AI Generate Tab

**What it does:** Takes a plain-English description of a user flow and generates complete, production-ready Playwright test code using AI (GitHub Models API with GPT-4o).

**How to use:**

1. Open the **AI Generate** tab.
2. The **Target URL** is auto-filled from your current browser tab (you can change it).
3. Describe the test scenario in plain English. For example:
   > "User logs in with email and password, navigates to the dashboard, creates a new project, and verifies it appears in the project list."
4. Select **framework options**:
   - **@playwright/test** — standard Playwright test format
   - **Playwright BDD (Cucumber)** — Gherkin-style feature files
   - **Component Testing** — for testing individual UI components
5. Toggle optional features:
   - **Page Object Model (POM)** — generates structured page classes
   - **Accessibility checks** — includes axe-core a11y validation
   - **Visual regression** — adds screenshot comparison snapshots
   - **API mocking** — stubs network requests in the test
6. Click **Generate with AI**.
7. Review the generated code in the output panel.
8. **Copy** the code to clipboard or **Export** as a `.spec.ts` file.
9. Optionally, **Save to Suites** for later reuse.

---

### 4. Suites Tab (Test Suite Management)

**What it does:** A persistent library for saving, organizing, and exporting your recorded and AI-generated test scripts.

**How to use:**

1. Open the **Suites** tab to see all saved test suites.
2. Use the **search bar** to find specific tests.
3. Click on a suite to view its test code.
4. **Export individual tests** as `.spec.ts` files or **download all** suites at once.
5. Manage your test library — delete tests you no longer need.

**How tests get saved to suites:**

- After recording, click "Save to Suite" from the Record tab footer.
- After AI generation, click "Save to Suite" from the output panel.
- Suites are persisted using Chrome Storage API with `unlimitedStorage` permission.

---

### 5. Audit Tab (Site Audit)

**What it does:** Performs a comprehensive full-site audit covering SEO, accessibility, HTML validation, mobile responsiveness, and link checking.

**How to use:**

1. Navigate to the website you want to audit.
2. Open the **Audit** tab.
3. Set the **maximum number of pages** to crawl.
4. Click **Start Audit**.
5. The extension crawls the site, checking each page for:
   - **SEO** — meta tags, headings structure, Open Graph data, canonical URLs
   - **Accessibility** — ARIA attributes, color contrast, keyboard navigation, alt text
   - **HTML validation** — proper markup, missing required attributes, deprecated elements
   - **Mobile responsiveness** — viewport meta, responsive breakpoints
   - **Link checking** — broken links, redirect chains, external link health
6. View results with per-page scores and detailed issue lists.
7. Export the audit report as PDF.

---

## Happy Flow Testing (Quick Start)

The **Happy Flow** section (located within the Record tab) provides one-click automated browser testing flows that run directly in your browser.

### Available Flows

| Flow | What It Does | How It Works |
|------|-------------|--------------|
| **Page Navigation** | Visits every discoverable page on the site and checks that all internal links work. | Crawls sitemap and discovered links, navigates to each page, audits SEO & accessibility, and verifies sub-links load correctly. |
| **Form Submit** | Finds all forms on the site, fills them with dummy data, submits, and validates error handling. | Detects `<form>` elements, identifies input types, fills with appropriate test data, submits, and checks for validation error messages. |
| **Login Flow** | Locates the login page, enters test credentials, submits, and verifies successful redirect. | Finds login forms (password fields), enters the email/password configured in Settings, submits, and checks for redirect to authenticated page. |
| **Link Click Test** | Clicks every internal link on the current page and verifies each one loads. | Collects all `<a>` tags with internal `href`, programmatically clicks each, waits for page load, and records success/failure. |
| **Full Fledge** | Combines all of the above — deep crawl, forms, links, sitemap, and login. | Runs Navigation + Form + Login + Link Click sequentially across the configured number of pages. |

**How to run a Happy Flow:**

1. Navigate to the target website.
2. Open the extension popup → **Record** tab → scroll to **Quick Start — Happy Flow**.
3. Set **Max Pages** (number of pages to test per flow).
4. Click the card for the desired flow.
5. Watch **real-time logs** as the flow executes in your browser.
6. Click **Stop & Generate Report** at any time to halt execution and get a partial results report.
7. Results are auto-saved to the Tests/Reports tab.

---

## GitHub Actions Integration

**What it does:** Lets you run your saved test suites in CI/CD pipelines via GitHub Actions.

**How to set up:**

1. Go to **Settings** and enter your **GitHub Repository** (owner/repo).
2. Ensure your **GitHub Token** has `repo` and `workflow` scopes.
3. Save tests to your suite library.

**How to run:**

1. Switch to the **Tests** tab.
2. Select an environment (local, staging, or production).
3. Click **Run All** to dispatch the Playwright workflow via GitHub Actions.
4. The extension sends a `workflow_dispatch` event to your configured repository.
5. Monitor results directly from the extension or in your GitHub Actions dashboard.

---

## How It All Works Under the Hood

### Architecture

```
┌─────────────────────────────────────────────┐
│  popup.html / popup.js                      │
│  (User Interface — tabs, buttons, display)  │
├─────────────────────────────────────────────┤
│  background.js (Service Worker)             │
│  - AI generation via GitHub Models API      │
│  - Happy flow coordination                  │
│  - Recording state management               │
│  - Video capture orchestration              │
│  - Chrome alarms for MV3 keepalive          │
├─────────────────────────────────────────────┤
│  content.js (Injected into every page)      │
│  - DOM event listeners (click, input, etc.) │
│  - Selector engine (8-level priority)       │
│  - Page audit (SEO, a11y, HTML, links)      │
│  - Form detection & auto-fill               │
│  - Login flow automation                    │
├─────────────────────────────────────────────┤
│  offscreen.js + offscreen.html              │
│  - Video recording via tabCapture API       │
│  - MediaRecorder for video encoding         │
├─────────────────────────────────────────────┤
│  report.html + report-loader.js             │
│  - Full-page report rendering               │
│  - PDF export via browser print             │
├─────────────────────────────────────────────┤
│  options.html / options.js                  │
│  - Settings management UI                   │
└─────────────────────────────────────────────┘
```

### Data Storage

| Storage | What's Stored |
|---------|---------------|
| **Chrome Storage API** | Settings (token, model, URLs), test suites, reports metadata, recording state |
| **IndexedDB** | Large video segments from tab recordings |

### Communication Flow

1. **Popup ↔ Background:** Chrome runtime messaging (`chrome.runtime.sendMessage`). The popup sends commands (start recording, run flow, generate AI test), and the background responds with results.
2. **Background ↔ Content Script:** Chrome tabs messaging (`chrome.tabs.sendMessage`). The background tells the content script to start/stop listening for DOM events, run audits, or perform form fills.
3. **Background ↔ Offscreen:** Chrome runtime messaging. The background creates/destroys the offscreen document to start/stop video capture.
4. **Background ↔ GitHub API:** HTTP requests to GitHub Models API for AI generation and GitHub Actions API for workflow dispatch.

### Chrome Permissions Explained

| Permission | Why It's Needed |
|------------|-----------------|
| `storage` | Persist settings, test suites, and report data across sessions |
| `unlimitedStorage` | Store large amounts of test data and video without hitting quota limits |
| `activeTab` | Access the current tab's URL and content for recording and auditing |
| `scripting` | Dynamically inject the content script when needed |
| `tabs` | Create, navigate, and manage tabs during happy flow execution |
| `downloads` | Export `.spec.ts` test files and video recordings to the user's machine |
| `alarms` | Keep the MV3 service worker alive during long-running happy flows |
| `offscreen` | Create an offscreen document for video recording (required by `tabCapture`) |

---

## Key Technical Highlights

- **Manifest V3 compliant** — uses a service worker instead of a persistent background page, with alarms-based keepalive for long operations.
- **Cross-page recording** — recording persists across navigations; the content script re-attaches on each page load via the `run_at: document_idle` manifest setting.
- **Smart selectors** — 8-level priority selector engine ensures tests are resilient to minor UI changes.
- **Video capture** — real-time tab video recording alongside interaction capture, stored in IndexedDB for efficient large-blob handling.
- **Offline-capable reports** — reports are rendered as self-contained HTML with score rings, stat cards, and embedded data — no server required.
- **Dark GitHub theme** — the UI matches the GitHub dark theme for a familiar developer experience.
