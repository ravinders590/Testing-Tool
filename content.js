/* ===== Playwright Pilot — Content Script (Recorder) ===== */
(() => {
  'use strict';

  let isRecording = false;
  let options = {};
  let lastInputTarget = null;
  let inputDebounceTimer = null;

  /* ── Selector Generation ── */
  function escCssAttr(s) { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

  function getBestSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return 'body';

    // 1. data-testid (highest priority)
    if (el.dataset.testid) return `[data-testid="${escCssAttr(el.dataset.testid)}"]`;
    if (el.getAttribute('data-test-id')) return `[data-test-id="${escCssAttr(el.getAttribute('data-test-id'))}"]`;
    if (el.getAttribute('data-cy')) return `[data-cy="${escCssAttr(el.getAttribute('data-cy'))}"]`;

    // 2. aria-label (valid CSS attribute selector)
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const tag = el.tagName.toLowerCase();
      return `${tag}[aria-label="${escCssAttr(ariaLabel)}"]`;
    }

    // 3. ID (unique and reliable)
    if (el.id) return `#${CSS.escape ? CSS.escape(el.id) : el.id}`;

    // 4. Placeholder
    if (el.placeholder) return `[placeholder="${escCssAttr(el.placeholder)}"]`;

    // 5. Form elements with name
    if (el.tagName === 'INPUT') {
      const type = el.type || 'text';
      if (el.name) return `input[name="${escCssAttr(el.name)}"]`;
      return `input[type="${type}"]`;
    }
    if (el.tagName === 'SELECT' && el.name) return `select[name="${escCssAttr(el.name)}"]`;
    if (el.tagName === 'TEXTAREA' && el.name) return `textarea[name="${escCssAttr(el.name)}"]`;

    // 6. Buttons — use type or class
    if (el.tagName === 'BUTTON') {
      const cls = Array.from(el.classList).filter((c) => !/hover|focus|active/.test(c)).slice(0, 2).join('.');
      if (cls) return `button.${cls}`;
      if (el.type && el.type !== 'submit') return `button[type="${el.type}"]`;
    }

    // 7. Links — use href attribute
    if (el.tagName === 'A') {
      const href = el.getAttribute('href');
      if (href && href !== '#' && href.length < 100) return `a[href="${escCssAttr(href)}"]`;
    }

    // 8. Class-based (last resort before CSS path)
    const classes = Array.from(el.classList)
      .filter((c) => !c.includes('hover') && !c.includes('focus') && !c.includes('active'))
      .slice(0, 2)
      .join('.');
    if (classes) return `${el.tagName.toLowerCase()}.${classes}`;

    // 9. CSS path fallback
    return buildCSSPath(el);
  }

  function buildCSSPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${current.id}`);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(selector);
      current = parent;
    }
    return parts.join(' > ');
  }

  /* ── Emit Step ── */
  function emitStep(step) {
    chrome.runtime.sendMessage({ type: 'PW_STEP_RECORDED', step });
  }

  /* ── Event Descriptions ── */
  function getClickDescription(el) {
    const text = el.textContent?.trim().slice(0, 40) || '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return `button "${text}"`;
    if (tag === 'a') return `link "${text}"`;
    if (tag === 'input' && el.type === 'submit') return `submit "${el.value || text}"`;
    return text ? `"${text}"` : tag;
  }

  /* ── Event Handlers ── */
  let dblClickTimer = null;
  let pendingClick = null;

  function handleClick(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!el || el.closest('.pw-pilot-ignore')) return;

    const selector = getBestSelector(el);
    const description = getClickDescription(el);

    if (e.detail === 2) {
      // Double-click: cancel the pending single-click and emit dblclick instead
      clearTimeout(dblClickTimer);
      pendingClick = null;
      const step = { action: 'dblclick', selector, description, timestamp: Date.now(), url: location.href };
      emitStep(step);
      if (options.assertions && el.textContent?.trim()) {
        emitStep({ action: 'assert-visible', selector, description: 'Verify element visible', timestamp: Date.now() });
      }
      return;
    }

    // Single click: defer emission to distinguish from double-click
    pendingClick = { action: 'click', selector, description, timestamp: Date.now(), url: location.href };
    clearTimeout(dblClickTimer);
    dblClickTimer = setTimeout(() => {
      if (pendingClick) {
        emitStep(pendingClick);
        if (options.assertions && el.textContent?.trim()) {
          emitStep({ action: 'assert-visible', selector: pendingClick.selector, description: 'Verify element visible', timestamp: Date.now() });
        }
        pendingClick = null;
      }
    }, 300);
  }

  function handleInput(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!el || !['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;

    // Debounce input events — only emit after 500ms of inactivity
    if (lastInputTarget === el) {
      clearTimeout(inputDebounceTimer);
    }
    lastInputTarget = el;

    inputDebounceTimer = setTimeout(() => {
      if (el.tagName === 'SELECT') {
        emitStep({
          action: 'select',
          selector: getBestSelector(el),
          value: el.value,
          description: `select "${el.options[el.selectedIndex]?.text || el.value}"`,
          timestamp: Date.now(),
        });
      } else {
        emitStep({
          action: 'fill',
          selector: getBestSelector(el),
          value: el.value,
          description: `type "${el.value.slice(0, 30)}${el.value.length > 30 ? '…' : ''}"`,
          timestamp: Date.now(),
        });
      }
      lastInputTarget = null;
    }, 500);
  }

  function handleKeydown(e) {
    if (!isRecording) return;
    // Only capture special keys (Enter, Tab, Escape)
    const specialKeys = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete'];
    if (!specialKeys.includes(e.key)) return;

    emitStep({
      action: 'press',
      selector: getBestSelector(e.target),
      key: e.key,
      description: `press ${e.key}`,
      timestamp: Date.now(),
    });
  }

  function handleScroll() {
    if (!isRecording) return;
    // Only emit scroll events periodically (every 2s max)
    if (handleScroll._last && Date.now() - handleScroll._last < 2000) return;
    handleScroll._last = Date.now();

    emitStep({
      action: 'scroll',
      deltaX: 0,
      deltaY: window.scrollY,
      description: `scroll to Y:${Math.round(window.scrollY)}`,
      timestamp: Date.now(),
    });
  }

  function handleChange(e) {
    if (!isRecording) return;
    const el = e.target;
    if (el.type === 'checkbox') {
      emitStep({
        action: el.checked ? 'check' : 'uncheck',
        selector: getBestSelector(el),
        description: `${el.checked ? 'check' : 'uncheck'} "${el.name || getBestSelector(el)}"`,
        timestamp: Date.now(),
      });
    } else if (el.type === 'radio') {
      emitStep({
        action: 'click',
        selector: getBestSelector(el),
        description: `select radio "${el.value || el.name || getBestSelector(el)}"`,
        timestamp: Date.now(),
      });
    } else if (el.tagName === 'SELECT') {
      emitStep({
        action: 'select',
        selector: getBestSelector(el),
        value: el.value,
        description: `select "${el.options[el.selectedIndex]?.text || el.value}"`,
        timestamp: Date.now(),
      });
    }
  }

  /* ── Attach/Detach Listeners ── */
  function attachListeners() {
    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('change', handleChange, true);
    document.addEventListener('scroll', handleScroll, { passive: true, capture: false });
  }

  function detachListeners() {
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('change', handleChange, true);
    document.removeEventListener('scroll', handleScroll, false);
    // Clean up pending double-click timer
    clearTimeout(dblClickTimer);
    pendingClick = null;
  }

  /* ── Recording Indicator Overlay ── */
  function showRecordingOverlay() {
    if (document.getElementById('pw-pilot-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'pw-pilot-overlay';
    overlay.className = 'pw-pilot-ignore';
    overlay.innerHTML = `
      <div class="pw-rec-badge">
        <span class="pw-rec-dot"></span>
        <span>Recording</span>
      </div>`;
    document.body.appendChild(overlay);
  }

  function hideRecordingOverlay() {
    const overlay = document.getElementById('pw-pilot-overlay');
    if (overlay) overlay.remove();
  }

  /* ── Hover Highlight ── */
  let highlightEl = null;

  function showHighlight(e) {
    if (!isRecording) return;
    const el = e.target;
    if (!el || el.closest('.pw-pilot-ignore')) return;

    if (!highlightEl) {
      highlightEl = document.createElement('div');
      highlightEl.id = 'pw-pilot-highlight';
      highlightEl.className = 'pw-pilot-ignore';
      document.body.appendChild(highlightEl);
    }

    const rect = el.getBoundingClientRect();
    highlightEl.style.top = `${rect.top + window.scrollY}px`;
    highlightEl.style.left = `${rect.left + window.scrollX}px`;
    highlightEl.style.width = `${rect.width}px`;
    highlightEl.style.height = `${rect.height}px`;
    highlightEl.style.display = 'block';
  }

  function hideHighlight() {
    if (highlightEl) highlightEl.style.display = 'none';
  }

  function attachHighlight() {
    document.addEventListener('mouseover', showHighlight, true);
    document.addEventListener('mouseout', hideHighlight, true);
  }

  function detachHighlight() {
    document.removeEventListener('mouseover', showHighlight, true);
    document.removeEventListener('mouseout', hideHighlight, true);
    if (highlightEl) {
      highlightEl.remove();
      highlightEl = null;
    }
  }

  /* ── Message Handler ── */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'PW_PING') {
      sendResponse('pong');
      return false;
    }

    if (msg.type === 'PW_START_RECORD') {
      isRecording = true;
      options = msg.options || {};
      attachListeners();
      attachHighlight();
      showRecordingOverlay();

      // Emit navigate step (for the first page or when user navigated to a new page)
      if (!msg.resumed || location.href !== msg.lastUrl) {
        emitStep({
          action: 'navigate',
          url: location.href,
          description: `navigate to ${location.origin}${location.pathname}`,
          timestamp: Date.now(),
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'PW_STOP_RECORD') {
      isRecording = false;
      detachListeners();
      detachHighlight();
      hideRecordingOverlay();
      sendResponse({ ok: true });
      return false;
    }

    // Detect page elements for Happy Flow generation
    if (msg.type === 'PW_DETECT_PAGE') {
      const elements = detectPageElements();
      sendResponse(elements);
      return false;
    }

    // Audit: extract all links and page info
    if (msg.type === 'PW_AUDIT_PAGE') {
      const auditData = auditCurrentPage();
      sendResponse(auditData);
      return false;
    }

    // Full comprehensive audit (SEO, a11y, HTML, responsiveness)
    if (msg.type === 'PW_FULL_AUDIT') {
      const data = runFullPageAudit();
      sendResponse(data);
      return false;
    }

    // Mobile responsiveness check
    if (msg.type === 'PW_CHECK_MOBILE') {
      const data = checkMobileResponsiveness();
      sendResponse(data);
      return false;
    }

    // Happy Flow: classify page type from content
    if (msg.type === 'PW_CLASSIFY_PAGE') {
      const data = classifyPageContent();
      sendResponse(data);
      return false;
    }

    // Happy Flow: collect all internal links on page
    if (msg.type === 'PW_COLLECT_LINKS') {
      const data = collectInternalLinks();
      sendResponse(data);
      return false;
    }

    // Happy Flow: click a specific link by href and return result
    if (msg.type === 'PW_CLICK_LINK') {
      (async () => {
        try {
          const targetHref = msg.href;
          if (!targetHref) { sendResponse({ clicked: false, error: 'No href provided' }); return; }
          // Match using canonical form (origin+pathname) since collectInternalLinks strips query/hash
          const toCanonical = (url) => { try { const u = new URL(url, location.href); return u.origin + u.pathname; } catch { return url; } };
          const targetCanonical = toCanonical(targetHref);
          const anchor = [...document.querySelectorAll('a[href]')].find((a) => {
            try {
              const resolved = new URL(a.href, location.href);
              return resolved.href === targetHref || (resolved.origin + resolved.pathname) === targetCanonical;
            } catch { return false; }
          });
          if (!anchor) { sendResponse({ clicked: false, error: 'Link element not found on page' }); return; }
          // Scroll into view and click
          anchor.scrollIntoView({ behavior: 'instant', block: 'center' });
          await new Promise((r) => setTimeout(r, 200));
          anchor.click();
          sendResponse({ clicked: true, text: (anchor.textContent || '').trim().slice(0, 80) });
        } catch (err) {
          sendResponse({ clicked: false, error: err.message });
        }
      })();
      return true;
    }

    // Happy Flow: find and fill forms with dummy data, submit
    if (msg.type === 'PW_TEST_FORMS') {
      (async () => {
        try {
          const result = await testPageForms();
          sendResponse(result);
        } catch (err) {
          sendResponse({ error: err.message, forms: [] });
        }
      })();
      return true;
    }

    // Happy Flow: login flow — fill email/password and submit
    if (msg.type === 'PW_TEST_LOGIN') {
      (async () => {
        try {
          const result = await testLoginFlow(msg.email, msg.password);
          sendResponse(result);
        } catch (err) {
          sendResponse({ error: err.message, success: false });
        }
      })();
      return true;
    }

    // Audit: check free jobs and paywall
    if (msg.type === 'PW_CHECK_PAYWALL') {
      (async () => {
        try {
          const result = await checkFreeJobsPaywall(msg.limit || 2);
          sendResponse(result);
        } catch (err) {
          sendResponse({ error: err.message, paywallDetected: false });
        }
      })();
      return true;
    }

    // Execute a single test step in the page
    if (msg.type === 'PW_RUN_STEP') {
      (async () => {
        try {
          const result = await executeTestStep(msg.step);
          sendResponse(result);
        } catch (err) {
          sendResponse({ pass: false, error: err.message });
        }
      })();
      return true;
    }

    return false;
  });

  /* ── Test Step Execution ── */
  async function waitForEl(selector, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {
        return null; // Invalid CSS selector
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  async function executeTestStep(step) {
    const TIMEOUT = 5000;

    switch (step.action) {
      case 'click': {
        const el = await waitForEl(step.selector, TIMEOUT);
        if (!el) return { pass: false, error: `Element not found: ${step.selector}` };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise((r) => setTimeout(r, 200));
        el.click();
        return { pass: true };
      }
      case 'type': {
        const el = await waitForEl(step.selector, TIMEOUT);
        if (!el) return { pass: false, error: `Input not found: ${step.selector}` };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('focus', { bubbles: true }));
        for (const char of step.value) {
          el.value += char;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: char }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { pass: true };
      }
      case 'select': {
        const el = await waitForEl(step.selector, TIMEOUT);
        if (!el) return { pass: false, error: `Select not found: ${step.selector}` };
        el.value = step.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { pass: true };
      }
      case 'hover': {
        const el = await waitForEl(step.selector, TIMEOUT);
        if (!el) return { pass: false, error: `Element not found: ${step.selector}` };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        return { pass: true };
      }
      case 'press': {
        const active = document.activeElement || document.body;
        active.dispatchEvent(new KeyboardEvent('keydown', { key: step.key, bubbles: true }));
        active.dispatchEvent(new KeyboardEvent('keyup', { key: step.key, bubbles: true }));
        if (step.key === 'Enter') {
          active.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
        }
        return { pass: true };
      }
      case 'waitForSelector': {
        const el = await waitForEl(step.selector, TIMEOUT);
        return el ? { pass: true } : { pass: false, error: `Timeout waiting for: ${step.selector}` };
      }
      case 'assertText': {
        const el = await waitForEl(step.selector, TIMEOUT);
        if (!el) return { pass: false, error: `Element not found: ${step.selector}` };
        const text = el.textContent || '';
        if (text.includes(step.expected)) return { pass: true };
        return { pass: false, error: `Expected "${step.expected}" but got "${text.slice(0, 100)}"` };
      }
      case 'assertVisible': {
        try {
          const el = document.querySelector(step.selector);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) return { pass: true };
          }
        } catch { /* invalid selector */ }
        return { pass: false, error: `Element not visible: ${step.selector}` };
      }
      case 'scroll': {
        window.scrollBy(step.deltaX || 0, step.deltaY || 0);
        return { pass: true };
      }
      case 'waitForLoad': {
        await new Promise((r) => setTimeout(r, 1500));
        return { pass: true };
      }
      default:
        return { pass: true, skipped: true };
    }
  }

  /* ── Page Audit: Extract all links and page info ── */
  function auditCurrentPage() {
    const allLinks = Array.from(document.querySelectorAll('a[href]'));
    const links = allLinks.map((a) => {
      const href = a.href;
      const text = a.textContent?.trim().slice(0, 80) || '';
      return { href, text };
    }).filter((l) => l.href && !l.href.startsWith('javascript:') && !l.href.startsWith('mailto:'));

    const uniqueLinks = [...new Map(links.map((l) => [l.href, l])).values()];

    // Detect job listings
    const jobCards = findJobCards();

    return {
      url: location.href,
      title: document.title,
      links: uniqueLinks,
      totalLinks: uniqueLinks.length,
      jobCards: jobCards.length,
      hasPaywall: !!document.querySelector('[class*="paywall"], [class*="premium"], [class*="upgrade"], [data-paywall], .paywall-overlay, .subscription-wall'),
      pageType: detectPageType(),
    };
  }

  function findJobCards() {
    // Common selectors for job listing cards
    const selectors = [
      '[class*="job-card"]', '[class*="job-listing"]', '[class*="job-item"]',
      '[class*="jobCard"]', '[class*="jobListing"]', '[class*="jobItem"]',
      '[data-job]', '[data-job-id]', '.job', '.listing',
      'article[class*="job"]', 'li[class*="job"]', 'div[class*="job"]',
      'a[href*="/job/"]', 'a[href*="/jobs/"]',
    ];
    const found = new Set();
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => found.add(el));
      } catch { /* skip invalid selectors */ }
    }
    return Array.from(found);
  }

  function detectPageType() {
    const url = location.href.toLowerCase();
    const title = document.title.toLowerCase();
    const h1 = document.querySelector('h1')?.textContent?.toLowerCase() || '';
    if (url.includes('/job') || title.includes('job') || h1.includes('job')) return 'jobs';
    if (url.includes('/pricing') || title.includes('pricing')) return 'pricing';
    if (url.includes('/login') || url.includes('/signin')) return 'auth';
    if (url.includes('/blog') || title.includes('blog')) return 'blog';
    return 'general';
  }

  /* ── Free Jobs Paywall Check ── */
  async function checkFreeJobsPaywall(limit) {
    const jobCards = findJobCards();
    const jobLinks = [];

    // Find clickable job links
    for (const card of jobCards) {
      const link = card.tagName === 'A' ? card : card.querySelector('a[href]');
      if (link && link.href) jobLinks.push(link);
    }

    if (!jobLinks.length) {
      return { error: 'No job listings found on this page', jobsFound: 0, paywallDetected: false };
    }

    const results = [];
    let paywallDetected = false;
    const freeLinks = jobLinks.slice(0, limit + 2); // Check a few beyond the limit

    for (let i = 0; i < freeLinks.length; i++) {
      const link = freeLinks[i];
      const text = link.textContent?.trim().slice(0, 60) || link.href;

      // Simulate click
      link.click();
      await new Promise((r) => setTimeout(r, 1500));

      // Check for paywall elements
      const paywallEl = document.querySelector(
        '[class*="paywall"], [class*="premium"], [class*="upgrade"], [class*="subscribe"], ' +
        '[data-paywall], .paywall-overlay, .subscription-wall, .modal[class*="pay"], ' +
        '[class*="locked"], [class*="blur-content"], [class*="gate"]'
      );
      const isBlocked = !!paywallEl;

      if (isBlocked && i >= limit) {
        paywallDetected = true;
      }

      results.push({
        index: i + 1,
        title: text,
        href: link.href,
        blocked: isBlocked,
        paywallText: isBlocked ? (paywallEl.textContent?.trim().slice(0, 100) || 'Paywall detected') : null,
      });

      // Go back if navigated
      if (location.href !== link.href) {
        // We're still on the same page (modal/overlay paywall)
      } else {
        window.history.back();
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return {
      jobsFound: jobLinks.length,
      freeLimit: limit,
      paywallDetected,
      results,
    };
  }

  /* ── Page Element Detection ── */
  function detectPageElements() {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map((h) => h.textContent.trim())
      .filter(Boolean)
      .slice(0, 10);

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
      .map((b) => b.textContent?.trim() || b.value || b.getAttribute('aria-label') || '')
      .filter(Boolean)
      .slice(0, 15);

    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
      .map((el) => {
        let labelText = '';
        try {
          labelText = el.getAttribute('aria-label')
            || el.placeholder
            || (el.id ? document.querySelector(`label[for="${CSS.escape ? CSS.escape(el.id) : el.id}"]`)?.textContent?.trim() : '')
            || el.name
            || '';
        } catch { /* invalid selector from el.id */ }
        return labelText ? `${el.tagName.toLowerCase()}[${labelText}]` : '';
      })
      .filter(Boolean)
      .slice(0, 15);

    const forms = Array.from(document.querySelectorAll('form'))
      .map((f) => f.id || f.getAttribute('aria-label') || f.action?.split('/').pop() || 'form')
      .slice(0, 5);

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.textContent?.trim())
      .filter((t) => t && t.length < 50)
      .slice(0, 10);

    const navItems = Array.from(document.querySelectorAll('nav a, [role="navigation"] a'))
      .map((a) => a.textContent?.trim())
      .filter(Boolean)
      .slice(0, 10);

    return { headings, buttons, inputs, forms, links, navItems };
  }

  /* ── Comprehensive Page Audit ── */
  function runFullPageAudit() {
    return {
      url: location.href,
      title: document.title,
      seo: auditSEO(),
      accessibility: auditAccessibility(),
      html: auditHTML(),
      links: auditCurrentPage().links,
      totalLinks: auditCurrentPage().totalLinks,
      pageType: detectPageType(),
      jobCards: findJobCards().length,
      hasPaywall: !!document.querySelector('[class*="paywall"], [class*="premium"], [class*="upgrade"], [data-paywall]'),
    };
  }

  function auditSEO() {
    const issues = [];
    const data = {};

    // Title
    const title = document.title;
    data.title = title;
    if (!title) issues.push({ severity: 'error', msg: 'Missing page title' });
    else if (title.length < 10) issues.push({ severity: 'warn', msg: `Title too short (${title.length} chars)` });
    else if (title.length > 70) issues.push({ severity: 'warn', msg: `Title too long (${title.length} chars, recommended ≤70)` });

    // Meta description
    const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
    data.metaDescription = metaDesc;
    if (!metaDesc) issues.push({ severity: 'error', msg: 'Missing meta description' });
    else if (metaDesc.length < 50) issues.push({ severity: 'warn', msg: `Meta description too short (${metaDesc.length} chars)` });
    else if (metaDesc.length > 160) issues.push({ severity: 'warn', msg: `Meta description too long (${metaDesc.length} chars, recommended ≤160)` });

    // Canonical
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    data.canonical = canonical;
    if (!canonical) issues.push({ severity: 'warn', msg: 'Missing canonical URL' });

    // OG tags
    const ogTags = {};
    document.querySelectorAll('meta[property^="og:"]').forEach((m) => {
      ogTags[m.getAttribute('property')] = m.content;
    });
    data.ogTags = ogTags;
    if (!ogTags['og:title']) issues.push({ severity: 'warn', msg: 'Missing og:title' });
    if (!ogTags['og:description']) issues.push({ severity: 'warn', msg: 'Missing og:description' });
    if (!ogTags['og:image']) issues.push({ severity: 'warn', msg: 'Missing og:image' });
    if (!ogTags['og:url']) issues.push({ severity: 'info', msg: 'Missing og:url' });

    // Twitter card
    const twitterCard = document.querySelector('meta[name="twitter:card"]')?.content || '';
    data.twitterCard = twitterCard;
    if (!twitterCard) issues.push({ severity: 'info', msg: 'Missing twitter:card meta' });

    // H1 tags
    const h1s = document.querySelectorAll('h1');
    data.h1Count = h1s.length;
    data.h1Text = Array.from(h1s).map((h) => h.textContent.trim()).slice(0, 3);
    if (h1s.length === 0) issues.push({ severity: 'error', msg: 'Missing H1 heading' });
    else if (h1s.length > 1) issues.push({ severity: 'warn', msg: `Multiple H1 tags (${h1s.length}) — should be exactly 1` });

    // Structured data
    const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
    data.structuredData = jsonLd.length;
    if (jsonLd.length === 0) issues.push({ severity: 'info', msg: 'No structured data (JSON-LD) found' });

    // Robots meta
    const robotsMeta = document.querySelector('meta[name="robots"]')?.content || '';
    data.robots = robotsMeta;

    // Lang attribute
    const lang = document.documentElement.lang;
    data.lang = lang;
    if (!lang) issues.push({ severity: 'warn', msg: 'Missing lang attribute on <html>' });

    // Viewport
    const viewport = document.querySelector('meta[name="viewport"]')?.content || '';
    data.viewport = viewport;
    if (!viewport) issues.push({ severity: 'error', msg: 'Missing viewport meta tag' });

    return { data, issues, score: Math.max(0, 100 - issues.filter((i) => i.severity === 'error').length * 15 - issues.filter((i) => i.severity === 'warn').length * 5) };
  }

  function auditAccessibility() {
    const issues = [];

    // Images without alt
    const imgs = document.querySelectorAll('img');
    const noAlt = Array.from(imgs).filter((i) => !i.hasAttribute('alt'));
    if (noAlt.length) issues.push({ severity: 'error', msg: `${noAlt.length} image(s) missing alt attribute`, count: noAlt.length });

    // Empty alt on non-decorative images
    const emptyAlt = Array.from(imgs).filter((i) => i.hasAttribute('alt') && i.alt === '' && !i.getAttribute('role'));
    if (emptyAlt.length > 3) issues.push({ severity: 'info', msg: `${emptyAlt.length} images with empty alt (verify these are decorative)` });

    // Form inputs without labels
    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
    let unlabeled = 0;
    inputs.forEach((input) => {
      const hasLabel = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      const hasAria = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby');
      const hasTitle = input.title;
      const hasPlaceholder = input.placeholder;
      if (!hasLabel && !hasAria && !hasTitle && !hasPlaceholder) unlabeled++;
    });
    if (unlabeled) issues.push({ severity: 'error', msg: `${unlabeled} form input(s) without accessible label`, count: unlabeled });

    // Heading hierarchy
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    let prevLevel = 0;
    let skippedLevels = 0;
    for (const h of headings) {
      const level = parseInt(h.tagName[1]);
      if (prevLevel > 0 && level > prevLevel + 1) skippedLevels++;
      prevLevel = level;
    }
    if (skippedLevels) issues.push({ severity: 'warn', msg: `Heading hierarchy skipped ${skippedLevels} level(s)` });

    // Empty buttons/links
    const emptyBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter((b) => {
      return !b.textContent?.trim() && !b.getAttribute('aria-label') && !b.title && !b.querySelector('img[alt]');
    });
    if (emptyBtns.length) issues.push({ severity: 'error', msg: `${emptyBtns.length} button(s) without accessible text`, count: emptyBtns.length });

    const emptyLinks = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
      return !a.textContent?.trim() && !a.getAttribute('aria-label') && !a.title && !a.querySelector('img[alt]');
    });
    if (emptyLinks.length) issues.push({ severity: 'warn', msg: `${emptyLinks.length} link(s) without accessible text`, count: emptyLinks.length });

    // ARIA roles validation
    const ariaElements = document.querySelectorAll('[role]');
    let invalidRoles = 0;
    const validRoles = ['alert','alertdialog','application','article','banner','button','cell','checkbox','columnheader','combobox','complementary','contentinfo','definition','dialog','directory','document','feed','figure','form','grid','gridcell','group','heading','img','link','list','listbox','listitem','log','main','marquee','math','menu','menubar','menuitem','menuitemcheckbox','menuitemradio','navigation','none','note','option','presentation','progressbar','radio','radiogroup','region','row','rowgroup','rowheader','search','searchbox','separator','slider','spinbutton','status','switch','tab','table','tablist','tabpanel','term','textbox','timer','toolbar','tooltip','tree','treegrid','treeitem'];
    ariaElements.forEach((el) => { if (!validRoles.includes(el.getAttribute('role'))) invalidRoles++; });
    if (invalidRoles) issues.push({ severity: 'warn', msg: `${invalidRoles} element(s) with invalid ARIA role` });

    // Tabindex > 0 (anti-pattern)
    const positiveTabindex = document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])');
    if (positiveTabindex.length) issues.push({ severity: 'warn', msg: `${positiveTabindex.length} element(s) with positive tabindex (anti-pattern)` });

    // Color contrast (basic heuristic for text visibility)
    // Cannot compute actual contrast without getComputedStyle per element — flag known patterns
    const lowContrastHints = document.querySelectorAll('[style*="color: #ccc"], [style*="color: #ddd"], [style*="color: #eee"], [style*="color:lightgray"]');
    if (lowContrastHints.length) issues.push({ severity: 'info', msg: `${lowContrastHints.length} element(s) may have low color contrast` });

    // Skip navigation link
    const skipLink = document.querySelector('a[href="#main"], a[href="#content"], a.skip-link, a.skip-nav, [class*="skip-to"]');
    if (!skipLink) issues.push({ severity: 'info', msg: 'No skip navigation link found' });

    // Document language
    if (!document.documentElement.lang) issues.push({ severity: 'error', msg: 'Missing lang attribute on <html>' });

    const score = Math.max(0, 100 - issues.filter((i) => i.severity === 'error').length * 12 - issues.filter((i) => i.severity === 'warn').length * 5);
    return { issues, score, totalElements: document.querySelectorAll('*').length };
  }

  function auditHTML() {
    const issues = [];

    // Doctype
    if (!document.doctype) issues.push({ severity: 'error', msg: 'Missing <!DOCTYPE html>' });

    // Charset
    const charset = document.querySelector('meta[charset]') || document.querySelector('meta[http-equiv="Content-Type"]');
    if (!charset) issues.push({ severity: 'error', msg: 'Missing charset declaration' });

    // Duplicate IDs
    const ids = {};
    document.querySelectorAll('[id]').forEach((el) => {
      const id = el.id;
      if (id) ids[id] = (ids[id] || 0) + 1;
    });
    const dupes = Object.entries(ids).filter(([, c]) => c > 1);
    if (dupes.length) issues.push({ severity: 'error', msg: `${dupes.length} duplicate ID(s): ${dupes.slice(0, 5).map(([id, c]) => id + '×' + c).join(', ')}` });

    // Empty <a> tags (no href)
    const emptyAnchors = document.querySelectorAll('a:not([href])');
    if (emptyAnchors.length) issues.push({ severity: 'warn', msg: `${emptyAnchors.length} anchor tag(s) without href` });

    // Inline styles count
    const inlineStyles = document.querySelectorAll('[style]');
    if (inlineStyles.length > 20) issues.push({ severity: 'info', msg: `${inlineStyles.length} elements with inline styles` });

    // Deprecated tags
    const deprecated = document.querySelectorAll('font, center, marquee, blink, frame, frameset, applet');
    if (deprecated.length) issues.push({ severity: 'error', msg: `${deprecated.length} deprecated HTML element(s) found` });

    // Missing favicon
    const favicon = document.querySelector('link[rel*="icon"]');
    if (!favicon) issues.push({ severity: 'warn', msg: 'Missing favicon' });

    // Empty tags (potential layout issues)
    const emptyDivs = Array.from(document.querySelectorAll('div, span, p')).filter((el) => !el.textContent?.trim() && !el.children.length && !el.querySelector('img, svg, canvas, video, iframe'));
    if (emptyDivs.length > 5) issues.push({ severity: 'info', msg: `${emptyDivs.length} empty container elements` });

    // Broken image sources
    const brokenImgs = Array.from(document.querySelectorAll('img')).filter((img) => img.naturalWidth === 0 && img.complete && img.src);
    if (brokenImgs.length) issues.push({ severity: 'error', msg: `${brokenImgs.length} broken image(s)`, urls: brokenImgs.slice(0, 5).map((i) => i.src) });

    const score = Math.max(0, 100 - issues.filter((i) => i.severity === 'error').length * 15 - issues.filter((i) => i.severity === 'warn').length * 5);
    return { issues, score };
  }

  function checkMobileResponsiveness() {
    const issues = [];

    // Check viewport meta
    const viewport = document.querySelector('meta[name="viewport"]');
    if (!viewport) {
      issues.push({ severity: 'error', msg: 'Missing viewport meta tag' });
    } else {
      const content = viewport.content;
      if (!content.includes('width=device-width')) issues.push({ severity: 'warn', msg: 'Viewport not set to device-width' });
      if (content.includes('user-scalable=no') || content.includes('maximum-scale=1')) {
        issues.push({ severity: 'warn', msg: 'Viewport prevents user zoom (accessibility concern)' });
      }
    }

    // Horizontal overflow
    const bodyWidth = document.body.scrollWidth;
    const viewportWidth = window.innerWidth;
    if (bodyWidth > viewportWidth + 5) {
      issues.push({ severity: 'error', msg: `Page has horizontal overflow (body: ${bodyWidth}px > viewport: ${viewportWidth}px)` });
    }

    // Fixed-width elements
    const allEls = document.querySelectorAll('body *');
    let fixedWidthCount = 0;
    for (const el of allEls) {
      const style = getComputedStyle(el);
      const w = parseInt(style.width);
      if (w > 500 && style.width.endsWith('px') && !['IMG', 'VIDEO', 'CANVAS', 'SVG'].includes(el.tagName)) {
        fixedWidthCount++;
      }
      if (fixedWidthCount > 5) break;
    }
    if (fixedWidthCount > 5) issues.push({ severity: 'warn', msg: `${fixedWidthCount}+ elements with fixed pixel widths >500px` });

    // Text too small
    const textEls = document.querySelectorAll('p, span, li, td, th, a, label');
    let tinyText = 0;
    for (let i = 0; i < Math.min(textEls.length, 100); i++) {
      const fs = parseFloat(getComputedStyle(textEls[i]).fontSize);
      if (fs < 12) tinyText++;
    }
    if (tinyText > 3) issues.push({ severity: 'warn', msg: `${tinyText} text element(s) with font-size < 12px` });

    // Touch targets too small
    const clickables = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
    let smallTargets = 0;
    for (let i = 0; i < Math.min(clickables.length, 80); i++) {
      const rect = clickables[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
        smallTargets++;
      }
    }
    if (smallTargets > 3) issues.push({ severity: 'warn', msg: `${smallTargets} touch target(s) smaller than 44×44px` });

    // Media queries presence (check stylesheets)
    let hasMediaQueries = false;
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule instanceof CSSMediaRule) { hasMediaQueries = true; break; }
          }
        } catch { /* cross-origin */ }
        if (hasMediaQueries) break;
      }
    } catch { /* ignore */ }
    if (!hasMediaQueries) issues.push({ severity: 'warn', msg: 'No CSS media queries detected' });

    const score = Math.max(0, 100 - issues.filter((i) => i.severity === 'error').length * 20 - issues.filter((i) => i.severity === 'warn').length * 8);
    return { issues, score, viewportWidth, bodyWidth };
  }

  /* ── Happy Flow: Classify Page Content ── */
  function classifyPageContent() {
    const path = location.pathname.toLowerCase();
    const title = document.title || '';
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    const bodyText = document.body?.innerText?.slice(0, 3000) || '';

    // Count content indicators
    const jobCards = document.querySelectorAll('[class*="job" i], [class*="listing" i], [class*="position" i], [data-job], .job-card, .job-listing').length;
    const companyLinks = document.querySelectorAll('a[href*="/company/"], a[href*="/employer/"]').length;
    const searchInputs = document.querySelectorAll('input[type="search"], input[name*="search" i], input[name*="query" i], input[placeholder*="search" i]').length;
    const forms = document.querySelectorAll('form').length;
    const articleContent = document.querySelectorAll('article, [class*="article" i], [class*="blog" i], [class*="post" i]').length;

    // Detect pagination
    const hasPagination = !!document.querySelector('[class*="pagination" i], [class*="pager" i], nav[aria-label*="page" i], .page-numbers');

    return {
      url: location.href,
      path,
      title,
      h1,
      jobCards,
      companyLinks,
      searchInputs,
      forms,
      articleContent,
      hasPagination,
      isCategory: jobCards > 2 && hasPagination,
      isJobDetail: (jobCards <= 2 && (path.includes('/job') || path.includes('/position') || path.includes('/career')) && h1.length > 5),
      isCompany: path.includes('/company') || path.includes('/employer'),
      isSearch: searchInputs > 0 || path.includes('/search') || location.search.includes('search'),
    };
  }

  /* ── Happy Flow: Collect Internal Links ── */
  function collectInternalLinks() {
    const origin = location.origin;
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const href = new URL(a.href, location.href);
        if (href.origin !== origin) continue;
        const canonical = href.origin + href.pathname;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        links.push({ href: canonical, text: (a.textContent || '').trim().slice(0, 80) });
      } catch { /* invalid URL */ }
    }
    return { url: location.href, title: document.title, links, totalLinks: links.length };
  }

  /* ── Happy Flow: Test All Forms on Page ── */
  const DUMMY_DATA = {
    email: 'test@example.com',
    password: 'TestPass123!',
    tel: '+1234567890',
    number: '42',
    url: 'https://example.com',
    date: '2025-06-15',
    text: 'Test input value',
    search: 'test search',
    textarea: 'This is a test message for form validation.',
  };

  function guessInputType(el) {
    const t = (el.type || 'text').toLowerCase();
    const n = (el.name || '').toLowerCase();
    const p = (el.placeholder || '').toLowerCase();
    const lbl = (el.getAttribute('aria-label') || '').toLowerCase();
    const combined = `${n} ${p} ${lbl}`;

    if (t === 'email' || combined.includes('email')) return 'email';
    if (t === 'password' || combined.includes('password')) return 'password';
    if (t === 'tel' || combined.includes('phone')) return 'tel';
    if (t === 'number') return 'number';
    if (t === 'url') return 'url';
    if (t === 'date') return 'date';
    if (t === 'search') return 'search';
    if (combined.includes('name') && combined.includes('first')) return 'text';
    if (combined.includes('name') && combined.includes('last')) return 'text';
    if (combined.includes('name')) return 'text';
    if (el.tagName === 'TEXTAREA') return 'textarea';
    return 'text';
  }

  async function fillInput(el) {
    const kind = guessInputType(el);
    const val = DUMMY_DATA[kind] || DUMMY_DATA.text;
    await simulateTyping(el, val);
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return { field: el.name || el.id || el.type || 'unknown', value: val };
  }

  async function testPageForms() {
    const results = [];
    const forms = document.querySelectorAll('form');
    if (!forms.length) return { forms: [], message: 'No forms found on this page' };

    for (const form of forms) {
      const formResult = {
        id: form.id || form.getAttribute('aria-label') || form.action?.split('/').pop() || 'unnamed-form',
        fields: [],
        submitted: false,
        validationErrors: [],
        successIndicator: null,
      };

      // Fill all visible inputs
      const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
      for (const input of inputs) {
        if (input.offsetParent === null) continue; // skip hidden
        if (input.tagName === 'SELECT') {
          const opts = input.querySelectorAll('option');
          if (opts.length > 1) {
            input.selectedIndex = 1;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            formResult.fields.push({ field: input.name || input.id || 'select', value: opts[1].text });
          }
        } else {
          const fill = await fillInput(input);
          formResult.fields.push(fill);
        }
      }

      // Check checkboxes
      for (const cb of form.querySelectorAll('input[type="checkbox"]:not(:checked)')) {
        if (cb.offsetParent === null) continue;
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        formResult.fields.push({ field: cb.name || 'checkbox', value: 'checked' });
      }

      // Try submitting
      await new Promise((r) => setTimeout(r, 300));
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      if (submitBtn) {
        // Listen for validation errors
        const beforeUrl = location.href;
        try {
          submitBtn.click();
          formResult.submitted = true;
          await new Promise((r) => setTimeout(r, 1500));

          // Check for success
          const afterUrl = location.href;
          if (afterUrl !== beforeUrl) {
            formResult.successIndicator = `Redirected to ${afterUrl}`;
          }
          const successEl = document.querySelector('.success, .alert-success, [role="alert"], .thank-you, .confirmation');
          if (successEl) {
            formResult.successIndicator = (formResult.successIndicator || '') + ' ' + successEl.textContent.trim().slice(0, 100);
          }
          // Check for validation messages
          const errors = document.querySelectorAll('.error, .invalid-feedback, .field-error, [class*="error"], :invalid');
          for (const err of Array.from(errors).slice(0, 5)) {
            const txt = err.textContent?.trim() || err.validationMessage || '';
            if (txt) formResult.validationErrors.push(txt.slice(0, 100));
          }
        } catch (e) {
          formResult.validationErrors.push(`Submit error: ${e.message}`);
        }
      } else {
        formResult.validationErrors.push('No submit button found');
      }

      results.push(formResult);
    }
    return { forms: results };
  }

  /* ── Happy Flow: Login Test ── */

  /** Simulate realistic user typing into an input field (async with per-char delay) */
  async function simulateTyping(el, value) {
    // Focus the field first (critical for React/Vue/Angular)
    el.focus();
    el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

    // Clear existing value
    const nativeSetter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
    )?.set;

    if (nativeSetter) { nativeSetter.call(el, ''); } else { el.value = ''; }
    el.dispatchEvent(new Event('input', { bubbles: true }));

    // Type each character with small delay — lets React/Vue/Angular process each keystroke
    for (let i = 0; i < value.length; i++) {
      const char = value[i];

      // Keyboard events
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true }));

      // Set value up to current character
      const partial = value.slice(0, i + 1);
      if (nativeSetter) { nativeSetter.call(el, partial); } else { el.value = partial; }

      // InputEvent (React needs this with data + inputType)
      el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: char }));

      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: `Key${char.toUpperCase()}`, bubbles: true, cancelable: true }));

      // Yield event loop — React/Vue/Angular state updates happen between characters
      await new Promise((r) => setTimeout(r, 20));
    }

    // Final change event (fires on blur in real browsers)
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function testLoginFlow(email, password) {
    // Wait for SPA to finish rendering
    await new Promise((r) => setTimeout(r, 1500));

    // Find email/username field — extensive selectors for various frameworks
    const emailField = document.querySelector([
      'input[type="email"]:not([hidden])',
      'input[autocomplete="email"]',
      'input[autocomplete="username"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[name="login"]',
      'input[name="user"]',
      'input[name*="email"]',
      'input[name*="user"]',
      'input[id*="email" i]',
      'input[id*="user" i]',
      'input[id*="login" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="user" i]',
      'input[placeholder*="login" i]',
      'input[aria-label*="email" i]',
      'input[aria-label*="user" i]',
    ].join(', '));

    // Find password field
    const passField = document.querySelector([
      'input[type="password"]:not([hidden])',
      'input[autocomplete="current-password"]',
      'input[autocomplete="new-password"]',
      'input[name="password"]',
      'input[name*="pass"]',
      'input[id*="pass" i]',
      'input[placeholder*="pass" i]',
      'input[aria-label*="pass" i]',
    ].join(', '));

    // Fallback: if no email field found, look for the first visible text/email input near a password field
    let emailInput = emailField;
    if (!emailInput && passField) {
      const form = passField.closest('form');
      if (form) {
        emailInput = form.querySelector('input[type="text"]:not([hidden]), input[type="email"]:not([hidden])');
      }
      if (!emailInput) {
        // Look for any text input just before the password field in DOM order
        const allInputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])'));
        const passIdx = allInputs.indexOf(passField);
        if (passIdx > 0) emailInput = allInputs[passIdx - 1];
      }
    }

    if (!emailInput && !passField) {
      // Last attempt: look for any visible form with a password-like field
      const allPass = document.querySelectorAll('input[type="password"]');
      for (const p of allPass) {
        if (p.offsetParent !== null) { // visible
          const f = p.closest('form');
          if (f) emailInput = f.querySelector('input[type="text"], input[type="email"]');
          if (emailInput) break;
        }
      }
      if (!emailInput && !allPass.length) {
        return { success: false, error: 'No login form found — could not find email or password fields', fieldsFound: { email: false, password: false } };
      }
    }

    const actualEmailField = emailInput || emailField;
    const result = { success: false, fieldsFound: { email: !!actualEmailField, password: !!passField }, steps: [] };
    const beforeUrl = location.href;

    // Fill email with realistic async typing simulation
    if (actualEmailField) {
      await simulateTyping(actualEmailField, email);
      actualEmailField.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      actualEmailField.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      result.steps.push({ action: 'fill-email', field: actualEmailField.name || actualEmailField.id || 'email', value: email });
    }

    await new Promise((r) => setTimeout(r, 500));

    // Fill password with realistic async typing simulation
    if (passField) {
      await simulateTyping(passField, password);
      passField.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      passField.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      result.steps.push({ action: 'fill-password', field: passField.name || passField.id || 'password', value: '●●●●●●●●' });
    }

    await new Promise((r) => setTimeout(r, 800));

    // Find and click submit/login button — comprehensive selectors
    const form = (actualEmailField || passField)?.closest('form');
    const loginBtn = findLoginButton(form);

    if (loginBtn) {
      // Focus and click the button like a real user
      loginBtn.scrollIntoView({ block: 'center' });
      loginBtn.focus();
      await new Promise((r) => setTimeout(r, 100));
      loginBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      loginBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      loginBtn.click();

      // Also try form.requestSubmit() as fallback for sites that rely on native form submission
      if (form) {
        try { form.requestSubmit?.(loginBtn); } catch { /* some forms block this */ }
      }

      result.steps.push({ action: 'click-submit', button: loginBtn.textContent?.trim().slice(0, 40) || 'submit' });

      // Short wait to catch same-page errors (don't wait for redirect —
      // if the page navigates, this content script is destroyed, so
      // background.js monitors the tab URL for redirect detection)
      await new Promise((r) => setTimeout(r, 2500));

      // Check if still on same page (SPA login without full navigation)
      if (location.href !== beforeUrl) {
        result.steps.push({ action: 'redirect', to: location.href });
        result.success = true;
        result.redirectedTo = location.href;
      }

      // Check for error messages
      const errorSels = [
        '.error:not(.has-error)', '.alert-danger', '.alert-error',
        '[role="alert"]:not([class*="success"])', '.invalid-feedback',
        '[class*="error-message" i]', '[class*="login-error" i]',
        '.field-validation-error', '.form-error', '.notice--error',
        '[data-error]', '.flash-error', '.validation-message',
      ];
      for (const sel of errorSels) {
        try {
          const errorEl = document.querySelector(sel);
          if (errorEl && errorEl.offsetParent !== null) {
            const errText = errorEl.textContent?.trim().slice(0, 150);
            if (errText && errText.length > 2) {
              result.steps.push({ action: 'error-detected', message: errText });
              result.loginError = errText;
              break;
            }
          }
        } catch { /* invalid selector, skip */ }
      }

      // Check for success indicators (dashboard, profile, avatar, welcome)
      const successSels = [
        '[class*="dashboard" i]', '[class*="profile" i]', '[class*="welcome" i]',
        '[class*="avatar" i]', 'nav [class*="user" i]', '[class*="logged-in" i]',
        '[class*="loggedin" i]', 'body[class*="logged" i]', '[class*="account" i]',
        '[class*="my-account" i]', '.user-menu', '.user-nav', '.user-dropdown',
      ];
      for (const sel of successSels) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            result.success = true;
            result.steps.push({ action: 'success-indicator', element: el.className?.slice(0, 50) });
            break;
          }
        } catch { /* skip */ }
      }
    } else {
      result.steps.push({ action: 'no-submit-button', error: 'Could not find login/submit button' });

      // Last resort: try submitting the form directly
      if (form) {
        try {
          form.requestSubmit?.() || form.submit();
          result.steps.push({ action: 'form-submit-fallback' });
          await new Promise((r) => setTimeout(r, 5000));
          if (location.href !== beforeUrl) {
            result.success = true;
            result.redirectedTo = location.href;
            result.steps.push({ action: 'redirect', to: location.href });
          }
        } catch { /* ignore */ }
      }
    }

    return result;
  }

  /** Find login/submit button with comprehensive selectors */
  function findLoginButton(form) {
    // Priority 1: submit button inside the form
    if (form) {
      const formBtn = form.querySelector('button[type="submit"], input[type="submit"]')
        || form.querySelector('button:not([type="button"]):not([type="reset"])');
      if (formBtn) return formBtn;
    }

    // Priority 2: any submit button on page
    const submitBtn = document.querySelector('button[type="submit"], input[type="submit"]');
    if (submitBtn) return submitBtn;

    // Priority 3: button with login/signin text
    const allBtns = document.querySelectorAll('button, a[role="button"], input[type="button"]');
    const loginWords = ['log in', 'login', 'sign in', 'signin', 'submit', 'continue', 'next'];
    for (const btn of allBtns) {
      if (btn.offsetParent === null) continue; // skip hidden
      const text = (btn.textContent || btn.value || '').trim().toLowerCase();
      if (loginWords.some((w) => text === w || text.startsWith(w))) return btn;
    }

    // Priority 4: button/link with login-ish class or id
    return document.querySelector(
      'button[class*="login" i], button[class*="signin" i], button[class*="sign-in" i], '
      + 'button[id*="login" i], button[id*="signin" i], '
      + 'a[class*="login" i][href], a[class*="signin" i][href], '
      + '[class*="btn-login" i], [class*="btn-signin" i]'
    );
  }

  /** Poll for URL change or DOM mutation after login submit */
  async function pollForLoginResult(beforeUrl, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));
      if (location.href !== beforeUrl) {
        return { redirected: true, currentUrl: location.href };
      }
    }
    return { redirected: false, currentUrl: location.href };
  }

  /* ── Auto-resume recording if background says it's active for this tab ── */
  try {
    chrome.runtime.sendMessage({ type: 'GET_RECORDER_STATE' }, (state) => {
      if (chrome.runtime.lastError || !state?.active) return;
      // Background says recording is active — start recording on this page
      if (!isRecording) {
        isRecording = true;
        options = {};
        attachListeners();
        attachHighlight();
        showRecordingOverlay();

        // Emit navigate step for this new page
        emitStep({
          action: 'navigate',
          url: location.href,
          description: `navigate to ${location.origin}${location.pathname}`,
          timestamp: Date.now(),
        });
      }
    });
  } catch { /* extension context may be invalid */ }
})();
