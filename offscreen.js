/* ===== Playwright Pilot — Offscreen Recording Script ===== */

let mediaRecorder = null;
let recordedChunks = [];
let videoCanvas = null;
let canvasCtx = null;

/* ── Shared IndexedDB (same origin as popup) ── */
const VIDEO_DB_NAME = 'pw_pilot_videos';
const VIDEO_DB_VERSION = 1;
const VIDEO_STORE = 'videos';
const LATEST_VIDEO_KEY = '__latest_recording';

function openVideoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VIDEO_DB_NAME, VIDEO_DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(VIDEO_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveVideoToDb(key, blob) {
  const db = await openVideoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VIDEO_STORE, 'readwrite');
    tx.objectStore(VIDEO_STORE).put({ blob, ts: Date.now() }, key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_INIT_VIDEO') {
    initVideoRecording(msg.width || 1280, msg.height || 720)
      .then(() => sendResponse({ started: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_ADD_FRAME') {
    addFrame(msg.dataUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP_RECORDING') {
    const idbKey = msg.idbKey || LATEST_VIDEO_KEY;
    stopRecording(idbKey)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function initVideoRecording(width, height) {
  // Clean up previous recorder
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    } catch { /* already stopped */ }
    mediaRecorder = null;
    recordedChunks = [];
  }

  videoCanvas = document.getElementById('videoCanvas');
  if (!videoCanvas) {
    videoCanvas = document.createElement('canvas');
    videoCanvas.id = 'videoCanvas';
    videoCanvas.style.display = 'none';
    document.body.appendChild(videoCanvas);
  }
  videoCanvas.width = width;
  videoCanvas.height = height;
  canvasCtx = videoCanvas.getContext('2d');

  // Fill with blank frame so captureStream has initial content
  canvasCtx.fillStyle = '#1a1a2e';
  canvasCtx.fillRect(0, 0, width, height);

  const stream = videoCanvas.captureStream(4); // Up to 4 FPS
  recordedChunks = [];

  // Choose a supported mimeType (cross-browser)
  const mimeTypes = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  let mimeType = '';
  for (const mt of mimeTypes) {
    if (MediaRecorder.isTypeSupported(mt)) { mimeType = mt; break; }
  }
  if (!mimeType) throw new Error('No supported video MIME type');

  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 1_500_000,
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.start(500);
}

function addFrame(dataUrl) {
  return new Promise((resolve) => {
    if (!canvasCtx || !videoCanvas) { resolve(); return; }
    const img = new Image();
    img.onload = () => {
      canvasCtx.drawImage(img, 0, 0, videoCanvas.width, videoCanvas.height);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
}

function stopRecording(idbKey) {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve({ dataUrl: null, savedToIdb: false });
      return;
    }

    mediaRecorder.onstop = async () => {
      mediaRecorder = null;

      if (!recordedChunks.length) {
        resolve({ dataUrl: null, savedToIdb: false });
        return;
      }

      const blob = new Blob(recordedChunks, { type: recordedChunks[0]?.type || 'video/webm' });
      recordedChunks = [];

      // Save blob directly to IndexedDB (reliable, no size limits via messaging)
      let savedToIdb = false;
      try {
        await saveVideoToDb(idbKey || LATEST_VIDEO_KEY, blob);
        savedToIdb = true;
      } catch (e) {
        console.warn('[Offscreen] Failed to save video to IDB:', e);
      }

      // Also try to create a dataUrl for small videos (can be returned via message)
      const sizeMb = blob.size / (1024 * 1024);
      if (sizeMb < 5) {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ dataUrl: reader.result, savedToIdb, idbKey: idbKey || LATEST_VIDEO_KEY });
        reader.onerror = () => resolve({ dataUrl: null, savedToIdb, idbKey: idbKey || LATEST_VIDEO_KEY });
        reader.readAsDataURL(blob);
      } else {
        // Large video — just use IDB
        resolve({ dataUrl: null, savedToIdb, idbKey: idbKey || LATEST_VIDEO_KEY });
      }
    };

    mediaRecorder.onerror = (e) => reject(new Error(e.error?.message || 'Recording error'));
    mediaRecorder.stop();
  });
}
