/* ===== Playwright Pilot — Popup Script ===== */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  let ghToken = '';
  let recording = false;
  let recordedSteps = [];
  let timerInterval = null;
  let timerSeconds = 0;
  let savedSuites = [];
  let savedReports = [];
  let recorderVideoDataUrl = null;

  /* ── Helpers ── */
  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function toast(msg, type = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast ${type}`;
    el.classList.remove('hidden');
    clearTimeout(el._tid);
    el._tid = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  function showState(id) {
    $$('.state').forEach((s) => s.classList.add('hidden'));
    $(`#state${id}`).classList.remove('hidden');
  }

  function downloadText(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadDataUrl(dataUrl, filename) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
  }

  /* ── IndexedDB Video Store (avoids chrome.storage.local size limits) ── */
  const VIDEO_DB_NAME = 'pw_pilot_videos';
  const VIDEO_DB_VERSION = 1;
  const VIDEO_STORE = 'videos';

  function openVideoDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(VIDEO_DB_NAME, VIDEO_DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(VIDEO_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveVideoToDb(reportId, videoData) {
    try {
      const db = await openVideoDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE, 'readwrite');
        tx.objectStore(VIDEO_STORE).put(videoData, reportId);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (err) { console.warn('[VideoDb] save error:', err.message); }
  }

  async function getVideoFromDb(reportId) {
    try {
      const db = await openVideoDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE, 'readonly');
        const req = tx.objectStore(VIDEO_STORE).get(reportId);
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    } catch (err) { console.warn('[VideoDb] get error:', err.message); return null; }
  }

  async function deleteVideoFromDb(reportId) {
    try {
      const db = await openVideoDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE, 'readwrite');
        tx.objectStore(VIDEO_STORE).delete(reportId);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (err) { console.warn('[VideoDb] delete error:', err.message); }
  }

  async function clearAllVideosFromDb() {
    try {
      const db = await openVideoDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE, 'readwrite');
        tx.objectStore(VIDEO_STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (err) { console.warn('[VideoDb] clear error:', err.message); }
  }

  async function getAllVideoKeysFromDb() {
    try {
      const db = await openVideoDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE, 'readonly');
        const req = tx.objectStore(VIDEO_STORE).getAllKeys();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
      });
    } catch (err) { console.warn('[VideoDb] getAllKeys error:', err.message); return []; }
  }

  /* ── Tab Management ── */
  function initTabs() {
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach((t) => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');

        $$('.tab-pane').forEach((p) => p.classList.add('hidden'));
        const paneId = `tab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`;
        const pane = $(`#${paneId}`);
        if (pane) pane.classList.remove('hidden');
      });
    });
  }

  /* ── Timer ── */
  function startTimer() {
    timerSeconds = 0;
    const el = $('#recorderTimer');
    el.classList.remove('hidden');
    el.textContent = '00:00';
    timerInterval = setInterval(() => {
      timerSeconds++;
      const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0');
      const s = String(timerSeconds % 60).padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  /* ── Recording Control ── */
  async function startRecording() {
    recording = true;
    recordedSteps = [];
    recorderVideoDataUrl = null;

    $('#recorderIndicator').classList.add('active');
    $('#recorderStatusText').textContent = 'Recording…';
    $('#btnStartRecord').disabled = true;
    $('#btnStartRecord').classList.add('recording');
    $('#btnStopRecord').disabled = false;
    $('#btnClearRecord').disabled = true;
    $('#recorderFooter').classList.add('hidden');
    $('#recordedSteps').innerHTML = '<p class="task-empty">Listening for interactions…</p>';

    startTimer();

    // Start recording via background (handles content script + video)
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.runtime.sendMessage({
        type: 'START_RECORDING',
        payload: { tabId: tab.id, options: getRecordOptions() },
      }, (res) => {
        if (chrome.runtime.lastError) console.warn('[Recorder] Start failed:', chrome.runtime.lastError.message);
        else if (res?.error) console.warn('[Recorder] Start failed:', res.error);
      });
    }
  }

  async function stopRecording() {
    recording = false;

    $('#recorderIndicator').classList.remove('active');
    $('#btnStartRecord').disabled = false;
    $('#btnStartRecord').classList.remove('recording');
    $('#btnStopRecord').disabled = true;
    $('#btnClearRecord').disabled = false;

    stopTimer();

    let videoInIdb = false;

    // Stop recording via background — get all steps + video
    try {
      const res = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
      if (res?.steps?.length) {
        recordedSteps = res.steps;
      }
      if (res?.videoDataUrl) {
        recorderVideoDataUrl = res.videoDataUrl;
      }
      videoInIdb = res?.videoInIdb || false;
    } catch (err) {
      console.warn('[Recorder] Stop failed:', err.message);
    }

    // Fallback: if no dataUrl from message, try loading from IndexedDB
    if (!recorderVideoDataUrl && videoInIdb) {
      try {
        const videoData = await getVideoFromDb('__latest_recording');
        if (videoData?.blob) {
          const reader = new FileReader();
          recorderVideoDataUrl = await new Promise((resolve) => {
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(videoData.blob);
          });
        }
      } catch (e) {
        console.warn('[Recorder] IDB video load failed:', e);
      }
    }

    $('#recorderStatusText').textContent = `Recorded ${recordedSteps.length} steps`;

    if (recordedSteps.length > 0) {
      renderSteps();
      $('#recorderFooter').classList.remove('hidden');
      $('#stepCount').textContent = `${recordedSteps.length} step${recordedSteps.length === 1 ? '' : 's'}`;
      // Show/hide video download button — show if we have dataUrl OR video was saved to IDB
      const hasVideo = !!recorderVideoDataUrl || videoInIdb;
      const vidBtn = $('#btnDownloadRecordingVideo');
      if (vidBtn) vidBtn.classList.toggle('hidden', !hasVideo);

      // Auto-save recording to Tests tab
      try {
        const code = generatePlaywrightCode(recordedSteps, getRecordOptions());
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const reportData = {
          steps: recordedSteps.map((s) => ({ ...s })),
          code,
          url: activeTab?.url || '',
          title: activeTab?.title || '',
        };
        if (recorderVideoDataUrl) reportData.videoDataUrl = recorderVideoDataUrl;
        reportData._hasVideo = !!recorderVideoDataUrl || videoInIdb;
        const host = activeTab?.url ? new URL(activeTab.url).hostname : 'page';
        await saveReport(`Recording — ${recordedSteps.length} steps on ${host}`, 'recording', reportData);
      } catch (e) {
        console.warn('[Report] Auto-save recording failed:', e);
      }
    }
  }

  function clearRecording() {
    recordedSteps = [];
    recording = false;
    recorderVideoDataUrl = null;
    // Clear background state if still active
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, () => void chrome.runtime.lastError);
    $('#recorderIndicator').classList.remove('active');
    $('#recorderStatusText').textContent = 'Ready to record';
    $('#recorderTimer').classList.add('hidden');
    $('#btnStartRecord').disabled = false;
    $('#btnStartRecord').classList.remove('recording');
    $('#btnStopRecord').disabled = true;
    $('#btnClearRecord').disabled = true;
    $('#recorderFooter').classList.add('hidden');
    $('#recordedSteps').innerHTML = '<p class="task-empty">No steps recorded yet. Click <strong>Start</strong> to begin recording browser interactions.</p>';
    const vidBtn = $('#btnDownloadRecordingVideo');
    if (vidBtn) vidBtn.classList.add('hidden');
    stopTimer();
  }

  function getRecordOptions() {
    return {
      assertions: $('#chkAssertions')?.checked ?? true,
      waitStates: $('#chkWaitStates')?.checked ?? true,
    };
  }

  /* ── Step Rendering ── */
  function renderSteps() {
    const container = $('#recordedSteps');
    if (!recordedSteps.length) {
      container.innerHTML = '<p class="task-empty">No steps recorded yet.</p>';
      return;
    }

    container.innerHTML = '';
    recordedSteps.forEach((step, i) => {
      const el = document.createElement('div');
      el.className = 'step-item';
      el.innerHTML = `
        <span class="step-number">${i + 1}</span>
        <div class="step-content">
          <div class="step-action"><span class="action-type">${escHtml(step.action)}</span> ${escHtml(step.description || '')}</div>
          <div class="step-selector">${escHtml(step.selector || '')}</div>
        </div>
        <button class="step-remove" data-index="${i}" title="Remove step">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06"/></svg>
        </button>`;
      container.appendChild(el);
    });

    container.querySelectorAll('.step-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        recordedSteps.splice(idx, 1);
        // Sync removal to background
        chrome.runtime.sendMessage({ type: 'REMOVE_RECORDED_STEP', payload: { index: idx } }, () => void chrome.runtime.lastError);
        renderSteps();
        updateStepCount();
      });
    });
  }

  function updateStepCount() {
    if (recordedSteps.length > 0) {
      $('#recorderFooter').classList.remove('hidden');
      $('#stepCount').textContent = `${recordedSteps.length} step${recordedSteps.length === 1 ? '' : 's'}`;
    } else {
      $('#recorderFooter').classList.add('hidden');
    }
  }

  /* ── Code Generation ── */
  function escJsStr(s) { return (s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  function getSelectedFramework() {
    return $('#genFramework')?.value || 'puppeteer-jest';
  }

  function isPlaywrightFw(fw) {
    return fw && fw.startsWith('playwright');
  }

  function generatePlaywrightCode(steps, options = {}) {
    const fw = getSelectedFramework();
    if (isPlaywrightFw(fw)) {
      return generatePlaywrightNativeCode(steps, options, fw);
    }
    return generatePuppeteerCode(steps, options);
  }

  /* ── Puppeteer Code Generation ── */
  function generatePuppeteerCode(steps, options = {}) {
    const lines = [];
    lines.push(`const puppeteer = require('puppeteer');`);
    lines.push('');
    lines.push(`describe('Recorded test - ${new Date().toISOString().slice(0, 10)}', () => {`);
    lines.push(`  let browser, page;`);
    lines.push('');
    lines.push(`  beforeAll(async () => {`);
    lines.push(`    browser = await puppeteer.launch({ headless: 'new' });`);
    lines.push(`    page = await browser.newPage();`);
    lines.push(`    await page.setViewport({ width: 1280, height: 720 });`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  afterAll(async () => {`);
    lines.push(`    await browser.close();`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  it('should complete the recorded flow', async () => {`);

    for (const step of steps) {
      const sel = escJsStr(step.selector);
      const val = escJsStr(step.value);
      switch (step.action) {
        case 'navigate':
          lines.push(`    await page.goto('${escJsStr(step.url)}', { waitUntil: 'networkidle0' });`);
          break;
        case 'click':
          if (step.selector) {
            lines.push(`    await page.waitForSelector('${sel}');`);
            lines.push(`    await page.click('${sel}');`);
          }
          break;
        case 'dblclick':
          if (step.selector) {
            lines.push(`    await page.waitForSelector('${sel}');`);
            lines.push(`    await page.click('${sel}', { clickCount: 2 });`);
          }
          break;
        case 'fill':
          if (step.selector && step.value !== undefined) {
            lines.push(`    await page.waitForSelector('${sel}');`);
            lines.push(`    await page.click('${sel}', { clickCount: 3 });`);
            lines.push(`    await page.type('${sel}', '${val}');`);
          }
          break;
        case 'press':
          if (step.selector && step.key) {
            lines.push(`    await page.keyboard.press('${escJsStr(step.key)}');`);
          }
          break;
        case 'select':
          if (step.selector && step.value) {
            lines.push(`    await page.select('${sel}', '${val}');`);
          }
          break;
        case 'check':
          if (step.selector) {
            lines.push(`    await page.waitForSelector('${sel}');`);
            lines.push(`    const cb = await page.$('${sel}');`);
            lines.push(`    const isChecked = await (await cb.getProperty('checked')).jsonValue();`);
            lines.push(`    if (!isChecked) await cb.click();`);
          }
          break;
        case 'uncheck':
          if (step.selector) {
            lines.push(`    await page.waitForSelector('${sel}');`);
            lines.push(`    const ucb = await page.$('${sel}');`);
            lines.push(`    const wasChecked = await (await ucb.getProperty('checked')).jsonValue();`);
            lines.push(`    if (wasChecked) await ucb.click();`);
          }
          break;
        case 'hover':
          if (step.selector) {
            lines.push(`    await page.hover('${sel}');`);
          }
          break;
        case 'scroll':
          lines.push(`    await page.evaluate(() => window.scrollBy(${step.deltaX || 0}, ${step.deltaY || 0}));`);
          break;
        case 'assert-visible':
          if (step.selector) {
            lines.push(`    const el = await page.$('${sel}');`);
            lines.push(`    expect(el).not.toBeNull();`);
          }
          break;
        case 'assert-text':
          if (step.selector && step.text) {
            lines.push(`    const txt = await page.$eval('${sel}', el => el.textContent);`);
            lines.push(`    expect(txt).toContain('${escJsStr(step.text)}');`);
          }
          break;
        case 'screenshot':
          lines.push(`    await page.screenshot({ path: 'screenshot-step-${step.stepIndex || 0}.png' });`);
          break;
        case 'wait':
          if (step.selector) {
            lines.push(`    await page.waitForSelector('${sel}', { visible: true });`);
          }
          break;
        default:
          lines.push(`    // ${step.action}: ${step.description || 'unknown action'}`);
      }

      // Auto-add wait for navigation
      if (options.waitStates && ['click', 'fill', 'press', 'select'].includes(step.action)) {
        lines.push(`    await page.waitForNetworkIdle();`);
      }
    }

    lines.push(`  }, 30000);`);
    lines.push('});');
    lines.push('');
    return lines.join('\n');
  }

  /* ── Playwright Code Generation ── */
  function generatePlaywrightNativeCode(steps, options = {}, framework = 'playwright-test') {
    const lines = [];
    const isNativeTest = framework === 'playwright-test';

    if (isNativeTest) {
      lines.push(`const { test, expect } = require('@playwright/test');`);
      lines.push('');
      lines.push(`test.describe('Recorded test - ${new Date().toISOString().slice(0, 10)}', () => {`);
      lines.push(`  test.use({ viewport: { width: 1280, height: 720 } });`);
      lines.push('');
      lines.push(`  test('should complete the recorded flow', async ({ page }) => {`);
    } else if (framework === 'playwright-jest') {
      lines.push(`const { chromium } = require('playwright');`);
      lines.push('');
      lines.push(`describe('Recorded test - ${new Date().toISOString().slice(0, 10)}', () => {`);
      lines.push(`  let browser, context, page;`);
      lines.push('');
      lines.push(`  beforeAll(async () => {`);
      lines.push(`    browser = await chromium.launch();`);
      lines.push(`    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });`);
      lines.push(`    page = await context.newPage();`);
      lines.push(`  });`);
      lines.push('');
      lines.push(`  afterAll(async () => {`);
      lines.push(`    await browser.close();`);
      lines.push(`  });`);
      lines.push('');
      lines.push(`  it('should complete the recorded flow', async () => {`);
    } else {
      // standalone
      lines.push(`const { chromium } = require('playwright');`);
      lines.push('');
      lines.push(`(async () => {`);
      lines.push(`  const browser = await chromium.launch();`);
      lines.push(`  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });`);
      lines.push(`  const page = await context.newPage();`);
      lines.push('');
      lines.push(`  try {`);
    }

    const indent = framework === 'playwright-basic' ? '    ' : '    ';

    for (const step of steps) {
      const sel = escJsStr(step.selector);
      const val = escJsStr(step.value);
      switch (step.action) {
        case 'navigate':
          lines.push(`${indent}await page.goto('${escJsStr(step.url)}', { waitUntil: 'networkidle' });`);
          break;
        case 'click':
          if (step.selector) {
            lines.push(`${indent}await page.locator('${sel}').click();`);
          }
          break;
        case 'dblclick':
          if (step.selector) {
            lines.push(`${indent}await page.locator('${sel}').dblclick();`);
          }
          break;
        case 'fill':
          if (step.selector && step.value !== undefined) {
            lines.push(`${indent}await page.locator('${sel}').fill('${val}');`);
          }
          break;
        case 'press':
          if (step.selector && step.key) {
            lines.push(`${indent}await page.locator('${sel}').press('${escJsStr(step.key)}');`);
          }
          break;
        case 'select':
          if (step.selector && step.value) {
            lines.push(`${indent}await page.locator('${sel}').selectOption('${val}');`);
          }
          break;
        case 'check':
          if (step.selector) {
            lines.push(`${indent}await page.locator('${sel}').check();`);
          }
          break;
        case 'uncheck':
          if (step.selector) {
            lines.push(`${indent}await page.locator('${sel}').uncheck();`);
          }
          break;
        case 'hover':
          if (step.selector) {
            lines.push(`${indent}await page.locator('${sel}').hover();`);
          }
          break;
        case 'scroll':
          lines.push(`${indent}await page.evaluate(() => window.scrollBy(${step.deltaX || 0}, ${step.deltaY || 0}));`);
          break;
        case 'assert-visible':
          if (step.selector) {
            lines.push(`${indent}await expect(page.locator('${sel}')).toBeVisible();`);
          }
          break;
        case 'assert-text':
          if (step.selector && step.text) {
            lines.push(`${indent}await expect(page.locator('${sel}')).toContainText('${escJsStr(step.text)}');`);
          }
          break;
        case 'screenshot':
          lines.push(`${indent}await page.screenshot({ path: 'screenshot-step-${step.stepIndex || 0}.png' });`);
          break;
        case 'wait':
          if (step.selector) {
            lines.push(`${indent}await page.locator('${sel}').waitFor({ state: 'visible' });`);
          }
          break;
        default:
          lines.push(`${indent}// ${step.action}: ${step.description || 'unknown action'}`);
      }

      if (options.waitStates && ['click', 'fill', 'press', 'select'].includes(step.action)) {
        lines.push(`${indent}await page.waitForLoadState('networkidle');`);
      }
    }

    if (isNativeTest) {
      lines.push(`  });`);
      lines.push('});');
    } else if (framework === 'playwright-jest') {
      lines.push(`  }, 30000);`);
      lines.push('});');
    } else {
      lines.push(`  } finally {`);
      lines.push(`    await browser.close();`);
      lines.push(`  }`);
      lines.push(`})();`);
    }

    lines.push('');
    return lines.join('\n');
  }

  /* ── Preview Modal ── */
  function showPreview() {
    const code = generatePlaywrightCode(recordedSteps, getRecordOptions());
    $('#previewCode code').textContent = code;
    $('#previewModal').classList.remove('hidden');
  }

  function closePreview() {
    $('#previewModal').classList.add('hidden');
  }

  /* ── AI Generation ── */
  async function generateWithAI() {
    const url = $('#genUrl').value.trim();
    const description = $('#genDescription').value.trim();
    const framework = $('#genFramework').value;
    const usePOM = $('#genPOM').checked;
    const a11y = $('#genAccessibility').checked;
    const visual = $('#genVisual').checked;
    const apiMock = $('#genAPI').checked;

    if (!description) {
      toast('Please describe the test scenario', 'error');
      return null;
    }

    if (!ghToken) {
      toast('GitHub token not configured. Go to Settings.', 'error');
      return null;
    }

    $('#genResult').classList.add('hidden');
    $('#genLoading').classList.remove('hidden');
    $('#btnGenerate').disabled = true;
    $('#btnGenerateAndRun') && ($('#btnGenerateAndRun').disabled = true);

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GENERATE_TEST',
        token: ghToken,
        payload: { url, description, framework, usePOM, a11y, visual, apiMock },
      });

      if (!res) throw new Error('Background service not responding. Try reloading the extension from chrome://extensions.');
      if (res.error) throw new Error(res.error);

      $('#genCode code').textContent = res.code;
      $('#genResult').classList.remove('hidden');
      toast('Test generated successfully', 'success');
      return res.code;
    } catch (err) {
      toast(err.message, 'error');
      return null;
    } finally {
      $('#genLoading').classList.add('hidden');
      $('#btnGenerate').disabled = false;
      $('#btnGenerateAndRun') && ($('#btnGenerateAndRun').disabled = false);
    }
  }

  /* ── Suite Management ── */
  async function loadSuites() {
    const data = await chrome.storage.local.get('pw_suites');
    savedSuites = data.pw_suites || [];
    renderSuites();
  }

  async function saveSuite(name, code, source) {
    const suite = {
      id: `suite_${Date.now()}`,
      name,
      code,
      source,
      createdAt: new Date().toISOString(),
      stepCount: recordedSteps.length,
    };
    savedSuites.push(suite);
    await chrome.storage.local.set({ pw_suites: savedSuites });
    renderSuites();
    toast(`Saved: ${name}`, 'success');
  }

  function renderSuites() {
    const container = $('#suiteList');
    if (!savedSuites.length) {
      container.innerHTML = '<p class="task-empty">Save recorded or AI-generated tests to build your test suite.</p>';
      return;
    }

    container.innerHTML = '';
    savedSuites.forEach((suite) => {
      const el = document.createElement('div');
      el.className = 'suite-item';
      el.innerHTML = `
        <svg class="suite-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
          <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1M1.5 2.75v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25"/>
        </svg>
        <div class="suite-info">
          <div class="suite-name">${escHtml(suite.name)}</div>
          <div class="suite-meta">${escHtml(suite.source)} · ${new Date(suite.createdAt).toLocaleDateString()}</div>
        </div>
        <div class="suite-actions">
          <button class="icon-btn suite-export" data-id="${suite.id}" title="Export">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
          </button>
          <button class="icon-btn suite-delete" data-id="${suite.id}" title="Delete">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75M6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25M4.997 6.178a.75.75 0 1 0-1.493.144l.536 5.46a1.75 1.75 0 0 0 1.74 1.568h4.44a1.75 1.75 0 0 0 1.74-1.568l.536-5.46a.75.75 0 0 0-1.493-.144l-.536 5.46a.25.25 0 0 1-.249.224H5.78a.25.25 0 0 1-.249-.224Z"/></svg>
          </button>
        </div>`;
      container.appendChild(el);
    });

    // Wire export/delete
    container.querySelectorAll('.suite-export').forEach((btn) => {
      btn.addEventListener('click', () => {
        const suite = savedSuites.find((s) => s.id === btn.dataset.id);
        if (suite) {
          const safeName = suite.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
          downloadText(suite.code, `${safeName}.test.js`);
        }
      });
    });

    container.querySelectorAll('.suite-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        savedSuites = savedSuites.filter((s) => s.id !== btn.dataset.id);
        await chrome.storage.local.set({ pw_suites: savedSuites });
        renderSuites();
        toast('Test deleted', '');
      });
    });
  }

  function exportAllSuites() {
    if (!savedSuites.length) {
      toast('No test suites to export', 'error');
      return;
    }
    // Export each suite as individual file
    savedSuites.forEach((suite) => {
      const safeName = suite.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      downloadText(suite.code, `${safeName}.test.js`);
    });
    toast(`Exported ${savedSuites.length} test files`, 'success');
  }

  /* ── Suite search ── */
  function filterSuites(query) {
    const q = query.toLowerCase();
    $$('.suite-item').forEach((item) => {
      const name = item.querySelector('.suite-name')?.textContent.toLowerCase() || '';
      item.style.display = name.includes(q) ? '' : 'none';
    });
  }

  /* ── Saved Reports Management ── */
  async function loadReports() {
    const data = await chrome.storage.local.get('pw_reports');
    savedReports = data.pw_reports || [];
    renderReports();
  }

  async function saveReport(name, type, data) {
    const report = {
      id: `report_${Date.now()}`,
      name,
      type, // 'test-run' | 'happy-flow' | 'audit' | 'recording'
      data,
      createdAt: new Date().toISOString(),
    };

    // Extract video data → store in IndexedDB (too large for chrome.storage)
    const videoPayload = extractVideoData(report);
    if (videoPayload) {
      await saveVideoToDb(report.id, videoPayload);
      report.data._hasVideo = true;
    }

    savedReports.unshift(report);
    // Keep max 50 reports to avoid storage limits
    if (savedReports.length > 50) {
      const removed = savedReports.splice(50);
      for (const r of removed) { deleteVideoFromDb(r.id).catch(() => {}); }
    }
    await chrome.storage.local.set({ pw_reports: savedReports });
    renderReports();
    toast(`Report saved to Tests tab`, 'success');
    return report;
  }

  function extractVideoData(report) {
    const d = report.data;
    if (!d) return null;

    // Single video (test-run, recording)
    if (d.videoDataUrl) {
      const url = d.videoDataUrl;
      delete d.videoDataUrl;
      return { type: 'single', dataUrl: url };
    }

    // Multiple segments (happy-flow, audit)
    if (d.videoSegments?.length) {
      const segs = d.videoSegments;
      d.videoSegments = segs.map((s) => ({ label: s.label, ts: s.ts })); // keep labels only
      d._hasVideo = true;
      return { type: 'segments', segments: segs };
    }

    return null;
  }

  async function deleteReport(id) {
    savedReports = savedReports.filter((r) => r.id !== id);
    await chrome.storage.local.set({ pw_reports: savedReports });
    deleteVideoFromDb(id).catch(() => {});
    renderReports();
    toast('Report deleted', '');
  }

  async function clearAllReports() {
    if (!savedReports.length) { toast('No reports to delete', ''); return; }
    savedReports = [];
    await chrome.storage.local.set({ pw_reports: savedReports });
    clearAllVideosFromDb().catch(() => {});
    renderReports();
    toast('All reports cleared', '');
  }

  function renderReports() {
    const container = $('#savedReportsList');
    if (!container) return;

    if (!savedReports.length) {
      container.innerHTML = '<p class="task-empty">No saved reports yet. Run tests, happy flows, or audits to generate reports.</p>';
      return;
    }

    container.innerHTML = '';
    for (const report of savedReports) {
      const el = document.createElement('div');
      el.className = 'report-item';
      el.dataset.id = report.id;
      el.dataset.type = report.type;

      const typeIcons = {
        'test-run': '▶',
        'happy-flow': '✓',
        'recording': '⏺',
        'audit': '🛡',
      };
      const typeIcon = `<div class="report-type-icon ${report.type}">${typeIcons[report.type] || '?'}</div>`;

      const badge = getReportBadge(report);
      const dateStr = new Date(report.createdAt).toLocaleString();
      const hasVideo = report.data?._hasVideo || report.data?.videoDataUrl || report.data?.videoSegments?.length;
      const videoTag = hasVideo
        ? `<span class="report-video-tag"><svg viewBox="0 0 16 16" width="8" height="8" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm6 6.809V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>Video</span>`
        : '';

      el.innerHTML = `
        ${typeIcon}
        <div class="report-info">
          <div class="report-name">${escHtml(report.name)}</div>
          <div class="report-meta"><span>${escHtml(report.type)} · ${dateStr}</span>${videoTag}</div>
        </div>
        ${badge}
        <div class="report-actions">
          <button class="icon-btn report-view" data-id="${report.id}" title="View report">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v12.5A1.75 1.75 0 0 1 14.25 16H1.75A1.75 1.75 0 0 1 0 14.25ZM1.5 1.75v12.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V1.75a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25M3 4.25a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 4.25m0 3a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 7.25m0 3a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75"/></svg>
          </button>
          <button class="icon-btn report-delete" data-id="${report.id}" title="Delete report">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75M6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25M4.997 6.178a.75.75 0 1 0-1.493.144l.536 5.46a1.75 1.75 0 0 0 1.74 1.568h4.44a1.75 1.75 0 0 0 1.74-1.568l.536-5.46a.75.75 0 0 0-1.493-.144l-.536 5.46a.25.25 0 0 1-.249.224H5.78a.25.25 0 0 1-.249-.224Z"/></svg>
          </button>
        </div>`;
      container.appendChild(el);
    }

    wireReportActions();
  }

  function getReportBadge(report) {
    if (report.type === 'test-run') {
      const s = report.data?.summary;
      if (!s) return '';
      const allPassed = s.failed === 0 && s.skipped === 0;
      const cls = allPassed ? 'pass' : s.passed > 0 ? 'mixed' : 'fail';
      const label = allPassed ? 'PASS' : `${s.passed}/${s.passed + s.failed}`;
      return `<span class="report-badge ${cls}">${label}</span>`;
    }
    if (report.type === 'happy-flow') {
      const steps = report.data?.steps || [];
      const passed = steps.filter((s) => s.pass).length;
      const failed = steps.filter((s) => !s.pass).length;
      const cls = failed === 0 ? 'pass' : passed > 0 ? 'mixed' : 'fail';
      const label = failed === 0 ? 'PASS' : `${passed}/${passed + failed}`;
      return `<span class="report-badge ${cls}">${label}</span>`;
    }
    if (report.type === 'audit') {
      const s = report.data?.summary;
      if (!s) return '';
      const avgScore = Math.round(((s.seoScore || 0) + (s.a11yScore || 0) + (s.htmlScore || 0) + (s.mobileScore || 0)) / 4);
      const cls = avgScore >= 80 ? 'pass' : avgScore >= 50 ? 'mixed' : 'fail';
      return `<span class="report-badge ${cls}">${avgScore}/100</span>`;
    }
    if (report.type === 'recording') {
      const steps = report.data?.steps || [];
      const hasVideo = report.data?._hasVideo;
      const label = `${steps.length} steps`;
      return `<span class="report-badge pass">${hasVideo ? '🎬 ' : ''}${label}</span>`;
    }
    return '';
  }

  function wireReportActions() {
    $$('.report-view').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const report = savedReports.find((r) => r.id === btn.dataset.id);
        if (report) showReportDetail(report);
      });
    });
    $$('.report-delete').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteReport(btn.dataset.id);
      });
    });
    $$('.report-item').forEach((item) => {
      item.addEventListener('click', () => {
        const report = savedReports.find((r) => r.id === item.dataset.id);
        if (report) showReportDetail(report);
      });
    });
  }

  async function showReportDetail(report) {
    $('#savedReportsList').classList.add('hidden');
    $('#tabTests .pane-toolbar')?.classList.add('hidden');
    const detail = $('#reportDetailView');
    detail.classList.remove('hidden');
    $('#reportDetailTitle').textContent = report.name;
    const body = $('#reportDetailBody');

    // Load video from IndexedDB if available
    let videoPayload = null;
    if (report.data?._hasVideo) {
      try { videoPayload = await getVideoFromDb(report.id); } catch (e) { console.warn('[IDB] Load video failed:', e); }
    }

    if (report.type === 'test-run') {
      renderTestRunDetail(body, report.data, videoPayload);
    } else if (report.type === 'happy-flow') {
      renderHappyFlowDetail(body, report.data, videoPayload);
    } else if (report.type === 'audit') {
      renderAuditDetail(body, report.data, videoPayload);
    } else if (report.type === 'recording') {
      renderRecordingDetail(body, report.data, videoPayload);
    }

    // Wire export button
    const exportBtn = $('#btnExportReport');
    exportBtn.onclick = () => exportReportAsPdf(report);

    // Show/hide .test.js and .spec.js download buttons for happy-flow reports
    const testJsBtn = $('#btnExportReportTestJs');
    const specJsBtn = $('#btnExportReportSpecJs');
    if (report.type === 'happy-flow' && report.data) {
      testJsBtn.classList.remove('hidden');
      specJsBtn.classList.remove('hidden');
      const flowType = report.data.flowType || 'full';
      testJsBtn.onclick = () => downloadHappyFlowScript(report.data, flowType);
      specJsBtn.onclick = () => downloadHappyFlowPlaywrightScript(report.data, flowType);
    } else {
      testJsBtn.classList.add('hidden');
      specJsBtn.classList.add('hidden');
    }
  }

  function hideReportDetail() {
    $('#reportDetailView').classList.add('hidden');
    $('#savedReportsList').classList.remove('hidden');
    // Re-show the toolbar for the Tests tab
    const toolbar = $('#tabTests .pane-toolbar');
    if (toolbar) toolbar.classList.remove('hidden');
  }

  function renderTestRunDetail(body, data, videoPayload) {
    const results = data?.results || [];
    const summary = data?.summary || {};
    let html = '';

    // Summary banner
    const allPassed = summary.failed === 0 && (summary.skipped || 0) === 0;
    html += `<div class="report-summary-banner ${allPassed ? 'pass' : 'fail'}">
      <span class="summary-badge">${allPassed ? 'ALL PASSED' : 'FAILED'}</span>
      <span class="summary-text">${summary.passed || 0} passed · ${summary.failed || 0} failed${summary.skipped ? ` · ${summary.skipped} skipped` : ''}</span>
    </div>`;

    for (const r of results) {
      const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '—';
      html += `<div class="run-step-row ${r.status}">
        <span class="run-step-icon ${r.status}">${icon}</span>
        <div class="run-step-info">
          <span class="run-step-name">${escHtml(r.name)}</span>
          ${r.error ? `<span class="run-step-error">${escHtml(r.error)}</span>` : ''}
        </div>
        <span class="run-step-duration">${r.duration || '—'}</span>
      </div>`;
    }

    // Video download — from IDB or inline
    const hasVideo = (videoPayload?.type === 'single' && videoPayload.dataUrl) || data?.videoDataUrl;
    if (hasVideo) {
      html += `<div class="video-section">
        <div class="video-section-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
          Testing Video
        </div>
        <div class="video-btn-grid">
          <button class="video-chip" id="btnReportVideo">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
            Download Video Recording
          </button>
        </div>
      </div>`;
    }

    body.innerHTML = html;

    if (hasVideo) {
      const vidUrl = videoPayload?.dataUrl || data.videoDataUrl;
      document.getElementById('btnReportVideo')?.addEventListener('click', () => {
        downloadDataUrl(vidUrl, `test-run-recording.webm`);
        toast('Video downloaded', 'success');
      });
    }
  }

  function renderHappyFlowDetail(body, data, videoPayload) {
    const steps = data?.steps || [];
    const pageAudits = data?.pageAudits || [];
    let html = '';

    // Summary banner
    const passed = steps.filter((s) => s.pass).length;
    const failed = steps.filter((s) => !s.pass).length;
    const bannerCls = failed === 0 ? 'pass' : 'fail';
    html += `<div class="report-summary-banner ${bannerCls}">
      <span class="summary-badge">${failed === 0 ? 'ALL PASSED' : 'FAILED'}</span>
      <span class="summary-text">${passed} passed · ${failed} failed · ${steps.length} total steps</span>
    </div>`;

    // Score cards from page audits
    if (pageAudits.length) {
      const scores = { seo: [], a11y: [], html: [] };
      for (const pa of pageAudits) {
        if (pa.audit?.seo?.score != null) scores.seo.push(pa.audit.seo.score);
        if (pa.audit?.accessibility?.score != null) scores.a11y.push(pa.audit.accessibility.score);
        if (pa.audit?.html?.score != null) scores.html.push(pa.audit.html.score);
      }
      const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : '—';
      const sc = (s) => typeof s === 'number' ? (s >= 80 ? 'var(--green)' : s >= 50 ? 'var(--orange)' : 'var(--red)') : 'var(--text3)';
      const avgSeo = avg(scores.seo);
      const avgA11y = avg(scores.a11y);
      const avgHtml = avg(scores.html);
      html += `<div class="report-score-cards">
        <div class="report-score-card"><div class="score-num" style="color:${sc(avgSeo)}">${avgSeo}</div><div class="score-label">SEO</div></div>
        <div class="report-score-card"><div class="score-num" style="color:${sc(avgA11y)}">${avgA11y}</div><div class="score-label">A11y</div></div>
        <div class="report-score-card"><div class="score-num" style="color:${sc(avgHtml)}">${avgHtml}</div><div class="score-label">HTML</div></div>
        <div class="report-score-card"><div class="score-num">${pageAudits.length}</div><div class="score-label">Pages</div></div>
      </div>`;
    }

    for (const step of steps) {
      const icon = step.pass ? '✓' : '✗';
      const cls = step.pass ? 'pass' : 'fail';
      let label = step.type || 'step';
      let detail = '';
      if (step.type === 'visit-page') {
        label = step.title || step.url || 'Page visit';
        detail = step.url || '';
      } else if (step.type === 'link-check') {
        label = step.text || step.url;
        detail = step.status ? `HTTP ${step.status}` : (step.error || '');
      } else if (step.type === 'form-test') {
        label = step.formId ? `Form: ${step.formId}` : 'Form test';
        detail = step.error || `${step.fields || 0} fields`;
      } else if (step.type === 'login') {
        label = 'Login attempt';
        detail = step.pass ? 'Success' : (step.loginError || step.error || 'Failed');
      } else if (step.type === 'sitemap') {
        label = 'Sitemap check';
        detail = step.error || `${step.totalUrls} URLs`;
      } else if (step.type === 'crawl-summary') {
        label = 'Deep crawl complete';
        detail = `${step.totalVisited} pages visited`;
      }

      html += `<div class="run-step-row ${cls}">
        <span class="run-step-icon ${cls}">${icon}</span>
        <div class="run-step-info">
          <span class="run-step-name">${escHtml(label)}</span>
          ${detail ? `<span class="run-step-error" style="color:var(--text3)">${escHtml(detail)}</span>` : ''}
        </div>
      </div>`;
    }

    // Video segments download — from IDB or inline
    const videoSegs = videoPayload?.type === 'segments' ? videoPayload.segments : data?.videoSegments;
    if (videoSegs?.length) {
      html += `<div class="video-section">
        <div class="video-section-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
          Testing Video${videoSegs.length > 1 ? 's' : ''}
        </div>
        <div class="video-btn-grid">`;
      for (let i = 0; i < videoSegs.length; i++) {
        const seg = videoSegs[i];
        const segLabel = seg.label || `Segment ${i + 1}`;
        html += `<button class="video-chip hf-report-video-btn" data-seg-idx="${i}">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
          ${escHtml(segLabel.length > 20 ? segLabel.slice(0, 20) + '…' : segLabel)}
        </button>`;
      }
      html += `</div></div>`;
    }

    body.innerHTML = html;

    // Wire video buttons
    body.querySelectorAll('.hf-report-video-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.segIdx, 10);
        const seg = videoSegs[idx];
        if (seg?.dataUrl) {
          downloadDataUrl(seg.dataUrl, `happy-flow-recording-${idx + 1}.webm`);
          toast('Video downloaded', 'success');
        }
      });
    });
  }

  function renderAuditDetail(body, data, videoPayload) {
    if (!data) { body.innerHTML = '<p class="task-empty">No audit data.</p>'; return; }
    const r = data;
    let html = '';

    // Score cards
    const sc = (s) => s >= 80 ? 'var(--green)' : s >= 50 ? 'var(--orange)' : 'var(--red)';
    html += `<div class="report-score-cards">
      <div class="report-score-card"><div class="score-num" style="color:${sc(r.summary?.seoScore || 0)}">${r.summary?.seoScore || 0}</div><div class="score-label">SEO</div></div>
      <div class="report-score-card"><div class="score-num" style="color:${sc(r.summary?.a11yScore || 0)}">${r.summary?.a11yScore || 0}</div><div class="score-label">A11y</div></div>
      <div class="report-score-card"><div class="score-num" style="color:${sc(r.summary?.htmlScore || 0)}">${r.summary?.htmlScore || 0}</div><div class="score-label">HTML</div></div>
      <div class="report-score-card"><div class="score-num" style="color:${sc(r.summary?.mobileScore || 0)}">${r.summary?.mobileScore || 0}</div><div class="score-label">Mobile</div></div>
    </div>`;

    // Summary stats banner
    const avgScore = Math.round(((r.summary?.seoScore || 0) + (r.summary?.a11yScore || 0) + (r.summary?.htmlScore || 0) + (r.summary?.mobileScore || 0)) / 4);
    const bannerCls = avgScore >= 60 ? 'pass' : 'fail';
    html += `<div class="report-summary-banner ${bannerCls}">
      <span class="summary-badge">${avgScore}/100</span>
      <span class="summary-text">${r.summary?.totalPages || 0} pages · ${r.summary?.totalLinks || 0} links · <span style="color:${(r.summary?.brokenLinks || 0) > 0 ? 'var(--red)' : 'inherit'}">${r.summary?.brokenLinks || 0} broken</span></span>
    </div>`;

    // Pages
    if (r.pages?.length) {
      html += '<div style="font-size:11px;font-weight:600;color:var(--text2);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.5px">Pages</div>';
      for (const p of r.pages) {
        const cls = p.error ? 'fail' : 'pass';
        const icon = p.error ? '✗' : '✓';
        html += `<div class="run-step-row ${cls}">
          <span class="run-step-icon ${cls}">${icon}</span>
          <div class="run-step-info">
            <span class="run-step-name">${escHtml(p.title || p.url)}</span>
            <span class="run-step-error" style="color:var(--text3)">${p.error ? escHtml(p.error) : (p.totalLinks || 0) + ' links'}</span>
          </div>
        </div>`;
      }
    }

    // Broken links
    if (r.brokenLinks?.length) {
      html += '<div style="font-size:11px;font-weight:600;color:var(--red);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.5px">Broken Links</div>';
      for (const lnk of r.brokenLinks) {
        html += `<div class="run-step-row fail">
          <span class="run-step-icon fail">✗</span>
          <div class="run-step-info">
            <span class="run-step-name">${escHtml(lnk.text || lnk.url)}</span>
            <span class="run-step-error">${lnk.status || 'ERR'}</span>
          </div>
        </div>`;
      }
    }

    // Video segments download (from IDB or inline)
    const videoSegs = videoPayload?.type === 'segments' ? videoPayload.segments : r.videoSegments;
    if (videoSegs?.length) {
      html += `<div class="video-section">
        <div class="video-section-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
          Testing Video${videoSegs.length > 1 ? 's' : ''}
        </div>
        <div class="video-btn-grid">`;
      for (let i = 0; i < videoSegs.length; i++) {
        const seg = videoSegs[i];
        const segLabel = seg.label || `Page ${i + 1}`;
        html += `<button class="video-chip audit-report-video-btn" data-seg-idx="${i}">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
          ${escHtml(segLabel.length > 20 ? segLabel.slice(0, 20) + '…' : segLabel)}
        </button>`;
      }
      html += `</div></div>`;
    }

    body.innerHTML = html;

    // Wire audit video buttons
    body.querySelectorAll('.audit-report-video-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.segIdx, 10);
        const seg = videoSegs[idx];
        if (seg?.dataUrl) {
          downloadDataUrl(seg.dataUrl, `audit-recording-${idx + 1}.webm`);
          toast('Video downloaded', 'success');
        }
      });
    });
  }

  function renderRecordingDetail(body, data, videoPayload) {
    if (!data) { body.innerHTML = '<p class="task-empty">No recording data.</p>'; return; }
    const steps = data.steps || [];
    let html = '';

    // Summary banner
    html += `<div class="report-summary-banner pass">
      <span class="summary-badge">${steps.length} STEPS</span>
      <span class="summary-text">${data.url ? escHtml(data.url) : 'Recording'}</span>
    </div>`;

    // Video section
    const vidUrl = videoPayload?.type === 'single' ? videoPayload.dataUrl : null;
    if (vidUrl) {
      html += `<div class="video-section">
        <div class="video-section-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
          Recording Video
        </div>
        <div class="video-btn-grid">
          <button class="video-chip" id="btnRecDetailVideo">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
            Download Video
          </button>
        </div>
      </div>`;
    }

    // Action buttons
    if (data.code) {
      html += `<div class="report-action-bar">
        <button class="btn btn-outline btn-sm" id="btnRecDetailScript">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M4.72 3.22a.75.75 0 0 1 1.06 0l3.5 3.5a.75.75 0 0 1 0 1.06l-3.5 3.5a.75.75 0 0 1-1.06-1.06L7.69 7.25 4.72 4.28a.75.75 0 0 1 0-1.06Zm3.5 7.28a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75Z"/></svg>
          Download Script
        </button>
      </div>`;
    }

    // Steps list
    for (const step of steps) {
      const actionLabel = step.action || step.type || 'action';
      const detail = step.selector || step.value || step.url || '';
      html += `<div class="run-step-row pass">
        <span class="run-step-icon pass" style="font-size:9px;font-weight:700">${escHtml(actionLabel.slice(0, 3).toUpperCase())}</span>
        <div class="run-step-info">
          <span class="run-step-name">${escHtml(actionLabel)}${step.text ? ' — ' + escHtml(step.text) : ''}</span>
          ${detail ? `<span class="run-step-error" style="color:var(--text3);font-family:monospace;font-size:10px">${escHtml(detail.length > 80 ? detail.slice(0, 80) + '…' : detail)}</span>` : ''}
        </div>
      </div>`;
    }

    // Code preview
    if (data.code) {
      html += `<div style="margin-top:10px;font-size:11px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.5px">Generated Script</div>`;
      html += `<pre style="background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;max-height:200px;margin-top:4px"><code>${escHtml(data.code)}</code></pre>`;
    }

    body.innerHTML = html;

    // Wire buttons
    if (data.code) {
      document.getElementById('btnRecDetailScript')?.addEventListener('click', () => {
        const blob = new Blob([data.code], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'recording.test.js'; a.click();
        URL.revokeObjectURL(url);
        toast('Script downloaded', 'success');
      });
    }
    if (vidUrl) {
      document.getElementById('btnRecDetailVideo')?.addEventListener('click', () => {
        downloadDataUrl(vidUrl, 'recording.webm');
        toast('Video downloaded', 'success');
      });
    }
  }

  function exportReportAsPdf(report) {
    let html = '';
    if (report.type === 'audit' && report.data) {
      html = buildReportHtml(report.data);
    } else if (report.type === 'happy-flow' && report.data) {
      html = buildHappyFlowReportHtml(report.data, report.data.flowType || 'full');
    } else if (report.type === 'test-run') {
      html = buildTestRunReportHtml(report);
    } else if (report.type === 'recording') {
      html = buildRecordingReportHtml(report);
    }
    if (!html) { toast('Cannot export this report type', 'error'); return; }

    chrome.runtime.sendMessage({ type: 'OPEN_REPORT_TAB', payload: { html } }, () => void chrome.runtime.lastError);
    toast('Report opened — use Print dialog to save as PDF', 'success');
  }

  function buildTestRunReportHtml(report) {
    const results = report.data?.results || [];
    const summary = report.data?.summary || {};
    const now = new Date(report.createdAt).toLocaleString();
    const allPassed = summary.failed === 0;

    let stepsHtml = '';
    for (const r of results) {
      const color = r.status === 'pass' ? '#16a34a' : r.status === 'fail' ? '#dc2626' : '#6b7280';
      const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '—';
      stepsHtml += `<tr>
        <td style="color:${color};font-weight:700;text-align:center">${icon}</td>
        <td>${escHtml(r.name)}</td>
        <td style="font-family:monospace;font-size:12px">${r.duration || '—'}</td>
        <td style="color:#dc2626;font-size:12px">${r.error ? escHtml(r.error) : ''}</td>
      </tr>`;
    }

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escHtml(report.name)} — AI Testing Tools</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#1f2937}
  h1{font-size:22px;margin-bottom:4px} h2{font-size:16px;margin:20px 0 8px}
  .badge{display:inline-block;padding:2px 10px;border-radius:4px;font-size:13px;font-weight:600;color:#fff}
  .badge-pass{background:#16a34a} .badge-fail{background:#dc2626}
  table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e5e7eb}
  th{background:#f3f4f6;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .meta{font-size:12px;color:#6b7280;margin-bottom:16px}
</style></head><body>
  <h1>${escHtml(report.name)}</h1>
  <div class="meta">${now} · <span class="badge ${allPassed ? 'badge-pass' : 'badge-fail'}">${allPassed ? 'PASSED' : 'FAILED'}</span> · ${summary.passed || 0} passed · ${summary.failed || 0} failed</div>
  <table><thead><tr><th></th><th>Step</th><th>Duration</th><th>Error</th></tr></thead><tbody>${stepsHtml}</tbody></table>
</body></html>`;
  }

  function buildRecordingReportHtml(report) {
    const data = report.data || {};
    const steps = data.steps || [];
    const now = new Date(report.createdAt).toLocaleString();

    let stepsHtml = '';
    for (const s of steps) {
      const action = s.action || s.type || 'action';
      const sel = s.selector || '';
      stepsHtml += `<tr>
        <td style="font-weight:600;text-transform:uppercase;font-size:11px">${escHtml(action)}</td>
        <td style="font-family:monospace;font-size:11px">${escHtml(sel.length > 60 ? sel.slice(0, 60) + '…' : sel)}</td>
        <td>${escHtml(s.text || s.value || '')}</td>
      </tr>`;
    }

    let codeHtml = '';
    if (data.code) {
      codeHtml = `<h2>Generated Script</h2><pre style="background:#f3f4f6;padding:16px;border-radius:6px;font-size:12px;overflow-x:auto">${escHtml(data.code)}</pre>`;
    }

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${escHtml(report.name)} — AI Testing Tools</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#1f2937}
  h1{font-size:22px;margin-bottom:4px} h2{font-size:16px;margin:20px 0 8px}
  table{width:100%;border-collapse:collapse;font-size:13px;margin:8px 0}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e5e7eb}
  th{background:#f3f4f6;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
  .meta{font-size:12px;color:#6b7280;margin-bottom:16px}
</style></head><body>
  <h1>${escHtml(report.name)}</h1>
  <div class="meta">${now} · ${steps.length} steps${data.url ? ' · ' + escHtml(data.url) : ''}</div>
  <table><thead><tr><th>Action</th><th>Selector</th><th>Value</th></tr></thead><tbody>${stepsHtml}</tbody></table>
  ${codeHtml}
</body></html>`;
  }

  function filterReports(query) {
    const q = query.toLowerCase();
    $$('.report-item').forEach((item) => {
      const name = item.querySelector('.report-name')?.textContent.toLowerCase() || '';
      item.style.display = name.includes(q) ? '' : 'none';
    });
  }

  /* ── Copy helper ── */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard', 'success');
    } catch {
      toast('Failed to copy', 'error');
    }
  }

  /* ── Message Listener (from content script) ── */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'PW_STEP_RECORDED' && recording) {
      msg.step.stepIndex = recordedSteps.length;
      recordedSteps.push(msg.step);
      renderSteps();
      updateStepCount();
    }
    return false;
  });

  /* ── Happy Flow Execution ── */
  let hfPolling = false;

  async function runHappyFlow(flowType) {
    // Get current tab URL
    let tabUrl = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabUrl = tab?.url || '';
    } catch { /* ignore */ }

    if (!tabUrl || tabUrl.startsWith('chrome')) {
      toast('Navigate to a webpage first', 'error');
      return;
    }

    // Load test credentials from storage
    let testEmail = '', testPassword = '';
    try {
      const data = await chrome.storage.sync.get(['testEmail', 'testPassword']);
      testEmail = data.testEmail || '';
      testPassword = data.testPassword || '';
    } catch { /* ignore */ }

    const maxPages = parseInt($('#hfMaxPages')?.value, 10) || 5;

    if ((flowType === 'login' || flowType === 'full') && (!testEmail || !testPassword)) {
      promptForCredentials(flowType, tabUrl, testEmail, testPassword, maxPages);
      return;
    }

    startHappyFlowExecution(flowType, tabUrl, testEmail, testPassword, maxPages);
  }

  function promptForCredentials(flowType, tabUrl, savedEmail, savedPassword, maxPages) {
    const section = $('#happyFlowSection');
    section._originalHtml = section._originalHtml || section.innerHTML;
    section.innerHTML = `
      <div style="padding:12px 0">
        <div class="hf-header">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" style="color:var(--yellow)">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0"/>
          </svg>
          <span class="hf-title">Enter Test Credentials</span>
        </div>
        <p style="font-size:12px;color:var(--muted);margin:6px 0">Provide an email and password for the login flow. These will also be saved to Settings.</p>
        <div style="display:flex;flex-direction:column;gap:6px;margin:8px 0">
          <input id="hfEmail" type="email" class="text-input" placeholder="Email / username" value="${escHtml(savedEmail)}" style="font-size:12px;padding:6px 8px" />
          <input id="hfPassword" type="password" class="text-input" placeholder="Password" value="${escHtml(savedPassword)}" style="font-size:12px;padding:6px 8px" />
        </div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button id="btnHFRunLogin" class="btn btn-primary btn-sm" style="flex:1">Run ${flowType === 'full' ? 'Full Fledge' : 'Login'} Flow</button>
          <button id="btnHFCancel" class="btn btn-outline btn-sm">Cancel</button>
        </div>
      </div>`;

    document.getElementById('btnHFCancel')?.addEventListener('click', () => restoreHappyFlowCards(section));
    document.getElementById('btnHFRunLogin')?.addEventListener('click', () => {
      const email = document.getElementById('hfEmail')?.value.trim();
      const password = document.getElementById('hfPassword')?.value.trim();
      if (!email || !password) {
        toast('Both email and password are required', 'error');
        return;
      }
      // Save to storage for next time
      chrome.storage.sync.set({ testEmail: email, testPassword: password });
      startHappyFlowExecution(flowType, tabUrl, email, password, maxPages);
    });

    document.getElementById('hfEmail')?.focus();
  }

  function startHappyFlowExecution(flowType, tabUrl, testEmail, testPassword, maxPages) {
    const section = $('#happyFlowSection');
    section._originalHtml = section._originalHtml || section.innerHTML;
    section.innerHTML = `
      <div style="padding:12px 0">
        <div class="hf-header">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" style="color:var(--green)">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/>
          </svg>
          <span class="hf-title">Running ${flowType} flow…</span>
        </div>
        <div class="hf-recording-badge" style="display:flex;align-items:center;gap:6px;margin:6px 0;padding:4px 8px;background:rgba(255,0,0,0.08);border-radius:6px;font-size:11px;color:var(--red)">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);animation:pulse-rec 1.2s infinite"></span>
          Recording video…
        </div>
        <div class="audit-progress" style="margin:8px 0"><div class="audit-progress-bar" style="width:0%"></div></div>
        <div id="hfLogArea" class="audit-log" style="max-height:200px;overflow-y:auto;font-size:11px;margin:8px 0"></div>
        <div style="margin-top:8px;text-align:center">
          <button id="btnHFStop" class="btn btn-outline btn-sm" style="color:var(--red);border-color:var(--red)">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" style="vertical-align:-2px;margin-right:4px"><rect x="3" y="3" width="10" height="10" rx="1.5"/></svg>
            Stop &amp; Generate Report
          </button>
        </div>
      </div>`;

    // Wire up stop button
    document.getElementById('btnHFStop')?.addEventListener('click', () => {
      const btn = document.getElementById('btnHFStop');
      if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
      chrome.runtime.sendMessage({ type: 'ABORT_HAPPY_FLOW' }, () => void chrome.runtime.lastError);
    });

    chrome.runtime.sendMessage({
      type: 'RUN_HAPPY_FLOW',
      payload: { url: tabUrl, flowType, testEmail, testPassword, maxPages: maxPages || 5 },
    }, (res) => {
      if (chrome.runtime.lastError || res?.error) {
        toast(res?.error || chrome.runtime.lastError.message, 'error');
        restoreHappyFlowCards(section);
        return;
      }

      // Start polling
      hfPolling = true;
      pollHappyFlow(section, flowType);
    });
  }

  function pollHappyFlow(section, flowType) {
    if (!hfPolling) return;
    chrome.runtime.sendMessage({ type: 'GET_HAPPY_FLOW_STATUS' }, (status) => {
      if (chrome.runtime.lastError || !status) {
        hfPolling = false;
        restoreHappyFlowCards(section);
        return;
      }

      // Render logs
      const logArea = document.getElementById('hfLogArea');
      if (logArea && status.logs?.length) {
        logArea.innerHTML = status.logs.map((l) => {
          const color = l.level === 'error' ? 'var(--red)' : l.level === 'success' ? 'var(--green)' : l.level === 'warn' ? 'var(--yellow)' : 'var(--muted)';
          return `<div style="color:${color};padding:1px 0">${escHtml(l.message)}</div>`;
        }).join('');
        logArea.scrollTop = logArea.scrollHeight;
      }

      if (!status.running) {
        hfPolling = false;
        if (status.results && !status.results.error) {
          // skipSave=true because background auto-saves the report
          renderHappyFlowResults(section, status.results, flowType, true);
          chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_HF_RESULT' });
        } else {
          toast(status.results?.error || 'Flow failed', 'error');
          restoreHappyFlowCards(section);
        }
        return;
      }

      setTimeout(() => pollHappyFlow(section, flowType), 800);
    });
  }

  function restoreHappyFlowCards(section) {
    if (section._originalHtml) {
      section.innerHTML = section._originalHtml;
      wireHappyFlowCards();
    }
  }

  function renderHappyFlowResults(section, results, flowType, skipSave) {
    const steps = results.steps || [];
    const passed = steps.filter((s) => s.pass).length;
    const failed = steps.filter((s) => !s.pass).length;
    const elapsed = results.completedAt
      ? ((new Date(results.completedAt) - new Date(results.startedAt)) / 1000).toFixed(1) + 's'
      : '';

    // Auto-save to reports (skip if already saved by background)
    if (!skipSave) {
      const reportData = { ...results, flowType };
      saveReport(
        `${flowType.charAt(0).toUpperCase() + flowType.slice(1)} Flow — ${passed} passed, ${failed} failed`,
        'happy-flow',
        reportData,
      );
    } else {
      // Reload reports so the background-saved one shows in the list
      loadReports();
    }

    const bannerCls = failed === 0 ? 'pass' : 'fail';
    const bannerText = results.aborted ? 'STOPPED' : (failed === 0 ? 'ALL PASSED' : 'FAILED');
    const abortedNote = results.aborted ? ' <span style="font-size:10px;color:var(--yellow)">(stopped early by user)</span>' : '';

    let html = `
      <div class="inline-results-card">
        <div class="inline-results-header">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" style="color:var(--green)">
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/>
          </svg>
          <span class="hf-title">${flowType.charAt(0).toUpperCase() + flowType.slice(1)} Flow — Results</span>
          <span class="inline-results-elapsed">${elapsed}</span>
        </div>

        <div class="report-summary-banner ${bannerCls}">
          <span class="summary-badge">${bannerText}</span>
          <span class="summary-text">${passed} passed · ${failed} failed · ${steps.length} total steps${abortedNote}</span>
        </div>

        <div class="report-score-cards">
          <div class="report-score-card"><div class="score-num" style="color:var(--green)">${passed}</div><div class="score-label">Passed</div></div>
          <div class="report-score-card"><div class="score-num" style="color:${failed > 0 ? 'var(--red)' : 'var(--green)'}">${failed}</div><div class="score-label">Failed</div></div>
          <div class="report-score-card"><div class="score-num">${steps.length}</div><div class="score-label">Steps</div></div>
        </div>

        <div class="audit-details-list" style="margin:8px 0">`;

    for (const step of steps) {
      const cls = step.pass ? 'ok' : 'broken';
      const icon = step.pass ? '✓' : '✗';
      let label = step.type;
      let detail = '';

      if (step.type === 'sitemap-found') {
        label = 'Sitemap found';
        detail = `${step.totalUrls} URLs`;
      } else if (step.type === 'visit-page') {
        label = step.title || step.url;
        const seo = step.audit?.seo?.score;
        const a11y = step.audit?.accessibility?.score;
        detail = step.error || `Loaded OK${seo != null ? ` | SEO: ${seo}` : ''}${a11y != null ? ` | A11y: ${a11y}` : ''}`;
      } else if (step.type === 'visit-subpage') {
        label = `  → ${step.text || step.url}`;
        const seo = step.audit?.seo?.score;
        detail = step.error || `Loaded OK${seo != null ? ` | SEO: ${seo}` : ''}`;
      } else if (step.type === 'collect-links') {
        label = 'Collected internal links';
        detail = `${step.totalLinks} links found`;
      } else if (step.type === 'check-link') {
        label = step.text || step.url;
        detail = step.status ? `HTTP ${step.status}` : (step.error || 'ERR');
      } else if (step.type === 'form-test') {
        label = step.formId ? `Form: ${step.formId}` : 'Form test';
        detail = step.error || `${step.fields || 0} fields, ${(step.validationErrors || []).length} errors`;
      } else if (step.type === 'login') {
        label = 'Login attempt';
        detail = step.error || (step.pass ? 'Success' : (step.loginError || 'Failed'));
      } else if (step.type === 'find-login-page') {
        label = 'Found login page';
        detail = step.url;
      } else if (step.type === 'sitemap') {
        label = 'Sitemap check';
        detail = step.error || `${step.totalUrls} URLs at ${step.sitemapUrl}`;
      } else if (step.type === 'crawl-summary') {
        label = 'Deep crawl complete';
        const b = step.buckets || {};
        detail = `${step.totalVisited} pages — ${b.category || 0} categories, ${b.jobDetail || 0} jobs, ${b.company || 0} companies`;
      } else if (step.type === 'link-click') {
        label = `🔗 ${step.text || step.url}`;
        detail = step.error || `Clicked → ${step.title || step.finalUrl || 'Loaded OK'}`;
      }

      // Show page type badge for visit-page steps
      const typeBadge = step.pageType ? `<span style="font-size:9px;background:var(--border);padding:1px 5px;border-radius:3px;margin-left:4px;text-transform:uppercase">${escHtml(step.pageType)}</span>` : '';

      html += `<div class="audit-row ${cls}"><span class="audit-row-icon">${icon}</span><span class="audit-row-text">${escHtml(label)}${typeBadge}</span><span class="audit-row-status">${escHtml(detail)}</span></div>`;
    }

    const hasVideos = results.videoSegments && results.videoSegments.length > 0;
    const hasVideoFlag = results._hasVideo;

    html += `</div>`;

    // Video section — always show if videos exist (inline or in IDB)
    if (hasVideos || hasVideoFlag) {
      const segCount = hasVideos ? results.videoSegments.length : 0;
      html += `
        <div class="video-section" id="hfVideoSection">
          <div class="video-section-header">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
            Testing Video${segCount > 1 ? 's' : ''}
          </div>
          <div class="video-btn-grid" id="hfVideoBtnGrid">
            ${hasVideos ? results.videoSegments.map((seg, i) => {
              const segLabel = seg.label || `Segment ${i + 1}`;
              return `<button class="video-chip hf-inline-video-btn" data-seg-idx="${i}">
                <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg>
                ${escHtml(segLabel.length > 25 ? segLabel.slice(0, 25) + '…' : segLabel)}
              </button>`;
            }).join('') : '<span style="font-size:11px;color:var(--text3)">Video saved — open report in Tests tab to download</span>'}
          </div>
        </div>`;
    }

    html += `
        <div class="report-action-bar">
          <button class="btn btn-outline btn-sm" id="btnHFBack">← Back</button>
          <button class="btn btn-outline btn-sm" id="btnHFDownloadVideo" style="border-color:var(--red);color:var(--red)">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
            Download Video
          </button>
          <button class="btn btn-success btn-sm" id="btnHFScript">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
            Download .test.js
          </button>
          <button class="btn btn-outline btn-sm" id="btnHFScriptPW" style="border-color:#2ea043;color:#2ea043">
            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
            Playwright .spec.js
          </button>
          <button class="btn btn-primary btn-sm" id="btnHFPdf">📄 Download PDF</button>
        </div>
      </div>`;

    section.innerHTML = html;
    section._hfResults = results;
    section._hfFlowType = flowType;
    document.getElementById('btnHFBack')?.addEventListener('click', () => restoreHappyFlowCards(section));
    document.getElementById('btnHFPdf')?.addEventListener('click', () => downloadHappyFlowPdf(results, flowType));
    document.getElementById('btnHFScript')?.addEventListener('click', () => downloadHappyFlowScript(results, flowType));
    document.getElementById('btnHFScriptPW')?.addEventListener('click', () => downloadHappyFlowPlaywrightScript(results, flowType));
    document.getElementById('btnHFDownloadVideo')?.addEventListener('click', async () => {
      // Try 1: Download from video segments metadata (has dataUrl or idbKey)
      const validSegments = (results.videoSegments || []).filter((s) => s.dataUrl || s.idbKey || s.savedToIdb || s.hasData);
      if (validSegments.length) {
        await downloadVideoSegments(validSegments, `${flowType}-flow`);
        return;
      }

      // Try 2: Scan IDB for any __hf_segment_* or __latest_recording keys
      try {
        const allKeys = await getAllVideoKeysFromDb();
        const segKeys = allKeys.filter((k) => typeof k === 'string' && (k.startsWith('__hf_segment_') || k === '__latest_recording'));
        if (segKeys.length) {
          let downloaded = 0;
          for (let i = 0; i < segKeys.length; i++) {
            const videoData = await getVideoFromDb(segKeys[i]);
            if (videoData?.blob) {
              const url = URL.createObjectURL(videoData.blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${flowType}-flow-recording-${i + 1}.webm`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 5000);
              downloaded++;
            }
          }
          if (downloaded > 0) {
            toast(`${downloaded} video${downloaded > 1 ? 's' : ''} downloaded`, 'success');
            return;
          }
        }
      } catch { /* IDB scan failed */ }

      toast('No video recordings captured — video recording requires an active browser tab', 'error');
    });

    // Wire inline video download buttons
    if (hasVideos) {
      document.querySelectorAll('.hf-inline-video-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.segIdx, 10);
          const seg = results.videoSegments[idx];
          const filename = `${flowType}-recording-${idx + 1}.webm`;
          if (seg?.dataUrl) {
            downloadDataUrl(seg.dataUrl, filename);
            toast('Video downloaded', 'success');
          } else if (seg?.idbKey || seg?.savedToIdb || seg?.hasData) {
            try {
              const videoData = await getVideoFromDb(seg.idbKey || '__latest_recording');
              if (videoData?.blob) {
                const url = URL.createObjectURL(videoData.blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                toast('Video downloaded', 'success');
              } else {
                toast('Video not found in storage', 'error');
              }
            } catch { toast('Failed to load video', 'error'); }
          }
        });
      });
    }

    // If _hasVideo but no inline segments, try loading from IDB
    if (hasVideoFlag && !hasVideos) {
      loadHFVideoFromIDB(results, flowType);
    }
  }

  async function loadHFVideoFromIDB(results, flowType) {
    try {
      const store = await chrome.storage.local.get({ pw_reports: [] });
      const reports = store.pw_reports || [];
      const matchReport = reports.find((r) => r.type === 'happy-flow' && r.data?._hasVideo);
      if (!matchReport) return;
      const videoPayload = await getVideoFromDb(matchReport.id);
      if (!videoPayload?.segments?.length) return;
      const grid = document.getElementById('hfVideoBtnGrid');
      if (!grid) return;
      grid.innerHTML = videoPayload.segments.map((seg, i) => {
        const segLabel = seg.label || `Segment ${i + 1}`;
        return `<button class="video-chip hf-inline-video-btn" data-seg-idx="${i}">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg>
          ${escHtml(segLabel.length > 25 ? segLabel.slice(0, 25) + '…' : segLabel)}
        </button>`;
      }).join('');
      grid.querySelectorAll('.hf-inline-video-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.segIdx, 10);
          const seg = videoPayload.segments[idx];
          if (seg?.dataUrl) {
            downloadDataUrl(seg.dataUrl, `${flowType}-recording-${idx + 1}.webm`);
            toast('Video downloaded', 'success');
          }
        });
      });
    } catch (e) {
      console.warn('[HF] Failed to load video from IDB:', e);
    }
  }

  /* ── Happy Flow PDF Report ── */
  function downloadHappyFlowPdf(results, flowType) {
    const html = buildHappyFlowReportHtml(results, flowType);
    chrome.runtime.sendMessage({ type: 'OPEN_REPORT_TAB', payload: { html } }, () => void chrome.runtime.lastError);
    toast('Report opened — use Print dialog to save as PDF', 'success');
  }

  /* ── Happy Flow Test Script Download ── */
  function downloadHappyFlowScript(results, flowType) {
    const code = generateHappyFlowTestCode(results, flowType);
    const safeName = `happy-flow-${flowType}-${Date.now()}`;
    downloadText(code, `${safeName}.test.js`);
    // Also save to suites
    saveSuite(`Happy Flow: ${flowType}`, code, 'happy-flow');
    toast('Test script downloaded & saved to Suites', 'success');
  }

  function downloadHappyFlowPlaywrightScript(results, flowType) {
    const code = generateHappyFlowPlaywrightCode(results, flowType);
    const safeName = `happy-flow-${flowType}-${Date.now()}`;
    downloadText(code, `${safeName}.spec.js`);
    saveSuite(`Happy Flow (Playwright): ${flowType}`, code, 'happy-flow');
    toast('Playwright script downloaded & saved to Suites', 'success');
  }

  async function downloadVideoSegments(segments, label) {
    if (!segments || !segments.length) {
      toast('No video recordings available', 'error');
      return;
    }
    let downloaded = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.failed && !seg.dataUrl && !seg.savedToIdb && !seg.hasData) continue; // Skip known-failed segments
      const segLabel = seg.label ? seg.label.replace(/[^a-z0-9-_]/gi, '_').slice(0, 40) : `segment-${i + 1}`;
      const filename = `${label || 'recording'}-${segLabel}.webm`;

      if (seg.dataUrl) {
        downloadDataUrl(seg.dataUrl, filename);
        downloaded++;
      } else if (seg.idbKey || seg.savedToIdb || seg.hasData) {
        // Load from IndexedDB using segment-specific key or fallback
        try {
          const videoData = await getVideoFromDb(seg.idbKey || '__latest_recording');
          if (videoData?.blob) {
            const url = URL.createObjectURL(videoData.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            downloaded++;
          }
        } catch (e) {
          console.warn(`[Video] Failed to load segment ${i} from IDB:`, e);
        }
      }
    }
    if (downloaded > 0) {
      toast(`${downloaded} video${downloaded > 1 ? 's' : ''} downloaded`, 'success');
    } else {
      // Final fallback: scan IDB for any segment keys
      try {
        const allKeys = await getAllVideoKeysFromDb();
        const segKeys = allKeys.filter((k) => typeof k === 'string' && k.startsWith('__hf_segment_'));
        let fallbackCount = 0;
        for (const key of segKeys) {
          const videoData = await getVideoFromDb(key);
          if (videoData?.blob) {
            const url = URL.createObjectURL(videoData.blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${label || 'recording'}-segment-${fallbackCount + 1}.webm`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            fallbackCount++;
          }
        }
        if (fallbackCount > 0) {
          toast(`${fallbackCount} video${fallbackCount > 1 ? 's' : ''} recovered from storage`, 'success');
          return;
        }
      } catch { /* IDB scan failed */ }
      toast('No video recordings could be loaded', 'error');
    }
  }

  function generateHappyFlowTestCode(results, flowType) {
    const steps = results.steps || [];
    const baseUrl = escJsStr(results.url || '');
    const lines = [];

    lines.push(`const puppeteer = require('puppeteer');`);
    lines.push('');
    lines.push(`/**`);
    lines.push(` * Happy Flow: ${flowType} — auto-generated by AI Testing Tools`);
    lines.push(` * Base URL: ${results.url || ''}`);
    lines.push(` * Generated: ${new Date().toISOString()}`);
    lines.push(` * Steps: ${steps.length} (${steps.filter((s) => s.pass).length} passed, ${steps.filter((s) => !s.pass).length} failed)`);
    lines.push(` */`);
    lines.push('');
    lines.push(`describe('Happy Flow — ${flowType}', () => {`);
    lines.push(`  let browser, page;`);
    lines.push(`  const BASE_URL = '${baseUrl}';`);
    lines.push('');
    lines.push(`  beforeAll(async () => {`);
    lines.push(`    browser = await puppeteer.launch({ headless: 'new' });`);
    lines.push(`    page = await browser.newPage();`);
    lines.push(`    await page.setViewport({ width: 1280, height: 720 });`);
    lines.push(`  });`);
    lines.push('');
    lines.push(`  afterAll(async () => {`);
    lines.push(`    await browser.close();`);
    lines.push(`  });`);
    lines.push('');

    // Group steps by type to create meaningful test blocks
    const visitSteps = steps.filter((s) => s.type === 'visit-page');
    const linkSteps = steps.filter((s) => s.type === 'link-check');
    const formSteps = steps.filter((s) => s.type === 'form-test');
    const loginSteps = steps.filter((s) => s.type === 'login' || s.type === 'find-login-page');
    const sitemapSteps = steps.filter((s) => s.type === 'sitemap' || s.type === 'sitemap-found');

    // Navigation tests
    if (visitSteps.length) {
      lines.push(`  describe('Page Navigation', () => {`);
      for (const step of visitSteps) {
        const url = escJsStr(step.url || '');
        const title = escJsStr(step.title || step.url || 'page');
        lines.push(`    it('should load: ${title.slice(0, 60)}', async () => {`);
        lines.push(`      const res = await page.goto('${url}', { waitUntil: 'networkidle0', timeout: 30000 });`);
        lines.push(`      expect(res.status()).toBeLessThan(400);`);
        if (step.title) {
          lines.push(`      const pageTitle = await page.title();`);
          lines.push(`      expect(pageTitle).toBeTruthy();`);
        }
        // Add SEO assertion if audit data exists
        if (step.audit?.seo?.score != null) {
          lines.push(`      // SEO score was ${step.audit.seo.score}/100 during happy flow`);
        }
        lines.push(`    }, 30000);`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Link check tests
    if (linkSteps.length) {
      lines.push(`  describe('Internal Links', () => {`);
      const uniqueLinks = [];
      const seen = new Set();
      for (const step of linkSteps) {
        if (step.url && !seen.has(step.url)) {
          seen.add(step.url);
          uniqueLinks.push(step);
        }
      }
      for (const step of uniqueLinks.slice(0, 50)) {
        const url = escJsStr(step.url || '');
        const text = escJsStr(step.text || step.url || 'link');
        lines.push(`    it('link: ${text.slice(0, 50)}', async () => {`);
        lines.push(`      const res = await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 15000 });`);
        lines.push(`      expect(res.status()).toBeLessThan(400);`);
        lines.push(`    }, 15000);`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Form tests
    if (formSteps.length) {
      lines.push(`  describe('Form Submission', () => {`);
      for (let i = 0; i < formSteps.length; i++) {
        const step = formSteps[i];
        const formId = escJsStr(step.formId || `form-${i + 1}`);
        lines.push(`    it('should test ${formId}', async () => {`);
        lines.push(`      await page.goto(BASE_URL, { waitUntil: 'networkidle0' });`);
        if (step.formId) {
          lines.push(`      const form = await page.$('form#${escJsStr(step.formId)}');`);
        } else {
          lines.push(`      const form = await page.$('form');`);
        }
        lines.push(`      expect(form).not.toBeNull();`);
        lines.push('');
        lines.push(`      // Fill form fields with test data`);
        lines.push(`      const inputs = await form.$$('input:not([type="hidden"]):not([type="submit"])');`);
        lines.push(`      for (const input of inputs) {`);
        lines.push(`        const type = await input.evaluate(el => el.type);`);
        lines.push(`        if (type === 'email') await input.type('test@example.com');`);
        lines.push(`        else if (type === 'password') await input.type('TestPass123!');`);
        lines.push(`        else if (type === 'text') await input.type('Test input');`);
        lines.push(`        else if (type === 'tel') await input.type('+1234567890');`);
        lines.push(`        else if (type === 'number') await input.type('42');`);
        lines.push(`      }`);
        lines.push('');
        lines.push(`      // Submit form`);
        lines.push(`      const submit = await form.$('[type="submit"], button:not([type="button"])');`);
        lines.push(`      if (submit) await submit.click();`);
        lines.push(`      await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});`);
        if (step.validationErrors?.length) {
          lines.push(`      // Note: ${step.validationErrors.length} validation errors were found during happy flow`);
        }
        lines.push(`    }, 30000);`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Login flow tests
    if (loginSteps.length) {
      const loginPage = loginSteps.find((s) => s.type === 'find-login-page');
      const loginAttempt = loginSteps.find((s) => s.type === 'login');
      lines.push(`  describe('Login Flow', () => {`);
      if (loginPage) {
        lines.push(`    it('should find the login page', async () => {`);
        lines.push(`      const res = await page.goto('${escJsStr(loginPage.url || '')}', { waitUntil: 'networkidle0' });`);
        lines.push(`      expect(res.status()).toBeLessThan(400);`);
        lines.push(`      const emailField = await page.$('input[type="email"], input[name="email"], input[name="username"]');`);
        lines.push(`      expect(emailField).not.toBeNull();`);
        lines.push(`    }, 15000);`);
        lines.push('');
      }
      if (loginAttempt) {
        lines.push(`    it('should login with test credentials', async () => {`);
        if (loginPage?.url) {
          lines.push(`      await page.goto('${escJsStr(loginPage.url)}', { waitUntil: 'networkidle0' });`);
        }
        lines.push(`      const emailField = await page.$('input[type="email"], input[name="email"], input[name="username"]');`);
        lines.push(`      const passField = await page.$('input[type="password"]');`);
        lines.push(`      expect(emailField).not.toBeNull();`);
        lines.push(`      expect(passField).not.toBeNull();`);
        lines.push('');
        lines.push(`      await emailField.click({ clickCount: 3 });`);
        lines.push(`      await emailField.type(process.env.TEST_EMAIL || 'test@example.com');`);
        lines.push(`      await passField.click({ clickCount: 3 });`);
        lines.push(`      await passField.type(process.env.TEST_PASSWORD || 'password');`);
        lines.push('');
        lines.push(`      const submitBtn = await page.$('button[type="submit"], input[type="submit"]');`);
        lines.push(`      if (submitBtn) await submitBtn.click();`);
        lines.push(`      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});`);
        if (loginAttempt.pass) {
          lines.push(`      // Login was successful during happy flow`);
        } else {
          lines.push(`      // Note: login failed during happy flow: ${escJsStr(loginAttempt.loginError || loginAttempt.error || '')}`);
        }
        lines.push(`    }, 30000);`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Sitemap test
    if (sitemapSteps.length) {
      const sm = sitemapSteps[0];
      lines.push(`  describe('Sitemap', () => {`);
      lines.push(`    it('should have an accessible sitemap', async () => {`);
      lines.push(`      const res = await page.goto(BASE_URL + '/sitemap.xml', { waitUntil: 'networkidle0', timeout: 10000 });`);
      lines.push(`      expect(res.status()).toBeLessThan(400);`);
      lines.push(`      const content = await page.content();`);
      lines.push(`      expect(content).toContain('<urlset');`);
      if (sm.totalUrls) {
        lines.push(`      // Sitemap had ${sm.totalUrls} URLs during happy flow`);
      }
      lines.push(`    }, 15000);`);
      lines.push(`  });`);
      lines.push('');
    }

    lines.push(`});`);
    lines.push('');
    return lines.join('\n');
  }

  /* ── Happy Flow Playwright Code Generator ── */
  function generateHappyFlowPlaywrightCode(results, flowType) {
    const steps = results.steps || [];
    const baseUrl = escJsStr(results.url || '');
    const lines = [];

    lines.push(`const { test, expect } = require('@playwright/test');`);
    lines.push('');
    lines.push(`/**`);
    lines.push(` * Happy Flow: ${flowType} — auto-generated by AI Testing Tools`);
    lines.push(` * Base URL: ${results.url || ''}`);
    lines.push(` * Generated: ${new Date().toISOString()}`);
    lines.push(` * Steps: ${steps.length} (${steps.filter((s) => s.pass).length} passed, ${steps.filter((s) => !s.pass).length} failed)`);
    lines.push(` */`);
    lines.push('');
    lines.push(`test.describe('Happy Flow — ${flowType}', () => {`);
    lines.push(`  const BASE_URL = '${baseUrl}';`);
    lines.push(`  test.use({ viewport: { width: 1280, height: 720 } });`);
    lines.push('');

    const visitSteps = steps.filter((s) => s.type === 'visit-page');
    const linkSteps = steps.filter((s) => s.type === 'link-check');
    const formSteps = steps.filter((s) => s.type === 'form-test');
    const loginSteps = steps.filter((s) => s.type === 'login' || s.type === 'find-login-page');
    const sitemapSteps = steps.filter((s) => s.type === 'sitemap' || s.type === 'sitemap-found');

    // Navigation tests
    if (visitSteps.length) {
      lines.push(`  test.describe('Page Navigation', () => {`);
      for (const step of visitSteps) {
        const url = escJsStr(step.url || '');
        const title = escJsStr(step.title || step.url || 'page');
        lines.push(`    test('should load: ${title.slice(0, 60)}', async ({ page }) => {`);
        lines.push(`      const res = await page.goto('${url}', { waitUntil: 'networkidle', timeout: 30000 });`);
        lines.push(`      expect(res.status()).toBeLessThan(400);`);
        if (step.title) {
          lines.push(`      await expect(page).toHaveTitle(/.+/);`);
        }
        if (step.audit?.seo?.score != null) {
          lines.push(`      // SEO score was ${step.audit.seo.score}/100 during happy flow`);
        }
        lines.push(`    });`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Link check tests
    if (linkSteps.length) {
      lines.push(`  test.describe('Internal Links', () => {`);
      const uniqueLinks = [];
      const seen = new Set();
      for (const step of linkSteps) {
        if (step.url && !seen.has(step.url)) {
          seen.add(step.url);
          uniqueLinks.push(step);
        }
      }
      for (const step of uniqueLinks.slice(0, 50)) {
        const url = escJsStr(step.url || '');
        const text = escJsStr(step.text || step.url || 'link');
        lines.push(`    test('link: ${text.slice(0, 50)}', async ({ page }) => {`);
        lines.push(`      const res = await page.goto('${url}', { waitUntil: 'domcontentloaded', timeout: 15000 });`);
        lines.push(`      expect(res.status()).toBeLessThan(400);`);
        lines.push(`    });`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Form tests
    if (formSteps.length) {
      lines.push(`  test.describe('Form Submission', () => {`);
      for (let i = 0; i < formSteps.length; i++) {
        const step = formSteps[i];
        const formId = escJsStr(step.formId || `form-${i + 1}`);
        lines.push(`    test('should test ${formId}', async ({ page }) => {`);
        lines.push(`      await page.goto(BASE_URL, { waitUntil: 'networkidle' });`);
        if (step.formId) {
          lines.push(`      const form = page.locator('form#${escJsStr(step.formId)}');`);
        } else {
          lines.push(`      const form = page.locator('form').first();`);
        }
        lines.push(`      await expect(form).toBeVisible();`);
        lines.push('');
        lines.push(`      // Fill form fields with test data`);
        lines.push(`      for (const input of await form.locator('input:not([type="hidden"]):not([type="submit"])').all()) {`);
        lines.push(`        const type = await input.getAttribute('type') || 'text';`);
        lines.push(`        if (type === 'email') await input.fill('test@example.com');`);
        lines.push(`        else if (type === 'password') await input.fill('TestPass123!');`);
        lines.push(`        else if (type === 'text') await input.fill('Test input');`);
        lines.push(`        else if (type === 'tel') await input.fill('+1234567890');`);
        lines.push(`        else if (type === 'number') await input.fill('42');`);
        lines.push(`      }`);
        lines.push('');
        lines.push(`      // Submit form`);
        lines.push(`      const submit = form.locator('[type="submit"], button:not([type="button"])').first();`);
        lines.push(`      if (await submit.count()) await submit.click();`);
        lines.push(`      await page.waitForLoadState('networkidle').catch(() => {});`);
        if (step.validationErrors?.length) {
          lines.push(`      // Note: ${step.validationErrors.length} validation errors were found during happy flow`);
        }
        lines.push(`    });`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Login flow tests
    if (loginSteps.length) {
      const loginPage = loginSteps.find((s) => s.type === 'find-login-page');
      const loginAttempt = loginSteps.find((s) => s.type === 'login');
      lines.push(`  test.describe('Login Flow', () => {`);
      if (loginPage) {
        lines.push(`    test('should find the login page', async ({ page }) => {`);
        lines.push(`      const res = await page.goto('${escJsStr(loginPage.url || '')}', { waitUntil: 'networkidle' });`);
        lines.push(`      expect(res.status()).toBeLessThan(400);`);
        lines.push(`      const emailField = page.locator('input[type="email"], input[name="email"], input[name="username"]').first();`);
        lines.push(`      await expect(emailField).toBeVisible();`);
        lines.push(`    });`);
        lines.push('');
      }
      if (loginAttempt) {
        lines.push(`    test('should login with test credentials', async ({ page }) => {`);
        if (loginPage?.url) {
          lines.push(`      await page.goto('${escJsStr(loginPage.url)}', { waitUntil: 'networkidle' });`);
        }
        lines.push(`      const emailField = page.locator('input[type="email"], input[name="email"], input[name="username"]').first();`);
        lines.push(`      const passField = page.locator('input[type="password"]').first();`);
        lines.push(`      await expect(emailField).toBeVisible();`);
        lines.push(`      await expect(passField).toBeVisible();`);
        lines.push('');
        lines.push(`      await emailField.fill(process.env.TEST_EMAIL || 'test@example.com');`);
        lines.push(`      await passField.fill(process.env.TEST_PASSWORD || 'password');`);
        lines.push('');
        lines.push(`      const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();`);
        lines.push(`      if (await submitBtn.count()) await submitBtn.click();`);
        lines.push(`      await page.waitForLoadState('networkidle').catch(() => {});`);
        if (loginAttempt.pass) {
          lines.push(`      // Login was successful during happy flow`);
        } else {
          lines.push(`      // Note: login failed during happy flow: ${escJsStr(loginAttempt.loginError || loginAttempt.error || '')}`);
        }
        lines.push(`    });`);
        lines.push('');
      }
      lines.push(`  });`);
      lines.push('');
    }

    // Sitemap test
    if (sitemapSteps.length) {
      const sm = sitemapSteps[0];
      lines.push(`  test.describe('Sitemap', () => {`);
      lines.push(`    test('should have an accessible sitemap', async ({ page }) => {`);
      lines.push(`      const res = await page.goto(BASE_URL + '/sitemap.xml', { waitUntil: 'networkidle', timeout: 10000 });`);
      lines.push(`      expect(res.status()).toBeLessThan(400);`);
      lines.push(`      const content = await page.content();`);
      lines.push(`      expect(content).toContain('<urlset');`);
      if (sm.totalUrls) {
        lines.push(`      // Sitemap had ${sm.totalUrls} URLs during happy flow`);
      }
      lines.push(`    });`);
      lines.push(`  });`);
      lines.push('');
    }

    lines.push(`});`);
    lines.push('');
    return lines.join('\n');
  }

  function buildHappyFlowReportHtml(results, flowType) {
    const now = new Date().toLocaleString();
    const steps = results.steps || [];
    const passed = steps.filter((s) => s.pass).length;
    const failed = steps.filter((s) => !s.pass).length;
    const pageAudits = results.pageAudits || [];
    const elapsed = results.completedAt
      ? ((new Date(results.completedAt) - new Date(results.startedAt)) / 1000).toFixed(1) + 's'
      : '';
    const siteName = (() => { try { return new URL(results.url).hostname.replace(/^www\./, ''); } catch { return results.url || 'Site'; } })();
    const faviconSrc = (() => { try { return new URL(results.url).origin + '/favicon.ico'; } catch { return ''; } })();
    const flowLabel = flowType.charAt(0).toUpperCase() + flowType.slice(1);

    // Compute avg scores from page audits
    const scores = { seo: [], a11y: [], html: [] };
    for (const pa of pageAudits) {
      if (pa.audit?.seo?.score != null) scores.seo.push(pa.audit.seo.score);
      if (pa.audit?.accessibility?.score != null) scores.a11y.push(pa.audit.accessibility.score);
      if (pa.audit?.html?.score != null) scores.html.push(pa.audit.html.score);
    }
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const avgSeo = avg(scores.seo);
    const avgA11y = avg(scores.a11y);
    const avgHtml = avg(scores.html);
    const avgAll = scores.seo.length ? Math.round((avgSeo + avgA11y + avgHtml) / 3) : 0;
    const overallGrade = avgAll >= 90 ? 'A' : avgAll >= 80 ? 'B' : avgAll >= 70 ? 'C' : avgAll >= 50 ? 'D' : 'F';
    const gradeColor = avgAll >= 80 ? '#16a34a' : avgAll >= 50 ? '#ca8a04' : '#dc2626';
    const bannerGradient = failed === 0 ? 'linear-gradient(135deg,#059669,#10b981)' : 'linear-gradient(135deg,#dc2626,#ef4444)';
    const scoreColor = (s) => typeof s === 'number' ? (s >= 80 ? '#16a34a' : s >= 50 ? '#ca8a04' : '#dc2626') : '#6b7280';

    const scoreRing = (score, label) => {
      const c = score >= 80 ? '#16a34a' : score >= 50 ? '#ca8a04' : '#dc2626';
      const dash = (Math.min(100, Math.max(0, score)) / 100) * 251.2;
      return `<div style="text-align:center;flex:1;min-width:100px">
        <svg width="72" height="72" viewBox="0 0 90 90"><circle cx="45" cy="45" r="40" fill="none" stroke="#e5e7eb" stroke-width="6"/><circle cx="45" cy="45" r="40" fill="none" stroke="${c}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash} 251.2" transform="rotate(-90 45 45)"/><text x="45" y="50" text-anchor="middle" font-size="20" font-weight="700" fill="${c}">${score}</text></svg>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-top:2px">${label}</div></div>`;
    };

    // Pages table
    let pagesHtml = '';
    if (pageAudits.length) {
      pagesHtml = `<div class="section"><div class="section-hd"><span>📄</span>Pages Crawled <span class="badge">${pageAudits.length}</span></div><table><thead><tr><th>#</th><th>Type</th><th>URL</th><th>Title</th><th>Links</th><th>SEO</th><th>A11y</th><th>HTML</th></tr></thead><tbody>`;
      pageAudits.forEach((pa, i) => {
        const seo = pa.audit?.seo?.score ?? '—';
        const a11y = pa.audit?.accessibility?.score ?? '—';
        const htmlS = pa.audit?.html?.score ?? '—';
        const links = pa.audit?.totalLinks ?? '—';
        const pType = pa.pageType || '—';
        pagesHtml += `<tr><td>${i + 1}</td><td style="text-transform:capitalize">${escHtml(pType)}</td><td style="word-break:break-all;max-width:250px">${escHtml(pa.url)}</td><td>${escHtml(pa.title || '—')}</td><td>${links}</td><td style="color:${scoreColor(seo)};font-weight:600">${seo}</td><td style="color:${scoreColor(a11y)};font-weight:600">${a11y}</td><td style="color:${scoreColor(htmlS)};font-weight:600">${htmlS}</td></tr>`;
      });
      pagesHtml += '</tbody></table></div>';
    }

    // Issue sections
    const issueSection = (title, icon, pages, getAudit) => {
      const filtered = pages.filter((pa) => getAudit(pa)?.issues?.length);
      if (!filtered.length) return '';
      let html = `<div class="section"><div class="section-hd"><span>${icon}</span>${escHtml(title)} <span class="badge">${filtered.length} pages</span></div>`;
      for (const pg of filtered) {
        const audit = getAudit(pg);
        const color = audit.score >= 80 ? '#16a34a' : audit.score >= 50 ? '#ca8a04' : '#dc2626';
        html += `<div class="pg-audit"><div class="pg-hd"><span class="pg-score" style="color:${color}">${audit.score}</span><span class="pg-url">${escHtml(pg.title || pg.url)}</span></div><ul class="issues">`;
        for (const iss of audit.issues) {
          const cls = iss.severity === 'error' ? 'iss-err' : iss.severity === 'warn' ? 'iss-warn' : 'iss-info';
          html += `<li class="${cls}">${escHtml(iss.msg || iss.message || '')}</li>`;
        }
        html += '</ul></div>';
      }
      return html + '</div>';
    };

    const seoSection = issueSection('SEO Issues', '🔍', pageAudits, (p) => p.audit?.seo);
    const a11ySection = issueSection('Accessibility Issues', '♿', pageAudits, (p) => p.audit?.accessibility);
    const htmlSection = issueSection('HTML Validation', '🧪', pageAudits, (p) => p.audit?.html);

    // Steps detail
    let stepsHtml = `<div class="section"><div class="section-hd"><span>📋</span>All Steps <span class="badge">${steps.length}</span></div><table><thead><tr><th>#</th><th>Type</th><th>Page Type</th><th>Detail</th><th>Result</th></tr></thead><tbody>`;
    steps.forEach((step, i) => {
      let detail = step.url || step.formId || '';
      const resultIcon = step.pass ? '✓' : '✕';
      const resultColor = step.pass ? '#16a34a' : '#dc2626';
      let resultText = step.pass ? 'Pass' : 'Fail';
      if (step.error) resultText += ` — ${step.error}`;
      if (step.type === 'visit-page' || step.type === 'visit-subpage') detail = step.title || step.url || '';
      if (step.type === 'link-click') detail = `${step.text || ''} → ${step.title || step.finalUrl || step.url || ''}`;
      if (step.type === 'login') detail = step.pass ? 'Login succeeded' : (step.loginError || step.error || 'Login failed');
      if (step.type === 'crawl-summary') {
        const b = step.buckets || {};
        detail = `${step.totalVisited} pages: ${b.category || 0} cat, ${b.jobDetail || 0} jobs, ${b.company || 0} co, ${b.search || 0} search`;
      }
      const pType = step.pageType || '';
      stepsHtml += `<tr><td>${i + 1}</td><td><span class="pill">${escHtml(step.type)}</span></td><td style="text-transform:capitalize">${escHtml(pType)}</td><td style="word-break:break-all;max-width:300px">${escHtml(detail)}</td><td style="color:${resultColor};font-weight:600">${resultIcon} ${escHtml(resultText)}</td></tr>`;
    });
    stepsHtml += '</tbody></table></div>';

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${flowLabel} Flow Report — ${escHtml(siteName)}</title>
<style>
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.no-print{display:none}@page{margin:1cm}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;max-width:960px;margin:0 auto;color:#1f2937;line-height:1.6;font-size:14px;background:#f8fafc}
  .hero{background:${bannerGradient};color:#fff;padding:40px 48px 32px;border-radius:0 0 24px 24px;position:relative;overflow:hidden}
  .hero::before{content:'';position:absolute;top:-40%;right:-10%;width:400px;height:400px;background:rgba(255,255,255,.08);border-radius:50%}
  .hero-top{display:flex;align-items:center;gap:16px;position:relative;z-index:1}
  .hero-logo{width:48px;height:48px;border-radius:12px;background:#fff;padding:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);object-fit:contain}
  .hero-title{font-size:28px;font-weight:800;letter-spacing:-.5px}
  .hero-url{opacity:.85;font-size:13px;margin-top:2px}
  .hero-meta{display:flex;gap:20px;margin-top:16px;font-size:12px;opacity:.85;position:relative;z-index:1;flex-wrap:wrap}
  .grade-banner{display:flex;align-items:center;gap:20px;background:#fff;margin:-28px 32px 24px;padding:20px 28px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);position:relative;z-index:2}
  .grade-circle{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800;color:#fff;flex-shrink:0}
  .grade-info h3{font-size:16px;font-weight:700;color:#111827}
  .grade-info p{font-size:13px;color:#6b7280}
  .result-banner{display:flex;align-items:center;gap:16px;background:#fff;margin:-28px 32px 24px;padding:20px 28px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);position:relative;z-index:2}
  .result-icon{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff;flex-shrink:0}
  .scores-row{display:flex;gap:12px;padding:0 32px;margin-bottom:28px;flex-wrap:wrap;justify-content:center}
  .stats-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:0 32px;margin-bottom:32px}
  .stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;text-align:center}
  .stat-num{font-size:24px;font-weight:700;color:#111827}
  .stat-label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
  .content{padding:0 32px 32px}
  .section{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;margin-bottom:20px}
  .section-hd{font-size:16px;font-weight:700;color:#111827;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;background:#eef2ff;color:#6366f1}
  .badge-green{background:#dcfce7;color:#16a34a}.badge-red{background:#fef2f2;color:#dc2626}
  table{width:100%;border-collapse:separate;border-spacing:0;margin:8px 0;font-size:13px;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb}
  th{padding:10px 14px;background:#f9fafb;font-weight:600;color:#374151;text-align:left;border-bottom:1px solid #e5e7eb}
  td{padding:10px 14px;border-bottom:1px solid #f3f4f6}
  tr:last-child td{border-bottom:none}tr:hover td{background:#fafbfc}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#f3f4f6;color:#6b7280}
  .pg-audit{border:1px solid #f3f4f6;border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .pg-audit:hover{border-color:#e5e7eb;background:#fafbfc}
  .pg-hd{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .pg-score{font-size:18px;font-weight:800;min-width:32px}
  .pg-url{font-size:13px;color:#4b5563;word-break:break-all}
  .issues{list-style:none;padding:0;margin:4px 0 0 42px}
  .issues li{padding:3px 0;font-size:12px;color:#6b7280;position:relative;padding-left:18px}
  .issues li::before{position:absolute;left:0}
  .iss-err::before{content:'✕';color:#dc2626;font-weight:700}
  .iss-warn::before{content:'!';color:#d97706;font-weight:700}
  .iss-info::before{content:'●';color:#6b7280;font-size:8px;top:7px}
  .footer{text-align:center;padding:24px 32px 32px;color:#9ca3af;font-size:12px}
  img.hero-logo[src=""]{display:none} img.hero-logo:not([src]){display:none}
</style></head><body>
<div class="hero">
  <div class="hero-top">
    <img class="hero-logo" src="${escHtml(faviconSrc)}" alt=""/>
    <div><div class="hero-title">${escHtml(siteName)}</div><div class="hero-url">${escHtml(results.url)}</div></div>
  </div>
  <div class="hero-meta"><span>🚀 ${flowLabel} Flow</span><span>📅 ${now}</span><span>⏱ ${elapsed || '—'}</span><span>📄 ${pageAudits.length} pages</span><span>📋 ${steps.length} steps</span></div>
</div>
<div class="result-banner">
  <div class="result-icon" style="background:${failed === 0 ? '#16a34a' : '#dc2626'}">${failed === 0 ? '✓' : '!'}</div>
  <div>
    <h3 style="font-size:16px;font-weight:700;color:#111827">${failed === 0 ? 'All Tests Passed' : `${failed} Test${failed > 1 ? 's' : ''} Failed`}</h3>
    <p style="font-size:13px;color:#6b7280">${passed} passed · ${failed} failed · ${steps.length} total steps</p>
  </div>
</div>
${pageAudits.length ? `<div class="scores-row">${scoreRing(avgSeo, 'Avg SEO')}${scoreRing(avgA11y, 'Avg A11y')}${scoreRing(avgHtml, 'Avg HTML')}</div>` : ''}
<div class="stats-bar">
  <div class="stat-card"><div class="stat-num" style="color:#16a34a">${passed}</div><div class="stat-label">Passed</div></div>
  <div class="stat-card"><div class="stat-num" style="color:${failed > 0 ? '#dc2626' : '#16a34a'}">${failed}</div><div class="stat-label">Failed</div></div>
  <div class="stat-card"><div class="stat-num">${pageAudits.length}</div><div class="stat-label">Pages</div></div>
  <div class="stat-card"><div class="stat-num">${pageAudits.reduce((n, p) => n + (p.audit?.totalLinks || 0), 0)}</div><div class="stat-label">Links</div></div>
</div>
<div class="content">
  ${pagesHtml}
  ${seoSection}
  ${a11ySection}
  ${htmlSection}
  ${stepsHtml}
</div>
<div class="footer">
  <img src="${escHtml(faviconSrc)}" width="16" height="16" style="vertical-align:middle;margin-right:4px;border-radius:3px"/>
  ${escHtml(siteName)} — ${flowLabel} Flow Report &middot; Generated by <strong>AI Testing Tools</strong>
</div>
</body></html>`;
  }

  function wireHappyFlowCards() {
    $$('.hf-card').forEach((card) => {
      card.addEventListener('click', () => {
        runHappyFlow(card.dataset.flow);
      });
    });
  }

  /* ── Resume happy flow on popup reopen ── */
  async function resumeHappyFlowIfNeeded() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_HAPPY_FLOW_STATUS' });
      if (!status) return;

      const section = $('#happyFlowSection');
      if (!section) return;

      if (status.running) {
        // Flow is still running — show progress UI and resume polling
        section._originalHtml = section._originalHtml || section.innerHTML;
        const flowType = status.results?.flowType || 'full';
        section.innerHTML = `
          <div style="padding:12px 0">
            <div class="hf-header">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" style="color:var(--green)">
                <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z"/>
              </svg>
              <span class="hf-title">Running flow… (resumed)</span>
            </div>
            <div class="audit-progress" style="margin:8px 0"><div class="audit-progress-bar" style="width:50%"></div></div>
            <div id="hfLogArea" class="audit-log" style="max-height:200px;overflow-y:auto;font-size:11px;margin:8px 0"></div>
          </div>`;
        hfPolling = true;
        pollHappyFlow(section, flowType);
        return;
      }

      // Flow is done — check for pending result
      const pending = await chrome.runtime.sendMessage({ type: 'GET_PENDING_HF_RESULT' });
      if (pending?.results) {
        // Migrate video from chrome.storage.local to IndexedDB if needed
        await migrateHFVideo(pending.results);

        section._originalHtml = section._originalHtml || section.innerHTML;
        renderHappyFlowResults(section, pending.results, pending.flowType || pending.results.flowType || 'full', true);
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_HF_RESULT' });
      }
    } catch (e) {
      console.warn('[HF] Resume check failed:', e);
    }
  }

  /* ── Migrate video segments saved by background into IndexedDB ── */
  async function migrateHFVideo(results) {
    if (!results?._hasVideo) return;
    try {
      const store = await chrome.storage.local.get({ pw_reports: [] });
      const reports = store.pw_reports || [];
      const matchReport = reports.find((r) => r.type === 'happy-flow' && r.data?._hasVideo);
      if (!matchReport) return;

      const videoKey = `pw_hf_video_${matchReport.id}`;
      const videoStore = await chrome.storage.local.get(videoKey);
      const videoSegs = videoStore[videoKey];
      if (videoSegs?.length) {
        await saveVideoToDb(matchReport.id, { type: 'segments', segments: videoSegs });
        await chrome.storage.local.remove(videoKey);
      }
    } catch (e) {
      console.warn('[HF] Video migration failed:', e);
    }
  }

  async function migrateAuditVideo() {
    try {
      const store = await chrome.storage.local.get({ pw_reports: [] });
      const reports = store.pw_reports || [];
      const matchReport = reports.find((r) => r.type === 'audit' && r.data?._hasVideo);
      if (!matchReport) return;

      const videoKey = `pw_audit_video_${matchReport.id}`;
      const videoStore = await chrome.storage.local.get(videoKey);
      const videoSegs = videoStore[videoKey];
      if (videoSegs?.length) {
        await saveVideoToDb(matchReport.id, { type: 'segments', segments: videoSegs });
        await chrome.storage.local.remove(videoKey);
      }
    } catch (e) {
      console.warn('[Audit] Video migration failed:', e);
    }
  }

  /* ── Migrate any pending background-saved video data into IndexedDB ── */
  async function migrateBackgroundVideos() {
    try {
      const store = await chrome.storage.local.get({ pw_reports: [] });
      const reports = store.pw_reports || [];
      const keysToRemove = [];

      for (const report of reports) {
        if (!report.data?._hasVideo) continue;

        // Check if already migrated to IDB
        const existing = await getVideoFromDb(report.id).catch(() => null);
        if (existing) continue;

        // Check for background-stored video data
        const prefixes = ['pw_hf_video_', 'pw_audit_video_', 'pw_tr_video_'];
        for (const prefix of prefixes) {
          const key = `${prefix}${report.id}`;
          const vStore = await chrome.storage.local.get(key);
          const vData = vStore[key];
          if (vData) {
            if (typeof vData === 'string') {
              // Single video (test run)
              await saveVideoToDb(report.id, { type: 'single', dataUrl: vData });
            } else if (Array.isArray(vData)) {
              // Video segments (happy flow / audit)
              await saveVideoToDb(report.id, { type: 'segments', segments: vData });
            }
            keysToRemove.push(key);
            break;
          }
        }
      }

      if (keysToRemove.length) {
        await chrome.storage.local.remove(keysToRemove);
      }
    } catch (e) {
      console.warn('[Migration] Video migration failed:', e);
    }
  }

  /* ── Happy Flow via AI Generate tab ── */
  async function generateHappyFlowFromAITab() {
    let tabUrl = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabUrl = tab?.url || '';
    } catch { /* ignore */ }

    const url = $('#genUrl').value.trim() || tabUrl;
    if (!url || url.startsWith('chrome')) {
      toast('Enter a target URL first', 'error');
      return;
    }

    // Pre-fill description and trigger AI generation
    $('#genDescription').value = `Complete happy path test: Load the page, verify all key elements are visible, interact with primary actions (forms, buttons, links), validate success states, and verify the core user journey works end-to-end.`;
    generateWithAI();
  }

  /* ── Test Runner ── */
  let lastRunCode = '';

  function openRunModal() {
    $('#runModal').classList.remove('hidden');
    $('#runResultsList').innerHTML = '';
    $('#runSummary').textContent = '';
    $('#runProgressFill').style.width = '0%';
    $('#runProgressText').textContent = 'Preparing…';
    $('#runProgress').classList.remove('hidden');
    $('#btnRerun').disabled = true;
  }

  function closeRunModal() {
    $('#runModal').classList.add('hidden');
  }

  function updateRunProgress(pct, text) {
    $('#runProgressFill').style.width = `${pct}%`;
    $('#runProgressText').textContent = text;
  }

  async function runTest(code) {
    if (!code || !code.trim()) {
      toast('No test code to run', 'error');
      return;
    }

    lastRunCode = code;
    openRunModal();
    updateRunProgress(10, 'Parsing test steps…');

    try {
      updateRunProgress(30, 'Executing test in browser…');

      const res = await chrome.runtime.sendMessage({
        type: 'EXECUTE_TEST',
        payload: { code },
      });

      if (!res) throw new Error('Background service not responding. Try reloading the extension from chrome://extensions.');
      if (res.error) throw new Error(res.error);

      updateRunProgress(100, 'Complete');
      renderRunResults(res.results, res.summary, res.videoDataUrl);
      $('#btnRerun').disabled = false;
    } catch (err) {
      updateRunProgress(100, 'Failed');
      $('#runResultsList').innerHTML = `<div class="run-error"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" style="color:var(--red)"><path d="M2.343 13.657A8 8 0 1 1 13.658 2.343 8 8 0 0 1 2.343 13.657ZM6.03 4.97a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042L6.94 8 4.97 9.97a.749.749 0 0 0 .326 1.275.749.749 0 0 0 .734-.215L8 9.06l1.97 1.97a.749.749 0 0 0 1.275-.326.749.749 0 0 0-.215-.734L9.06 8l1.97-1.97a.749.749 0 0 0-.326-1.275.749.749 0 0 0-.734.215L8 6.94Z"/></svg> ${escHtml(err.message)}</div>`;
      $('#runSummary').textContent = 'Execution failed';
      toast(err.message, 'error');
    }
  }

  function renderRunResults(results, summary, videoDataUrl) {
    const container = $('#runResultsList');
    container.innerHTML = '';

    results.forEach((r) => {
      const el = document.createElement('div');
      el.className = `run-step-row ${r.status}`;

      const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '—';
      el.innerHTML = `
        <span class="run-step-icon ${r.status}">${icon}</span>
        <div class="run-step-info">
          <span class="run-step-name">${escHtml(r.name)}</span>
          ${r.error ? `<span class="run-step-error">${escHtml(r.error)}</span>` : ''}
        </div>
        <span class="run-step-duration">${r.duration || '—'}</span>`;
      container.appendChild(el);
    });

    // Video download button
    if (videoDataUrl) {
      const videoSection = document.createElement('div');
      videoSection.className = 'video-section';
      videoSection.style.margin = '8px 14px';
      videoSection.innerHTML = `
        <div class="video-section-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
          Testing Video
        </div>
        <div class="video-btn-grid">
          <button class="video-chip" id="btnDownloadRunVideo">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06z"/></svg>
            Download Video Recording
          </button>
        </div>`;
      container.appendChild(videoSection);
      document.getElementById('btnDownloadRunVideo')?.addEventListener('click', () => {
        downloadDataUrl(videoDataUrl, `test-run-${Date.now()}.webm`);
        toast('Video downloaded', 'success');
      });
    }

    // Summary
    const s = summary;
    const allPassed = s.failed === 0 && s.skipped === 0;
    $('#runSummary').innerHTML = `
      <span class="run-badge ${allPassed ? 'pass' : 'fail'}">${allPassed ? 'PASSED' : 'FAILED'}</span>
      <span class="run-counts">${s.passed} passed · ${s.failed} failed${s.skipped ? ` · ${s.skipped} skipped` : ''}</span>`;

    // Report is auto-saved by background, just reload reports
    loadReports();
  }

  async function generateAndRun() {
    const description = $('#genDescription').value.trim();
    if (!description) {
      toast('Please describe the test scenario', 'error');
      return;
    }

    // Generate — returns the code or null on failure
    const code = await generateWithAI();
    if (code) {
      await runTest(code);
    }
  }

  /* ── Init ── */
  document.addEventListener('DOMContentLoaded', async () => {
    initTabs();

    // Load token
    const data = await chrome.storage.sync.get(['githubToken']);
    ghToken = data.githubToken || '';

    if (!ghToken) {
      showState('NoToken');
    } else {
      showState('Main');
      loadSuites();
      loadReports();
      migrateBackgroundVideos();
    }

    // Settings button
    $('#btnGoSettings')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
    $('#btnSettings')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    // Recorder buttons
    $('#btnStartRecord').addEventListener('click', startRecording);
    $('#btnStopRecord').addEventListener('click', stopRecording);
    $('#btnClearRecord').addEventListener('click', clearRecording);

    // Restore recording state if recording was started before popup opened
    chrome.runtime.sendMessage({ type: 'GET_RECORDER_STATE' }, (state) => {
      if (chrome.runtime.lastError || !state?.active) return;
      // Recording is in progress — restore UI
      recording = true;
      recordedSteps = state.steps || [];
      $('#recorderIndicator').classList.add('active');
      $('#recorderStatusText').textContent = 'Recording…';
      $('#btnStartRecord').disabled = true;
      $('#btnStartRecord').classList.add('recording');
      $('#btnStopRecord').disabled = false;
      $('#btnClearRecord').disabled = true;

      // Restore timer from elapsed time
      if (state.startedAt) {
        timerSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
      }
      startTimer();

      // Render steps collected so far
      if (recordedSteps.length > 0) {
        renderSteps();
        updateStepCount();
      } else {
        $('#recordedSteps').innerHTML = '<p class="task-empty">Listening for interactions…</p>';
      }
    });

    // Preview & export for recorder
    $('#btnPreview').addEventListener('click', showPreview);
    $('#btnRunRecording')?.addEventListener('click', () => {
      const code = generatePlaywrightCode(recordedSteps, getRecordOptions());
      runTest(code);
    });
    $('#btnExportRecording').addEventListener('click', () => {
      const code = generatePlaywrightCode(recordedSteps, getRecordOptions());
      const ext = isPlaywrightFw(getSelectedFramework()) ? '.spec.js' : '.test.js';
      const filename = `recorded-test-${Date.now()}${ext}`;
      downloadText(code, filename);

      // Also save to suites
      saveSuite(`Recorded ${new Date().toLocaleString()}`, code, 'recorder');
    });
    $('#btnExportRecordingPW')?.addEventListener('click', () => {
      const code = generatePlaywrightNativeCode(recordedSteps, getRecordOptions(), 'playwright-test');
      downloadText(code, `recorded-test-${Date.now()}.spec.js`);
      saveSuite(`Recorded (Playwright) ${new Date().toLocaleString()}`, code, 'recorder');
    });

    // Video recording download
    $('#btnDownloadRecordingVideo')?.addEventListener('click', async () => {
      if (recorderVideoDataUrl) {
        downloadDataUrl(recorderVideoDataUrl, `recording-${Date.now()}.webm`);
        toast('Video downloaded', 'success');
        return;
      }
      // Fallback: try loading from IndexedDB
      try {
        const videoData = await getVideoFromDb('__latest_recording');
        if (videoData?.blob) {
          const url = URL.createObjectURL(videoData.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `recording-${Date.now()}.webm`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
          toast('Video downloaded', 'success');
        } else {
          toast('No video recording found', 'error');
        }
      } catch (e) {
        toast('Failed to load video recording', 'error');
      }
    });

    // Preview modal
    $('#btnClosePreview').addEventListener('click', closePreview);
    $('.modal-overlay')?.addEventListener('click', closePreview);
    $('#btnCopyPreview').addEventListener('click', () => {
      copyToClipboard($('#previewCode code').textContent);
    });
    $('#btnRunPreview')?.addEventListener('click', () => {
      const code = $('#previewCode code').textContent;
      closePreview();
      runTest(code);
    });
    $('#btnExportPreview').addEventListener('click', () => {
      const code = $('#previewCode code').textContent;
      const ext = isPlaywrightFw(getSelectedFramework()) ? '.spec.js' : '.test.js';
      downloadText(code, `preview-test-${Date.now()}${ext}`);
      saveSuite(`Recorded ${new Date().toLocaleString()}`, code, 'recorder');
      closePreview();
    });
    $('#btnExportPreviewPW')?.addEventListener('click', () => {
      const code = generatePlaywrightNativeCode(recordedSteps, getRecordOptions(), 'playwright-test');
      downloadText(code, `preview-test-${Date.now()}.spec.js`);
      saveSuite(`Recorded (Playwright) ${new Date().toLocaleString()}`, code, 'recorder');
      closePreview();
    });

    // AI Generate
    $('#btnGenerate').addEventListener('click', generateWithAI);
    $('#btnGenerateAndRun')?.addEventListener('click', generateAndRun);
    $('#btnCopyGen')?.addEventListener('click', () => {
      copyToClipboard($('#genCode code').textContent);
    });
    $('#btnRunGen')?.addEventListener('click', () => {
      const code = $('#genCode code').textContent;
      if (code) runTest(code);
    });
    $('#btnExportGen')?.addEventListener('click', () => {
      const code = $('#genCode code').textContent;
      const desc = $('#genDescription').value.trim().slice(0, 30).replace(/[^a-zA-Z0-9_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
      const ext = isPlaywrightFw(getSelectedFramework()) ? '.spec.js' : '.test.js';
      downloadText(code, `${desc || 'ai-test'}-${Date.now()}${ext}`);
      saveSuite(`AI: ${$('#genDescription').value.trim().slice(0, 50)}`, code, 'ai-generated');
    });
    $('#btnExportGenPW')?.addEventListener('click', () => {
      const code = $('#genCode code').textContent;
      const desc = $('#genDescription').value.trim().slice(0, 30).replace(/[^a-zA-Z0-9_ ]/g, '').replace(/\s+/g, '-').toLowerCase();
      downloadText(code, `${desc || 'ai-test'}-${Date.now()}.spec.js`);
      saveSuite(`AI (Playwright): ${$('#genDescription').value.trim().slice(0, 50)}`, code, 'ai-generated');
    });

    // Auto-fill URL from active tab
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && !tab.url.startsWith('chrome')) {
        $('#genUrl').value = tab.url;
      }
    } catch { /* ignore */ }

    // Suites
    $('#btnRefreshSuites')?.addEventListener('click', loadSuites);
    $('#btnExportAll')?.addEventListener('click', exportAllSuites);
    $('#suiteSearch')?.addEventListener('input', (e) => filterSuites(e.target.value));

    // Happy Flow cards in Record tab
    wireHappyFlowCards();

    // Check if a happy flow is running or just finished (popup may have closed mid-flow)
    resumeHappyFlowIfNeeded();

    // Happy Flow button in AI Generate tab
    $('#btnHappyFlow')?.addEventListener('click', generateHappyFlowFromAITab);

    // Run modal controls
    $('#btnCloseRun')?.addEventListener('click', closeRunModal);
    $('#btnCloseRunFooter')?.addEventListener('click', closeRunModal);
    $('#btnRerun')?.addEventListener('click', () => {
      if (lastRunCode) runTest(lastRunCode);
    });
    // Close run modal on overlay click
    $$('#runModal .modal-overlay').forEach((el) => el.addEventListener('click', closeRunModal));

    // Saved Reports (Tests tab)
    $('#reportSearch')?.addEventListener('input', (e) => filterReports(e.target.value));
    $('#btnClearAllReports')?.addEventListener('click', clearAllReports);
    $('#btnBackToReports')?.addEventListener('click', hideReportDetail);

    // Audit tab — auto-fill URL
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && !tab.url.startsWith('chrome')) {
        const u = new URL(tab.url);
        $('#auditUrl').value = u.origin;
      }
    } catch { /* ignore */ }

    // Audit controls
    $('#btnStartAudit')?.addEventListener('click', startSiteAudit);
    $('#btnStopAudit')?.addEventListener('click', stopSiteAudit);
    $('#btnDownloadReport')?.addEventListener('click', downloadPdfReport);
    $('#btnClearLog')?.addEventListener('click', () => {
      $('#auditLog').innerHTML = '';
    });

    // Check if an audit was running or completed while popup was closed
    checkAuditOnLoad();
  });

  /* ═══════════ SITE AUDIT ═══════════ */
  let auditPollTimer = null;
  let auditReport = null;
  let lastLogCount = 0;
  let auditPort = null;

  function updateAuditProgress(pct, text) {
    $('#auditProgressFill').style.width = `${pct}%`;
    $('#auditProgressText').textContent = text;
  }

  function appendLogEntry(entry) {
    const container = $('#auditLog');
    const wrap = $('#auditLogWrap');
    wrap.classList.remove('hidden');
    const row = document.createElement('div');
    row.className = `audit-log-entry audit-log-${entry.level}`;
    row.innerHTML = `<span class="audit-log-time">${escHtml(entry.time)}</span><span class="audit-log-lvl">${entry.level.toUpperCase()}</span><span class="audit-log-msg">${escHtml(entry.message)}</span>`;
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function renderAuditLogs(logs) {
    if (!logs || logs.length <= lastLogCount) return;
    const wrap = $('#auditLogWrap');
    wrap.classList.remove('hidden');
    const newEntries = logs.slice(lastLogCount);
    for (const entry of newEntries) {
      appendLogEntry(entry);
    }
    lastLogCount = logs.length;
  }

  function connectAuditPort() {
    if (auditPort) return;
    try {
      auditPort = chrome.runtime.connect({ name: 'audit-status' });
      auditPort.onMessage.addListener((msg) => {
        if (msg.type === 'AUDIT_LOG') {
          appendLogEntry(msg.entry);
          lastLogCount++;
        } else if (msg.type === 'AUDIT_DONE') {
          // Final poll to get the report
          pollAuditOnce();
        }
      });
      auditPort.onDisconnect.addListener(() => { auditPort = null; });
    } catch { auditPort = null; }
  }

  function disconnectAuditPort() {
    if (auditPort) {
      try { auditPort.disconnect(); } catch { /* already disconnected */ }
      auditPort = null;
    }
  }

  function stopSiteAudit() {
    chrome.runtime.sendMessage({ type: 'STOP_AUDIT' }, () => void chrome.runtime.lastError);
    $('#btnStopAudit').disabled = true;
    updateAuditProgress(100, 'Stopping…');
  }

  async function startSiteAudit() {
    const baseUrl = $('#auditUrl').value.trim();
    if (!baseUrl) { toast('Enter a site URL', 'error'); return; }

    const payload = {
      baseUrl,
      checkSitemap: $('#chkSitemap')?.checked ?? true,
      checkLinks: $('#chkAuditLinks')?.checked ?? true,
      checkFreeJobs: $('#chkFreeJobs')?.checked ?? true,
      freeJobLimit: parseInt($('#freeJobLimit')?.value, 10) || 2,
      maxPages: parseInt($('#maxPages')?.value, 10) || 5,
    };

    $('#btnStartAudit').disabled = true;
    $('#btnStopAudit').disabled = false;
    $('#auditProgress').classList.remove('hidden');
    $('#auditResults').classList.add('hidden');
    $('#auditLog').innerHTML = '';
    $('#auditLogWrap').classList.remove('hidden');
    lastLogCount = 0;
    updateAuditProgress(5, 'Starting audit…');

    // Connect port for real-time log streaming (also keeps SW alive)
    connectAuditPort();

    // Send to background — audit runs in service worker (survives popup close)
    try {
      const res = await chrome.runtime.sendMessage({ type: 'START_AUDIT', payload });
      if (res?.error) {
        toast(res.error, 'error');
        $('#btnStartAudit').disabled = false;
        $('#btnStopAudit').disabled = true;
        disconnectAuditPort();
        return;
      }
    } catch (err) {
      toast(`Failed to start audit: ${err.message}`, 'error');
      $('#btnStartAudit').disabled = false;
      disconnectAuditPort();
      return;
    }

    // Poll the background for status updates (sequential — wait for each to finish)
    startAuditPolling();
  }

  function startAuditPolling() {
    stopAuditPolling();
    schedulePoll();
  }

  function schedulePoll() {
    auditPollTimer = setTimeout(() => pollAuditOnce(), 1000);
  }

  async function pollAuditOnce() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_AUDIT_STATUS' });
      if (!status) { schedulePoll(); return; }

      updateAuditProgress(status.progress, status.progressText);
      renderAuditLogs(status.logs);

      if (!status.running) {
        stopAuditPolling();
        disconnectAuditPort();
        $('#btnStartAudit').disabled = false;
        $('#btnStopAudit').disabled = true;

        if (status.report) {
          auditReport = status.report;
          renderAuditResults();
          // Report is auto-saved by background, just reload
          loadReports();
          toast('Site audit complete! Downloading PDF…', 'success');
          // Auto-download PDF report
          setTimeout(() => downloadPdfReport(), 500);
        } else {
          toast('Audit ended without results', 'error');
        }
        return;
      }
      // Still running — schedule next poll
      schedulePoll();
    } catch (err) {
      // SW may have restarted, retry a few times
      console.warn('Audit poll error:', err.message);
      schedulePoll();
    }
  }

  function stopAuditPolling() {
    if (auditPollTimer) {
      clearTimeout(auditPollTimer);
      auditPollTimer = null;
    }
  }

  // When popup opens, check if audit is already running
  async function checkAuditOnLoad() {
    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_AUDIT_STATUS' });
      if (!status) return;

      if (status.running) {
        // Audit is still running — show progress and resume polling
        $('#btnStartAudit').disabled = true;
        $('#btnStopAudit').disabled = false;
        $('#auditProgress').classList.remove('hidden');
        $('#auditLogWrap').classList.remove('hidden');
        updateAuditProgress(status.progress, status.progressText);
        renderAuditLogs(status.logs);
        connectAuditPort();
        startAuditPolling();
      } else if (status.report) {
        // Audit finished while popup was closed — show results
        auditReport = status.report;
        $('#auditProgress').classList.remove('hidden');
        $('#auditLogWrap').classList.remove('hidden');
        updateAuditProgress(100, 'Audit complete');
        renderAuditLogs(status.logs);
        renderAuditResults();
        loadReports();
        // Migrate video from background storage to IDB
        migrateAuditVideo();
      }
    } catch { /* ignore */ }
  }

  function renderAuditResults() {
    if (!auditReport) return;
    const r = auditReport;

    $('#auditResults').classList.remove('hidden');
    $('#auditPagesCount').textContent = r.summary.totalPages;
    $('#auditLinksCount').textContent = r.summary.totalLinks;
    $('#auditBrokenCount').textContent = r.summary.brokenLinks;
    $('#auditPaywallStatus').textContent = r.paywallResults ? (r.summary.paywallDetected ? 'Yes' : 'No') : '—';

    // Score cards
    const scoreColor = (s) => s >= 80 ? 'var(--green)' : s >= 50 ? 'var(--yellow)' : 'var(--red)';
    const seo = r.summary.seoScore || 0;
    const a11y = r.summary.a11yScore || 0;
    const html = r.summary.htmlScore || 0;
    const mob = r.summary.mobileScore || 0;
    const seoEl = $('#auditSeoScore'); seoEl.textContent = seo; seoEl.style.color = scoreColor(seo);
    const a11yEl = $('#auditA11yScore'); a11yEl.textContent = a11y; a11yEl.style.color = scoreColor(a11y);
    const htmlEl = $('#auditHtmlScore'); htmlEl.textContent = html; htmlEl.style.color = scoreColor(html);
    const mobEl = $('#auditMobileScore'); mobEl.textContent = mob; mobEl.style.color = scoreColor(mob);

    // Color the broken count
    if (r.summary.brokenLinks > 0) {
      $('#auditBrokenCount').style.color = 'var(--red)';
    }

    const container = $('#auditDetailsList');
    container.innerHTML = '';

    // Sitemap section
    if (r.sitemap) {
      container.innerHTML += `
        <div class="audit-detail-section">
          <div class="audit-section-title">Sitemap</div>
          <div class="audit-row ok">
            <span class="audit-row-icon">✓</span>
            <span class="audit-row-text">${escHtml(r.sitemap.url)}</span>
            <span class="audit-row-status">${r.sitemap.totalUrls} URLs</span>
          </div>
        </div>`;
    }

    // Pages section
    if (r.pages.length) {
      let pagesHtml = '<div class="audit-detail-section"><div class="audit-section-title">Pages Audited</div>';
      for (const p of r.pages) {
        const cls = p.error ? 'broken' : 'ok';
        const icon = p.error ? '✗' : '✓';
        const status = p.error ? escHtml(p.error) : `${p.totalLinks} links`;
        pagesHtml += `<div class="audit-row ${cls}"><span class="audit-row-icon">${icon}</span><span class="audit-row-text" title="${escHtml(p.url)}">${escHtml(p.title || p.url)}</span><span class="audit-row-status">${status}</span></div>`;
      }
      pagesHtml += '</div>';
      container.innerHTML += pagesHtml;
    }

    // SEO section
    if (r.seoResults?.length) {
      let seoHtml = '<div class="audit-detail-section"><div class="audit-section-title">SEO Analysis</div>';
      for (const pg of r.seoResults) {
        const cls = pg.score >= 80 ? 'ok' : pg.score >= 50 ? 'warn' : 'broken';
        seoHtml += `<div class="audit-row ${cls}"><span class="audit-row-icon">${pg.score >= 80 ? '✓' : pg.score >= 50 ? '!' : '✗'}</span><span class="audit-row-text" title="${escHtml(pg.url)}">${escHtml(pg.title || pg.url)}</span><span class="audit-row-status">${pg.score}/100</span></div>`;
        if (pg.issues?.length) {
          for (const iss of pg.issues) {
            const iCls = iss.severity === 'error' ? 'broken' : 'warn';
            seoHtml += `<div class="audit-row ${iCls}" style="padding-left:28px;font-size:11px"><span class="audit-row-icon">${iss.severity === 'error' ? '✗' : '!'}</span><span class="audit-row-text">${escHtml(iss.message)}</span></div>`;
          }
        }
      }
      seoHtml += '</div>';
      container.innerHTML += seoHtml;
    }

    // Accessibility section
    if (r.accessibilityResults?.length) {
      let a11yHtml = '<div class="audit-detail-section"><div class="audit-section-title">Accessibility (ADA)</div>';
      for (const pg of r.accessibilityResults) {
        const cls = pg.score >= 80 ? 'ok' : pg.score >= 50 ? 'warn' : 'broken';
        a11yHtml += `<div class="audit-row ${cls}"><span class="audit-row-icon">${pg.score >= 80 ? '✓' : pg.score >= 50 ? '!' : '✗'}</span><span class="audit-row-text" title="${escHtml(pg.url)}">${escHtml(pg.title || pg.url)}</span><span class="audit-row-status">${pg.score}/100</span></div>`;
        if (pg.issues?.length) {
          for (const iss of pg.issues) {
            const iCls = iss.severity === 'error' ? 'broken' : 'warn';
            a11yHtml += `<div class="audit-row ${iCls}" style="padding-left:28px;font-size:11px"><span class="audit-row-icon">${iss.severity === 'error' ? '✗' : '!'}</span><span class="audit-row-text">${escHtml(iss.message)}</span></div>`;
          }
        }
      }
      a11yHtml += '</div>';
      container.innerHTML += a11yHtml;
    }

    // HTML Validation section
    if (r.htmlResults?.length) {
      let htmlResHtml = '<div class="audit-detail-section"><div class="audit-section-title">HTML Validation</div>';
      for (const pg of r.htmlResults) {
        const cls = pg.score >= 80 ? 'ok' : pg.score >= 50 ? 'warn' : 'broken';
        htmlResHtml += `<div class="audit-row ${cls}"><span class="audit-row-icon">${pg.score >= 80 ? '✓' : pg.score >= 50 ? '!' : '✗'}</span><span class="audit-row-text" title="${escHtml(pg.url)}">${escHtml(pg.title || pg.url)}</span><span class="audit-row-status">${pg.score}/100</span></div>`;
        if (pg.issues?.length) {
          for (const iss of pg.issues) {
            const iCls = iss.severity === 'error' ? 'broken' : 'warn';
            htmlResHtml += `<div class="audit-row ${iCls}" style="padding-left:28px;font-size:11px"><span class="audit-row-icon">${iss.severity === 'error' ? '✗' : '!'}</span><span class="audit-row-text">${escHtml(iss.message)}</span></div>`;
          }
        }
      }
      htmlResHtml += '</div>';
      container.innerHTML += htmlResHtml;
    }

    // Mobile Responsiveness section
    if (r.mobileResults?.length) {
      let mobHtml = '<div class="audit-detail-section"><div class="audit-section-title">Mobile Responsiveness</div>';
      for (const pg of r.mobileResults) {
        const cls = pg.score >= 80 ? 'ok' : pg.score >= 50 ? 'warn' : 'broken';
        mobHtml += `<div class="audit-row ${cls}"><span class="audit-row-icon">${pg.score >= 80 ? '✓' : pg.score >= 50 ? '!' : '✗'}</span><span class="audit-row-text" title="${escHtml(pg.url)}">${escHtml(pg.title || pg.url)}</span><span class="audit-row-status">${pg.score}/100</span></div>`;
        if (pg.issues?.length) {
          for (const iss of pg.issues) {
            const iCls = iss.severity === 'error' ? 'broken' : 'warn';
            mobHtml += `<div class="audit-row ${iCls}" style="padding-left:28px;font-size:11px"><span class="audit-row-icon">${iss.severity === 'error' ? '✗' : '!'}</span><span class="audit-row-text">${escHtml(iss.message)}</span></div>`;
          }
        }
      }
      mobHtml += '</div>';
      container.innerHTML += mobHtml;
    }

    // Broken links section
    if (r.brokenLinks.length) {
      let linksHtml = '<div class="audit-detail-section"><div class="audit-section-title">Broken Links</div>';
      for (const lnk of r.brokenLinks) {
        linksHtml += `<div class="audit-row broken"><span class="audit-row-icon">✗</span><span class="audit-row-text" title="${escHtml(lnk.url)}">${escHtml(lnk.text || lnk.url)}</span><span class="audit-row-status">${lnk.status || 'ERR'}</span></div>`;
      }
      linksHtml += '</div>';
      container.innerHTML += linksHtml;
    }

    // Paywall section
    if (r.paywallResults) {
      const pw = r.paywallResults;
      let pwHtml = `<div class="audit-detail-section"><div class="audit-section-title">Free Jobs Paywall Test (limit: ${pw.freeLimit})</div>`;
      pwHtml += `<div class="audit-row ${pw.paywallDetected ? 'ok' : 'warn'}"><span class="audit-row-icon">${pw.paywallDetected ? '✓' : '!'}</span><span class="audit-row-text">${pw.jobsFound} jobs found, paywall ${pw.paywallDetected ? 'detected' : 'NOT detected'} after ${pw.freeLimit} views</span></div>`;
      if (pw.results) {
        for (const jr of pw.results) {
          const cls = jr.blocked ? 'warn' : 'ok';
          const icon = jr.blocked ? '🔒' : '✓';
          pwHtml += `<div class="audit-row ${cls}"><span class="audit-row-icon">${icon}</span><span class="audit-row-text">Job ${jr.index}: ${escHtml(jr.title)}</span><span class="audit-row-status">${jr.blocked ? 'blocked' : 'free'}</span></div>`;
        }
      }
      pwHtml += '</div>';
      container.innerHTML += pwHtml;
    }

    // Video recordings section
    const hasAuditVideos = r.videoSegments?.length > 0;
    const hasAuditVideoFlag = r._hasVideo;
    if (hasAuditVideos || hasAuditVideoFlag) {
      let vidHtml = `<div class="video-section" id="auditVideoSection">
        <div class="video-section-header">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM6 10.559V5.442a.25.25 0 0 1 .379-.215l4.264 2.559a.25.25 0 0 1 0 .428L6.379 10.773A.25.25 0 0 1 6 10.559Z"/></svg>
          Testing Video${hasAuditVideos && r.videoSegments.length > 1 ? 's' : ''}
        </div>
        <div class="video-btn-grid" id="auditVideoBtnGrid">`;

      if (hasAuditVideos) {
        for (let i = 0; i < r.videoSegments.length; i++) {
          const seg = r.videoSegments[i];
          const segLabel = seg.label || `Segment ${i + 1}`;
          vidHtml += `<button class="video-chip audit-video-btn" data-seg-idx="${i}" title="${escHtml(segLabel)}">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg>
            ${escHtml(segLabel.length > 25 ? segLabel.slice(0, 25) + '…' : segLabel)}
          </button>`;
        }
      } else {
        vidHtml += '<span style="font-size:11px;color:var(--text3)">Video saved — open report in Tests tab to download</span>';
      }

      vidHtml += `</div></div>`;
      container.innerHTML += vidHtml;

      // Wire audit video download buttons
      if (hasAuditVideos) {
        container.querySelectorAll('.audit-video-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.segIdx, 10);
            const seg = r.videoSegments[idx];
            if (seg?.dataUrl) {
              downloadDataUrl(seg.dataUrl, `audit-recording-${idx + 1}.webm`);
              toast('Video downloaded', 'success');
            }
          });
        });
      }

      // If _hasVideo but no inline segments, try loading from IDB
      if (hasAuditVideoFlag && !hasAuditVideos) {
        loadAuditVideoFromIDB();
      }
    }
  }

  async function loadAuditVideoFromIDB() {
    try {
      const store = await chrome.storage.local.get({ pw_reports: [] });
      const reports = store.pw_reports || [];
      const matchReport = reports.find((r) => r.type === 'audit' && r.data?._hasVideo);
      if (!matchReport) return;
      const videoPayload = await getVideoFromDb(matchReport.id);
      if (!videoPayload?.segments?.length) return;
      const grid = document.getElementById('auditVideoBtnGrid');
      if (!grid) return;
      grid.innerHTML = videoPayload.segments.map((seg, i) => {
        const segLabel = seg.label || `Segment ${i + 1}`;
        return `<button class="video-chip audit-video-btn" data-seg-idx="${i}" title="${escHtml(segLabel)}">
          <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0M1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0m4.879-2.773 4.264 2.559a.25.25 0 0 1 0 .428l-4.264 2.559A.25.25 0 0 1 6 10.559V5.442a.25.25 0 0 1 .379-.215"/></svg>
          ${escHtml(segLabel.length > 25 ? segLabel.slice(0, 25) + '…' : segLabel)}
        </button>`;
      }).join('');
      grid.querySelectorAll('.audit-video-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.segIdx, 10);
          const seg = videoPayload.segments[idx];
          if (seg?.dataUrl) {
            downloadDataUrl(seg.dataUrl, `audit-recording-${idx + 1}.webm`);
            toast('Video downloaded', 'success');
          }
        });
      });
    } catch (e) {
      console.warn('[Audit] Failed to load video from IDB:', e);
    }
  }

  /* ── PDF Report Generation ── */
  function downloadPdfReport() {
    if (!auditReport) {
      toast('No audit results to export', 'error');
      return;
    }

    const r = auditReport;
    const html = buildReportHtml(r);
    chrome.runtime.sendMessage({ type: 'OPEN_REPORT_TAB', payload: { html } }, () => void chrome.runtime.lastError);
    toast('Report opened — use Print dialog to save as PDF', 'success');
  }

  function buildReportHtml(r) {
    const now = new Date().toLocaleString();
    const siteName = (() => { try { return new URL(r.baseUrl).hostname.replace(/^www\./, ''); } catch { return r.baseUrl; } })();
    const faviconSrc = (() => { try { return new URL(r.baseUrl).origin + '/favicon.ico'; } catch { return ''; } })();
    const avgScore = Math.round(((r.summary.seoScore || 0) + (r.summary.a11yScore || 0) + (r.summary.htmlScore || 0) + (r.summary.mobileScore || 0)) / 4);
    const overallGrade = avgScore >= 90 ? 'A' : avgScore >= 80 ? 'B' : avgScore >= 70 ? 'C' : avgScore >= 50 ? 'D' : 'F';
    const gradeColor = avgScore >= 80 ? '#16a34a' : avgScore >= 50 ? '#ca8a04' : '#dc2626';

    const scoreRing = (score, label) => {
      const color = score >= 80 ? '#16a34a' : score >= 50 ? '#ca8a04' : '#dc2626';
      const dash = (Math.min(100, Math.max(0, score)) / 100) * 251.2;
      return `<div style="text-align:center;flex:1;min-width:110px">
        <svg width="80" height="80" viewBox="0 0 90 90"><circle cx="45" cy="45" r="40" fill="none" stroke="#e5e7eb" stroke-width="6"/><circle cx="45" cy="45" r="40" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${dash} 251.2" transform="rotate(-90 45 45)"/><text x="45" y="50" text-anchor="middle" font-size="20" font-weight="700" fill="${color}">${score}</text></svg>
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-top:4px">${label}</div></div>`;
    };

    const issueBlock = (title, icon, results, scoreKey) => {
      if (!results?.length) return '';
      let html = `<div class="section"><div class="section-hd"><span>${icon}</span>${escHtml(title)} <span class="badge">${r.summary[scoreKey]}/100</span></div>`;
      for (const pg of results) {
        const color = pg.score >= 80 ? '#16a34a' : pg.score >= 50 ? '#ca8a04' : '#dc2626';
        html += `<div class="pg-audit"><div class="pg-hd"><span class="pg-score" style="color:${color}">${pg.score}</span><span class="pg-url">${escHtml(pg.title || pg.url)}</span></div>`;
        if (pg.issues?.length) {
          html += '<ul class="issues">';
          for (const iss of pg.issues) {
            const cls = iss.severity === 'error' ? 'iss-err' : iss.severity === 'warn' ? 'iss-warn' : 'iss-info';
            html += `<li class="${cls}">${escHtml(iss.message || iss.msg)}</li>`;
          }
          html += '</ul>';
        }
        html += '</div>';
      }
      return html + '</div>';
    };

    let brokenLinksHtml = '';
    if (r.brokenLinks.length) {
      brokenLinksHtml = `<div class="section"><div class="section-hd"><span>🔗</span>Broken Links <span class="badge badge-red">${r.brokenLinks.length}</span></div><table><thead><tr><th>URL</th><th>Link Text</th><th>Status</th></tr></thead><tbody>`;
      for (const lnk of r.brokenLinks) brokenLinksHtml += `<tr><td style="word-break:break-all">${escHtml(lnk.url)}</td><td>${escHtml(lnk.text)}</td><td style="font-weight:600;color:#dc2626">${lnk.status || 'ERR'}</td></tr>`;
      brokenLinksHtml += '</tbody></table></div>';
    }

    let pagesHtml = '';
    if (r.pages.length) {
      pagesHtml = `<div class="section"><div class="section-hd"><span>📄</span>Pages Audited <span class="badge">${r.pages.length}</span></div><table><thead><tr><th>URL</th><th>Title</th><th>Links</th><th>Type</th></tr></thead><tbody>`;
      for (const p of r.pages) pagesHtml += `<tr><td style="word-break:break-all">${escHtml(p.url)}</td><td>${escHtml(p.title || '—')}</td><td>${p.totalLinks || '—'}</td><td><span class="pill">${escHtml(p.pageType || '—')}</span></td></tr>`;
      pagesHtml += '</tbody></table></div>';
    }

    let paywallHtml = '';
    if (r.paywallResults) {
      const pw = r.paywallResults;
      paywallHtml = `<div class="section"><div class="section-hd"><span>🔒</span>Paywall Test <span class="badge ${pw.paywallDetected ? 'badge-green' : 'badge-red'}">${pw.paywallDetected ? 'Detected' : 'Not Found'}</span></div><p style="margin:8px 0;color:#4b5563"><strong>Jobs:</strong> ${pw.jobsFound} | <strong>Limit:</strong> ${pw.freeLimit}</p>`;
      if (pw.results?.length) {
        paywallHtml += '<table><thead><tr><th>#</th><th>Job Title</th><th>Status</th></tr></thead><tbody>';
        for (const jr of pw.results) paywallHtml += `<tr><td>${jr.index}</td><td>${escHtml(jr.title)}</td><td><span class="badge ${jr.blocked ? 'badge-orange' : 'badge-green'}">${jr.blocked ? 'Blocked' : 'Free'}</span></td></tr>`;
        paywallHtml += '</tbody></table>';
      }
      paywallHtml += '</div>';
    }

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Site Audit — ${escHtml(siteName)}</title>
<style>
  @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.no-print{display:none}@page{margin:1cm}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;max-width:960px;margin:0 auto;color:#1f2937;line-height:1.6;font-size:14px;background:#f8fafc}
  .hero{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:40px 48px 32px;border-radius:0 0 24px 24px;position:relative;overflow:hidden}
  .hero::before{content:'';position:absolute;top:-40%;right:-10%;width:400px;height:400px;background:rgba(255,255,255,.08);border-radius:50%}
  .hero-top{display:flex;align-items:center;gap:16px;position:relative;z-index:1}
  .hero-logo{width:48px;height:48px;border-radius:12px;background:#fff;padding:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);object-fit:contain}
  .hero-title{font-size:28px;font-weight:800;letter-spacing:-.5px}
  .hero-url{opacity:.85;font-size:13px;margin-top:2px}
  .hero-meta{display:flex;gap:24px;margin-top:16px;font-size:12px;opacity:.8;position:relative;z-index:1}
  .grade-banner{display:flex;align-items:center;gap:20px;background:#fff;margin:-28px 32px 24px;padding:20px 28px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);position:relative;z-index:2}
  .grade-circle{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:800;color:#fff;flex-shrink:0}
  .grade-info h3{font-size:16px;font-weight:700;color:#111827}
  .grade-info p{font-size:13px;color:#6b7280}
  .scores-row{display:flex;gap:12px;padding:0 32px;margin-bottom:28px;flex-wrap:wrap;justify-content:center}
  .stats-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:0 32px;margin-bottom:32px}
  .stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;text-align:center}
  .stat-num{font-size:24px;font-weight:700;color:#111827}
  .stat-label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
  .content{padding:0 32px 32px}
  .section{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:24px;margin-bottom:20px}
  .section-hd{font-size:16px;font-weight:700;color:#111827;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;background:#eef2ff;color:#6366f1}
  .badge-green{background:#dcfce7;color:#16a34a}.badge-red{background:#fef2f2;color:#dc2626}.badge-orange{background:#fef3c7;color:#d97706}
  table{width:100%;border-collapse:separate;border-spacing:0;margin:8px 0;font-size:13px;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb}
  th{padding:10px 14px;background:#f9fafb;font-weight:600;color:#374151;text-align:left;border-bottom:1px solid #e5e7eb}
  td{padding:10px 14px;border-bottom:1px solid #f3f4f6}
  tr:last-child td{border-bottom:none}tr:hover td{background:#fafbfc}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;background:#f3f4f6;color:#6b7280}
  .pg-audit{border:1px solid #f3f4f6;border-radius:10px;padding:12px 16px;margin-bottom:10px}
  .pg-audit:hover{border-color:#e5e7eb;background:#fafbfc}
  .pg-hd{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .pg-score{font-size:18px;font-weight:800;min-width:32px}
  .pg-url{font-size:13px;color:#4b5563;word-break:break-all}
  .issues{list-style:none;padding:0;margin:4px 0 0 42px}
  .issues li{padding:3px 0;font-size:12px;color:#6b7280;position:relative;padding-left:18px}
  .issues li::before{position:absolute;left:0}
  .iss-err::before{content:'✕';color:#dc2626;font-weight:700}
  .iss-warn::before{content:'!';color:#d97706;font-weight:700}
  .iss-info::before{content:'●';color:#6b7280;font-size:8px;top:7px}
  .sitemap-ok{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;font-size:13px;background:#f0fdf4;color:#16a34a}
  .sitemap-err{display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:8px;font-size:13px;background:#fef2f2;color:#dc2626}
  .footer{text-align:center;padding:24px 32px 32px;color:#9ca3af;font-size:12px}
  img.hero-logo[src=""]{display:none} img.hero-logo:not([src]){display:none}
</style></head><body>
<div class="hero">
  <div class="hero-top">
    <img class="hero-logo" src="${escHtml(faviconSrc)}" alt=""/>
    <div><div class="hero-title">${escHtml(siteName)}</div><div class="hero-url">${escHtml(r.baseUrl)}</div></div>
  </div>
  <div class="hero-meta"><span>📅 ${now}</span><span>📄 ${r.summary.totalPages} pages</span><span>🔗 ${r.summary.totalLinks} links</span></div>
</div>
<div class="grade-banner">
  <div class="grade-circle" style="background:${gradeColor}">${overallGrade}</div>
  <div class="grade-info"><h3>Overall Score: ${avgScore}/100</h3><p>Average of SEO, Accessibility, HTML &amp; Mobile</p></div>
</div>
<div class="scores-row">${scoreRing(r.summary.seoScore || 0, 'SEO')}${scoreRing(r.summary.a11yScore || 0, 'Accessibility')}${scoreRing(r.summary.htmlScore || 0, 'HTML')}${scoreRing(r.summary.mobileScore || 0, 'Mobile')}</div>
<div class="stats-bar">
  <div class="stat-card"><div class="stat-num">${r.summary.totalPages}</div><div class="stat-label">Pages</div></div>
  <div class="stat-card"><div class="stat-num">${r.summary.totalLinks}</div><div class="stat-label">Links</div></div>
  <div class="stat-card"><div class="stat-num" style="color:${r.summary.brokenLinks > 0 ? '#dc2626' : '#16a34a'}">${r.summary.brokenLinks}</div><div class="stat-label">Broken</div></div>
  <div class="stat-card"><div class="stat-num">${r.paywallResults ? (r.summary.paywallDetected ? '✓' : '✗') : '—'}</div><div class="stat-label">Paywall</div></div>
</div>
<div class="content">
  ${r.sitemap ? `<div class="section"><div class="section-hd"><span>🗺️</span>Sitemap</div><div class="sitemap-ok">✓ Found at <strong style="margin:0 4px">${escHtml(r.sitemap.url)}</strong> — ${r.sitemap.totalUrls} URLs, ${r.sitemap.audited} audited</div></div>` : '<div class="section"><div class="section-hd"><span>🗺️</span>Sitemap</div><div class="sitemap-err">✕ Sitemap not found</div></div>'}
  ${pagesHtml}
  ${issueBlock('SEO Analysis', '🔍', r.seoResults, 'seoScore')}
  ${issueBlock('Accessibility (ADA)', '♿', r.accessibilityResults, 'a11yScore')}
  ${issueBlock('HTML Validation', '🧪', r.htmlResults, 'htmlScore')}
  ${issueBlock('Mobile Responsiveness', '📱', r.mobileResults, 'mobileScore')}
  ${brokenLinksHtml}
  ${paywallHtml}
</div>
<div class="footer">
  <img src="${escHtml(faviconSrc)}" width="16" height="16" style="vertical-align:middle;margin-right:4px;border-radius:3px"/>
  ${escHtml(siteName)} — Site Audit Report &middot; Generated by <strong>AI Testing Tools</strong>
</div>
</body></html>`;
  }
})();
