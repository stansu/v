/* 影片下載器 — 前端（GitHub Pages 靜態頁）
 * 透過 GitHub REST API 觸發 repo 內的 .github/workflows/download.yml，
 * 再輪詢 run 狀態、下載 artifact。沒有任何後端。
 */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const API = 'https://api.github.com';
  const KEY = 'vdl.settings.v1';
  const DEFAULTS = { owner: '', repo: '', token: '', branch: 'main', workflow: 'download.yml' };
  const MAX_URLS = 10;

  let settings = loadSettings();
  const tasks = [];
  let seq = 0;
  let polling = false;

  /* ---------- 設定 ---------- */

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function persist() {
    // 無痕模式或封鎖儲存時，退化成「只存在這個分頁」
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* 忽略 */
    }
  }

  function fillForm() {
    $('#owner').value = settings.owner;
    $('#repo').value = settings.repo;
    $('#token').value = settings.token;
    $('#branch').value = settings.branch;
    $('#workflow').value = settings.workflow;
    updateConnState();
  }

  function readForm() {
    settings = {
      owner: $('#owner').value.trim(),
      repo: $('#repo').value.trim(),
      token: $('#token').value.trim(),
      branch: ($('#branch').value.trim() || 'main'),
      workflow: ($('#workflow').value.trim() || 'download.yml'),
    };
    persist();
    updateConnState();
  }

  function updateConnState() {
    const el = $('#connState');
    const ok = settings.owner && settings.repo && settings.token;
    el.textContent = ok ? `${settings.owner}/${settings.repo}` : '未設定';
    el.className = 'pill ' + (ok ? 'pill-good' : 'pill-muted');
  }

  function requireSettings() {
    if (!settings.owner || !settings.repo || !settings.token) {
      showSettings(true);
      toast('先填 owner、repo 和 token', true);
      return false;
    }
    return true;
  }

  function repoPath() {
    return `/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`;
  }

  /* ---------- GitHub API ---------- */

  async function gh(path, opts = {}) {
    const res = await fetch(API + path, {
      ...opts,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${settings.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });

    if (res.status === 204) return null;

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!res.ok) {
      let msg = (data && data.message) || `HTTP ${res.status}`;
      if (res.status === 403 && /rate limit/i.test(msg)) {
        msg += '（API 額度用完，稍後再試）';
      }
      if (res.status === 404) {
        msg += '（檢查 repo 名稱、token 權限、workflow 檔名是否正確）';
      }
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function dispatch(task) {
    await gh(`${repoPath()}/actions/workflows/${encodeURIComponent(settings.workflow)}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        ref: settings.branch,
        inputs: {
          url: task.url,
          mode: task.mode,
          quality: task.quality,
          subtitles: task.subs ? 'yes' : 'no',
          playlist: task.playlist ? 'yes' : 'no',
        },
      }),
    });
    task.owner = settings.owner;
    task.repo = settings.repo;
    task.dispatchedAt = Date.now();
    task.status = 'dispatched';
  }

  /* ---------- 輪詢 ---------- */

  const FINAL = new Set(['success', 'failure', 'error']);

  async function pollOnce() {
    if (polling) return;
    const active = tasks.filter((t) =>
      !FINAL.has(t.status) || (t.status === 'success' && !t.artifact && (t.artTries || 0) < 3)
    );
    if (!active.length) return;

    if (!settings.token) {
      active.forEach((t) => setError(t, 'token 已被清除'));
      return;
    }

    polling = true;
    try {
      // 1. 把還沒有 runId 的任務對應到剛建立的 workflow run
      const needRun = active.filter((t) => !t.runId).sort((a, b) => a.dispatchedAt - b.dispatchedAt);
      if (needRun.length) {
        const data = await gh(`${repoPath()}/actions/runs?event=workflow_dispatch&per_page=40`);
        const claimed = new Set(tasks.filter((t) => t.runId).map((t) => t.runId));
        const runs = (data.workflow_runs || [])
          .filter((x) => (x.path || '').endsWith('/' + settings.workflow) && !claimed.has(x.id))
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        for (const t of needRun) {
          const run = runs.find((x) => new Date(x.created_at).getTime() >= t.dispatchedAt - 15000);
          if (run) {
            t.runId = run.id;
            claimed.add(run.id);
          }
        }
      }

      // 2. 更新每個 run 的狀態
      for (const t of active) {
        if (!t.runId) {
          if (Date.now() - t.dispatchedAt > 90000) {
            setError(t, '90 秒內找不到對應的 run，請看 Actions 頁面');
          }
          continue;
        }
        const run = await gh(`${repoPath()}/actions/runs/${t.runId}`);
        t.status = run.status === 'completed'
          ? (run.conclusion === 'success' ? 'success' : 'failure')
          : (run.status === 'in_progress' ? 'in_progress' : 'queued');
        t.conclusion = run.conclusion || '';

        if (t.status === 'success' && !t.artifact) {
          const art = await gh(`${repoPath()}/actions/runs/${t.runId}/artifacts`);
          t.artifact = (art.artifacts || [])[0] || null;
          t.artTries = (t.artTries || 0) + 1;
        }
      }
    } catch (e) {
      // 保留可重試狀態，不把整個列表打掛
      active.forEach((t) => { t.lastError = e.message; });
    } finally {
      polling = false;
      render();
    }
  }

  function setError(task, msg) {
    task.status = 'error';
    task.error = msg;
    render();
  }

  /* ---------- 下載 artifact ---------- */

  async function saveArtifact(task) {
    const a = task.artifact;
    const runUrl = `https://github.com/${task.owner}/${task.repo}/actions/runs/${task.runId}`;
    if (!a) {
      window.open(runUrl, '_blank', 'noopener');
      return;
    }
    try {
      const res = await fetch(a.archive_download_url, {
        headers: {
          Authorization: `Bearer ${settings.token}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const el = document.createElement('a');
      el.href = href;
      el.download = `${a.name}.zip`;
      document.body.appendChild(el);
      el.click();
      el.remove();
      setTimeout(() => URL.revokeObjectURL(href), 20000);
    } catch (e) {
      // 瀏覽器 CORS 或網路阻擋時，退回 Actions 頁面手動下載
      toast('直接下載失敗（' + e.message + '），已開 Actions 頁面', true);
      window.open(runUrl, '_blank', 'noopener');
    }
  }

  /* ---------- 送出任務 ---------- */

  function parseUrls() {
    return [...new Set(
      $('#urls').value.split(/\s+/).map((s) => s.trim()).filter(Boolean)
    )];
  }

  async function start() {
    const urls = parseUrls();
    if (!urls.length) return toast('請先貼上網址', true);
    if (urls.length > MAX_URLS) return toast(`一次最多 ${MAX_URLS} 個連結`, true);
    if (!requireSettings()) return;

    const mode = $('#mode').value;
    const quality = mode === 'audio' ? '1080' : $('#quality').value;
    const subs = $('#subs').checked;
    const playlist = $('#playlist').checked;
    const btn = $('#start');

    btn.disabled = true;
    btn.textContent = '建立任務中…';

    for (const url of urls) {
      const task = {
        id: ++seq, url, mode, quality, subs, playlist,
        status: 'dispatched', runId: null, dispatchedAt: Date.now(), artTries: 0,
        owner: settings.owner, repo: settings.repo,
        artifact: null, error: '', conclusion: '',
      };
      tasks.push(task);
      render();
      try {
        await dispatch(task);
      } catch (e) {
        setError(task, e.message);
      }
    }

    btn.disabled = false;
    btn.textContent = '開始下載';
    render();
    pollOnce();
  }

  async function retry(task) {
    task.runId = null;
    task.artifact = null;
    task.error = '';
    task.conclusion = '';
    try {
      await dispatch(task);
      render();
      pollOnce();
    } catch (e) {
      setError(task, e.message);
    }
  }

  /* ---------- 畫面 ---------- */

  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return m ? `${m} 分 ${String(s % 60).padStart(2, '0')} 秒` : `${s} 秒`;
  }

  const STATUS_TEXT = {
    dispatched: '已觸發', queued: '排隊中', in_progress: '執行中',
    success: '完成', failure: '失敗', error: '錯誤',
  };

  function statusPill(status) {
    const cls = status === 'success' ? 'pill-good'
      : (status === 'failure' || status === 'error') ? 'pill-bad'
      : 'pill-muted';
    return `<span class="pill ${cls}">${STATUS_TEXT[status] || status}</span>`;
  }

  function barClass(status) {
    if (status === 'success') return 'done';
    if (status === 'failure' || status === 'error') return 'failed';
    if (status === 'in_progress' || status === 'queued' || status === 'dispatched') return 'running';
    return '';
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function render() {
    const card = $('#tasksCard');
    const list = $('#tasks');
    card.hidden = tasks.length === 0;
    if (!tasks.length) { list.innerHTML = ''; return; }

    list.innerHTML = tasks.map((t) => {
      const runUrl = t.runId
        ? `https://github.com/${t.owner}/${t.repo}/actions/runs/${t.runId}`
        : '';
      const meta = [];
      meta.push(t.mode === 'audio' ? 'mp3' : `${t.quality === 'best' ? '最佳' : t.quality + 'p'} mp4`);
      if (t.subs) meta.push('字幕');
      if (t.playlist) meta.push('播放清單');
      if (t.status === 'in_progress' || t.status === 'queued' || t.status === 'dispatched') {
        meta.push(fmtElapsed(Date.now() - t.dispatchedAt));
      }
      if (t.status === 'success' && t.artifact) {
        const kb = Math.round((t.artifact.size_in_bytes || 0) / 1024);
        meta.push(kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);
      }
      if (t.error) meta.push(t.error);

      return `
        <li class="task" data-id="${t.id}">
          <div class="task-top">
            <span class="task-url" title="${esc(t.url)}">${esc(t.url)}</span>
            ${statusPill(t.status)}
          </div>
          <div class="bar ${barClass(t.status)}"><i></i></div>
          <div class="task-foot">
            <span class="meta">${meta.map(esc).join(' · ')}</span>
            ${runUrl ? `<a class="meta" href="${esc(runUrl)}" target="_blank" rel="noopener">日誌</a>` : ''}
            ${t.status === 'success' && t.artifact
              ? `<button class="btn btn-sm btn-primary" data-act="save">下載 zip</button>` : ''}
            ${(t.status === 'failure' || t.status === 'error')
              ? `<a class="meta" href="https://github.com/${t.owner}/${t.repo}#疑難排解" target="_blank" rel="noopener">疑難排解</a>
                 <button class="btn btn-sm" data-act="retry">重新觸發</button>` : ''}
          </div>
        </li>`;
    }).join('');
  }

  /* ---------- 其他 ---------- */

  let toastTimer = null;
  function toast(msg, isErr = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function showSettings(open) {
    $('#settingsPanel').hidden = !open;
    $('#settingsToggle').setAttribute('aria-expanded', String(open));
  }

  async function testConnection() {
    readForm();
    const msg = $('#settingsMsg');
    msg.className = 'msg';
    msg.textContent = '測試中…';
    try {
      const repo = await gh(repoPath());
      const wf = await gh(`${repoPath()}/actions/workflows`);
      const found = (wf.workflows || []).some((w) => (w.path || '').endsWith('/' + settings.workflow));
      if (!found) throw new Error(`找不到 workflow ${settings.workflow}`);
      msg.className = 'msg ok';
      msg.textContent = `連線正常：${repo.full_name}（${repo.private ? '私有' : '公開'}）`;
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = '失敗：' + e.message;
    }
  }

  /* ---------- 啟動 ---------- */

  function init() {
    const q = new URLSearchParams(location.search);
    if (q.get('owner') && !settings.owner) settings.owner = q.get('owner');
    if (q.get('repo') && !settings.repo) settings.repo = q.get('repo');

    fillForm();
    $('#settingsToggle').addEventListener('click', () => showSettings($('#settingsPanel').hidden));
    $('#saveSettings').addEventListener('click', () => { readForm(); toast('已儲存'); showSettings(false); });
    $('#testConn').addEventListener('click', testConnection);
    $('#clearToken').addEventListener('click', () => {
      settings.token = '';
      $('#token').value = '';
      persist(); updateConnState(); toast('token 已清除');
    });
    $('#start').addEventListener('click', start);
    $('#clearDone').addEventListener('click', () => {
      for (let i = tasks.length - 1; i >= 0; i--) if (FINAL.has(tasks[i].status)) tasks.splice(i, 1);
      render();
    });

    $('#mode').addEventListener('change', () => {
      const audio = $('#mode').value === 'audio';
      $('#qualityField').style.opacity = audio ? '.45' : '1';
      $('#quality').disabled = audio;
    });

    $('#tasks').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const li = btn.closest('.task');
      const task = tasks.find((t) => String(t.id) === li.dataset.id);
      if (!task) return;
      if (btn.dataset.act === 'save') saveArtifact(task);
      if (btn.dataset.act === 'retry') retry(task);
    });

    const dialog = $('#howtoDialog');
    $('#howto').addEventListener('click', (ev) => { ev.preventDefault(); dialog.showModal(); });
    $('#howtoClose').addEventListener('click', () => dialog.close());

    render();
    // 每秒重繪計時器（只動態更新有在跑的任務），每 5 秒問一次 GitHub
    setInterval(() => {
      if (tasks.some((t) => !FINAL.has(t.status))) render();
    }, 1000);
    setInterval(pollOnce, 5000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
