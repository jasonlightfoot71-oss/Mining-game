// Fire & Free Pour Trained — firefreepour.js
(function() {
  const SB_BASE = 'https://awxuqcriwfavqwcagmey.supabase.co/rest/v1';
  const SB_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF3eHVxY3Jpd2ZhdnF3Y2FnbWV5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzAwMDMsImV4cCI6MjA4OTYwNjAwM30.gTZnGQdHlJXFUcsH3dCcHCVZ4hDgHR4YDFNEN9L2PBg';
  const HDRS    = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' };

  let ffpConfig    = { fireTitle: '', pourTitle: '' };
  let ffpParsedData = [];
  let ffpPasteDate  = null;
  let ctStaffNames  = [];
  let ctRoleByName  = {}; // normName(name) → CT's role field, the authoritative source (not the free-text Non-FOH paste label)
  let nameAliases   = {}; // pastedName (norm) → ctName (orig)
  let pendingAliases = []; // fuzzy matches awaiting confirmation

  // Per-person, per-training-type completion tracking. Shape:
  // { [normName]: { fire: 'YYYY-MM-DD'|null, pour: 'YYYY-MM-DD'|null } }
  // Set automatically when a [auto-ffp] task is marked complete (see the
  // _ffpTaskCheck watcher below). Checked by maybeAssign() so a completed
  // person isn't re-nagged daily just because they're still sitting in the
  // pasted list. A fresh paste is still ground truth — buildResults() clears
  // a person's stored completion for a kind the moment a new paste shows
  // them as genuinely outstanding again, so completions never block a real,
  // up-to-date "still not done" result.
  let ffpCompletions = {};
  let _ffpTaskSnap = {}; // taskId → last-seen status, for the watcher below (session-only, see ffpProcessedTaskIds)

  // Persistent (survives reloads/new sessions, unlike _ffpTaskSnap) memory of
  // which [auto-ffp] task IDs have already been used to set a completion.
  // Without this, a fresh paste correctly clearing ffpCompletions[n][kind]
  // back to null (see "fresh paste is ground truth" in buildResults()) gets
  // silently undone the next time ANYONE opens the app: _ffpTaskSnap resets
  // to empty on every new session, so the very next full-history scan below
  // sees that person's old already-complete task as if it just transitioned
  // to complete, finds ffpCompletions[n][kind] now null (falsy), and
  // re-stamps it complete — reviving a stale completion the paste had just
  // overridden. Tracking processed task IDs persistently means a given task
  // can only ever set a completion once, no matter how many times it's
  // rediscovered on reload or how many times a later paste clears the
  // result — only a genuinely new task (new ID) can set it again.
  let ffpProcessedTaskIds = {}; // taskId → true

  // ── Supabase helpers ────────────────────────────────────────
  async function sbGet(table, params) {
    const res = await fetch(`${SB_BASE}/${table}?${params}`, { headers: HDRS });
    return res.ok ? res.json() : [];
  }
  async function sbPost(table, body) {
    // Every caller here writes a key/value row to taskmill_config as an
    // upsert (Prefer: resolution=merge-duplicates), but without telling
    // Postgrest which column is the conflict target, it silently falls
    // back to whatever the table's own primary key happens to be. If
    // that's ever anything other than `key` (e.g. after a Supabase
    // restore recreated the table with a different/no PK), every "save"
    // here starts INSERTing a fresh duplicate row instead of updating
    // the existing one — exactly the kind of thing a crash-and-recovery
    // could silently change. appraisal.js already gets this right for
    // its own taskmill_config writes (apSetFlag, ?on_conflict=key) —
    // this brings firefreepour.js in line with it.
    const url = table === 'taskmill_config' ? `${SB_BASE}/${table}?on_conflict=key` : `${SB_BASE}/${table}`;
    const res = await fetch(url, { method:'POST', headers:HDRS, body: JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`[ffp] sbPost ${table} failed:`, res.status, err);
    }
    return res;
  }

  let currentlyAway = new Map(); // normName → transfer entry (only currently away)

  // ── Init ───────────────────────────────────────────────────
  window.ffpInit = async function() {
    // Config MUST be loaded before the task watcher starts, otherwise it
    // can't tell whether a completed task is Fire or Pour training (the
    // classification is done by matching the task description against
    // ffpConfig.fireTitle/pourTitle) — if the watcher runs first, a
    // completion gets marked "already processed" with no kind recorded and
    // is silently skipped forever, showing as Outstanding permanently even
    // though the task really was completed. Same category of bug as the
    // ffpCompletions race fixed below, just for config instead.
    await loadConfig();
    loadCTStaff();
    loadAliases();
    loadTransfers();
    // Completions MUST be loaded before results render AND before the task
    // watcher's first check, otherwise the watcher can't tell which
    // completed tasks are already recorded vs genuinely new, and results
    // can briefly show someone as Outstanding when they're actually done.
    await loadFfpCompletions();
    // Must also be loaded before the task watcher's first check — it's what
    // stops that first check from re-completing every historically-completed
    // task in one go (see ffpProcessedTaskIds comment above its declaration).
    await loadFfpProcessedTasks();
    loadSavedPaste();
    // Load and show saved results immediately on open
    loadSavedResults();
    ffpSetTab('setup');
    startFfpTaskWatcher();
  };

  // ── Always-on completion watcher ─────────────────────────────
  // Everything above (loadConfig/loadFfpCompletions/loadFfpProcessedTasks/
  // startFfpTaskWatcher) previously only ran inside ffpInit() — which only
  // fires when someone physically opens the Fire & Free Pour page. A
  // completed [auto-ffp] task is ONLY ever turned into an ffpCompletions
  // entry by the watcher those calls start, so on any day nobody happened
  // to open the page, completions never got recorded at all — even though
  // the underlying task genuinely showed complete. The 9am scheduler further
  // down runs unconditionally on every page load regardless of who's
  // visited what, so it kept reading an empty/stale completions map and
  // re-assigning tasks to people who'd already finished them — creating
  // exactly the "unnecessary duplicate work" symptom this was reported as.
  // Running the same four calls here, unconditionally as soon as this
  // script loads, means a completed task gets recorded the moment the next
  // task snapshot fires (see the onSnapshot hook in index.html that calls
  // window._ffpTaskCheck on every change), whether or not anyone ever opens
  // the FFP page. ffpInit() still runs its own copies when the page IS
  // opened — all four are safe to call twice (startFfpTaskWatcher no-ops via
  // ffpWatcherStarted; the loads just refresh state with whatever's current).
  (async function initFfpWatcherOnLoad() {
    await loadConfig();
    await loadFfpCompletions();
    await loadFfpProcessedTasks();
    startFfpTaskWatcher();
  })();

  async function loadFfpCompletions() {
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_completions&select=value&order=updated_at.desc&limit=1');
      if (rows.length && rows[0].value) ffpCompletions = rows[0].value;
      return true;
    } catch(e) { console.warn('[ffp] loadFfpCompletions failed — keeping existing in-memory state:', e.message); return false; }
  }

  async function loadFfpProcessedTasks() {
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_processed_tasks&select=value&order=updated_at.desc&limit=1');
      if (rows.length && rows[0].value) ffpProcessedTaskIds = rows[0].value;
      return true;
    } catch(e) { console.warn('[ffp] loadFfpProcessedTasks failed — keeping existing in-memory state:', e.message); return false; }
  }

  // ── Reload-before-write merge helpers ───────────────────────
  // firefreepour.js is loaded on EVERY page load (see the <script> tag in
  // index.html), not just when someone opens the FFP page — the 9am
  // scheduler at the bottom of this file fires in every open tab/device
  // independently, and the live task-watcher below runs in any tab that
  // has the FFP page open. Each of those holds its own in-memory copy of
  // ffpCompletions / ffpProcessedTaskIds. The old saveFfpCompletions()/
  // saveFfpProcessedTasks() POSTed that whole local object as a blob
  // overwrite with no reload first — this is the exact "reload before
  // write" mistake already learned from a prior FFP bug (see project
  // notes), just re-introduced for these two config rows. Whichever
  // device's save landed last in Supabase won outright, silently
  // discarding any completion another device had just recorded — reviving
  // "not done" state, restamping old completions with today's date, and
  // triggering duplicate re-assignment. These helpers instead reload the
  // current server row immediately before writing and apply only the
  // specific field(s) this call actually changed, so two devices saving
  // around the same time merge instead of clobbering each other.
  async function patchFfpCompletions(patches) { // [{ n, kind, date }] — date:null clears
    if (!patches.length) return;
    let fresh = {};
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_completions&select=value&order=updated_at.desc&limit=1');
      if (rows.length && rows[0].value) fresh = rows[0].value;
    } catch(e) {
      console.warn('[ffp] patchFfpCompletions reload failed — patching local state only, next save will retry the merge:', e.message);
      fresh = { ...ffpCompletions };
    }
    for (const { n, kind, date } of patches) {
      if (!fresh[n]) fresh[n] = { fire: null, pour: null };
      fresh[n][kind] = date;
    }
    ffpCompletions = fresh;
    sbPost('taskmill_config', { key:'ffp_completions', value: ffpCompletions, updated_at: new Date().toISOString() }).catch(()=>{});
  }
  async function patchFfpProcessedTasks(taskIds) { // [taskId, ...]
    if (!taskIds.length) return;
    let fresh = {};
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_processed_tasks&select=value&order=updated_at.desc&limit=1');
      if (rows.length && rows[0].value) fresh = rows[0].value;
    } catch(e) {
      console.warn('[ffp] patchFfpProcessedTasks reload failed — patching local state only, next save will retry the merge:', e.message);
      fresh = { ...ffpProcessedTaskIds };
    }
    for (const id of taskIds) fresh[id] = true;
    ffpProcessedTaskIds = fresh;
    sbPost('taskmill_config', { key:'ffp_processed_tasks', value: ffpProcessedTaskIds, updated_at: new Date().toISOString() }).catch(()=>{});
  }

  // Watches for [auto-ffp] tasks transitioning to 'complete' and records a
  // completion date per person+training-type, so maybeAssign() can skip them
  // going forward without needing the pasted list to change. Hooks into the
  // same global task-snapshot refresh cycle used by appraisal.js's watchers
  // (window._appData, refreshed on every Firestore task-list snapshot).
  let ffpWatcherStarted = false;
  function startFfpTaskWatcher() {
    if (ffpWatcherStarted) return;
    ffpWatcherStarted = true;
    const TAG = '[auto-ffp]';

    // Refreshes ffpCompletions AND the saved outstanding/missing lists
    // from Supabase, re-rendering if either actually changed. This is
    // what makes a fresh paste done on one device — which updates BOTH
    // ffp_completions (clearing stale completions) and ffp_results (the
    // outstanding/missing lists themselves) — visible on any OTHER
    // device already sitting on the FFP results page. Both were
    // previously only ever loaded once, at page-open (ffpInit →
    // loadFfpCompletions/loadSavedResults), so an already-open device
    // had no way to notice either had changed elsewhere; it just kept
    // showing its own stale page-open-time snapshot indefinitely —
    // "marked complete" for someone a fresh paste had already cleared
    // server-side, or an outstanding list that no longer matched reality.
    // Piggybacks on the same onSnapshot cadence _ffpTaskCheck already
    // runs on rather than adding a separate poll timer, throttled since
    // that cadence fires on every task change anywhere in the whole app,
    // not just FFP-related ones.
    let _ffpLastLiveRefresh = 0;
    async function refreshFfpLiveStateIfChanged() {
      const now = Date.now();
      if (now - _ffpLastLiveRefresh < 30000) return; // throttle to once per 30s
      _ffpLastLiveRefresh = now;
      const resultsEl = document.getElementById('ffp-results-body');
      if (!resultsEl) return; // nobody's looking at results right now — nothing to keep fresh
      try {
        const [compRows, resRows] = await Promise.all([
          sbGet('taskmill_config', 'key=eq.ffp_completions&select=value&order=updated_at.desc&limit=1'),
          sbGet('taskmill_config', 'key=eq.ffp_results&select=value&order=updated_at.desc&limit=1'),
        ]);
        let changed = false;
        if (compRows.length && compRows[0].value && JSON.stringify(compRows[0].value) !== JSON.stringify(ffpCompletions)) {
          ffpCompletions = compRows[0].value;
          changed = true;
        }
        // ffp_results itself isn't cached in a module-level variable — it's
        // rendered straight from the fetch in loadSavedResults()/renderSavedResults(),
        // so just checking its updated_at against what's already on screen
        // (via the panel's own last-rendered timestamp) tells us whether a
        // re-render is worth doing at all.
        const lastShown = resultsEl.dataset.updatedAt || '';
        if (resRows.length && resRows[0].value && resRows[0].value.updatedAt && resRows[0].value.updatedAt !== lastShown) {
          changed = true;
        }
        if (changed && window.ffpReloadResults) window.ffpReloadResults();
      } catch(e) { console.warn('[ffp] live state refresh failed:', e.message); }
    }

    window._ffpTaskCheck = async function() {
      refreshFfpLiveStateIfChanged().catch(()=>{});
      const allTasks = window._appData || {};
      const toRecord = []; // { normName, kind, taskId }
      // Every taskId that needs stamping as processed this run, whether it's
      // a genuinely new completion (toRecord below) or an already-known one
      // being rediscovered (a few lines down) — both cases must reach
      // Supabase via patchFfpProcessedTasks(), not just the first, or the
      // "process a task ID once, ever" guarantee doesn't survive a reload.
      const processedIdsToPatch = [];

      // Scan every date, not just today. A task can be marked complete on
      // any day, including days nobody had the app open — if we only ever
      // looked at today's date key, a completion from yesterday (or any
      // earlier day) would never be seen at all once today's date rolls
      // over, and would be stuck showing Outstanding forever. The
      // protection against the OLD bug (re-triggering long-past
      // completions as if they were brand new) is the ffpCompletions check
      // below, not date-scoping — that's what actually distinguishes
      // "already recorded" from "genuinely new".
      Object.values(allTasks).forEach(dayTasks => {
        (dayTasks || []).forEach(t => {
          if (!(t.description || '').includes(TAG)) return;
          if (t.status !== 'complete') {
            _ffpTaskSnap[t.id] = t.status;
            return;
          }
          // Persisted check FIRST: this is what actually survives a reload
          // or a new session, unlike _ffpTaskSnap below. Without it, the
          // very first scan of a fresh session sees every historically-
          // completed [auto-ffp] task as if it just transitioned to
          // complete (since _ffpTaskSnap starts empty every session), and
          // — if a paste since then has cleared the resulting completion
          // back to null via buildResults()'s "fresh paste is ground
          // truth" logic — silently re-marks it complete again, undoing
          // the paste's override. A task ID can only ever set a completion
          // once, no matter how many times it's rediscovered afterwards.
          if (ffpProcessedTaskIds[t.id]) { _ffpTaskSnap[t.id] = 'complete'; return; }

          const wasComplete = _ffpTaskSnap[t.id] === 'complete';
          _ffpTaskSnap[t.id] = 'complete';
          if (wasComplete) return; // already processed this session

          const desc = (t.description || '').toLowerCase();
          let kind = null;
          if (ffpConfig.fireTitle && desc.includes(ffpConfig.fireTitle.toLowerCase())) kind = 'fire';
          else if (ffpConfig.pourTitle && desc.includes(ffpConfig.pourTitle.toLowerCase())) kind = 'pour';
          if (!kind || !t.lead) return;

          const n = normName(t.lead);
          // Already recorded as complete in the persisted data — nothing
          // new to do, but still mark this task ID as processed so it
          // can't resurrect the completion later if a paste clears it.
          if (ffpCompletions[n]?.[kind]) { ffpProcessedTaskIds[t.id] = true; processedIdsToPatch.push(t.id); return; }

          toRecord.push({ normName: n, kind, taskId: t.id });
        });
      });

      const today = new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'}).split('/').reverse().join('-');
      const completionPatches = []; // [{ n, kind, date }]
      for (const { normName: n, kind, taskId } of toRecord) {
        if (!ffpCompletions[n]) ffpCompletions[n] = { fire: null, pour: null };
        if (ffpCompletions[n][kind] !== today) {
          ffpCompletions[n][kind] = today;
          completionPatches.push({ n, kind, date: today });
        }
        ffpProcessedTaskIds[taskId] = true;
        processedIdsToPatch.push(taskId);
      }
      // Persist processed-task memory any time this run touched it at all —
      // not gated behind toRecord having entries, since the everyday case
      // (old completions being rediscovered, nothing new) is exactly the
      // case that must be persisted for the "process once, ever" guarantee
      // to survive a reload. patchFfpProcessedTasks()/patchFfpCompletions()
      // reload the current Supabase row first and merge just these specific
      // IDs/fields into it, so a save from another device around the same
      // time doesn't get silently overwritten (or overwrite this one).
      if (processedIdsToPatch.length) await patchFfpProcessedTasks(processedIdsToPatch);
      if (completionPatches.length) {
        await patchFfpCompletions(completionPatches);
        // Re-render the Results view if it exists in the DOM, so anyone
        // currently on that page sees the updated status immediately —
        // previously this only updated the underlying data, leaving
        // whatever was already on screen stale until a manual refresh.
        if (document.getElementById('ffp-results-body') && window.ffpReloadResults) {
          window.ffpReloadResults();
        }
      }
    };
    // Run on first call so initial state is captured
    if (window.data) { window._appData = window.data; window._ffpTaskCheck().catch(()=>{}); }
  }

  async function loadSavedPaste() {
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_paste&select=value&order=updated_at.desc&limit=1');
      if (rows.length && rows[0].value?.rows) {
        ffpParsedData = rows[0].value.rows;
        ffpPasteDate  = rows[0].value.pasteDate || null;
        console.log(`[ffp] Loaded saved paste: ${ffpParsedData.length} rows from ${ffpPasteDate}`);
      }
    } catch(e) { console.warn('[ffp] loadSavedPaste:', e.message); }
  }

  async function loadSavedResults() {
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_results&select=value&order=updated_at.desc&limit=1');
      if (!rows.length || !rows[0].value) return;
      const r = rows[0].value;
      ffpPasteDate = r.pasteDate || null;
      // Render saved results directly
      renderSavedResults(r);
    } catch(e) { console.warn('[ffp] loadSavedResults:', e.message); }
  }

  function renderSavedResults(r) {
    const el = document.getElementById('ffp-results-body');
    if (!el) return;
    const isAdmin = window.currentUser && window.currentUser.email === 'jasonlightfoot71@gmail.com';
    const adminBtn = isAdmin ? `<div style="margin-bottom:12px;">
      <button onclick="window.ffpAssignToday()" style="padding:7px 14px;background:var(--gold);color:#0c0b09;border:none;border-radius:7px;font-weight:700;cursor:pointer;font-family:DM Mono,monospace;font-size:11px;">⚡ Assign Outstanding Tasks for Today</button>
    </div>` : '';
    const { fireOutstanding=[], pourOutstanding=[], fireMissing=[], pourMissing=[], allAway=[], pasteDate, updatedAt, fireTitle, pourTitle } = r;
    // Use saved titles as fallback — ffpConfig may not have loaded yet due to
    // the race between loadConfig() and loadSavedResults() in ffpInit()
    const fireLabel = ffpConfig.fireTitle || fireTitle || '';
    const pourLabel = ffpConfig.pourTitle || pourTitle || '';

    function section(emoji, label, outstanding, missing, kind) {
      if (!label) return '';
      let rowIdx = 0;
      const rows = [
        ...outstanding.map(n=>{
          const completedDate = ffpCompletions[normName(n)]?.[kind];
          const idAttr = ` class="ffp-res-${kind}-row"${rowIdx++ === 0 ? ` id="ffp-res-${kind}-row-0"` : ''}`;
          return completedDate
            ? `<div${idAttr} style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);"><span>🟡</span><div><div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div><div style="font-family:DM Mono,monospace;font-size:9px;color:var(--amber);">Marked complete ${completedDate} — awaiting next paste</div></div></div>`
            : `<div${idAttr} style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);"><span>🔴</span><div><div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div><div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);">Outstanding</div></div></div>`;
        }),
        ...missing.map(n=>{
          const idAttr = ` class="ffp-res-${kind}-row"${rowIdx++ === 0 ? ` id="ffp-res-${kind}-row-0"` : ''}`;
          return `<div${idAttr} style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);"><span>⚫</span><div><div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div><div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);">Not in training system</div></div></div>`;
        })
      ];
      return `<div style="margin-bottom:20px;">
        <div id="ffp-res-${kind}-title" style="font-family:DM Mono,monospace;font-size:9px;color:var(--gold);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">${emoji} ${esc(label)}</div>
        ${rows.length===0?`<div style="font-family:DM Mono,monospace;font-size:12px;color:var(--green);padding:10px 0;">✅ All staff trained</div>`:
          `<div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);margin-bottom:8px;">${rows.length} not trained</div>${rows.join('')}`}
      </div>`;
    }

    const awayHTML = allAway.length ? `<div style="margin-bottom:20px;">
      <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">✈️ Away from Pub — Not Required</div>
      ${allAway.map(n=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);"><span>✈️</span><div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div></div>`).join('')}
    </div>` : '';

    el.innerHTML = `
      ${adminBtn}
      <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);margin-bottom:14px;">
        Paste from ${esc(pasteDate||'?')} · Last updated ${updatedAt ? new Date(updatedAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}) : '?'}
      </div>
      ${section('🔥', fireLabel, fireOutstanding, fireMissing, 'fire')}
      ${section('🍺', pourLabel, pourOutstanding, pourMissing, 'pour')}
      ${awayHTML}
      <div style="margin-top:10px;font-family:DM Mono,monospace;font-size:9px;color:var(--muted);">
        🔴 Outstanding &nbsp;·&nbsp; 🟡 Marked complete, awaiting next paste &nbsp;·&nbsp; ⚫ Not in training system &nbsp;·&nbsp; ✈️ Away from pub
      </div>`;
    el.dataset.updatedAt = updatedAt || '';

    // Switch to results tab
    ffpSetTab('results');
  }

  async function loadTransfers() {
    try {
      const { doc, getDoc } = window._fbFns || {};
      if (!doc || !getDoc || !window.db) return;
      const snap = await getDoc(doc(window.db, 'taskmill_transfers', 'shared'));
      if (!snap.exists()) return;
      const today = new Date(); today.setHours(0,0,0,0);
      const transfers = snap.data().transfers || [];
      currentlyAway = new Map();
      transfers.forEach(t => {
        const name = normName(t.name||'');
        if (!name) return;

        if (t.studentType === 'non-term-time') {
          // Non-term student: away when today is before dateReturnNonTerm OR after dateLeave
          const retDate   = t.dateReturnNonTerm ? new Date(t.dateReturnNonTerm+'T00:00:00') : null;
          const leaveDate = t.dateLeave         ? new Date(t.dateLeave+'T00:00:00')         : null;
          // Currently away = not yet returned, or already left again
          const notYetBack  = retDate   && today < retDate;
          const leftAgain   = leaveDate && today >= leaveDate;
          if (notYetBack || leftAgain) currentlyAway.set(name, t);
        } else {
          // Standard transfer: away from dateOut until dateReturn
          const out = t.dateOut ? new Date(t.dateOut+'T00:00:00') : null;
          if (!out || out > today) return;
          if (t.dateReturn && t.dateReturn !== 'NOT_RETURNING') {
            const ret = new Date(t.dateReturn+'T00:00:00');
            if (ret <= today) return;
          }
          currentlyAway.set(name, t);
        }
      });
    } catch(e) { console.warn('[ffp] transfers load:', e.message); }
  }

  // ── Config ─────────────────────────────────────────────────
  async function loadConfig() {
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_settings&select=value&order=updated_at.desc&limit=1');
      if (rows.length) ffpConfig = { ...ffpConfig, ...rows[0].value };
    } catch(e) {
      try { const c = localStorage.getItem('taskmill_ffp_config'); if(c) ffpConfig = {...ffpConfig,...JSON.parse(c)}; } catch(e2){}
    }
    applyConfigToUI();
  }

  function applyConfigToUI() {
    const f = document.getElementById('ffp-fire-title');
    const p = document.getElementById('ffp-pour-title');
    if (f) f.value = ffpConfig.fireTitle || '';
    if (p) p.value = ffpConfig.pourTitle || '';
  }

  window.ffpSaveSetup = async function() {
    ffpConfig.fireTitle = (document.getElementById('ffp-fire-title')?.value||'').trim();
    ffpConfig.pourTitle = (document.getElementById('ffp-pour-title')?.value||'').trim();
    localStorage.setItem('taskmill_ffp_config', JSON.stringify(ffpConfig));
    const msg = document.getElementById('ffp-setup-msg');
    try {
      const res = await sbPost('taskmill_config', { key:'ffp_settings', value:ffpConfig, updated_at: new Date().toISOString() });
      if (res.ok) {
        if (msg) { msg.textContent='✅ Settings saved.'; msg.style.color='var(--green)'; }
      } else {
        if (msg) { msg.textContent='⚠️ Saved locally only — check console.'; msg.style.color='var(--amber)'; }
      }
    } catch(e) {
      console.warn('[ffp] save error:', e);
      if (msg) { msg.textContent='✅ Saved locally only.'; msg.style.color='var(--amber)'; }
    }
  };

  // ── CT Staff ───────────────────────────────────────────────
  let ctLeaverNames = new Set(); // normalised names of status 3/5 staff

  async function loadCTStaff() {
    try {
      let staff = [];
      if (window._ctrkAllStaff && window._ctrkAllStaff.length) {
        staff = window._ctrkAllStaff;
      } else {
        const rows = await sbGet('compliance_staff', 'select=data&order=name');
        staff = rows.map(r => r.data || {});
      }
      ctStaffNames = staff.map(s=>(s.name||'').trim()).filter(Boolean);
      ctRoleByName = {};
      staff.forEach(s => { if (s.name) ctRoleByName[normName(s.name)] = (s.role||'').trim(); });
      ctLeaverNames = new Set(
        staff
          .filter(s => [3,5].includes(parseInt(s.status_num)))
          .map(s => normName((s.name||'').trim()))
          .filter(Boolean)
      );
    } catch(e) { console.warn('[ffp] CT staff:', e.message); }
  }

  // ── Aliases ────────────────────────────────────────────────
  async function loadAliases() {
    try {
      const rows = await sbGet('taskmill_config', 'key=eq.ffp_aliases&select=value&order=updated_at.desc&limit=1');
      if (rows.length) nameAliases = rows[0].value || {};
    } catch(e) {}
  }

  async function saveAliases() {
    await sbPost('taskmill_config', { key:'ffp_aliases', value:nameAliases });
  }

  // Confirm a pending alias
  window.ffpConfirmAlias = async function(pastedNorm, ctOrig) {
    nameAliases[pastedNorm] = ctOrig;
    await saveAliases();
    pendingAliases = pendingAliases.filter(a => a.pastedNorm !== pastedNorm);
    buildResults();
  };

  window.ffpRejectAlias = function(pastedNorm) {
    nameAliases[pastedNorm] = '';
    saveAliases();
    pendingAliases = pendingAliases.filter(a => a.pastedNorm !== pastedNorm);
    buildResults();
  };

  window.ffpClearAlias = async function(pastedNorm) {
    delete nameAliases[pastedNorm];
    await saveAliases();
    buildResults();
  };

  // ── Fuzzy matching ─────────────────────────────────────────
  // Simple similarity: share same surname + at least one common word
  function isFuzzyMatch(a, b) {
    const wa = a.split(' ');
    const wb = b.split(' ');
    // Same surname (last word)?
    if (wa[wa.length-1] !== wb[wb.length-1]) return false;
    // First names share a prefix (dave/david, chris/christopher etc)
    const fa = wa[0], fb = wb[0];
    if (fa === fb) return false; // exact match already handled
    return fa.startsWith(fb.slice(0,3)) || fb.startsWith(fa.slice(0,3));
  }

  // Resolve a pasted name to a CT name using aliases or fuzzy
  function resolveName(pastedOrig) {
    const n = normName(pastedOrig);
    // Exact CT match (case-insensitive) — return the CT name's correct
    // casing/spelling, not the pasted string, even though they matched.
    // Previously this returned pastedOrig here, so a pasted name that
    // differed only in casing (e.g. "Sabrina Mccann" vs CT's "Sabrina
    // McCann") would still match successfully but then get used verbatim
    // with the wrong casing anyway — creating what looked like two
    // different people on the dashboard.
    const exactMatch = ctStaffNames.find(c => normName(c) === n);
    if (exactMatch) return { ctName: exactMatch, exact: true };
    // Saved alias
    if (nameAliases[n] !== undefined) {
      return nameAliases[n] ? { ctName: nameAliases[n], exact: true, aliased: true } : { ctName: pastedOrig, exact: false, rejected: true };
    }
    // Fuzzy
    const fuzzy = ctStaffNames.find(c => isFuzzyMatch(n, normName(c)));
    if (fuzzy) return { ctName: fuzzy, exact: false, fuzzy: true, pastedNorm: n };
    return { ctName: pastedOrig, exact: false };
  }

  // ── Tabs ───────────────────────────────────────────────────
  window.ffpAssignToday = async function() {
    const btn = document.querySelector('[onclick="window.ffpAssignToday()"]');
    if (btn) { btn.textContent = 'Assigning…'; btn.disabled = true; }
    await ffpAutoAssign(true); // force = bypass daily flag
    if (btn) { btn.textContent = '✓ Done'; setTimeout(() => { btn.textContent = '⚡ Assign Outstanding Tasks for Today'; btn.disabled = false; }, 2000); }
    loadSavedResults();
  };

  window.ffpReloadResults = function() { loadSavedResults(); };
  window.ffpSetTab = function(tab) {
    ['setup','paste','results'].forEach(t => {
      const p = document.getElementById(`ffp-panel-${t}`);
      const b = document.getElementById(`ffp-tab-${t}`);
      if (p) p.style.display = t===tab ? '' : 'none';
      if (b) b.classList.toggle('active', t===tab);
    });
    if (tab==='setup') applyConfigToUI();
  };

  // ── Paste ──────────────────────────────────────────────────
  window.ffpClear = function() {
    const el = document.getElementById('ffp-paste-area');
    if (el) el.value = '';
    const msg = document.getElementById('ffp-paste-msg');
    if (msg) msg.textContent = '';
  };

  window.ffpClearSavedPaste = async function() {
    ffpParsedData = [];
    ffpPasteDate  = null;
    try {
      await fetch(`${SB_BASE}/taskmill_config?key=eq.ffp_paste`, {
        method: 'DELETE',
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
    } catch(e) {}
    const msg = document.getElementById('ffp-paste-msg');
    if (msg) { msg.textContent = '🗑 Saved paste cleared.'; msg.style.color = 'var(--muted)'; }
    document.getElementById('ffp-results-body').innerHTML = '<div style="color:var(--muted);font-family:DM Mono,monospace;font-size:12px;padding:20px;text-align:center;">Paste data and run report first.</div>';
  };

  window.ffpParse = async function() {
    const raw = (document.getElementById('ffp-paste-area')?.value||'').trim();
    const msg = document.getElementById('ffp-paste-msg');
    if (!raw) { if(msg){msg.textContent='Nothing to parse.';msg.style.color='var(--muted)';} return; }
    if (!ffpConfig.fireTitle && !ffpConfig.pourTitle) {
      if(msg){msg.textContent='Set at least one title filter in Setup first.';msg.style.color='var(--red)';}
      ffpSetTab('setup'); return;
    }
    const lines = raw.split('\n').filter(l=>l.trim());
    ffpParsedData = [];
    for (const line of lines) {
      const cols = line.split('\t');
      if (cols.length < 8) continue;
      const empName  = (cols[2]||'').trim();
      const title    = (cols[7]||'').trim();
      const status   = (cols[6]||'').trim();
      const compDate = (cols[8]||'').trim();
      if (!empName || empName==='Employee Name') continue;
      ffpParsedData.push({ name:empName, title, status, compDate });
    }
    // Save paste to Supabase — trim to essential fields only to keep payload small
    const pasteDate = new Date().toISOString().slice(0,10);
    ffpPasteDate = pasteDate;
    const trimmedRows = ffpParsedData.map(r => ({ name:r.name, title:r.title, status:r.status }));
    console.log('[ffp] saving paste to Supabase, rows:', trimmedRows.length, 'approx bytes:', JSON.stringify(trimmedRows).length);
    const saveRes = await fetch(`${SB_BASE}/taskmill_config?on_conflict=key`, {
      method: 'POST',
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ key:'ffp_paste', value:{ rows:trimmedRows, pasteDate }, updated_at: new Date().toISOString() })
    });
    if (!saveRes.ok) {
      const err = await saveRes.text();
      console.error('[ffp] paste save failed:', saveRes.status, err);
    }
    // Verify it saved
    let verified = false;
    try {
      const check = await sbGet('taskmill_config', 'key=eq.ffp_paste&select=key');
      verified = check.length > 0;
    } catch(e) {}
    if(msg){msg.textContent=`✅ Parsed ${ffpParsedData.length} rows. ${verified?'Saved to cloud ✓':'⚠️ Cloud save failed — check console'}`;msg.style.color=verified?'var(--green)':'var(--amber)';}
    buildResults();
    ffpSetTab('results');
  };

  // ── Results ────────────────────────────────────────────────
  function buildResults() {
    const el = document.getElementById('ffp-results-body');
    if (!el) return;

    const fireFilter = ffpConfig.fireTitle.toLowerCase();
    const pourFilter = ffpConfig.pourTitle.toLowerCase();
    const fireStatus = {}, pourStatus = {};
    const namesInPaste = new Set();
    pendingAliases = [];

    for (const row of ffpParsedData) {
      const resolved = resolveName(row.name);
      const ctNorm   = normName(resolved.ctName);
      const title    = row.title.toLowerCase();
      namesInPaste.add(ctNorm);

      // Track fuzzy matches needing confirmation
      if (resolved.fuzzy && !pendingAliases.some(a=>a.pastedNorm===resolved.pastedNorm)) {
        pendingAliases.push({ pastedNorm: resolved.pastedNorm, pastedOrig: row.name, ctName: resolved.ctName });
      }

      if (fireFilter && title.includes(fireFilter)) {
        if (!fireStatus[ctNorm] || row.status==='Completed')
          fireStatus[ctNorm] = { status:row.status, compDate:row.compDate, origName:resolved.ctName };
      }
      if (pourFilter && title.includes(pourFilter)) {
        if (!pourStatus[ctNorm] || row.status==='Completed')
          pourStatus[ctNorm] = { status:row.status, compDate:row.compDate, origName:resolved.ctName };
      }
    }

    const fireOutstanding = Object.entries(fireStatus).filter(([n,v]) => v.status!=='Completed' && !currentlyAway.has(n) && !ctLeaverNames.has(n)).map(([,v])=>v.origName);
    const pourOutstanding = Object.entries(pourStatus).filter(([n,v]) => v.status!=='Completed' && !currentlyAway.has(n) && !ctLeaverNames.has(n)).map(([,v])=>v.origName);
    const fireMissing = ctStaffNames.filter(n => !namesInPaste.has(normName(n)) && !currentlyAway.has(normName(n)) && !ctLeaverNames.has(normName(n)) && fireFilter);
    const pourMissing = ctStaffNames.filter(n => !namesInPaste.has(normName(n)) && !currentlyAway.has(normName(n)) && !ctLeaverNames.has(normName(n)) && pourFilter);

    // Fresh paste is ground truth: anyone it shows as genuinely outstanding
    // has their stored task-completion cleared, so a real "still not done"
    // result is never silently blocked by an earlier completed reminder task.
    const clearPatches = []; // [{ n, kind, date:null }]
    for (const origName of [...fireOutstanding, ...fireMissing]) {
      const n = normName(origName);
      if (ffpCompletions[n]?.fire) { ffpCompletions[n].fire = null; clearPatches.push({ n, kind:'fire', date:null }); }
    }
    for (const origName of [...pourOutstanding, ...pourMissing]) {
      const n = normName(origName);
      if (ffpCompletions[n]?.pour) { ffpCompletions[n].pour = null; clearPatches.push({ n, kind:'pour', date:null }); }
    }
    if (clearPatches.length) patchFfpCompletions(clearPatches).catch(e=>console.warn('[ffp] clear-completion patch failed:', e.message));

    // People away from pub who would otherwise appear as not trained
    const fireAway = Object.entries(fireStatus).filter(([n,v]) => v.status!=='Completed' && currentlyAway.has(n) && !ctLeaverNames.has(n)).map(([,v])=>v.origName);
    const pourAway = Object.entries(pourStatus).filter(([n,v]) => v.status!=='Completed' && currentlyAway.has(n) && !ctLeaverNames.has(n)).map(([,v])=>v.origName);
    const fireMissingAway = ctStaffNames.filter(n => !namesInPaste.has(normName(n)) && currentlyAway.has(normName(n)) && !ctLeaverNames.has(normName(n)) && fireFilter);
    const pourMissingAway = ctStaffNames.filter(n => !namesInPaste.has(normName(n)) && currentlyAway.has(normName(n)) && !ctLeaverNames.has(normName(n)) && pourFilter);
    const allAway = [...new Set([...fireAway, ...pourAway, ...fireMissingAway, ...pourMissingAway])];

    // Save computed results to Supabase — much smaller than raw paste
    // Include the title labels so renderSavedResults can display correctly
    // even if ffpConfig hasn't loaded yet (race condition on page open)
    const savedResults = { fireOutstanding, pourOutstanding, fireMissing, pourMissing, allAway, pasteDate: ffpPasteDate, updatedAt: new Date().toISOString(), fireTitle: ffpConfig.fireTitle, pourTitle: ffpConfig.pourTitle };
    sbPost('taskmill_config', { key:'ffp_results', value: savedResults, updated_at: new Date().toISOString() }).catch(()=>{});

    // Alias confirmation cards
    const aliasHTML = pendingAliases.length ? `
      <div style="background:rgba(212,160,23,.08);border:1px solid var(--gold);border-radius:10px;padding:12px;margin-bottom:16px;">
        <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--gold);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">🔍 Name Matches — Please Confirm</div>
        ${pendingAliases.map(a=>`
          <div style="padding:8px 0;border-bottom:1px solid var(--border);" id="alias-row-${btoa(a.pastedNorm).replace(/=/g,'')}">
            <div style="font-family:DM Mono,monospace;font-size:11px;margin-bottom:6px;">
              Is <strong>${esc(a.pastedOrig)}</strong> the same person as <strong>${esc(a.ctName)}</strong>?
            </div>
            <div style="display:flex;gap:8px;">
              <button data-pasted="${esc(a.pastedNorm)}" data-ct="${esc(a.ctName)}" onclick="ffpConfirmAlias(this.dataset.pasted,this.dataset.ct)"
                style="padding:4px 12px;background:var(--green);color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:DM Mono,monospace;font-size:10px;font-weight:700;">✓ Yes, same person</button>
              <button data-pasted="${esc(a.pastedNorm)}" onclick="ffpRejectAlias(this.dataset.pasted)"
                style="padding:4px 12px;background:var(--surface);color:var(--text);border:1px solid var(--border2);border-radius:6px;cursor:pointer;font-family:DM Mono,monospace;font-size:10px;">✗ Different person</button>
            </div>
          </div>`).join('')}
      </div>` : '';

    // Saved aliases panel
    const savedAliases = Object.entries(nameAliases).filter(([,v])=>v);
    const aliasListHTML = savedAliases.length ? `
      <div style="margin-bottom:16px;">
        <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Saved Name Matches</div>
        ${savedAliases.map(([pasted,ct])=>`
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-family:DM Mono,monospace;font-size:10px;">
            <span style="color:var(--muted);">${esc(pasted)}</span>
            <span style="color:var(--muted);">→</span>
            <span>${esc(ct)}</span>
            <button data-pasted="${esc(pasted)}" onclick="ffpClearAlias(this.dataset.pasted)" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:11px;margin-left:auto;">✕</button>
          </div>`).join('')}
      </div>` : '';

    function section(emoji, label, outstanding, missing, kind) {
      if (!label) return '';
      let rowIdx = 0;
      const rows = [
        ...outstanding.map(n=>{
          const completedDate = ffpCompletions[normName(n)]?.[kind];
          const idAttr = ` class="ffp-res-${kind}-row"${rowIdx++ === 0 ? ` id="ffp-res-${kind}-row-0"` : ''}`;
          return completedDate
            ? `<div${idAttr} style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);">
                <span>🟡</span>
                <div>
                  <div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div>
                  <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--amber);">Marked complete ${completedDate} — awaiting next paste</div>
                </div></div>`
            : `<div${idAttr} style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);">
                <span>🔴</span>
                <div>
                  <div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div>
                  <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);">Outstanding</div>
                </div></div>`;
        }),
        ...missing.map(n=>{
          const idAttr = ` class="ffp-res-${kind}-row"${rowIdx++ === 0 ? ` id="ffp-res-${kind}-row-0"` : ''}`;
          return `<div${idAttr} style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);">
          <span>⚫</span>
          <div>
            <div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div>
            <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);">Not in training system</div>
          </div></div>`;
        })
      ];
      return `<div style="margin-bottom:20px;">
        <div id="ffp-res-${kind}-title" style="font-family:DM Mono,monospace;font-size:9px;color:var(--gold);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">${emoji} ${esc(label)}</div>
        ${rows.length===0
          ? `<div style="font-family:DM Mono,monospace;font-size:12px;color:var(--green);padding:10px 0;">✅ All staff trained</div>`
          : `<div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);margin-bottom:8px;">${rows.length} not trained</div>${rows.join('')}`}
      </div>`;
    }

    const awayHTML = allAway.length ? `
      <div style="margin-bottom:20px;">
        <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">✈️ Away from Pub — Not Required</div>
        <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);margin-bottom:8px;">${allAway.length} staff currently on transfer — excluded from report</div>
        ${allAway.map(n=>`<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);">
          <span>✈️</span>
          <div>
            <div style="font-family:DM Mono,monospace;font-size:12px;font-weight:600;">${esc(n)}</div>
            <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);">
              ${(()=>{ const t=currentlyAway.get(normName(n)); return t ? `Away since ${t.dateOut||'?'}${t.dateReturn&&t.dateReturn!=='NOT_RETURNING'?' · returning '+t.dateReturn:t.dateReturn==='NOT_RETURNING'?' · not returning':''}`:''; })()}
            </div>
          </div>
        </div>`).join('')}
      </div>` : '';

    el.innerHTML = `
      <div style="font-family:DM Mono,monospace;font-size:9px;color:var(--muted);margin-bottom:14px;">
        Report generated ${new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})} · ${ffpParsedData.length} rows · ${ctStaffNames.length} CT staff
      </div>
      ${aliasHTML}
      ${section('🔥', ffpConfig.fireTitle, fireOutstanding, fireMissing, 'fire')}
      ${section('🍺', ffpConfig.pourTitle, pourOutstanding, pourMissing, 'pour')}
      ${awayHTML}
      ${aliasListHTML}
      <div style="margin-top:10px;font-family:DM Mono,monospace;font-size:9px;color:var(--muted);">
        🔴 Outstanding &nbsp;·&nbsp; 🟡 Marked complete, awaiting next paste &nbsp;·&nbsp; ⚫ Not in training system &nbsp;·&nbsp; ✈️ Away from pub
      </div>`;
    el.dataset.updatedAt = savedResults.updatedAt;
  }

  // ── Auto task assignment ────────────────────────────────────
  window.ffpAutoAssign = async function(force = false) {
    // Prevents two overlapping executions (e.g. two open tabs/devices both
    // triggering their own catch-up run, or a backgrounded tab's timer
    // firing late alongside a fresh one) from each reading a "nobody's
    // been assigned yet" state before either has finished writing, and
    // both ending up creating the exact same set of duplicate tasks. The
    // once-daily flag below only gets set at the END of a successful run,
    // so it can't catch two runs that both start before either finishes.
    if (window._ffpAutoAssignRunning) {
      console.log('[ffp] auto-assign already in progress — skipping this call');
      return;
    }
    window._ffpAutoAssignRunning = true;
    try {
      const { doc, getDoc, setDoc } = window._fbFns || {};
      if (!doc || !getDoc || !window.db) return;

      const todayKey = new Date().toLocaleDateString('en-GB',{timeZone:'Europe/London'}).split('/').reverse().join('-');
      const assignDateKey = todayKey;

      if (!force) {
        try {
          const flagRows = await sbGet('taskmill_config', 'key=eq.ffp_autoassign_flag&select=value&order=updated_at.desc&limit=1');
          if (flagRows.length && flagRows[0].value && flagRows[0].value.date === todayKey) {
            console.log('[ffp] auto-assign already ran today — skipping');
            return;
          }
        } catch(e) {}
      }

      // Ensure title-filter config is loaded — it's normally only loaded when
      // the FFP page is opened (ffpInit), but the scheduled run can fire in a
      // session where nobody has opened that page yet.
      if (!ffpConfig.fireTitle && !ffpConfig.pourTitle) await loadConfig();
      if (!ffpConfig.fireTitle && !ffpConfig.pourTitle) { console.log('[ffp] no title filters configured — skipping auto-assign'); return; }

      // Same cold-start problem as above — ffpCompletions is normally loaded
      // by ffpInit() when the page is opened. Without this, a scheduled run
      // that fires before anyone's opened the page this session would see
      // an empty completions map and re-assign everyone regardless of who's
      // actually already been marked complete. If the reload itself fails
      // (network blip, Supabase hiccup) an empty map is indistinguishable
      // from "genuinely nobody's done" — so abort this run rather than risk
      // mass duplicate re-assignment off unverified state; the hourly 9–12
      // retry (see scheduler below) will pick it up once Supabase responds.
      if (!Object.keys(ffpCompletions).length) {
        const loadedOk = await loadFfpCompletions();
        if (!loadedOk) {
          console.warn('[ffp] auto-assign: could not confirm completions from Supabase — skipping this run rather than risk duplicate re-assignment');
          return;
        }
      }

      // Load saved paste if not already loaded
      if (!ffpParsedData.length) await loadSavedPaste();

      // If still no paste data, try using saved results for outstanding names
      let useResults = false;
      let savedFireOutstanding = [], savedPourOutstanding = [], savedFireMissing = [], savedPourMissing = [];
      if (!ffpParsedData.length) {
        try {
          const res = await sbGet('taskmill_config', 'key=eq.ffp_results&select=value&order=updated_at.desc&limit=1');
          if (res.length && res[0].value) {
            const rv = res[0].value;
            savedFireOutstanding = rv.fireOutstanding || [];
            savedPourOutstanding = rv.pourOutstanding || [];
            savedFireMissing     = rv.fireMissing || [];
            savedPourMissing     = rv.pourMissing || [];
            ffpPasteDate = rv.pasteDate || todayKey;
            useResults = true;
          }
        } catch(e) {}
      }

      if (!ffpParsedData.length && !useResults) return;

      // Load breaks schedule
      const brkSnap = await getDoc(doc(window.db, 'taskmill_breaks', 'schedule'));
      if (!brkSnap.exists()) return;
      const brkData = brkSnap.data();
      const brkDateKey = brkData.date ? new Date(brkData.date).toISOString().slice(0,10) : null;
      if (brkDateKey !== todayKey) return; // breaks not for today

      const staff = (brkData.staff || []).filter(p => p.name);
      // Kitchen/Cleaning/Overnight/Housekeeping staff live separately since they
      // never go through the break scheduler — merge them in here so they (and
      // any kitchen/cleaner managers among them) are visible to on-shift checks.
      const nonFOH = (brkData.nonFOH || []).map(p => ({
        name: p.name,
        role: '',
        pasteRole: (p.pasteRole || '').trim(),
        startDate: p.start,
        endDate: p.end,
      })).filter(p => p.name && p.startDate && p.endDate);
      const allStaff = [...staff, ...nonFOH];

      const CASH_MGR_ROLES    = new Set(['cash manager / floor', 'cash manager / bar']);
      // Kitchen/cleaner managers never go through the People tab's role
      // taxonomy (see comment below), so they're matched on their raw,
      // free-text paste-role label — which makes an exact-match list
      // fragile: any label that isn't one of a handful of exact strings
      // silently falls out of the pool with no warning, and their whole
      // department's training then falls back to a cash manager instead.
      // Matching leniently on "contains kitchen/clean" + a leadership
      // word is the same approach getWorkerDept() below already uses to
      // classify a worker's own department, and is far more forgiving of
      // real-world label variation ("Cleaning Supervisor", "Kitchen Lead
      // Manager", etc.) than requiring an exact string match.
      // "leader" contains the substring "lead", so without an explicit
      // exclusion any Kitchen/Cleaning Team Leader or Shift Leader (not
      // management) would incorrectly match below via the .includes('lead')
      // check meant for variants like "Kitchen Lead Manager". Real management
      // titles use "Manager" — never "Leader" — so bail out first on that.
      const isKitchenMgrRole = r => {
        if (r.includes('leader')) return false;
        return r==='hall manager' || (r.includes('kitchen') && (r.includes('manager')||r.includes('mgr')||r.includes('lead')||r.includes('shift')));
      };
      const isCleanerMgrRole = r => {
        if (r.includes('leader')) return false;
        return r.includes('clean') && (r.includes('manager')||r.includes('mgr')||r.includes('lead')||r.includes('supervisor'));
      };
      // Same cold-start problem noted below (CT staff is normally only
      // loaded by ffpInit() when the page is opened) — but now needs to
      // happen before the manager pools are built too, since kitchen/
      // cleaner manager matching depends on ctRoleByName being populated.
      if (!ctStaffNames.length) await loadCTStaff();

      // Cash managers are FOH and carry the internal taxonomy role assigned via
      // the People tab; kitchen/cleaner managers never go through that
      // assignment, so they're matched primarily on Compliance Tracker's own
      // role field, falling back to the raw Non-FOH paste label only if CT
      // has nothing on file for that person.
      const cashMgrs    = staff.filter(p => CASH_MGR_ROLES.has((p.role||'').toLowerCase()));
      const kitchenMgrs = nonFOH.filter(p => isKitchenMgrRole((ctRoleByName[normName(p.name)] || p.pasteRole || '').toLowerCase()));
      const cleanerMgrs = nonFOH.filter(p => isCleanerMgrRole((ctRoleByName[normName(p.name)] || p.pasteRole || '').toLowerCase()));
      console.log('[ffp] non-FOH roles seen today:', [...new Set(nonFOH.map(p=>`${p.name}: paste="${p.pasteRole}" CT="${ctRoleByName[normName(p.name)]||''}"`))]);
      console.log('[ffp] matched as kitchen manager:', kitchenMgrs.map(p=>`${p.name} (${p.pasteRole})`));
      console.log('[ffp] matched as cleaner manager:', cleanerMgrs.map(p=>`${p.name} (${p.pasteRole})`));
      const managers = [...cashMgrs, ...kitchenMgrs, ...cleanerMgrs];
      if (!managers.length) return;

      function hhmm(d) { if(!d) return ''; const dt=d instanceof Date?d:new Date(d); return dt.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
      function fmtShift(p) { return p?.startDate&&p?.endDate?`${hhmm(new Date(p.startDate))}-${hhmm(new Date(p.endDate))}`:''; }
      function overlapMins(a, b) {
        const as=new Date(a.startDate),ae=new Date(a.endDate),bs=new Date(b.startDate),be=new Date(b.endDate);
        return Math.max(0,Math.min(ae,be)-Math.max(as,bs))/60000;
      }

      // Managers are counted against the 5-task cap by their CT-resolved
      // name (see maybeAssign below) because a saved task's `name` field
      // is always that resolved name, never the raw rota name — counting
      // by raw rota name here would silently never match either a
      // newly-created task or a pre-existing one loaded from Firestore
      // whenever a manager's rota name doesn't exactly match their CT
      // record (casing, or a nickname like "Dave"/"David"), letting them
      // blow straight through the cap. Resolved once per pool member so
      // every touch point (init, cap-check reads, pre-count, increment)
      // agrees on the same identity.
      function resolveMgrCtName(rawName) {
        const rn = normName(rawName);
        return ctStaffNames.find(c => normName(c) === rn)
          || ctStaffNames.find(c => isFuzzyMatch(rn, normName(c)))
          || rawName;
      }
      // 5 tasks per manager cap
      const mgrTaskCount = {};
      managers.forEach(m => { mgrTaskCount[normName(resolveMgrCtName(m.name))] = 0; });
      const CAP_PER_MGR = 5;

      // Use paste-derived lists or saved results
      let fireOutList, pourOutList, fireMissList, pourMissList;
      // Anyone no longer present in CT at all (fully deleted, e.g. by the
      // 7-day leaver cleanup) needs excluding here too — ctLeaverNames only
      // catches someone still IN CT with a Leaver status; once they're
      // actually removed, they vanish from that set entirely rather than
      // staying flagged, so a name-existence check is needed alongside it.
      const ctStaffNamesNorm = new Set(ctStaffNames.map(n => normName(n)));
      if (useResults) {
        fireOutList  = savedFireOutstanding.filter(n => ctStaffNamesNorm.has(normName(n)));
        pourOutList  = savedPourOutstanding.filter(n => ctStaffNamesNorm.has(normName(n)));
        fireMissList = savedFireMissing.filter(n => ctStaffNamesNorm.has(normName(n)));
        pourMissList = savedPourMissing.filter(n => ctStaffNamesNorm.has(normName(n)));
        console.log(`[ffp] auto-assign using saved results: ${fireOutList.length} fire, ${pourOutList.length} pour outstanding (after removing anyone no longer in CT)`);
      } else {
        // Build from paste
        const fireFilter2 = ffpConfig.fireTitle.toLowerCase();
        const pourFilter2 = ffpConfig.pourTitle.toLowerCase();
        const fStatus = {}, pStatus = {};
        const inPaste = new Set();
        for (const row of ffpParsedData) {
          const resolved = resolveName(row.name);
          const n = normName(resolved.ctName);
          const title = row.title.toLowerCase();
          inPaste.add(n);
          if (fireFilter2 && title.includes(fireFilter2)) {
            if (!fStatus[n] || row.status==='Completed') fStatus[n] = { status:row.status, origName:resolved.ctName };
          }
          if (pourFilter2 && title.includes(pourFilter2)) {
            if (!pStatus[n] || row.status==='Completed') pStatus[n] = { status:row.status, origName:resolved.ctName };
          }
        }
        fireOutList  = Object.entries(fStatus).filter(([n,v])=>v.status!=='Completed'&&!currentlyAway.has(n)&&!ctLeaverNames.has(n)&&ctStaffNamesNorm.has(n)).map(([,v])=>v.origName);
        pourOutList  = Object.entries(pStatus).filter(([n,v])=>v.status!=='Completed'&&!currentlyAway.has(n)&&!ctLeaverNames.has(n)&&ctStaffNamesNorm.has(n)).map(([,v])=>v.origName);
        fireMissList = ctStaffNames.filter(n=>!inPaste.has(normName(n))&&!currentlyAway.has(normName(n))&&!ctLeaverNames.has(normName(n))&&fireFilter2);
        pourMissList = ctStaffNames.filter(n=>!inPaste.has(normName(n))&&!currentlyAway.has(normName(n))&&!ctLeaverNames.has(normName(n))&&pourFilter2);
      }

      // Load today's tasks
      const taskSnap = await getDoc(doc(window.db, 'taskmill', 'shared'));
      const sharedData = taskSnap.exists() ? taskSnap.data() : {};
      const allTasks = Object.values(sharedData.tasks||{}).flat();
      const allTasksWithDate = Object.entries(sharedData.tasks||{}).flatMap(([dk, tasks]) => tasks.map(t => ({...t, _dk: dk})));
      const newTasks = {}; // Only newly created tasks — DO NOT copy sharedData.tasks (causes duplicates via shared array refs)

      const TAG = '[auto-ffp]';
      let assigned = 0;
      const pasteDate = ffpPasteDate || todayKey;

      // Pre-count existing [auto-ffp] tasks already assigned TODAY per manager
      const todayTasks = (sharedData.tasks?.[todayKey] || []);
      todayTasks.forEach(t => {
        if ((t.description||'').includes(TAG) && t.status !== 'cancelled') {
          const key = normName(t.name||'');
          if (mgrTaskCount[key] !== undefined) mgrTaskCount[key]++;
        }
      });
      console.log('[ffp] existing today tasks per manager:', JSON.stringify(mgrTaskCount));

      // Exact match first; if that fails, fall back to the same fuzzy
      // matcher resolveName() already uses for the pasted training sheet
      // (same-surname + first-name prefix, e.g. "dave"/"david") — the
      // breaks planner is a separate data source from Compliance Tracker
      // and was never guaranteed to use the same short/full name someone's
      // CT record or training paste uses. Without this, a genuine nickname
      // mismatch here reads as "not on shift today" and silently blocks
      // every auto-assign for that person, not just a casing quirk.
      function onShift(name) {
        const n = normName(name);
        return allStaff.find(p => normName(p.name||'')===n)
          || allStaff.find(p => isFuzzyMatch(n, normName(p.name||'')));
      }

      function findMgrFromPool(pool, worker) {
        const available = pool.filter(m => (mgrTaskCount[normName(resolveMgrCtName(m.name))]||0) < CAP_PER_MGR && normName(m.name) !== normName(worker.name));
        if (!available.length) return null;
        // Require at least 2 hours of shift overlap — anything thinner isn't
        // realistically enough time to run training, so don't assign anyone
        // rather than picking someone with only a sliver of shared time.
        const withGoodOverlap = available.filter(m=>overlapMins(worker,m)>=120).sort((a,b)=>(mgrTaskCount[normName(resolveMgrCtName(a.name))]||0)-(mgrTaskCount[normName(resolveMgrCtName(b.name))]||0));
        if (withGoodOverlap.length) return withGoodOverlap[0];
        return null; // nobody has 2+ hours overlap — don't assign
      }
      function getWorkerDept(name) {
        const n = normName(name);
        const nf = nonFOH.find(p => normName(p.name) === n) || nonFOH.find(p => isFuzzyMatch(n, normName(p.name)));
        if (!nf) return 'foh';
        const r = (nf.pasteRole||'').toLowerCase();
        if (r.includes('kitchen')) return 'kitchen';
        if (r.includes('clean')) return 'cleaner';
        return 'foh'; // overnight/housekeeping — no dedicated manager pool, treat as cash-managed
      }
      // kind: 'pour' is always trained by a cash manager regardless of the
      // trainee's department. 'fire' routes to the trainee's own department
      // manager (kitchen/cleaner), falling back to cash if none are on shift —
      // except FOH staff, who are strictly cash-managers-only, no fallback pool.
      function findMgr(worker, kind) {
        if (kind === 'pour') return findMgrFromPool(cashMgrs, worker);
        const dept = getWorkerDept(worker.name);
        if (dept === 'kitchen') return findMgrFromPool(kitchenMgrs.length ? kitchenMgrs : cashMgrs, worker);
        if (dept === 'cleaner') return findMgrFromPool(cleanerMgrs.length ? cleanerMgrs : cashMgrs, worker);
        return findMgrFromPool(cashMgrs, worker);
      }
      const twoWeeksAgo = Date.now() - 14*24*60*60*1000;

      async function maybeAssign(personName, trainingType, kind) {
        const n = normName(personName);
        if (currentlyAway.has(n)) return;
        const worker = onShift(personName);
        if (!worker) {
          console.log(`[ffp] ${personName} not on shift today — skipping`);
          return;
        }

        // Skip if this person's task for this training type has already been
        // marked complete (see ffpCompletions / startFfpTaskWatcher above).
        // A fresh paste showing them as still genuinely outstanding clears
        // this automatically in buildResults() before auto-assign ever runs,
        // so a real "still not done" result is never silently blocked.
        if (ffpCompletions[n]?.[kind]) {
          console.log(`[ffp] ${personName} already completed ${kind} on ${ffpCompletions[n][kind]} — skipping`);
          return;
        }

        // Same-day duplicate check — regardless of paste vs saved-results source
        const todayDuplicate = allTasksWithDate.some(t =>
          normName(t.lead||'') === n &&
          (t.description||'').includes(TAG) &&
          (t.description||'').toLowerCase().includes(trainingType.toLowerCase()) &&
          t._dk === todayKey &&
          (t.status === 'pending' || t.status === 'complete' || t.status === 'completed')
        );
        if (todayDuplicate) { console.log(`[ffp] ${personName} already has task today — skipping`); return; }

        const mgr = findMgr(worker, kind);
        if (!mgr) {
          console.log(`[ffp] ${personName} on shift ${fmtShift(worker)} but no manager overlap — skipping`);
          return;
        }
        // The manager's name comes from the rota/Breaks paste (staff/nonFOH),
        // a completely separate data source from Compliance Tracker, and —
        // unlike the trainee — was never run through resolveName(). If the
        // rota has them typed with different casing than their CT record
        // (exactly what happened with "Sabrina Mccann" vs CT's "Sabrina
        // McCann"), that mismatch went straight into the task untouched.
        // Same applies to a nickname/short-name difference (e.g. rota
        // "Dave Pullan" vs CT "David Pullan") — fuzzy fallback catches that too.
        const mgrName = resolveMgrCtName(mgr.name);
        console.log(`[ffp] assigning ${trainingType} for ${personName} to ${mgrName}`);

        const task = {
          id:          Date.now() + Math.random(),
          name:        mgrName,
          lead:        personName,
          description: `${trainingType} outstanding ${TAG} | ${personName}: ${fmtShift(worker)} | ${mgrName}: ${fmtShift(mgr)}`,
          status:      'pending',
          reason:      '', replanDate:'', replanAssigned:'',
          privacy:     false,
          createdBy:   'Taskmill',
          createdAt:   new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),
        };

        if (!newTasks[assignDateKey]) newTasks[assignDateKey] = [];
        newTasks[assignDateKey].push(task);
        assigned++;
        mgrTaskCount[normName(mgrName)] = (mgrTaskCount[normName(mgrName)]||0) + 1;
      }

      // Fire outstanding
      if (ffpConfig.fireTitle) {
        for (const name of [...fireOutList, ...fireMissList]) {
          await maybeAssign(name, ffpConfig.fireTitle, 'fire');
        }
      }

      // Free pour outstanding
      if (ffpConfig.pourTitle) {
        for (const name of [...pourOutList, ...pourMissList]) {
          await maybeAssign(name, ffpConfig.pourTitle, 'pour');
        }
      }

      if (assigned > 0) {
        const { updateDoc: _upd } = window._fbFns || {};
        if (_upd) {
          // Prune old tasks first to stay under Firestore 1MB limit
          if (typeof window.apPruneTasks === 'function') {
            try { await window.apPruneTasks(doc(window.db,'taskmill','shared'), sharedData, { updateDoc: _upd }); } catch(e) {}
          }
          if (typeof window.apWriteNewTasksSafely === 'function') {
            // Re-reads Firestore fresh immediately before writing, and logs
            // its own audit event — same protection the other auto-assign
            // engines (appraisal.js, elearning.js) now have. sharedData
            // above was already a fresh direct-Firestore read (not the
            // Supabase mirror those use), so the risk here was always
            // smaller, but the processing loop and the prune step above
            // both take time, so it's worth closing that gap too.
            await window.apWriteNewTasksSafely(newTasks);
          } else {
            const _dateUpdates = {};
            Object.entries(newTasks).forEach(([dk, arr]) => {
              const existing = (sharedData.tasks||{})[dk] || [];
              _dateUpdates[`tasks.${dk}`] = [...existing, ...arr];
            });
            if (Object.keys(_dateUpdates).length) {
              await _upd(doc(window.db, 'taskmill', 'shared'), _dateUpdates);
              // Dual-write to Supabase
              if (typeof window.sbSyncTasks === 'function') {
                Object.entries(newTasks).forEach(([dk, arr]) => {
                  const existing = (sharedData.tasks||{})[dk] || [];
                  window.sbSyncTasks(dk, [...existing, ...arr]).catch(()=>{});
                });
              }
            }
          }
        }
        console.log(`[ffp] assigned ${assigned} training tasks`);
      } else {
        console.log('[ffp] no tasks to assign today');
      }

      try {
        await sbPost('taskmill_config', { key:'ffp_autoassign_flag', value:{date:todayKey}, updated_at:new Date().toISOString() });
      } catch(e) { console.warn('[ffp] failed to save autoassign flag:', e.message); }
    } catch(e) { console.warn('[ffp] auto-assign error:', e.message); }
    finally { window._ffpAutoAssignRunning = false; }
  };

  // ── Auto-assign helpers ─────────────────────────────────────
  function normName(n) { return (n||'').trim().toLowerCase().replace(/\s+/g,' '); }
  function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


  // ── 9am daily scheduler ────────────────────────────────────
  (function scheduleFFPAutoAssign() {
    function ukHour() {
      return Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }));
    }
    function msUntil9amUK() {
      // Read the actual UK wall-clock date/time components directly via
      // formatToParts — does NOT round-trip through new Date(localeString),
      // which silently breaks (Invalid Date / NaN) for en-GB's DD/MM/YYYY
      // format, since the Date constructor expects MM/DD/YYYY for
      // slash-separated strings. That NaN delay made setTimeout fire at
      // ~0ms, so this whole scheduler was retriggering itself in a tight
      // infinite loop — every iteration calling ffpAutoAssign(), which
      // hammered Supabase until the browser ran out of resources.
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour12: false,
        year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit'
      });
      const parts = {};
      fmt.formatToParts(now).forEach(p => { if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10); });
      // Treat the UK wall-clock components as if they were UTC — this is
      // just a stable reference frame for the subtraction below, not an
      // actual UTC conversion, but it correctly accounts for BST/GMT since
      // formatToParts already resolved the real UK local time.
      const ukNowRef   = Date.UTC(parts.year, parts.month-1, parts.day, parts.hour===24?0:parts.hour, parts.minute, parts.second);
      const next9amRef = Date.UTC(parts.year, parts.month-1, parts.day, 9, 0, 0);
      let diff = next9amRef - ukNowRef;
      if (diff <= 0) diff += 24*3600*1000; // already past 9am UK today — wait until tomorrow
      return diff;
    }
    // Safety floor: never schedule on a NaN/invalid/absurd delay, no matter
    // the cause — falls back to checking again in 1 hour rather than risking
    // a runaway loop like the one that caused this.
    function safeDelay(ms) {
      if (!Number.isFinite(ms) || ms <= 0 || ms > 25*3600*1000) return 3600000;
      return ms;
    }
    function runAndReschedule() {
      ffpAutoAssign().catch(e => console.warn('[ffp] auto-assign error:', e.message));
      setTimeout(runAndReschedule, safeDelay(msUntil9amUK()));
      // If breaks weren't ready at 9am they might be pasted at 10/11am.
      // Schedule hourly retries until noon so auto-assign catches up the
      // same day rather than waiting until tomorrow's 9am trigger.
      // The once-per-day flag inside ffpAutoAssign makes these safe —
      // once it runs successfully it sets the flag and all further calls
      // that day skip immediately.
      const h = ukHour();
      if (h >= 9 && h < 12) {
        setTimeout(() => ffpAutoAssign().catch(()=>{}), 60 * 60 * 1000); // +1hr
      }
    }
    // Catch up immediately if the app is opened after 9am and today's run
    // hasn't happened in this session yet — previously this only ran from the
    // *next* scheduled timer, so a tab opened mid-afternoon would silently
    // wait until the following day before assigning anything.
    if (ukHour() >= 9) {
      ffpAutoAssign().catch(e => console.warn('[ffp] auto-assign error:', e.message));
    }
    setTimeout(runAndReschedule, safeDelay(msUntil9amUK()));
  })();

})();
