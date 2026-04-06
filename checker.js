import fs from 'fs/promises';

// --- Shared M3U Parser (Keep your existing function) ---
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
      if (!tLine) continue;

      if (tLine.startsWith('#EXTINF:')) {
        const logoMatch = tLine.match(/tvg-logo="([^"]+)"/);
        const groupMatch = tLine.match(/group-title="([^"]+)"/);
        const nameSplit = tLine.split(',');
        currentCh.logo = logoMatch ? logoMatch[1] : '';
        currentCh.group = groupMatch ? groupMatch[1] : '';
        currentCh.name = nameSplit.length > 1 ? nameSplit[1].trim() : '';
      } else if (tLine.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
        const keyData = tLine.substring(tLine.indexOf('=') + 1);
        if (keyData) {
          const [keyId, key] = keyData.split(':');
          currentCh.keyId = keyId;
          currentCh.key = key;
        }
      } else if (tLine.startsWith('#EXTHTTP:')) {
        try {
          const headers = JSON.parse(tLine.replace('#EXTHTTP:', ''));
          if (headers.cookie) currentCh.cookie = headers.cookie;
        } catch (e) {}
      } else if (!tLine.startsWith('#')) {
        if (currentCh.name) {
          const isM3U8 = /\.m3u8(\?|$)/i.test(tLine);
          let playerLink = '';

          if (isM3U8 && !(currentCh.keyId && currentCh.key)) {
            playerLink = `https://proxy.lrl45.workers.dev/?url=${encodeURIComponent(tLine)}`;
          } else {
            const baseMpDUrl = tLine.split('?')[0];
            playerLink = `https://dash.vodep39240327.workers.dev/?url=${baseMpDUrl}?name=${currentCh.name.replace(/\s+/g, '_')}`;

            if (currentCh.keyId && currentCh.key) {
              playerLink += `&keyId=${currentCh.keyId}&key=${currentCh.key}`;
            }
            if (currentCh.cookie) {
              playerLink += `&cookie=${currentCh.cookie}`;
            } else if (tLine.includes('__hdnea__=')) {
              const match = tLine.match(/__hdnea__=[^&]+/);
              if (match) playerLink += `&cookie=${match[0]}`;
            }
          }
          
          parsed.push({
            name: currentCh.name,
            logo: currentCh.logo,
            group: currentCh.group,
            link: playerLink,
            originalLink: tLine 
          });
        }
        currentCh = {};
      }
    }
  } catch (e) { console.error('M3U fetch failed', url, e.message); }
  return parsed;
}

// --- Health Pinger (Keep your existing function) ---
async function checkLinkHealth(link) {
  try {
    const urlObj = new URL(link);
    const mpd = urlObj.searchParams.get('url');
    const testUrl = mpd || link;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(testUrl, { 
      method: 'GET', 
      headers: { 'Range': 'bytes=0-500' },
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    
    if (res.ok || res.status === 206) return 'online';
    return 'offline';
  } catch (e) {
    return 'offline';
  }
}

// --- New Logic: Process Sources Separately ---
async function processSource(name, url, isJson = false) {
  console.log(`Processing ${name}...`);
  let channels = [];

  try {
    if (isJson) {
      const res = await fetch(url);
      if (res.ok) channels = await res.json();
    } else {
      channels = await fetchAndParseM3U(url);
    }
  } catch (e) {
    console.error(`Failed to fetch ${name}`);
    return;
  }

  console.log(`Checking health for ${channels.length} channels in ${name}...`);
  
  const BATCH_SIZE = 20; // Smaller batch to be safe
  for (let i = 0; i < channels.length; i += BATCH_SIZE) {
    const batch = channels.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (ch) => {
      // Use originalLink if it exists, otherwise use link
      const pingUrl = ch.originalLink || ch.link;
      ch.status = await checkLinkHealth(pingUrl);
      // Optional: remove originalLink to save space
      delete ch.originalLink;
    }));
  }

  await fs.writeFile(`${name}_checked.json`, JSON.stringify(channels, null, 2));
  console.log(`Saved: ${name}_checked.json`);
}

async function run() {
  const sourcesRaw = await fs.readFile('sources.json', 'utf8');
  const sources = JSON.parse(sourcesRaw);

  // Define your tasks individually
  const tasks = [
    { id: 'primary', url: sources.primary, isJson: true },
    { id: 'jtv', url: sources.jtv, isJson: false },
    { id: 'jstar', url: sources.jstar, isJson: false },
    { id: 'backup', url: sources.backup, isJson: false },
    { id: 'power', url: sources.power, isJson: false }
  ];

  // Run them one after another to avoid crashing memory
  for (const task of tasks) {
    await processSource(task.id, task.url, task.isJson);
  }

  console.log("All files processed individually!");
}

run().catch(console.error);
