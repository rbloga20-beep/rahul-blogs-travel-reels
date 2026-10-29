// Rahul Blogs travel reel: pick the next places -> real free stock videos (HD first) (Pixabay, Mixkit) -> FFmpeg reel in the
// "N best places" style (big title, numbered spots, end card), logo and copyright-free music -> Facebook + Instagram
// reel and story.
// usage: node scripts/reel.mjs [make|all]     (DRY_RUN=true makes the reel without posting; PLACE=... forces a place)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, ENV, GRAPH, on, need, log, sleep, http, short, readJson, writeJson, pageToken, aiJson } from './lib.mjs';

const FPS = 30, W = 1080, H = 1920;
const OUT = path.join(ROOT, 'output');
const TMP = path.join(ROOT, 'temp');
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const frames = (sec) => Math.round(sec * FPS) / FPS; // every length is a whole number of frames
const PY = process.platform === 'win32' ? 'python' : 'python3';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26, ...opts }).toString();
}
const ffprobe = (f) => JSON.parse(run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', f]));

// ---------------- topic ----------------
// every real word of the place name must be in the clip's tags/page name, so a "Kerala Backwaters" label never sits on
// a hill clip; plurals are cut to the stem ("falls" also matches "waterfall")
const STOP = new Set(['the', 'of', 'de', 'del', 'and', 'la', 'le']);
const keyWords = (name) => name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !STOP.has(w))
  .map((w) => (w.length > 4 ? w.replace(/(es|s)$/, '') : w));

function allPlaces() {
  const p = readJson('places.json', {});
  const extra = readJson('state/extra_places.json', []);
  return [...p.south.map((s) => [s, 'south']), ...p.india.map((s) => [s, 'india']), ...p.world.map((s) => [s, 'world']),
    ...extra.map((s) => [s, 'world'])].map(([s, sec]) => {
    const [name, area] = s.split('|');
    return { name: name.trim(), area: (area || '').trim(), section: sec, india: sec !== 'world' };
  });
}

async function addMorePlaces(used) {
  log('all places used: asking AI for 40 new destinations');
  const j = await aiJson(`List 40 famous, very photogenic travel destinations around the world that are NOT in this list: ${Object.keys(used).join(', ')}.
Return JSON {"places":["Place|Country", ...]} with well-known names that stock-video sites are likely to have clips of.`);
  const extra = readJson('state/extra_places.json', []);
  for (const s of j.places || []) if (/\|/.test(s) && !extra.includes(s)) extra.push(s);
  writeJson('state/extra_places.json', extra);
}

// ---------------- stock footage: videos, HD first (Pixabay + Mixkit licences, no attribution needed) ----------------
// HD (1080p+) wherever a clip has it; a 720p clip only where no HD one is available (never below 720p)
const HD = 1080, MIN_RES = 720;
const side = (x) => (x?.url ? Math.min(x.width, x.height) : 0);
async function pixabay(q) {
  if (!ENV.PIXABAY_API_KEY) return [];
  const r = await http(`https://pixabay.com/api/videos/?key=${ENV.PIXABAY_API_KEY}&q=${encodeURIComponent(q)}&per_page=80&safesearch=true`);
  if (!r.ok) { log(`pixabay ${r.status}`); return []; }
  return (r.body.hits || []).map((h) => {
    // smallest HD file (4K only when nothing smaller is HD), else the best below HD
    const v = [h.videos.large, h.videos.medium, h.videos.xlarge].find((x) => side(x) >= HD) ||
      [h.videos.large, h.videos.medium].filter((x) => side(x) >= MIN_RES).sort((a, b) => side(b) - side(a))[0];
    return v && { id: 'pxb' + h.id, src: 'Pixabay', page: h.pageURL, text: `${h.tags} ${h.pageURL}`.toLowerCase(), thumb: v.thumbnail,
      url: v.url, w: v.width, h: v.height, hd: side(v) >= HD, dur: h.duration, user: h.user,
      pop: Math.log10(1 + (h.likes || 0) * 20 + (h.downloads || 0)) };
  }).filter((c) => c && c.dur >= 4);
}
// Mixkit (Mixkit Stock Video Free License: commercial use, no attribution); no API, so its search page is read.
// The 1080p file first, 720p if that is missing; the real size is checked again after download.
async function mixkit(q) {
  const r = await http(`https://mixkit.co/free-stock-video/discover/${encodeURIComponent(q.toLowerCase().replace(/\s+/g, '-'))}/`,
    { headers: { 'User-Agent': 'Mozilla/5.0 RahulBlogsReels' } });
  if (!r.ok || typeof r.body !== 'string') return [];
  const out = [];
  for (const card of r.body.split('item-grid-card__title').slice(1)) {
    const id = (card.match(/assets\.mixkit\.co\/videos\/(\d+)\//) || [])[1];
    const title = (card.match(/^">\s*([^<]+)</) || [])[1];
    if (id && title) out.push({ id: 'mix' + id, src: 'Mixkit', page: `https://mixkit.co/free-stock-video/${id}/`, text: title.toLowerCase(),
      url: `https://assets.mixkit.co/videos/${id}/${id}-1080.mp4`, alt: `https://assets.mixkit.co/videos/${id}/${id}-720.mp4`,
      thumb: `https://assets.mixkit.co/videos/${id}/${id}-thumb-360-0.jpg`, w: 1920, h: 1080, hd: true, dur: 8, pop: 2.5 });
  }
  return out;
}

// HD photos, only for places that have no video at all. A photo counts as HD when a full 1080x1920 frame can be cut
// from it without upscaling. Pixabay's free API stops at 1280 px, so the sources are Unsplash (free key, Unsplash
// License) and Wikimedia Commons originals that are CC0 / public domain.
const photoHD = (w, h) => Math.min(w, h * 9 / 16) >= 1080;
async function unsplash(q) {
  if (!ENV.UNSPLASH_ACCESS_KEY) return [];
  const r = await http(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(q)}&per_page=30&content_filter=high`,
    { headers: { Authorization: 'Client-ID ' + ENV.UNSPLASH_ACCESS_KEY, 'Accept-Version': 'v1' } });
  if (!r.ok) { log(`unsplash ${r.status}`); return []; }
  return (r.body.results || []).filter((p) => photoHD(p.width, p.height)).map((p) => ({
    id: 'uns' + p.id, type: 'photo', src: 'Unsplash', page: p.links.html, user: p.user?.name,
    text: `${p.description || ''} ${p.alt_description || ''} ${p.slug || ''}`.toLowerCase(),
    url: `${p.urls.raw}&w=2160&fm=jpg&q=85`, thumb: p.urls.small, w: p.width, h: p.height, track: p.links.download_location,
    pop: Math.log10(1 + (p.likes || 0) * 20) }));
}
async function commonsPhotos(q) {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=40' +
    `&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=2160`;
  const r = await http(u, { headers: { 'User-Agent': 'RahulBlogsReels/1.0 (rbloga20@gmail.com)' } });
  if (!r.ok) return [];
  return Object.values(r.body.query?.pages || {}).map((p) => ({ p, ii: p.imageinfo?.[0] })).filter(({ ii }) => ii &&
    /^(cc0|public domain|pd)/i.test(ii.extmetadata?.LicenseShortName?.value || '') && photoHD(ii.width, ii.height)).map(({ p, ii }) => ({
    id: 'wmc' + p.pageid, type: 'photo', src: 'Wikimedia Commons', page: ii.descriptionurl, user: '',
    text: p.title.toLowerCase(), url: ii.thumburl || ii.url, thumb: ii.thumburl?.replace(/\/\d+px-/, '/500px-') || ii.url, // Wikimedia only serves standard thumb widths
    w: ii.width, h: ii.height, pop: 2 }));
}

// only clips whose tags/page name really mention the place (stock tags are often wrong for real places)
async function clipsFor(place, usedClips, max = 7) {
  const kws = keyWords(place.name);
  const bad = /\b(people|man|woman|girl|boy|model|selfie|portrait|dance|wedding|ship|port|traffic|construction|farm|food|cooking|interior|office)\b/;
  let all = [...await pixabay(place.name), ...await mixkit(place.name)];
  let ok = all.filter((c) => !usedClips[c.id] && kws.length && kws.every((k) => c.text.includes(k)) && !bad.test(c.text));
  if (!ok.length && place.section !== 'region') {
    // no video of this place anywhere -> HD photos; the Gemini check below decides whether they really show it
    all = [...await unsplash(place.name), ...await commonsPhotos(place.name)];
    ok = all.filter((c) => !usedClips[c.id] && !bad.test(c.text) && (ENV.GEMINI_API_KEY || kws.every((k) => c.text.includes(k))));
  }
  // most scenic + most liked first, a little randomness so reels differ
  const score = (c) => (c.text.match(SCENIC) || []).length * 1.2 + (c.pop ?? 2.5) + (c.h > c.w ? 1 : 0) + Math.random() +
    (c.hd ? 4 : 0); // an HD clip of the place always beats a 720p one
  const ranked = ok.map((c) => ({ ...c, score: score(c) })).sort((a, b) => b.score - a.score);
  return verifyClips(place, ranked, max);
}

// stock tags are often wrong ("munnar" on a river with boats), so Gemini looks at each clip's thumbnail:
// does it plausibly show this place, and is it scenic? Verdicts are cached; at most VISION_BUDGET checks per run.
let visionLeft = parseInt(ENV.VISION_BUDGET || '30', 10); // 6 runs x 30 stays well inside the free daily quota
async function verifyClips(place, clips, max = 7) {
  if (!ENV.GEMINI_API_KEY || on('SKIP_VISION')) return clips.slice(0, max);
  const cache = readJson('state/clip_checks.json', {});
  const out = [];
  for (const c of clips) {
    if (out.length >= max) break;
    const key = `${c.id}|${place.name}`;
    if (!cache[key]?.v && c.thumb && visionLeft > 0) { // v2 verdicts also check "view of the place"
      visionLeft--;
      try {
        const ir = await fetch(c.thumb, { headers: { 'User-Agent': 'RahulBlogsReels/1.0' } });
        if (!ir.ok || !/image/.test(ir.headers.get('content-type') || '')) throw new Error(`thumbnail HTTP ${ir.status}`);
        const img = await ir.arrayBuffer();
        let r;
        for (const m of (ENV.GEMINI_VISION_MODELS || 'gemini-3.1-flash-lite,gemini-3.5-flash-lite,gemini-3.5-flash').split(',')) {
          r = await http(`https://generativelanguage.googleapis.com/v1beta/models/${m.trim()}:generateContent`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ENV.GEMINI_API_KEY },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [
              { inline_data: { mime_type: 'image/jpeg', data: Buffer.from(img).toString('base64') } },
              { text: `This is ${c.type === 'photo' ? 'a stock photo found for' : 'a frame of a stock video tagged'} "${place.name}"${place.area ? ` (${place.area})` : ''}. ` +
                'Could it really show that place (landscape, landmarks, vegetation, climate all plausible)? Is it a beautiful travel shot? ' +
                'Is a person (or vehicle with rider) the main subject? Is it a view of the place itself (landscape, landmark, ' +
                'town, water, nature scenery) rather than an animal, insect, plant/flower close-up, object, map, drawing or document? ' +
                'Return JSON {"plausible": true/false, "scenic": 1-10, "has_text_or_watermark": true/false, "person_main_subject": true/false, "place_view": true/false}' }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
          }, 60000);
          if (r.ok || ![429, 500, 503, 0].includes(r.status)) break; // busy -> next model
        }
        if (!r.ok) throw new Error(`gemini HTTP ${r.status} ${short(r.body).slice(0, 120)}`);
        const j = JSON.parse(r.body.candidates[0].content.parts.map((p) => p.text || '').join(''));
        await sleep(1500); // stay under the free per-minute limit
        // landscapes only: our text must never sit on a person
        cache[key] = { v: 2, ok: !!j.plausible && !!j.place_view && !j.has_text_or_watermark && !j.person_main_subject && (j.scenic || 0) >= 6, s: j.scenic || 0 };
      } catch (e) { log(`vision check failed (${e.message}), keeping clip`); cache[key] = null; }
    }
    // photos always need a passed Gemini check (a "Ponmudi bush frog" photo once matched by name); videos pass on
    // their tags only when Gemini could not be asked
    if (cache[key]?.ok || ((cache[key] === undefined || cache[key] === null) && c.type !== 'photo')) out.push(c);
    else log(`  dropped ${c.page} (${cache[key] ? `${cache[key].s}/10 or not ${place.name}` : 'photo not verified'})`);
  }
  if (!on('DRY_RUN')) writeJson('state/clip_checks.json', cache);
  return out;
}
const SCENIC = /\b(nature|landscape|aerial|drone|waterfall|mountains?|beach|sunset|sunrise|lake|river|sea|ocean|hills?|tea|backwaters?|boat|houseboat|forest|clouds|mist|fog|valley|palm|island|temple|fort|palace|snow|green|scenic|coast|waves|lagoon|garden)\b/g;

// A reel in the style of the reference "Munnar 10 best location": title clip -> numbered spots, one clip each (HD first) ->
// closing clip ("More beautiful places" / "Follow for more"). shots[] carries role intro|item|outro.
//   list:   "KERALA / 6 best places to visit" -> 1 Munnar, 2 Varkala ...   (places of one state/country)
//   single: "MUNNAR / <short line>" -> several clips of that one place, labelled with its name
async function chooseReel() {
  const used = readJson('state/used_places.json', {});
  const usedClips = readJson('state/used_clips.json', {});
  let places = allPlaces();
  if (ENV.PLACE) {
    const [name, area] = ENV.PLACE.split('|');
    const a = (area || '').trim();
    places = [{ name: name.trim(), area: a, section: 'manual', india: places.some((p) => p.india && p.area === a) }];
  } else if (!places.some((p) => !used[p.name])) { await addMorePlaces(used); places = allPlaces(); }
  // "no footage" marks expire after 45 days (new stock gets uploaded); dry runs never write them
  const today = new Date().toISOString().slice(0, 10);
  const stale = (u) => u && u.status === 'no footage' && (Date.now() - Date.parse(u.date)) / 864e5 > 45;
  const free = places.filter((p) => ENV.PLACE || !used[p.name] || stale(used[p.name]));
  const noFootage = (p) => { if (!ENV.PLACE && !on('DRY_RUN')) used[p.name] = { date: today, status: 'no footage' }; };
  const save = () => { if (!ENV.PLACE && !on('DRY_RUN')) writeJson('state/used_places.json', used); };
  const regionOf = (area, india) => ({ name: area, area: '', section: 'region', india });
  const take = (clip, place, role, num) => ({ ...clip, place, role, num });

  // the list is built from one state/country when it has 4+ places with footage, else from the whole section
  // ("SOUTH INDIA / 6 best places"): South India has few stock clips per state (checked 2026-10-29: 15 of 77 places)
  const SECTION = { south: 'South India', india: 'India', world: 'Around the World', manual: '', region: '' };
  const makeList = (title, india, found, rc) => {
    const region = regionOf(title, india);
    const spare = [...rc, ...found.filter(([, c]) => c[1]).map(([, c]) => c[1])]; // intro/outro clips
    if (found.length < 4 || !spare.length) return null;
    save();
    const items = found.slice(0, 8).map(([p, c], i) => take(c[0], p, 'item', i + 1));
    return { kind: 'list', area: region, places: items.map((s) => s.place),
      shots: [take(spare[0], region, 'intro'), ...items, take(spare[1] || spare[0], region, 'outro')] };
  };
  for (let a = 0; a < 4 && free.length; a++) {
    const sec = free[0].section;
    const pool = free.filter((p) => p.section === sec).slice(0, 24);
    const found = [];
    for (const p of pool) {
      const c = await clipsFor(p, usedClips, 2);
      log(`${p.name}: ${c.length} clips`);
      if (c.length) found.push([p, c]); else noFootage(p);
      if (found.length >= 10) break;
    }
    const taken = new Set(found.flatMap(([, c]) => c.map((x) => x.id)));
    const fresh = async (place, max) => (await clipsFor(place, usedClips, max)).filter((c) => !taken.has(c.id));
    // 1) one state/country with 4+ places
    const areas = [...new Set(found.map(([p]) => p.area))];
    for (const ar of areas) {
      const f = found.filter(([p]) => p.area === ar);
      if (f.length < 4) continue;
      const rc = await fresh(regionOf(ar), 2);
      const r = makeList(ar, f[0][0].india, f, rc);
      if (r) return r;
    }
    // 2) the whole section
    if (SECTION[sec] && found.length >= 4) {
      const rc = sec === 'world' ? [] : await fresh(regionOf(SECTION[sec]), 2);
      const r = makeList(SECTION[sec], sec !== 'world', found, rc);
      if (r) return r;
    }
    const area = (found[0]?.[0] || pool[0]).area;
    const region = regionOf(area, pool[0].india);
    const rc = await fresh(region, 6);
    log(`region ${area}: ${rc.length} clips`);
    // one place with plenty of clips of its own
    for (const [p] of found) {
      const c = await clipsFor(p, usedClips, 7);
      if (c.length >= 5) {
        save();
        return { kind: 'single', area: region, places: [p],
          shots: [take(c[0], p, 'intro'), ...c.slice(1, -1).map((x) => take(x, p, 'item')), take(c[c.length - 1], p, 'outro')] };
      }
    }
    // the state itself
    if (rc.length >= 4) {
      save();
      return { kind: 'single', area: region, places: [region],
        shots: [take(rc[0], region, 'intro'), ...rc.slice(1, -1).map((x) => take(x, region, 'item')), take(rc[rc.length - 1], region, 'outro')] };
    }
    // places that have a clip or two stay in the queue for a later list; the next section gets its turn now
    for (const p of pool) free.splice(free.indexOf(p), 1);
  }
  save();
  throw new Error('no place with enough free stock footage found in this run');
}

// ---------------- words ----------------
async function writeText(reel) {
  const recent = readJson('state/posts.json', []).slice(-12).map((p) => p.sub).filter(Boolean);
  const list = reel.kind === 'list';
  const names = reel.places.map((p) => (p.area ? `${p.name} (${p.area})` : p.name)).join(', ');
  const prompt = `You write for "Rahul Blogs", an Indian travel creator's Facebook/Instagram reels (scenic clips + music + on-screen text, no voice).
Reel: ${list ? `numbered list of the best places in ${reel.area.name}: ${names}` : `scenes of ${names}`}.
Write natural, human English (simple words like a real traveller; no clichés like "hidden gem", "breathtaking", "nestled").
Return JSON:
{"sub": "short line shown under the big title, max 26 characters, no emoji${list ? `, e.g. "${reel.places.length} best places to visit"` : ', e.g. "In next 3 months", "Best time: Sep to Mar"'}; don't repeat these: ${JSON.stringify(recent)}",
 "line": "one caption line with 1 true, specific fact (best time to visit, what it is famous for), max 120 characters, 1 emoji allowed",
 "question": "a short question that invites comments, 1 emoji allowed",
 "hashtags": ["8 to 10 relevant hashtags without #, English letters only, mix of place names and travel tags"]}`;
  const title = (list ? reel.area.name : reel.places[0].name);
  try {
    const j = await aiJson(prompt, { check: (x) => {
      const s = String(x.sub || '').trim();
      if (s.length < 4 || s.length > 30) return 'bad sub';
      if (!String(x.line || '').trim() || !Array.isArray(x.hashtags)) return 'missing caption/hashtags';
    } });
    return { title, sub: String(j.sub).replace(/[\p{Extended_Pictographic}️#]/gu, '').trim(), line: String(j.line).trim(),
      question: String(j.question || 'Which one would you visit first? 👇').trim(),
      hashtags: (j.hashtags || []).map((h) => String(h).replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean) };
  } catch (e) {
    log('AI text failed, using a template: ' + e.message);
    return { title, sub: list ? `${reel.places.length} best places to visit` : pick(['Save this for your trip', 'Best time: Oct to Mar', 'Add it to your list']),
      line: list ? `Best places in ${title} 📍` : `${title} 📍`, question: 'Which one would you visit first? 👇',
      hashtags: [...reel.places.map((x) => x.name.replace(/\W/g, '')), title.replace(/\W/g, ''), 'travel', 'travelreels'] };
  }
}
function postText(t, reel) {
  const fixed = (ENV.FIXED_HASHTAGS || 'travel reels explore travelgram wanderlust').split(/[\s,#]+/).filter(Boolean);
  if (reel.places.some((p) => p.india) || reel.area?.india) fixed.push('incredibleindia');
  const tags = [...new Set([...t.hashtags, ...fixed].map((h) => h.toLowerCase()))].slice(0, 15).map((h) => '#' + h);
  const list = reel.kind === 'list' ? '\n\n' + reel.places.map((p, i) => `${i + 1}. ${p.name}`).join('\n') : '';
  // Unsplash's API guidelines ask for the photographer's name
  const uns = [...new Set(reel.shots.filter((c) => c.src === 'Unsplash').map((c) => c.user).filter(Boolean))];
  const credit = uns.length ? `\n📷 Photos: ${uns.join(', ')} on Unsplash` : '';
  return `${t.title}: ${t.sub}${list}\n\n${t.line}\n${t.question}${credit}\n\n${tags.join(' ')}`.slice(0, 2200);
}

// ---------------- render ----------------
const XFADES = ['fade', 'dissolve', 'smoothleft', 'smoothright', 'smoothup', 'slideleft', 'wipeleft', 'zoomin'];

async function download(url, file) {
  for (let k = 0; k < 4; k++) {
    let wait = 8000 * 2 ** k;
    try {
      await sleep(1200); // gentle pace towards the stock sites
      const r = await fetch(url, { headers: { 'User-Agent': 'RahulBlogsReels/1.0' } });
      if (r.status === 429) wait = Math.max(wait, 1000 * (parseInt(r.headers.get('retry-after') || '0', 10) || 0));
      if (r.status === 404) throw Object.assign(new Error('HTTP 404'), { final: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      if (fs.statSync(file).size > 30000) return;
      throw new Error('file too small');
    } catch (e) { log(`download retry ${new URL(url).host} (${e.message})`); if (e.final) break; await sleep(wait); }
  }
  throw new Error('download failed: ' + new URL(url).host);
}

async function render(reel, text, id) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
  const T = frames(rnd(0.25, 0.35)); // short, quick transitions like the reference
  const segs = [];
  for (const [i, c] of reel.shots.entries()) {
    const photo = c.type === 'photo';
    const raw = path.join(TMP, `raw${i}${photo ? '.jpg' : '.mp4'}`);
    try { await download(c.url, raw).catch((e) => { if (!c.alt) throw e; return download(c.alt, raw); }); } catch (e) {
      if (c.role === 'item' && reel.shots.filter((s) => s.role === 'item').length > 3) { log(`skipping ${c.page}: ${e.message}`); continue; }
      throw e;
    }
    // Unsplash asks apps to report each photo they use (API guideline)
    if (c.track && ENV.UNSPLASH_ACCESS_KEY) http(c.track, { headers: { Authorization: 'Client-ID ' + ENV.UNSPLASH_ACCESS_KEY } }).catch(() => {});
    const info = ffprobe(raw);
    const vs = info.streams.find((s) => s.codec_type === 'video') || {};
    const tooSmall = photo ? !photoHD(vs.width || 0, vs.height || 0) : Math.min(vs.width || 0, vs.height || 0) < MIN_RES;
    if (tooSmall) { // videos never below 720p, photos only HD, whatever the site claimed
      log(`skipping ${c.page}: only ${vs.width}x${vs.height}`); fs.rmSync(raw);
      if (c.role !== 'item') throw new Error('intro/outro clip is too small');
      continue;
    }
    const realDur = photo ? 99 : parseFloat(info.format.duration) || c.dur;
    const want = c.role === 'intro' ? rnd(3.0, 3.4) : c.role === 'outro' ? rnd(3.6, 4.0) : (reel.kind === 'list' ? rnd(2.3, 2.7) : rnd(2.6, 3.2));
    const d = frames(Math.min(realDur - 0.3, want));
    const ss = Math.max(0, rnd(0.3, Math.max(0.4, realDur - d - 0.4))).toFixed(2);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const zoom = rnd(1.05, 1.12).toFixed(3);
    const seg = path.join(TMP, `seg${i}.mp4`);
    // fill 9:16, slow pan across the frame, punchier colour; everything forced to bt709 so the joins never stall
    const look = `eq=saturation=${rnd(1.12, 1.25).toFixed(2)}:contrast=1.04,unsharp=5:5:0.4,fps=${FPS},format=yuv420p,` +
      `setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`;
    let vf, input;
    if (photo) {
      // photo -> moving shot: worked on at 2x size so the slow zoom + pan stays smooth (zoompan on small frames jitters)
      const nF = Math.round(d * FPS), z0 = Math.random() < 0.5 ? 1.0 : 1.12, z1 = z0 === 1.0 ? 1.12 : 1.0;
      vf = `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase:out_color_matrix=bt709,crop=${W * 2}:${H * 2},` +
        `zoompan=z='${z0}+${(z1 - z0).toFixed(2)}*on/${nF}':x='(iw-iw/zoom)*(0.5+${dir}*0.4*(on/${nF}-0.5))':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=${FPS},` + look;
      input = ['-loop', '1', '-framerate', String(FPS), '-i', raw];
    } else {
      vf = `scale=${W}*${zoom}:${H}*${zoom}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:x='(iw-${W})*(0.5+${dir}*0.45*(t/${d}-0.5))':y='(ih-${H})/2',` + look;
      input = ['-ss', ss, '-i', raw];
    }
    run('ffmpeg', ['-y', '-v', 'error', ...input, '-t', String(d), '-an', '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast',
      '-crf', '17', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', seg]);
    segs.push({ file: seg, d, c });
    fs.rmSync(raw);
  }
  // numbers stay 1..n even if a clip was skipped
  let n = 0;
  for (const s of segs) if (s.c.role === 'item' && reel.kind === 'list') s.c.num = ++n;
  reel.shots = segs.map((s) => s.c);
  if (reel.kind === 'list') reel.places = segs.filter((s) => s.c.role === 'item').map((s) => s.c.place);
  // timeline: segment i starts at sum(d<i) - i*T
  let acc = 0; const starts = [];
  for (const s of segs) { starts.push(acc); acc += s.d - T; }
  const total = frames(acc + T);

  // overlays drawn by Pillow (cards.py)
  const style = {
    title_y: pick([0.38, 0.42]), title_size: pick([180, 200]), sub_size: 60,
    grad: pick([[[255, 236, 64], [255, 170, 20]], [[255, 244, 120], [255, 196, 0]], [[255, 226, 90], [255, 140, 40]]]),
    item_y: pick([0.27, 0.31]), item_size: pick([84, 92]), pin_color: [230, 40, 40],
  };
  const b = (f) => path.join(ROOT, 'brand', f);
  const fonts = { title: b(pick(['Poppins-BlackItalic.ttf', 'Poppins-ExtraBoldItalic.ttf'])), sub: b('Poppins-SemiBold.ttf'), item: b('Poppins-Black.ttf') };
  const items = [], shows = [];
  const card = (kind, text, extra, a, bEnd) => {
    const png = path.join(TMP, `card${items.length}.png`);
    items.push({ kind, text, out: png, ...extra });
    shows.push({ png, a, b: bEnd });
  };
  segs.forEach((s, i) => {
    const a = starts[i], end = i + 1 < segs.length ? starts[i + 1] + T : total;
    if (s.c.role === 'intro') card('title', text.title, { sub: text.sub }, 0, end - 0.05); // visible from frame 0 = thumbnail
    else if (s.c.role === 'item') card('item', s.c.place.name, { num: reel.kind === 'list' ? s.c.num : null }, a + 0.1, end - 0.05);
    else {
      const mid = a + (end - a) * 0.5;
      card('end', reel.kind === 'list' ? 'More beautiful places' : `More of ${text.title}`, { pin: true }, a + 0.1, mid);
      card('end', 'Follow for more', { pin: false }, mid, total);
    }
  });
  const spec = path.join(TMP, 'cards.json');
  fs.writeFileSync(spec, JSON.stringify({ fonts, style, items }));
  run(PY, [path.join(ROOT, 'scripts', 'cards.py'), spec]);

  // music: a random copyright-free track, random start, faded
  const tracks = fs.readdirSync(path.join(ROOT, 'music')).filter((f) => /\.mp3$/i.test(f));
  const recentTracks = readJson('state/posts.json', []).slice(-3).map((p) => p.music);
  const fresh = tracks.filter((t) => !recentTracks.includes(t));
  const track = pick(fresh.length ? fresh : tracks);
  const mDur = parseFloat(ffprobe(path.join(ROOT, 'music', track)).format.duration);
  const mStart = Math.max(0, rnd(0, Math.min(40, mDur - total - 1))).toFixed(2);

  const args = ['-y', '-v', 'error'];
  segs.forEach((s) => args.push('-i', s.file));
  const logoIdx = segs.length, firstOv = logoIdx + 1;
  args.push('-loop', '1', '-i', path.join(ROOT, 'brand', 'logo.png'));
  shows.forEach((s) => args.push('-loop', '1', '-t', String(total), '-i', s.png));
  const musicIdx = firstOv + shows.length;
  args.push('-ss', mStart, '-i', path.join(ROOT, 'music', track));

  const fc = [];
  let last = '0:v';
  for (let i = 1; i < segs.length; i++) {
    fc.push(`[${last}][${i}:v]xfade=transition=${pick(XFADES)}:duration=${T}:offset=${starts[i].toFixed(3)}[x${i}]`);
    last = `x${i}`;
  }
  const logoW = 230; // brand/logo.png is the cropped Rahul Blogs logo (770x652)
  fc.push(`[${logoIdx}:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=0.95[logo]`);
  fc.push(`[${last}][logo]overlay=x=44:y=150:shortest=1[v0]`);
  shows.forEach((s, k) => {
    const f = 0.2;
    const fadeIn = s.a > 0 ? `fade=t=in:st=${s.a.toFixed(2)}:d=${f}:alpha=1,` : ''; // the title is fully there at frame 0
    const fadeOut = s.b < total - 0.05 ? `,fade=t=out:st=${(s.b - f).toFixed(2)}:d=${f}:alpha=1` : '';
    fc.push(`[${firstOv + k}:v]format=rgba,${fadeIn}null${fadeOut}[o${k}]`);
    fc.push(`[v${k}][o${k}]overlay=0:0:enable='between(t,${s.a.toFixed(2)},${s.b.toFixed(2)})'[v${k + 1}]`);
  });
  fc.push(`[v${shows.length}]format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[vout]`);
  fc.push(`[${musicIdx}:a]atrim=0:${total},asetpts=N/SR/TB,afade=t=in:st=0:d=0.3,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6,` +
    `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);
  const outFile = path.join(OUT, `${id}.mp4`);
  args.push('-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(total),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '9M', '-bufsize', '18M', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile + '.tmp.mp4');
  run('ffmpeg', args);
  fs.renameSync(outFile + '.tmp.mp4', outFile);
  // cover = the title frame (custom thumbnail on Facebook; Instagram uses thumb_offset 0)
  run('ffmpeg', ['-y', '-v', 'error', '-ss', '0.5', '-i', outFile, '-frames:v', '1', outFile.replace(/\.mp4$/, '_thumb.jpg')]);
  log(`rendered ${path.basename(outFile)}: ${total.toFixed(2)} s, ${segs.length} clips, music "${track}" from ${mStart} s`);
  return { file: outFile, total, track };
}

// ---------------- publish ----------------
async function rupload(url, file, tok) {
  const size = fs.statSync(file).size;
  // same bytes to the same upload id from offset 0, so a retry after a dropped connection is safe
  const r = await http(url, { method: 'POST', body: fs.readFileSync(file),
    headers: { Authorization: 'OAuth ' + tok, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' } }, 600000, { retry: true });
  if (!r.ok || !r.body.success) throw new Error('upload failed: ' + short(r.body));
}
async function fbReel(file, caption, title) {
  const tok = await pageToken(), page = ENV.FB_PAGE_ID;
  const st = await http(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: tok }) }, 60000, { retry: true });
  if (!st.body.video_id) throw new Error('FB reel start: ' + short(st.body));
  const vid = st.body.video_id;
  await rupload(`https://rupload.facebook.com/video-upload/v26.0/${vid}`, file, tok);
  const fin = await http(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'finish', video_id: vid, video_state: 'PUBLISHED', title, description: caption, access_token: tok }) }, 120000);
  // a dropped connection here may still have published: the status check below decides (no blind retry = no double post)
  if (fin.status !== 0 && (!fin.ok || !fin.body.success)) throw new Error('FB reel publish: ' + short(fin.body));
  let link = '';
  for (let k = 0; k < 40 && !link; k++) {
    await sleep(10000);
    const s = await http(`${GRAPH}/${vid}?fields=status,permalink_url&access_token=${encodeURIComponent(tok)}`);
    const v = s.body.status || {};
    if (v.video_status === 'error') throw new Error('FB processing: ' + short(v));
    if (v.publishing_phase?.status === 'complete' || v.video_status === 'ready') link = s.body.permalink_url ? `https://www.facebook.com${s.body.permalink_url.replace(/^https?:\/\/[^/]+/, '')}` : 'ok';
  }
  if (!link && fin.status === 0) throw new Error('FB reel publish: connection dropped and the reel never appeared');
  log('facebook reel: ' + (link || 'published, status not confirmed yet'));
  // custom cover = the title frame (best effort; the reel is already live)
  const thumb = file.replace(/\.mp4$/, '_thumb.jpg');
  if (fs.existsSync(thumb)) {
    const fd = new FormData();
    fd.append('source', new Blob([fs.readFileSync(thumb)], { type: 'image/jpeg' }), 'thumb.jpg');
    fd.append('is_preferred', 'true'); fd.append('access_token', tok);
    const th = await http(`${GRAPH}/${vid}/thumbnails`, { method: 'POST', body: fd }, 120000, { retry: true });
    log(th.ok ? 'facebook cover set' : 'facebook cover failed: ' + short(th.body));
  }
  return { id: vid, url: link };
}
async function fbStory(file) {
  const tok = await pageToken(), page = ENV.FB_PAGE_ID;
  const st = await http(`${GRAPH}/${page}/video_stories`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: tok }) }, 60000, { retry: true });
  if (!st.body.video_id) throw new Error('FB story start: ' + short(st.body));
  await rupload(st.body.upload_url || `https://rupload.facebook.com/video-upload/v26.0/${st.body.video_id}`, file, tok);
  const fin = await http(`${GRAPH}/${page}/video_stories`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'finish', video_id: st.body.video_id, access_token: tok }) }, 120000);
  if (!fin.ok || !fin.body.success) throw new Error('FB story publish: ' + short(fin.body));
  log('facebook story posted');
  return { id: fin.body.post_id || st.body.video_id };
}
async function igMedia(file, type, caption) {
  need('IG_USER_ID');
  const tok = await pageToken(), ig = ENV.IG_USER_ID;
  const body = { media_type: type, upload_type: 'resumable', access_token: tok };
  if (type === 'REELS') Object.assign(body, { caption, share_to_feed: true, thumb_offset: 500 }); // title card is on screen from frame 0
  // an extra unused container is harmless, so creating one may be retried
  const c = await http(`${GRAPH}/${ig}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 60000, { retry: true });
  if (!c.body.id) throw new Error(`IG ${type} container: ` + short(c.body));
  await rupload(`https://rupload.facebook.com/ig-api-upload/v26.0/${c.body.id}`, file, tok);
  let st = '';
  for (let k = 0; k < 40 && st !== 'FINISHED'; k++) {
    await sleep(12000);
    st = (await http(`${GRAPH}/${c.body.id}?fields=status_code&access_token=${encodeURIComponent(tok)}`)).body.status_code || '';
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error(`IG ${type} processing ${st}`);
  }
  if (st !== 'FINISHED') throw new Error(`IG ${type} processing not finished in 8 min`);
  const pub = await http(`${GRAPH}/${ig}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: c.body.id, access_token: tok }) }, 120000);
  if (!pub.body.id && pub.status === 0) {
    // connection dropped: if the container shows PUBLISHED it went out — take the newest media instead of posting again
    await sleep(15000);
    const s = (await http(`${GRAPH}/${c.body.id}?fields=status_code&access_token=${encodeURIComponent(tok)}`)).body.status_code;
    if (s === 'PUBLISHED') pub.body = { id: (await http(`${GRAPH}/${ig}/media?fields=id&limit=1&access_token=${encodeURIComponent(tok)}`)).body.data?.[0]?.id };
  }
  if (!pub.body.id) throw new Error(`IG ${type} publish: ` + short(pub.body));
  const pl = (await http(`${GRAPH}/${pub.body.id}?fields=permalink&access_token=${encodeURIComponent(tok)}`)).body.permalink || '';
  log(`instagram ${type.toLowerCase()} posted ${pl}`);
  return { id: pub.body.id, url: pl };
}

// ---------------- main ----------------
async function main() {
  const mode = process.argv[2] || 'all';
  const dry = on('DRY_RUN') || mode === 'make';
  const id = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const reel = await chooseReel();
  log(`reel ${id}: ${reel.kind} — ${reel.places.map((p) => p.name).join(', ')} (${reel.shots.length} clips)`);
  const text = await writeText(reel);
  log(`title: ${text.title} / ${text.sub}`);
  const r = await render(reel, text, id);
  const caption = postText(text, reel);
  fs.writeFileSync(r.file.replace(/\.mp4$/, '.txt'), caption);

  const rec = { id, date: new Date().toISOString(), places: reel.places.map((p) => p.name), hook: `${text.title} / ${text.sub}`,
    sub: text.sub, music: r.track, seconds: +r.total.toFixed(2), clips: reel.shots.map((c) => `${c.src} ${c.page}`), dry };
  if (!dry) {
    need('FB_PAGE_ID', 'META_SYSTEM_TOKEN');
    const title = `${text.title}: ${text.sub}`.slice(0, 100);
    const tries = { fb: () => fbReel(r.file, caption, title), ig: () => igMedia(r.file, 'REELS', caption),
      fbStory: () => fbStory(r.file), igStory: () => igMedia(r.file, 'STORIES') };
    if (!on('STORIES', true)) { delete tries.fbStory; delete tries.igStory; }
    if (!on('IG_ENABLED', true)) { delete tries.ig; delete tries.igStory; }
    for (const [k, f] of Object.entries(tries)) {
      // stories only follow a reel that really went out, so a failed run can be retried without double stories
      if (/Story/.test(k) && rec.fb?.error && (rec.ig?.error || !tries.ig)) { rec[k] = { error: 'skipped: no reel posted' }; continue; }
      try { rec[k] = await f(); } catch (e) { rec[k] = { error: e.message }; log(`${k} FAILED: ${e.message}`); }
      if (!rec[k].error) fs.writeFileSync(path.join(OUT, 'posted.flag'), k); // tells the workflow not to retry
    }
  }
  // remember what was posted so nothing repeats (dry runs leave the queue alone unless DRY_RUN_KEEP_QUEUE=false)
  if (!ENV.PLACE && !(dry && on('DRY_RUN_KEEP_QUEUE', true))) {
    const used = readJson('state/used_places.json', {});
    for (const p of reel.places) used[p.name] = { date: rec.date.slice(0, 10), status: dry ? 'dry run' : 'posted' };
    writeJson('state/used_places.json', used);
    const uc = readJson('state/used_clips.json', {});
    for (const c of reel.shots) uc[c.id] = rec.date.slice(0, 10);
    writeJson('state/used_clips.json', uc);
  }
  const posts = readJson('state/posts.json', []);
  posts.push(rec); writeJson('state/posts.json', posts.slice(-500));
  fs.appendFileSync(path.join(ROOT, 'CREDITS.md'), reel.shots.map((c) => `| ${id} | ${c.place.name} | ${c.src} (${c.user || ''}) | ${c.page} | ${c.src} Content License, commercial use, no attribution needed |\n`).join(''));
  if (!dry && rec.fb?.error && rec.ig?.error) throw new Error('both Facebook and Instagram reel posts failed');
  log('done');
}

main().catch((e) => { log('ERROR: ' + e.message); process.exit(1); });
