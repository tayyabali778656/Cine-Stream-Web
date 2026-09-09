const fs = require('fs');
let content = fs.readFileSync('serve.js', 'utf8');

const target = `        } else {
          // ── Non-Vercel (VPS): background refresh (stale-while-revalidate) ─────
          // Serve existing episodes immediately — AnimeKai refreshes in background.`;

const replacement = `        } else {
          // ── Non-Vercel (VPS): background refresh (stale-while-revalidate) ─────
          // Serve existing episodes immediately — AnimeKai refreshes in background.
          
          const targetEpObj = episodes.find(e => e.season === season && e.episode === episode);
          const hasZeroSources = !targetEpObj || !targetEpObj.sources || targetEpObj.sources.length === 0;
          
          if (hasZeroSources) {
            // CRITICAL FIX: If target episode has NO sources from ToonStream, we MUST await AnimeKai synchronously
            // otherwise the player gets an empty array and crashes with Download APK error.
            try {
              const akEpisodes = await animekaiSvc.getLiveEpisodes(slug, season, episode);
              if (akEpisodes && akEpisodes.length > 0) {
                for (const akEp of akEpisodes) {
                  let reqEp = episodes.find(e => e.season === akEp.season && e.episode === akEp.episode);
                  if (reqEp) {
                    reqEp.sources = [...(reqEp.sources || []), ...(akEp.sources || [])];
                  } else {
                    episodes.push(akEp);
                  }
                }
              }
            } catch(e) { console.warn('Sync AK scrape failed:', e.message); }
          }`;

if (content.includes(target)) {
  content = content.replace(target, replacement);
  fs.writeFileSync('serve.js', content);
  console.log('serve.js updated successfully');
} else {
  console.log('Target not found in serve.js');
}
