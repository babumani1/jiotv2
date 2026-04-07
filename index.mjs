import fs from 'fs/promises';

// --- Shared M3U Parser ---
async function fetchAndParseM3U(url) {
  const parsed = [];
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    const lines = text.split('\n');
    let currentCh = {};
    for (const line of lines) {
      const tLine = line.trim();
      if (!tLine || tLine.startsWith('#EXTM3U')) continue;

      if (tLine.startsWith('#EXTINF:')) {
        const logoMatch = tLine.match(/tvg-logo="([^"]+)"/);
        const groupMatch = tLine.match(/group-title="([^"]+)"/);
        const nameSplit = tLine.split(',');
        currentCh.logo = logoMatch ? logoMatch[1] : '';
        currentCh.group = groupMatch ? groupMatch[1] : '';
        currentCh.name = nameSplit.length > 1 ? nameSplit[1].trim() : '';
      } else if (tLine.startsWith('#KODIPROP:')) {
         const keyData = tLine.substring(tLine.indexOf('=') + 1);
         if (keyData.includes(':')) {
           const [keyId, key] = keyData.split(':');
           currentCh.keyId = keyId;
           currentCh.key = key;
         }
      } else if (!tLine.startsWith('#')) {
        if (currentCh.name) {
          const isM3U8 = /\.m3u8(\?|$)/i.test(tLine);
          let playerLink = tLine;

          if (isM3U8 && !(currentCh.keyId && currentCh.key)) {
            playerLink = `https://proxy.lrl45.workers.dev/?url=${encodeURIComponent(tLine)}`;
          } else if (currentCh.keyId) {
            const base = tLine.split('?')[0];
            playerLink = `https://dash.vodep39240327.workers.dev/?url=${base}?name=${currentCh.name.replace(/\s+/g, '_')}&keyId=${currentCh.keyId}&key=${currentCh.key}`;
          }
          
          parsed.push({
            name: currentCh.name,
            logo: currentCh.logo,
            group: currentCh.group,
            link: playerLink,
            pingUrl: tLine 
          });
        }
        currentCh = {};
      }
    }
  } catch (e) { console.error('M3U Error:', e.message); }
  return parsed;
}

// --- Health Checker ---
async function checkLinkHealth(link) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(link, { 
      method: 'GET', 
      headers: { 'Range': 'bytes=0-500' },
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    return (res.ok || res.status === 206) ? 'online' : 'offline';
  } catch { return 'offline'; }
}

// --- Main Runner ---
async function run() {
  const sourcesRaw = await fs.readFile('sources.json', 'utf8');
  const sources = JSON.parse(sourcesRaw);

  const tasks = [
    { id: 'primary', url: sources.primary, isJson: true },
    { id: 'jtv', url: sources.jtv, isJson: false },
    { id: 'jstar', url: sources.jstar, isJson: false },
    { id: 'backup', url: sources.backup, isJson: false },
    { id: 'power', url: sources.power, isJson: false },
    { id: 'perelive', url: sources.perelive, isJson: false },
     { id: 'ExtenderMax', url: sources.ExtenderMax, isJson: false }
  ];

  for (const task of tasks) {
    console.log(`Starting ${task.id}...`);
    let channels = [];
    try {
      if (task.isJson) {
        const r = await fetch(task.url);
        channels = await r.json();
      } else {
        channels = await fetchAndParseM3U(task.url);
      }

      // Health Check in Batches
      const BATCH = 20;
      for (let i = 0; i < channels.length; i += BATCH) {
        const batch = channels.slice(i, i + BATCH);
        await Promise.all(batch.map(async (ch) => {
          ch.status = await checkLinkHealth(ch.pingUrl || ch.link);
          delete ch.pingUrl; // Clean up before saving
        }));
      }

      await fs.writeFile(`${task.id}.json`, JSON.stringify(channels, null, 2));
      console.log(`Finished ${task.id}.json`);
    } catch (e) { console.error(`Failed ${task.id}:`, e.message); }
  }
}

run();
