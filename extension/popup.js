let speakerId = 1;
let speedScale = 1.0;
let autoNext = false;
let autoNextDelay = 5;
let voicevoxHost = 'localhost:50021';
let pollingInterval = null;
let isOnSupportedPage = false;

// --- localStorage ヘルパー ---
const KEYS = {
  speakerId:    'voicevox_speakerId',
  speedScale:   'voicevox_speedScale',
  autoNext:     'voicevox_autoNext',
  autoNextDelay:'voicevox_autoNextDelay',
  voicevoxHost: 'voicevox_host',
};

function lsGet(key, defaultValue) {
  const raw = localStorage.getItem(KEYS[key]);
  if (raw === null) return defaultValue;
  try { return JSON.parse(raw); } catch { return defaultValue; }
}

function lsSet(key, value) {
  localStorage.setItem(KEYS[key], JSON.stringify(value));
  // コンテンツスクリプトが読めるよう chrome.storage.local にも反映
  chrome.storage.local.set({ [KEYS[key]]: value });
}

// --- メッセージ送信 ---
function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function sendToContent(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('タブが見つかりません');
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// --- 対応ページ確認 ---
async function checkSupportedPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;
  const url = tab.url || '';
  return url.includes('ncode.syosetu.com/') || url.includes('kakuyomu.jp/works/');
}

// --- VOICEVOX接続確認 ---
async function checkConnection() {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'status-dot checking';
  text.textContent = 'VOICEVOX接続確認中...';

  try {
    const result = await sendToBackground({ action: 'checkConnection', host: voicevoxHost });
    if (result.connected) {
      dot.className = 'status-dot connected';
      text.textContent = `VOICEVOX v${result.version} 接続済み`;
      await loadSpeakers();
      return true;
    }
    dot.className = 'status-dot disconnected';
    text.textContent = 'VOICEVOXに接続できません';
    return false;
  } catch {
    dot.className = 'status-dot disconnected';
    text.textContent = 'VOICEVOXに接続できません';
    return false;
  }
}

// --- スピーカー一覧読み込み ---
async function loadSpeakers() {
  const select = document.getElementById('speaker-select');
  try {
    const result = await sendToBackground({ action: 'getSpeakers', host: voicevoxHost });
    if (!result.speakers) return;

    select.innerHTML = '';
    for (const speaker of result.speakers) {
      for (const style of speaker.styles) {
        const opt = document.createElement('option');
        opt.value = style.id;
        opt.textContent = `${speaker.name}（${style.name}）`;
        select.appendChild(opt);
      }
    }
    select.disabled = false;

    // 保存済みスピーカーを復元
    const saved = lsGet('speakerId', null);
    if (saved !== null) {
      select.value = saved;
      speakerId = Number(saved);
    } else {
      speakerId = Number(select.value);
    }
  } catch {
    select.innerHTML = '<option value="1">デフォルト (ID: 1)</option>';
    select.disabled = false;
  }
}

// --- UI更新 ---
function updateUI(status, error) {
  const btnPlay   = document.getElementById('btn-play');
  const btnPause  = document.getElementById('btn-pause');
  const btnStop   = document.getElementById('btn-stop');
  const progressText = document.getElementById('progress-text');
  const progressBar  = document.getElementById('progress-bar');

  if (error) {
    progressText.textContent = `エラー: ${error}`;
    progressText.className = 'progress-text error';
    return;
  }
  if (!status) return;

  const { isReading, isPaused, currentIndex, total } = status;
  progressBar.style.width = total > 0 ? `${Math.round((currentIndex / total) * 100)}%` : '0%';

  if (!isOnSupportedPage) {
    btnPlay.disabled = btnPause.disabled = btnStop.disabled = true;
    return;
  }

  if (isReading && !isPaused) {
    btnPlay.disabled = true;
    btnPlay.textContent = '▶ 再生';
    btnPause.disabled = false;
    btnPause.textContent = '⏸ 一時停止';
    btnStop.disabled = false;
    progressText.textContent = `読み上げ中: ${currentIndex + 1} / ${total} 段落`;
    progressText.className = 'progress-text reading';
  } else if (isPaused) {
    btnPlay.disabled = false;
    btnPlay.textContent = '▶ 再開';
    btnPause.disabled = true;
    btnPause.textContent = '⏸ 一時停止';
    btnStop.disabled = false;
    progressText.textContent = `一時停止中: ${currentIndex + 1} / ${total} 段落`;
    progressText.className = 'progress-text paused';
  } else if (total > 0 && currentIndex >= total - 1) {
    btnPlay.disabled = false;
    btnPlay.textContent = '▶ 再生';
    btnPause.disabled = btnStop.disabled = true;
    progressText.textContent = `読み上げ完了 (${total} 段落)`;
    progressText.className = 'progress-text done';
    progressBar.style.width = '100%';
  } else {
    btnPlay.disabled = false;
    btnPlay.textContent = '▶ 再生';
    btnPause.disabled = btnStop.disabled = true;
  }
}

// --- ポーリング ---
function startPolling() {
  stopPolling();
  pollingInterval = setInterval(async () => {
    try { updateUI(await sendToContent({ action: 'getStatus' })); } catch { /* 無視 */ }
  }, 500);
}
function stopPolling() {
  if (pollingInterval !== null) { clearInterval(pollingInterval); pollingInterval = null; }
}

// --- ボタン・コントロールイベント ---
document.getElementById('btn-play').addEventListener('click', async () => {
  try {
    const result = await sendToContent({ action: 'play', speakerId, speedScale, autoNext, autoNextDelay, voicevoxHost });
    if (!result?.success) updateUI(null, result?.error || '読み上げを開始できませんでした');
  } catch (err) {
    updateUI(null, `コンテンツスクリプトへの接続に失敗しました: ${err.message}`);
  }
});

document.getElementById('btn-pause').addEventListener('click', async () => {
  try { await sendToContent({ action: 'pause' }); } catch (err) { console.error(err); }
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  try {
    await sendToContent({ action: 'stop' });
    const progressText = document.getElementById('progress-text');
    progressText.textContent = '停止しました';
    progressText.className = 'progress-text';
    document.getElementById('progress-bar').style.width = '0%';
  } catch (err) { console.error(err); }
});

document.getElementById('speaker-select').addEventListener('change', e => {
  speakerId = Number(e.target.value);
  lsSet('speakerId', speakerId);
});

document.getElementById('speed-range').addEventListener('input', e => {
  speedScale = Number(e.target.value);
  document.getElementById('speed-value').textContent = `${speedScale.toFixed(1)}x`;
  lsSet('speedScale', speedScale);
});

document.getElementById('auto-next').addEventListener('change', e => {
  autoNext = e.target.checked;
  document.getElementById('delay-row').style.display = autoNext ? 'flex' : 'none';
  lsSet('autoNext', autoNext);
});

document.getElementById('auto-next-delay').addEventListener('change', e => {
  autoNextDelay = Number(e.target.value);
  lsSet('autoNextDelay', autoNextDelay);
});

// ホスト変更（Enterキーまたは「接続」ボタン）
function applyHost() {
  const raw = document.getElementById('voicevox-host').value.trim();
  voicevoxHost = raw || 'localhost:50021';
  document.getElementById('voicevox-host').value = voicevoxHost;
  lsSet('voicevoxHost', voicevoxHost);
  checkConnection();
}
document.getElementById('voicevox-host').addEventListener('keydown', e => {
  if (e.key === 'Enter') applyHost();
});
document.getElementById('btn-reconnect').addEventListener('click', applyHost);

// --- 初期化（localStorage から同期的に復元）---
(() => {
  speedScale    = lsGet('speedScale',    1.0);
  autoNext      = lsGet('autoNext',      false);
  autoNextDelay = lsGet('autoNextDelay', 5);
  voicevoxHost  = lsGet('voicevoxHost',  'localhost:50021');

  document.getElementById('speed-range').value          = speedScale;
  document.getElementById('speed-value').textContent    = `${speedScale.toFixed(1)}x`;
  document.getElementById('auto-next').checked          = autoNext;
  document.getElementById('delay-row').style.display    = autoNext ? 'flex' : 'none';
  document.getElementById('auto-next-delay').value      = autoNextDelay;
  document.getElementById('voicevox-host').value        = voicevoxHost;
})();

(async () => {
  isOnSupportedPage = await checkSupportedPage();
  if (!isOnSupportedPage) document.getElementById('not-supported').style.display = 'block';

  await checkConnection();

  if (isOnSupportedPage) {
    document.getElementById('btn-play').disabled = false;
    try { updateUI(await sendToContent({ action: 'getStatus' })); } catch { /* 初回は無視 */ }
  }

  startPolling();
})();
