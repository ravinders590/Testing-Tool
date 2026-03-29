(async () => {
  try {
    // Get HTML from background's in-memory variable (avoids storage timing/size issues)
    const resp = await chrome.runtime.sendMessage({ type: 'GET_PENDING_REPORT' });
    const html = resp?.html;
    if (!html) {
      document.body.textContent = 'No report data found.';
      return;
    }

    // Parse the HTML string into a DOM tree
    const parser = new DOMParser();
    const parsed = parser.parseFromString(html, 'text/html');

    // Copy <html> attributes (e.g. lang)
    for (const attr of parsed.documentElement.attributes) {
      document.documentElement.setAttribute(attr.name, attr.value);
    }

    // Clear existing head and body
    while (document.head.firstChild) document.head.removeChild(document.head.firstChild);
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);

    // Use importNode + appendChild (innerHTML doesn't activate <style> elements on extension pages)
    for (const node of [...parsed.head.childNodes]) {
      document.head.appendChild(document.importNode(node, true));
    }
    for (const node of [...parsed.body.childNodes]) {
      document.body.appendChild(document.importNode(node, true));
    }

    // Copy <body> attributes (e.g. style, class)
    for (const attr of parsed.body.attributes) {
      document.body.setAttribute(attr.name, attr.value);
    }

    document.title = parsed.title || 'Report';

    // Auto-trigger print dialog after images and styles settle
    setTimeout(() => window.print(), 900);
  } catch (e) {
    document.body.textContent = 'Error loading report: ' + e.message;
  }
})();
