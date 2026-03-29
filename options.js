/* ===== Playwright Pilot — Options Script ===== */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const SETTINGS_KEYS = [
    'githubToken',
    'aiModel',
    'defaultBaseUrl',
    'selectorStrategy',
    'testTimeout',
    'repoOwner',
    'repoName',
    'testEmail',
    'testPassword',
  ];

  /* ── Load Settings ── */
  async function loadSettings() {
    const data = await chrome.storage.sync.get(SETTINGS_KEYS);
    $('#githubToken').value = data.githubToken || '';
    $('#aiModel').value = data.aiModel || 'gpt-4o';
    $('#defaultBaseUrl').value = data.defaultBaseUrl || '';
    $('#selectorStrategy').value = data.selectorStrategy || 'auto';
    $('#testTimeout').value = data.testTimeout || 30000;
    $('#repoOwner').value = data.repoOwner || '';
    $('#repoName').value = data.repoName || '';
    $('#testEmail').value = data.testEmail || '';
    $('#testPassword').value = data.testPassword || '';
  }

  /* ── Save Settings ── */
  function handleSave(e) {
    e.preventDefault();

    const token = $('#githubToken').value.trim();
    if (!token) {
      showStatus('saveStatus', 'GitHub token is required.', true);
      return;
    }

    const settings = {
      githubToken: token,
      aiModel: $('#aiModel').value,
      defaultBaseUrl: $('#defaultBaseUrl').value.trim(),
      selectorStrategy: $('#selectorStrategy').value,
      testTimeout: parseInt($('#testTimeout').value, 10) || 30000,
      repoOwner: $('#repoOwner').value.trim(),
      repoName: $('#repoName').value.trim(),
      testEmail: $('#testEmail').value.trim(),
      testPassword: $('#testPassword').value.trim(),
    };

    chrome.storage.sync.set(settings, () => {
      showStatus('saveStatus', 'Settings saved successfully!', false);

      // Also save repo config to local
      if (settings.repoOwner && settings.repoName) {
        chrome.storage.local.set({
          pw_selected_repo: {
            owner: settings.repoOwner,
            name: settings.repoName,
            defaultBranch: 'main',
          },
        });
      }
    });
  }

  /* ── Test Connection ── */
  async function testConnection() {
    const token = $('#githubToken').value.trim();
    if (!token) {
      showTestStatus('Enter a token first.', true);
      return;
    }

    showTestStatus('Testing connection…', false);

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const user = await res.json();
      showTestStatus(`Connected as <strong>${user.login}</strong> (${user.name || 'no name'})`, false);
    } catch (err) {
      showTestStatus(`Connection failed: ${err.message}`, true);
    }
  }

  /* ── Token Toggle ── */
  function toggleTokenVisibility() {
    const input = $('#githubToken');
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  /* ── Status Helpers ── */
  function showStatus(id, msg, isError) {
    const el = $(`#${id}`);
    el.innerHTML = msg;
    el.className = `save-status ${isError ? 'error' : ''}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
  }

  function showTestStatus(msg, isError) {
    const el = $('#testStatus');
    el.innerHTML = msg;
    el.className = `test-status ${isError ? 'error' : 'success'}`;
    el.classList.remove('hidden');
  }

  /* ── Init ── */
  document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    $('#settingsForm').addEventListener('submit', handleSave);
    $('#btnTestToken').addEventListener('click', testConnection);
    $('#toggleToken').addEventListener('click', toggleTokenVisibility);
  });
})();
