// Rahul Blogs travel reel: pick the next place -> real free stock (Pixabay videos + photos, Mixkit) -> FFmpeg reel with
// hook text, place labels, logo and copyright-free music -> Facebook + Instagram reel and story.
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

// ---------------- stock footage (free: Pixabay + Mixkit licences, no attribution needed) ----------------
async function pixabay(q) {
  if (!ENV.PIXABAY_API_KEY) return [];
  const r = await http(`https://pixabay.com/api/videos/?key=${ENV.PIXABAY_API_KEY}&q=${encodeURIComponent(q)}&per_page=60&safesearch=true`);
  if (!r.ok) { log(`pixabay ${r.status}`); return []; }
  return (r.body.hits || []).map((h) => {
    const v = h.videos.large?.url ? h.videos.large : h.videos.medium;
    return { id: 'pxb' + h.id, src: 'Pixabay', page: h.pageURL, text: `${h.tags} ${h.pageURL}`.toLowerCase(), thumb: v.thumbnail,
      url: v.url, w: v.width, h: v.height, dur: h.duration, user: h.user, pop: Math.log10(1 + (h.likes || 0) * 20 + (h.downloads || 0)) };
  }).filter((c) => c.url && c.dur >= 4);
}
// Mixkit (Mixkit Stock Video Free License: commercial use, no attribution); no API, so its search page is read
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
      thumb: `https://assets.mixkit.co/videos/${id}/${id}-thumb-360-0.jpg`, w: 1920, h: 1080, dur: 8, pop: 2.5 });
  }
  return out;
}
// real photos (Pixabay) get a slow camera move; used when a place has too few video clips
async function pixabayPhotos(q) {
  if (!ENV.PIXABAY_API_KEY) return [];
  const r = await http(`https://pixabay.com/api/?key=${ENV.PIXABAY_API_KEY}&q=${encodeURIComponent(q)}&image_type=photo&per_page=80&safesearch=true&min_width=1200`);
  if (!r.ok) { log(`pixabay photos ${r.status}`); return []; }
  return (r.body.hits || []).map((h) => ({ id: 'pxp' + h.id, type: 'photo', src: 'Pixabay', page: h.pageURL, user: h.user,
    text: `${h.tags} ${h.pageURL}`.toLowerCase(), url: h.largeImageURL, thumb: h.previewURL, w: h.imageWidth, h: h.imageHeight,
    dur: 99, pop: Math.log10(1 + (h.likes || 0) * 20 + (h.downloads || 0)) - 0.8 }));
}

// only clips whose tags/page name really mention the place (stock tags are often wrong for real places)
async function clipsFor(place, usedClips, photos = true) {
  const kws = keyWords(place.name);
  let all = [...await pixabay(place.name), ...await mixkit(place.name)];
  // fewer than 6 matching videos -> real photos fill the gap
  if (photos && all.filter((c) => kws.every((k) => c.text.includes(k))).length < 6) all = all.concat(await pixabayPhotos(place.name));
  const ok = all.filter((c) => !usedClips[c.id] && kws.length && kws.every((k) => c.text.includes(k)) &&
    !/\b(people|man|woman|girl|boy|model|selfie|portrait|dance|wedding|ship|port|traffic|construction|farm|food|cooking|interior|office)\b/.test(c.text));
  // most scenic + most liked first, a little randomness so reels differ
  const score = (c) => (c.text.match(SCENIC) || []).length * 1.2 + (c.pop ?? 2.5) + (c.h > c.w ? 1 : 0) + Math.random() +
    (c.type === 'photo' ? 0 : 2); // video beats photo when both fit
  const ranked = ok.map((c) => ({ ...c, score: score(c) })).sort((a, b) => b.score - a.score);
  return verifyClips(place, ranked);
}

// stock tags are often wrong ("munnar" on a river with boats), so Gemini looks at each clip's thumbnail:
// does it plausibly show this place, and is it scenic? Verdicts are cached; at most VISION_BUDGET checks per run.
let visionLeft = parseInt(ENV.VISION_BUDGET || '40', 10);
async function verifyClips(place, clips, max = 7) {
  if (!ENV.GEMINI_API_KEY || on('SKIP_VISION')) return clips;
  const cache = readJson('state/clip_checks.json', {});
  const out = [];
  for (const c of clips) {
    if (out.length >= max) break;
    const key = `${c.id}|${place.name}`;
    if (!cache[key] && c.thumb && visionLeft > 0) {
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
            { text: `This is ${c.type === 'photo' ? 'a stock photo' : 'a frame of a stock video'} tagged "${place.name}"${place.area ? ` (${place.area})` : ''}. ` +
              'Could it really show that place (landscape, landmarks, vegetation, climate all plausible)? Is it a beautiful travel shot? ' +
              'Return JSON {"plausible": true/false, "scenic": 1-10, "has_text_or_watermark": true/false}' }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
        }, 60000);
        if (r.ok || ![429, 500, 503, 0].includes(r.status)) break; // busy -> next model
        }
        if (!r.ok) throw new Error(`gemini HTTP ${r.status} ${short(r.body).slice(0, 120)}`);
        const j = JSON.parse(r.body.candidates[0].content.parts.map((p) => p.text || '').join(''));
        await sleep(1500); // stay under the free per-minute limit
        cache[key] = { ok: !!j.plausible && !j.has_text_or_watermark && (j.scenic || 0) >= 6, s: j.scenic || 0 };
      } catch (e) { log(`vision check failed (${e.message}), keeping clip`); cache[key] = null; }
    }
    if (cache[key] === undefined || cache[key] === null || cache[key].ok) out.push(c);
    else log(`  dropped ${c.page} (${cache[key].s}/10 or not ${place.name})`);
  }
  if (!on('DRY_RUN')) writeJson('state/clip_checks.json', cache);
  return out;
}
const SCENIC = /\b(nature|landscape|aerial|drone|waterfall|mountains?|beach|sunset|sunrise|lake|river|sea|ocean|hills?|tea|backwaters?|boat|houseboat|forest|clouds|mist|fog|valley|palm|island|temple|fort|palace|snow|green|scenic|coast|waves|lagoon|garden)\b/g;

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

  // go state by state (in list order): one place with >= 4 clips -> its own reel; else up to 5 places of that state
  for (let a = 0; a < 6 && free.length; a++) {
    const area = free[0].area;
    const group = free.filter((p) => p.area === area).slice(0, 12);
    const found = [];
    for (const p of group) {
      const c = await clipsFor(p, usedClips);
      log(`${p.name}: ${c.length} matching clips`);
      if (c.length >= 4) { save(); return { kind: 'single', places: [p], shots: c.slice(0, 7).map((x) => ({ ...x, place: p })) }; }
      if (c.length) found.push([p, c]); else noFootage(p);
      if (found.length >= 5) break;
    }
    const shots = found.flatMap(([p, c]) => c.slice(0, 3).map((x) => ({ ...x, place: p })));
    if (found.length >= 2 && shots.length >= 4) { save(); return { kind: 'list', places: found.map(([p]) => p), shots: shots.slice(0, 8) }; }
    // not enough in this state: try a state reel, else move on to the next state
    const region = { name: area, area: '', section: 'region', india: group[0].india };
    const rc = (await clipsFor(region, usedClips)).filter((c) => !shots.some((s) => s.id === c.id));
    log(`region ${area}: ${rc.length} matching clips`);
    if (shots.length + rc.length >= 4) {
      save();
      const mix = [...shots, ...rc.slice(0, Math.max(0, 6 - shots.length)).map((x) => ({ ...x, place: region }))];
      return { kind: shots.length ? 'list' : 'region', places: [...found.map(([p]) => p), ...(rc.length ? [region] : [])], shots: mix };
    }
    for (const [p] of found) noFootage(p);
    for (const p of group) free.splice(free.indexOf(p), 1);
  }
  save();
  // last resort: a reel of one state/country with clips tagged with its name (only the region is labelled)
  for (const area of [...new Set(free.map((p) => p.area))].slice(0, 6)) {
    const region = { name: area, area: '', section: 'region', india: allPlaces().some((p) => p.area === area && p.india) };
    const clips = await clipsFor(region, usedClips);
    log(`region ${area}: ${clips.length} matching clips`);
    if (clips.length >= 4) return { kind: 'region', places: [region], shots: clips.slice(0, 7).map((c) => ({ ...c, place: region })) };
  }
  throw new Error('no place with enough free stock footage found in this run');
}

// ---------------- words ----------------
async function writeText(reel) {
  const recent = readJson('state/posts.json', []).slice(-12).map((p) => p.hook).filter(Boolean);
  const names = reel.places.map((p) => (p.area ? `${p.name} (${p.area})` : p.name)).join(', ');
  const prompt = `You write for "Rahul Blogs", an Indian travel creator's Facebook/Instagram reels (scenic clips + music, no voice).
Reel type: ${{ single: 'one place', list: 'several places in the same region', region: 'scenes from one state/country' }[reel.kind]}: ${names}.
Write in natural, human, English (simple words, like a real traveller wrote it; no clichÃ©s like "hidden gem", "breathtaking", "nestled").
Don't repeat the structure of these recent hooks: ${JSON.stringify(recent)}.
Return JSON:
{"hook": "on-screen line shown in the first 2 seconds, max 42 characters, curiosity or feeling, no emoji, no hashtags",
 "caption": "2-3 short lines: one line about the place(s) with 1 true, specific fact (season or best time, what it is famous for), then a question that invites comments; 1-2 emoji allowed",
 "hashtags": ["8 to 10 relevant hashtags without #, English letters only, mix of place names and travel tags"]}`;
  try {
    const j = await aiJson(prompt);
    const hook = String(j.hook || '').replace(/[\p{Extended_Pictographic}ï¸#]/gu, '').trim();
    if (hook.length < 8 || hook.length > 60) throw new Error('bad hook length');
    return { hook, caption: String(j.caption || '').trim(), hashtags: (j.hashtags || []).map((h) => String(h).replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean) };
  } catch (e) {
    log('AI text failed, using a template: ' + e.message);
    const p = reel.places[0];
    const hooks = reel.kind === 'single'
      ? [`${p.name} doesn't feel real`, `Save this for your ${p.area} trip`, `Have you been to ${p.name}?`, `This is ${p.name}, ${p.area}`]
      : [`${reel.places.length} places in ${p.area} you'll love`, `${p.area} is unreal`, `Your next ${p.area} trip`];
    return { hook: pick(hooks), caption: `${reel.places.map((x) => x.name).join(' â€¢ ')}\nWhich one would you visit first? ðŸ‘‡`,
      hashtags: [...reel.places.map((x) => x.name.replace(/\W/g, '')), p.area.replace(/\W/g, ''), 'travel', 'travelreels'] };
  }
}
function postText(t, reel) {
  const fixed = (ENV.FIXED_HASHTAGS || 'travel reels explore travelgram wanderlust').split(/[\s,#]+/).filter(Boolean);
  if (reel.places.some((p) => p.india)) fixed.push('incredibleindia');
  const tags = [...new Set([...t.hashtags, ...fixed].map((h) => h.toLowerCase()))].slice(0, 15).map((h) => '#' + h);
  return `${t.hook}\n\n${t.caption}\n\n${tags.join(' ')}`.slice(0, 2200);
}

// ---------------- render ----------------
const XFADES = ['fade', 'dissolve', 'smoothleft', 'smoothright', 'smoothup', 'circleopen', 'slideleft', 'wipeleft', 'zoomin', 'fadeblack'];

async function download(url, file) {
  for (let k = 0; k < 4; k++) {
    let wait = 8000 * 2 ** k;
    try {
      await sleep(1200); // gentle pace towards the stock sites
      const r = await fetch(url, { headers: { 'User-Agent': 'RahulBlogsReels/1.0' } });
      if (r.status === 429) wait = Math.max(wait, 1000 * (parseInt(r.headers.get('retry-after') || '0', 10) || 0));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
      if (fs.statSync(file).size > 30000) return;
      throw new Error('file too small');
    } catch (e) { log(`download retry ${new URL(url).host} (${e.message})`); await sleep(wait); }
  }
  throw new Error('download failed: ' + new URL(url).host);
}

async function render(reel, text, id) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
  const T = frames(rnd(0.3, 0.5)); // transition length varies per reel
  const segs = [];
  for (const [i, c] of reel.shots.entries()) {
    const raw = path.join(TMP, `raw${i}${c.type === 'photo' ? '.jpg' : '.mp4'}`);
    await download(c.url, raw).catch(async (e) => { if (!c.alt) throw e; await download(c.alt, raw); });
    const realDur = c.type === 'photo' ? 99 : parseFloat(ffprobe(raw).format.duration) || c.dur;
    // ~14-18 s per reel: fewer clips -> each clip stays longer (max ~4.3 s)
    const base = Math.min(4.3, Math.max(2.4, rnd(14, 18) / reel.shots.length + T));
    const d = frames(Math.min(realDur - 0.3, i === 0 ? Math.max(base, rnd(2.8, 3.3)) : base * rnd(0.85, 1.15)));
    const ss = Math.max(0, rnd(0.3, Math.max(0.4, realDur - d - 0.4))).toFixed(2);
    const dir = Math.random() < 0.5 ? -1 : 1;
    const zoom = rnd(1.06, 1.14).toFixed(3);
    const seg = path.join(TMP, `seg${i}.mp4`);
    // fill 9:16, slow pan across the frame, punchier colour; everything forced to bt709 so the joins never stall
    const look = `eq=saturation=${rnd(1.12, 1.25).toFixed(2)}:contrast=1.04,unsharp=5:5:0.4,fps=${FPS},format=yuv420p,` +
      `setsar=1,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv`;
    let vf, input;
    if (c.type === 'photo') {
      // photo: upscaled 2x so the slow zoom/pan stays smooth (zoompan on a small image jitters)
      const n = Math.round(d * FPS), z0 = Math.random() < 0.5 ? 1.0 : 1.12, z1 = z0 === 1.0 ? 1.12 : 1.0;
      vf = `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase:out_color_matrix=bt709,crop=${W * 2}:${H * 2},` +
        `zoompan=z='${z0}+${(z1 - z0).toFixed(2)}*on/${n}':x='(iw-iw/zoom)*(0.5+${dir}*0.4*(on/${n}-0.5))':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=${FPS},` + look;
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
  // timeline: segment i starts at sum(d<i) - i*T
  let acc = 0; const starts = [];
  for (const s of segs) { starts.push(acc); acc += s.d - T; }
  const total = frames(acc + T);

  // overlays drawn by Pillow
  const style = {
    hook_y: pick([0.28, 0.33, 0.42]), hook_size: pick([86, 92, 98]), hook_box: Math.random() < 0.4,
    hook_stroke: Math.random() < 0.3 ? 4 : 0, hook_color: pick([[255, 255, 255], [255, 255, 255], [255, 236, 170]]),
    label_y: pick([0.5, 0.56, 0.62]), label_size: pick([84, 92]), pin_color: pick([[234, 67, 53], [255, 82, 82], [255, 193, 7]]),
  };
  const fonts = path.join(ROOT, 'brand');
  const items = [{ kind: 'hook', text: text.hook, out: path.join(TMP, 'hook.png') }];
  const shows = [{ png: path.join(TMP, 'hook.png'), a: 0.15, b: Math.min(starts[1] ?? total, 2.9) }];
  const sub = (p) => (p.india ? (p.area ? `${p.area}, India` : 'India') : p.area);
  if (reel.kind !== 'list') {
    const p = reel.places[0];
    items.push({ kind: 'place', text: p.name, sub: sub(p), out: path.join(TMP, 'place0.png') });
    shows.push({ png: path.join(TMP, 'place0.png'), a: starts[1] + 0.25, b: starts[1] + segs[1].d - T - 0.1 });
    const last = segs.length - 1;
    shows.push({ png: path.join(TMP, 'place0.png'), a: starts[last] + 0.25, b: total - 0.3 });
  } else {
    // the hook is short here; the first clip's place is labelled after it if the next clip is somewhere else
    if (segs[1].c.place !== segs[0].c.place) {
      shows[0].b = Math.min(shows[0].b, 2.0);
      const png = path.join(TMP, 'placeF.png');
      items.push({ kind: 'place', text: segs[0].c.place.name, sub: sub(segs[0].c.place), out: png });
      shows.push({ png, a: 2.1, b: Math.max(2.8, starts[1] + T - 0.05) });
    }
    // one label spans a run of clips of the same place
    for (let i = 1, n = 0; i < segs.length; n++) {
      let j = i;
      while (j + 1 < segs.length && segs[j + 1].c.place === segs[i].c.place) j++;
      const png = path.join(TMP, `place${n}.png`);
      items.push({ kind: 'place', text: segs[i].c.place.name, sub: sub(segs[i].c.place), out: png });
      shows.push({ png, a: starts[i] + 0.2, b: Math.min(total - 0.2, starts[j] + segs[j].d - T - 0.1) });
      i = j + 1;
    }
  }
  const spec = path.join(TMP, 'cards.json');
  const bold = pick(['Poppins-Bold.ttf', 'Poppins-ExtraBold.ttf']);
  fs.writeFileSync(spec, JSON.stringify({ font: path.join(fonts, bold), font2: path.join(fonts, 'Poppins-SemiBold.ttf'), style, items }));
  run(PY, [path.join(ROOT, 'scripts', 'cards.py'), spec]);

  // music: a random copyright-free track, random start, faded
  const tracks = fs.readdirSync(path.join(ROOT, 'music')).filter((f) => /\.mp3$/i.test(f));
  const recentTracks = readJson('state/posts.json', []).slice(-3).map((p) => p.music);
  const track = pick(tracks.filter((t) => !recentTracks.includes(t)).length ? tracks.filter((t) => !recentTracks.includes(t)) : tracks);
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
    const off = (starts[i]).toFixed(3);
    fc.push(`[${last}][${i}:v]xfade=transition=${pick(XFADES)}:duration=${T}:offset=${off}[x${i}]`);
    last = `x${i}`;
  }
  const logoW = 230; // brand/logo.png is the cropped Rahul Blogs logo (770x652)
  fc.push(`[${logoIdx}:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=0.95[logo]`);
  fc.push(`[${last}][logo]overlay=x=44:y=150:shortest=1[v0]`);
  shows.forEach((s, k) => {
    const f = 0.3;
    fc.push(`[${firstOv + k}:v]format=rgba,fade=t=in:st=${s.a.toFixed(2)}:d=${f}:alpha=1,fade=t=out:st=${(s.b - f).toFixed(2)}:d=${f}:alpha=1[o${k}]`);
    fc.push(`[v${k}][o${k}]overlay=0:0:enable='between(t,${s.a.toFixed(2)},${s.b.toFixed(2)})'[v${k + 1}]`);
  });
  fc.push(`[v${shows.length}]format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv[vout]`);
  fc.push(`[${musicIdx}:a]atrim=0:${total},asetpts=N/SR/TB,afade=t=in:st=0:d=0.4,afade=t=out:st=${(total - 1.6).toFixed(2)}:d=1.6,` +
    `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]`);
  const outFile = path.join(OUT, `${id}.mp4`);
  args.push('-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aout]', '-t', String(total),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-maxrate', '9M', '-bufsize', '18M', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-r', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outFile + '.tmp.mp4');
  run('ffmpeg', args);
  fs.renameSync(outFile + '.tmp.mp4', outFile);
  log(`rendered ${path.basename(outFile)}: ${total.toFixed(2)} s, ${segs.length} clips, music "${track}" from ${mStart} s`);
  return { file: outFile, total, track };
}

// ---------------- publish ----------------
async function rupload(url, file, tok) {
  const size = fs.statSync(file).size;
  const r = await http(url, { method: 'POST', body: fs.readFileSync(file),
    headers: { Authorization: 'OAuth ' + tok, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' } }, 600000);
  if (!r.ok || !r.body.success) throw new Error('upload failed: ' + short(r.body));
}
async function fbReel(file, caption, title) {
  const tok = await pageToken(), page = ENV.FB_PAGE_ID;
  const st = await http(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: tok }) });
  if (!st.body.video_id) throw new Error('FB reel start: ' + short(st.body));
  const vid = st.body.video_id;
  await rupload(`https://rupload.facebook.com/video-upload/v26.0/${vid}`, file, tok);
  const fin = await http(`${GRAPH}/${page}/video_reels`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'finish', video_id: vid, video_state: 'PUBLISHED', title, description: caption, access_token: tok }) }, 120000);
  if (!fin.ok || !fin.body.success) throw new Error('FB reel publish: ' + short(fin.body));
  let link = '';
  for (let k = 0; k < 40 && !link; k++) {
    await sleep(10000);
    const s = await http(`${GRAPH}/${vid}?fields=status,permalink_url&access_token=${encodeURIComponent(tok)}`);
    const v = s.body.status || {};
    if (v.video_status === 'error') throw new Error('FB processing: ' + short(v));
    if (v.publishing_phase?.status === 'complete' || v.video_status === 'ready') link = s.body.permalink_url ? `https://www.facebook.com${s.body.permalink_url.replace(/^https?:\/\/[^/]+/, '')}` : 'ok';
  }
  log('facebook reel: ' + (link || 'published, status not confirmed yet'));
  return { id: vid, url: link };
}
async function fbStory(file) {
  const tok = await pageToken(), page = ENV.FB_PAGE_ID;
  const st = await http(`${GRAPH}/${page}/video_stories`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_phase: 'start', access_token: tok }) });
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
  if (type === 'REELS') Object.assign(body, { caption, share_to_feed: true, thumb_offset: 500 });
  const c = await http(`${GRAPH}/${ig}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  log(`reel ${id}: ${reel.kind} â€” ${reel.places.map((p) => p.name).join(', ')} (${reel.shots.length} clips)`);
  const text = await writeText(reel);
  log(`hook: ${text.hook}`);
  const r = await render(reel, text, id);
  const caption = postText(text, reel);
  fs.writeFileSync(r.file.replace(/\.mp4$/, '.txt'), caption);

  const rec = { id, date: new Date().toISOString(), places: reel.places.map((p) => p.name), hook: text.hook, music: r.track,
    seconds: +r.total.toFixed(2), clips: reel.shots.map((c) => `${c.src} ${c.page}`), dry };
  if (!dry) {
    need('FB_PAGE_ID', 'META_SYSTEM_TOKEN');
    const title = text.hook.slice(0, 100);
    const tries = { fb: () => fbReel(r.file, caption, title), ig: () => igMedia(r.file, 'REELS', caption),
      fbStory: () => fbStory(r.file), igStory: () => igMedia(r.file, 'STORIES') };
    if (!on('STORIES', true)) { delete tries.fbStory; delete tries.igStory; }
    if (!on('IG_ENABLED', true)) { delete tries.ig; delete tries.igStory; }
    for (const [k, f] of Object.entries(tries)) {
      try { rec[k] = await f(); } catch (e) { rec[k] = { error: e.message }; log(`${k} FAILED: ${e.message}`); }
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
