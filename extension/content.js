// ハイライト用スタイル注入
const highlightStyle = document.createElement('style');
highlightStyle.textContent = `
  .voicevox-highlight {
    background-color: #fef08a !important;
    outline: 2px solid #eab308 !important;
    border-radius: 2px;
    transition: background-color 0.2s;
  }
  .voicevox-clickable {
    cursor: pointer;
  }
  .voicevox-clickable:hover:not(.voicevox-highlight) {
    background-color: rgba(79, 142, 247, 0.12) !important;
    outline: 1px dashed #4f8ef7 !important;
    border-radius: 2px;
  }
`;
document.head.appendChild(highlightStyle);

const state = {
  isReading: false,
  isPaused: false,
  paragraphs: [],
  elements: [],
  currentIndex: 0,
  currentAudio: null,
  currentAudioResolve: null,
  pauseResolve: null,
  speakerId: 1,
  speedScale: 1.0,
  autoNext: false,
  autoNextDelay: 5,
  voicevoxHost: 'localhost:50021',
};

// ループ世代カウンター: 古いループが新ループと競合しないよう管理
let readGeneration = 0;

// ルビを除去してテキストを取得
function getTextWithoutRuby(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('rt, rp').forEach(n => n.remove());
  return clone.textContent.trim();
}

// 小説テキストの抽出
function extractNovelContent() {
  // なろう
  const narouBody = document.querySelector('#novel_honbun');
  if (narouBody) {
    const all = Array.from(narouBody.querySelectorAll('p'));
    const filtered = all.map(el => ({ el, text: getTextWithoutRuby(el) }))
                        .filter(({ text }) => text.length > 0);
    return { elements: filtered.map(f => f.el), texts: filtered.map(f => f.text) };
  }

  // カクヨム (複数のセレクタで試行)
  const kakuyomuSelectors = [
    '.widget-episodeBody',
    '[class*="widget-episodeBody"]',
    '.episode-body',
  ];
  for (const sel of kakuyomuSelectors) {
    const container = document.querySelector(sel);
    if (container) {
      const all = Array.from(container.querySelectorAll('p'));
      if (all.length === 0) continue;
      const filtered = all.map(el => ({ el, text: getTextWithoutRuby(el) }))
                          .filter(({ text }) => text.length > 0);
      return { elements: filtered.map(f => f.el), texts: filtered.map(f => f.text) };
    }
  }

  return { elements: [], texts: [] };
}

// ハイライト制御
function highlightElement(index) {
  document.querySelectorAll('.voicevox-highlight').forEach(el => {
    el.classList.remove('voicevox-highlight');
  });
  if (index >= 0 && index < state.elements.length) {
    const el = state.elements[index];
    el.classList.add('voicevox-highlight');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// 一時停止中の待機
async function waitWhilePaused() {
  if (!state.isPaused) return;
  await new Promise(resolve => {
    state.pauseResolve = resolve;
  });
  state.pauseResolve = null;
}

// VOICEVOX合成をバックグラウンドに依頼
async function synthesize(text, speakerId, speedScale) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'synthesize', text, speakerId, speedScale, host: state.voicevoxHost },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (response.error) {
          reject(new Error(response.error));
        } else {
          resolve(response.audioBase64);
        }
      }
    );
  });
}

// ステータス通知
function notifyStatus(extraData = {}) {
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    isReading: state.isReading,
    isPaused: state.isPaused,
    currentIndex: state.currentIndex,
    total: state.paragraphs.length,
    ...extraData,
  });
}

// 次ページURLを取得
function findNextPageUrl() {
  // 汎用: <link rel="next">
  const linkNext = document.querySelector('link[rel="next"]');
  if (linkNext?.href) return linkNext.href;

  // なろう: .novel_bn 内の「次へ」リンク
  for (const nav of document.querySelectorAll('.novel_bn')) {
    const links = Array.from(nav.querySelectorAll('a'));
    const next = links.find(a => /次/.test(a.textContent));
    if (next?.href) return next.href;
  }

  // カクヨム: エピソードナビゲーションの次へリンク
  const kakuyomuNext = document.querySelector(
    '[class*="EpisodeFooter"] a[class*="next"], [class*="episodeNavigation"] a[class*="next"]'
  );
  if (kakuyomuNext?.href) return kakuyomuNext.href;

  // 汎用フォールバック: ページ内の「次の話」「次話」「次へ」リンク
  for (const a of document.querySelectorAll('a')) {
    if (/次の?[話話頁ページ章]|next/i.test(a.textContent.trim())) return a.href;
  }

  return null;
}

// カウントダウンオーバーレイを表示して次ページへ遷移
function showCountdown(nextUrl, seconds) {
  removeCountdown();

  const overlay = document.createElement('div');
  overlay.id = 'voicevox-countdown';
  Object.assign(overlay.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    background: 'rgba(22, 33, 62, 0.96)',
    color: '#e0e0e0',
    padding: '12px 16px',
    borderRadius: '8px',
    fontSize: '13px',
    zIndex: '999999',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
    fontFamily: '"Hiragino Sans", "Meiryo", sans-serif',
    border: '1px solid #0f3460',
  });

  const textEl = document.createElement('span');

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'キャンセル';
  Object.assign(cancelBtn.style, {
    background: '#ef4444',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: '12px',
    fontFamily: 'inherit',
  });

  overlay.appendChild(textEl);
  overlay.appendChild(cancelBtn);
  document.body.appendChild(overlay);

  let remaining = seconds;
  const update = () => { textEl.textContent = `${remaining}秒後に次のページへ移動します`; };
  update();

  const interval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(interval);
      removeCountdown();
      // 次ページで自動読み上げするフラグを立ててから遷移
      chrome.storage.local.set({ voicevox_autoStart: true }, () => {
        window.location.href = nextUrl;
      });
    } else {
      update();
    }
  }, 1000);

  const cancel = () => {
    clearInterval(interval);
    removeCountdown();
  };

  cancelBtn.addEventListener('click', cancel);

  const escHandler = e => {
    if (e.key === 'Escape') { cancel(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
}

function removeCountdown() {
  document.getElementById('voicevox-countdown')?.remove();
}

// 読み上げを強制停止してループを終了させる
function stopReading() {
  state.isReading = false;
  state.isPaused = false;
  if (state.currentAudio) {
    state.currentAudio.pause();
    state.currentAudio = null;
  }
  if (state.currentAudioResolve) {
    state.currentAudioResolve();
  }
  if (state.pauseResolve) {
    state.pauseResolve();
    state.pauseResolve = null;
  }
}

// 指定段落から読み上げを開始（読み上げ中でも即ジャンプ可）
function startReadingFrom(index) {
  stopReading();
  readGeneration++;
  state.currentIndex = index;
  state.isReading = true;
  state.isPaused = false;
  readLoop(index, readGeneration);
}

// クリックリスナーを段落要素に設置（起動時に chrome.storage.local から設定を復元）
async function setupParagraphListeners() {
  // ポップアップが localStorage に保存し chrome.storage.local へ同期した値を読む
  const saved = await chrome.storage.local.get([
    'voicevox_speakerId',
    'voicevox_speedScale',
    'voicevox_autoNext',
    'voicevox_autoNextDelay',
    'voicevox_host',
    'voicevox_autoStart',
  ]);
  if (saved.voicevox_speakerId     !== undefined) state.speakerId    = Number(saved.voicevox_speakerId);
  if (saved.voicevox_speedScale    !== undefined) state.speedScale   = Number(saved.voicevox_speedScale);
  if (saved.voicevox_autoNext      !== undefined) state.autoNext      = saved.voicevox_autoNext;
  if (saved.voicevox_autoNextDelay !== undefined) state.autoNextDelay = Number(saved.voicevox_autoNextDelay);
  if (saved.voicevox_host          !== undefined) state.voicevoxHost  = saved.voicevox_host;

  const { elements, texts } = extractNovelContent();
  if (texts.length === 0) return;

  state.paragraphs = texts;
  state.elements = elements;

  elements.forEach((el, i) => {
    el.classList.add('voicevox-clickable');
    el.addEventListener('click', () => startReadingFrom(i));
  });

  // 自動遷移で来た場合は即読み上げ開始（フラグは読んだら即消す）
  if (saved.voicevox_autoStart) {
    chrome.storage.local.remove('voicevox_autoStart');
    startReadingFrom(0);
  }
}

// 読み上げメインループ
async function readLoop(startIndex, generation) {
  let index = startIndex;

  while (index < state.paragraphs.length && state.isReading && generation === readGeneration) {
    state.currentIndex = index;
    highlightElement(index);
    notifyStatus();

    // 合成
    let audioBase64;
    try {
      audioBase64 = await synthesize(state.paragraphs[index], state.speakerId, state.speedScale);
    } catch (err) {
      notifyStatus({ error: `合成エラー: ${err.message}` });
      state.isReading = false;
      break;
    }

    if (!state.isReading) break;

    // 一時停止中なら合成後・再生前に待機
    await waitWhilePaused();
    if (!state.isReading) break;

    // 再生
    const audio = new Audio('data:audio/wav;base64,' + audioBase64);
    state.currentAudio = audio;

    await new Promise(resolve => {
      const done = () => {
        state.currentAudioResolve = null;
        resolve();
      };
      state.currentAudioResolve = done;
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch(done);
    });

    state.currentAudio = null;

    // 段落間で一時停止中なら待機
    await waitWhilePaused();
    if (!state.isReading) break;

    index++;
  }

  // ハイライト解除
  document.querySelectorAll('.voicevox-highlight').forEach(el => {
    el.classList.remove('voicevox-highlight');
  });

  // 世代が一致している場合のみ完了処理（別ループに引き継がれた場合はスキップ）
  if (state.isReading && generation === readGeneration) {
    state.isReading = false;
    state.isPaused = false;
    notifyStatus({ done: true });

    if (state.autoNext) {
      const nextUrl = findNextPageUrl();
      if (nextUrl) showCountdown(nextUrl, state.autoNextDelay);
    }
  }
}

// スペースキーで一時停止/再開トグル
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  if (!state.isReading && !state.isPaused) return;
  // テキスト入力中は無視
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

  e.preventDefault();

  if (state.isPaused) {
    state.isPaused = false;
    if (state.pauseResolve) {
      state.pauseResolve();
      state.pauseResolve = null;
    }
    if (state.currentAudio) {
      state.currentAudio.play();
    }
  } else {
    state.isPaused = true;
    if (state.currentAudio) {
      state.currentAudio.pause();
    }
  }
});

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'play') {
    // 設定を常に最新値で更新
    if (message.speakerId !== undefined) state.speakerId = message.speakerId;
    if (message.speedScale !== undefined) state.speedScale = message.speedScale;
    if (message.autoNext      !== undefined) state.autoNext      = message.autoNext;
    if (message.autoNextDelay !== undefined) state.autoNextDelay = message.autoNextDelay;
    if (message.voicevoxHost  !== undefined) state.voicevoxHost  = message.voicevoxHost;

    if (state.isPaused) {
      // 一時停止から再開
      state.isPaused = false;
      if (state.pauseResolve) {
        state.pauseResolve();
        state.pauseResolve = null;
      }
      if (state.currentAudio) {
        state.currentAudio.play();
      }
      sendResponse({ success: true });

    } else if (!state.isReading) {
      // 未抽出ならここで抽出、抽出済みならそのまま使う
      if (state.paragraphs.length === 0) {
        const { elements, texts } = extractNovelContent();
        if (texts.length === 0) {
          sendResponse({ success: false, error: '小説テキストが見つかりませんでした' });
          return true;
        }
        state.paragraphs = texts;
        state.elements = elements;
      }
      readGeneration++;
      state.currentIndex = 0;
      state.isReading = true;
      state.isPaused = false;
      readLoop(0, readGeneration);
      sendResponse({ success: true, total: state.paragraphs.length });
    } else {
      sendResponse({ success: true });
    }
    return true;
  }

  if (message.action === 'pause') {
    if (state.isReading && !state.isPaused) {
      state.isPaused = true;
      if (state.currentAudio) {
        state.currentAudio.pause();
      }
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'stop') {
    readGeneration++;
    stopReading();
    removeCountdown();
    document.querySelectorAll('.voicevox-highlight').forEach(el => {
      el.classList.remove('voicevox-highlight');
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'getStatus') {
    sendResponse({
      isReading: state.isReading,
      isPaused: state.isPaused,
      currentIndex: state.currentIndex,
      total: state.paragraphs.length,
    });
    return true;
  }
});

// ページ読み込み完了後にクリックリスナーを設置
setupParagraphListeners();
