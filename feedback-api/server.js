// Frontier Tavern feedback ingestion service.
// Zero-dependency Node 20+. Receives player reports from the game client,
// validates + sanitizes them, commits screenshots to the private triage repo,
// and opens one GitHub issue per report (the issue body is the developer
// brief). The client report ID is the idempotency key: retries never create
// duplicates. The game client holds NO credentials — only this service talks
// to GitHub, with a fine-grained PAT scoped to the feedback repo.
//
// Env:
//   FEEDBACK_GITHUB_TOKEN  fine-grained PAT: contents+issues RW on the repo below
//   FEEDBACK_REPO          default "Luminary-Analytics/frontier-tavern-feedback"
//   PORT                   provided by Render

'use strict';

const http = require('http');

const REPO = process.env.FEEDBACK_REPO || 'Luminary-Analytics/frontier-tavern-feedback';
const TOKEN = process.env.FEEDBACK_GITHUB_TOKEN || '';
const PORT = process.env.PORT || 10000;

const MAX_BODY = 3 * 1024 * 1024;      // 3 MB total request
const MAX_SHOT = 900 * 1024;           // 900 KB per screenshot (base64 pre-decode)
const MAX_SHOTS = 3;
const MAX_TEXT = 4000;                 // per text field
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const RATE_MAX = 8;                    // reports per window per IP

const VALID_TYPES = new Set(['bug', 'enhancement', 'feedback']);
const VALID_IMPACT = new Set(['blocking', 'major', 'moderate', 'minor', 'cosmetic', '']);

const rate = new Map(); // ip -> [timestamps]
const seen = new Map(); // clientReportId -> issue url (per-process cache)

function clip(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  return s.length > n ? s.slice(0, n) + '\u2026' : s;
}

// escape player text so it can never smuggle markdown/html into the brief
function quoteBlock(s) {
  if (!s) return '_（not provided）_'.replace(/（|）/g, m => m === '（' ? '(' : ')');
  return '> ' + clip(s, MAX_TEXT).replace(/`/g, "'").replace(/\r?\n/g, '\n> ');
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (rate.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX) { rate.set(ip, list); return true; }
  list.push(now);
  rate.set(ip, list);
  return false;
}

async function gh(path, method, body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'frontier-tavern-feedback-api',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    const t = await res.text();
    throw new Error('github ' + method + ' ' + path + ' -> ' + res.status + ' ' + t.slice(0, 300));
  }
  return res.status === 404 ? null : res.json();
}

async function findExisting(clientReportId) {
  if (seen.has(clientReportId)) return seen.get(clientReportId);
  const q = encodeURIComponent(`repo:${REPO} in:body "${clientReportId}"`);
  try {
    const r = await gh('/search/issues?q=' + q, 'GET');
    // hyphen tokenisation again: taking items[0] blindly would treat an
    // unrelated report as a duplicate and silently DROP a real one
    if (r && Array.isArray(r.items))
      for (const it of r.items)
        if (typeof it.body === 'string' && it.body.includes(clientReportId))
          return it.html_url;
  } catch { /* search is best-effort; the per-process cache still guards */ }
  return null;
}


// ── the reply loop ───────────────────────────────────────────────────────
// Triage can ask a reporter for more detail without knowing who they are.
// A developer comment marked [[ASK]] becomes a question the GAME shows to
// whoever filed that report; their answer comes back as a [[REPLY]] comment
// on the same issue. Identity never leaves the player's machine: the client
// simply asks "any questions for THESE report ids?", which are ids it
// generated itself.
const ASK = '[[ASK]]';
const REPLY = '[[REPLY]]';

const issueCache = new Map(); // clientReportId -> {number, title}

// The client already knows its issue number (the server returned FT-000129
// when the report was filed), so look the issue up DIRECTLY. GitHub's search
// API is both rate-limited to 30/min and hyphen-tokenised, which made a UUID
// query match every report in the repo — exactly the wrong tool here. The
// clientReportId is still required and must appear in the issue body, so a
// caller can't read questions off an issue that isn't theirs.
async function issueFor(reportId, clientReportId) {
  const m = /^FT-0*(\d+)$/.exec(String(reportId || '').trim());
  if (!m) return null;
  const key = m[1] + '|' + clientReportId;
  if (issueCache.has(key)) return issueCache.get(key);
  const issue = await gh(`/repos/${REPO}/issues/${m[1]}`, 'GET');
  if (!issue || typeof issue.body !== 'string') return null;
  if (!issue.body.includes(clientReportId)) return null;   // not the caller's
  const hit = { number: issue.number, title: issue.title };
  issueCache.set(key, hit);
  return hit;
}

// The newest [[ASK]] counts as pending only while no [[REPLY]] follows it.
async function pendingQuestion(reportId, clientReportId) {
  const hit = await issueFor(reportId, clientReportId);
  if (!hit) return null;
  const comments = await gh(`/repos/${REPO}/issues/${hit.number}/comments?per_page=100`, 'GET');
  if (!Array.isArray(comments)) return null;
  let ask = null, askAt = 0, replyAt = 0;
  for (const c of comments) {
    const body = (c && c.body) || '';
    const at = Date.parse(c.created_at || '') || 0;
    if (body.includes(ASK) && at >= askAt) {
      askAt = at;
      ask = body.slice(body.indexOf(ASK) + ASK.length).trim();
    }
    if (body.includes(REPLY) && at > replyAt) replyAt = at;
  }
  if (!ask || replyAt > askAt) return null;
  return {
    clientReportId,
    reportId: 'FT-' + String(hit.number).padStart(6, '0'),
    title: clip(hit.title, 120),
    question: clip(ask, 700),
    askedAt: new Date(askAt).toISOString(),
  };
}

function brief(r, shotUrls) {
  const rep = r.report || {};
  const b = r.build || {}, s = r.session || {}, w = r.world || {}, t = r.target || {};
  const perf = r.performance || {}, scan = r.placementScan || {};
  const lines = [];
  lines.push('## FRONTIER TAVERN PLAYER REPORT');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Client report ID | \`${clip(r.clientReportId, 64)}\` |`);
  lines.push(`| Type / Category | ${clip(rep.type, 24)} / ${clip(rep.category, 40)} |`);
  lines.push(`| Player impact | ${clip(rep.playerImpact, 24) || 'n/a'} |`);
  lines.push(`| Build | ${clip(b.gameVersion, 24)} (${clip(b.channel, 24) || 'unknown channel'}) |`);
  lines.push(`| Scene / Day / Time | ${clip(w.scene, 40)} / day ${s.gameDay ?? '?'} / ${clip(s.gameTime, 12)} |`);
  lines.push(`| Player position | ${JSON.stringify(w.playerPosition || null)} |`);
  lines.push(`| Session | ${clip(s.sessionId, 40)} (${s.sessionDurationSeconds ?? '?'}s in) |`);
  lines.push('');
  lines.push('### OBSERVED (player text)');
  lines.push(quoteBlock(rep.description));
  lines.push('');
  lines.push('### EXPECTED (player text)');
  lines.push(quoteBlock(rep.expectedBehavior));
  lines.push('');
  lines.push('### STEPS (player text)');
  lines.push(quoteBlock(rep.reproductionSteps));
  lines.push('');
  lines.push('### AUTOMATIC CONTEXT (captured by the game)');
  lines.push('- Held item: ' + clip((r.gameplayState || {}).heldItem, 60));
  lines.push('- Target: ' + (t.identified
    ? `${clip(t.displayName, 60)} — \`${clip(t.hierarchyPath, 160)}\` (prefab \`${clip(t.prefabId, 60)}\`, ${t.hitDistance ?? '?'}m)`
    : 'no specific object identified'));
  lines.push('- Camera dir: ' + JSON.stringify(w.cameraDirection || null));
  lines.push('- FPS now/avg: ' + (perf.currentFps ?? '?') + '/' + (perf.averageFps ?? '?') +
             ' @ ' + clip(perf.resolution, 20));
  if (scan && scan.included) {
    lines.push('');
    lines.push('### PLACEMENT SCAN (captured by the game)');
    lines.push('- Status: ' + clip(scan.status, 40));
    lines.push('- Support: ' + clip(scan.expectedSupport, 60) +
               ' | gap: ' + (scan.supportGapMeters ?? 'n/a') + 'm');
  }
  const trail = Array.isArray(r.eventTrail) ? r.eventTrail.slice(-40) : [];
  if (trail.length) {
    lines.push('');
    lines.push('### RECENT EVENT TRAIL (captured by the game)');
    lines.push('```');
    for (const e of trail) lines.push(clip(String(e), 220));
    lines.push('```');
  }
  const logs = Array.isArray(r.recentErrors) ? r.recentErrors.slice(-20) : [];
  if (logs.length) {
    lines.push('');
    lines.push('### RECENT WARNINGS/ERRORS (captured by the game)');
    lines.push('```');
    for (const e of logs) lines.push(clip(String(e), 400));
    lines.push('```');
  }
  if (shotUrls.length) {
    lines.push('');
    lines.push('### SCREENSHOTS');
    shotUrls.forEach((u, i) => lines.push(`![screenshot-${i + 1}](${u})`));
  }
  lines.push('');
  lines.push('---');
  lines.push('_Triage: set labels for status/priority. Player impact never sets internal priority automatically. Promote via **Transfer issue** to the main repo after acceptance; this original stays immutable._');
  return lines.join('\n');
}

async function fileReport(r, ip) {
  const id = r.clientReportId;
  const existing = await findExisting(id);
  if (existing) return { duplicate: true, url: existing };

  // screenshots -> repo contents
  const shotUrls = [];
  const shots = Array.isArray(r.attachments) ? r.attachments.slice(0, MAX_SHOTS) : [];
  for (let i = 0; i < shots.length; i++) {
    const a = shots[i];
    if (!a || typeof a.base64 !== 'string' || a.base64.length > MAX_SHOT * 1.4) continue;
    if (!/^[A-Za-z0-9+/=]+$/.test(a.base64)) continue;
    const path = `attachments/${encodeURIComponent(id)}/screenshot-${i + 1}.jpg`;
    const res = await gh(`/repos/${REPO}/contents/${path}`, 'PUT', {
      message: `screenshots for ${id}`,
      content: a.base64,
    });
    if (res && res.content) shotUrls.push(res.content.download_url);
  }

  const rep = r.report || {};
  const title = `[${clip(rep.type, 12) || 'report'}] ${clip(rep.summary, 90) || '(no summary)'}`;
  const labels = ['new'];
  if (VALID_TYPES.has(rep.type)) labels.push(rep.type);
  if (rep.category) labels.push('cat:' + clip(rep.category, 30));
  if (rep.playerImpact && VALID_IMPACT.has(rep.playerImpact) && rep.playerImpact !== '')
    labels.push('impact:' + rep.playerImpact);

  const issue = await gh(`/repos/${REPO}/issues`, 'POST', {
    title,
    body: brief(r, shotUrls),
    labels,
  });
  seen.set(id, issue.html_url);
  console.log(`filed ${id} -> ${issue.html_url} (ip ${ip})`);
  return { duplicate: false, url: issue.html_url, number: issue.number };
}

function validate(r) {
  if (!r || typeof r !== 'object') return 'bad json';
  if (typeof r.clientReportId !== 'string' ||
      !/^[0-9a-fA-F-]{16,64}$/.test(r.clientReportId)) return 'bad clientReportId';
  const rep = r.report || {};
  if (!VALID_TYPES.has(rep.type)) return 'bad report.type';
  if (!rep.summary || typeof rep.summary !== 'string') return 'missing summary';
  if (!rep.description || typeof rep.description !== 'string') return 'missing description';
  if (rep.playerImpact && !VALID_IMPACT.has(rep.playerImpact)) return 'bad playerImpact';
  return null;
}

// ── AI polish: turn a player's raw words into a tidy report ──
// The game client never holds the Anthropic key; this service brokers one
// short Messages call. Fail-soft by design: any problem returns an error the
// client shows as "the scribe is unavailable" and the player's own text stands.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ASSIST_MODEL = process.env.ASSIST_MODEL || 'claude-haiku-4-5-20251001';
const ASSIST_MAX_INPUT = 4000;

async function polish(type, subject, description) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: ASSIST_MODEL,
      max_tokens: 700,
      system:
        'You tidy playtest feedback for a cozy tavern video game. Rewrite the ' +
        "player's report so a developer can act on it: a short specific subject " +
        'line and a clear description (plain sentences; a short list only if ' +
        'the player raised several separate points). PRESERVE every fact and ' +
        "the player's meaning — never invent details, steps, or symptoms they " +
        "didn't state, and keep their tone friendly. Respond with ONLY a JSON " +
        'object: {"subject": "...", "description": "..."} — no code fences, ' +
        'no commentary.',
      messages: [{
        role: 'user',
        content: 'Report type: ' + type + '\nSubject (may be empty): ' + subject +
                 '\nDescription:\n' + description,
      }],
    }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('').trim();
  // tolerate stray prose around the JSON — grab the outermost object
  const m = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(m ? m[0] : text);
  if (typeof parsed.subject !== 'string' || typeof parsed.description !== 'string')
    throw new Error('assist: malformed model output');
  return { subject: clip(parsed.subject, 120), description: clip(parsed.description, MAX_TEXT) };
}

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.method === 'GET' && req.url === '/healthz')
    return send(200, { ok: true, repo: REPO, hasToken: TOKEN !== '', hasAssist: ANTHROPIC_KEY !== '' });

  if (req.method === 'POST' && req.url === '/api/v1/feedback/assist') {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
      .toString().split(',')[0].trim();
    if (rateLimited(ip))
      return send(429, { error: 'rate limited — try again later' });
    if (!ANTHROPIC_KEY)
      return send(503, { error: 'assist not configured' });
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 64 * 1024) { send(413, { error: 'too large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (size > 64 * 1024) return;
      let r;
      try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return send(400, { error: 'bad json' }); }
      const desc = clip(r.description, ASSIST_MAX_INPUT);
      if (!desc) return send(400, { error: 'missing description' });
      try {
        const out = await polish(
          VALID_TYPES.has(r.type) ? r.type : 'feedback',
          clip(r.subject, 120), desc);
        return send(200, out);
      } catch (e) {
        console.error('assist failed:', e.message);
        return send(502, { error: 'assist failed — try again later' });
      }
    });
    return;
  }

  // questions waiting for THIS player's reports
  if (req.method === 'GET' && req.url.startsWith('/api/v1/feedback/questions')) {
    if (!TOKEN) return send(503, { error: 'service not configured' });
    const u = new URL(req.url, 'http://x');
    // each entry is "FT-000129:<clientReportId>"
    const pairs = (u.searchParams.get('ids') || '')
      .split(',').map(x => x.trim())
      .map(x => { const i = x.indexOf(':'); return i < 0 ? null : [x.slice(0, i), x.slice(i + 1)]; })
      .filter(p => p && /^FT-\d{1,9}$/.test(p[0]) && /^[0-9a-fA-F-]{16,64}$/.test(p[1]))
      .slice(0, 20);
    if (pairs.length === 0) return send(200, { questions: [] });
    Promise.all(pairs.map(p => pendingQuestion(p[0], p[1]).catch(() => null)))
      .then(list => send(200, { questions: list.filter(Boolean) }))
      .catch(() => send(502, { error: 'lookup failed' }));
    return;
  }

  // the player's answer goes back onto the same issue
  if (req.method === 'POST' && req.url === '/api/v1/feedback/answer') {
    const ip2 = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
      .toString().split(',')[0].trim();
    if (rateLimited(ip2)) return send(429, { error: 'rate limited — try again later' });
    if (!TOKEN) return send(503, { error: 'service not configured' });
    let n = 0; const parts = [];
    req.on('data', c => {
      n += c.length;
      if (n > 32 * 1024) { send(413, { error: 'too large' }); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', async () => {
      if (n > 32 * 1024) return;
      let r;
      try { r = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { return send(400, { error: 'bad json' }); }
      if (typeof r.clientReportId !== 'string' ||
          !/^[0-9a-fA-F-]{16,64}$/.test(r.clientReportId))
        return send(400, { error: 'bad clientReportId' });
      const text = clip(r.text, MAX_TEXT);
      if (!text) return send(400, { error: 'empty reply' });
      try {
        const hit = await issueFor(r.reportId, r.clientReportId);
        if (!hit) return send(404, { error: 'report not found' });
        await gh(`/repos/${REPO}/issues/${hit.number}/comments`, 'POST', {
          body: REPLY + ' **The reporter replied:**\n\n> ' +
                text.replace(/\n/g, '\n> '),
        });
        // answered — drop the needs-info flag if triage set one
        try { await gh(`/repos/${REPO}/issues/${hit.number}/labels/needs-info`, 'DELETE'); }
        catch { /* label may not be set */ }
        return send(200, { success: true, reportId: 'FT-' + String(hit.number).padStart(6, '0') });
      } catch (e) {
        console.error('answer failed:', e.message);
        return send(502, { error: 'could not post reply' });
      }
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/v1/feedback/reports')
    return send(404, { success: false, error: 'not found' });

  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?')
    .toString().split(',')[0].trim();
  if (rateLimited(ip))
    return send(429, { success: false, error: 'rate limited — try again later' });
  if (!TOKEN)
    return send(503, { success: false, error: 'service not configured' });

  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { send(413, { success: false, error: 'too large' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (size > MAX_BODY) return;
    let r;
    try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(400, { success: false, error: 'bad json' }); }
    const err = validate(r);
    if (err) return send(400, { success: false, error: err });
    try {
      const out = await fileReport(r, ip);
      return send(200, {
        success: true,
        reportId: 'FT-' + (out.number != null ? String(out.number).padStart(6, '0') : 'dup'),
        clientReportId: r.clientReportId,
        duplicate: out.duplicate,
        receivedUtc: new Date().toISOString(),
      });
    } catch (e) {
      console.error('file failed:', e.message);
      return send(502, { success: false, error: 'upstream failure — retry later' });
    }
  });
});

server.listen(PORT, () => console.log('feedback api on :' + PORT + ' -> ' + REPO));
