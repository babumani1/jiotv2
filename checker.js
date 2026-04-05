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
      if (!tLine) continue;

      if (tLine.startsWith('#EXTINF:')) {
        const logoMatch = tLine.match(/tvg-logo="([^"]+)"/);
        const groupMatch = tLine.match(/group-title="([^"]+)"/);
        const nameSplit = tLine.split(',');
        currentCh.logo = logoMatch ? logoMatch[1] : '';
        currentCh.group = groupMatch ? groupMatch[1] : '';
        currentCh.name = nameSplit.length > 1 ? nameSplit[1].trim() : '';
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
            originalLink: tLine // Keep original to ping
          });
        }
        currentCh = {};
      }
    }
  } catch (e) { console.error('M3U fetch failed', url, e.message); }
  return parsed;
}

// --- Health Pinger ---
async function checkLinkHealth(link) {
  try {
    const urlObj = new URL(link);
    const mpd = urlObj.searchParams.get('url');
    const testUrl = mpd || link;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    // Use GET with Range to prevent full download but ensure it's fully accessible
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

// --- Main Script ---
async function run() {
  console.log("Starting IPTV Checker Workflow...");
  const sourcesRaw = await fs.readFile('sources.json', 'utf8');
  const sources = JSON.parse(sourcesRaw);

  console.log("Fetching primary JSON...");
  let primaryChannels = [];
  try {
    const jsonRes = await fetch(sources.primary);
    if (jsonRes.ok) primaryChannels = await jsonRes.json();
  } catch(e) { console.error("Primary fetch failed"); }

  console.log("Fetching M3U playlists...");
  const [jtvChannels, jstarChannels, rawBackupChannels] = await Promise.all([
    fetchAndParseM3U(sources.jtv),
    fetchAndParseM3U(sources.jstar),
    fetchAndParseM3U(sources.backup)
  ]);

  const normalizeGroup = (v = '') => v.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const allowedBackupGroupsNormalized = new Set([
    'hotstar', 'jioplus', 'jiostar', 'jiotv', 'jio', 'jio2', 'jio3', 'jiotvindip',
    'sunnxt', 'sonyww', 'sonyin', 'zee5in', 'zee5lite', 'zeesun'
  ]);

  const backupChannelsMap = new Map();
  (rawBackupChannels || []).forEach((c) => {
    const group = normalizeGroup(c.group || '');
    if (allowedBackupGroupsNormalized.has(group)) {
      let name = (c.name || '').toLowerCase().trim();
      if (name) {
        name = name.replace(/\s*-\s*rs.*$/i, '').replace(/\s*\(.*?\)/g, '').trim();
        if (!backupChannelsMap.has(name)) backupChannelsMap.set(name, []);
        backupChannelsMap.get(name).push({ url: c.link, rawUrl: c.originalLink });
      }
    }
  });

  const allChannelNames = new Set([
    ...primaryChannels.map(c => (c.name || '').toLowerCase()),
    ...jtvChannels.map(c => (c.name || '').toLowerCase()),
    ...jstarChannels.map(c => (c.name || '').toLowerCase())
  ]);

  const mergedChannels = [];
  console.log(`Merging ${allChannelNames.size} unique channels...`);

  for (const lowerName of Array.from(allChannelNames)) {
    if (!lowerName) continue;
    const primary = primaryChannels.find(c => (c.name || '').toLowerCase() === lowerName);
    const jtv = jtvChannels.find(c => (c.name || '').toLowerCase() === lowerName);
    const jstar = jstarChannels.find(c => (c.name || '').toLowerCase() === lowerName);

    const baseCh = primary || jtv || jstar;
    if (!baseCh) continue;

    const servers = [];
    // Note: We use originalLink if available for pinging, else we just use the player link.
    if (primary?.link) servers.push({ name: 'Server 1', url: primary.link, pingUrl: primary.link });
    if (jtv?.link) servers.push({ name: 'Server 2', url: jtv.link, pingUrl: jtv.originalLink || jtv.link });
    if (jstar?.link) servers.push({ name: 'Server 3', url: jstar.link, pingUrl: jstar.originalLink || jstar.link });

    const cleanLowerName = lowerName.replace(/\s*-\s*rs.*$/i, '').replace(/\s*\(.*?\)/g, '').trim();
    const backupLinks = backupChannelsMap.get(cleanLowerName);
    if (backupLinks) {
      backupLinks.forEach((bk, idx) => {
        servers.push({ name: `Backup ${idx + 1}`, url: bk.url, pingUrl: bk.rawUrl || bk.url });
      });
    }

    // Deduplicate servers by URL
    const uniqueServers = servers.filter((s, index, self) => index === self.findIndex((t) => t.url === s.url));

    mergedChannels.push({
      name: baseCh.name,
      logo: baseCh.logo,
      group: baseCh.group,
      link: uniqueServers.length > 0 ? uniqueServers[0].url : baseCh.link,
      servers: uniqueServers.map(s => ({ name: s.name, url: s.url, pingUrl: s.pingUrl })) // Keep pingUrl for now
    });
  }

  console.log(`Initiating Health Checks for ${mergedChannels.length} channels...`);
  // Process in small batches to not overwhelm network/CPU
  const BATCH_SIZE = 50;
  for (let i = 0; i < mergedChannels.length; i += BATCH_SIZE) {
    const batch = mergedChannels.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (ch) => {
      // Check multiple servers and mark online if any one server is reachable.
      if (ch.servers && ch.servers.length > 0) {
        let online = false;
        for (const s of ch.servers.slice(0, 8)) {
          const status = await checkLinkHealth(s.pingUrl || s.url);
          if (status === 'online') {
            online = true;
            break;
          }
        }
        ch.status = online ? 'online' : 'offline';
      } else {
        ch.status = await checkLinkHealth(ch.link);
      }

      // Cleanup pingUrl so it doesn't inflate JSON size
      if (ch.servers) {
        ch.servers.forEach(s => delete s.pingUrl);
      }
    }));
    
    console.log(`Checked batch ${i/BATCH_SIZE + 1} (${Math.min(i+BATCH_SIZE, mergedChannels.length)} / ${mergedChannels.length})`);
  }

  await fs.writeFile('channels.json', JSON.stringify(mergedChannels, null, 2));
  console.log("Successfully wrote channels.json with health data!");
}

run().catch(console.error);
