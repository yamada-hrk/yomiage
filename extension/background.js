function baseUrl(host) {
  const h = (host || 'localhost:50021').replace(/^https?:\/\//, '');
  return `http://${h}`;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const base = baseUrl(message.host);

  if (message.action === 'checkConnection') {
    fetch(`${base}/version`)
      .then(res => res.json())
      .then(version => sendResponse({ connected: true, version }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (message.action === 'getSpeakers') {
    fetch(`${base}/speakers`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(speakers => sendResponse({ speakers }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'synthesize') {
    synthesize(base, message.text, message.speakerId, message.speedScale ?? 1.0)
      .then(audioBase64 => sendResponse({ audioBase64 }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function synthesize(base, text, speakerId, speedScale) {
  const queryRes = await fetch(
    `${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
    { method: 'POST' }
  );
  if (!queryRes.ok) throw new Error(`audio_query失敗: HTTP ${queryRes.status}`);

  const query = await queryRes.json();
  query.speedScale = speedScale;

  const synthRes = await fetch(
    `${base}/synthesis?speaker=${speakerId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(query),
    }
  );
  if (!synthRes.ok) throw new Error(`synthesis失敗: HTTP ${synthRes.status}`);

  const buf = await synthRes.arrayBuffer();
  return arrayBufferToBase64(buf);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}
