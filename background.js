/* ===== Playwright Pilot — Background Service Worker ===== */

const AI_ENDPOINT = 'https://models.inference.ai.azure.com/chat/completions';
const AI_MODEL = 'gpt-4o';

/* ── Message Router ── */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  /* ── Recorder: collect steps from content scripts ── */
  if (msg.type === 'PW_STEP_RECORDED') {
    if (recorderState.active) {
      msg.step.stepIndex = recorderState.steps.length;
      recorderState.steps.push(msg.step);
    }
    // Don't consume — let popup listener also receive it
    return false;
  }

  const handlers = {
    GENERATE_TEST:       () => generateTest(msg.token, msg.payload),
    GENERATE_HAPPY_FLOW: () => generateHappyFlow(msg.token, msg.payload),
    RUN_HAPPY_FLOW:      () => runHappyFlow(msg.payload),
    GET_HAPPY_FLOW_STATUS: () => getHappyFlowStatus(),
    GET_PENDING_HF_RESULT: () => getPendingHFResult(),
    CLEAR_PENDING_HF_RESULT: () => clearPendingHFResult(),
    RUN_TESTS:           () => runTests(msg.token, msg.payload),
    EXECUTE_TEST:        () => executeTest(msg.payload),
    ENHANCE_CODE:        () => enhanceCode(msg.token, msg.payload),
    FETCH_SITEMAP:       () => fetchSitemap(msg.payload),
    CHECK_URL:           () => checkUrl(msg.payload),
    CAPTURE_TAB:         () => captureTab(msg.payload),
    START_AUDIT:         () => startSiteAudit(msg.payload),
    ABORT_HAPPY_FLOW:    () => abortHappyFlow(),
    STOP_AUDIT:          () => stopSiteAudit(),
    GET_AUDIT_STATUS:    () => getAuditStatus(),
    START_VIDEO_RECORD:  () => startManualVideoRecording(msg.payload),
    STOP_VIDEO_RECORD:   () => stopManualVideoRecording(),
    OPEN_REPORT_TAB:     () => openReportTab(msg.payload),
    GET_PENDING_REPORT:  () => getPendingReport(),
    START_RECORDING:     () => startRecordingSession(msg.payload),
    STOP_RECORDING:      () => stopRecordingSession(),
    GET_RECORDER_STATE:  () => getRecorderState(),
    REMOVE_RECORDED_STEP:() => removeRecordedStep(msg.payload),
  };

  const fn = handlers[msg.type];
  if (!fn) return false;

  (async () => {
    try {
      const result = await fn();
      sendResponse(result);
    } catch (err) {
      sendResponse({ error: err.message || 'Unknown error in background' });
    }
  })();
  return true;
});

/* ── Keepalive via chrome.alarms (MV3-safe) ── */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'audit-keepalive') {
    if (!auditState.running) {
      chrome.alarms.clear('audit-keepalive');
    }
  }
  if (alarm.name === 'hf-keepalive') {
    if (!happyFlowState.running) {
      chrome.alarms.clear('hf-keepalive');
    }
  }
});

/* ── Port connection for real-time audit status ── */
const auditPorts = new Set();
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'audit-status') {
    auditPorts.add(port);
    port.onDisconnect.addListener(() => auditPorts.delete(port));
  }
});

/* ── AI Test Generation ── */
async function generateTest(token, payload) {
  if (!payload) throw new Error('Missing test parameters.');
  if (!token) throw new Error('GitHub token not configured. Go to Settings.');

  const { url, description, framework, usePOM, a11y, visual, apiMock } = payload;

  const systemPrompt = buildSystemPrompt(framework, { usePOM, a11y, visual, apiMock });
  const userPrompt = buildUserPrompt(url, description, framework, { usePOM, a11y, visual, apiMock });

  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`AI generation failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Extract code block from AI response
  const code = extractCodeBlock(content);
  return { code };
}

function isPlaywrightFramework(framework) {
  return framework && framework.startsWith('playwright');
}

function buildSystemPrompt(framework, options) {
  if (isPlaywrightFramework(framework)) {
    return buildPlaywrightSystemPrompt(framework, options);
  }

  const fwName = framework === 'puppeteer-jest' ? 'Puppeteer + Jest'
    : framework === 'puppeteer-mocha' ? 'Puppeteer + Mocha/Chai'
    : 'Puppeteer + Jest';

  return `You are an expert Puppeteer E2E test automation engineer. Generate production-ready test code.

RULES:
1. Use JavaScript/Node.js with ${fwName} framework.
2. Use modern Puppeteer best practices: page.waitForSelector, page.$eval, page.$$eval, page.type, page.click, page.select.
3. NEVER use fragile selectors like nth-child or absolute xpath. Prefer data-testid, aria-label, role, and semantic selectors.
4. Include proper test structure: describe blocks, beforeAll/afterAll for browser lifecycle, beforeEach/afterEach for page setup.
5. Add meaningful test names that describe the user story.
6. Handle async operations properly with async/await.
7. Use page.waitForNavigation() or page.waitForNetworkIdle() after user actions that trigger navigation.
8. ${options.usePOM ? 'Use Page Object Model pattern. Create a class for the page with methods for each action.' : 'Write inline test code without POM.'}
9. ${options.a11y ? 'Include accessibility checks using axe-puppeteer (axe.run).' : 'Skip accessibility checks.'}
10. ${options.visual ? 'Include screenshot comparisons using page.screenshot() and image-based diffing.' : 'Skip visual regression.'}
11. ${options.apiMock ? 'Mock API endpoints using page.setRequestInterception(true) and page.on("request").' : 'Do not mock APIs.'}
12. Always launch browser with puppeteer.launch({ headless: "new" }) and set viewport with page.setViewport({ width: 1280, height: 720 }).
13. Always close browser in afterAll block.
14. Return ONLY the code. No explanations, no markdown.`;
}

function buildPlaywrightSystemPrompt(framework, options) {
  const fwName = framework === 'playwright-test' ? '@playwright/test (recommended)'
    : framework === 'playwright-jest' ? 'Playwright + Jest (jest-playwright)'
    : 'Playwright (standalone script)';

  const isNativeTest = framework === 'playwright-test';

  return `You are an expert Playwright E2E test automation engineer. Generate production-ready test code.

RULES:
1. Use JavaScript/Node.js with ${fwName} framework.
2. Use modern Playwright best practices: page.locator(), page.getByRole(), page.getByText(), page.getByTestId(), page.getByLabel(), page.getByPlaceholder().
3. NEVER use fragile selectors like nth-child or absolute xpath. Prefer getByRole, getByTestId, getByLabel, getByText, and semantic locators.
4. ${isNativeTest ? 'Use test() and expect() from @playwright/test. Use test.describe() for grouping. Use built-in fixtures (page, context, browser).' : 'Include proper test structure: describe blocks, beforeAll/afterAll for browser lifecycle.'}
5. Add meaningful test names that describe the user story.
6. Handle async operations properly with async/await.
7. ${isNativeTest ? 'Use await page.waitForURL() or await page.waitForLoadState("networkidle") after navigation actions.' : 'Use page.waitForURL() or page.waitForLoadState("networkidle") after navigation actions.'}
8. ${options.usePOM ? 'Use Page Object Model pattern. Create a class for the page with methods for each action.' : 'Write inline test code without POM.'}
9. ${options.a11y ? 'Include accessibility checks using @axe-core/playwright.' : 'Skip accessibility checks.'}
10. ${options.visual ? 'Include visual comparisons using await expect(page).toHaveScreenshot().' : 'Skip visual regression.'}
11. ${options.apiMock ? 'Mock API endpoints using page.route() to intercept and fulfill requests.' : 'Do not mock APIs.'}
12. ${isNativeTest ? 'Use test.use({ viewport: { width: 1280, height: 720 } }) or configure in playwright.config.' : 'Launch browser with chromium.launch() and set viewport { width: 1280, height: 720 }.'}
13. ${isNativeTest ? 'Playwright Test handles browser lifecycle automatically — do NOT manually launch/close browsers.' : 'Always close browser in afterAll block.'}
14. Use Playwright assertions: await expect(locator).toBeVisible(), toHaveText(), toContainText(), toHaveValue(), etc.
15. Return ONLY the code. No explanations, no markdown.`;
}

function buildUserPrompt(url, description, framework, options) {
  const isPW = isPlaywrightFramework(framework);
  const toolName = isPW ? 'Playwright' : 'Puppeteer';
  let prompt = `Generate a complete ${toolName} E2E test for the following scenario:\n\n`;

  if (url) prompt += `Target URL: ${url}\n`;
  prompt += `Test Description: ${description}\n`;
  prompt += `Framework: ${framework}\n\n`;

  prompt += `Requirements:\n`;
  prompt += `- Use descriptive test names\n`;
  if (isPW) {
    prompt += `- Add proper assertions using Playwright expect (toBeVisible, toHaveText, toContainText, etc.)\n`;
    prompt += `- Handle loading states with page.waitForLoadState() and locator auto-waiting\n`;
  } else {
    prompt += `- Add proper assertions for each step (expect from Jest or assert from Chai)\n`;
    prompt += `- Handle loading states with waitForSelector and waitForNetworkIdle\n`;
  }

  if (options.usePOM) {
    prompt += `- Implement Page Object Model pattern\n`;
    prompt += `- Export the page class separately\n`;
  }
  if (options.a11y) {
    prompt += `- Add accessibility audit after key interactions\n`;
  }
  if (options.visual) {
    prompt += `- Add visual snapshot comparisons at key states\n`;
  }
  if (options.apiMock) {
    prompt += `- Mock external API calls with realistic data\n`;
  }

  return prompt;
}

function extractCodeBlock(content) {
  // Try to extract from markdown code block
  const match = content.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
  if (match) return match[1].trim();

  // Fallback: check if content starts with import
  if (content.trim().startsWith('import')) return content.trim();

  return content.trim();
}

/* ── Happy Flow Generation ── */
async function generateHappyFlow(token, payload) {
  if (!payload) throw new Error('Missing happy flow parameters.');
  if (!token) throw new Error('GitHub token not configured. Go to Settings.');

  const { url, flowType, pageTitle, pageElements, framework } = payload;
  const isPW = isPlaywrightFramework(framework);

  const systemPrompt = isPW
    ? `You are an expert Playwright E2E test automation engineer.
Generate a production-ready default happy path test that validates the core user journey.

RULES:
1. Use JavaScript with @playwright/test framework.
2. Use modern Playwright APIs: page.locator(), page.getByRole(), page.getByText(), page.getByTestId(), page.getByLabel(), page.getByPlaceholder().
3. NEVER use fragile selectors. Prefer getByRole, getByTestId, getByLabel, getByText, and semantic locators.
4. Add meaningful assertions using Playwright expect (toBeVisible, toHaveText, toContainText, toHaveURL, etc.) after every significant action.
5. Include proper test.describe/test blocks with descriptive names.
6. Use page.waitForURL() or page.waitForLoadState("networkidle") after navigations.
7. Handle async/await correctly.
8. Use test fixtures (page, context, browser) — do NOT manually launch/close browsers.
9. Use test.use({ viewport: { width: 1280, height: 720 } }) to set viewport.
10. Return ONLY the code. No explanations, no markdown syntax.`
    : `You are an expert Puppeteer E2E test automation engineer.
Generate a production-ready default happy path test that validates the core user journey.

RULES:
1. Use JavaScript with Puppeteer + Jest framework.
2. Use modern Puppeteer APIs: page.waitForSelector, page.$eval, page.type, page.click, page.select.
3. NEVER use fragile selectors. Prefer data-testid, aria-label, role, and semantic selectors.
4. Add meaningful assertions (Jest expect) after every significant action.
5. Include proper describe/it blocks with descriptive names.
6. Use page.waitForNavigation() or page.waitForNetworkIdle() after navigations.
7. Handle async/await correctly.
8. Launch browser in beforeAll with puppeteer.launch({ headless: "new" }), close in afterAll.
9. Set viewport with page.setViewport({ width: 1280, height: 720 }).
10. Return ONLY the code. No explanations, no markdown syntax.`;

  const userPrompt = buildHappyFlowPrompt(url, flowType, pageTitle, pageElements);

  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Happy flow generation failed (${res.status}): ${errBody.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return { code: extractCodeBlock(content), flowType };
}

function buildHappyFlowPrompt(url, flowType, pageTitle, pageElements) {
  let prompt = `Generate a happy path E2E test for this page:\n\n`;
  prompt += `URL: ${url}\n`;
  if (pageTitle) prompt += `Page Title: ${pageTitle}\n`;
  prompt += `Flow Type: ${flowType}\n\n`;

  if (pageElements) {
    prompt += `Detected Page Elements:\n`;
    if (pageElements.forms?.length) prompt += `- Forms: ${pageElements.forms.join(', ')}\n`;
    if (pageElements.buttons?.length) prompt += `- Buttons: ${pageElements.buttons.join(', ')}\n`;
    if (pageElements.links?.length) prompt += `- Key Links: ${pageElements.links.slice(0, 10).join(', ')}\n`;
    if (pageElements.inputs?.length) prompt += `- Input Fields: ${pageElements.inputs.join(', ')}\n`;
    if (pageElements.headings?.length) prompt += `- Headings: ${pageElements.headings.join(', ')}\n`;
    prompt += '\n';
  }

  switch (flowType) {
    case 'navigation':
      prompt += `Generate a test that:\n`;
      prompt += `1. Navigates to the URL\n`;
      prompt += `2. Verifies the page title\n`;
      prompt += `3. Checks all major sections/headings are visible\n`;
      prompt += `4. Verifies navigation links work\n`;
      prompt += `5. Checks the page loads within acceptable time\n`;
      prompt += `6. Verifies no console errors\n`;
      break;
    case 'form':
      prompt += `Generate a test that:\n`;
      prompt += `1. Navigates to the URL\n`;
      prompt += `2. Identifies all form fields\n`;
      prompt += `3. Fills each field with valid test data\n`;
      prompt += `4. Submits the form\n`;
      prompt += `5. Verifies success message or redirect\n`;
      prompt += `6. Validates the form prevents empty submissions\n`;
      break;
    case 'auth':
      prompt += `Generate a test that:\n`;
      prompt += `1. Navigates to the login/auth page\n`;
      prompt += `2. Enters valid test credentials (use placeholder email/password)\n`;
      prompt += `3. Clicks the login/sign-in button\n`;
      prompt += `4. Waits for redirect to dashboard or home\n`;
      prompt += `5. Verifies user is authenticated (profile, avatar, or welcome text)\n`;
      prompt += `6. Includes a logout step at the end\n`;
      break;
    case 'full':
    default:
      prompt += `Generate a COMPREHENSIVE happy path test that:\n`;
      prompt += `1. Navigates to the URL and verifies page load\n`;
      prompt += `2. Checks page title and key headings\n`;
      prompt += `3. Interacts with the primary call-to-action\n`;
      prompt += `4. Fills any forms with valid data\n`;
      prompt += `5. Clicks primary buttons and verifies responses\n`;
      prompt += `6. Navigates through main user journey\n`;
      prompt += `7. Validates success states at each step\n`;
      prompt += `8. Covers the complete happy path from entry to success\n`;
      break;
  }

  return prompt;
}

/* ── Persistent Recorder State (survives popup close & page navigation) ── */
const recorderState = { active: false, tabId: null, steps: [], startedAt: null, options: {} };

async function startRecordingSession(payload) {
  if (recorderState.active) return { error: 'Already recording' };
  const { tabId, options } = payload || {};
  if (!tabId) return { error: 'No tab ID' };

  recorderState.active = true;
  recorderState.tabId = tabId;
  recorderState.steps = [];
  recorderState.startedAt = Date.now();
  recorderState.options = options || {};

  // Tell content script on the current tab to start
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PW_START_RECORD', options: recorderState.options });
  } catch { /* content script may not be ready yet */ }

  // Start video capture
  try {
    await startManualVideoRecording({ tabId });
  } catch (e) { console.warn('[Recorder] Video start failed:', e.message); }

  return { started: true };
}

async function stopRecordingSession() {
  if (!recorderState.active) return { steps: [], videoDataUrl: null, videoInIdb: false };

  recorderState.active = false;
  const steps = [...recorderState.steps];
  const tabId = recorderState.tabId;

  // Stop content script recording on the current tab
  try {
    if (tabId) await chrome.tabs.sendMessage(tabId, { type: 'PW_STOP_RECORD' });
  } catch { /* tab may be closed */ }

  // Stop video and get data
  let videoDataUrl = null;
  let videoInIdb = false;
  try {
    const res = await stopManualVideoRecording();
    videoDataUrl = res?.videoDataUrl || null;
    videoInIdb = res?.videoInIdb || false;
  } catch (e) {
    console.warn('[Recorder] Video stop error:', e.message);
  }

  const result = { steps, videoDataUrl, videoInIdb, startedAt: recorderState.startedAt };

  // Reset
  recorderState.tabId = null;
  recorderState.steps = [];
  recorderState.startedAt = null;

  return result;
}

function getRecorderState() {
  return {
    active: recorderState.active,
    tabId: recorderState.tabId,
    stepCount: recorderState.steps.length,
    steps: recorderState.steps,
    startedAt: recorderState.startedAt,
  };
}

function removeRecordedStep(payload) {
  const idx = payload?.index;
  if (typeof idx === 'number' && idx >= 0 && idx < recorderState.steps.length) {
    recorderState.steps.splice(idx, 1);
    // Re-index
    recorderState.steps.forEach((s, i) => { s.stepIndex = i; });
  }
  return { steps: recorderState.steps };
}

/* ── Re-inject recording on tab navigation ── */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!recorderState.active) return;
  if (tabId !== recorderState.tabId) return;
  if (changeInfo.status !== 'complete') return;

  // Content script was freshly injected on this page — tell it to start recording
  setTimeout(async () => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PW_START_RECORD', options: recorderState.options, resumed: true });
    } catch { /* content script not ready */ }
  }, 500);
});

/* ── Video Recording Engine ── */
const videoState = { active: false, segments: [], maxSegments: 10 };

function canRecordSegment() {
  return videoState.active && videoState.segments.length < videoState.maxSegments;
}

async function recordTabSegment(tabId) {
  if (!canRecordSegment()) return false;
  return startTabRecording(tabId);
}

async function saveTabSegment(label) {
  if (!videoState.active) return;
  // Generate a unique IDB key per segment to avoid overwriting previous segments
  const segKey = `__hf_segment_${Date.now()}_${videoState.segments.length}`;
  const result = await stopTabRecording(segKey);
  if (result?.dataUrl) {
    videoState.segments.push({ label, dataUrl: result.dataUrl, idbKey: segKey, ts: Date.now() });
  } else if (result?.savedToIdb) {
    // Video saved to IDB but too large for message — store the IDB key reference
    videoState.segments.push({ label, idbKey: result.idbKey || segKey, savedToIdb: true, ts: Date.now() });
  } else {
    // Recording failed for this segment — still track it so popup can attempt IDB lookup
    videoState.segments.push({ label, idbKey: segKey, failed: true, ts: Date.now() });
  }
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length) return; // already exists
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Recording tab video for test playback',
  });
}

async function closeOffscreenDocument() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length) await chrome.offscreen.closeDocument();
  } catch { /* already closed */ }
}

/* ── Screen-capture state (interval-based via captureVisibleTab) ── */
const screenCapture = { active: false, intervalId: null, tabId: null, windowId: null };

async function startTabRecording(tabId) {
  try {
    // Stop any existing capture first
    if (screenCapture.active) {
      screenCapture.active = false;
      if (screenCapture.intervalId) { clearInterval(screenCapture.intervalId); screenCapture.intervalId = null; }
    }

    const tabInfo = await chrome.tabs.get(tabId);

    // Skip recording for chrome://, about:, or extension pages
    const tabUrl = tabInfo.url || tabInfo.pendingUrl || '';
    if (!tabUrl || tabUrl.startsWith('chrome') || tabUrl.startsWith('about:') || tabUrl.startsWith('edge:')) {
      return false;
    }

    // Make the tab active + focused (required for captureVisibleTab)
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tabInfo.windowId, { focused: true });
    await delay(300);

    await ensureOffscreenDocument();

    // Initialize canvas-based video recorder in offscreen document (1080p for high-quality .webm)
    const initResp = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_INIT_VIDEO',
      width: 1920,
      height: 1080,
    });
    if (initResp?.error) {
      console.warn('[Video] Init recording failed:', initResp.error);
      return false;
    }

    // Capture first frame immediately (high quality)
    try {
      const frame = await chrome.tabs.captureVisibleTab(tabInfo.windowId, { format: 'jpeg', quality: 92 });
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_ADD_FRAME', dataUrl: frame }).catch(() => {});
    } catch { /* first frame optional */ }

    // Start interval capture at ~4 FPS for smoother high-quality video
    screenCapture.active = true;
    screenCapture.tabId = tabId;
    screenCapture.windowId = tabInfo.windowId;
    screenCapture.intervalId = setInterval(async () => {
      if (!screenCapture.active) {
        clearInterval(screenCapture.intervalId);
        screenCapture.intervalId = null;
        return;
      }
      try {
        // Re-read tab to get current windowId (may have changed)
        const tab = await chrome.tabs.get(screenCapture.tabId);
        if (!tab) return;
        const frame = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 92 });
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_ADD_FRAME', dataUrl: frame }).catch(() => {});
      } catch {
        // Tab closed, not visible, or capture failed — skip this frame
      }
    }, 250);

    return true;
  } catch (err) {
    console.warn('[Video] startTabRecording error:', err.message);
    return false;
  }
}

async function stopTabRecording(idbKey) {
  // Stop the screenshot interval
  screenCapture.active = false;
  if (screenCapture.intervalId) {
    clearInterval(screenCapture.intervalId);
    screenCapture.intervalId = null;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_STOP_RECORDING',
      idbKey: idbKey || undefined,
    });
    if (response?.dataUrl) return { dataUrl: response.dataUrl, savedToIdb: response.savedToIdb || false, idbKey: response.idbKey };
    if (response?.savedToIdb) return { dataUrl: null, savedToIdb: true, idbKey: response.idbKey };
    if (response?.error) console.warn('[Video] Stop recording error:', response.error);
    return { dataUrl: null, savedToIdb: false };
  } catch (err) {
    console.warn('[Video] stopTabRecording error:', err.message);
    return { dataUrl: null, savedToIdb: false };
  }
}

/* ── Open Report in New Tab (called from popup, runs in background so it persists) ── */
let pendingReportHtml = null;

async function openReportTab(payload) {
  const { html } = payload || {};
  if (!html) return { error: 'No HTML content' };

  // Keep HTML in memory (avoids chrome.storage.local size/timing issues)
  pendingReportHtml = html;
  await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
  return { success: true };
}

function getPendingReport() {
  const html = pendingReportHtml;
  pendingReportHtml = null;
  return { html: html || '' };
}

/* ── Manual Video Recording (Start/Stop from Recorder tab) ── */
let manualRecordingActive = false;

async function startManualVideoRecording(payload) {
  if (manualRecordingActive) return { error: 'Already recording' };
  if (!payload?.tabId) return { error: 'No tab ID provided' };

  try {
    await ensureOffscreenDocument();
    const started = await startTabRecording(payload.tabId);
    if (!started) return { error: 'Could not start video recording' };
    manualRecordingActive = true;
    return { started: true };
  } catch (err) {
    return { error: err.message };
  }
}

async function stopManualVideoRecording() {
  if (!manualRecordingActive) return { videoDataUrl: null, videoInIdb: false };

  manualRecordingActive = false;
  const result = await stopTabRecording();
  await closeOffscreenDocument();
  return { videoDataUrl: result.dataUrl || null, videoInIdb: result.savedToIdb || false };
}

/* ── Happy Flow Execution Engine ── */
const happyFlowState = { running: false, abort: false, results: null, logs: [], pendingResult: null };

function logHF(level, message) {
  happyFlowState.logs.push({ ts: Date.now(), level, message });
}

function getHappyFlowStatus() {
  return {
    running: happyFlowState.running,
    results: stripVideoDataForMessage(happyFlowState.results),
    logs: happyFlowState.logs,
  };
}

function stripVideoDataForMessage(results) {
  if (!results?.videoSegments?.length) return results;
  return {
    ...results,
    videoSegments: results.videoSegments.map((s) => ({
      label: s.label,
      ts: s.ts,
      idbKey: s.idbKey,
      savedToIdb: s.savedToIdb,
      hasData: !!s.dataUrl || !!s.savedToIdb,
      failed: s.failed || false,
    })),
    _hasVideo: true,
  };
}

function getPendingHFResult() {
  if (happyFlowState.pendingResult) {
    const pr = { ...happyFlowState.pendingResult };
    if (pr.results) pr.results = stripVideoDataForMessage(pr.results);
    return pr;
  }
  // Also check if flow just finished (popup missed it)
  if (!happyFlowState.running && happyFlowState.results && !happyFlowState.results.error) {
    return { results: stripVideoDataForMessage(happyFlowState.results), flowType: happyFlowState.results.flowType || 'full' };
  }
  return null;
}

function clearPendingHFResult() {
  happyFlowState.pendingResult = null;
  happyFlowState.results = null;
  return { ok: true };
}

function abortHappyFlow() {
  if (!happyFlowState.running) return { ok: false, error: 'No flow running' };
  happyFlowState.abort = true;
  logHF('warn', 'Stop requested — finishing current step and generating report…');
  return { ok: true };
}

async function runHappyFlow(payload) {
  if (happyFlowState.running) return { error: 'Happy flow already running' };
  if (!payload?.url) return { error: 'No URL provided' };

  const { url, flowType, testEmail, testPassword, maxPages } = payload;
  happyFlowState.running = true;
  happyFlowState.abort = false;
  happyFlowState.results = null;
  happyFlowState.logs = [];

  logHF('info', `Starting ${flowType} flow on ${url}`);

  // MV3 keepalive
  chrome.alarms.create('hf-keepalive', { periodInMinutes: 0.4 });

  // Run in background — store globally to prevent GC
  globalThis.__happyFlowPromise = runHappyFlowAsync(url, flowType, testEmail, testPassword, maxPages || 5).catch((err) => {
    logHF('error', `Flow failed: ${err.message}`);
    happyFlowState.results = { error: err.message };
  }).finally(async () => {
    happyFlowState.running = false;
    chrome.alarms.clear('hf-keepalive');

    // Auto-save report to storage so it persists even if popup is closed
    const res = happyFlowState.results;
    if (res && !res.error) {
      try {
        await autoSaveHappyFlowReport(res, flowType);
        happyFlowState.pendingResult = { results: res, flowType, savedAt: Date.now() };
      } catch (e) { console.warn('[HF] Auto-save report failed:', e); }
    }
  });

  return { started: true };
}

async function runHappyFlowAsync(url, flowType, testEmail, testPassword, maxPages) {
  const results = { flowType, url, maxPages, startedAt: new Date().toISOString(), steps: [] };

  // Initialize video recording state
  videoState.active = true;
  videoState.segments = [];
  videoState.maxSegments = 8;
  try { await ensureOffscreenDocument(); } catch (e) { console.warn('[Video] Offscreen setup failed:', e.message); videoState.active = false; }

  if (flowType === 'navigation') {
    await runNavigationFlow(url, results, maxPages);
  }
  if (flowType === 'link-click') {
    await runLinkClickFlow(url, results);
  }
  if (flowType === 'full') {
    // Full Fledge: deep crawl by page type (categories, job details, search, company, etc.)
    await runDeepCrawl(url, results, maxPages);
  }
  if (flowType === 'form' || flowType === 'full') {
    await runFormFlow(url, results);
  }
  if (flowType === 'login' || flowType === 'full') {
    await runLoginFlow(url, results, testEmail, testPassword);
  }
  if (flowType === 'full') {
    await runSitemapCheck(url, results);
  }

  results.completedAt = new Date().toISOString();
  if (happyFlowState.abort) results.aborted = true;
  const elapsed = ((new Date(results.completedAt) - new Date(results.startedAt)) / 1000).toFixed(1);
  const abortLabel = happyFlowState.abort ? ' (stopped by user)' : '';
  logHF('success', `Flow complete${abortLabel} in ${elapsed}s — ${results.steps.length} steps`);

  // Finalize video recording
  videoState.active = false;
  results.videoSegments = videoState.segments.filter(Boolean);
  const capturedCount = results.videoSegments.filter((s) => !s.failed).length;
  const failedCount = results.videoSegments.filter((s) => s.failed).length;
  if (capturedCount > 0) {
    logHF('info', `Video: ${capturedCount} segment${capturedCount > 1 ? 's' : ''} captured${failedCount ? `, ${failedCount} failed` : ''}`);
  } else if (failedCount > 0) {
    logHF('warn', `Video: recording failed for all ${failedCount} segments — tab capture may not be available`);
  }
  videoState.segments = [];
  await closeOffscreenDocument();

  happyFlowState.results = results;
}

/* ── Auto-save happy flow report to chrome.storage.local ── */
async function autoSaveHappyFlowReport(results, flowType) {
  const steps = results.steps || [];
  const passed = steps.filter((s) => s.pass).length;
  const failed = steps.filter((s) => !s.pass).length;

  const report = {
    id: `report_${Date.now()}`,
    name: `${flowType.charAt(0).toUpperCase() + flowType.slice(1)} Flow — ${passed} passed, ${failed} failed`,
    type: 'happy-flow',
    data: { ...results, flowType },
    createdAt: new Date().toISOString(),
  };

  // Extract video data to IndexedDB-compatible payload stored alongside report
  // Since we're in background (no DOM), store video data in a separate storage key
  const videoSegments = report.data.videoSegments;
  if (videoSegments?.length) {
    // Store full video data separately for the popup to save to IndexedDB later
    try {
      await chrome.storage.local.set({ [`pw_hf_video_${report.id}`]: videoSegments });
    } catch (e) {
      console.warn('[HF] Video segments too large for storage:', e.message);
    }
    // Keep labels and IDB keys in the report (strip large dataUrl strings)
    report.data.videoSegments = videoSegments.map((s) => ({ label: s.label, ts: s.ts, idbKey: s.idbKey, savedToIdb: s.savedToIdb }));
    report.data._hasVideo = true;
  }

  // Add to reports array
  const store = await chrome.storage.local.get({ pw_reports: [] });
  const reports = store.pw_reports || [];
  reports.unshift(report);
  if (reports.length > 50) reports.splice(50);
  await chrome.storage.local.set({ pw_reports: reports });

  console.log('[HF] Auto-saved report:', report.id);
  return report;
}

/* ── Auto-save audit report to chrome.storage.local ── */
async function autoSaveAuditReport(reportData) {
  const report = {
    id: `report_${Date.now()}`,
    name: `Audit — ${reportData.summary?.totalPages || 0} pages, SEO ${reportData.summary?.seoScore || 0}/100`,
    type: 'audit',
    data: { ...reportData },
    createdAt: new Date().toISOString(),
  };

  // Store video segments separately
  const videoSegments = report.data.videoSegments;
  if (videoSegments?.length) {
    try {
      await chrome.storage.local.set({ [`pw_audit_video_${report.id}`]: videoSegments });
    } catch (e) {
      console.warn('[Audit] Video segments too large for storage:', e.message);
    }
    report.data.videoSegments = videoSegments.map((s) => ({ label: s.label, ts: s.ts }));
    report.data._hasVideo = true;
  }

  const store = await chrome.storage.local.get({ pw_reports: [] });
  const reports = store.pw_reports || [];
  reports.unshift(report);
  if (reports.length > 50) reports.splice(50);
  await chrome.storage.local.set({ pw_reports: reports });

  console.log('[Audit] Auto-saved report:', report.id);
  return report;
}

/* ── Auto-save test run report to chrome.storage.local ── */
async function autoSaveTestRunReport(testResult) {
  const s = testResult.summary || {};
  const allPassed = s.failed === 0 && (s.skipped || 0) === 0;

  const report = {
    id: `report_${Date.now()}`,
    name: `Test Run — ${allPassed ? 'ALL PASSED' : `${s.passed} passed, ${s.failed} failed`}`,
    type: 'test-run',
    data: { results: testResult.results, summary: testResult.summary },
    createdAt: new Date().toISOString(),
  };

  // Store video separately
  if (testResult.videoDataUrl) {
    try {
      await chrome.storage.local.set({ [`pw_tr_video_${report.id}`]: testResult.videoDataUrl });
    } catch (e) {
      console.warn('[TestRun] Video too large for storage:', e.message);
    }
    report.data._hasVideo = true;
  }

  const store = await chrome.storage.local.get({ pw_reports: [] });
  const reports = store.pw_reports || [];
  reports.unshift(report);
  if (reports.length > 50) reports.splice(50);
  await chrome.storage.local.set({ pw_reports: reports });

  console.log('[TestRun] Auto-saved report:', report.id);
  return report;
}

async function runNavigationFlow(baseUrl, results, maxPages) {
  logHF('info', '── Navigation Flow ──');
  const SUB_PAGES_PER_LINK = 2;
  const pageLimit = maxPages || 5;

  // Step 1: Fetch sitemap to get all pages
  let sitemapUrls = [];
  try {
    logHF('info', 'Fetching sitemap…');
    const sitemapRes = await fetchSitemap({ url: baseUrl });
    if (sitemapRes?.urls?.length) {
      sitemapUrls = sitemapRes.urls;
      logHF('success', `Sitemap found: ${sitemapUrls.length} URLs`);
      results.steps.push({ type: 'sitemap-found', url: sitemapRes.sitemapUrl, totalUrls: sitemapUrls.length, pass: true });
    }
  } catch { /* no sitemap */ }

  // Fallback: if no sitemap, collect links from base page
  if (!sitemapUrls.length) {
    logHF('warn', 'No sitemap — collecting links from base URL');
    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: baseUrl, active: false });
      await waitForTabComplete(tab.id);
      await waitForContentScript(tab.id);
      const linkData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_COLLECT_LINKS' });
      sitemapUrls = (linkData?.links || []).map((l) => l.href);
      logHF('info', `Collected ${sitemapUrls.length} internal links from base page`);
    } finally {
      if (tab?.id) try { await chrome.tabs.remove(tab.id); } catch { /* */ }
    }
  }

  if (!sitemapUrls.length) {
    logHF('warn', 'No URLs found to navigate');
    results.steps.push({ type: 'navigation', pass: false, error: 'No URLs found' });
    return;
  }

  // Step 2: Visit each sitemap page and check 2 internal links inside it
  let totalPassed = 0, totalFailed = 0;
  const maxSitemapPages = Math.min(sitemapUrls.length, pageLimit);
  logHF('info', `Visiting ${maxSitemapPages} pages (checking ${SUB_PAGES_PER_LINK} sub-links each)…`);

  for (let i = 0; i < maxSitemapPages; i++) {
    if (happyFlowState.abort) { logHF('warn', 'Aborted by user'); break; }

    const pageUrl = sitemapUrls[i];
    logHF('info', `[${i + 1}/${maxSitemapPages}] Opening ${pageUrl}`);

    let tab = null;
    let tabRecording = false;
    try {
      tab = await chrome.tabs.create({ url: pageUrl, active: canRecordSegment() });
      await waitForTabComplete(tab.id);
      tabRecording = await recordTabSegment(tab.id);
      await waitForContentScript(tab.id);

      // Check the sitemap page itself loaded OK
      const pageTitle = await chrome.tabs.sendMessage(tab.id, { type: 'PW_PING' }).then(() => tab.title).catch(() => '');
      logHF('success', `  ✓ Page loaded: "${pageTitle || pageUrl}"`);

      // Run full page audit (SEO, a11y, HTML, links)
      let auditData = null;
      try {
        auditData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_FULL_AUDIT' });
        const seoScore = auditData?.seo?.score ?? '—';
        const a11yScore = auditData?.accessibility?.score ?? '—';
        logHF('info', `  SEO: ${seoScore}/100 | A11y: ${a11yScore}/100 | Links: ${auditData?.totalLinks || 0}`);
      } catch {
        logHF('warn', '  Could not run page audit');
      }

      results.steps.push({ type: 'visit-page', url: pageUrl, title: pageTitle, pass: true, audit: auditData });
      if (!results.pageAudits) results.pageAudits = [];
      results.pageAudits.push({ url: pageUrl, title: pageTitle || auditData?.title || '', audit: auditData });
      totalPassed++;

      // Collect internal links from this page
      let subLinks = [];
      try {
        const linkData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_COLLECT_LINKS' });
        subLinks = (linkData?.links || []).filter((l) => l.href !== pageUrl);
        logHF('info', `  Found ${subLinks.length} internal links on this page`);
      } catch {
        logHF('warn', '  Could not collect links from page');
      }

      // Visit up to SUB_PAGES_PER_LINK internal links from this page
      const subToVisit = subLinks.slice(0, SUB_PAGES_PER_LINK);
      for (const sub of subToVisit) {
        if (happyFlowState.abort) break;
        logHF('info', `    → Checking sub-link: ${sub.text || sub.href}`);

        try {
          await chrome.tabs.update(tab.id, { url: sub.href });
          await waitForTabComplete(tab.id);
          await waitForContentScript(tab.id);

          const subTitle = await chrome.tabs.sendMessage(tab.id, { type: 'PW_PING' }).then(() => tab.title).catch(() => '');
          // Refresh tab info after navigation
          const updatedTab = await chrome.tabs.get(tab.id);
          const finalUrl = updatedTab.url || sub.href;

          // Run audit on sub-page too
          let subAudit = null;
          try {
            subAudit = await chrome.tabs.sendMessage(tab.id, { type: 'PW_FULL_AUDIT' });
          } catch { /* skip */ }

          logHF('success', `    ✓ Sub-page loaded: "${subTitle || finalUrl}"`);
          results.steps.push({ type: 'visit-subpage', url: sub.href, finalUrl, title: subTitle, parentUrl: pageUrl, text: sub.text, pass: true, audit: subAudit });
          if (!results.pageAudits) results.pageAudits = [];
          results.pageAudits.push({ url: finalUrl, title: subTitle || subAudit?.title || '', audit: subAudit, parentUrl: pageUrl });
          totalPassed++;
        } catch (err) {
          logHF('error', `    ✗ Sub-page failed: ${err.message}`);
          results.steps.push({ type: 'visit-subpage', url: sub.href, parentUrl: pageUrl, text: sub.text, pass: false, error: err.message });
          totalFailed++;
        }
      }
    } catch (err) {
      logHF('error', `  ✗ Page failed: ${err.message}`);
      results.steps.push({ type: 'visit-page', url: pageUrl, pass: false, error: err.message });
      totalFailed++;
    } finally {
      if (tabRecording) await saveTabSegment(`Nav: ${pageUrl}`);
      if (tab?.id) try { await chrome.tabs.remove(tab.id); } catch { /* */ }
    }
  }

  logHF('info', `Navigation complete: ${totalPassed} passed, ${totalFailed} failed`);
}

/* ── Link Click Flow: click every internal link on the current page ── */
async function runLinkClickFlow(baseUrl, results) {
  logHF('info', '── Link Click Test ──');
  if (!results.pageAudits) results.pageAudits = [];

  const pageUrl = baseUrl;
  let tab = null;
  let tabRecording = false;
  let totalPassed = 0, totalFailed = 0;

  try {
    // Open the current page
    tab = await chrome.tabs.create({ url: pageUrl, active: false });
    await waitForTabComplete(tab.id);
    tabRecording = await recordTabSegment(tab.id);
    await waitForContentScript(tab.id);

    const pageTitle = await chrome.tabs.sendMessage(tab.id, { type: 'PW_PING' }).then(() => tab.title).catch(() => '');
    logHF('success', `Page loaded: "${pageTitle || pageUrl}"`);

    // Run audit on the page
    let auditData = null;
    try {
      auditData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_FULL_AUDIT' });
      logHF('info', `SEO: ${auditData?.seo?.score ?? '—'}/100 | A11y: ${auditData?.accessibility?.score ?? '—'}/100 | Links: ${auditData?.totalLinks || 0}`);
    } catch { logHF('warn', 'Could not run page audit'); }

    results.steps.push({ type: 'visit-page', url: pageUrl, title: pageTitle, pass: true, audit: auditData });
    results.pageAudits.push({ url: pageUrl, title: pageTitle || auditData?.title || '', audit: auditData });

    // Collect all internal links on this page
    let pageLinks = [];
    try {
      const linkData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_COLLECT_LINKS' });
      pageLinks = (linkData?.links || []).filter((l) => l.href !== pageUrl);
      logHF('info', `Found ${pageLinks.length} internal links to click`);
    } catch {
      logHF('warn', 'Could not collect links from page');
    }

    if (!pageLinks.length) {
      logHF('warn', 'No internal links found on the page');
      results.steps.push({ type: 'link-click', pass: false, error: 'No internal links found on this page' });
      return;
    }

    logHF('info', `Clicking ${pageLinks.length} internal links one by one…`);

    // Click each internal link one by one
    for (let li = 0; li < pageLinks.length; li++) {
      if (happyFlowState.abort) { logHF('warn', 'Aborted by user'); break; }
      const link = pageLinks[li];
      const linkLabel = link.text || link.href;
      logHF('info', `[${li + 1}/${pageLinks.length}] Clicking: ${linkLabel.slice(0, 60)}`);

      try {
        // Navigate back to the source page first (if not the first link)
        if (li > 0) {
          await chrome.tabs.update(tab.id, { url: pageUrl });
          await waitForTabComplete(tab.id);
          await waitForContentScript(tab.id);
        }

        // Click the link via content script
        const clickResult = await chrome.tabs.sendMessage(tab.id, { type: 'PW_CLICK_LINK', href: link.href });
        if (!clickResult?.clicked) {
          logHF('warn', `  ⊘ Could not click — ${clickResult?.error || 'unknown'}`);
          results.steps.push({ type: 'link-click', url: link.href, parentUrl: pageUrl, text: link.text, pass: false, error: clickResult?.error || 'Click failed' });
          totalFailed++;
          continue;
        }

        // Give browser time to initiate navigation from the click
        await delay(800);
        try { await waitForTabComplete(tab.id); } catch { /* timeout ok, verify below */ }
        await delay(400);

        // Verify the page loaded
        const updatedTab = await chrome.tabs.get(tab.id);
        const finalUrl = updatedTab.url || link.href;

        let loadOk = true;
        let subTitle = '';
        try {
          await waitForContentScript(tab.id);
          await chrome.tabs.sendMessage(tab.id, { type: 'PW_PING' });
          const freshTab = await chrome.tabs.get(tab.id);
          subTitle = freshTab.title || '';
        } catch {
          loadOk = false;
        }

        if (loadOk) {
          logHF('success', `  ✓ Loaded: "${subTitle || finalUrl}"`);
          results.steps.push({ type: 'link-click', url: link.href, finalUrl, parentUrl: pageUrl, text: link.text, title: subTitle, pass: true });
          totalPassed++;
        } else {
          logHF('error', `  ✗ Failed to load after click`);
          results.steps.push({ type: 'link-click', url: link.href, finalUrl, parentUrl: pageUrl, text: link.text, pass: false, error: 'Page did not respond after click' });
          totalFailed++;
        }
      } catch (err) {
        logHF('error', `  ✗ Error: ${err.message}`);
        results.steps.push({ type: 'link-click', url: link.href, parentUrl: pageUrl, text: link.text, pass: false, error: err.message });
        totalFailed++;
      }
    }
  } catch (err) {
    logHF('error', `Page failed to load: ${err.message}`);
    results.steps.push({ type: 'visit-page', url: pageUrl, pass: false, error: err.message });
  } finally {
    if (tabRecording) await saveTabSegment(`LinkClick: ${pageUrl}`);
    if (tab?.id) try { await chrome.tabs.remove(tab.id); } catch { /* */ }
  }

  logHF('success', `Link Click Test complete: ${totalPassed + totalFailed} links clicked, ${totalPassed} passed, ${totalFailed} failed`);
}

/* ── Deep Crawl: discover & visit all page types (categories, details, search, company) ── */
async function runDeepCrawl(baseUrl, results, maxPages) {
  logHF('info', '══ Deep Crawl — All Page Types ══');
  if (!results.pageAudits) results.pageAudits = [];
  const limit = maxPages || 5;
  logHF('info', `Max pages limit: ${limit}`);

  const origin = new URL(baseUrl).origin;
  const visited = new Set();
  let totalPassed = 0, totalFailed = 0;

  // Classify a URL into page type based on path patterns
  function classifyUrl(href) {
    try {
      const path = new URL(href).pathname.toLowerCase();
      // Category / listing pages
      if (/^\/(remote-jobs|jobs|categories|category|positions|roles)(\/[a-z0-9-]+)?$/.test(path)) return 'category';
      // Job detail pages
      if (/\/(job|jobs|remote-jobs)\/[a-z0-9-]+-\d+/.test(path) || /\/(job|position|listing|career)\/[^/]+$/.test(path)) return 'job-detail';
      // Company pages
      if (/^\/(company|companies|employer|org)(\/[^/]+)?$/.test(path)) return 'company';
      // Search pages
      if (/\/(search|find|browse)/.test(path) || href.includes('?s=') || href.includes('?search=') || href.includes('?q=')) return 'search';
      // Blog / resources
      if (/^\/(blog|resources|news|articles)(\/.*)?$/.test(path)) return 'blog';
      // About / static pages
      if (/^\/(about|contact|faq|help|pricing|terms|privacy|sitemap)/.test(path)) return 'static';
      // Home
      if (path === '/' || path === '') return 'home';
      return 'other';
    } catch { return 'other'; }
  }

  // Helper: visit a page, run audit, collect links
  async function visitAndAudit(url, pageType, label) {
    if (visited.has(url) || happyFlowState.abort) return null;
    visited.add(url);

    logHF('info', `[${pageType.toUpperCase()}] ${label || url}`);
    let tab = null;
    let tabRecording = false;
    try {
      tab = await chrome.tabs.create({ url, active: canRecordSegment() });
      await waitForTabComplete(tab.id);
      tabRecording = await recordTabSegment(tab.id);
      await waitForContentScript(tab.id);

      const pageTitle = await chrome.tabs.sendMessage(tab.id, { type: 'PW_PING' }).then(() => tab.title).catch(() => '');

      // Run full audit
      let auditData = null;
      try {
        auditData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_FULL_AUDIT' });
        logHF('info', `  SEO: ${auditData?.seo?.score ?? '—'}/100 | A11y: ${auditData?.accessibility?.score ?? '—'}/100 | Links: ${auditData?.totalLinks || 0}`);
      } catch { logHF('warn', '  Audit skipped'); }

      // Classify page from content script too
      let pageClass = null;
      try {
        pageClass = await chrome.tabs.sendMessage(tab.id, { type: 'PW_CLASSIFY_PAGE' });
      } catch { /* skip */ }

      logHF('success', `  ✓ ${pageType}: "${pageTitle || url}"`);
      results.steps.push({ type: 'visit-page', url, title: pageTitle, pass: true, audit: auditData, pageType, contentClass: pageClass });
      results.pageAudits.push({ url, title: pageTitle || auditData?.title || '', audit: auditData, pageType });
      totalPassed++;

      // Collect links for further crawling
      let links = [];
      try {
        const linkData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_COLLECT_LINKS' });
        links = linkData?.links || [];
      } catch { /* skip */ }

      return links;
    } catch (err) {
      logHF('error', `  ✗ ${pageType} failed: ${err.message}`);
      results.steps.push({ type: 'visit-page', url, pass: false, error: err.message, pageType });
      totalFailed++;
      return null;
    } finally {
      if (tabRecording) await saveTabSegment(`Crawl: ${pageType} — ${url}`);
      if (tab?.id) try { await chrome.tabs.remove(tab.id); } catch { /* */ }
    }
  }

  // Step 1: Visit home/base page and collect all internal links
  logHF('info', '── Phase 1: Discover all links from base page ──');
  const homeLinks = await visitAndAudit(baseUrl, 'home', 'Home page');
  const allLinks = new Map(); // href → { href, text, type }
  if (homeLinks) {
    for (const l of homeLinks) {
      if (l.href.startsWith(origin)) {
        allLinks.set(l.href, { ...l, type: classifyUrl(l.href) });
      }
    }
  }

  // Also try fetching sitemap for more URLs
  try {
    logHF('info', 'Fetching sitemap for additional URLs…');
    const sitemapRes = await fetchSitemap({ url: baseUrl });
    if (sitemapRes?.urls?.length) {
      logHF('success', `Sitemap: ${sitemapRes.urls.length} URLs`);
      results.steps.push({ type: 'sitemap-found', url: sitemapRes.sitemapUrl, totalUrls: sitemapRes.urls.length, pass: true });
      for (const u of sitemapRes.urls) {
        if (!allLinks.has(u)) {
          allLinks.set(u, { href: u, text: '', type: classifyUrl(u) });
        }
      }
    }
  } catch { logHF('warn', 'No sitemap found — using discovered links only'); }

  // Group URLs by type
  const buckets = { category: [], 'job-detail': [], company: [], search: [], blog: [], static: [], other: [] };
  for (const [href, info] of allLinks) {
    if (visited.has(href)) continue;
    if (buckets[info.type]) buckets[info.type].push(info);
    else buckets.other.push(info);
  }

  // Helper: feed newly discovered links into buckets
  function feedLinks(links) {
    if (!links) return;
    for (const l of links) {
      if (!l.href.startsWith(origin) || allLinks.has(l.href) || visited.has(l.href)) continue;
      const t = classifyUrl(l.href);
      allLinks.set(l.href, { ...l, type: t });
      if (buckets[t]) buckets[t].push({ ...l, type: t });
      else buckets.other.push({ ...l, type: t });
    }
  }

  logHF('info', `Discovered: ${buckets.category.length} categories, ${buckets['job-detail'].length} jobs, ${buckets.company.length} companies, ${buckets.search.length} search, ${buckets.blog.length} blog, ${buckets.static.length} static, ${buckets.other.length} other`);

  // Distribute page budget across categories proportionally
  const catLimit = Math.max(1, Math.ceil(limit * 0.25));
  const jobLimit = Math.max(1, Math.ceil(limit * 0.2));
  const compLimit = Math.max(1, Math.ceil(limit * 0.15));
  const searchLimit = Math.max(1, Math.ceil(limit * 0.1));
  const blogLimit = Math.max(1, Math.ceil(limit * 0.1));
  const staticLimit = Math.max(1, Math.ceil(limit * 0.1));
  const otherLimit = Math.max(1, Math.ceil(limit * 0.1));

  // Step 2: Visit category/listing pages
  const categoryPages = buckets.category.slice(0, catLimit);
  if (categoryPages.length) {
    logHF('info', `── Phase 2: Category pages (${categoryPages.length}) ──`);
    for (const cat of categoryPages) {
      if (happyFlowState.abort) break;
      const catLinks = await visitAndAudit(cat.href, 'category', cat.text || cat.href);
      feedLinks(catLinks);
    }
  }

  // Step 3: Visit job detail pages
  const jobPages = buckets['job-detail'].filter((j) => !visited.has(j.href)).slice(0, jobLimit);
  if (jobPages.length) {
    logHF('info', `── Phase 3: Job detail pages (${jobPages.length}) ──`);
    for (const job of jobPages) {
      if (happyFlowState.abort) break;
      const jobLinks = await visitAndAudit(job.href, 'job-detail', job.text || job.href);
      feedLinks(jobLinks);
    }
  }

  // Step 4: Visit company pages
  const companyPages = buckets.company.filter((c) => !visited.has(c.href)).slice(0, compLimit);
  if (companyPages.length) {
    logHF('info', `── Phase 4: Company pages (${companyPages.length}) ──`);
    for (const comp of companyPages) {
      if (happyFlowState.abort) break;
      const compLinks = await visitAndAudit(comp.href, 'company', comp.text || comp.href);
      feedLinks(compLinks);
    }
  }

  // Step 5: Visit search pages
  const searchPages = buckets.search.filter((s) => !visited.has(s.href)).slice(0, searchLimit);
  if (searchPages.length) {
    logHF('info', `── Phase 5: Search pages (${searchPages.length}) ──`);
    for (const sp of searchPages) {
      if (happyFlowState.abort) break;
      const spLinks = await visitAndAudit(sp.href, 'search', sp.text || sp.href);
      feedLinks(spLinks);
    }
  } else {
    // Try constructing a search page URL
    const searchUrl = `${origin}/remote-jobs?search=developer`;
    if (!visited.has(searchUrl)) {
      logHF('info', '── Phase 5: Testing search page ──');
      const spLinks = await visitAndAudit(searchUrl, 'search', 'Search: developer');
      feedLinks(spLinks);
    }
  }

  // Step 6: Visit blog/resource pages
  const blogPages = buckets.blog.filter((b) => !visited.has(b.href)).slice(0, blogLimit);
  if (blogPages.length) {
    logHF('info', `── Phase 6: Blog/Resource pages (${blogPages.length}) ──`);
    for (const bp of blogPages) {
      if (happyFlowState.abort) break;
      const bpLinks = await visitAndAudit(bp.href, 'blog', bp.text || bp.href);
      feedLinks(bpLinks);
    }
  }

  // Step 7: Visit static pages (about, contact, etc)
  const staticPages = buckets.static.filter((s) => !visited.has(s.href)).slice(0, staticLimit);
  if (staticPages.length) {
    logHF('info', `── Phase 7: Static pages (${staticPages.length}) ──`);
    for (const sp of staticPages) {
      if (happyFlowState.abort) break;
      const stLinks = await visitAndAudit(sp.href, 'static', sp.text || sp.href);
      feedLinks(stLinks);
    }
  }

  // Step 8: Visit remaining uncategorized pages
  const otherPages = buckets.other.filter((o) => !visited.has(o.href)).slice(0, otherLimit);
  if (otherPages.length) {
    logHF('info', `── Phase 8: Other pages (${otherPages.length}) ──`);
    for (const op of otherPages) {
      if (happyFlowState.abort) break;
      const opLinks = await visitAndAudit(op.href, 'other', op.text || op.href);
      feedLinks(opLinks);
    }
  }

  // Step 9: Crawl any newly discovered links from all phases (second pass)
  const secondPassLinks = [];
  for (const [href, info] of allLinks) {
    if (visited.has(href)) continue;
    secondPassLinks.push(info);
  }
  const secondPass = secondPassLinks.slice(0, Math.max(1, Math.ceil(limit * 0.3)));
  if (secondPass.length) {
    logHF('info', `── Phase 9: Second-pass internal links (${secondPass.length} new) ──`);
    for (const lnk of secondPass) {
      if (happyFlowState.abort) break;
      await visitAndAudit(lnk.href, lnk.type || 'other', lnk.text || lnk.href);
    }
  }

  logHF('info', `Deep crawl complete: ${totalPassed} passed, ${totalFailed} failed, ${visited.size} unique pages visited`);
  results.steps.push({ type: 'crawl-summary', pass: true, totalVisited: visited.size, totalPassed, totalFailed, buckets: {
    category: categoryPages.length, jobDetail: jobPages.length, company: companyPages.length,
    search: searchPages.length || 1, blog: blogPages.length, static: staticPages.length,
    secondPass: secondPass.length,
  }});
}

async function runFormFlow(baseUrl, results) {
  logHF('info', '── Form Submit Flow ──');
  let tab = null;
  let tabRecording = false;
  try {
    tab = await chrome.tabs.create({ url: baseUrl, active: canRecordSegment() });
    await waitForTabComplete(tab.id);
    tabRecording = await recordTabSegment(tab.id);
    await waitForContentScript(tab.id);

    const formData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_TEST_FORMS' });
    if (formData?.forms?.length) {
      for (const form of formData.forms) {
        const pass = form.validationErrors.length === 0 && form.submitted;
        results.steps.push({
          type: 'form-test', formId: form.id, fields: form.fields.length,
          submitted: form.submitted, validationErrors: form.validationErrors,
          successIndicator: form.successIndicator, pass,
        });
        logHF(pass ? 'success' : 'warn',
          `  Form "${form.id}": ${form.fields.length} fields filled, submitted=${form.submitted}, errors=${form.validationErrors.length}${form.successIndicator ? ', success: ' + form.successIndicator.slice(0, 60) : ''}`);
      }
    } else {
      logHF('warn', '  No forms found on this page');
      results.steps.push({ type: 'form-test', pass: false, error: 'No forms found' });
    }
  } finally {
    if (tabRecording) await saveTabSegment('Form Flow');
    if (tab?.id) try { await chrome.tabs.remove(tab.id); } catch { /* */ }
  }
}

async function runLoginFlow(baseUrl, results, email, password) {
  logHF('info', '── Login Flow ──');
  if (!email || !password) {
    logHF('warn', 'No test credentials — set email & password in Settings');
    results.steps.push({ type: 'login', pass: false, error: 'No test credentials configured in Settings' });
    return;
  }

  // Step 1: Find the login page URL
  const loginPaths = ['/login', '/signin', '/sign-in', '/auth/login', '/account/login', '/users/sign_in', '/log-in', '/auth', '/session/new', '/wp-login.php', '/members/login', '/user/login', '/account/signin', '/portal/login'];
  let loginUrl = null;
  let tab = null;
  let tabRecording = false;

  try {
    const origin = new URL(baseUrl).origin;

    // Try common login paths first
    logHF('info', '  Searching for login page…');
    for (const path of loginPaths) {
      if (happyFlowState.abort) break;
      const candidate = origin + path;
      try {
        const res = await checkUrl({ url: candidate });
        if (res?.ok && res.status < 400) {
          loginUrl = candidate;
          logHF('success', `  Found login page at ${candidate}`);
          break;
        }
      } catch { /* skip */ }
    }

    // If no common path worked, open base URL and look for a login link
    if (!loginUrl) {
      logHF('info', '  No common login path found — scanning base page for login link…');
      tab = await chrome.tabs.create({ url: baseUrl, active: false });
      await waitForTabComplete(tab.id);
      await waitForContentScript(tab.id);

      const linkData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_COLLECT_LINKS' });
      const links = linkData?.links || [];
      const loginLink = links.find((l) => {
        const lower = (l.href + ' ' + l.text).toLowerCase();
        return lower.includes('login') || lower.includes('signin') || lower.includes('sign-in') || lower.includes('sign in') || lower.includes('log in');
      });
      if (loginLink) {
        loginUrl = loginLink.href;
        logHF('success', `  Found login link: "${loginLink.text}" → ${loginUrl}`);
      }
      await chrome.tabs.remove(tab.id).catch(() => {});
      tab = null;
    }

    if (!loginUrl) {
      // Last resort: try the base URL itself (maybe it IS the login page)
      loginUrl = baseUrl;
      logHF('warn', '  No login page found — trying base URL as login page');
    }

    results.steps.push({ type: 'find-login-page', url: loginUrl, pass: true });

    // Step 2: Open login page and attempt login (with recording)
    tab = await chrome.tabs.create({ url: loginUrl, active: canRecordSegment() });
    await waitForTabComplete(tab.id);
    tabRecording = await recordTabSegment(tab.id);
    await waitForContentScript(tab.id);

    logHF('info', `  Attempting login at ${loginUrl} with ${email}…`);

    // Send login message + monitor tab URL for redirect from background side.
    // Key insight: when login succeeds with a full-page redirect, the content
    // script is destroyed and sendMessage returns an error. We detect success
    // by checking if the tab URL changed.
    const tabId = tab.id;
    let loginData = null;
    let messageError = false;

    try {
      loginData = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { type: 'PW_TEST_LOGIN', email, password }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    } catch {
      // Content script was destroyed (page navigated) → likely a successful login redirect
      messageError = true;
    }

    // Check the tab's current URL to detect redirects
    let finalTabUrl = loginUrl;
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      finalTabUrl = tabInfo.url || loginUrl;
    } catch { /* tab may be closed */ }

    const redirected = finalTabUrl !== loginUrl;

    if (loginData) {
      // Content script responded (stayed on same page or SPA navigation)
      const pass = loginData.success || redirected;
      const stepsToLog = loginData.steps || [];
      if (redirected && !loginData.redirectedTo) {
        stepsToLog.push({ action: 'redirect', to: finalTabUrl });
        loginData.redirectedTo = finalTabUrl;
      }
      results.steps.push({ type: 'login', pass, steps: stepsToLog, redirectedTo: loginData.redirectedTo || finalTabUrl, loginError: loginData.loginError });
      for (const s of stepsToLog) {
        if (s.action === 'error-detected') logHF('error', `  Login error: ${s.message}`);
        else if (s.action === 'redirect') logHF('info', `  Redirected → ${s.to}`);
        else if (s.action === 'success-indicator') logHF('success', `  Dashboard indicator found: ${s.element}`);
        else logHF('info', `  ${s.action}: ${s.field || s.button || ''}`);
      }
      logHF(pass ? 'success' : 'warn', `  Login ${pass ? 'succeeded' : 'failed'}`);
    } else if (messageError && redirected) {
      // Content script destroyed + URL changed = successful login redirect
      logHF('success', `  Login succeeded — redirected to ${finalTabUrl}`);
      results.steps.push({
        type: 'login', pass: true,
        steps: [{ action: 'redirect', to: finalTabUrl }],
        redirectedTo: finalTabUrl,
      });
    } else if (messageError) {
      // Content script destroyed but URL didn't change — wait and re-check
      logHF('info', '  Waiting for redirect…');
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const tabInfo2 = await chrome.tabs.get(tabId);
        finalTabUrl = tabInfo2.url || loginUrl;
      } catch { /* tab closed */ }

      if (finalTabUrl !== loginUrl) {
        logHF('success', `  Login succeeded — redirected to ${finalTabUrl}`);
        results.steps.push({
          type: 'login', pass: true,
          steps: [{ action: 'redirect', to: finalTabUrl }],
          redirectedTo: finalTabUrl,
        });
      } else {
        logHF('warn', '  Login failed — no redirect detected');
        results.steps.push({ type: 'login', pass: false, error: 'No redirect after login attempt' });
      }
    } else {
      results.steps.push({ type: 'login', pass: false, error: 'No response from content script' });
      logHF('error', '  No response from login flow');
    }
  } finally {
    if (tabRecording) await saveTabSegment('Login Flow');
    if (tab?.id) try { await chrome.tabs.remove(tab.id); } catch { /* */ }
  }
}

async function runSitemapCheck(baseUrl, results) {
  logHF('info', '── Sitemap Check ──');
  try {
    const sitemapRes = await fetchSitemap({ url: baseUrl });
    if (sitemapRes?.urls?.length) {
      logHF('success', `Sitemap found at ${sitemapRes.sitemapUrl}: ${sitemapRes.urls.length} URLs`);
      results.steps.push({ type: 'sitemap', pass: true, sitemapUrl: sitemapRes.sitemapUrl, totalUrls: sitemapRes.urls.length });
    } else {
      logHF('warn', 'Sitemap returned no URLs');
      results.steps.push({ type: 'sitemap', pass: false, error: 'Empty sitemap' });
    }
  } catch {
    logHF('warn', 'Sitemap not found');
    results.steps.push({ type: 'sitemap', pass: false, error: 'Sitemap not found' });
  }
}

/* ── Code Enhancement ── */
async function enhanceCode(token, payload) {
  if (!payload) throw new Error('Missing enhancement parameters.');
  if (!token) throw new Error('GitHub token not configured. Go to Settings.');

  const { code, enhancement } = payload;

  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are a Puppeteer test expert. Enhance the given test code based on the request. Return ONLY the enhanced code, no explanations.`,
        },
        {
          role: 'user',
          content: `Original code:\n\`\`\`javascript\n${code}\n\`\`\`\n\nEnhancement request: ${enhancement}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) throw new Error(`Enhancement failed (${res.status})`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  return { code: extractCodeBlock(content) };
}

/* ── Test Execution via GitHub Actions ── */
async function runTests(token, payload) {
  if (!payload) throw new Error('Missing test parameters.');
  if (!token) throw new Error('GitHub token not configured. Go to Settings.');

  const { environment, suites } = payload;

  // Get saved repo config
  const config = await chrome.storage.local.get(['pw_selected_repo']);
  const repo = config.pw_selected_repo;

  if (!repo) {
    throw new Error('No repository selected. Configure a repo in the Suites tab.');
  }

  // Dispatch workflow
  const dispatchRes = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/workflows/playwright.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: repo.defaultBranch || 'main',
        inputs: {
          base_url: environment,
          test_count: String(suites.length),
        },
      }),
    }
  );

  if (!dispatchRes.ok) {
    const body = await dispatchRes.text();
    throw new Error(`Workflow dispatch failed (${dispatchRes.status}): ${body.slice(0, 200)}`);
  }

  // Return mock results since workflow runs async
  return {
    results: suites.map((_, i) => ({
      name: `Test Suite ${i + 1}`,
      status: 'pending',
      duration: '—',
    })),
  };
}

/* ── Local Test Execution ── */
async function executeTest(payload) {
  if (!payload || !payload.code) throw new Error('No test code provided.');

  const { code } = payload;
  const steps = parseTestCode(code);

  if (!steps.length) throw new Error('No executable steps found in the test code.');

  const results = [];
  let passed = 0;
  let failed = 0;
  let tabId = null;
  let videoDataUrl = null;

  try {
    // Find first navigate URL to open the test tab
    const firstNav = steps.find((s) => s.action === 'navigate');
    if (!firstNav) throw new Error('Test must contain at least one page.goto() navigation.');

    const tab = await chrome.tabs.create({ url: firstNav.url, active: true });
    tabId = tab.id;

    await waitForTabComplete(tabId);
    await waitForContentScript(tabId);

    // Start video recording
    const recordingStarted = await startTabRecording(tabId);

    // Mark first navigate as passed
    const navStart = Date.now();
    results.push({
      name: firstNav.description,
      action: 'navigate',
      status: 'pass',
      duration: `${Date.now() - navStart}ms`,
    });
    passed++;

    // Execute remaining steps
    for (const step of steps) {
      if (step === firstNav) continue;

      const startTime = Date.now();
      let result;

      try {
        if (step.action === 'navigate') {
          await chrome.tabs.update(tabId, { url: step.url });
          await waitForTabComplete(tabId);
          await waitForContentScript(tabId);
          result = { pass: true };
        } else if (step.action === 'waitForLoad') {
          await delay(1500);
          result = { pass: true };
        } else if (step.action === 'screenshot') {
          result = { pass: true };
        } else {
          result = await chrome.tabs.sendMessage(tabId, { type: 'PW_RUN_STEP', step });
        }
      } catch (err) {
        result = { pass: false, error: err.message };
      }

      const duration = Date.now() - startTime;
      const stepResult = {
        name: step.description,
        action: step.action,
        status: result.pass ? 'pass' : 'fail',
        error: result.error || null,
        duration: `${duration}ms`,
      };
      results.push(stepResult);

      if (result.pass) passed++;
      else failed++;

      // Stop on critical failures (navigation or element interaction)
      if (!result.pass && ['navigate', 'click', 'type', 'waitForSelector'].includes(step.action)) {
        // Mark remaining steps as skipped
        const remaining = steps.filter((s) => s !== firstNav && !results.find((r) => r.name === s.description));
        remaining.forEach((s) => {
          results.push({ name: s.description, action: s.action, status: 'skip', duration: '—' });
        });
        break;
      }
    }

    // Stop video recording and get data
    if (recordingStarted) {
      videoDataUrl = await stopTabRecording();
    }
  } catch (err) {
    results.push({ name: 'Setup', action: 'setup', status: 'fail', error: err.message, duration: '0ms' });
    failed++;
    // Try to stop recording even on error
    try { videoDataUrl = await stopTabRecording(); } catch { /* ignore */ }
  }

  await closeOffscreenDocument();

  const skipped = results.filter((r) => r.status === 'skip').length;
  const testResult = { results, summary: { total: steps.length, passed, failed, skipped }, tabId, videoDataUrl };

  // Auto-save test run report to storage
  try {
    await autoSaveTestRunReport(testResult);
  } catch (e) { console.warn('[TestRun] Auto-save failed:', e); }

  return testResult;
}

/* Extract quoted arguments from method calls, handling nested quotes correctly */
function extractQuotedArgs(line, method) {
  const idx = line.indexOf(method + '(');
  if (idx === -1) return null;
  const args = [];
  let pos = idx + method.length + 1;
  while (pos < line.length && args.length < 3) {
    while (pos < line.length && /[\s,]/.test(line[pos])) pos++;
    const q = line[pos];
    if (q !== "'" && q !== '"' && q !== '`') break;
    pos++;
    let start = pos;
    while (pos < line.length) {
      if (line[pos] === '\\') { pos += 2; continue; }
      if (line[pos] === q) break;
      pos++;
    }
    args.push(line.slice(start, pos));
    pos++;
  }
  return args.length > 0 ? args : null;
}

function parseTestCode(code) {
  const steps = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;

    // page.goto(url)
    if (line.includes('page.goto')) {
      const args = extractQuotedArgs(line, 'page.goto');
      if (args) {
        steps.push({ action: 'navigate', url: args[0], description: `Navigate to ${args[0]}` });
        continue;
      }
    }

    // page.waitForSelector(selector)
    if (line.includes('page.waitForSelector')) {
      const args = extractQuotedArgs(line, 'page.waitForSelector');
      if (args) {
        steps.push({ action: 'waitForSelector', selector: args[0], description: `Wait for "${args[0]}"` });
        continue;
      }
    }

    // page.click(selector)
    if (line.includes('page.click')) {
      const args = extractQuotedArgs(line, 'page.click');
      if (args) {
        steps.push({ action: 'click', selector: args[0], description: `Click "${args[0]}"` });
        continue;
      }
    }

    // page.type(selector, text)
    if (line.includes('page.type')) {
      const args = extractQuotedArgs(line, 'page.type');
      if (args && args.length >= 2) {
        steps.push({ action: 'type', selector: args[0], value: args[1], description: `Type "${args[1]}" into "${args[0]}"` });
        continue;
      }
    }

    // page.select(selector, value)
    if (line.includes('page.select')) {
      const args = extractQuotedArgs(line, 'page.select');
      if (args && args.length >= 2) {
        steps.push({ action: 'select', selector: args[0], value: args[1], description: `Select "${args[1]}" in "${args[0]}"` });
        continue;
      }
    }

    // page.hover(selector)
    if (line.includes('page.hover')) {
      const args = extractQuotedArgs(line, 'page.hover');
      if (args) {
        steps.push({ action: 'hover', selector: args[0], description: `Hover over "${args[0]}"` });
        continue;
      }
    }

    // page.keyboard.press(key)
    if (line.includes('page.keyboard.press')) {
      const args = extractQuotedArgs(line, 'page.keyboard.press');
      if (args) {
        steps.push({ action: 'press', key: args[0], description: `Press key "${args[0]}"` });
        continue;
      }
    }

    // page.waitForNavigation / waitForNetworkIdle / networkidle
    if (line.includes('waitForNavigation') || line.includes('waitForNetworkIdle') || line.includes('networkidle')) {
      steps.push({ action: 'waitForLoad', description: 'Wait for page load' });
      continue;
    }

    // page.screenshot
    if (line.includes('page.screenshot')) {
      steps.push({ action: 'screenshot', description: 'Capture screenshot' });
      continue;
    }

    // page.$eval(selector, fn) — look ahead for assertion
    const evalArgs = line.includes('page.$eval') ? extractQuotedArgs(line, 'page.$eval') : null;
    if (evalArgs) {
      const selector = evalArgs[0];
      // Check next lines for expect().toContain()
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const nextLine = lines[j].trim();
        const assertMatch = nextLine.match(/expect\(.*?\)\.toContain\(\s*['"`]([^'"`]*)['"`]\)/);
        if (assertMatch) {
          steps.push({ action: 'assertText', selector, expected: assertMatch[1], description: `Assert "${selector}" contains "${assertMatch[1]}"` });
          i = j; // Skip the expect line
          break;
        }
      }
      continue;
    }

    // expect(...).not.toBeNull — element existence
    if (line.includes('expect(') && line.includes('not.toBeNull')) {
      // Try to find the selector from previous $() call
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const prevArgs = extractQuotedArgs(lines[j].trim(), 'page.$');
        if (prevArgs) {
          steps.push({ action: 'assertVisible', selector: prevArgs[0], description: `Assert "${prevArgs[0]}" exists` });
          break;
        }
      }
      continue;
    }

    // page.evaluate(() => window.scrollBy(x, y))
    const scrollMatch = line.match(/window\.scrollBy\(\s*(\d+)\s*,\s*(\d+)\)/);
    if (scrollMatch) {
      steps.push({ action: 'scroll', deltaX: parseInt(scrollMatch[1]), deltaY: parseInt(scrollMatch[2]), description: `Scroll by (${scrollMatch[1]}, ${scrollMatch[2]})` });
      continue;
    }
  }

  return steps;
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Navigation timeout (30s)'));
    }, 30000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        // Extra delay for content script injection
        delay(500).then(resolve);
      }
    }

    // Check if already complete
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timeout);
        delay(500).then(resolve);
      } else {
        chrome.tabs.onUpdated.addListener(listener);
      }
    }).catch(() => {
      clearTimeout(timeout);
      reject(new Error('Tab not found'));
    });
  });
}

async function waitForContentScript(tabId) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'PW_PING' });
      if (response === 'pong') return true;
    } catch { /* content script not ready */ }
    await delay(200);
  }
  throw new Error('Content script not ready after 10s');
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── Extension Install Handler ── */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({ pw_suites: [] });
  }
});

/* ── Sitemap Fetching ── */
async function fetchSitemap(payload) {
  if (!payload?.url) throw new Error('URL is required.');
  const base = payload.url.replace(/\/+$/, '');

  // Try multiple common sitemap paths
  const candidates = [
    `${base}/sitemap_index.xml`,
    `${base}/sitemap.xml`,
    `${base}/sitemap_index.xml.gz`,
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/xml, application/xml, text/html, */*',
  };

  let text = null;
  let sitemapUrl = null;

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok) {
        text = await res.text();
        sitemapUrl = url;
        break;
      }
    } catch { /* try next */ }
  }

  if (!text) {
    // Try robots.txt to discover sitemap URLs
    try {
      const robotsRes = await fetch(`${base}/robots.txt`, { headers });
      if (robotsRes.ok) {
        const robotsTxt = await robotsRes.text();
        const sitemapMatches = robotsTxt.match(/^Sitemap:\s*(.+)$/gim) || [];
        for (const line of sitemapMatches) {
          const smUrl = line.replace(/^Sitemap:\s*/i, '').trim();
          try {
            const smRes = await fetch(smUrl, { headers });
            if (smRes.ok) {
              text = await smRes.text();
              sitemapUrl = smUrl;
              break;
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip robots.txt */ }
  }

  if (!text) throw new Error(`No sitemap found at ${candidates.join(', ')}`);

  // Check if this is a sitemap index (contains <sitemap> entries pointing to child sitemaps)
  const childSitemapRegex = /<sitemap>\s*<loc>\s*(.*?)\s*<\/loc>/g;
  const childUrls = [];
  let cm;
  while ((cm = childSitemapRegex.exec(text)) !== null) {
    childUrls.push(cm[1]);
  }

  const allPageUrls = [];

  if (childUrls.length > 0) {
    // This is a sitemap index — fetch each child sitemap
    for (const childUrl of childUrls) {
      try {
        const childRes = await fetch(childUrl, { headers });
        if (!childRes.ok) continue;
        const childText = await childRes.text();
        const locRegex = /<loc>\s*(.*?)\s*<\/loc>/g;
        let lm;
        while ((lm = locRegex.exec(childText)) !== null) {
          // Skip entries that look like child sitemaps themselves
          if (!lm[1].endsWith('.xml')) {
            allPageUrls.push(lm[1]);
          }
        }
      } catch { /* skip failed child sitemap */ }
    }
  } else {
    // Regular sitemap — extract <loc> entries directly
    const locRegex = /<loc>\s*(.*?)\s*<\/loc>/g;
    let lm;
    while ((lm = locRegex.exec(text)) !== null) {
      allPageUrls.push(lm[1]);
    }
  }

  if (!allPageUrls.length) throw new Error('No page URLs found in sitemap.');
  return { urls: allPageUrls, sitemapUrl, childSitemaps: childUrls.length };
}

/* ── URL Health Check ── */
async function checkUrl(payload) {
  if (!payload?.url) return { url: '', status: 0, ok: false };

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html, application/xhtml+xml, */*',
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    // Try HEAD first
    let res = await fetch(payload.url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers,
    });

    // Many servers reject HEAD or return 4xx/5xx — fall back to GET
    if (!res.ok && res.status >= 400) {
      const controller2 = new AbortController();
      const timeoutId2 = setTimeout(() => controller2.abort(), 15000);
      try {
        res = await fetch(payload.url, {
          method: 'GET',
          signal: controller2.signal,
          redirect: 'follow',
          headers,
        });
      } finally {
        clearTimeout(timeoutId2);
      }
    }

    clearTimeout(timeoutId);
    return { url: payload.url, status: res.status, ok: res.ok };
  } catch (err) {
    return { url: payload.url, status: 0, ok: false, error: err.message };
  }
}

/* ── Tab Screenshot Capture ── */
async function captureTab(payload) {
  try {
    const windowId = payload?.windowId;
    const opts = { format: 'png' };
    // Ensure the window is focused — captureVisibleTab requires it
    if (windowId) {
      try { await chrome.windows.update(windowId, { focused: true }); } catch { /* ignore */ }
      await delay(200);
    }
    const dataUrl = windowId
      ? await chrome.tabs.captureVisibleTab(windowId, opts)
      : await chrome.tabs.captureVisibleTab(opts);
    return { dataUrl };
  } catch (err) {
    return { error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════
   ██  SITE AUDIT ENGINE (runs entirely in background)  ██
   ═══════════════════════════════════════════════════════════ */
let auditState = {
  running: false,
  abort: false,
  progress: 0,
  progressText: '',
  report: null,
  logs: [],
};

function getAuditStatus() {
  return {
    running: auditState.running,
    progress: auditState.progress,
    progressText: auditState.progressText,
    report: auditState.report,
    logs: auditState.logs,
  };
}

function logAudit(level, message) {
  const entry = { time: new Date().toISOString().slice(11, 19), level, message };
  auditState.logs.push(entry);
  console.log(`[audit:${level}] ${message}`);
  // Push to any connected popup ports
  for (const port of auditPorts) {
    try { port.postMessage({ type: 'AUDIT_LOG', entry }); } catch { /* disconnected */ }
  }
}

function stopSiteAudit() {
  auditState.abort = true;
  return { stopped: true };
}

function updateProgress(pct, text) {
  auditState.progress = pct;
  auditState.progressText = text;
}

async function startSiteAudit(payload) {
  if (auditState.running) return { error: 'Audit already running' };
  if (!payload?.baseUrl) return { error: 'URL is required' };

  const opts = payload;
  auditState = {
    running: true,
    abort: false,
    progress: 5,
    progressText: 'Starting audit…',
    report: null,
    logs: [],
  };

  logAudit('info', `Audit started for ${payload.baseUrl}`);
  logAudit('info', `Options — sitemap: ${payload.checkSitemap ?? true}, links: ${payload.checkLinks ?? true}, freeJobs: ${payload.checkFreeJobs ?? true}, maxPages: ${payload.maxPages || 20}`);

  // MV3 keepalive: use chrome.alarms (Chrome keeps SW alive during alarm event processing)
  chrome.alarms.create('audit-keepalive', { periodInMinutes: 0.4 });

  // Run audit — store globally so the runtime tracks the promise chain
  globalThis.__auditPromise = runAuditAsync(opts).catch((err) => {
    logAudit('error', `Audit failed: ${err.message}`);
    auditState.progressText = `Failed: ${err.message}`;
    auditState.progress = 100;
    auditState.running = false;
    chrome.alarms.clear('audit-keepalive');
  });

  return { started: true };
}

async function runAuditAsync(opts) {
  const {
    baseUrl,
    checkSitemap = true,
    checkLinks = true,
    checkFreeJobs = true,
    freeJobLimit = 2,
    maxPages = 5,
  } = opts;

  const report = {
    baseUrl,
    startedAt: new Date().toISOString(),
    sitemap: null,
    pages: [],
    brokenLinks: [],
    paywallResults: null,
    seoResults: [],
    accessibilityResults: [],
    htmlResults: [],
    mobileResults: [],
    summary: {
      totalPages: 0, totalLinks: 0, brokenLinks: 0, paywallDetected: false,
      seoScore: 0, a11yScore: 0, htmlScore: 0, mobileScore: 0,
    },
  };

  try {
    // ── Step 1: Fetch Sitemap ──
    let sitemapUrls = [baseUrl];
    if (checkSitemap) {
      updateProgress(10, 'Fetching sitemap…');
      logAudit('info', `Searching for sitemap at ${baseUrl} (trying sitemap_index.xml)…`);
      try {
        const sitemapRes = await fetchSitemap({ url: baseUrl });
        if (sitemapRes?.urls) {
          sitemapUrls = sitemapRes.urls.slice(0, maxPages);
          report.sitemap = {
            url: sitemapRes.sitemapUrl,
            totalUrls: sitemapRes.urls.length,
            audited: sitemapUrls.length,
            childSitemaps: sitemapRes.childSitemaps || 0,
          };
          const indexNote = sitemapRes.childSitemaps ? ` (sitemap index with ${sitemapRes.childSitemaps} child sitemaps)` : '';
          logAudit('success', `Sitemap found at ${sitemapRes.sitemapUrl}${indexNote}: ${sitemapRes.urls.length} URLs (auditing ${sitemapUrls.length})`);
        } else {
          logAudit('warn', 'Sitemap response empty — using base URL only');
        }
      } catch {
        logAudit('warn', 'Sitemap not found — falling back to base URL only');
        report.sitemap = null;
      }
    } else {
      logAudit('info', 'Sitemap check skipped (disabled)');
    }

    report.summary.totalPages = sitemapUrls.length;
    logAudit('info', `Total pages to audit: ${sitemapUrls.length}`);

    // ── Step 2: Visit pages — full audit (SEO, A11y, HTML, links) ──
    logAudit('info', '── Step 2: Comprehensive page audit ──');
    const allLinks = new Map();
    let seoTotal = 0, a11yTotal = 0, htmlTotal = 0;

    // Initialize video recording for audit (max 5 page recordings)
    videoState.active = true;
    videoState.segments = [];
    videoState.maxSegments = 5;
    try { await ensureOffscreenDocument(); } catch (e) { console.warn('[Video] Offscreen setup failed:', e.message); videoState.active = false; }

    for (let i = 0; i < sitemapUrls.length; i++) {
      if (auditState.abort) { logAudit('warn', 'Audit aborted by user'); break; }

      const pageUrl = sitemapUrls[i];
      const pct = 10 + Math.round((i / sitemapUrls.length) * 45);
      updateProgress(pct, `Auditing page ${i + 1}/${sitemapUrls.length}…`);
      logAudit('info', `[${i + 1}/${sitemapUrls.length}] Opening ${pageUrl}`);

      let tab = null;
      let tabRecording = false;
      try {
        tab = await chrome.tabs.create({ url: pageUrl, active: canRecordSegment() });
        logAudit('info', `  Tab created (id: ${tab.id}), waiting for load…`);
        await waitForTabComplete(tab.id);
        tabRecording = await recordTabSegment(tab.id);
        await waitForContentScript(tab.id);
        logAudit('info', '  Content script ready');

        // Full audit data from content script
        let fullData = null;
        try {
          fullData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_FULL_AUDIT' });
        } catch (e) {
          logAudit('warn', `  Full audit message failed: ${e.message}`);
        }

        const pageResult = {
          url: pageUrl,
          title: fullData?.title || '',
          totalLinks: fullData?.totalLinks || 0,
          jobCards: fullData?.jobCards || 0,
          pageType: fullData?.pageType || 'unknown',
          hasPaywall: fullData?.hasPaywall || false,
          screenshot: null,
        };

        // SEO
        if (fullData?.seo) {
          const seo = fullData.seo;
          seoTotal += seo.score;
          report.seoResults.push({ url: pageUrl, title: fullData.title, score: seo.score, issues: seo.issues, data: seo.data });
          const errCount = seo.issues.filter((i) => i.severity === 'error').length;
          const warnCount = seo.issues.filter((i) => i.severity === 'warn').length;
          logAudit(errCount ? 'warn' : 'success', `  SEO score: ${seo.score}/100  (${errCount} errors, ${warnCount} warnings)`);
        }

        // Accessibility
        if (fullData?.accessibility) {
          const a11y = fullData.accessibility;
          a11yTotal += a11y.score;
          report.accessibilityResults.push({ url: pageUrl, title: fullData.title, score: a11y.score, issues: a11y.issues });
          const errCount = a11y.issues.filter((i) => i.severity === 'error').length;
          logAudit(errCount ? 'warn' : 'success', `  A11y score: ${a11y.score}/100  (${a11y.issues.length} issues)`);
        }

        // HTML Validation
        if (fullData?.html) {
          const html = fullData.html;
          htmlTotal += html.score;
          report.htmlResults.push({ url: pageUrl, title: fullData.title, score: html.score, issues: html.issues });
          logAudit(html.score < 80 ? 'warn' : 'success', `  HTML score: ${html.score}/100  (${html.issues.length} issues)`);
        }

        // Collect links
        if (fullData?.links) {
          const newLinks = fullData.links.filter((l) => !allLinks.has(l.href)).length;
          for (const link of fullData.links) {
            if (!allLinks.has(link.href)) allLinks.set(link.href, link);
          }
          logAudit('info', `  Collected ${newLinks} new links (total: ${allLinks.size})`);
        }


        // Mobile responsiveness check
        try {
          logAudit('info', '  Checking mobile responsiveness…');
          // Resize to mobile viewport via scripting
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => { document.documentElement.style.width = '375px'; document.documentElement.style.overflow = 'hidden'; },
          });
          await delay(300);
          const mobileData = await chrome.tabs.sendMessage(tab.id, { type: 'PW_CHECK_MOBILE' });
          // Restore
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => { document.documentElement.style.width = ''; document.documentElement.style.overflow = ''; },
          });
          if (mobileData) {
            report.mobileResults.push({ url: pageUrl, title: fullData?.title || '', score: mobileData.score, issues: mobileData.issues });
            logAudit(mobileData.score < 70 ? 'warn' : 'success', `  Mobile score: ${mobileData.score}/100  (${mobileData.issues.length} issues)`);
          }
        } catch (e) {
          logAudit('warn', `  Mobile check failed: ${e.message}`);
        }

        // Paywall check on job pages
        if (checkFreeJobs && fullData?.pageType === 'jobs' && fullData?.jobCards > 0 && !report.paywallResults) {
          updateProgress(pct, 'Testing paywall on job page…');
          logAudit('info', `  Testing paywall (limit: ${freeJobLimit})…`);
          try {
            const paywallRes = await chrome.tabs.sendMessage(tab.id, { type: 'PW_CHECK_PAYWALL', limit: freeJobLimit });
            if (paywallRes) {
              report.paywallResults = paywallRes;
              report.summary.paywallDetected = paywallRes.paywallDetected;
              logAudit(paywallRes.paywallDetected ? 'success' : 'warn',
                `  Paywall ${paywallRes.paywallDetected ? 'detected' : 'NOT detected'} — ${paywallRes.jobsFound} jobs found`);
            }
          } catch (e) {
            logAudit('warn', `  Paywall check failed: ${e.message}`);
          }
        }

        report.pages.push(pageResult);
        logAudit('success', `  ✓ Page complete: "${pageResult.title || pageUrl}"`);
      } catch (err) {
        logAudit('error', `  ✗ Page failed: ${err.message}`);
        report.pages.push({ url: pageUrl, error: err.message });
      } finally {
        if (tabRecording) await saveTabSegment(`Audit: ${pageUrl}`);
        if (tab?.id) {
          try { await chrome.tabs.remove(tab.id); } catch { /* already closed */ }
        }
      }
    }

    // Calculate average scores
    const pageCount = report.seoResults.length || 1;
    report.summary.seoScore = Math.round(seoTotal / pageCount);
    report.summary.a11yScore = Math.round(a11yTotal / pageCount);
    report.summary.htmlScore = Math.round(htmlTotal / pageCount);
    report.summary.mobileScore = report.mobileResults.length
      ? Math.round(report.mobileResults.reduce((s, m) => s + m.score, 0) / report.mobileResults.length)
      : 0;

    // ── Step 3: Check Links in background (no tabs) ──
    if (checkLinks && !auditState.abort) {
      const linkUrls = Array.from(allLinks.keys()).slice(0, 100);
      report.summary.totalLinks = linkUrls.length;
      logAudit('info', `── Step 3: Checking ${linkUrls.length} links (background fetch) ──`);

      for (let i = 0; i < linkUrls.length; i++) {
        if (auditState.abort) { logAudit('warn', 'Audit aborted by user'); break; }
        if (i % 5 === 0) {
          updateProgress(60 + Math.round((i / linkUrls.length) * 30), `Checking link ${i + 1}/${linkUrls.length}…`);
        }
        try {
          const checkRes = await checkUrl({ url: linkUrls[i] });
          if (checkRes && !checkRes.ok) {
            const linkInfo = allLinks.get(linkUrls[i]);
            report.brokenLinks.push({
              url: linkUrls[i],
              text: linkInfo?.text || '',
              status: checkRes.status,
              error: checkRes.error || `HTTP ${checkRes.status}`,
            });
            logAudit('error', `  ✗ Broken [${checkRes.status || 'ERR'}] ${linkUrls[i]}`);
          }
        } catch { /* skip */ }
      }
      report.summary.brokenLinks = report.brokenLinks.length;
      logAudit('info', `Link check complete: ${report.summary.brokenLinks} broken out of ${linkUrls.length}`);
    } else if (!checkLinks) {
      logAudit('info', 'Link check skipped (disabled)');
    }

    // ── Done ──
    report.completedAt = new Date().toISOString();

    // Finalize video recording for audit
    videoState.active = false;
    report.videoSegments = videoState.segments.filter(Boolean);
    videoState.segments = [];
    await closeOffscreenDocument();

    auditState.report = report;
    const elapsed = ((new Date(report.completedAt) - new Date(report.startedAt)) / 1000).toFixed(1);
    logAudit('success', `✓ Audit complete in ${elapsed}s — ${report.pages.length} pages, ${report.summary.totalLinks} links, ${report.summary.brokenLinks} broken`);
    logAudit('info', `Scores → SEO: ${report.summary.seoScore}/100, A11y: ${report.summary.a11yScore}/100, HTML: ${report.summary.htmlScore}/100, Mobile: ${report.summary.mobileScore}/100`);
    updateProgress(100, 'Audit complete');

  } catch (err) {
    logAudit('error', `Audit error: ${err.message}`);
    updateProgress(100, `Failed: ${err.message}`);
    auditState.report = report; // Save partial results
  } finally {
    auditState.running = false;
    chrome.alarms.clear('audit-keepalive');

    // Auto-save audit report to storage
    if (auditState.report && !auditState.report.error) {
      try { await autoSaveAuditReport(auditState.report); } catch (e) { console.warn('[Audit] Auto-save failed:', e); }
    }

    // Notify connected popups that audit is done
    for (const port of auditPorts) {
      try { port.postMessage({ type: 'AUDIT_DONE' }); } catch { /* disconnected */ }
    }
  }
}
