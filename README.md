# Playwright Pilot

> Chrome extension for E2E automation testing — record browser interactions across pages, generate Playwright tests with AI, run happy flow audits (navigation, form, login, link-click), site-wide SEO/accessibility audits, and manage test suites with video playback.

## Features

### Record Browser Interactions
- Click **Start** to begin recording clicks, typing, navigation, form fills, and assertions
- **Cross-page recording** — recording persists across page navigations; close the popup and reopen it on any page to continue or stop
- Smart selector generation (data-testid → role-based → accessible → CSS fallback)
- Real-time step list with edit/remove capability
- Visual highlight overlay shows elements as you interact
- **Video capture** — tab video is recorded alongside interactions and saved with the report
- Configurable options: auto-assertions, screenshots, smart wait states

### AI Test Generation
- Describe a user flow in plain English and get complete Playwright test code
- Supports **@playwright/test**, **Playwright BDD (Cucumber)**, and **Component Testing**
- Page Object Model (POM) generation
- Accessibility checks via axe-core
- Visual regression snapshots
- API mocking support

### Happy Flow Testing
Run automated flow tests directly from the extension:

| Flow | Description |
|------|-------------|
| **Navigation** | Visit sitemap/discovered pages, audit SEO & accessibility, check sub-links |
| **Form** | Detect forms, fill with dummy data, submit, and validate errors |
| **Login** | Find login page, enter test credentials, verify redirect |
| **Link Click** | Detect all internal links on the current page, click each one, verify it loads |
| **Full Fledge** | Deep crawl + form + login + sitemap check combined |

- **Stop & Generate Report** — stop any running flow mid-execution and get a partial report
- Modern report UI with score rings, stat cards, and downloadable PDF
- Results auto-saved to the Reports tab

### Site Audit
- Full-site SEO, accessibility, HTML validation, mobile responsiveness, and link checking
- Page-by-page audit with scores and issue details
- Configurable max pages

### Test Suite Management
- Save recorded and AI-generated tests to a persistent suite library
- Export individual `.spec.ts` files or download all at once
- Search and filter saved test suites

### Reports & History
- All test runs, recordings, happy flows, and audits saved as reports
- Reports include video segments when available
- **PDF export** — download any report as a styled PDF via print
- IndexedDB storage for large video data

### GitHub Actions Integration
- Configure repository for CI/CD integration
- Run test suites against different environments (local, staging, production)
- Dispatch Playwright workflows via GitHub Actions

## Installation

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `playwrightPilot` folder
4. Click the extension icon in the toolbar

## Setup

1. Click the **Settings** (gear) icon in the extension popup
2. Add your **GitHub Personal Access Token** with `repo` and `workflow` scopes
3. Configure your preferred AI model, selector strategy, and default base URL
4. (Optional) Set test email/password for the Login happy flow
5. (Optional) Set your GitHub repo owner/name for Actions integration

## Usage

### Recording a Test
1. Navigate to the page you want to test
2. Click the Playwright Pilot icon → **Record** tab
3. Click **Start** to begin recording
4. Interact with the page — clicks, typing, navigation are captured
5. **Navigate freely** — recording continues across pages, even if you close the popup
6. Reopen the popup at any time — the Stop button is available and all steps are preserved
7. Click **Stop** when done — recording and video are auto-saved to Reports
8. Click **Preview Code** to review the generated Playwright script
9. Click **Export .spec.ts** to download the test file

### Happy Flow Testing
1. Navigate to the target website
2. Click the Playwright Pilot icon → **Happy Flow** tab
3. Choose a flow: Navigation, Form, Login, Link Click, or Full Fledge
4. Set max pages (for Navigation/Full) or provide credentials (for Login/Full)
5. Watch real-time logs as the flow runs
6. Click **Stop & Generate Report** at any time to get partial results
7. View results inline or download as PDF

### AI-Generated Tests
1. Open the **AI Generate** tab
2. Enter the target URL (auto-filled from current tab)
3. Describe the test scenario in plain English
4. Select framework style and options (POM, accessibility, etc.)
5. Click **Generate with AI**
6. Review, copy, or export the generated code

### Running Tests
1. Save tests to your suite library
2. Switch to the **Tests** tab
3. Select an environment
4. Click **Run All** to dispatch via GitHub Actions

## Selector Strategy

Playwright Pilot generates resilient selectors in this priority order:

| Priority | Strategy | Example |
|----------|----------|---------|
| 1 | `data-testid` | `[data-testid="login-btn"]` |
| 2 | Role + aria-label | `role=button[name="Submit"]` |
| 3 | Label association | `getByLabel("Email")` |
| 4 | Placeholder | `[placeholder="Enter email"]` |
| 5 | Text content | `getByText("Sign In")` |
| 6 | Element ID | `#submit-form` |
| 7 | CSS class | `button.primary-action` |
| 8 | CSS path | `form > div:nth-of-type(2) > button` |

## Tech Stack

- **Chrome Extension** — Manifest V3 with service worker
- **Playwright** — Test framework target
- **GitHub Models API** — AI test generation (GPT-4o)
- **GitHub Actions** — CI/CD integration
- **Chrome Storage API** — Settings and suite persistence
- **IndexedDB** — Video segment storage
- **Offscreen API** — Tab video capture via `tabCapture`

## File Structure

```
playwrightPilot/
├── manifest.json       # Extension manifest (MV3)
├── background.js       # Service worker (AI, happy flows, recording coordinator, video)
├── content.js          # DOM recorder, selector engine, page audits, form/login testing
├── content.css         # Recording overlay + highlight styles
├── popup.html          # Extension popup UI (tabs: Record, AI, Happy Flow, Tests, Reports)
├── popup.js            # Popup logic (recording, flows, reports, code generation)
├── popup.css           # Popup styles (dark GitHub theme)
├── report.html         # Extension page for PDF report rendering
├── report-loader.js    # Loads report HTML from background and triggers print
├── offscreen.html      # Offscreen document for video recording
├── options.html        # Settings page
├── options.js          # Settings logic
├── options.css         # Settings styles
├── README.md           # This file
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Permissions

| Permission | Purpose |
|------------|---------|
| `storage` | Save settings, suites, reports |
| `activeTab` | Access current tab for recording/auditing |
| `scripting` | Inject content script on demand |
| `tabs` | Create/manage tabs for happy flows |
| `downloads` | Export test files |
| `alarms` | MV3 keepalive during long-running flows |
| `tabCapture` | Video recording of tab |
| `offscreen` | Offscreen document for MediaRecorder |

## License

MIT
