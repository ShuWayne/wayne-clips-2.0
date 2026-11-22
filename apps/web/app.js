// Wayne.clips — frontend controller. Calls the REAL API (fetch + SSE,
// polling fallback). No invented jobs, clips, views or creators anywhere.
// Demo content is always tagged SAMPLE.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AGENTS = [
  ['scout', 'Scout', 'Finds niches taking off and rights-cleared sources.'],
  ['ingest', 'Ingest', 'Downloads the source, extracts audio, probes resolution, transcribes.'],
  ['viral', 'Viral Moments', 'Scores every moment and picks the clips worth posting.'],
  ['subtitle', 'Subtitles', 'Word-level captions, safe-area aware, burned in.'],
  ['effects', 'Effects', 'Picks parameterised presets by emotion, never more than the moment needs.'],
  ['render', 'Render + QA', 'Cuts, reframes, encodes, then checks dimensions, audio and caption safety.'],
  ['publish', 'Publish', 'Writes title, caption and hashtags. Uploads only after your approval.'],
];
const CHECKLIST = [
  'Is the footage mine or authorised?', 'No ending, twist or embargoed reveal?',
  'Hook in the first two seconds?', 'Captions readable on a phone?',
  'Caption has no false claim?', 'Disclosure added if sponsored?',
];

const api = {
  async get(p) { const r = await fetch(p); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `GET ${p} failed (${r.status})`); return r.json(); },
  async post(p, body, isForm = false) {
    const r = await fetch(p, { method: 'POST', body: isForm ? body : JSON.stringify(body || {}), headers: isForm ? {} : { 'content-type': 'application/json' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `POST ${p} failed (${r.status})`);
    return r.json();
  },
  async del(p) { const r = await fetch(p, { method: 'DELETE' }); if (!r.ok) throw new Error('delete failed'); return r.json(); },
};
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  $('#live').textContent = msg;
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3600);
}
// ---------- clip viewer ----------
// Opens only when called with a real clip (job clip cards). Never opened on load.
let viewerCtx = null;
function openViewer({ src, poster, caption, meta, jobId, rank }) {
  const v = $('#viewer-video');
  v.src = src; if (poster) v.poster = poster;
  $('#viewer-cap').textContent = caption || '';
  $('#viewer-meta').textContent = meta || '';
  viewerCtx = { jobId, rank };
  $('#viewer').hidden = false;
  $('#viewer-close').focus();
}
function closeViewer() {
  const v = $('#viewer-video');
  v.pause(); v.removeAttribute('src'); v.load();
  viewerCtx = null;
  $('#viewer').hidden = true;
}

// ---------- landing: scroll chapters, nav, HUD ----------
const CHAPTERS = [
  { p0: 0, p1: 0.07, name: 'Wordmark' }, { p0: 0.22, p1: 0.32, name: 'Scatter' },
  { p0: 0.44, p1: 0.56, name: 'Pipeline' }, { p0: 0.64, p1: 0.78, name: 'Studio' },
  { p0: 0.86, p1: 0.93, name: 'Hub' }, { p0: 0.93, p1: 1.01, name: 'Finale' },
];
let currentP = 0, currentChapter = 0;
function scrollP() {
  const track = $('#track');
  const max = track.offsetHeight - innerHeight;
  return Math.max(0, Math.min(1, scrollY / Math.max(1, max)));
}
function chapterFor(p) {
  for (let i = 0; i < CHAPTERS.length; i++) if (p >= CHAPTERS[i].p0 && p < CHAPTERS[i].p1) return i;
  return p < 0.07 ? 0 : 5;
}
function buildRail() {
  const rail = $('#rail');
  rail.innerHTML = CHAPTERS.map((c, i) => `<button data-ch="${i}" aria-label="Chapter ${i + 1}: ${c.name}"><i></i><label>${c.name}</label></button>`).join('') + `<div class="counter" id="rail-counter">01 / 06</div>`;
  $$('button', rail).forEach(b => b.addEventListener('click', () => jumpToChapter(+b.dataset.ch)));
}
function jumpToChapter(i) {
  const track = $('#track');
  const max = track.offsetHeight - innerHeight;
  scrollTo({ top: CHAPTERS[i].p0 * max + 10, behavior: 'smooth' });
}
function onScrollLanding() {
  const p = scrollP(); currentP = p;
  const ch = chapterFor(p);
  if (ch !== currentChapter) {
    currentChapter = ch;
    $$('.chapter').forEach((el, i) => el.classList.toggle('on', i === ch));
    $$('#rail button').forEach((b, i) => b.classList.toggle('active', i === ch));
    const c = $('#rail-counter'); if (c) c.textContent = `0${ch + 1} / 06`;
  }
  $('#nav').classList.toggle('hidden', p < 0.06);
  $('.hud-bl').style.display = p > 0.05 ? 'none' : '';
  // Pipeline chapter: focus the agent the camera faces.
  if (ch === 2) {
    const k = Math.min(6, Math.max(0, Math.floor((p - 0.44) / 0.12 * 6)));
    $$('#agent-list li').forEach((li, i) => li.classList.toggle('focused', i === k));
    const f = $('#agent-focus');
    if (f) { f.hidden = false; f.innerHTML = `<h4>${esc(AGENTS[k][1])}</h4><p>${esc(AGENTS[k][2])}</p><p class="mono" style="font-size:11px;color:var(--text-3);margin-top:6px">${esc(window.__agentLast?.[AGENTS[k][0]] || 'No job yet — paste a link to start one.')}</p>`; }
  } else { const f = $('#agent-focus'); if (f) f.hidden = true; }
  // Studio chapter: scroll scrubs the 30s timeline.
  if (ch === 3) {
    const t = ((p - 0.64) / 0.14) * 30;
    setStudioMini(t);
  }
}
function setStudioMini(t) {
  const steps = [['01', 'CAPTURE', 'DROP / Bring the source in', 0, 4], ['02', 'FIND THE CUT', 'RIPPLE / Mark the moment', 4, 10], ['03', 'CAPTIONS', 'TIMING / Lock the word timing', 10, 15], ['04', 'KEYFRAME', 'KEYFRAME / Keep the action in frame', 15, 19], ['05', 'TEMPLATE', 'CURVE / Style the clip', 19, 25], ['06', 'EXPORT', 'RENDER / Finish the file', 25, 30]];
  const s = steps.find(([,, , a, b]) => t >= a && t < b) || steps[5];
  $('#sm-step').textContent = `${s[0]} / ${s[1]} — ${s[2]}`;
  $('#sm-time').textContent = `${t.toFixed(2).padStart(5, '0')} / 30.00`;
  $('#sm-progress').style.width = `${(t / 30) * 100}%`;
  const caps = ['NEW CAPTION.', 'THIS CHANGES EVERYTHING.', 'CLIP THAT.', 'KEEP THE CHAOS.', 'NOBODY TELLS YOU THIS.', 'READY TO DROP.'];
  $('#sm-caption').textContent = caps[steps.indexOf(s)] || caps[0];
}
async function loadAgentsLanding() {
  try {
    const { agents } = await api.get('/api/agents');
    window.__agentStates = Object.fromEntries(agents.map(a => [a.id, a.state]));
    window.__agentLast = Object.fromEntries(agents.map(a => [a.id, a.lastLine]));
    $('#agent-list').innerHTML = agents.map((a, i) => `<li data-state="${a.state}"><span class="n">0${i + 1}</span><b>${esc(a.name)}</b><span>${esc(a.role)}</span><span class="dot"></span></li>`).join('');
    $('#landing-steps').innerHTML = [['01', 'CAPTURE'], ['02', 'FIND THE CUT'], ['03', 'CAPTIONS'], ['04', 'KEYFRAME'], ['05', 'TEMPLATE'], ['06', 'EXPORT']].map(([n, s]) => `<li data-step="${n}">${n} ${s}</li>`).join('');
  } catch { $('#agent-list').innerHTML = AGENTS.map(([id, n, r], i) => `<li data-state="standby"><span class="n">0${i + 1}</span><b>${n}</b><span>${r}</span><span class="dot"></span></li>`).join(''); }
}
async function loadLimitsFoot() {
  try {
    const l = await api.get('/api/platform-limits');
    $('#limits-foot').textContent = `Platform limits — last checked ${l.checkedAt}`;
  } catch { $('#limits-foot').textContent = 'Platform limits — last checked unknown'; }
}

// ---------- link box ----------
function linkBoxHTML(idPrefix) {
  return `<form class="linkbox glass" id="${idPrefix}-form">
    <h3>Paste a link. <span style="color:var(--pink)">Get clips.</span></h3>
    <p class="hint">Seven agents do the work. You approve every upload.</p>
    <div class="field"><label for="${idPrefix}-url">Video link</label>
      <input type="url" id="${idPrefix}-url" placeholder="https://… (a video you own or have rights to clip)" autocomplete="off"></div>
    <div class="field"><div class="dropzone" id="${idPrefix}-drop">Or drop a video file here — or <button type="button" class="btn ghost sm" id="${idPrefix}-pick">choose a file</button><input type="file" id="${idPrefix}-file" accept="video/*" hidden></div></div>
    <div class="field"><label class="check"><input type="checkbox" id="${idPrefix}-rights"> <span>I own this video or have the rights to clip and repost it <b style="color:var(--text)">(required for any URL)</b></span></label>
      <select id="${idPrefix}-basis" style="margin-top:8px"><option value="owned">Rights basis: owned</option><option value="permitted">permitted — written permission on file</option><option value="licensed">licensed — e.g. Creative Commons (attribution added)</option></select></div>
    <div class="field"><label>Formats</label><div class="chips" data-group="formats">
      <button type="button" class="chip on" data-v="9:16">9:16</button><button type="button" class="chip" data-v="1:1">1:1</button><button type="button" class="chip" data-v="16:9">16:9</button></div></div>
    <div class="field"><label>Quality</label><div class="chips" data-group="res">
      <button type="button" class="chip on" data-v="1080p">1080p</button><button type="button" class="chip" data-v="4K">4K</button><button type="button" class="chip" data-v="8K">8K</button></div>
      <p class="note">Exports above the source resolution are upscaled, not real 4K/8K detail.</p></div>
    <div class="field"><label>Caption style</label><div class="chips" data-group="style">
      <button type="button" class="chip on" data-v="pop">pop</button><button type="button" class="chip" data-v="bounce">bounce</button><button type="button" class="chip" data-v="karaoke">karaoke</button></div></div>
    <div class="field"><label for="${idPrefix}-niche">Niche (free text — used for hashtags)</label>
      <input type="text" id="${idPrefix}-niche" placeholder="e.g. study tips"></div>
    <div class="field"><label>Upload mode</label><div class="chips" data-group="mode">
      <button type="button" class="chip on" data-v="review">Review first — recommended</button><button type="button" class="chip" data-v="auto">Auto — with caps</button></div></div>
    <button class="btn primary" type="submit" style="width:100%">CREATE CLIPS</button>
    <p class="form-error" id="${idPrefix}-err"></p>
    <p class="note">Rights first: reference-only sources are never downloaded. Nothing uploads before you approve it.</p>
  </form>`;
}
function wireLinkBox(prefix) {
  const form = $(`#${prefix}-form`);
  const pick = (group) => $$(`.chips[data-group="${group}"] .chip`, form).filter(c => c.classList.contains('on')).map(c => c.dataset.v);
  const single = (group) => pick(group)[0];
  $$('.chips .chip', form).forEach(chip => chip.addEventListener('click', () => {
    const group = chip.closest('.chips').dataset.group;
    if (group === 'formats') chip.classList.toggle('on');
    else $$('.chips[data-group="' + group + '"] .chip', form).forEach(c => c.classList.toggle('on', c === chip));
  }));
  const drop = $(`#${prefix}-drop`), fileInput = $(`#${prefix}-file`);
  $(`#${prefix}-pick`).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) drop.firstChild.textContent = `File: ${fileInput.files[0].name} — `; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) { fileInput.files = e.dataTransfer.files; drop.firstChild.textContent = `File: ${e.dataTransfer.files[0].name} — `; } });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $(`#${prefix}-err`); err.textContent = '';
    const url = $(`#${prefix}-url`).value.trim();
    const file = fileInput.files[0];
    const rights = $(`#${prefix}-rights`).checked;
    if (!url && !file) { err.textContent = 'Paste a video link or drop a file first.'; return; }
    if (url && !rights) { err.textContent = 'Rights first: tick the rights confirmation before a URL job can start.'; return; }
    const btn = $('button[type=submit]', form); btn.disabled = true; btn.textContent = 'CREATING JOB…';
    try {
      let job;
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('sourceUrl', url);
        fd.append('rightsConfirmed', String(rights));
        fd.append('rightsBasis', $(`#${prefix}-basis`).value);
        fd.append('formats', JSON.stringify(pick('formats')));
        fd.append('resolutions', JSON.stringify([single('res')]));
        fd.append('niche', $(`#${prefix}-niche`).value.trim());
        fd.append('uploadMode', single('mode'));
        fd.append('captionStyle', single('style'));
        job = await api.post('/api/jobs', fd, true);
      } else {
        job = await api.post('/api/jobs', {
          sourceUrl: url, rightsConfirmed: rights, rightsBasis: $(`#${prefix}-basis`).value,
          formats: pick('formats'), resolutions: [single('res')],
          niche: $(`#${prefix}-niche`).value.trim(), uploadMode: single('mode'), captionStyle: single('style'),
        });
      }
      toast('Job created — the seven agents are running.');
      location.hash = `#/jobs/${job.id}`;
    } catch (e2) { err.textContent = e2.message; btn.disabled = false; btn.textContent = 'CREATE CLIPS'; }
  });
}

// ---------- router ----------
const routes = {
  '/': showLanding, '/new': viewNew, '/jobs': viewJobs, '/studio': viewStudio,
  '/scout': viewScout, '/pages': viewPages, '/earnings': viewEarnings,
  '/hub': viewHub, '/playbook': viewPlaybook, '/settings': viewSettings,
};
function showLanding() {
  $('#landing').hidden = false; $('#app').hidden = true;
  $('#landing').style.display = ''; document.body.style.overflow = '';
  onScrollLanding();
}
function showApp(html) {
  $('#landing').hidden = true; $('#app').hidden = false;
  $('#app').innerHTML = `<div class="view">${html}</div>`;
  scrollTo(0, 0);
}
function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, arg] = hash.split('/').filter(Boolean);
  const key = '/' + (path || '');
  if (key === '/jobs' && arg) return viewJob(arg);
  (routes[key] || showLanding)();
}
addEventListener('hashchange', route);

// ---------- jobs ----------
async function viewJobs() {
  showApp(`<h1>Jobs</h1><p class="lede">Every job, newest first. Jobs persist on disk as <span class="mono">jobs/&lt;id&gt;/job.json</span>.</p><div id="jobs-list"><p class="lede">Loading…</p></div><a class="btn primary" href="#/new">+ New job</a>`);
  try {
    const { jobs } = await api.get('/api/jobs');
    $('#jobs-list').innerHTML = jobs.length ? jobs.map(j => `<article class="card glass" style="margin-bottom:12px">
      <h3>${esc(j.input.sourceUrl || j.input.sourceFile || 'file job')}</h3>
      <p>${esc(j.input.niche || 'no niche')} · ${esc(j.input.rightsBasis)} · ${j.status} · ${(j.clips || []).length} clips</p>
      <div class="row"><span class="tag">${j.status}</span><span class="tag">${esc(j.createdAt.slice(0, 19).replace('T', ' '))}</span><a class="btn ghost sm" href="#/jobs/${j.id}">Open →</a></div></article>`).join('') : '<p class="lede">No jobs yet. Paste a link on the landing page.</p>';
  } catch (e) { $('#jobs-list').innerHTML = `<p class="lede">Could not load jobs: ${esc(e.message)}</p>`; }
}
let jobPoll = null, jobSSE = null;
async function viewJob(id) {
  showApp(`<h1>Job</h1><p class="lede mono" id="job-id">${esc(id)}</p><div id="job-body"><p class="lede">Loading…</p></div>`);
  clearInterval(jobPoll);
  if (jobSSE) { jobSSE.close(); jobSSE = null; }
  const render = async () => {
    try {
      const { job } = await api.get(`/api/jobs/${id}`);
      renderJob(job);
    } catch (e) { $('#job-body').innerHTML = `<p class="lede">Could not load this job: ${esc(e.message)}</p>`; }
  };
  await render();
  try {
    jobSSE = new EventSource(`/api/events?jobId=${id}`);
    jobSSE.onmessage = ev => { const d = JSON.parse(ev.data); if (d.type === 'snapshot' || d.type === 'log' || d.type === 'status' || d.type === 'job') render(); };
    jobSSE.onerror = () => { jobSSE.close(); jobSSE = null; jobPoll = setInterval(render, 3000); };
  } catch { jobPoll = setInterval(render, 3000); }
  jobPoll = jobPoll || setInterval(render, 5000);
}
function renderJob(job) {
  const done = AGENT_IDS_DONE(job);
  const clips = job.clips || [];
  const renderResults = job.agents.render.output?.results || [];
  const byRank = Object.fromEntries(renderResults.map(r => [r.rank, r]));
  $('#job-body').innerHTML = `
    <div class="panel glass"><h2>Pipeline <span class="mono">${esc(job.status.toUpperCase())}</span></h2>
      <div class="progress-steps">${AGENTS.map(([aid, n]) => `<span class="${job.agents[aid].status}">${n} — ${job.agents[aid].status}</span>`).join('')}</div>
      <div class="bar"><i style="width:${(done / 7) * 100}%"></i></div>
      <p class="note" style="margin-top:10px">Source: ${esc(job.input.sourceUrl || job.input.sourceFile || '—')} · rights: ${esc(job.input.rightsBasis)}${job.input.rightsConfirmed ? ' (confirmed)' : ''} · ${esc(job.input.formats.join(', '))} · ${esc(job.input.resolutions.join(', '))} · ${esc(job.input.captionStyle)} captions</p>
    </div>
    <div class="panel glass"><h2>Live log</h2><div class="log" id="job-log" aria-live="polite">${(job.events || []).map(e => `<div><span class="t">${esc(e.createdAt.slice(11, 19))}</span><span class="${e.status === 'failed' ? 'fail' : e.status === 'running' ? 'run' : 'ok'}">[${esc(e.agent)}]</span> ${esc(e.message)}</div>`).join('') || 'No events yet.'}</div></div>
    <h2 style="font-family:var(--disp);font-size:28px">CLIPS — ${(clips.length)}</h2>
    <div class="clip-grid">${clips.map(c => {
      const r = byRank[c.rank];
      const file = r ? `/files/${job.id}/${r.file}` : null;
      return `<article class="card glass clip-card">
        ${file ? `<video src="${file}" poster="/files/${job.id}/${r.poster}" controls playsinline preload="metadata"></video>` : `<img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='360' height='640'><rect width='360' height='640' fill='%23190426'/><text x='180' y='320' fill='%23EE5FA7' font-size='22' text-anchor='middle' font-family='Arial'>RENDERING…</text></svg>" alt="Clip ${c.rank} not rendered yet">`}
        <div class="body"><h4>#${c.rank} — ${esc(c.captionText || c.hook)}</h4>
        <div class="meta">${c.start.toFixed(1)}s – ${c.end.toFixed(1)}s · score ${c.score} · ${esc(c.captionStyle || '')}</div>
        <div class="qa">${(r ? [...r.qa, ...(r.warnings || [])] : ['queued']).map(q => `<span class="tag ${/passed/.test(q) ? 'ok' : /pending|upscaled/.test(q) ? 'warn' : 'mint'}">${esc(q)}</span>`).join('')}${r?.upscaled > 1 ? `<span class="tag warn">upscaled ×${r.upscaled}</span>` : ''}</div>
        ${file ? `<div class="row"><button class="btn ghost sm" data-view="${c.rank}">View</button><a class="btn ghost sm" href="${file}" download>Download MP4</a><a class="btn ghost sm" href="#/studio?job=${job.id}&clip=${c.rank}">Open in Studio</a></div>` : ''}
        <div class="row"><select id="regen-style-${c.rank}" aria-label="Caption style"><option value="pop">pop</option><option value="bounce">bounce</option><option value="karaoke">karaoke</option></select>
        <button class="btn ghost sm" data-regen="${c.rank}">Regenerate</button></div>
        </div></article>`;
    }).join('') || '<p class="lede">No clips yet — the agents are still working, or the transcript was empty (voiceover needed).</p>'}</div>
    <h2 style="font-family:var(--disp);font-size:28px;margin-top:26px">PUBLISH DRAFTS</h2>
    <div id="drafts">${(job.drafts || []).map(d => `<article class="card glass" style="margin-bottom:12px">
      <h3>#${d.rank} · ${esc(d.platform)} — ${esc(d.title)}</h3>
      <p>${esc(d.caption)}<br><span class="mono" style="color:var(--pink)">${esc(d.hashtags.join(' '))}</span></p>
      <div class="row"><span class="tag ${d.status === 'draft' ? '' : 'ok'}">${esc(d.status)}</span>
      ${d.status === 'draft' ? `<button class="btn primary sm" data-approve="${d.rank}:${d.platform}">Approve &amp; upload</button>` : ''}</div>
      <div class="approve-box" id="approve-${d.rank}-${d.platform}" hidden>
        <p class="note">All six must be ticked before Approve:</p>
        ${CHECKLIST.map((c, i) => `<label class="check"><input type="checkbox" data-ck="${i}"> <span>${esc(c)}</span></label>`).join('')}
        <button class="btn mint sm" data-confirm-approve="${d.rank}:${d.platform}" style="margin-top:10px">Confirm approval</button>
      </div></article>`).join('') || '<p class="lede">No drafts yet.</p>'}</div>`;
  $$('[data-view]').forEach(b => b.addEventListener('click', () => {
    const rank = +b.dataset.view;
    const c = clips.find(x => x.rank === rank);
    const r = byRank[rank];
    if (!c || !r) return;
    openViewer({
      src: `/files/${job.id}/${r.file}`,
      poster: `/files/${job.id}/${r.poster}`,
      caption: c.captionText || c.hook,
      meta: `#${rank} · ${c.start.toFixed(1)}s–${c.end.toFixed(1)}s · score ${c.score} · rights: ${job.input.rightsBasis} (confirmed)`,
      jobId: job.id, rank,
    });
  }));
  $$('[data-regen]').forEach(b => b.addEventListener('click', async () => {
    const rank = +b.dataset.regen;
    const style = $(`#regen-style-${rank}`).value;
    b.disabled = true; b.textContent = 'Regenerating…';
    try {
      await api.post(`/api/jobs/${job.id}/clips/${rank}/regenerate`, { overrides: { captionStyle: style } });
      toast(`Clip #${rank} regenerated with ${style} captions.`);
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Regenerate'; }
  }));
  $$('[data-approve]').forEach(b => b.addEventListener('click', () => {
    const box = $(`#approve-${b.dataset.approve.replace(':', '-')}`);
    if (box) box.hidden = !box.hidden;
  }));
  $$('[data-confirm-approve]').forEach(b => b.addEventListener('click', async () => {
    const [rank, platform] = b.dataset.confirmApprove.split(':');
    const box = b.closest('.approve-box');
    const checklist = $$('input[data-ck]', box).map(i => i.checked);
    try {
      const out = await api.post(`/api/jobs/${job.id}/publish/${rank}:${platform}/approve`, { checklist });
      toast(`Approved: clip #${rank} for ${platform}. ${out.status}`);
    } catch (e) { toast(e.message); }
  }));
  const log = $('#job-log'); if (log) log.scrollTop = log.scrollHeight;
}
function AGENT_IDS_DONE(job) { return AGENTS.filter(([id]) => job.agents[id]?.status === 'done').length; }

// ---------- studio ----------
let studioTimer = null;
function viewNew() {
  showApp(`<h1>New job</h1><p class="lede">Paste a link or drop a file. Rights first — a URL job needs your confirmation.</p><div id="new-linkbox"></div>`);
  $('#new-linkbox').innerHTML = linkBoxHTML('new');
  wireLinkBox('new');
}
async function viewStudio() {
  showApp(`<h1>Clip Studio</h1><p class="lede">The 30-second loop, live. When a real job exists the panels bind to it; otherwise the loop runs on the demo and every panel is tagged SAMPLE.</p>
  <div id="studio-banner"></div><div id="studio-root"><p class="lede">Loading the Studio…</p></div>`);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const jobId = params.get('job');
  const clipRank = +(params.get('clip') || 1);
  let demo = null, job = null, clips = [], toolkit = [];
  try { demo = await api.get('/api/studio-demo'); } catch {}
  try { toolkit = (await api.get('/api/toolkit')).tools; } catch {}
  try {
    if (jobId) job = (await api.get(`/api/jobs/${jobId}`)).job;
    else { const { jobs } = await api.get('/api/jobs'); job = jobs.find(j => j.status === 'done') || null; }
  } catch {}
  const isDemo = !job || !(job.clips || []).length;
  if (isDemo) {
    $('#studio-banner').innerHTML = `<div class="banner"><b>SAMPLE</b><span>Run a job to see your own clip here — this loop is the demo from studio-demo.json.</span></div>`;
    clips = (demo?.moments || []).map((m, i) => ({ rank: i + 1, ...m, captionText: m.hook, captionStyle: 'pop', fontScale: 1 }));
  } else {
    clips = job.clips.map(c => ({ ...c }));
    $('#studio-banner').innerHTML = `<div class="banner" style="background:rgba(140,231,215,.08);border-color:rgba(140,231,215,.4);color:var(--mint)"><b>REAL JOB</b><span>${esc(job.id)} — ${clips.length} clips. Edits here regenerate the clip.</span></div>`;
  }
  const sel = clips[Math.min(clipRank - 1, clips.length - 1)] || clips[0];
  const tools = demo?.tools || [];
  const steps = demo?.steps || [];
  $('#studio-root').innerHTML = `
  <div class="studio" id="studio-grid">
    <div class="panel glass wide" style="padding:14px 20px">
      <div class="studio-top"><div><h2 class="studio-title">WAYNE.CLIPS <span>/ STUDIO</span></h2><div class="studio-sub">${esc(job ? job.id.slice(0, 8) : 'SAMPLE_JOB')} × 7 AGENTS ${isDemo ? '<span class="tag sample">SAMPLE</span>' : ''}</div></div><div class="clipit">CLIP IT.<br>SHIP IT.</div></div>
      <div class="stepbar"><span class="cur" id="st-step">01 / CAPTURE</span><span id="st-bar">DROP / Bring the source in</span><span id="st-time">00.00 / 30.00</span></div>
    </div>
    <div class="panel glass"><h2>PROGRAM / SOURCE_01 <span class="mono" style="color:var(--text-3)">ORIGINAL SPEED</span></h2>
      <div class="program" id="program">
        ${job && sel ? `<video id="prog-video" src="/files/${job.id}/clip-${sel.rank}.mp4" poster="/files/${job.id}/clip-${sel.rank}.jpg" loop muted playsinline></video>` : `<div style="width:100%;height:100%;background:linear-gradient(135deg,#EE5FA7,#7C3AED);display:flex;align-items:center;justify-content:center;font-family:var(--disp);font-size:28px;color:#fff">${esc(sel?.captionText || 'SAMPLE SOURCE')}</div>`}
        <span class="src-tag">● ${esc(job ? (job.input.sourceUrl || job.input.sourceFile || 'SOURCE') : 'SAMPLE SOURCE')}</span>
        <div class="cropbox" id="cropbox" style="left:22%;top:8%;width:56%;height:84%"><span class="clab">9:16 / CROP 02</span><span class="xlab" id="crop-x">X 44.3%</span>
          <span class="handle" style="top:-3px;left:-3px"></span><span class="handle" style="top:-3px;right:-3px"></span><span class="handle" style="bottom:-3px;left:-3px"></span><span class="handle" style="bottom:-3px;right:-3px"></span><span class="handle" style="top:-3px;left:calc(50% - 3px)"></span><span class="handle" style="bottom:-3px;left:calc(50% - 3px)"></span></div>
        <div class="capbox" id="capbox"><i></i><i></i><i></i><i></i><span id="capbox-text">${esc(sel?.captionText || 'NEW CAPTION')}. </span></div>
      </div>
      <div class="transport"><button id="st-play" aria-label="Play or pause">⏸</button><span class="tc" id="st-tc">00:06:00</span><span class="src">SOURCE ${sel ? `${Math.round(sel.start)}–${Math.round(sel.end)} SEC` : '18–48 SEC'}</span></div>
      <div class="hairline" id="st-hair"></div>
      <div class="row" style="display:flex;gap:8px;margin-top:10px"><span class="tag sample">SAMPLE</span><span class="tag">9:16 / H.264</span><span class="tag mint">VIDEO + CAPTIONS</span></div>
    </div>
    <div>
      <div class="panel glass" style="margin-bottom:12px"><h2>MEDIA BIN / SOURCE MOMENTS</h2>
        <div class="thumbs">${clips.slice(0, 3).map((c, i) => `<button data-bin="${c.rank}" class="${c.rank === sel.rank ? 'sel' : ''}">${job ? `<video src="/files/${job.id}/clip-${c.rank}.mp4" muted preload="metadata"></video>` : `<div style="aspect-ratio:16/9;background:linear-gradient(135deg,#B39DFF,#EE5FA7)"></div>`}<span>${c.start.toFixed(1)}s — ${esc(c.captionText || c.hook)}</span></button>`).join('')}</div>
      </div>
      <div class="panel glass" style="margin-bottom:12px"><h2>INSPECTOR / LIVE EDIT <span style="color:var(--pink);font-size:11px">KEYFRAMES</span></h2>
        <input class="insp-field" id="insp-caption" value="${esc(sel?.captionText || 'NEW CAPTION')}" aria-label="Live caption">
        <div class="kv"><span>FONT</span><b>ANTON</b><input type="range" id="insp-size" min="24" max="56" value="${Math.round(36 * (sel?.fontScale || 1))}" aria-label="Font size"><b id="insp-size-v">${Math.round(36 * (sel?.fontScale || 1))} PX</b></div>
        <div class="kv"><span style="color:var(--mint)">MOTION CROP</span><b id="insp-crop">X 44.3%</b><b>9:16 / SAFE AREA</b></div>
        <div class="chiprow" id="kf-chips"></div>
        <div class="kv"><span style="color:var(--lavender)">EASING / POSITION</span><b>ease-in-out</b></div>
        <svg class="curve" viewBox="0 0 200 56" aria-hidden="true"><path d="M4 52 C 60 52, 140 4, 196 4" fill="none" stroke="#B39DFF" stroke-width="2"/><circle cx="100" cy="28" r="4" fill="#B39DFF"/></svg>
        <div class="kv"><span>RGB <b id="rgb-v">−6.0</b></span><b>grade</b></div>
        <svg class="curve" viewBox="0 0 200 56" aria-hidden="true"><path d="M4 40 C 70 40, 130 12, 196 12" fill="none" stroke="#FFB58A" stroke-width="2"/><circle cx="140" cy="20" r="4" fill="#FFB58A"/></svg>
        <div id="takeover" hidden><span class="tag mint">YOU HAVE THE CURSOR</span> <button class="btn mint sm" id="apply-takeover">Apply &amp; regenerate clip</button></div>
      </div>
      <div class="panel glass"><h2>9:16 / OUTPUT PREVIEW</h2>
        <div style="display:flex;gap:12px;align-items:center"><div style="width:74px;aspect-ratio:9/16;border-radius:10px;background:linear-gradient(160deg,#EE5FA7,#7C3AED);display:flex;align-items:flex-end;padding:8px;font-family:var(--disp);font-size:11px;color:#fff">${esc(sel?.captionText || 'SAMPLE')}</div>
        <div><b>SHORT_0${sel?.rank || 1}</b><div class="mono" style="font-size:11px;color:var(--text-2)">9:16 / H.264<br><span style="color:var(--mint)">VIDEO + CAPTIONS</span></div></div></div>
        <div class="kv" style="margin-top:12px"><span>EXPORT / H.264</span><b id="export-label">QUEUED</b></div>
        <div class="bar"><i id="export-bar" style="width:0%"></i></div>
        <div style="display:flex;gap:3px;margin-top:10px" id="levels">${Array.from({ length: 8 }, () => '<i style="flex:1;height:14px;background:linear-gradient(180deg,#8CE7D7,#FFB58A,#EE5FA7);opacity:.5;border-radius:2px"></i>').join('')}</div>
      </div>
    </div>
    <div class="panel glass wide seq"><h2>SEQUENCE / SHORT_0${sel?.rank || 1} <span style="color:var(--pink);font-size:11px">SNAP • 30.00 SEC</span></h2>
      <div class="ruler"><span>00</span><span>05</span><span>10</span><span>15</span><span>20</span><span>25</span><span>30</span></div>
      <div class="track" data-track="source"><span class="lbl">SOURCE</span><div class="fill" id="fill-source" style="transform:scaleX(0)"></div></div>
      <div class="track" data-track="captions"><span class="lbl">CAPTIONS</span><span id="cap-pills"></span></div>
      <div class="track" data-track="reframe"><span class="lbl">REFRAME</span><svg id="reframe-line" viewBox="0 0 100 26" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%"><polyline points="0,13 30,13 60,8 100,8" fill="none" stroke="#B39DFF" stroke-width="1.5"/><circle cx="30" cy="13" r="2" fill="#B39DFF"/><circle cx="60" cy="8" r="2" fill="#B39DFF"/></svg></div>
      <div class="track" data-track="audio"><span class="lbl">AUDIO</span><div class="wave" id="wave"></div></div>
      <div class="playhead" id="playhead" style="left:0%"></div>
      <div class="ripple-tag" id="ripple-tag" style="left:20%" hidden>RIPPLE −2.0s</div>
    </div>
    <div class="panel glass wide"><h2>THE CLIPPING TOOLKIT / ${tools.length} TOOLS <span style="color:var(--pink);font-size:11px">${esc(demo?.modelId || 'claude-sonnet-5-5')}</span></h2>
      <div class="toolgrid">${tools.map((t, i) => {
        const probe = toolkit.find(p => p.id === t.id);
        const off = probe && probe.status === 'not_connected';
        return `<div class="${off ? 'off' : ''}" data-tool="${t.id}"><span class="num" style="color:${['#EE5FA7', '#8CE7D7', '#B39DFF', '#FFB58A'][i % 4]}">${String(i + 1).padStart(2, '0')}</span>${esc(t.name)}${off ? ' — not installed' : ''}</div>`;
      }).join('')}</div>
      <div class="cursor" id="agent-cursor" style="left:20%;top:20%;color:var(--pink)"><span class="ring"></span><span class="arrow">➤</span><span class="ctag">01 Select</span></div>
    </div>
  </div>`;
  $('#wave').innerHTML = Array.from({ length: 90 }, (_, i) => `<i style="height:${20 + Math.abs(Math.sin(i * 0.7)) * 70}%"></i>`).join('');
  // Studio loop state
  let t = 0, playing = true, takenOver = false;
  const caps = demo?.captions || ['THIS CHANGES EVERYTHING.', 'CLIP THAT.', 'KEEP THE CHAOS.', 'NOBODY TELLS YOU THIS.', 'RUN IT BACK.', 'READY TO DROP.'];
  const stepFor = tt => steps.find(s => tt >= s.t0 && tt < s.t1) || steps[steps.length - 1];
  const cursorMoves = [
    { at: 1, x: '70%', y: '18%', tag: '01 Select', color: 'var(--pink)', tool: 'claude' },
    { at: 6, x: '30%', y: '78%', tag: '02 Trim', color: 'var(--pink)', tool: 'ffmpeg' },
    { at: 11, x: '72%', y: '30%', tag: '03 Captions', color: 'var(--peach)', tool: 'whisper' },
    { at: 13, x: '45%', y: '45%', tag: '04 Type', color: 'var(--peach)', tool: 'libass' },
    { at: 16, x: '55%', y: '30%', tag: '05 Reframe', color: 'var(--mint)', tool: 'reframe' },
    { at: 20, x: '75%', y: '55%', tag: '06 Motion', color: 'var(--lavender)', tool: 'ffmpeg' },
    { at: 22, x: '78%', y: '62%', tag: '07 Color', color: 'var(--lime)', tool: 'ffmpeg' },
    { at: 27, x: '60%', y: '82%', tag: '08 Export', color: 'var(--lime)', tool: 'ffmpeg' },
  ];
  const tick = () => {
    if (!document.body.contains($('#st-time'))) { clearInterval(studioTimer); return; }
    if (playing && !takenOver) t = (t + 0.1) % 30;
    const s = stepFor(t);
    $('#st-step').textContent = `${s.n} / ${s.name}`;
    $('#st-bar').textContent = s.bar;
    $('#st-time').textContent = `${t.toFixed(2).padStart(5, '0')} / 30.00`;
    const mm = String(Math.floor(t / 60)).padStart(2, '0'), ss = String(Math.floor(t % 60)).padStart(2, '0');
    $('#st-tc').textContent = `${mm}:${ss}:00`;
    $('#st-hair').style.width = `${(t / 30) * 100}%`;
    $('#playhead').style.left = `${(t / 30) * 100}%`;
    $('#ripple-tag').hidden = !(t >= 4 && t < 10);
    $('#fill-source').style.transform = `scaleX(${Math.min(1, t / 4)})`;
    const capIdx = Math.min(caps.length - 1, Math.floor(t / 5));
    if (!takenOver) $('#capbox-text').textContent = (t < 4 ? 'NEW CAPTION' : caps[capIdx]) + '. ';
    $('#cap-pills').innerHTML = caps.slice(0, Math.max(1, Math.floor(t / 5))).map((c, i) => `<span class="pill" style="left:${8 + i * 15}%">${esc(c)}</span>`).join('');
    // crop slide 15–19s: X 44.3% -> 52.8%
    const cx = t < 15 ? 44.3 : t > 19 ? 52.8 : 44.3 + ((t - 15) / 4) * 8.5;
    $('#crop-x').textContent = `X ${cx.toFixed(1)}%`;
    $('#insp-crop').textContent = `X ${cx.toFixed(1)}%`;
    $('#cropbox').style.left = `${18 + ((cx - 44.3) / 8.5) * 8}%`;
    $('#kf-chips').innerHTML = Array.from({ length: Math.max(2, Math.min(7, 2 + Math.floor(Math.max(0, t - 15)))) }, (_, i) => `<span class="tag mint">+ KEYFRAME 0${i + 2}</span>`).join('');
    $('#rgb-v').textContent = t < 19 ? '−6.0' : t > 25 ? '+0.0' : `${(-6 + ((t - 19) / 6) * 6).toFixed(1)}`;
    const exp = t < 25 ? 0 : t >= 30 ? 100 : ((t - 25) / 5) * 100;
    $('#export-bar').style.width = `${Math.min(100, exp)}%`;
    $('#export-label').textContent = t < 25 ? 'QUEUED' : t < 29 ? 'RENDERING…' : 'SAVED / .MP4';
    $$('#levels i').forEach((el, i) => { el.style.opacity = t >= 25 && t < 30 ? 0.4 + 0.6 * Math.abs(Math.sin(t * 2 + i)) : 0.5; });
    // agent cursor
    const mv = [...cursorMoves].reverse().find(m => t >= m.at) || cursorMoves[0];
    const cur = $('#agent-cursor');
    if (!takenOver && cur) {
      cur.style.left = mv.x; cur.style.top = mv.y; cur.style.color = mv.color;
      $('.ctag', cur).textContent = mv.tag;
      $$('.toolgrid div').forEach(d => d.classList.toggle('use', d.dataset.tool === mv.tool));
    }
    const pv = $('#prog-video');
    if (pv) { if (playing && pv.paused) pv.play().catch(() => {}); if (!playing && !pv.paused) pv.pause(); }
  };
  clearInterval(studioTimer);
  studioTimer = setInterval(tick, 100);
  tick();
  $('#st-play').addEventListener('click', () => { playing = !playing; $('#st-play').textContent = playing ? '⏸' : '▶'; });
  $$('[data-bin]').forEach(b => b.addEventListener('click', () => { location.hash = `#/studio?job=${job?.id || ''}&clip=${b.dataset.bin}`; }));
  const armTakeover = () => {
    if (!job) { toast('Demo mode — run a job to take over a real clip.'); return; }
    takenOver = true;
    $('#takeover').hidden = false;
    toast('You have the cursor — edits pause the agents.');
  };
  $('#insp-caption').addEventListener('input', armTakeover);
  $('#insp-size').addEventListener('input', e => { $('#insp-size-v').textContent = `${e.target.value} PX`; armTakeover(); });
  $('#apply-takeover').addEventListener('click', async () => {
    if (!job) return;
    const btn = $('#apply-takeover'); btn.disabled = true; btn.textContent = 'Regenerating…';
    try {
      await api.post(`/api/jobs/${job.id}/clips/${sel.rank}/regenerate`, { overrides: { captionText: $('#insp-caption').value.trim().toUpperCase(), captionStyle: sel.captionStyle || 'pop', fontScale: +$('#insp-size').value / 36 } });
      toast(`Clip #${sel.rank} regenerated with your overrides.`);
      takenOver = false; $('#takeover').hidden = true;
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = 'Apply & regenerate clip';
  });
}

// ---------- scout / pages / earnings / hub / playbook / settings ----------
async function viewScout() {
  showApp(`<h1>Scout</h1><p class="lede">Niche opportunity radar. Without a YouTube API key Scout works from Hub licences + local patterns only — it says so, and reference-only sources are never clippable.</p>
  <div class="row" style="display:flex;gap:10px;margin-bottom:16px"><input type="text" id="scout-niche" placeholder="Niche (optional)" style="background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:10px 12px"><button class="btn primary" id="scout-run">Find niches</button><button class="btn ghost" id="scout-auto">Queue clips from cleared sources (review mode)</button></div>
  <div id="scout-out"><p class="lede">Press “Find niches”.</p></div>`);
  const run = async () => {
    $('#scout-out').innerHTML = '<p class="lede">Scouting…</p>';
    try {
      const r = await api.post('/api/scout', { niche: $('#scout-niche').value.trim() });
      $('#scout-out').innerHTML = `<p class="note" style="margin-bottom:14px">${esc(r.note)} ${r.claudeAvailable ? 'Claude shortlist available.' : 'Claude not connected.'}</p>
      <div class="cards">${r.niches.map(n => `<article class="card glass"><h3>${esc(n.name)}</h3><p>${esc(n.why)}</p>
        <div class="bar"><i style="width:${Math.round(n.score * 100)}%"></i></div>
        <div class="row"><span class="tag mint">score ${n.score}</span><span class="tag">${esc(n.pattern.clipSeconds)}s typical</span><span class="tag">${esc(n.pattern.hashtags.join(' '))}</span><span class="tag">best ${esc(n.pattern.bestHours)}</span></div></article>`).join('')}</div>
      <h2 style="font-family:var(--disp);font-size:24px;margin-top:22px">CLEARED TO CLIP — ${r.cleared.length}</h2>
      ${r.cleared.map(c => `<div class="card glass" style="margin-bottom:10px"><h3>${esc(c.channel)}</h3><p>${esc(c.scope)} — attribution: ${esc(c.attribution || '—')}</p><span class="tag ok">${esc(c.rightsBasis)}</span></div>`).join('') || '<p class="lede">No cleared sources yet — publish a licence in the Hub.</p>'}
      <h2 style="font-family:var(--disp);font-size:24px;margin-top:22px">REFERENCE ONLY — ${r.referenceOnly.length}</h2>
      <p class="note">These are shown as links and are never downloaded.</p>
      ${r.referenceOnly.map(c => `<div class="card glass" style="margin-bottom:10px"><h3>${esc(c.channel)}</h3><p>${esc(c.scope)}</p><span class="tag warn">reference — never downloaded</span></div>`).join('') || '<p class="lede">None.</p>'}`;
    } catch (e) { $('#scout-out').innerHTML = `<p class="lede">Scout failed: ${esc(e.message)}</p>`; }
  };
  $('#scout-run').addEventListener('click', run);
  $('#scout-auto').addEventListener('click', async () => {
    try { const r = await api.post('/api/autopilot', { niche: $('#scout-niche').value.trim() }); toast(r.note); }
    catch (e) { toast(e.message); }
  });
}
async function viewPages() {
  showApp(`<h1>Pages</h1><p class="lede">One card per faceless page. A duplicate guard refuses to queue the same clip on two pages.</p>
  <div class="panel glass"><h2>New page</h2>
    <div class="field"><label>Angle (one sentence)</label><input type="text" id="pg-angle" placeholder="e.g. 60-second study tips that actually work"></div>
    <div class="field"><label>Niche</label><input type="text" id="pg-niche" placeholder="e.g. study"></div>
    <div class="field"><label>Handle</label><input type="text" id="pg-handle" placeholder="@yourpage"></div>
    <div class="field"><label>Daily cap</label><input type="text" id="pg-cap" value="3"></div>
    <div class="row" style="display:flex;gap:8px"><button class="btn primary" id="pg-create">Create page</button><button class="btn ghost" id="pg-ideas">Generate names, bios &amp; 30-day plan</button></div>
    <div id="pg-ideas-out" style="margin-top:12px"></div></div>
  <div id="pages-list"></div>`);
  const load = async () => {
    const { pages } = await api.get('/api/pages');
    $('#pages-list').innerHTML = pages.map(p => `<article class="card glass" style="margin-bottom:12px"><h3>${esc(p.handle || p.niche)} — ${esc(p.angle)}</h3>
      <p>Niche: ${esc(p.niche)} · Platforms: ${esc((p.platforms || []).join(', '))} · Daily cap: ${p.dailyCap} · ${p.sponsored ? 'Sponsored' : 'Not sponsored'} · ${esc(p.status)}</p>
      <div class="row"><button class="btn ghost sm" data-del-page="${p.id}">Delete</button></div></article>`).join('') || '<p class="lede">No pages yet.</p>';
    $$('[data-del-page]').forEach(b => b.addEventListener('click', async () => { await api.del(`/api/pages/${b.dataset.delPage}`); load(); }));
  };
  await load();
  $('#pg-create').addEventListener('click', async () => {
    try {
      await api.post('/api/pages', { angle: $('#pg-angle').value.trim(), niche: $('#pg-niche').value.trim(), handle: $('#pg-handle').value.trim(), dailyCap: +$('#pg-cap').value || 3, platforms: ['YouTube', 'Instagram'] });
      toast('Page created.'); load();
    } catch (e) { toast(e.message); }
  });
  $('#pg-ideas').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/pages/ideas', { niche: $('#pg-niche').value.trim(), angle: $('#pg-angle').value.trim() });
      $('#pg-ideas-out').innerHTML = `<p class="note">Generated by ${esc(r.generatedBy)}.</p><p><b>Names:</b> ${esc(r.names.join(', '))}</p><p><b>Bios:</b><br>${r.bios.map(esc).join('<br>')}</p><p><b>30-day plan:</b><br>${r.plan.map(esc).join('<br>')}</p>`;
    } catch (e) { toast(e.message); }
  });
}
function viewEarnings() {
  showApp(`<h1>Earnings</h1><p class="lede">Formula only — no default rates, no “average income”. Type your own numbers from your own analytics.</p>
  <div class="panel glass"><h2>Calculator</h2>
    <div class="field"><label>Target amount ($)</label><input type="text" id="er-target" value="10000"></div>
    <div class="field"><label>Rate per 1,000 verified views ($)</label><input type="text" id="er-rate" placeholder="e.g. 1.00"></div>
    <div class="field"><label>Platform fee (%)</label><input type="text" id="er-fee" value="10"></div>
    <div class="field"><label>Verified views (for payout)</label><input type="text" id="er-views" placeholder="e.g. 500000"></div>
    <div class="field"><label>Per-clip cap ($) — 0 means no cap</label><input type="text" id="er-cap" value="0"></div>
    <button class="btn primary" id="er-calc">Calculate</button>
    <div id="er-out" style="margin-top:14px"></div>
    <p class="note">Example from the helper text only: a 10,000 target at 1.00 per 1,000 views with a 10% fee needs about 11.1 million verified views.</p></div>
  <div class="panel glass"><h2>Sponsorship cold email</h2>
    <div class="field"><label>Your average views, last 30 days (your real number)</label><input type="text" id="er-avg" placeholder="e.g. 4200"></div>
    <div class="field"><label>Page angle</label><input type="text" id="er-angle" placeholder="e.g. 60-second study tips"></div>
    <div class="field"><label>Brand</label><input type="text" id="er-brand" placeholder="e.g. Notebook Co"></div>
    <button class="btn ghost" id="er-email">Draft email</button>
    <pre id="er-email-out" style="white-space:pre-wrap;font-family:var(--ui);font-size:14px;line-height:1.6;color:var(--text-2)"></pre></div>
  <div class="panel glass"><h2>Platform thresholds</h2><div id="er-limits"><p class="lede">Loading…</p></div></div>`);
  $('#er-calc').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/earnings', { target: +$('#er-target').value || 0, ratePer1k: +$('#er-rate').value || 0, feePct: +$('#er-fee').value || 0, verifiedViews: +$('#er-views').value || 0, perClipCap: +$('#er-cap').value || 0 });
      $('#er-out').innerHTML = `<p><b>Payout:</b> $${r.payout.toLocaleString()}</p><p><b>Views needed for target:</b> ${r.viewsNeeded ? r.viewsNeeded.toLocaleString() : '— enter a rate above 0'}</p><p class="note">${esc(r.formula)}</p>`;
    } catch (e) { toast(e.message); }
  });
  $('#er-email').addEventListener('click', () => {
    const avg = $('#er-avg').value.trim() || '[your average views]';
    $('#er-email-out').textContent = `Subject: A sponsored clip idea for ${$('#er-brand').value.trim() || '[brand]'}\n\nHi,\n\nI run a faceless short-form page about ${$('#er-angle').value.trim() || '[angle]'}. Over the last 30 days my clips averaged ${avg} views.\n\nIdea: one sponsored clip built around your product, in my usual format. The clip will be labelled as an ad.\n\nHappy to share the exact format and timeline if you are interested.\n\nThanks,\nWayne.clips`;
  });
  api.get('/api/platform-limits').then(l => {
    $('#er-limits').innerHTML = l.limits.map(x => `<p><b>${esc(x.platform)} — ${esc(x.item)}:</b> ${esc(x.value)}<br><span class="note">Source: ${esc(x.source)} · last checked ${esc(x.checkedAt)}</span></p>`).join('');
  }).catch(() => { $('#er-limits').innerHTML = '<p class="lede">Could not load limits.</p>'; });
}
async function viewHub() {
  showApp(`<h1>Hub</h1><p class="lede">The place for all clippers and creators. Wayne.clips records agreements, views and attribution. <b>It does not hold or move money</b> — payouts happen on the campaign platform.</p>
  <div class="panel glass"><h2>Publish a licence</h2>
    <div class="field"><label>Channel</label><input type="text" id="hb-channel" placeholder="e.g. @creator"></div>
    <div class="field"><label>Scope</label><input type="text" id="hb-scope" placeholder="e.g. My 2026 cooking videos, Shorts only"></div>
    <div class="field"><label>Attribution line</label><input type="text" id="hb-attr" placeholder="e.g. Footage: @creator"></div>
    <div class="field"><label>Source video URL (optional — needed for Scout autopilot)</label><input type="text" id="hb-url" placeholder="https://…"></div>
    <div class="field"><label>Expiry date</label><input type="text" id="hb-exp" placeholder="2027-01-01"></div>
    <button class="btn primary" id="hb-pub">Publish licence</button></div>
  <div class="panel glass"><h2>New campaign</h2>
    <div class="field"><label>Brand</label><input type="text" id="hb-brand" placeholder="e.g. Notebook Co"></div>
    <div class="field"><label>Rules</label><input type="text" id="hb-rules" placeholder="e.g. English clips, logo in top half, min 8s"></div>
    <div class="field"><label>Rate per 1,000 verified views ($)</label><input type="text" id="hb-rate" placeholder="e.g. 2.00"></div>
    <div class="field"><label>Cap per clip ($)</label><input type="text" id="hb-cap" placeholder="e.g. 50"></div>
    <button class="btn ghost" id="hb-camp">Post campaign</button></div>
  <div id="hub-lists"></div>`);
  const load = async () => {
    const [{ licences }, { campaigns }] = await Promise.all([api.get('/api/licences'), api.get('/api/campaigns')]);
    $('#hub-lists').innerHTML = `<h2 style="font-family:var(--disp);font-size:24px">LICENCES — ${licences.length}</h2>` +
      licences.map(l => `<article class="card glass" style="margin-bottom:10px"><h3>${esc(l.channel)} — ${esc(l.scope)}</h3><p>Attribution: ${esc(l.attribution || '—')} · Basis: ${esc(l.basis)} · Expires: ${esc(l.expires || '—')} ${l.expires && new Date(l.expires) < new Date() ? '<span class="tag bad">expired — reference only</span>' : ''}</p><div class="row"><button class="btn ghost sm" data-del-lic="${l.id}">Remove</button>${l.sourceUrl ? `<button class="btn mint sm" data-start-job="${esc(l.sourceUrl)}" data-lic="${l.id}">Start a job from this source →</button>` : ''}</div></article>`).join('') +
      `<h2 style="font-family:var(--disp);font-size:24px;margin-top:22px">CAMPAIGNS — ${campaigns.length}</h2>` +
      campaigns.map(c => `<article class="card glass" style="margin-bottom:10px"><h3>${esc(c.brand)}</h3><p>${esc(c.rules)}</p><p class="mono" style="font-size:12px;color:var(--text-2)">Rate: $${c.ratePer1k ?? '—'} / 1,000 verified views · Cap: $${c.cap ?? '—'} · Platforms: ${esc((c.allowedPlatforms || []).join(', '))}</p><div class="row"><button class="btn ghost sm" data-del-camp="${c.id}">Remove</button></div></article>`).join('');
    $$('[data-del-lic]').forEach(b => b.addEventListener('click', async () => { await api.del(`/api/licences/${b.dataset.delLic}`); load(); }));
    $$('[data-del-camp]').forEach(b => b.addEventListener('click', async () => { await api.del(`/api/campaigns/${b.dataset.delCamp}`); load(); }));
    $$('[data-start-job]').forEach(b => b.addEventListener('click', async () => {
      try {
        const j = await api.post('/api/jobs', { sourceUrl: b.dataset.startJob, rightsConfirmed: true, rightsBasis: 'licensed', licenceId: b.dataset.lic, formats: ['9:16'], resolutions: ['1080p'], captionStyle: 'pop', uploadMode: 'review' });
        location.hash = `#/jobs/${j.id}`;
      } catch (e) { toast(e.message); }
    }));
  };
  await load();
  $('#hb-pub').addEventListener('click', async () => {
    try { await api.post('/api/licences', { channel: $('#hb-channel').value.trim(), scope: $('#hb-scope').value.trim(), attribution: $('#hb-attr').value.trim(), sourceUrl: $('#hb-url').value.trim(), expires: $('#hb-exp').value.trim() || null }); toast('Licence published.'); load(); }
    catch (e) { toast(e.message); }
  });
  $('#hb-camp').addEventListener('click', async () => {
    try { await api.post('/api/campaigns', { brand: $('#hb-brand').value.trim(), rules: $('#hb-rules').value.trim(), ratePer1k: +$('#hb-rate').value || null, cap: +$('#hb-cap').value || null }); toast('Campaign posted.'); load(); }
    catch (e) { toast(e.message); }
  });
}
function viewPlaybook() {
  const stages = [
    ['01', 'Find the opportunities', 'Scout’s niche radar. Hype windows fade: build the system for a niche you can keep serving.', '#/scout'],
    ['02', 'Learn the rules', 'The Guard: rights classes, originality (every clip gets a hook, big captions and one line of your own commentary), embargo / spoiler / leak flags, sponsor disclosure, scam checklist (no fee to join a campaign, check payout history, never post leaked footage).', '#/settings'],
    ['03', 'Research with Claude', 'Web-search call plus a typed shortlist. Read the shortlist before acting; rights default to unknown.', '#/scout'],
    ['04', 'Build a faceless page', 'One-sentence angle, names that say what the page does, handle-check links, accounts you control (no bought accounts), no logos that imply an official page.', '#/pages'],
    ['05', 'Automate clipping', 'Ingest, Viral Moments, Render. If the footage has no speech, the page asks for a voiceover first — the transcript would be empty.', '#/new'],
    ['06', 'Subtitles and captions', 'Subtitle agent plus the caption writer: ≤120 chars, 3 hashtags, no spoilers, sponsored clips start with “Ad:”.', '#/studio'],
    ['07', 'Automate publishing', 'Approve gate, private YouTube upload, manual route for platforms without approved access.', '#/jobs'],
    ['08', 'Monetise', 'Campaign maths, platform programmes, sponsorships, ad labels.', '#/earnings'],
    ['09', 'Scale into multiple pages', 'More pages with their own angle, footage and accounts — not more spam. The duplicate guard keeps one clip off two pages.', '#/pages'],
  ];
  const prompts = [
    'I run a faceless short-form page about [niche]. Angle: "[angle]". Give me 10 page names that say what the page does, 3 bio lines under 80 characters that do not imply any brand runs the page, and a 30-day plan with one clip idea per day. Rules: no spoilers, no leaks, only my own footage or authorised footage. Mark any idea that needs footage I may not have rights to.',
    'List five [niche] short-form formats working this week, with one source each, and say which source you could not verify.',
    'Write a 90-word cold email from the owner of a faceless [niche] page to a brand. Include: page angle, platforms, average views over the last 30 days [fill in real numbers], one idea for a sponsored clip, and one line saying the clip will be labelled as an ad. Do not claim reach I have not given you. Do not imply any brand endorses the page.',
  ];
  showApp(`<h1>Playbook</h1><p class="lede">Nine stages, generic for any niche. Every number below comes from platform-limits.json with its source and “last checked” date.</p>
  <div class="cards">${stages.map(([n, t, d, href]) => `<article class="card glass"><h3><span class="mono" style="color:var(--pink)">${n}</span> ${esc(t)}</h3><p>${esc(d)}</p><a class="btn ghost sm" href="${href}">Open the feature →</a></article>`).join('')}</div>
  <h2 style="font-family:var(--disp);font-size:28px;margin-top:26px">COPY-PROMPTS</h2>
  ${prompts.map((p, i) => `<div class="panel glass"><p style="color:var(--text-2);font-size:14px;line-height:1.6">${esc(p)}</p><button class="btn ghost sm" data-copy="${i}">Copy prompt</button></div>`).join('')}
  <div class="panel glass"><h2>Clip approval checklist</h2><p style="color:var(--text-2);font-size:14px;line-height:1.8">${CHECKLIST.map((c, i) => `${i + 1}. ${esc(c)}`).join('<br>')}</p><p class="note">All six must be ticked before Approve on any upload draft.</p></div>`);
  $$('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(prompts[+b.dataset.copy]); toast('Prompt copied.'); }
    catch { toast('Copy failed — select the text manually.'); }
  }));
}
async function viewSettings() {
  showApp(`<h1>Settings</h1><p class="lede">Keys and connections, owned channels, permissions, platform limits and the toolkit probe. Nothing here is faked — a missing key turns its feature off and says so.</p>
  <div class="panel glass"><h2>Toolkit probe <span class="mono">GET /api/toolkit</span></h2><div id="set-tools"><p class="lede">Probing…</p></div></div>
  <div class="panel glass"><h2>Platform limits <span class="mono" id="set-limits-when"></span></h2><div id="set-limits"></div></div>
  <div class="panel glass"><h2>Keys &amp; connections</h2><p class="lede">Set these as environment variables on the server (see .env.example). The UI never asks for secrets in a form.</p>
  <table class="tbl"><tr><th>Key</th><th>What it unlocks</th><th>Status</th></tr>
  <tr><td>ANTHROPIC_API_KEY</td><td>Claude scoring, titles, Scout shortlist</td><td class="mono">—</td></tr>
  <tr><td>YOUTUBE_API_KEY</td><td>Scout live metadata</td><td class="mono">—</td></tr>
  <tr><td>YOUTUBE_ACCESS_TOKEN</td><td>Real YouTube uploads (private by default)</td><td class="mono">—</td></tr>
  <tr><td>REDIS_URL / QUEUE=bullmq</td><td>BullMQ queue instead of in-process</td><td class="mono">—</td></tr></table></div>
  <div class="panel glass"><h2>Owned channels &amp; permissions</h2>
  <div class="field"><label>Owned channel IDs (comma-separated)</label><input type="text" id="set-owned" placeholder="e.g. UCxxxx, UCyyyy"></div>
  <div class="field"><label>Permissions file (JSON: [{channelId, evidence, attribution, expires}])</label><textarea id="set-perm" rows="4" placeholder='[{"channelId":"UC…","evidence":"email 12 Jan","attribution":"Footage: @x","expires":"2027-01-01"}]'></textarea></div>
  <button class="btn primary" id="set-save">Save settings</button></div>`);
  try {
    const { tools } = await api.get('/api/toolkit');
    $('#set-tools').innerHTML = `<table class="tbl"><tr><th>Tool</th><th>Version</th><th>Status</th><th>Note</th></tr>${tools.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.version || '—')}</td><td>${t.status === 'connected' ? '<span class="tag ok">connected</span>' : '<span class="tag warn">not installed</span>'}</td><td>${esc(t.note || '')}</td></tr>`).join('')}</table>`;
  } catch (e) { $('#set-tools').innerHTML = `<p class="lede">Probe failed: ${esc(e.message)}</p>`; }
  try {
    const l = await api.get('/api/platform-limits');
    $('#set-limits-when').textContent = `last checked ${l.checkedAt}`;
    $('#set-limits').innerHTML = `<table class="tbl"><tr><th>Platform</th><th>Item</th><th>Value</th><th>Source / checked</th></tr>${l.limits.map(x => `<tr><td>${esc(x.platform)}</td><td>${esc(x.item)}</td><td>${esc(x.value)}</td><td>${esc(x.source)}<br>${esc(x.checkedAt)}</td></tr>`).join('')}</table>`;
  } catch { $('#set-limits').innerHTML = '<p class="lede">Could not load limits.</p>'; }
  try {
    const { settings } = await api.get('/api/settings');
    $('#set-owned').value = (settings.ownedChannelIds || []).join(', ');
    $('#set-perm').value = settings.permissionsText || '';
  } catch {}
  $('#set-save').addEventListener('click', async () => {
    try {
      await api.post('/api/settings', { settings: { ownedChannelIds: $('#set-owned').value.split(',').map(s => s.trim()).filter(Boolean), permissionsText: $('#set-perm').value } });
      toast('Settings saved.');
    } catch (e) { toast(e.message); }
  });
}

// ---------- palette / paste-anywhere / keys / sound ----------
const COMMANDS = [
  ['Go to the finale — paste a link', 'finale', () => jumpToChapter(5)],
  ['Open the Studio', 'studio', () => location.hash = '#/studio'],
  ['Open Scout', 'scout', () => location.hash = '#/scout'],
  ['Open Playbook', 'playbook', () => location.hash = '#/playbook'],
  ['Open the Hub', 'hub', () => location.hash = '#/hub'],
  ['Open Jobs', 'jobs', () => location.hash = '#/jobs'],
  ['Open Earnings', 'earnings', () => location.hash = '#/earnings'],
  ['New job', 'new', () => location.hash = '#/new'],
  ['Jump to chapter 1 — Scatter', '1', () => jumpToChapter(1)],
  ['Jump to chapter 2 — Pipeline', '2', () => jumpToChapter(2)],
  ['Jump to chapter 3 — Studio', '3', () => jumpToChapter(3)],
  ['Jump to chapter 4 — Hub', '4', () => jumpToChapter(4)],
];
function openPalette() {
  $('#palette').hidden = false;
  const input = $('#palette-input'); input.value = ''; input.focus();
  renderPalette('');
  input.oninput = () => renderPalette(input.value);
  input.onkeydown = e => {
    if (e.key === 'Enter') { const first = $('#palette-list li'); if (first) first.click(); }
    if (e.key === 'Escape') closePalette();
  };
}
function renderPalette(q) {
  const list = COMMANDS.filter(([t]) => t.toLowerCase().includes(q.toLowerCase()));
  $('#palette-list').innerHTML = list.map(([t, k], i) => `<li class="${i === 0 ? 'sel' : ''}" data-ci="${COMMANDS.indexOf(COMMANDS.find(c => c[0] === t))}">${esc(t)}<span>${esc(k)}</span></li>`).join('') || '<li>No match</li>';
  $$('#palette-list li').forEach(li => li.addEventListener('click', () => { closePalette(); COMMANDS[+li.dataset.ci][2](); }));
}
function closePalette() { $('#palette').hidden = true; }
let audioCtx = null, audioOn = false;
function toggleSound() {
  audioOn = !audioOn;
  $('#sound-btn').textContent = audioOn ? 'SOUND ON' : 'SOUND OFF';
  if (audioOn) {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = 55; gain.gain.value = 0.03;
    const osc2 = audioCtx.createOscillator(), gain2 = audioCtx.createGain();
    osc2.type = 'sine'; osc2.frequency.value = 110.5; gain2.gain.value = 0.012;
    osc.connect(gain).connect(audioCtx.destination); osc2.connect(gain2).connect(audioCtx.destination);
    osc.start(); osc2.start();
    audioCtx._nodes = [osc, osc2];
  } else if (audioCtx?._nodes) { audioCtx._nodes.forEach(o => { try { o.stop(); } catch {} }); audioCtx._nodes = null; }
}

// ---------- init ----------
function init() {
  buildRail();
  $('#linkbox-slot').innerHTML = linkBoxHTML('final');
  wireLinkBox('final');
  loadAgentsLanding();
  loadLimitsFoot();
  setStudioMini(0);
  addEventListener('scroll', () => { if (!$('#landing').hidden) onScrollLanding(); }, { passive: true });
  $$('.chapter').forEach((el, i) => el.classList.toggle('on', i === 0));
  $('#nav-paste').addEventListener('click', () => jumpToChapter(5));
  $('#cmdk-btn').addEventListener('click', openPalette);
  $('#sound-btn').addEventListener('click', toggleSound);
  $('#account-btn').addEventListener('click', () => location.hash = '#/settings');
  $('#viewer-close').addEventListener('click', closeViewer);
  $('#viewer').addEventListener('click', e => { if (e.target === $('#viewer')) closeViewer(); });
  $('#viewer-studio').addEventListener('click', () => {
    if (!viewerCtx) return;
    const { jobId, rank } = viewerCtx;
    closeViewer();
    location.hash = `#/studio?job=${jobId}&clip=${rank}`;
  });
  document.addEventListener('keydown', e => {
    const inInput = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#palette').hidden ? openPalette() : closePalette(); return; }
    if (e.key === 'Escape') { closePalette(); if (!$('#viewer').hidden) closeViewer(); }
    if (!inInput && /^[1-6]$/.test(e.key) && !$('#landing').hidden) jumpToChapter(+e.key - 1);
  });
  document.addEventListener('paste', async e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
    const text = (e.clipboardData?.getData('text') || '').trim();
    if (!/^https?:\/\//.test(text)) return;
    e.preventDefault();
    jumpToChapter(5);
    setTimeout(() => {
      const url = $('#final-url');
      if (url) { url.value = text; url.focus(); toast('Link swallowed — paste it into the box when ready. It never submits by itself.'); }
    }, 600);
  });
  // If the 3D scene never reports ready (CDN blocked / no WebGL), show the
  // static fallback instead of a blank canvas.
  setTimeout(() => {
    if (window.__sceneReady !== 'ready') {
      document.getElementById('no-webgl').hidden = false;
      document.getElementById('gl').style.display = 'none';
    }
  }, 5000);
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.goto; }));
  route();
}
document.addEventListener('DOMContentLoaded', init);
