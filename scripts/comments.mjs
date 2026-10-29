// Replies to new comments on the latest reels (Facebook page + Instagram) in the commenter's own language.
// usage: node scripts/comments.mjs      (DRY_RUN=true only prints the replies)
import { ENV, on, log, sleep, graph, readJson, writeJson, aiJson, pageToken, short } from './lib.mjs';

const MAX_PER_RUN = parseInt(ENV.MAX_REPLIES_PER_RUN || '25', 10);

async function writeReply(comment, context) {
  const j = await aiJson(`You are Rahul from "Rahul Blogs", an Indian travel creator. Someone commented on your travel reel (${context}).
Comment: """${comment.slice(0, 600)}"""
Write a short, warm, human reply (1-2 sentences, max 1 emoji) in EXACTLY the same language AND script as the comment
(Hindi in Devanagari -> Devanagari, Hinglish in Roman letters -> Roman Hinglish, Tamil -> Tamil, Malayalam -> Malayalam, English -> English, etc.).
Answer travel questions briefly and correctly (best season, how to reach) if you are sure; never invent prices or exact timings; no links; no hashtags.
Set skip=true for spam, ads, links, abuse, hate, politics, or comments that need no reply (only a tag of a friend, only "." etc.).
Return JSON {"skip": boolean, "reply": "text"}`, { temperature: 0.7 });
  return j.skip ? null : String(j.reply || '').trim() || null;
}

async function main() {
  const dry = on('DRY_RUN');
  if (!on('COMMENT_REPLIES', true)) return log('comment replies are switched off');
  const replied = readJson('state/replied.json', {});
  const posts = readJson('state/posts.json', []).filter((p) => !p.dry).slice(-30);
  const pageId = ENV.FB_PAGE_ID, igId = ENV.IG_USER_ID;
  let count = 0;
  const tok = await pageToken();

  for (const p of posts.reverse()) {
    const context = `places: ${(p.places || []).join(', ')}`;
    // Facebook reel comments
    if (p.fb?.id) {
      const r = await graph(`${p.fb.id}/comments`, { fields: 'id,message,from{id},comment_count', filter: 'stream', limit: '50' }, 'GET', tok);
      if (!r.ok) log(`fb comments ${p.fb.id}: ${short(r.body)}`);
      for (const c of r.body.data || []) {
        if (count >= MAX_PER_RUN) break;
        if (replied[c.id] || c.from?.id === pageId || !c.message) continue;
        // skip threads we already answered (our reply is a child comment from the page)
        const kids = await graph(`${c.id}/comments`, { fields: 'from{id}', limit: '25' }, 'GET', tok);
        if ((kids.body.data || []).some((k) => k.from?.id === pageId)) { replied[c.id] = 'seen'; continue; }
        const reply = await writeReply(c.message, context).catch((e) => { log('AI: ' + e.message); return undefined; });
        if (reply === undefined) continue;
        if (reply && !dry) {
          const s = await graph(`${c.id}/comments`, { message: reply }, 'POST', tok);
          if (!s.ok) { log(`fb reply failed: ${short(s.body)}`); continue; }
        }
        log(`fb ${dry ? '(dry) ' : ''}reply to "${c.message.slice(0, 60)}": ${reply || '(skipped)'}`);
        replied[c.id] = reply ? 'replied' : 'skipped'; count++;
        await sleep(2500);
      }
    }
    // Instagram reel comments
    if (p.ig?.id && igId) {
      const r = await graph(`${p.ig.id}/comments`, { fields: 'id,text,username,replies{username}', limit: '50' }, 'GET', tok);
      if (!r.ok) log(`ig comments ${p.ig.id}: ${short(r.body)}`);
      const me = (ENV.IG_USERNAME || '').toLowerCase();
      for (const c of r.body.data || []) {
        if (count >= MAX_PER_RUN) break;
        if (replied[c.id] || !c.text || (me && c.username?.toLowerCase() === me)) continue;
        if (me && (c.replies?.data || []).some((k) => k.username?.toLowerCase() === me)) { replied[c.id] = 'seen'; continue; }
        const reply = await writeReply(c.text, context).catch((e) => { log('AI: ' + e.message); return undefined; });
        if (reply === undefined) continue;
        if (reply && !dry) {
          const s = await graph(`${c.id}/replies`, { message: reply }, 'POST', tok);
          if (!s.ok) { log(`ig reply failed: ${short(s.body)}`); continue; }
        }
        log(`ig ${dry ? '(dry) ' : ''}reply to "${c.text.slice(0, 60)}": ${reply || '(skipped)'}`);
        replied[c.id] = reply ? 'replied' : 'skipped'; count++;
        await sleep(2500);
      }
    }
  }
  if (!dry) {
    const keys = Object.keys(replied);
    writeJson('state/replied.json', Object.fromEntries(keys.slice(-5000).map((k) => [k, replied[k]])));
  }
  log(`comments done: ${count} handled`);
}

main().catch((e) => { log('ERROR: ' + e.message); process.exit(1); });
