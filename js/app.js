/* 75 Hard Tracker — front-end app
 * Talks to the Google Apps Script backend (config.API_URL). If no URL is set,
 * it falls back to an OFFLINE demo mode backed by localStorage so the UI is
 * still fully usable on your phone.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG;
  var LEN = CFG.CHALLENGE_LENGTH;
  var WATER_GOAL = CFG.WATER_GOAL_ML;
  var GLASS = CFG.GLASS_ML;
  var GLASS_COUNT = Math.round(WATER_GOAL / GLASS);
  var OFFLINE = !CFG.API_URL;

  var TASKS = [
    { key: 'workout1',  emoji: '🏋️', title: 'Indoor workout',  sub: '45 minutes' },
    { key: 'outdoor',   emoji: '🌳', title: 'Outdoor workout', sub: '45 minutes · rain or shine' },
    { key: 'reading',   emoji: '📖', title: 'Read 10 pages',    sub: 'Non-fiction / self-help' },
    { key: 'photo',     emoji: '📸', title: 'Progress photo',   sub: 'Snap it today' },
    { key: 'diet',      emoji: '🥗', title: 'Follow your diet', sub: 'No cheat meals' },
    { key: 'noAlcohol', emoji: '🚫', title: 'No alcohol',       sub: 'Zero, none' },
    // Stored inside the day's `extra` JSON (xkey) so no backend column is needed.
    { key: 'noCig',     emoji: '🚭', title: 'No cigarettes',    sub: 'Zero, none', xkey: true }
  ];
  var TOTAL_ITEMS = TASKS.length + 1; // + water
  // Read/write a task's done-state, whether it's a top-level day field or lives
  // in the day's `extra` bag (xkey tasks like No cigarettes).
  function taskDone(d, t) { return t.xkey ? !!(d.extra && d.extra[t.key]) : !!d[t.key]; }
  function taskSetDone(d, t, v) {
    if (t.xkey) { if (!d.extra) d.extra = {}; d.extra[t.key] = !!v; }
    else d[t.key] = !!v;
  }
  // Counts toward completion. Newly-added xkey tasks were never tracked on old
  // logs, so an ABSENT flag counts as satisfied — past complete days (and their
  // streaks) aren't retroactively broken. New days seed the flag explicitly.
  function taskSat(d, t) {
    if (t.xkey && (!d.extra || d.extra[t.key] === undefined)) return true;
    return taskDone(d, t);
  }
  var TASK_BY_KEY = {}; TASKS.forEach(function (t) { TASK_BY_KEY[t.key] = t; });

  /* ================= Challenge engine =================
     The active challenge (profile.challenge) is a set of RULES evaluated against
     data the app already tracks. Rule shapes:
       { t:'task',   key:'workout1' }                       -> day boolean / extra (noCig)
       { t:'water' }                                        -> waterMl >= challenge.water
       { t:'metric', key:'steps', min:8000, label, emoji, app }  -> day metrics[key] >= min
       { t:'habit',  id:'h_..' }                            -> extra[id] (a custom Habit)
       { t:'manual', id:'x', label, emoji }                 -> extra['ch_'+id] (own checklist item) */
  var CH_METRICS = {
    steps:     { label: 'steps',       emoji: '👟', app: 'steps',    fmt: function (v) { return Number(v).toLocaleString(); } },
    meditMin:  { label: 'min meditate', emoji: '🧘', app: 'meditate', fmt: function (v) { return v + ' min'; } },
    detoxMin:  { label: 'min offline', emoji: '📵', app: 'detox',    fmt: function (v) { return v + ' min'; } },
    sleepMin:  { label: 'min sleep',   emoji: '😴', app: 'sleep',    fmt: function (v) { return v + ' min'; } },
    breathMin: { label: 'min breathe', emoji: '🫁', app: 'breathe',  fmt: function (v) { return v + ' min'; } }
  };
  // Difficulty tiers group the challenges in the gallery. 'base' is the gentle,
  // no-challenge everyday baseline.
  var CH_TIERS = [
    { id: 'base',   label: 'Everyday',  sub: 'no challenge — just the basics' },
    { id: 'easy',   label: 'Easy',      sub: 'ease in · forgiving' },
    { id: 'medium', label: 'Medium',    sub: 'balanced · sustainable' },
    { id: 'hard',   label: 'Hard',      sub: 'no excuses' }
  ];
  // Preset library — plain data; a new challenge is one entry here.
  var CH_PRESETS = [
    { id: 'dailyLife', name: 'Daily Life', emoji: '🌤️', tier: 'base', days: 0, reset: 'none', pass: 'all', water: 3000,
      desc: 'Not on a challenge — just the everyday basics. Move, hydrate, read. No streak to break.',
      rules: [{ t: 'task', key: 'workout1' }, { t: 'task', key: 'reading' }, { t: 'water' }] },
    { id: 'soft75', name: '75 Soft', emoji: '🌊', tier: 'easy', days: 75, reset: 'none', pass: 70, water: 4000,
      desc: 'Same habits, forgiving. Hit ~70% of the day and keep your streak — no restarts.',
      rules: [{ t: 'task', key: 'workout1' }, { t: 'task', key: 'outdoor' }, { t: 'task', key: 'reading' },
        { t: 'task', key: 'photo' }, { t: 'task', key: 'diet' }, { t: 'task', key: 'noAlcohol' }, { t: 'task', key: 'noCig' }, { t: 'water' }] },
    { id: 'dopamine', name: 'Dopamine Detox', emoji: '📵', tier: 'easy', days: 14, reset: 'none', pass: 'all', water: 0,
      desc: '14 days off cheap stimulation — no doomscroll, no junk, real focus and calm.',
      rules: [{ t: 'metric', key: 'detoxMin', min: 180 }, { t: 'metric', key: 'meditMin', min: 10 }, { t: 'manual', id: 'nosocial', label: 'No social media', emoji: '🙅' }, { t: 'manual', id: 'nojunk', label: 'No junk food', emoji: '🍔' }] },
    { id: 'medium75', name: '75 Medium', emoji: '⚖️', tier: 'medium', days: 75, reset: 'none', pass: 'all', water: 4000,
      desc: 'The sustainable middle. One workout, clean diet, reading, water — daily, no reset.',
      rules: [{ t: 'task', key: 'workout1' }, { t: 'task', key: 'diet' }, { t: 'task', key: 'noAlcohol' }, { t: 'task', key: 'reading' }, { t: 'water' }] },
    { id: 'winterArc', name: 'Winter Arc', emoji: '❄️', tier: 'medium', days: 90, reset: 'none', pass: 'all', water: 3000,
      desc: '90 days of locking in — train, meditate, read, unplug. Consistency over perfection.',
      rules: [{ t: 'task', key: 'workout1' }, { t: 'metric', key: 'meditMin', min: 10 }, { t: 'metric', key: 'detoxMin', min: 60 }, { t: 'task', key: 'reading' }, { t: 'water' }] },
    { id: 'hard75', name: '75 Hard', emoji: '🔥', tier: 'hard', days: 75, reset: 'hard', pass: 'all', water: 4000,
      desc: 'The original. 6 strict rules, no misses — slip and you restart Day 1.',
      rules: [{ t: 'task', key: 'workout1' }, { t: 'task', key: 'outdoor' }, { t: 'task', key: 'reading' },
        { t: 'task', key: 'photo' }, { t: 'task', key: 'diet' }, { t: 'task', key: 'noAlcohol' }, { t: 'task', key: 'noCig' }, { t: 'water' }] },
    { id: 'monkMode', name: 'Monk Mode', emoji: '🧘', tier: 'hard', days: 30, reset: 'none', pass: 'all', water: 0,
      desc: '30 days of radical focus. Deep work, meditation, reading, training — distractions cut.',
      rules: [{ t: 'metric', key: 'detoxMin', min: 120 }, { t: 'metric', key: 'meditMin', min: 10 }, { t: 'task', key: 'reading' }, { t: 'task', key: 'workout1' }, { t: 'manual', id: 'deepwork', label: 'Deep work 2h', emoji: '💼' }] }
  ];
  function chPreset(id) { return CH_PRESETS.filter(function (p) { return p.id === id; })[0]; }
  // Deep-clone a preset (or def) into an active run stamped with a start date.
  function chInstantiate(base, startDate) {
    var def = JSON.parse(JSON.stringify(base));
    def.startDate = startDate || todayStr();
    def.history = base.history || [];
    return def;
  }
  // Legacy migration: synthesize from the old mode/softTarget so nothing changes
  // for existing users until they explicitly pick a challenge.
  function chMigratedDefault() {
    var start = state.user ? state.user.startDate : todayStr();
    // Soft-mode legacy users keep 75 Soft (with their target).
    if (state.profile && state.profile.mode === 'soft') {
      var sdef = chInstantiate(chPreset('soft75'), start);
      if (state.profile.softTarget) sdef.pass = Math.min(100, Math.max(20, Number(state.profile.softTarget) || 70));
      sdef.water = 4000;
      return sdef;
    }
    // CRITICAL: anyone who has ALREADY been using the app (any logged history,
    // or an account that predates today) stays on 75 Hard — the original
    // default. We must never silently move an existing user off their
    // challenge. Only a genuinely NEW account starts on the Daily Life baseline.
    var existing = (state.logs && state.logs.length > 0) ||
      (state.user && state.user.startDate && String(state.user.startDate) < todayStr());
    var def = chInstantiate(chPreset(existing ? 'hard75' : 'dailyLife'), start);
    def.water = existing ? 4000 : def.water;   // keep migrated completion identical
    return def;
  }
  function activeCh() {
    if (state._ch) return state._ch;
    state._ch = (state.profile && state.profile.challenge) ? state.profile.challenge : chMigratedDefault();
    return state._ch;
  }
  function chStart() { var c = activeCh(); return (c && c.startDate) || (state.user ? state.user.startDate : todayStr()); }
  function chWaterGoal() { var c = activeCh(); var w = c && Number(c.water); return w > 0 ? w : (CFG.WATER_GOAL_ML || 4000); }
  function chRules() { var c = activeCh(); return (c && c.rules) || []; }
  function chHasWater() { return chRules().some(function (r) { return r.t === 'water'; }); }
  function chDay() { return dayNumber(chStart(), todayStr()); }
  // Human label/emoji/sub for any rule (drives Today rows + Stats bars).
  function ruleView(rule) {
    if (rule.t === 'water') return { emoji: '💧', title: 'Drink ' + litres(chWaterGoal()) + ' L of water', sub: 'Tap a glass each time you drink' };
    if (rule.t === 'task') { var t = TASK_BY_KEY[rule.key] || {}; return { emoji: t.emoji || '✅', title: t.title || rule.key, sub: t.sub || '' }; }
    if (rule.t === 'metric') { var m = CH_METRICS[rule.key] || { label: rule.key, emoji: '📊' }; return { emoji: m.emoji, title: rule.label || (rule.min + ' ' + m.label), sub: 'Logged in the ' + (m.app || rule.key) + ' app', app: m.app, metric: true }; }
    if (rule.t === 'habit') { var h = ((state.profile && state.profile.customTasks) || []).filter(function (x) { return x.id === rule.id; })[0]; return { emoji: '🔗', title: (h && h.name) || 'Habit', sub: 'Custom habit' }; }
    if (rule.t === 'manual') return { emoji: rule.emoji || '📌', title: rule.label || 'Task', sub: 'Tap when done' };
    return { emoji: '•', title: '?', sub: '' };
  }
  function ruleMet(d, rule) {
    switch (rule.t) {
      case 'water':  return (Number(d.waterMl) || 0) >= chWaterGoal();
      case 'task':   { var t = TASK_BY_KEY[rule.key]; return t ? taskSat(d, t) : false; }
      case 'metric': return (Number((d.metrics || {})[rule.key]) || 0) >= (Number(rule.min) || 0);
      case 'habit':  return !!(d.extra && d.extra[rule.id]);
      case 'manual': return !!(d.extra && d.extra['ch_' + rule.id]);
    }
    return false;
  }
  function ruleToggle(d, rule) {
    if (rule.t === 'task') { var t = TASK_BY_KEY[rule.key]; if (t) taskSetDone(d, t, !taskDone(d, t)); }
    else if (rule.t === 'habit') { if (!d.extra) d.extra = {}; d.extra[rule.id] = !d.extra[rule.id]; }
    else if (rule.t === 'manual') { if (!d.extra) d.extra = {}; d.extra['ch_' + rule.id] = !d.extra['ch_' + rule.id]; }
  }
  function chCount(d) { return chRules().filter(function (r) { return ruleMet(d, r); }).length; }
  function chAllMet(d) { return chRules().every(function (r) { return ruleMet(d, r); }); }
  function chNeeded() { var c = activeCh(); return c.pass === 'all' ? chRules().length : Math.max(1, Math.ceil(Number(c.pass) / 100 * chRules().length)); }
  function chGoalLive(d) { var c = activeCh(); return c.pass === 'all' ? chAllMet(d) : chCount(d) >= chNeeded(); }
  // Keep the legacy globals in sync so the ~20 existing call sites just work.
  function syncChallenge() {
    LEN = Number(activeCh().days) || 0;
    WATER_GOAL = chWaterGoal();
    GLASS_COUNT = Math.max(1, Math.round(WATER_GOAL / GLASS));
    TOTAL_ITEMS = chRules().length || 1;
  }
  // Set/replace the active challenge and persist to the profile.
  function setChallenge(def, cb) {
    var profile = Object.assign({}, state.profile, { challenge: def });
    state.profile = profile; state._ch = def; syncChallenge();
    // Re-evaluate today's completion under the new rules.
    if (state.today) { state.today.completed = goalMet(state.today); upsertLocal(state.today); }
    api('saveGoals', { profile: profile }).then(function (data) {
      if (data && data.profile) { state.profile = data.profile; state._ch = data.profile.challenge || def; syncChallenge(); }
      if (cb) cb();
    }).catch(function (e) { toast(e.message); if (cb) cb(); });
  }
  var ADMIN_USERS = ['pronoy']; // who sees the admin dashboard (backend enforces too)
  function isAdmin() { return !!state.user && ADMIN_USERS.indexOf(String(state.user.username || '').toLowerCase()) >= 0; }

  /* ---------------- state ---------------- */
  var state = {
    token: localStorage.getItem('hard_token') || '',
    username: localStorage.getItem('hard_user') || '',
    user: null,
    logs: [],
    today: null,
    profile: {},
    foods: [],
    foodsDate: null,
    dietDate: null,
    customFoods: [],
    friends: null,
    bizSelected: null,
    money: null,
    coachHistory: null,
    coachBusy: false,
    scanData: null,
    pendingFood: null,
    editingFoodId: null,
    activeFast: null,
    fastTimer: null,
    calMonth: null,          // 'YYYY-MM' shown in the Journey calendar
    editDay: null,
    saveTimer: null
  };

  /* ---------------- DOM helpers ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function show(s) { $(s).classList.remove('hidden'); }
  function hide(s) { $(s).classList.add('hidden'); }

  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); t.classList.remove('show'); }, 2200);
  }

  /* ---------------- Tap feedback (haptic + click sound) ---------------- */
  var FX = {
    haptics: localStorage.getItem('hard_haptics') !== '0', // default on
    sound: localStorage.getItem('hard_sound') !== '0',     // default on
    actx: null,
    ensure: function () {
      if (this.actx) { if (this.actx.state === 'suspended') this.actx.resume(); return; }
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) { try { this.actx = new Ctx(); } catch (e) {} }
    },
    beep: function () {
      this.ensure();
      if (!this.actx) return;
      try {
        var now = this.actx.currentTime;
        var o = this.actx.createOscillator(), g = this.actx.createGain();
        o.type = 'triangle'; o.frequency.setValueAtTime(420, now); o.frequency.exponentialRampToValueAtTime(180, now + 0.05);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.06, now + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
        o.connect(g); g.connect(this.actx.destination);
        o.start(now); o.stop(now + 0.07);
      } catch (e) {}
    },
    tap: function () {
      if (this.haptics && navigator.vibrate) { try { navigator.vibrate(8); } catch (e) {} }
      if (this.sound) this.beep();
    },
    set: function (key, on) {
      this[key] = on;
      localStorage.setItem(key === 'haptics' ? 'hard_haptics' : 'hard_sound', on ? '1' : '0');
      if (on) this.tap(); // confirm the toggle itself
    }
  };
  // Fire on pointerdown so it feels instant (and unlocks audio on the first user gesture).
  // Walk up a few ancestors and tick if the element is a control or is styled clickable.
  document.addEventListener('pointerdown', function (e) {
    var node = e.target;
    for (var i = 0; i < 5 && node && node.nodeType === 1; i++) {
      if (node.disabled) return;
      var tag = node.tagName;
      var isControl = tag === 'BUTTON' || tag === 'A' ||
        (tag === 'INPUT' && /^(checkbox|radio|button|submit)$/i.test(node.type));
      if (isControl || node.getAttribute('role') === 'button') { FX.tap(); return; }
      try { if (window.getComputedStyle(node).cursor === 'pointer') { FX.tap(); return; } } catch (e2) {}
      node = node.parentNode;
    }
  }, { passive: true });

  /* ---------------- date helpers ---------------- */
  function todayStr() { return fmt(new Date()); }
  function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(s) {
    if (s instanceof Date) return s;
    var str = String(s);
    var p = str.slice(0, 10).split('-');
    if (p.length === 3 && p[0].length === 4) return new Date(+p[0], +p[1] - 1, +p[2]);
    var d = new Date(str); // tolerate "Tue Jun 16 2026 …" style strings from Sheets
    return isNaN(d.getTime()) ? new Date() : d;
  }
  function addDays(s, n) {
    var d = parse(s); d.setDate(d.getDate() + n); return fmt(d);
  }
  function dayNumber(startDate, date) {
    var diff = Math.floor((parse(date) - parse(startDate)) / 86400000) + 1;
    return diff < 1 ? 0 : diff;
  }
  function prettyDate(s) {
    return parse(s).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  /* ---------------- API ---------------- */
  // A free-tier Apps Script Web App ("Execute as: Me") occasionally cold-starts
  // or blips — the request never reaches it, and fetch() itself rejects
  // (Safari: "Load failed", Chrome: "Failed to fetch") before any response
  // comes back. That's distinct from the server responding with a real error,
  // which is never retried here. Retrying with backoff clears most transient
  // hiccups without the user ever seeing them; the schedule is generous
  // (~8s total) since an Apps Script cold start or a brief connectivity gap
  // can outlast a couple of quick retries.
  var API_BACKOFF = [600, 1200, 2200, 4000]; // ms of delay before each retry
  // Apps Script is genuinely slow: a cold start plus a couple of full-sheet
  // reads can run well past 20s, so a tight ceiling turns ordinary slowness
  // into a failure. This is a backstop against a hung request, not a latency
  // budget — keep it well above the worst honest response.
  var API_TIMEOUT = 45000;
  // Replaying a request is only safe if the server can recognise it as the
  // same one. Reads always can be; writes only when they carry a clientId the
  // backend dedups on, otherwise a retry after a timeout could double-write.
  var SAFE_ACTIONS = {
    getState: 1, getProfile: 1, getFasts: 1, getFood: 1, getFoodRange: 1, getFoodStats: 1,
    moneyGetState: 1, moneyGetTxns: 1, moneyDashboard: 1, listGet: 1, friends: 1, leaderboard: 1
  };
  function isIdempotent(action, payload) {
    if (SAFE_ACTIONS[action]) return true;
    if (!payload) return false;
    if (payload.clientId) return true;
    if (payload.transaction && payload.transaction.clientId) return true;
    if (Array.isArray(payload.transactions) && payload.transactions.length) {
      return payload.transactions.every(function (t) { return t && t.clientId; });
    }
    return false;
  }
  // fetch() only rejects when the connection itself fails — a server that
  // accepts the request and then stalls leaves the promise pending forever,
  // which is how a save could sit on "Saving…" indefinitely. Abort instead.
  function fetchWithTimeout(url, opts, idempotent) {
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, API_TIMEOUT);
    var merged = Object.assign({}, opts, { signal: ctrl.signal });
    return fetch(url, merged).then(function (r) { clearTimeout(timer); return r; },
      function (err) {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') {
          var e = new Error('API_TIMEOUT');
          // A timed-out request may already have been applied server-side, so
          // only replay it when the backend can dedup the repeat.
          e.noRetry = !idempotent;
          throw e;
        }
        throw err;
      });
  }
  function fetchWithRetry(url, opts, attempt, onRetry, idempotent) {
    attempt = attempt || 0;
    return fetchWithTimeout(url, opts, idempotent).catch(function (err) {
      if ((err && err.noRetry) || attempt >= API_BACKOFF.length) throw err;
      if (onRetry) onRetry(attempt + 1, API_BACKOFF.length + 1);
      return new Promise(function (resolve) { setTimeout(resolve, API_BACKOFF[attempt]); })
        .then(function () { return fetchWithRetry(url, opts, attempt + 1, onRetry, idempotent); });
    });
  }
  // onRetry(attempt, totalAttempts) is optional — pass it to surface live
  // "still trying" progress instead of the UI going silent for several seconds.
  function api(action, payload, onRetry) {
    payload = payload || {};
    payload.action = action;
    if (state.token) { payload.token = state.token; payload.username = state.username; }
    // Wrap the offline shim in a real promise so a thrown error (e.g. an
    // out-of-Charge gate) rejects like the network path instead of throwing sync.
    var p = OFFLINE
      ? new Promise(function (resolve) { resolve(offlineApi(action, payload)); })
      : fetchWithRetry(CFG.API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight
          body: JSON.stringify(payload)
        }, 0, onRetry, isIdempotent(action, payload)).then(function (r) { return r.json(); })
          .then(function (res) {
            if (!res.ok) throw new Error(res.error || 'Request failed');
            if (res.charge) updateCharge(res.charge);   // battery echoed back on metered calls
            return res.data;
          });
    return p.catch(function (err) {
      var msg = String(err && err.message || '');
      if (msg.indexOf('CHARGE_EMPTY') === 0) { handleChargeEmpty(msg); throw err; }
      if (msg === 'API_TIMEOUT') {
        throw new Error(isIdempotent(action, payload)
          ? 'The server is being slow — that didn’t go through. Try again; it won’t double-save.'
          : 'The server took too long to respond. Pull to refresh and check whether it saved before trying again.');
      }
      // Reword the raw browser network-failure strings (meaningless to a user)
      // into something actionable — this only fires once retries are exhausted.
      if (/^(load failed|failed to fetch|networkerror|typeerror)/i.test(msg) || /network/i.test(msg)) {
        throw new Error('Couldn’t reach the server after several tries — check your connection and try again.');
      }
      throw err;
    });
  }

  /* ---------------- Offline backend (localStorage) ---------------- */
  function db() { return JSON.parse(localStorage.getItem('hard_demo') || '{"users":{},"logs":{}}'); }
  function saveDb(d) { localStorage.setItem('hard_demo', JSON.stringify(d)); }
  var MONEY_DEFAULT_CATS = [
    ['Food & Dining', 'Groceries', 'need', '🛒', '#16a34a'], ['Food & Dining', 'Restaurants', 'want', '🍽️', '#f59e0b'],
    ['Food & Dining', 'Online Delivery', 'want', '🛵', '#ef4444'], ['Transport', 'Fuel', 'need', '⛽', '#0ea5e9'],
    ['Transport', 'Cabs / Ride-share', 'want', '🚕', '#38bdf8'], ['Entertainment', 'OTT / Subscriptions', 'want', '📺', '#a855f7'],
    ['Shopping', 'General Shopping', 'want', '🛍️', '#be185d'], ['Health', 'Pharmacy', 'need', '💊', '#14b8a6'],
    ['Bills & Utilities', 'Rent / EMI', 'need', '🏠', '#64748b'], ['Bills & Utilities', 'Internet / Mobile', 'need', '📶', '#334155'],
    ['Money', 'Savings & Investments', 'saving', '📈', '#10b981'], ['Income', 'Income', 'income', '💰', '#22c55e'],
    ['Other', 'Miscellaneous', 'want', '📦', '#6b7280']
  ];

  function offlineApi(action, p) {
    var d = db();
    function pub(u) {
      return { username: u.username, displayName: u.displayName, startDate: u.startDate,
        currentDay: dayNumber(u.startDate, todayStr()), challengeLength: LEN, waterGoalMl: WATER_GOAL,
        email: u.email || '', emailVerified: !!u.emailVerified };
    }
    function userLogs(un) { return (d.logs[un] || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }

    if (action === 'register') {
      var un = (p.username || '').toLowerCase().trim();
      if (un.length < 3) throw new Error('Username must be at least 3 characters.');
      if (d.users[un]) throw new Error('That username is already taken.');
      d.users[un] = { username: un, displayName: p.displayName || un, password: p.password,
        startDate: p.startDate || todayStr(), token: 't_' + un, email: p.email || '', emailVerified: !!p.email };
      d.logs[un] = []; saveDb(d);
      return { token: 't_' + un, user: pub(d.users[un]) };
    }
    if (action === 'login') {
      var lu = d.users[(p.username || '').toLowerCase().trim()];
      if (!lu || lu.password !== p.password) throw new Error('Invalid username or password.');
      return { token: lu.token, user: pub(lu) };
    }
    var me = d.users[(p.username || '').toLowerCase().trim()];
    if (!me || me.token !== p.token) throw new Error('Session expired. Please log in again.');

    if (action === 'updateEmail') { me.email = p.email || ''; me.emailVerified = !!p.email; saveDb(d); return { user: pub(me) }; }
    if (action === 'changePassword') { me.password = p.newPassword; saveDb(d); return { ok: true }; }
    if (action === 'adminResetPassword') {
      var tu = d.users[(p.username || '').toLowerCase().trim()];
      if (tu) { tu.password = p.newPassword; saveDb(d); }
      return { ok: true, username: p.username };
    }
    if (action === 'changeUsername') {
      var nn = (p.newUsername || '').toLowerCase().trim();
      if (d.users[nn]) throw new Error('That username is already taken.');
      delete d.users[me.username]; me.username = nn; d.users[nn] = me; saveDb(d);
      return { token: me.token, user: pub(me) };
    }

    // ---- Charge (offline demo): mirrors the server-side budget ----
    var OFF_COST = { scanLabel: 5, foodSearch: 1, coachChat: 2, parseScreenTime: 8, moneyParseScreenshot: 5, moneyParseMessage: 2, moneyCoachChat: 2 };
    function offChargeState() {
      var month = todayStr().slice(0, 7);
      var completed = userLogs(me.username).filter(function (l) { return String(l.date).slice(0, 7) === month && l.completed; }).length;
      var earned = Math.min(200, completed * 6);
      d.charge = d.charge || {};
      var spent = Number(d.charge[me.username + '|' + month]) || 0;
      var cap = Math.min(300, 100 + earned);
      return { month: month, base: 100, earned: earned, spent: spent, cap: cap, balance: Math.max(0, cap - spent), max: 300, earnPerDay: 6, costs: OFF_COST, unlimited: false };
    }
    if (action === 'getCharge') return offChargeState();
    if (OFF_COST[action]) {
      var cst = OFF_COST[action], stq = offChargeState();
      if (stq.balance < cst) throw new Error('CHARGE_EMPTY|You’re out of Charge. Complete today’s tasks to recharge (+6 each), or it refills on the 1st.');
      var ckey = me.username + '|' + stq.month;
      d.charge = d.charge || {}; d.charge[ckey] = (Number(d.charge[ckey]) || 0) + cst; saveDb(d);
      setTimeout(function () { updateCharge(offChargeState()); }, 0);
    }

    // ---- Money Manager (offline demo mode) ----
    if (action.indexOf('money') === 0) {
      d.money = d.money || {};
      var mm = d.money[me.username] || (d.money[me.username] = { accounts: [], categories: [], txns: [], budget: {} });
      var moneyStatus = function () {
        var limit = Number(mm.budget.limit) || 0;
        var from = todayStr().slice(0, 7) + '-01', today2 = todayStr();
        var spent = mm.txns.filter(function (t) { return t.type === 'expense' && t.date >= from && t.date <= today2; }).reduce(function (s, t) { return s + (Number(t.amount) || 0); }, 0);
        var now = new Date(), daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), dayOfMonth = now.getDate();
        var daysLeft = Math.max(1, daysInMonth - dayOfMonth + 1);
        var pct = limit > 0 ? spent / limit : 0;
        var level = limit <= 0 ? 'none' : (pct >= 1 ? 'stop' : pct >= 0.85 ? 'critical' : pct >= 0.70 ? 'warn' : 'ok');
        var remaining = limit > 0 ? Math.max(0, limit - spent) : 0;
        return { limit: limit, spent: spent, remaining: remaining, pct: pct, level: level, daysLeft: daysLeft, daysInMonth: daysInMonth, dayOfMonth: dayOfMonth, safePerDay: limit > 0 ? remaining / daysLeft : 0, projection: dayOfMonth > 0 ? (spent / dayOfMonth) * daysInMonth : 0, categoryFlags: [] };
      };
      var moneyDashboardCalc = function () {
        var from2 = todayStr().slice(0, 7) + '-01';
        var catMap = {}; mm.categories.forEach(function (c) { catMap[c.id] = c; });
        var byCategory = {}, byKind = { need: 0, want: 0, saving: 0 }, byMerchant = {}, totalSpend = 0;
        mm.txns.filter(function (t) { return t.date >= from2 && t.type === 'expense'; }).forEach(function (t) {
          var c = catMap[t.categoryId] || { name: 'Uncategorised', kind: 'want', icon: '❓', color: '#6b7280' };
          totalSpend += Number(t.amount) || 0;
          byCategory[t.categoryId] = (byCategory[t.categoryId] || 0) + (Number(t.amount) || 0);
          byKind[c.kind] = (byKind[c.kind] || 0) + (Number(t.amount) || 0);
          var m = t.merchant || '(unknown)'; byMerchant[m] = (byMerchant[m] || 0) + (Number(t.amount) || 0);
        });
        var catList = Object.keys(byCategory).map(function (id) { var c = catMap[id] || {}; return { id: id, name: c.name || 'Uncategorised', icon: c.icon || '❓', color: c.color || '#6b7280', total: byCategory[id] }; }).sort(function (a, b) { return b.total - a.total; });
        var merchList = Object.keys(byMerchant).map(function (m) { return { merchant: m, total: byMerchant[m] }; }).sort(function (a, b) { return b.total - a.total; }).slice(0, 8);
        return { totalSpend: totalSpend, byCategory: catList, byKind: byKind, topMerchants: merchList, status: moneyStatus() };
      };
      if (action === 'moneyGetState') {
        if (!mm.categories.length) {
          mm.categories = MONEY_DEFAULT_CATS.map(function (c) { return { id: 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: c[1], group: c[0], kind: c[2], icon: c[3], color: c[4] }; });
        }
        saveDb(d);
        return { accounts: mm.accounts, categories: mm.categories, budget: mm.budget, status: moneyStatus(), dashboard: moneyDashboardCalc() };
      }
      if (action === 'moneyAddAccount') { var acc = Object.assign({ id: 'a_' + Date.now().toString(36) }, p.account); mm.accounts.push(acc); saveDb(d); return { account: acc }; }
      if (action === 'moneyDeleteAccount') { mm.accounts = mm.accounts.filter(function (a) { return a.id !== p.id; }); saveDb(d); return { deleted: p.id }; }
      if (action === 'moneyAddCategory') { var mc = Object.assign({ id: 'c_' + Date.now().toString(36) }, p.category); mm.categories.push(mc); saveDb(d); return { category: mc }; }
      if (action === 'moneyUpdateCategory') {
        var uc = mm.categories.filter(function (c) { return c.id === (p.category || {}).id; })[0];
        if (!uc) throw new Error('Category not found.');
        ['name', 'group', 'kind', 'icon', 'color'].forEach(function (f) { if (p.category[f] !== undefined) uc[f] = p.category[f]; });
        saveDb(d); return { category: uc };
      }
      if (action === 'moneyDeleteCategory') { mm.categories = mm.categories.filter(function (c) { return c.id !== p.id; }); saveDb(d); return { deleted: p.id }; }
      if (action === 'moneyGetTxns') { var lim = Number(p.limit) || 0; var list = mm.txns.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }); return { transactions: lim ? list.slice(0, lim) : list }; }
      if (action === 'moneyAddTxn') { var tx = Object.assign({ id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), date: todayStr() }, p.transaction); mm.txns.push(tx); saveDb(d); return { transaction: tx, status: moneyStatus() }; }
      if (action === 'moneyAddTxns') {
        var added = (p.transactions || []).map(function (t) { return Object.assign({ id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }, t); });
        added.forEach(function (t) { mm.txns.push(t); }); saveDb(d);
        return { added: added.length, transactions: added, status: moneyStatus() };
      }
      if (action === 'moneyDeleteTxn') { mm.txns = mm.txns.filter(function (t) { return t.id !== p.id; }); saveDb(d); return { deleted: p.id, status: moneyStatus() }; }
      if (action === 'moneyUpdateTxn') {
        var etx = mm.txns.filter(function (t) { return t.id === (p.transaction && p.transaction.id); })[0];
        if (etx) Object.assign(etx, p.transaction);
        saveDb(d); return { transaction: etx || null, status: moneyStatus() };
      }
      if (action === 'moneyDashboard') return moneyDashboardCalc();
      if (action === 'moneySaveBudget') {
        mm.budget = { limit: Number(p.overall) || 0, perCategory: p.perCategory || {}, monthlyIncome: Number(p.monthlyIncome) || 0, savingsGoal: Number(p.savingsGoal) || 0 };
        saveDb(d); return { budget: mm.budget, status: moneyStatus() };
      }
      if (action === 'moneyParseScreenshot' || action === 'moneyParseMessage' || action === 'moneyCoachChat') {
        throw new Error('This needs the online backend (Gemini) — not available in demo mode.');
      }
    }

    function myFasts() { return (d.fasts && d.fasts[me.username]) || []; }
    function activeFast() { return myFasts().filter(function (f) { return !f.endAt; })[0] || null; }

    if (action === 'getState') return { user: pub(me), logs: userLogs(me.username), profile: d.profiles && d.profiles[me.username] || {}, activeFast: activeFast() };
    if (action === 'startFast') {
      var ex = activeFast(); if (ex) return { fast: ex };
      d.fasts = d.fasts || {}; var fa = d.fasts[me.username] || (d.fasts[me.username] = []);
      var nf = { id: 'fa_' + Date.now(), startAt: p.startAt || new Date().toISOString(), endAt: '', goalHours: Number(p.goalHours) || 16 };
      fa.push(nf); saveDb(d); return { fast: nf };
    }
    if (action === 'endFast') {
      var act = activeFast(); if (act) { act.endAt = new Date().toISOString(); saveDb(d); }
      return { fast: act || null };
    }
    if (action === 'logPastFast') {
      if (!p.startAt || !p.endAt) throw new Error('Both start and end times are required.');
      d.fasts = d.fasts || {}; var fap = d.fasts[me.username] || (d.fasts[me.username] = []);
      var pf = { id: 'fa_' + Date.now(), startAt: p.startAt, endAt: p.endAt, goalHours: 0 };
      fap.push(pf); saveDb(d); return { fast: pf };
    }
    if (action === 'getFasts') {
      var done = myFasts().filter(function (f) { return f.endAt; }).sort(function (a, b) { return a.startAt < b.startAt ? 1 : -1; });
      return { active: activeFast(), fasts: done.slice(0, 30) };
    }
    if (action === 'updateFast') {
      var fu = myFasts().filter(function (f) { return f.id === p.id; })[0];
      if (fu) { if (p.startAt) fu.startAt = p.startAt; if (p.endAt != null) fu.endAt = p.endAt; saveDb(d); }
      return { fast: fu || null };
    }
    if (action === 'deleteFast') {
      if (d.fasts && d.fasts[me.username]) {
        d.fasts[me.username] = d.fasts[me.username].filter(function (f) { return f.id !== p.id; });
        saveDb(d);
      }
      return { deleted: p.id };
    }
    if (action === 'saveGoals') {
      // Mirrors the real backend: merge onto the stored profile rather than
      // replacing it, so a stale/partial client snapshot can't wipe fields
      // (meds, habits, ...) it doesn't happen to mention.
      d.profiles = d.profiles || {};
      d.profiles[me.username] = Object.assign({}, d.profiles[me.username] || {}, p.profile || {});
      saveDb(d);
      return { profile: d.profiles[me.username] };
    }
    if (action === 'getFood') {
      var all = (d.foods && d.foods[me.username]) || [];
      return { foods: all.filter(function (x) { return x.date === (p.date || todayStr()); }) };
    }
    if (action === 'getFoodRange') {
      var allR = (d.foods && d.foods[me.username]) || [];
      var from = p.from || todayStr(), to = p.to || todayStr();
      var perDay = {};
      allR.filter(function (x) { return x.date >= from && x.date <= to; }).forEach(function (x) {
        var e = perDay[x.date] || (perDay[x.date] = { date: x.date, cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 });
        e.cal += Number(x.calories) || 0; e.p += Number(x.protein) || 0; e.c += Number(x.carbs) || 0;
        e.f += Number(x.fat) || 0; e.s += Number(x.sugar) || 0; e.fb += Number(x.fiber || 0);
      });
      var days = Object.keys(perDay).sort();
      var tot = { cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 };
      days.forEach(function (dt) { var e = perDay[dt]; tot.cal += e.cal; tot.p += e.p; tot.c += e.c; tot.f += e.f; tot.s += e.s; tot.fb += e.fb; });
      var n = days.length;
      function avgR(v) { return n ? Math.round(v / n) : 0; }
      return {
        from: from, to: to, daysLogged: n, perDay: days.map(function (dt) { return perDay[dt]; }),
        total: { cal: Math.round(tot.cal), p: Math.round(tot.p), c: Math.round(tot.c), f: Math.round(tot.f), s: Math.round(tot.s), fb: Math.round(tot.fb) },
        avg: { cal: avgR(tot.cal), p: avgR(tot.p), c: avgR(tot.c), f: avgR(tot.f), s: avgR(tot.s), fb: avgR(tot.fb) }
      };
    }
    if (action === 'addFood') {
      d.foods = d.foods || {}; var arr = d.foods[me.username] || (d.foods[me.username] = []);
      var rec = p.food; rec.id = 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      arr.push(rec); saveDb(d); return { food: rec };
    }
    if (action === 'deleteFood') {
      if (d.foods && d.foods[me.username]) {
        d.foods[me.username] = d.foods[me.username].filter(function (x) { return x.id !== p.id; });
        saveDb(d);
      }
      return { deleted: p.id };
    }
    if (action === 'updateFood') {
      var farr = (d.foods && d.foods[me.username]) || [];
      var row = farr.filter(function (x) { return x.id === p.id; })[0];
      if (row) { ['grams', 'calories', 'protein', 'carbs', 'fat', 'sugar', 'fiber'].forEach(function (k) { row[k] = p.food[k]; }); saveDb(d); }
      return { food: row || null };
    }
    if (action === 'getCustomFoods') {
      return { foods: (d.customFoods || []) };
    }
    if (action === 'addCustomFood') {
      d.customFoods = d.customFoods || [];
      var nm = String(p.food.name || '').trim();
      var dup = d.customFoods.some(function (x) { return x.name.toLowerCase() === nm.toLowerCase(); });
      if (!dup && nm) {
        d.customFoods.push({ id: 'c_' + Date.now(), name: nm, kcal: Math.round(p.food.kcal || 0),
          protein: p.food.p || 0, carbs: p.food.c || 0, fat: p.food.f || 0, sugar: p.food.s || 0 });
        saveDb(d);
      }
      return { food: p.food };
    }
    if (action === 'foodSummary') {
      var all = (d.foods && d.foods[me.username]) || [];
      var tt = { cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 };
      all.forEach(function (x) {
        tt.cal += Number(x.calories) || 0; tt.p += Number(x.protein) || 0; tt.c += Number(x.carbs) || 0;
        tt.f += Number(x.fat) || 0; tt.s += Number(x.sugar) || 0; tt.fb += Number(x.fiber) || 0;
      });
      var days = {}; all.forEach(function (x) { days[x.date] = true; });
      var n = Object.keys(days).length;
      var av = function (v) { return n ? Math.round(v / n) : 0; };
      return { totalCalories: Math.round(tt.cal), daysLogged: n, avgCalories: av(tt.cal),
        avgProtein: av(tt.p), avgCarbs: av(tt.c), avgFat: av(tt.f), avgSugar: av(tt.s), avgFiber: av(tt.fb) };
    }
    if (action === 'saveDay') {
      var day = p.day; day.completed = goalMet(day);
      var arr = d.logs[me.username] || (d.logs[me.username] = []);
      var i = arr.findIndex(function (l) { return l.date === day.date; });
      if (i >= 0) arr[i] = day; else arr.push(day);
      saveDb(d); return { day: day };
    }
    if (action === 'reset') {
      me.startDate = p.startDate || todayStr(); saveDb(d);
      return { user: pub(me), logs: userLogs(me.username) };
    }
    if (action === 'updateProfile') {
      me.displayName = p.displayName || me.displayName; saveDb(d); return { user: pub(me) };
    }
    if (action === 'deleteAccount') {
      if (me.password !== p.password) throw new Error('Password is incorrect.');
      var un = me.username;
      delete d.users[un];
      if (d.logs) delete d.logs[un];
      if (d.foods) delete d.foods[un];
      if (d.fasts) delete d.fasts[un];
      if (d.profiles) delete d.profiles[un];
      saveDb(d); return { deleted: true };
    }
    if (action === 'leaderboard') {
      var today = todayStr();
      var board = Object.keys(d.users).map(function (k) {
        var u = d.users[k], lg = userLogs(k);
        var tl = lg.filter(function (x) { return x.date === today; })[0];
        var done = 0;
        if (tl) {
          ['workout1', 'outdoor', 'reading', 'photo', 'diet', 'noAlcohol'].forEach(function (key) { if (tl[key]) done++; });
          if (Number(tl.waterMl) >= WATER_GOAL) done++;
        }
        var cals = ((d.foods && d.foods[k]) || []).filter(function (x) { return x.date === today; })
          .reduce(function (s, x) { return s + (Number(x.calories) || 0); }, 0);
        var start = u.startDate;
        var doneDates = {};
        lg.forEach(function (x) { if (x.completed && x.date >= start && x.date <= today) doneDates[x.date] = true; });
        return {
          displayName: u.displayName, currentDay: dayNumber(u.startDate, today),
          completedDays: Object.keys(doneDates).length, streak: streakOf(lg),
          todayDone: done, todayTotal: TOTAL_ITEMS, todayComplete: tl ? !!tl.completed : false,
          todayWaterMl: tl ? (Number(tl.waterMl) || 0) : 0,
          todayCalories: Math.round(cals),
          calorieGoal: (d.profiles && d.profiles[k] && d.profiles[k].calorieGoal) || 0
        };
      }).sort(function (a, b) { return b.completedDays - a.completedDays || b.todayDone - a.todayDone; });
      return { leaderboard: board };
    }
    // Friends features aren't meaningful in single-device demo mode — return empties.
    if (action === 'getFriends') return { friends: [], incoming: [], outgoing: [] };
    if (action === 'searchUsers') return { users: [] };
    if (action === 'addFriend') return { status: 'outgoing' };
    if (action === 'respondFriend') return { status: 'friend' };
    if (action === 'removeFriend') return { status: 'removed' };
    if (action === 'coachChat') return { reply: 'The AI coach needs the online backend (Gemini) — it isn’t available in demo mode.' };
    if (action === 'parseScreenTime') throw new Error('Screen Time analysis needs the online backend (Gemini) — not available in demo mode.');
    if (action === 'listGet') { return { items: ((d.lists && d.lists[me.username] && d.lists[me.username][p.kind]) || []).slice() }; }
    if (action === 'listAdd') {
      d.lists = d.lists || {}; d.lists[me.username] = d.lists[me.username] || {};
      var la = d.lists[me.username][p.kind] || (d.lists[me.username][p.kind] = []);
      var rec = Object.assign({ id: 'l_' + Date.now() + Math.random().toString(36).slice(2, 6), createdAt: new Date().toISOString() }, p.item);
      la.push(rec); saveDb(d); return { item: rec };
    }
    if (action === 'listUpdate') {
      var lu = ((d.lists && d.lists[me.username] && d.lists[me.username][p.kind]) || []).filter(function (x) { return x.id === p.id; })[0];
      if (lu) { Object.assign(lu, p.item); saveDb(d); } return { ok: true, id: p.id };
    }
    if (action === 'listDelete') {
      if (d.lists && d.lists[me.username] && d.lists[me.username][p.kind]) d.lists[me.username][p.kind] = d.lists[me.username][p.kind].filter(function (x) { return x.id !== p.id; });
      saveDb(d); return { ok: true, id: p.id };
    }
    throw new Error('Unknown action');
  }

  /* ---------------- domain helpers (challenge-driven) ---------------- */
  function isComplete(d) { return chAllMet(d); }
  function completedCount(d) { return chCount(d); }
  // Retained for legacy callers (Home tiles, toasts): soft = threshold challenge.
  function challengeMode() { return activeCh().pass === 'all' ? 'hard' : 'soft'; }
  function softTarget() { var c = activeCh(); return c.pass === 'all' ? 100 : Number(c.pass) || 70; }
  function softNeeded() { return chNeeded(); }
  // Does this day count toward streak / "completed days"?
  // Days before the active run started keep their stored `completed` flag, so
  // switching challenges never rewrites history / breaks past streaks.
  function goalMet(d) {
    var start = chStart();
    if (start && d.date < start) return !!d.completed;
    return chGoalLive(d);
  }
  function streakOf(logs) {
    // Count consecutive complete days ending today (or yesterday if today's
    // still in progress, so an unfinished today doesn't zero your streak).
    var set = {};
    logs.forEach(function (l) { if (goalMet(l)) set[l.date] = true; });
    var d = todayStr();
    if (!set[d]) d = addDays(d, -1);
    var s = 0;
    while (set[d]) { s++; d = addDays(d, -1); }
    return s;
  }
  function emptyDay(date) {
    return { date: date, dayNumber: state.user ? dayNumber(state.user.startDate, date) : 1,
      workout1: false, workout2: false, outdoor: false, waterMl: 0,
      reading: false, photo: false, diet: false, noAlcohol: false, completed: false, notes: '',
      extra: { noCig: false }, mood: 0, gut: 0, biz: {}, metrics: {} };
  }
  function logFor(date) {
    return state.logs.filter(function (l) { return l.date === date; })[0];
  }
  // Keep one log per date (the most complete), guarding against duplicate rows.
  function dedupeLogs(logs) {
    var m = {};
    logs.forEach(function (l) {
      var ex = m[l.date];
      if (!ex || (isComplete(l) && !isComplete(ex))) m[l.date] = l;
    });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }

  /* ---------------- Auth UI ---------------- */
  function initAuth() {
    var di = $('#register-form [name=startDate]');
    if (di) di.value = todayStr();
    if (OFFLINE) $('.offline-note').classList.remove('hidden');

    document.querySelectorAll('[data-authtab]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('[data-authtab]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        var login = b.dataset.authtab === 'login';
        $('#login-form').classList.toggle('hidden', !login);
        $('#register-form').classList.toggle('hidden', login);
        authMsg('');
      });
    });

    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      authSubmit('login', { username: f.username.value, password: f.password.value }, 'Logging in…');
    });

    $('#register-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      authSubmit('register', {
        username: f.username.value, password: f.password.value, displayName: f.displayName.value,
        startDate: f.startDate.value, email: f.email.value
      }, 'Setting up…');
    });
  }

  function authMsg(msg, cls, retry) {
    var m = $('#auth-msg');
    m.className = 'form-msg' + (cls ? ' ' + cls : '');
    if (retry) {
      m.innerHTML = '';
      m.appendChild(document.createTextNode(msg || ''));
      var b = el('button', 'link-btn auth-retry-btn', 'Try again');
      b.type = 'button';
      b.addEventListener('click', retry);
      m.appendChild(document.createTextNode(' '));
      m.appendChild(b);
    } else {
      m.textContent = msg || '';
    }
  }

  function authSubmit(action, payload, busy) {
    authMsg(busy);
    api(action, payload, function (attempt, total) {
      // Live progress during the ~8s retry window, so a slow connection reads
      // as "still working" instead of a frozen button.
      authMsg('Still trying to reach the server… (' + attempt + '/' + total + ')');
    }).then(function (data) {
      state.token = data.token; state.username = data.user.username; state.user = data.user;
      localStorage.setItem('hard_token', state.token);
      localStorage.setItem('hard_user', state.username);
      authMsg('');
      return loadState();
    }).then(enterApp).catch(function (err) {
      authMsg(err.message, 'error', function () { authSubmit(action, payload, busy); });
    });
  }

  /* ---------------- App boot ---------------- */
  function loadState() {
    return api('getState', {}).then(function (data) {
      state.user = data.user;
      state.logs = dedupeLogs(data.logs || []);
      state.user.currentDay = dayNumber(state.user.startDate, todayStr());
      state.profile = data.profile || {};
      state._ch = null;          // recompute active challenge from the fresh profile
      syncChallenge();
      state.activeFast = data.activeFast || null;
      reconcilePendingFast();    // push a locally-started fast the server never got, if any
      reconcileDetoxSession();   // sync an in-progress detox timer with the server, either direction
      var t = logFor(todayStr());
      state.today = t ? Object.assign(emptyDay(todayStr()), t) : emptyDay(todayStr());
      lastXpLevel = levelInfo(xpTotals().total).level;   // seed baseline once data is ready
      cacheState();
      // Safe to run only here: state.logs/profile are freshly loaded from the
      // network. enterApp() also runs optimistically against a STALE cached
      // snapshot before this resolves — migrating there would process an
      // incomplete log list and mark itself done, silently skipping the real
      // data once it arrives.
      migrateLegacyGutData();
    });
  }
  function cacheState() {
    localStorage.setItem('hard_cache', JSON.stringify({ user: state.user, logs: state.logs }));
  }

  function enterApp() {
    hide('#auth-screen'); show('#app-screen');
    $('#set-version').textContent = '75 Hard Tracker v' + CFG.APP_VERSION + (OFFLINE ? ' · demo mode' : '');
    bindAppEvents();
    loadCustomFoods();
    renderAll();
    switchView('home');
    prefetchStats();   // warm Stats averages in the background
    refreshCharge();   // load the AI-cost battery
  }

  function loadCustomFoods() {
    api('getCustomFoods', {}).then(function (data) {
      state.customFoods = (data.foods || []).map(function (f) {
        return { name: f.name, kcal: f.kcal, p: f.protein, c: f.carbs, f: f.fat, s: f.sugar, fb: f.fiber || 0, serving: 100, shared: true };
      });
    }).catch(function () {});
  }

  function bindAppEvents() {
    if (bindAppEvents.done) return; bindAppEvents.done = true;
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchView(b.dataset.view); });
    });
    $('#sync-state').addEventListener('click', function () {
      flushPendingSaves();   // push any queued change first, so the re-read isn't stale
      loadState().then(renderAll).then(function () { toast('Synced'); });
    });
    // Never lose an in-flight change when the app is backgrounded or closed —
    // mobile browsers kill pending timers, which used to revert quick toggles.
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushPendingSaves(); });
    window.addEventListener('pagehide', flushPendingSaves);
    $('#save-day').addEventListener('click', function () {
      var d = appDay();
      if (d.date === todayStr()) { pushToday(true); }
      else { queueSaveDay(d); toast('Saved ' + shortDate(d.date) + ' ✓'); }
    });
    $('#day-notes').addEventListener('input', function () {
      var d = appDay(); d.notes = this.value; queueSaveDay(d);
    });
    $('#add-habit-btn').addEventListener('click', addHabit);
    $('#new-habit').addEventListener('keydown', function (e) { if (e.key === 'Enter') addHabit(); });
    $('#add-biz-btn').addEventListener('click', addBusiness);
    $('#new-biz').addEventListener('keydown', function (e) { if (e.key === 'Enter') addBusiness(); });
    $('#logout').addEventListener('click', logout);
    $('#reset-challenge').addEventListener('click', resetChallenge);
    $('#save-profile').addEventListener('click', saveProfile);
    $('#acct-email-btn').addEventListener('click', acctEmailSave);
    document.querySelectorAll('#mode-seg [data-mode]').forEach(function (b) {
      b.addEventListener('click', function () { pickMode(b.dataset.mode); });
    });
    $('#save-mode').addEventListener('click', saveMode);
    $('#set-ch-open').addEventListener('click', function () { switchView('challenges'); });
    $('#set-ch-browse').addEventListener('click', function () { switchView('challenges'); });
    $('#acct-username-btn').addEventListener('click', acctChangeUsername);
    $('#acct-pw-btn').addEventListener('click', acctChangePassword);
    $('#save-startdate').addEventListener('click', saveStartDate);
    $('#delete-account').addEventListener('click', deleteAccount);
    // Journey month navigation + Life Score history chips
    $('#cal-prev').addEventListener('click', function () {
      state.calMonth = ymShift(state.calMonth || ymOf(todayStr()), -1);
      renderCalendar();
    });
    $('#cal-next').addEventListener('click', function () {
      state.calMonth = ymShift(state.calMonth || ymOf(todayStr()), 1);
      renderCalendar();
    });
    $('#month-report').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-ym]');
      if (chip) { state.calMonth = chip.getAttribute('data-ym'); renderCalendar(); }
    });
    $('#home-score').addEventListener('click', function () {
      state.calMonth = ymOf(todayStr());
      switchView('calendar');
    });
    $('#day-close').addEventListener('click', function () { hide('#day-modal'); });
    $('#day-modal').addEventListener('click', function (e) { if (e.target.id === 'day-modal') hide('#day-modal'); });
    $('#day-save').addEventListener('click', saveDayEditor);
    $('#de-notes').addEventListener('input', function () { if (state.editDay) state.editDay.notes = this.value; });
    document.querySelectorAll('[data-calc]').forEach(function (b) {
      b.addEventListener('click', function () { calcDispatch(b.dataset.calc); });
    });
    $('#bf-sex').addEventListener('change', function () {
      $('#bf-hip-wrap').classList.toggle('hidden', this.value !== 'female');
    });
    // Once the user edits an auto-filled Calc field, stop overwriting it —
    // everything else keeps syncing live from the latest Body log.
    $('#view-calc').addEventListener('input', function (e) { if (e.target.id) state.calcTouched[e.target.id] = true; });
    $('#view-calc').addEventListener('change', function (e) { if (e.target.id) state.calcTouched[e.target.id] = true; });
    $('#fx-sound').addEventListener('change', function () { FX.set('sound', this.checked); });
    $('#fx-haptics').addEventListener('change', function () { FX.set('haptics', this.checked); });
    // Admin dashboard
    $('#open-admin').addEventListener('click', function () { switchView('admin'); });
    $('#admin-back').addEventListener('click', function () { switchView('settings'); });
    document.querySelectorAll('#admin-tabs [data-atab]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#admin-tabs [data-atab]').forEach(function (x) { x.classList.toggle('active', x === b); });
        ['scans', 'users', 'foods'].forEach(function (t) { $('#admin-pane-' + t).classList.toggle('hidden', t !== b.dataset.atab); });
      });
    });
    $('#admin-food-filter').addEventListener('input', function () { renderAdminFoods(); });
    $('#admin-foods-list').addEventListener('click', function (e) {
      var save = e.target.closest('[data-save]'); var del = e.target.closest('[data-del]');
      if (save) adminSaveFood(save.getAttribute('data-save'), save);
      if (del) adminDeleteFood(del.getAttribute('data-del'));
    });
    $('#admin-users-list').addEventListener('click', function (e) {
      var r = e.target.closest('[data-resetpw]');
      if (r) adminResetUserPassword(r.getAttribute('data-resetpw'));
    });
    // Friends tabs + actions
    document.querySelectorAll('#board-tabs [data-btab]').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('#board-tabs [data-btab]').forEach(function (x) { x.classList.toggle('active', x === b); });
        ['feed', 'requests', 'add'].forEach(function (t) { $('#board-pane-' + t).classList.toggle('hidden', t !== b.dataset.btab); });
        if (b.dataset.btab === 'add') setTimeout(function () { $('#friend-search').focus(); }, 50);
      });
    });
    $('#friend-search').addEventListener('input', function () {
      clearTimeout(friendSearchTimer);
      var q = this.value;
      friendSearchTimer = setTimeout(function () { runFriendSearch(q); }, 300);
    });
    $('#view-board').addEventListener('click', function (e) {
      var t = e.target.closest('[data-add],[data-accept],[data-decline],[data-cancel]');
      if (!t) return;
      if (t.hasAttribute('data-add')) addFriend(t.getAttribute('data-add'));
      else if (t.hasAttribute('data-accept')) respondFriend(t.getAttribute('data-accept'), true);
      else if (t.hasAttribute('data-decline')) respondFriend(t.getAttribute('data-decline'), false);
      else if (t.hasAttribute('data-cancel')) { e.preventDefault(); removeFriend(t.getAttribute('data-cancel')); }
    });
    // ATLAS home + library
    $('#view-home').addEventListener('click', function (e) {
      var qa = e.target.closest('[data-qa]'); var pil = e.target.closest('[data-pillar]');
      if (e.target.closest('#home-journey-open')) { switchView('calendar'); return; }
      if (qa) homeQuickAction(qa.getAttribute('data-qa'));
      else if (pil) switchView('library');
    });
    $('#library-groups').addEventListener('click', function (e) {
      var t = e.target.closest('[data-app]');
      if (t) openApp(t.getAttribute('data-app'));
    });
    // AI Coach
    $('#coach-fab').addEventListener('click', function () { openCoach('hard'); });
    $('#coach-close').addEventListener('click', function () { hide('#coach-modal'); });
    $('#coach-clear').addEventListener('click', clearCoach);
    $('#coach-send').addEventListener('click', sendCoach);
    $('#coach-modal').addEventListener('click', function (e) { if (e.target.id === 'coach-modal') hide('#coach-modal'); });
    $('#coach-text').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(96, this.scrollHeight) + 'px'; });
    $('#coach-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCoach(); }
    });
    bindDietEvents();
  }

  function switchView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.add('hidden'); });
    $('#view-' + name).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    if (name !== 'diet' && name !== 'fast') stopFastTimer();
    if (name !== 'breathe') stopBreathe();
    if (name !== 'challenges') state.chBuilder = null;
    // A running meditation keeps ticking across views (it chimes + banks itself);
    // the manifest practice flow, though, resets if you walk away mid-card.
    if (name !== 'manifest' && manifest.step !== -1) { manifest.step = -1; stopManifestViz(); }
    // Leaving the mini-apps resets day-editing back to today.
    if (name === 'home' || name === 'today' || name === 'library') state.appDate = null;
    if (name === 'home') renderHome();
    if (name === 'library') renderLibrary();
    if (name === 'today') renderToday();
    if (name === 'water') renderWaterApp();
    if (name === 'fast') renderFasting();
    if (name === 'mood') renderMoodApp();
    if (name === 'us') renderUsApp();
    if (name === 'avatar') renderAvatar();
    if (name === 'gut') renderGutApp();
    if (name === 'habits') renderHabitsApp();
    if (name === 'work') renderWorkApp();
    if (name === 'journal') renderJournal();
    if (name === 'reading') renderReading();
    if (name === 'steps') renderSteps();
    if (name === 'sleep') renderSleep();
    if (name === 'body') renderBody();
    if (name === 'gym') renderGym();
    if (name === 'breathe') renderBreathe();
    if (name === 'detox') renderDetox();
    if (name === 'meditate') renderMeditate();
    if (name === 'manifest') renderManifest();
    if (name === 'challenges') renderChallenges();
    if (name === 'meds') renderMeds();
    if (name === 'money') renderMoney();
    if (name === 'subs') renderSubs();
    if (name === 'savings') renderSavings();
    if (name === 'tasks') renderTasks();
    if (name === 'goals') renderGoals();
    if (name === 'diet') renderDiet();
    if (name === 'calendar') renderCalendar();
    if (name === 'stats') renderStats();
    if (name === 'board') renderBoard();
    if (name === 'calc') renderCalc();
    if (name === 'settings') renderSettings();
    if (name === 'admin') renderAdmin();
    window.scrollTo(0, 0);
  }

  /* ---------------- Render: header + today ---------------- */
  function renderAll() {
    $('#hdr-name').textContent = firstName(state.user.displayName);
    var cd = chDay();                 // day within the active challenge
    var pill = $('.day-pill');
    pill.onclick = null; pill.style.cursor = '';
    if (state.user.currentDay > 2000 || state.user.currentDay < 0) {
      pill.innerHTML = '⚠️ Set start date';
      pill.style.cursor = 'pointer';
      pill.onclick = function () { switchView('settings'); };
    } else if (!LEN) {               // open-ended challenge — just count up
      pill.innerHTML = 'Day <span id="hdr-day">' + Math.max(1, cd) + '</span>';
    } else if (cd <= LEN) {
      pill.innerHTML = 'Day <span id="hdr-day">' + Math.max(1, cd) + '</span> <span class="muted">/ ' + LEN + '</span>';
    } else {
      pill.innerHTML = 'Day <span id="hdr-day">' + cd + '</span> <span class="muted">🏆</span>';
    }
    renderToday();
  }
  function firstName(n) { return String(n || 'athlete').split(' ')[0]; }

  function renderToday() {
    var d = appDay();
    var isToday = appDate() === todayStr();
    // Date bar on top — navigate to (and edit) any past day, like the mini-apps.
    var bar = $('#today-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderToday); }
    // Hard-reset banner (only on today, only for strict challenges after a miss).
    var banner = $('#today-banner');
    if (banner) { banner.innerHTML = isToday ? chResetBannerHtml() : ''; bindResetBanner(banner); }
    $('#today-date').textContent = isToday ? prettyDate(d.date) : prettyDate(d.date);

    // Rules of the active challenge (rendered in order; water gets its widget).
    var list = $('#tasklist');
    list.innerHTML = '';
    chRules().forEach(function (rule) {
      if (rule.t === 'water') { list.appendChild(renderWaterCompact(d)); return; }
      var v = ruleView(rule);
      var done = ruleMet(d, rule);
      var row = el('div', 'task' + (done ? ' done' : '') + (v.metric ? ' task-metric' : ''));
      var progress = '';
      if (v.metric) {
        var cur = Number((d.metrics || {})[rule.key]) || 0;
        var mfmt = (CH_METRICS[rule.key] && CH_METRICS[rule.key].fmt) || function (x) { return x; };
        progress = '<div class="t-sub">' + mfmt(cur) + ' / ' + mfmt(rule.min) + ' · tap to open ›</div>';
      }
      row.innerHTML =
        '<div class="check">✓</div>' +
        '<div class="t-emoji">' + v.emoji + '</div>' +
        '<div class="t-body"><div class="t-title">' + esc(v.title) + '</div>' +
        (v.metric ? progress : '<div class="t-sub">' + esc(v.sub) + '</div>') + '</div>';
      row.addEventListener('click', function () {
        if (v.metric && v.app) { switchView(v.app); return; }   // deep-link, not toggle
        var before = dayXp(d).total;
        ruleToggle(d, rule);
        var delta = dayXp(d).total - before;
        renderToday();
        queueSaveDay(d);
        gamifyAfterToggle(delta);                                // floater + level-up
      });
      list.appendChild(row);
    });
    if (!chHasWater()) { /* water is optional for this challenge */ }

    // ring / status
    var count = completedCount(d);
    var pct = Math.round((count / TOTAL_ITEMS) * 100);
    var met = goalMet(d);
    var soft = challengeMode() === 'soft';
    var ring = $('#ring-fg');
    var circ = 2 * Math.PI * 52;
    ring.style.strokeDashoffset = circ * (1 - count / TOTAL_ITEMS);
    ring.style.stroke = met ? 'var(--green)' : 'var(--primary)';
    $('#ring-pct').textContent = pct + '%';
    var rc = $('#ring-center-label'); if (rc) rc.textContent = isToday ? 'today' : 'day ' + Math.max(1, dayNumber(chStart(), d.date));

    var st = $('#today-status');
    if (met) { st.textContent = soft ? 'Goal met! 🎉' : 'Day complete! 🎉'; st.className = 'status-chip done'; }
    else { st.textContent = count + ' / ' + TOTAL_ITEMS + ' done' + (soft ? ' · need ' + softNeeded() : ''); st.className = 'status-chip pending'; }

    $('#streak-line').textContent = '🔥 ' + streakOf(state.logs) + ' day streak · ' + activeCh().emoji + ' ' + esc(activeCh().name);
    renderTodayExtras();
  }

  /* ----- Journal (mood check-in + note) ----- */
  function renderJournal() {
    var bar = $('#journal-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderJournal); }
    renderMood(appDay(), '#journal-mood');
    $('#day-notes').value = appDay().notes || '';
  }

  /* ----- Mood: three dimensions (emotional / mental / physical) -----
     Emotional stays in d.mood (backward-compatible with Life Score, calendar
     colours and the Journal); mental & physical ride the day-log metrics. */
  var MOOD_DIMS = [
    { key: 'mood',         inMetrics: false, label: 'Emotional', emoji: '❤️', sub: 'how you feel' },
    { key: 'moodMental',   inMetrics: true,  label: 'Mental',    emoji: '🧠', sub: 'focus & clarity' },
    { key: 'moodPhysical', inMetrics: true,  label: 'Physical',  emoji: '💪', sub: 'energy & body' }
  ];
  function moodDimGet(d, dim) { return dim.inMetrics ? (Number((d.metrics || {})[dim.key]) || 0) : (Number(d[dim.key]) || 0); }
  function moodDimSet(d, dim, v) { if (dim.inMetrics) { if (!d.metrics) d.metrics = {}; d.metrics[dim.key] = v; } else { d[dim.key] = v; } }
  function moodAvg(d) {
    var vals = MOOD_DIMS.map(function (dim) { return moodDimGet(d, dim); }).filter(function (x) { return x > 0; });
    return vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) / vals.length : 0;
  }
  function moodColorAvg(d) { var a = moodAvg(d); return a ? moodColor(Math.round(a)) : null; }

  function renderMoodDimensions(d, sel) {
    var box = $(sel); if (!box) return;
    box.innerHTML = MOOD_DIMS.map(function (dim) {
      var cur = moodDimGet(d, dim);
      return '<div class="mood-dim"><div class="mood-dim-lbl">' + dim.emoji + ' <b>' + dim.label + '</b> <span class="muted tiny">· ' + dim.sub + '</span></div>' +
        '<div class="mood-buttons" data-mdim="' + dim.key + '">' + MOODS.map(function (m) {
          return '<button type="button" class="mood-btn' + (cur === m.v ? ' sel' : '') + '" style="--mc:' + m.color + '" data-mv="' + m.v + '">' +
            '<span class="mood-emoji">' + m.emoji + '</span><span class="mood-label">' + m.label + '</span></button>';
        }).join('') + '</div></div>';
    }).join('');
    box.querySelectorAll('[data-mdim]').forEach(function (row) {
      var dim = MOOD_DIMS.filter(function (x) { return x.key === row.getAttribute('data-mdim'); })[0];
      row.querySelectorAll('[data-mv]').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = Number(b.getAttribute('data-mv'));
          moodDimSet(d, dim, moodDimGet(d, dim) === v ? 0 : v);
          queueSaveDay(d);
          renderMoodApp();
          if (!$('#view-journal').classList.contains('hidden') && dim.key === 'mood') renderMood(d, '#journal-mood');
        });
      });
    });
  }

  function renderMoodApp() {
    var bar = $('#mood-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderMoodApp); }
    renderMoodDimensions(appDay(), '#mood-dims');
    var cal = $('#mood-cal');
    if (cal) {
      buildDayPicker(cal, ymOf(appDate()), renderMoodApp, function (date) {
        var l = logFor(date);
        return l ? moodColorAvg(l) : null;   // calendar colour = avg of the three
      });
      cal.classList.remove('hidden');
    }
    var leg = $('#mood-legend');
    if (leg) leg.innerHTML = MOODS.map(function (mm) {
      return '<span class="gt-key"><i style="background:' + mm.color + '"></i>' + mm.emoji + ' ' + mm.label + '</span>';
    }).join('');
    renderMoodRange();
  }
  function renderMoodRange() {
    var box = $('#mood-range'); if (!box) return;
    var rs = rangeState('moodrg');
    box.innerHTML = rangeBarHtml('moodrg');
    if (rs.mode === 'day') { bindRangeBar(box, 'moodrg', renderMoodApp); return; }
    var r = rangeSpan(rs.mode, rs.anchor);
    // Overall (avg of the three) hero + a per-dimension breakdown.
    var agg = rangeAgg(r.from, r.to, function (l) { var a = l ? moodAvg(l) : 0; return a > 0 ? a : null; });
    var best = MOODS.filter(function (m) { return m.v === Math.round(agg.avg); })[0];
    var dimRows = MOOD_DIMS.map(function (dim) {
      var da = rangeAgg(r.from, r.to, function (l) { var v = l ? moodDimGet(l, dim) : 0; return v > 0 ? v : null; });
      var w = da.logged ? Math.round(da.avg / 5 * 100) : 0;
      return '<div class="mr-row"><span class="mr-name">' + dim.emoji + ' ' + dim.label + '</span>' +
        '<div class="mr-bar"><span style="width:' + w + '%;background:var(--mind-c)"></span></div>' +
        '<span class="mr-val mono">' + (da.logged ? da.avg.toFixed(1) : '—') + '</span></div>';
    }).join('');
    box.innerHTML += '<div class="card hero-row">' +
      ringMini(pctOf(agg.avg, 5), best ? best.color : 'var(--mind-c)', 92, '<b>' + (agg.logged ? agg.avg.toFixed(1) : '—') + '</b>') +
      '<div class="hero-meta"><div class="metric-big"><b>' + (agg.logged ? agg.avg.toFixed(1) + '/5 ' + (best ? best.emoji : '') : 'No logs') + '</b></div>' +
      '<div class="muted tiny">overall · ' + agg.logged + ' of ' + agg.days + ' days logged</div></div></div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:6px">By dimension · avg</div>' + dimRows + '</div>' +
      (agg.logged ? '<div class="card"><div class="eyebrow">Overall mood per day</div>' + rangeBarChart(agg.perDay, 'var(--mind-c)') + '</div>' : '');
    bindRangeBar(box, 'moodrg', renderMoodApp);
  }
  function gutBar(pct, color) { return '<div class="gut-bar"><span style="width:' + Math.max(0, Math.min(100, pct)) + '%;background:' + color + '"></span></div>'; }
  function gutStepperHtml(field, label, emoji, val, unit) {
    return '<div class="gut-step-row"><span>' + emoji + ' ' + label + '</span>' +
      '<div class="gut-stepper"><button type="button" class="gs-dec" data-gk="' + field + '">−</button>' +
      '<b id="gs-' + field + '">' + (val || 0) + (unit || '') + '</b>' +
      '<button type="button" class="gs-inc" data-gk="' + field + '">+</button></div></div>';
  }
  function renderGutApp() {
    var box = $('#gut-app'); if (!box) return;
    var bar = $('#gut-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderGutApp); }
    var d = appDay(), g = gutOf(d);
    // Only trust d.gut as a real Bristol pick if extra.gut.bristol confirms it —
    // guards against legacy pre-Bristol-scale data (old value 1 meant "didn't
    // go", now value 1 means Pellets) showing up as a false selection.
    var confirmedGut = (d.gut && g.bristol === d.gut) ? d.gut : 0;
    var sel = GUT.filter(function (x) { return x.v === confirmedGut; })[0];
    var plantsWk = gutWeekSum('plants'), ferm = Number(g.fermented) || 0;
    var fiber = dietFiberFor(d.date);   // auto from the Diet log (null = loading)
    // Persist the diet-sourced fibre so the weekly trends can read it.
    if (fiber != null && (Number(g.fiber) || 0) !== fiber) { gutPatch(d, { fiber: fiber }); queueSaveDay(d); }
    var waterMl = Number(d.waterMl) || 0, waterPct = pctOf(waterMl, WATER_GOAL);
    var ideal = gutIdealRate();
    var sleepMin = Number((d.metrics || {}).sleepMin) || 0;
    var moved = d.workout1 || d.outdoor || (Number((d.metrics || {}).steps) || 0) >= 6000;

    var html =
      // ---- Bowel movement (Bristol scale) ----
      '<div class="card"><div class="gut-head"><span class="eyebrow">💩 Bowel movement</span>' +
        '<span class="muted tiny">Bristol scale · aim for 3–4</span></div>' +
        '<div class="gut-bristol' + (g.noGo ? ' gut-bristol-off' : '') + '">' + GUT.map(function (t) {
          return '<button type="button" class="gbr' + (confirmedGut === t.v && !g.noGo ? ' sel' : '') + (t.tier === 'Ideal' ? ' ideal' : '') + '" data-bristol="' + t.v + '" style="--gc:' + t.color + '">' +
            '<span class="gbr-n">' + t.v + '</span><span class="gbr-emoji">' + bristolSvg(t.v) + '</span><span class="gbr-name">' + t.short + '</span></button>';
        }).join('') + '</div>' +
        (g.noGo ? '<div class="gut-sel-note"><b style="color:' + GUT_NOGO_COLOR + '">🚫 No bowel movement</b> — didn’t go today.</div>'
             : sel ? '<div class="gut-sel-note"><b style="color:' + sel.color + '">' + sel.label + ' · ' + sel.tier + '</b> — ' + esc(sel.sub) + '</div>'
             : '<div class="muted tiny" style="margin-top:8px">Tap the type that matches. Types 3–4 are the healthy target.</div>') +
        '<button type="button" class="gut-nogo-btn' + (g.noGo ? ' on' : '') + '" id="gut-nogo">🚫 ' + (g.noGo ? 'Marked as no BM today' : "Didn't go today") + '</button>' +
        (g.noGo ? '' : gutStepperHtml('bm', 'Times today', '🔁', Number(g.bm) || 0, '')) +
      '</div>' +
      // ---- Symptoms ----
      '<div class="card"><span class="eyebrow">📊 Symptoms today</span>' +
        '<p class="muted tiny" style="margin:2px 0 12px">0 = none · 10 = severe. Track how strong each felt.</p>' +
        GUT_SYMPTOMS.map(function (s) {
          var v = Number(g[s.key]) || 0;
          return '<div class="gut-slider"><div class="gsl-top"><span>' + s.emoji + ' ' + s.label + '</span><b id="gv-' + s.key + '">' + v + '</b></div>' +
            '<input type="range" min="0" max="10" step="1" value="' + v + '" data-gsl="' + s.key + '" class="gut-range-input"></div>';
        }).join('') +
        '<div class="gut-slider"><div class="gsl-top"><span>🧠 Stress</span><b id="gv-stress">' + (Number(g.stress) || 0) + '</b></div>' +
          '<input type="range" min="0" max="10" step="1" value="' + (Number(g.stress) || 0) + '" data-gsl="stress" class="gut-range-input"></div>' +
      '</div>' +
      // ---- Feed your microbiome ----
      '<div class="card"><span class="eyebrow">🌱 Feed your microbiome</span>' +
        '<div class="gut-target"><div class="gt-top"><span>🥦 Plant diversity</span><b>' + plantsWk + ' / ' + GUT_PLANTS_WK + ' this week</b></div>' +
          gutBar(plantsWk / GUT_PLANTS_WK * 100, '#22c55e') +
          gutStepperHtml('plants', 'Unique plants today', '🥕', Number(g.plants) || 0, '') + '</div>' +
        '<div class="gut-target"><div class="gt-top"><span>🌾 Fibre today</span><b>' + (fiber == null ? '…' : fiber + ' g') + ' <span class="muted">/ ' + GUT_FIBER_MIN + '–' + GUT_FIBER_MAX + ' g</span></b></div>' +
          gutBar((fiber || 0) / GUT_FIBER_MAX * 100, (fiber || 0) >= GUT_FIBER_MIN ? '#22c55e' : '#eab308') +
          '<p class="muted tiny" style="margin:6px 0 0">Auto-summed from what you logged in <button class="link-btn gut-open-diet" type="button" style="margin:0;padding:0">Diet ›</button></p></div>' +
        gutStepperHtml('fermented', 'Fermented servings (kefir, yogurt, kimchi…)', '🫙', ferm, '') +
        '<div class="gut-target" style="margin-top:12px"><div class="gt-top"><span>💧 Hydration</span><b>' + litres(waterMl) + ' / ' + litres(WATER_GOAL) + ' L</b></div>' +
          gutBar(waterPct, '#38bdf8') +
          '<p class="muted tiny" style="margin:6px 0 0">Fibre needs water to move — logged from your <button class="link-btn gut-open-water" type="button" style="margin:0;padding:0">Water app ›</button></p></div>' +
      '</div>' +
      // ---- This week / modulators ----
      '<div class="card"><span class="eyebrow">📈 Gut vitals</span>' +
        '<div class="gut-tiles">' +
          gutTile('✅ Ideal stool', ideal == null ? '—' : ideal + '%', 'last 30 days (type 3–4)') +
          gutTile('🥦 Plants', plantsWk + '/' + GUT_PLANTS_WK, 'this week') +
          gutTile('😴 Sleep', sleepMin ? hoursMin(sleepMin) : '—', '7–9h target · from Sleep') +
          gutTile('🏃 Movement', moved ? 'Yes' : '—', '30+ min aids motility') +
        '</div></div>' +
      // ---- Calendar ----
      '<div class="card"><h3>Bristol calendar</h3><p class="muted tiny" style="margin:0 0 8px">Tap a day to view or edit it. Green = ideal (3–4).</p>' +
        '<div id="gut-cal"></div>' +
        '<div class="gt-legend" style="margin-top:10px">' + GUT.map(function (t) {
          return '<span class="gt-key"><i style="background:' + t.color + '"></i>' + t.v + ' ' + t.short + '</span>';
        }).join('') + '<span class="gt-key"><i style="background:' + GUT_NOGO_COLOR + '"></i>No BM</span></div></div>' +
      // ---- Trends ----
      '<div id="gut-range"></div>';

    box.innerHTML = html;

    // Calendar
    buildDayPicker($('#gut-cal'), ymOf(appDate()), renderGutApp, function (date) {
      return gutCalColor(logFor(date));
    });

    // Bristol type (picking one clears any "no BM" mark — mutually exclusive)
    box.querySelectorAll('[data-bristol]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = Number(b.getAttribute('data-bristol'));
        var cur = (d.gut && gutOf(d).bristol === d.gut) ? d.gut : 0;
        gutPatch(d, { bristol: cur === v ? 0 : v, noGo: false });
        queueSaveDay(d); renderGutApp();
      });
    });
    var nogoBtn = $('#gut-nogo');
    if (nogoBtn) nogoBtn.addEventListener('click', function () {
      var now = !gutOf(d).noGo;
      gutPatch(d, now ? { noGo: true, bristol: 0 } : { noGo: false });
      queueSaveDay(d); renderGutApp();
    });
    // Steppers (bm, plants, fermented)
    box.querySelectorAll('.gs-inc, .gs-dec').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-gk'), cur = Number(gutOf(d)[k]) || 0;
        var next = Math.max(0, cur + (b.classList.contains('gs-inc') ? 1 : -1));
        var patch = {}; patch[k] = next; gutPatch(d, patch);
        queueSaveDay(d);
        if (k === 'plants') renderGutApp();       // updates the weekly bar
        else $('#gs-' + k).textContent = next;
      });
    });
    // Symptom + stress sliders — live label, debounced save, no full re-render.
    box.querySelectorAll('.gut-range-input').forEach(function (r) {
      r.addEventListener('input', function () {
        var k = r.getAttribute('data-gsl'), v = Number(r.value);
        var lab = $('#gv-' + k); if (lab) lab.textContent = v;
        var patch = {}; patch[k] = v; gutPatch(d, patch);
        clearTimeout(state.gutSaveTimer); state.gutSaveTimer = setTimeout(function () { queueSaveDay(d); }, 400);
      });
    });
    var wbtn = box.querySelector('.gut-open-water');
    if (wbtn) wbtn.addEventListener('click', function () { switchView('water'); });
    var dbtn = box.querySelector('.gut-open-diet');
    if (dbtn) dbtn.addEventListener('click', function () { switchView('diet'); });

    renderGutRange();
  }
  function gutTile(label, val, sub) {
    return '<div class="gut-tile"><div class="gt-lbl eyebrow">' + label + '</div><div class="gt-val">' + val + '</div><div class="muted tiny">' + sub + '</div></div>';
  }
  function renderGutRange() {
    var box = $('#gut-range'); if (!box) return;
    var rs = rangeState('gutrg');
    box.innerHTML = rangeBarHtml('gutrg');
    if (rs.mode === 'day') { bindRangeBar(box, 'gutrg', renderGutApp); return; }
    var r = rangeSpan(rs.mode, rs.anchor);
    var dates = rangeDatesList(r.from, r.to).filter(function (x) { return x <= todayStr(); });
    var counts = {}, logged = 0, idealDays = 0, noGoDays = 0, symSum = { bloat: 0, gas: 0, heartburn: 0, energy: 0, stress: 0 }, symN = 0, plants = 0, fiberSum = 0, fiberN = 0, ferm = 0;
    dates.forEach(function (dt) {
      var l = logFor(dt); if (!l) return;
      var gg = gutOf(l);
      if (gg.noGo) noGoDays++;
      else if (l.gut && gg.bristol === l.gut) { counts[l.gut] = (counts[l.gut] || 0) + 1; logged++; if (l.gut === 3 || l.gut === 4) idealDays++; }
      if (Object.keys(gg).length) {
        symN++; ['bloat', 'gas', 'heartburn', 'energy', 'stress'].forEach(function (k) { symSum[k] += Number(gg[k]) || 0; });
        plants += Number(gg.plants) || 0; ferm += Number(gg.fermented) || 0;
        if (gg.fiber != null) { fiberSum += Number(gg.fiber) || 0; fiberN++; }
      }
    });
    var distro = GUT.map(function (t) {
      var c = counts[t.v] || 0, pct = logged ? Math.round(c / logged * 100) : 0;
      return '<div class="mr-row"><span class="mr-name" style="width:74px">' + t.v + ' ' + t.short + '</span>' +
        '<div class="mr-bar"><span style="width:' + pct + '%;background:' + t.color + '"></span></div>' +
        '<span class="mr-val mono">' + c + '</span></div>';
    }).join('') + (noGoDays ? '<div class="mr-row"><span class="mr-name" style="width:74px">🚫 No BM</span>' +
      '<div class="mr-bar"><span style="width:' + Math.round(noGoDays / (logged + noGoDays) * 100) + '%;background:' + GUT_NOGO_COLOR + '"></span></div>' +
      '<span class="mr-val mono">' + noGoDays + '</span></div>' : '');
    var symRows = GUT_SYMPTOMS.concat([{ key: 'stress', label: 'Stress', emoji: '🧠' }]).map(function (s) {
      var avg = symN ? symSum[s.key] / symN : 0;
      return '<div class="mr-row"><span class="mr-name" style="width:74px">' + s.emoji + ' ' + s.label + '</span>' +
        '<div class="mr-bar"><span style="width:' + (avg / 10 * 100) + '%;background:#f59e0b"></span></div>' +
        '<span class="mr-val mono">' + avg.toFixed(1) + '</span></div>';
    }).join('');
    box.innerHTML +=
      '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Bristol distribution · ' + rangeLabelFor(rs.mode, rs.anchor) + '</div>' +
        ((logged || noGoDays) ? distro + '<div class="muted tiny" style="margin-top:8px">' + (logged ? '✅ ' + Math.round(idealDays / logged * 100) + '% ideal (3–4) · ' : '') + logged + ' logged' + (noGoDays ? ' · ' + noGoDays + ' no-BM' : '') + '</div>' : '<p class="muted tiny">No stool logs in this range.</p>') + '</div>' +
      (symN ? '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Symptoms · avg /10</div>' + symRows + '</div>' : '') +
      '<div class="card"><div class="eyebrow" style="margin-bottom:6px">Microbiome fuel · avg per day</div>' +
        '<div class="gut-tiles">' +
          gutTile('🥦 Plants', dates.length ? (plants / dates.length).toFixed(1) : '—', 'per day') +
          gutTile('🌾 Fibre', fiberN ? Math.round(fiberSum / fiberN) + 'g' : '—', 'per logged day') +
          gutTile('🫙 Fermented', dates.length ? (ferm / dates.length).toFixed(1) : '—', 'servings/day') +
        '</div></div>';
    bindRangeBar(box, 'gutrg', renderGutApp);
  }

  /* ----- Us — relationship check-ins (Life pillar) -----
     Daily fields live in d.extra.rel (zero-redeploy, same pattern as habits/mood).
     Partner info + the reflection diary live in profile (profile.relationship /
     profile.relDiary), synced via the existing saveGoals round-trip — no backend
     changes needed. The reflection diary is deliberately NOT scored/XP'd: honest
     conflict journalling shouldn't feel like something to game. */
  var REL_LANGS = [
    { key: 'words', emoji: '💬', label: 'Words' },
    { key: 'acts',  emoji: '🤝', label: 'Acts' },
    { key: 'gifts', emoji: '🎁', label: 'Gifts' },
    { key: 'time',  emoji: '⏳', label: 'Time' },
    { key: 'touch', emoji: '🤗', label: 'Touch' }
  ];
  var REL_SCORES = [
    { v: 5, label: 'Close',   emoji: '🥰' },
    { v: 4, label: 'Good',    emoji: '😊' },
    { v: 3, label: 'Okay',    emoji: '😐' },
    { v: 2, label: 'Distant', emoji: '😕' },
    { v: 1, label: 'Rough',   emoji: '💔' }
  ];
  // Shown on a hard day (score <= 2) instead of the positive fields — naming
  // what strained things is its own kind of showing up.
  var REL_FRICTION = [
    { key: 'busy',    emoji: '🏃', label: 'Busy / apart' },
    { key: 'argument',emoji: '💢', label: 'Argument' },
    { key: 'distant', emoji: '🌫️', label: 'Felt distant' },
    { key: 'tired',   emoji: '😮‍💨', label: 'Drained' },
    { key: 'miscomm', emoji: '🗯️', label: 'Miscommunication' },
    { key: 'stress',  emoji: '🔥', label: 'Outside stress' }
  ];
  function relOf(d) { return (d.extra && d.extra.rel) || {}; }
  function relPatch(d, patch) {
    if (!d.extra) d.extra = {};
    d.extra.rel = Object.assign({ langs: {} }, relOf(d), patch);
  }
  function relScoreColor(v) {
    return v >= 5 ? '#ff4d8d' : v >= 4 ? '#ff86ae' : v >= 3 ? '#ffb7cc' : v >= 2 ? '#b98a97' : '#7d5560';
  }
  function relInfo() { return (state.profile && state.profile.relationship) || {}; }
  function relDiary() { return (state.profile && state.profile.relDiary) || []; }
  // Days until the next occurrence of a 'YYYY-MM-DD' anniversary/birthday (0 = today).
  function daysUntilAnniversary(dateStr) {
    if (!dateStr || dateStr.length < 10) return null;
    var mmdd = dateStr.slice(5);
    var today = todayStr(), y = Number(today.slice(0, 4));
    var next = y + '-' + mmdd;
    if (next < today) next = (y + 1) + '-' + mmdd;
    return dayNumber(today, next) - 1;
  }
  function relCountdowns() {
    var info = relInfo(), out = [];
    if (info.anniversary) out.push({ label: (info.partnerName ? info.partnerName + ' · ' : '') + 'Anniversary', emoji: '💍', days: daysUntilAnniversary(info.anniversary) });
    if (info.partnerBirthday) out.push({ label: (info.partnerName || 'Partner') + '’s birthday', emoji: '🎂', days: daysUntilAnniversary(info.partnerBirthday) });
    return out.filter(function (x) { return x.days != null; }).sort(function (a, b) { return a.days - b.days; });
  }

  function renderUsApp() {
    var bar = $('#us-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderUsApp); }
    renderRelDates();
    renderBalance('#us-balance', false);
    renderRelActs(appDay());
    renderRelCheckin(appDay());
    renderRelRange();
    var cal = $('#us-cal');
    if (cal) {
      buildDayPicker(cal, ymOf(appDate()), renderUsApp, function (date) {
        var l = logFor(date), r = l ? relOf(l) : null;
        return r && r.score ? relScoreColor(r.score) : null;
      });
    }
    var leg = $('#us-legend');
    if (leg) leg.innerHTML = REL_SCORES.map(function (s) {
      return '<span class="gt-key"><i style="background:' + relScoreColor(s.v) + '"></i>' + s.emoji + ' ' + s.label + '</span>';
    }).join('');
    renderRelDiary();
  }

  function renderRelDates() {
    var box = $('#us-dates'); if (!box) return;
    var info = relInfo();
    var cds = relCountdowns();
    box.innerHTML =
      '<div class="rel-dates-head"><span class="eyebrow">💞 ' + (info.partnerName ? esc(info.partnerName) : 'Your partner') + '</span>' +
        '<button class="icon-btn" id="rel-edit-dates" type="button">✎</button></div>' +
      (cds.length ? '<div class="rel-cds">' + cds.map(function (c) {
        return '<span class="rel-cd">' + c.emoji + ' <b>' + (c.days === 0 ? 'Today!' : c.days + 'd') + '</b> ' + esc(c.label) + '</span>';
      }).join('') + '</div>' : '<p class="muted tiny" style="margin:4px 0 0">Add your anniversary &amp; their birthday to see countdowns here and on Home.</p>') +
      '<div id="rel-dates-form" class="hidden">' +
        '<label>Partner’s name<input type="text" id="rel-name" value="' + esc(info.partnerName || '') + '" placeholder="e.g. Alex" /></label>' +
        '<label>Anniversary<input type="date" id="rel-anniv" value="' + esc(info.anniversary || '') + '" /></label>' +
        '<label>Their birthday<input type="date" id="rel-bday" value="' + esc(info.partnerBirthday || '') + '" /></label>' +
        '<button class="btn primary block" id="rel-save-dates" type="button">Save</button>' +
      '</div>';
    box.querySelector('#rel-edit-dates').addEventListener('click', function () { box.querySelector('#rel-dates-form').classList.toggle('hidden'); });
    box.querySelector('#rel-save-dates').addEventListener('click', function () {
      var profile = Object.assign({}, state.profile, { relationship: {
        partnerName: box.querySelector('#rel-name').value.trim(),
        anniversary: box.querySelector('#rel-anniv').value,
        partnerBirthday: box.querySelector('#rel-bday').value
      } });
      state.profile = profile;
      renderRelDates();
      if (!$('#view-home').classList.contains('hidden')) renderHome();
      api('saveGoals', { profile: profile }).then(function (data) { if (data && data.profile) state.profile = data.profile; toast('Saved'); }).catch(function (e) { toast(e.message); });
    });
  }

  function renderRelCheckin(d) {
    var box = $('#us-checkin'); if (!box) return;
    var r = relOf(d);
    var hard = r.score && r.score <= 2;   // Distant / Rough → show the hard-day path
    var positive =
      '<label class="rel-qt-row"><input type="checkbox" id="rel-qt"' + (r.qt ? ' checked' : '') + ' /> We spent real quality time together today</label>' +
      '<div class="rel-lang-lbl">Love languages you expressed today</div>' +
      '<div class="rel-langs">' + REL_LANGS.map(function (l) {
        var on = !!(r.langs && r.langs[l.key]);
        return '<button type="button" class="rel-lang-chip' + (on ? ' on' : '') + '" data-lk="' + l.key + '">' + l.emoji + ' ' + l.label + '</button>';
      }).join('') + '</div>' +
      '<label>One thing you appreciated about them today<textarea id="rel-note" rows="2" placeholder="e.g. They made me laugh when I was stressed about work.">' + esc(r.note || '') + '</textarea></label>';
    var hardBlock =
      '<div class="rel-hard">' +
        '<div class="rel-lang-lbl">What made today hard?</div>' +
        '<div class="rel-langs">' + REL_FRICTION.map(function (f) {
          var on = !!(r.friction && r.friction[f.key]);
          return '<button type="button" class="rel-lang-chip rel-fric' + (on ? ' on' : '') + '" data-fk="' + f.key + '">' + f.emoji + ' ' + f.label + '</button>';
        }).join('') + '</div>' +
        '<label>What strained things today? (just for you)<textarea id="rel-hardnote" rows="2" placeholder="e.g. We were both buried in work and barely spoke.">' + esc(r.hardNote || '') + '</textarea></label>' +
        '<div class="rel-repair"><span>Hard days count too — naming it is showing up. 💛</span>' +
          '<button type="button" class="btn" id="rel-to-diary">＋ Add a reflection</button></div>' +
      '</div>';
    box.innerHTML =
      '<div class="card">' +
        '<div class="rel-score-lbl">How connected did you feel today?</div>' +
        '<div class="mood-buttons" id="rel-score-btns">' + REL_SCORES.map(function (s) {
          return '<button type="button" class="mood-btn' + (r.score === s.v ? ' sel' : '') + '" style="--mc:' + relScoreColor(s.v) + '" data-rv="' + s.v + '">' +
            '<span class="mood-emoji">' + s.emoji + '</span><span class="mood-label">' + s.label + '</span></button>';
        }).join('') + '</div>' +
        (hard ? hardBlock : positive) +
      '</div>';
    box.querySelectorAll('#rel-score-btns [data-rv]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = Number(b.getAttribute('data-rv'));
        var before = dayXp(d).total;
        relPatch(d, { score: relOf(d).score === v ? 0 : v });
        var delta = dayXp(d).total - before;
        renderRelCheckin(d);   // may switch between the positive / hard layouts
        queueSaveDay(d);
        gamifyAfterToggle(delta);
      });
    });
    var bindNote = function (sel, field) {
      var noteEl = box.querySelector(sel); if (!noteEl) return;
      var noteTimer;
      noteEl.addEventListener('input', function () {
        clearTimeout(noteTimer);
        var val = noteEl.value, patch = {}; patch[field] = val;
        noteTimer = setTimeout(function () {
          var before = dayXp(d).total;
          relPatch(d, patch);
          var delta = dayXp(d).total - before;
          queueSaveDay(d);
          gamifyAfterToggle(delta);
        }, 500);
      });
    };
    if (hard) {
      box.querySelectorAll('.rel-fric').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var key = chip.getAttribute('data-fk');
          var friction = Object.assign({}, relOf(d).friction);
          friction[key] = !friction[key];
          relPatch(d, { friction: friction });
          chip.classList.toggle('on');
          queueSaveDay(d);
        });
      });
      var diaryBtn = box.querySelector('#rel-to-diary');
      if (diaryBtn) diaryBtn.addEventListener('click', function () {
        var form = $('#rel-diary-form');
        if (form) { form.classList.remove('hidden'); form.scrollIntoView({ behavior: 'smooth', block: 'center' }); var t = form.querySelector('#rd-situation'); if (t) t.focus(); }
      });
      bindNote('#rel-hardnote', 'hardNote');
    } else {
      box.querySelector('#rel-qt').addEventListener('change', function () {
        var before = dayXp(d).total;
        relPatch(d, { qt: this.checked });
        var delta = dayXp(d).total - before;
        queueSaveDay(d);
        gamifyAfterToggle(delta);
      });
      box.querySelectorAll('.rel-lang-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          var key = chip.getAttribute('data-lk');
          var langs = Object.assign({}, relOf(d).langs);
          langs[key] = !langs[key];
          var before = dayXp(d).total;
          relPatch(d, { langs: langs });
          var delta = dayXp(d).total - before;
          chip.classList.toggle('on');
          queueSaveDay(d);
          gamifyAfterToggle(delta);
        });
      });
      bindNote('#rel-note', 'note');
    }
  }

  function renderRelRange() {
    var box = $('#us-range'); if (!box) return;
    var rs = rangeState('usrg');
    box.innerHTML = rangeBarHtml('usrg');
    if (rs.mode === 'day') { bindRangeBar(box, 'usrg', renderUsApp); return; }
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { var rr = l ? relOf(l) : null; return rr && rr.score ? rr.score : null; });
    var qtAgg = rangeAgg(r.from, r.to, function (l) { var rr = l ? relOf(l) : null; return rr ? (rr.qt ? 1 : 0) : null; });
    var best = REL_SCORES.filter(function (s) { return s.v === Math.round(agg.avg); })[0];
    var langTally = {}; REL_LANGS.forEach(function (l) { langTally[l.key] = 0; });
    rangeDatesList(r.from, r.to).filter(function (dt) { return dt <= todayStr(); }).forEach(function (dt) {
      var l = logFor(dt), rr = l ? relOf(l) : null;
      if (rr && rr.langs) REL_LANGS.forEach(function (lg) { if (rr.langs[lg.key]) langTally[lg.key]++; });
    });
    var maxLang = Math.max(1, REL_LANGS.reduce(function (mx, l) { return Math.max(mx, langTally[l.key]); }, 0));
    var langRows = REL_LANGS.map(function (l) {
      var w = Math.round(langTally[l.key] / maxLang * 100);
      return '<div class="mr-row"><span class="mr-name">' + l.emoji + ' ' + l.label + '</span>' +
        '<div class="mr-bar"><span style="width:' + w + '%;background:#ff77a8"></span></div>' +
        '<span class="mr-val mono">' + langTally[l.key] + '</span></div>';
    }).join('');
    box.innerHTML += '<div class="card hero-row">' +
      ringMini(pctOf(agg.avg, 5), best ? relScoreColor(best.v) : '#ff77a8', 92, '<b>' + (agg.logged ? agg.avg.toFixed(1) : '—') + '</b>') +
      '<div class="hero-meta"><div class="metric-big"><b>' + (agg.logged ? agg.avg.toFixed(1) + '/5 ' + (best ? best.emoji : '') : 'No logs') + '</b></div>' +
      '<div class="muted tiny">connection · ' + agg.logged + ' of ' + agg.days + ' days logged · quality time ' + qtAgg.hits + '/' + qtAgg.days + ' days</div></div></div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:6px">Love languages expressed</div>' + langRows + '</div>' +
      (agg.logged ? '<div class="card"><div class="eyebrow">Connection per day</div>' + rangeBarChart(agg.perDay, '#ff77a8') + '</div>' : '');
    bindRangeBar(box, 'usrg', renderUsApp);
  }

  function renderRelDiary() {
    var box = $('#us-diary'); if (!box) return;
    var entries = relDiary();
    box.innerHTML =
      '<h3>Reflection &amp; repair journal</h3>' +
      '<p class="muted tiny" style="margin:0 0 10px">Private notes after a disagreement — what happened, how you resolved it, what you learned. Not scored — just for you.</p>' +
      '<div id="rel-diary-list">' + (entries.length ? entries.slice().reverse().map(function (e) {
        return '<div class="rel-entry" data-id="' + e.id + '">' +
          '<div class="rel-entry-head"><span class="mono tiny muted">' + shortDate(e.date) + '</span><button class="rel-entry-del" type="button" title="Delete">✕</button></div>' +
          (e.situation ? '<p><b>What happened:</b> ' + esc(e.situation) + '</p>' : '') +
          (e.resolution ? '<p><b>How we resolved it:</b> ' + esc(e.resolution) + '</p>' : '') +
          (e.lesson ? '<p><b>What we learned:</b> ' + esc(e.lesson) + '</p>' : '') +
        '</div>';
      }).join('') : '<p class="muted tiny">No entries yet.</p>') + '</div>' +
      '<button class="btn block" id="rel-diary-add" type="button">+ Add reflection</button>' +
      '<div id="rel-diary-form" class="hidden">' +
        '<label>What happened<textarea id="rd-situation" rows="2"></textarea></label>' +
        '<label>How you resolved it<textarea id="rd-resolution" rows="2"></textarea></label>' +
        '<label>What you learned<textarea id="rd-lesson" rows="2"></textarea></label>' +
        '<button class="btn primary block" id="rd-save" type="button">Save entry</button>' +
      '</div>';
    box.querySelector('#rel-diary-add').addEventListener('click', function () { box.querySelector('#rel-diary-form').classList.toggle('hidden'); });
    box.querySelectorAll('.rel-entry-del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.closest('.rel-entry').getAttribute('data-id');
        if (!confirm('Delete this reflection entry?')) return;
        saveRelDiary(relDiary().filter(function (e) { return e.id !== id; }));
      });
    });
    box.querySelector('#rd-save').addEventListener('click', function () {
      var situation = box.querySelector('#rd-situation').value.trim();
      var resolution = box.querySelector('#rd-resolution').value.trim();
      var lesson = box.querySelector('#rd-lesson').value.trim();
      if (!situation && !resolution && !lesson) return;
      var next = relDiary().slice();
      next.push({ id: 'rd_' + Date.now().toString(36), date: todayStr(), situation: situation, resolution: resolution, lesson: lesson });
      saveRelDiary(next);
    });
  }
  function saveRelDiary(entries) {
    var profile = Object.assign({}, state.profile, { relDiary: entries });
    state.profile = profile;
    renderRelDiary();
    api('saveGoals', { profile: profile }).then(function (data) { if (data && data.profile) state.profile = data.profile; }).catch(function (e) { toast(e.message); });
  }

  /* ----- Small Acts — a daily, low-effort connection prompt -----
     ADHD-friendly: removes the "what do I even do?" load by suggesting ONE
     concrete act a day. Deterministic by date (stable through the day) with a
     shuffle. Marking it done is a one-tap Life-XP win. */
  var SMALL_ACTS = [
    { e: '💬', t: 'Text them one specific thing you appreciate about them.' },
    { e: '👂', t: 'Ask about their day — and listen for 10 minutes without fixing anything.' },
    { e: '🧠', t: 'Name the thing pulling your focus right now, so they know it isn’t them.' },
    { e: '📵', t: 'Put your phone in another room for one hour together tonight.' },
    { e: '🗓️', t: 'Suggest a real plan for this weekend — a place and a time.' },
    { e: '🤗', t: 'Give them a 20-second hug — long enough to actually relax into it.' },
    { e: '☕', t: 'Bring them their favourite drink or snack, unprompted.' },
    { e: '🙏', t: 'Apologise for one small thing you brushed past recently.' },
    { e: '🍽️', t: 'Share one meal today with no screens.' },
    { e: '📝', t: 'Leave them a short note somewhere they’ll find it later.' },
    { e: '🚶', t: 'Take a 15-minute walk together after work.' },
    { e: '🎧', t: 'Send a song or clip that made you think of them.' },
    { e: '⏰', t: 'Clock out 30 minutes early today and give that time to them.' },
    { e: '❓', t: 'Ask: “What would make this week easier for you?”' },
    { e: '💐', t: 'Bring home a small surprise — anything counts.' },
    { e: '🛌', t: 'Go to bed at the same time tonight.' },
    { e: '🍳', t: 'Quietly take one chore off their plate.' },
    { e: '📸', t: 'Look at old photos together for a few minutes.' },
    { e: '💌', t: 'Tell them one reason you’re glad you’re with them.' },
    { e: '🌙', t: 'Ask how they’re really doing — and let there be a pause.' },
    { e: '🎯', t: 'Ask what they need more of from you right now, then just listen.' },
    { e: '🔁', t: 'Follow up on something they told you last week.' }
  ];
  function actSeed(date) { var s = 0; for (var i = 0; i < date.length; i++) s = (s * 31 + date.charCodeAt(i)) >>> 0; return s; }
  function suggestedAct(d) { return SMALL_ACTS[(actSeed(d.date) + (state.usActBump || 0)) % SMALL_ACTS.length]; }
  function renderRelActs(d) {
    var box = $('#us-act'); if (!box) return;
    var done = !!relOf(d).act;
    var act = suggestedAct(d);
    box.innerHTML =
      '<div class="card act-card' + (done ? ' done' : '') + '">' +
        '<span class="eyebrow">💞 Today’s small act</span>' +
        '<div class="act-text">' + act.e + ' ' + esc(act.t) + '</div>' +
        '<div class="act-btns">' +
          '<button class="btn primary act-did" type="button"' + (done ? ' disabled' : '') + '>' + (done ? 'Done today ✓' : 'I did it') + '</button>' +
          '<button class="btn act-another" type="button">Another idea ↻</button>' +
        '</div>' +
      '</div>';
    box.querySelector('.act-did').addEventListener('click', function () {
      if (relOf(d).act) return;
      var before = dayXp(d).total;
      relPatch(d, { act: true });
      var delta = dayXp(d).total - before;
      renderRelActs(d); queueSaveDay(d); gamifyAfterToggle(delta);
    });
    box.querySelector('.act-another').addEventListener('click', function () {
      state.usActBump = (state.usActBump || 0) + 1; renderRelActs(d);
    });
  }

  /* ----- Work / Focus check-in — parallel to Us, but boundary-first -----
     Deliberately rewards focus quality and CLOCKING OUT, not raw hours, so it
     nudges toward sustainable work instead of more of it. Lives in d.extra.work
     (zero-redeploy). Focus score & the "overworked" flag earn no XP. */
  var FOCUS_SCORES = [
    { v: 5, label: 'Deep',       emoji: '🎯' },
    { v: 4, label: 'Good',       emoji: '🙂' },
    { v: 3, label: 'Scattered',  emoji: '😵‍💫' },
    { v: 2, label: 'Distracted', emoji: '🫤' },
    { v: 1, label: 'Lost',       emoji: '😞' }
  ];
  function focusColor(v) { return v >= 5 ? '#22c55e' : v >= 4 ? '#84cc16' : v >= 3 ? '#eab308' : v >= 2 ? '#f97316' : '#ef4444'; }
  function workOf(d) { return (d.extra && d.extra.work) || {}; }
  function workPatch(d, patch) { if (!d.extra) d.extra = {}; d.extra.work = Object.assign({}, workOf(d), patch); }

  function renderWorkCheckin(d) {
    var box = $('#work-checkin'); if (!box) return;
    var w = workOf(d);
    box.innerHTML =
      '<div class="card">' +
        '<div class="rel-score-lbl">How was your focus today?</div>' +
        '<div class="mood-buttons" id="wk-focus-btns">' + FOCUS_SCORES.map(function (s) {
          return '<button type="button" class="mood-btn' + (w.focus === s.v ? ' sel' : '') + '" style="--mc:' + focusColor(s.v) + '" data-fv="' + s.v + '">' +
            '<span class="mood-emoji">' + s.emoji + '</span><span class="mood-label">' + s.label + '</span></button>';
        }).join('') + '</div>' +
        '<div class="wk-stepper-row"><span>🧱 Deep-work sessions</span>' +
          '<div class="wk-stepper"><button type="button" class="wk-dec">−</button><b id="wk-deep">' + (Number(w.deep) || 0) + '</b><button type="button" class="wk-inc">+</button></div></div>' +
        '<label class="rel-qt-row wk-boundary"><input type="checkbox" id="wk-clockout"' + (w.clockOut ? ' checked' : '') + ' /> 🌙 I clocked out and protected my evening</label>' +
        '<label class="rel-qt-row"><input type="checkbox" id="wk-overwork"' + (w.overwork ? ' checked' : '') + ' /> ⚠️ I overworked today (honest — no penalty)</label>' +
        (w.overwork ? '<p class="muted tiny wk-overwork-note">Noticing it is the first step. Try one small act in Us to rebalance — it counts more than you think.</p>' : '') +
        '<label>One win from today<textarea id="wk-note" rows="2" placeholder="e.g. Shipped the thing I’d been avoiding.">' + esc(w.note || '') + '</textarea></label>' +
      '</div>';
    box.querySelectorAll('#wk-focus-btns [data-fv]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = Number(b.getAttribute('data-fv'));
        workPatch(d, { focus: workOf(d).focus === v ? 0 : v });
        renderWorkCheckin(d); queueSaveDay(d);
        if (!$('#view-work').classList.contains('hidden')) { renderWorkCalRange(); }
      });
    });
    function stepDeep(delta) {
      var cur = Number(workOf(d).deep) || 0, next = Math.max(0, Math.min(12, cur + delta));
      if (next === cur) return;
      var before = dayXp(d).total;
      workPatch(d, { deep: next });
      var xd = dayXp(d).total - before;
      renderWorkCheckin(d); queueSaveDay(d); gamifyAfterToggle(xd);
    }
    box.querySelector('.wk-inc').addEventListener('click', function () { stepDeep(1); });
    box.querySelector('.wk-dec').addEventListener('click', function () { stepDeep(-1); });
    box.querySelector('#wk-clockout').addEventListener('change', function () {
      var before = dayXp(d).total;
      workPatch(d, { clockOut: this.checked });
      var xd = dayXp(d).total - before;
      queueSaveDay(d); gamifyAfterToggle(xd);
    });
    box.querySelector('#wk-overwork').addEventListener('change', function () {
      workPatch(d, { overwork: this.checked });
      renderWorkCheckin(d); queueSaveDay(d);
    });
    var noteEl = box.querySelector('#wk-note'), nt;
    noteEl.addEventListener('input', function () {
      clearTimeout(nt); var val = noteEl.value;
      nt = setTimeout(function () {
        var before = dayXp(d).total;
        workPatch(d, { note: val });
        var xd = dayXp(d).total - before;
        queueSaveDay(d); gamifyAfterToggle(xd);
      }, 500);
    });
  }
  function renderWorkCalRange() {
    var cal = $('#work-cal');
    if (cal) {
      buildDayPicker(cal, ymOf(appDate()), renderWorkApp, function (date) {
        var l = logFor(date), w = l ? workOf(l) : null;
        return w && w.focus ? focusColor(w.focus) : null;
      });
    }
    var leg = $('#work-legend');
    if (leg) leg.innerHTML = FOCUS_SCORES.map(function (s) {
      return '<span class="gt-key"><i style="background:' + focusColor(s.v) + '"></i>' + s.emoji + ' ' + s.label + '</span>';
    }).join('');
    renderFocusRange();
  }
  function renderFocusRange() {
    var box = $('#work-range'); if (!box) return;
    var rs = rangeState('workrg');
    box.innerHTML = rangeBarHtml('workrg');
    if (rs.mode === 'day') { bindRangeBar(box, 'workrg', renderWorkApp); return; }
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { var w = l ? workOf(l) : null; return w && w.focus ? w.focus : null; });
    var clockOuts = 0, deep = 0, overworks = 0;
    rangeDatesList(r.from, r.to).filter(function (dt) { return dt <= todayStr(); }).forEach(function (dt) {
      var l = logFor(dt), w = l ? workOf(l) : null; if (!w) return;
      if (w.clockOut) clockOuts++; deep += Number(w.deep) || 0; if (w.overwork) overworks++;
    });
    var best = FOCUS_SCORES.filter(function (s) { return s.v === Math.round(agg.avg); })[0];
    box.innerHTML += '<div class="card hero-row">' +
      ringMini(pctOf(agg.avg, 5), best ? focusColor(best.v) : '#f59e0b', 92, '<b>' + (agg.logged ? agg.avg.toFixed(1) : '—') + '</b>') +
      '<div class="hero-meta"><div class="metric-big"><b>' + (agg.logged ? agg.avg.toFixed(1) + '/5 ' + (best ? best.emoji : '') : 'No logs') + '</b></div>' +
      '<div class="muted tiny">focus · ' + agg.logged + ' of ' + agg.days + ' days · 🌙 clocked out ' + clockOuts + ' · 🧱 ' + deep + ' deep sessions' + (overworks ? ' · ⚠️ overworked ' + overworks : '') + '</div></div></div>' +
      (agg.logged ? '<div class="card"><div class="eyebrow">Focus per day</div>' + rangeBarChart(agg.perDay, '#f59e0b') + '</div>' : '');
    bindRangeBar(box, 'workrg', renderWorkApp);
  }

  /* ----- Attention Balance — the antidote to work quietly eating everything -----
     Compares days you worked vs days you connected over the last week. Makes the
     invisible imbalance visible (ADHD time-blindness), warmly, without shame. */
  function workedDay(l) {
    if (!l) return false;
    if (l.biz) { for (var k in l.biz) { var e = l.biz[k] || {}; if ((Number(e.m) || 0) > 0 || (Number(e.t) || 0) > 0) return true; } }
    var w = (l.extra && l.extra.work) || {};
    return !!(w.focus || Number(w.deep) || w.clockOut || w.overwork || (w.note && String(w.note).trim()));
  }
  function connectedDay(l) {
    if (!l) return false;
    var r = (l.extra && l.extra.rel) || {};
    // Any deliberate engagement counts as showing up — including a hard-day
    // check-in (a score with a friction note), not just the good-day actions.
    if (r.qt || r.act || r.score || (r.note && String(r.note).trim()) || (r.hardNote && String(r.hardNote).trim())) return true;
    if (r.langs) { for (var k in r.langs) if (r.langs[k]) return true; }
    return false;
  }
  function attentionBalance() {
    var today = todayStr(), wDays = 0, cDays = 0, clockOuts = 0, daysSince = null;
    for (var i = 0; i < 7; i++) {
      var dt = addDays(today, -i);
      var l = dt === today ? state.today : logFor(dt);
      if (workedDay(l)) wDays++;
      if (connectedDay(l)) { cDays++; if (daysSince == null) daysSince = i; }
      var w = (l && l.extra && l.extra.work) || {}; if (w.clockOut) clockOuts++;
    }
    return { wDays: wDays, cDays: cDays, clockOuts: clockOuts, daysSince: daysSince, gap: wDays - cDays };
  }
  function balanceMsg(b) {
    if (b.wDays + b.cDays === 0) return null;
    var name = relInfo().partnerName || 'them';
    if (b.gap >= 3) return { tone: 'tilt', text: 'Work’s been in the driver’s seat this week. One small act for ' + name + ' today can start to shift it.' };
    if (b.daysSince != null && b.daysSince >= 2) return { tone: 'nudge', text: 'It’s been ' + b.daysSince + ' days since you last connected. A small hello goes a long way 💞' };
    if (b.daysSince == null) return { tone: 'nudge', text: 'No connection logged this week yet. Start with one small act — it’s enough.' };
    if (b.cDays >= b.wDays && b.cDays > 0) return { tone: 'good', text: 'Good balance this week — you’re showing up for both. Keep it going 💪' };
    return { tone: 'ok', text: 'A steady week. One small act keeps the momentum.' };
  }
  function renderBalance(sel, jump) {
    var box = $(sel); if (!box) return;
    var b = attentionBalance(), msg = balanceMsg(b);
    if (!msg) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    var balRow = function (label, days, color) {
      var w = Math.round(days / 7 * 100);
      return '<div class="bal-row"><span class="bal-name">' + label + '</span>' +
        '<div class="bal-bar"><span style="width:' + w + '%;background:' + color + '"></span></div>' +
        '<span class="bal-val mono">' + days + '/7</span></div>';
    };
    box.innerHTML =
      '<div class="card home-balance tone-' + msg.tone + '">' +
        '<span class="eyebrow">⚖️ Focus balance · last 7 days</span>' +
        '<div class="bal-rows">' + balRow('🏢 Work', b.wDays, '#f59e0b') + balRow('💞 Us', b.cDays, '#ff77a8') + '</div>' +
        '<div class="bal-msg">' + esc(msg.text) + '</div>' +
        (b.clockOuts ? '<div class="muted tiny" style="margin-top:6px">🌙 You protected your evening ' + b.clockOuts + ' day' + (b.clockOuts === 1 ? '' : 's') + ' this week.</div>' : '') +
      '</div>';
    if (jump) { var c = box.querySelector('.home-balance'); c.style.cursor = 'pointer'; c.onclick = function () { switchView('us'); }; }
  }

  /* ----- Mood meter (does NOT affect 75 Hard completion) ----- */
  var MOODS = [
    { v: 5, label: 'Great', emoji: '😄', color: '#2fd47a' },
    { v: 4, label: 'Good',  emoji: '🙂', color: '#9bd84a' },
    { v: 3, label: 'Okay',  emoji: '😐', color: '#ffc24b' },
    { v: 2, label: 'Low',   emoji: '😕', color: '#ff9f43' },
    { v: 1, label: 'Bad',   emoji: '😣', color: '#ff5470' }
  ];
  function moodColor(v) { for (var i = 0; i < MOODS.length; i++) if (MOODS[i].v === v) return MOODS[i].color; return null; }
  function renderMood(d, sel) {
    var box = $(sel || '#mood-buttons'); if (!box) return;
    box.innerHTML = '';
    MOODS.forEach(function (m) {
      var on = d.mood === m.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', m.color);
      b.innerHTML = '<span class="mood-emoji">' + m.emoji + '</span><span class="mood-label">' + m.label + '</span>';
      b.addEventListener('click', function () {
        d.mood = (d.mood === m.v) ? 0 : m.v;
        // Reflect on whichever mood widgets exist (Mood app + Journal).
        renderMood(d, '#mood-buttons'); renderMood(d, '#journal-mood');
        queueSaveDay(d);
        if (!$('#view-mood').classList.contains('hidden')) renderMoodApp();
      });
      box.appendChild(b);
    });
  }

  /* ----- Gut health tracker (does NOT affect 75 Hard completion) ----- */
  // Bristol Stool Scale (the medical standard). Types 3–4 are the ideal target.
  // d.gut holds the Bristol type (1–7) — the calendar colours by it. The richer
  // gut data (symptoms, inputs, stress) lives in d.extra.gut (zero-redeploy).
  var GUT = [
    { v: 1, label: 'Type 1', short: 'Pellets', emoji: '🔴', sub: 'Hard separate lumps — hard to pass', tier: 'Constipation', color: '#ef4444' },
    { v: 2, label: 'Type 2', short: 'Lumpy',   emoji: '🟠', sub: 'Lumpy, sausage-shaped',              tier: 'Constipation', color: '#f97316' },
    { v: 3, label: 'Type 3', short: 'Cracked', emoji: '🟢', sub: 'Sausage with cracks on the surface', tier: 'Ideal',        color: '#84cc16' },
    { v: 4, label: 'Type 4', short: 'Smooth',  emoji: '✅', sub: 'Smooth & soft, like a snake',        tier: 'Ideal',        color: '#22c55e' },
    { v: 5, label: 'Type 5', short: 'Blobs',   emoji: '🟡', sub: 'Soft blobs with clear edges',        tier: 'Lacking fibre',color: '#eab308' },
    { v: 6, label: 'Type 6', short: 'Mushy',   emoji: '🟤', sub: 'Fluffy, mushy, ragged edges',        tier: 'Diarrhoea',    color: '#f59e0b' },
    { v: 7, label: 'Type 7', short: 'Liquid',  emoji: '💧', sub: 'Entirely liquid — no solid pieces',  tier: 'Diarrhoea',    color: '#3b82f6' }
  ];
  var GUT_NOGO_COLOR = '#5b6472';
  function gutColor(v) { for (var i = 0; i < GUT.length; i++) if (GUT[i].v === v) return GUT[i].color; return null; }
  // The old picker (pre-Bristol-scale) stored value 1 as "Didn't go" — the same
  // raw number the new scale uses for Type 1 (Pellets). A day only gets coloured
  // by its Bristol value if extra.gut.bristol confirms it was logged through the
  // NEW scale; otherwise (ambiguous legacy data, or genuinely no log) it's left
  // uncoloured rather than risk mislabelling an old "didn't go" day as Pellets.
  function gutCalColor(l) {
    if (!l) return null;
    var g = gutOf(l);
    if (g.noGo) return GUT_NOGO_COLOR;
    if (l.gut && g.bristol === l.gut) return gutColor(l.gut);
    return null;
  }
  function gutLabel(v) { var g = GUT.filter(function (x) { return x.v === v; })[0]; return g ? g.label + ' · ' + g.short : null; }
  // Hand-drawn Bristol stool illustrations (crisp, scalable, theme-safe) — a
  // much clearer visual cue than a coloured dot when picking your type.
  function bristolSvg(v) {
    var c = '#8a5a2c', k = '#5c3812';
    var s = '<svg viewBox="0 0 44 44" class="brs" aria-hidden="true">';
    if (v === 1) return s + '<g fill="' + c + '"><circle cx="23" cy="9" r="4.6"/><circle cx="18" cy="19" r="3.7"/><circle cx="26" cy="26" r="4.2"/><circle cx="19" cy="34" r="3.3"/></g></svg>';
    if (v === 2) return s + '<g fill="' + c + '"><ellipse cx="22" cy="22" rx="8" ry="16"/><circle cx="16" cy="12" r="4.2"/><circle cx="28" cy="15" r="4.6"/><circle cx="16" cy="23" r="4.6"/><circle cx="28" cy="29" r="4.2"/><circle cx="21" cy="35" r="4.2"/></g></svg>';
    if (v === 3) return s + '<rect x="16" y="5" width="12" height="34" rx="6" fill="' + c + '"/><g stroke="' + k + '" stroke-width="1.7" stroke-linecap="round" fill="none"><path d="M20 12l4 3"/><path d="M24 20l-4 3"/><path d="M20 28l4 3"/></g></svg>';
    if (v === 4) return s + '<path d="M22 4c5 0 5 8 4 18s2 18-4 18-3-8-4-18S17 4 22 4z" fill="' + c + '"/></svg>';
    if (v === 5) return s + '<g fill="' + c + '"><ellipse cx="23" cy="11" rx="7.5" ry="5.5"/><ellipse cx="18" cy="24" rx="6.8" ry="5"/><ellipse cx="25" cy="35" rx="6.2" ry="4.6"/></g></svg>';
    if (v === 6) return s + '<path d="M11 25c-2-8 6-9 6-9 1-6 9-4 9-4 8-1 8 6 8 6 4 3 0 8 0 8 1 6-7 6-7 6-4 3-9-1-9-1-7 1-7-6-7-6z" fill="' + c + '"/><g fill="' + k + '" opacity=".5"><circle cx="15" cy="20" r="1.4"/><circle cx="30" cy="19" r="1.4"/><circle cx="24" cy="30" r="1.4"/></g></svg>';
    return s + '<path d="M6 27c4-3 8-1 8-1 3-4 8-2 8-2 4-3 8 0 8 0 4-1 7 3 7 3-1 6-10 6-10 6-7 2-13-1-13-1-7 0-8-5-8-5z" fill="' + c + '"/></svg>';
  }
  // Fibre grams logged in the Diet app for a date (summed from food entries).
  // Uses the already-loaded diet foods for the current diet date; otherwise
  // fetches once and caches, then re-renders the gut view.
  var gutFiberCache = {};
  function dietFiberFor(date) {
    if (state.foodsDate === date && state.foods) {
      return Math.round(state.foods.reduce(function (s, f) { return s + (Number(f.fiber) || 0); }, 0));
    }
    if (gutFiberCache[date] != null) return gutFiberCache[date];
    api('getFood', { date: date }).then(function (data) {
      gutFiberCache[date] = Math.round((data.foods || []).reduce(function (s, f) { return s + (Number(f.fiber) || 0); }, 0));
      if (!$('#view-gut').classList.contains('hidden')) renderGutApp();
    }).catch(function () { gutFiberCache[date] = 0; });
    return null; // loading
  }
  var GUT_SYMPTOMS = [
    { key: 'bloat', label: 'Bloating', emoji: '🎈' },
    { key: 'gas', label: 'Gas', emoji: '💨' },
    { key: 'heartburn', label: 'Heartburn', emoji: '🔥' },
    { key: 'energy', label: 'Energy crash', emoji: '🥱' }
  ];
  var GUT_PLANTS_WK = 30, GUT_FIBER_MIN = 25, GUT_FIBER_MAX = 38;
  function gutOf(d) { return (d.extra && d.extra.gut) || {}; }
  function gutPatch(d, patch) {
    if (!d.extra) d.extra = {};
    d.extra.gut = Object.assign({}, gutOf(d), patch);
    if (patch.bristol !== undefined) d.gut = patch.bristol;   // mirror for the calendar + legacy
  }
  /* ---------------- One-time legacy Gut data migration ----------------
     The pre-Bristol-scale picker reused the numbers 1-7 for entirely different
     things — two of them (Bloated, Acidity) were SYMPTOMS, not stool shapes at
     all. Remap each old value into the field it actually corresponds to in the
     new model: real stool-consistency values become a confirmed Bristol type;
     "Didn't go" becomes the new no-BM flag; the two symptom values move into
     their matching symptom slider instead of being forced into a stool shape
     that was never actually reported. Runs once per account, then never again. */
  var GUT_LEGACY_MAP = {
    1: { noGo: true },   // "Didn't go"  -> the no-BM flag (not Pellets)
    2: { bristol: 2 },   // "Hard"       -> Lumpy (constipation)
    3: { bristol: 3 },   // "Healthy"    -> Cracked (ideal)
    4: { bristol: 4 },   // "Soft"       -> Smooth (ideal)
    5: { bristol: 6 },   // "Loose"      -> Mushy (diarrhoea-leaning)
    6: { bloat: 7 },     // "Bloated"    -> the Bloating symptom slider
    7: { heartburn: 7 }  // "Acidity"    -> the Heartburn symptom slider
  };
  function migrateLegacyGutData() {
    if (state.profile && state.profile.gutLegacyMigrated) return;
    var toSave = [];
    (state.logs || []).forEach(function (d) {
      if (!d || !d.gut) return;
      if (gutOf(d).bristol === d.gut) return;        // already a confirmed new-scheme log
      var map = GUT_LEGACY_MAP[d.gut]; if (!map) return;
      var patch = Object.assign({}, map);
      if (patch.bristol === undefined) patch.bristol = 0;   // symptom/no-go days carry no stool type
      gutPatch(d, patch);
      toSave.push(d);
    });
    function finish() {
      var profile = Object.assign({}, state.profile, { gutLegacyMigrated: true });
      state.profile = profile;
      api('saveGoals', { profile: profile }).then(function (data) {
        if (data && data.profile) state.profile = data.profile;
        if (!$('#view-gut').classList.contains('hidden')) renderGutApp();
      }).catch(function () {});
    }
    if (!toSave.length) { finish(); return; }
    toast('Updating ' + toSave.length + ' past gut log' + (toSave.length === 1 ? '' : 's') + ' to the new scale…');
    // Save one at a time — Apps Script doesn't love a burst of concurrent writes.
    (function next() {
      var d = toSave.shift();
      if (!d) { finish(); return; }
      api('saveDay', { day: d }).catch(function () {}).then(next);
    })();
  }
  // Sum a numeric gut field over the last 7 days (incl. today).
  function gutWeekSum(field) {
    var t = 0;
    for (var i = 0; i < 7; i++) { var dt = addDays(todayStr(), -i); var l = dt === todayStr() ? (state.today || {}) : logFor(dt); t += Number(gutOf(l || {})[field]) || 0; }
    return t;
  }
  // % of logged days in the last 30 that were an ideal stool (Bristol 3–4).
  function gutIdealRate() {
    var hit = 0, n = 0;
    for (var i = 0; i < 30; i++) {
      var dt = addDays(todayStr(), -i); var l = dt === todayStr() ? state.today : logFor(dt); if (!l) continue;
      var gg = gutOf(l);
      if (l.gut && gg.bristol === l.gut) { n++; if (l.gut === 3 || l.gut === 4) hit++; }
    }
    return n ? Math.round(hit / n * 100) : null;
  }
  // The Bristol selector — used in the gut app and the day editor.
  function renderGut(d, sel) {
    var box = $(sel || '#gut-buttons'); if (!box) return;
    box.innerHTML = '';
    GUT.forEach(function (g) {
      var on = d.gut === g.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', g.color);
      b.innerHTML = '<span class="mood-emoji">' + g.emoji + '</span><span class="mood-label">' + g.short + '</span>';
      b.addEventListener('click', function () {
        var nv = (d.gut === g.v) ? 0 : g.v;
        gutPatch(d, { bristol: nv });
        renderGut(d, sel || '#gut-buttons');
        queueSaveDay(d);
        if (!$('#view-gut').classList.contains('hidden')) renderGutApp();
      });
      box.appendChild(b);
    });
  }

  /* ----- Custom daily habits (do NOT affect 75 Hard completion) ----- */
  function renderHabitsApp() {
    var bar = $('#habits-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderHabitsApp); }
    var slot = $('#habit-emoji-slot');
    if (slot) { slot.innerHTML = emojiFieldHtml('habit-emoji', '📌'); bindEmojiField('habit-emoji'); }
    renderExtraTasks(appDay());
  }
  // Streak of consecutive days this habit was done (ending today or yesterday).
  function habitStreak(id) {
    var d = todayStr();
    var l = logFor(d);
    if (!l || !l.extra || !l.extra[id]) d = addDays(d, -1);
    var s = 0;
    while (true) {
      var lg = logFor(d);
      if (!lg || !lg.extra || !lg.extra[id]) break;
      s++; d = addDays(d, -1);
    }
    return s;
  }
  var HABIT_STARTERS = ['🧘 Meditate 10 min', '🚶 Evening walk', '🧴 Skincare', '🙏 Gratitude note', '🧹 Tidy desk', '📵 No phone in bed'];
  function habitEmoji(name) {
    // If the user typed an emoji first, use it as the icon.
    var m = String(name).match(/^(\p{Extended_Pictographic}(?:️)?)\s*/u);
    return m ? m[1] : null;
  }
  /* ---- Shared emoji picker ----
     Used by habits and the challenge builder. Typing an emoji first in the
     name used to be the only way to set an icon — undiscoverable, and awkward
     on a phone keyboard. A stored `emoji` field now wins, with the old
     name-prefix kept as the fallback so existing items keep their icon. */
  var EMOJI_PALETTE = [
    '📌','✅','🔥','⭐','🎯','💪','🏃','🚶','🧘','🏋️','🚴','🏊','🤸','🧗','⚽',
    '📚','✍️','💻','🧠','🎨','🎸','🎧','📷','🗣️','🌐',
    '💧','🥗','🍎','🥦','☕','🚭','🍺','💊','🩺','🦷','😴','🛏️',
    '☀️','🌙','⏰','📵','🧹','🧴','🙏','🌱','💰','📈','❤️','🐕','👨‍👩‍👧','🧾','🎵'
  ];
  function emojiFieldHtml(id, current) {
    return '<div class="emoji-field">' +
      '<button type="button" class="emoji-btn" id="' + id + '-btn" title="Choose an icon">' + (current || '📌') + '</button>' +
      '<div class="emoji-grid hidden" id="' + id + '-grid">' +
        EMOJI_PALETTE.map(function (e) {
          return '<button type="button" class="emoji-opt" data-emoji="' + e + '">' + e + '</button>';
        }).join('') +
      '</div></div>';
  }
  function bindEmojiField(id, onPick) {
    var btn = $('#' + id + '-btn'), grid = $('#' + id + '-grid');
    if (!btn || !grid) return;
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!grid.classList.contains('hidden')) { grid.classList.add('hidden'); return; }
      // Close any other open picker, then flip up only if there's no room below.
      document.querySelectorAll('.emoji-grid').forEach(function (g) { g.classList.add('hidden'); });
      grid.classList.remove('up', 'hidden');
      var r = grid.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 8 && btn.getBoundingClientRect().top > r.height + 16) grid.classList.add('up');
    });
    grid.querySelectorAll('[data-emoji]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var em = b.getAttribute('data-emoji');
        btn.textContent = em;
        grid.classList.add('hidden');
        if (onPick) onPick(em);
      });
    });
  }
  function emojiFieldValue(id, fallback) {
    var b = $('#' + id + '-btn');
    var v = b ? String(b.textContent || '').trim() : '';
    return v || fallback || '📌';
  }
  // An item's icon: the picked emoji, else a legacy emoji typed into the name.
  function habitIcon(h) { return (h && h.emoji) || habitEmoji(h && h.name) || '📌'; }
  function habitLabel(h) {
    var n = (h && h.name) || '';
    return habitEmoji(n) ? n.replace(/^(\p{Extended_Pictographic}(?:️)?)\s*/u, '') : n;
  }
  // Rendered into the Habits mini-app AND (compactly) onto Today, so extra
  // things you're doing on top of the challenge are tickable where you
  // already are each morning.
  function renderExtraTasks(d, mountSel, compact) {
    var list = $(mountSel || '#extra-tasks'); if (!list) return;
    if (!d.extra) d.extra = {};
    var habits = (state.profile && state.profile.customTasks) || [];
    list.innerHTML = '';

    if (habits.length && !compact) {
      // Week header: completion across all habits over the last 7 days.
      var hits = 0, slots = 0, today = todayStr();
      for (var i = 0; i < 7; i++) {
        var lg = logFor(addDays(today, -i));
        habits.forEach(function (h) { slots++; if (lg && lg.extra && lg.extra[h.id]) hits++; });
      }
      var wkPct = slots ? Math.round(hits / slots * 100) : 0;
      var head = el('div', 'card hero-row' + (wkPct >= 80 ? ' goal-hit' : ''));
      head.innerHTML = ringMini(wkPct, 'var(--life-c)', 84, '<b>' + wkPct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>This week</b></div>' +
        '<div class="muted tiny">' + hits + ' of ' + slots + ' habit checks done</div></div>';
      list.appendChild(head);
    }

    habits.forEach(function (h) {
      var done = !!d.extra[h.id];
      var streak = habitStreak(h.id);
      var em = habitIcon(h);
      var title = habitLabel(h);
      // Last-7-days dot strip (Loop/Streaks-style).
      var dots = '';
      for (var i = 6; i >= 0; i--) {
        var dte = addDays(todayStr(), -i);
        var lg2 = dte === d.date ? d : logFor(dte);
        dots += '<i class="hdot' + (lg2 && lg2.extra && lg2.extra[h.id] ? ' on' : '') + (dte === todayStr() ? ' td' : '') + '"></i>';
      }
      var row = el('div', 'task habit' + (done ? ' done' : ''));
      row.innerHTML =
        '<div class="check">✓</div>' +
        '<div class="t-emoji">' + em + '</div>' +
        '<div class="t-body"><div class="t-title">' + esc(title) +
          (streak > 1 ? ' <span class="hstreak">🔥' + streak + '</span>' : '') + '</div>' +
        (compact ? '' : '<div class="hdots">' + dots + '</div>') + '</div>' +
        (compact ? '' : '<button class="habit-del" title="Remove">✕</button>');
      row.addEventListener('click', function (e) {
        if (e.target.classList.contains('habit-del')) return;
        d.extra[h.id] = !d.extra[h.id];
        renderExtraTasks(d, mountSel, compact);
        queueSaveDay(d);
      });
      if (!compact) row.querySelector('.habit-del').addEventListener('click', function (e) {
        e.stopPropagation();
        removeHabit(h.id);
      });
      list.appendChild(row);
    });

    if (!habits.length && !compact) {
      var empty = el('div', 'card');
      empty.innerHTML = '<p class="muted tiny" style="margin:0 0 10px">No habits yet — start with one of these, or add your own below.</p>' +
        '<div class="starter-chips">' + HABIT_STARTERS.map(function (s) {
          return '<button type="button" class="starter-chip" data-starter="' + esc(s) + '">' + s + '</button>';
        }).join('') + '</div>';
      empty.querySelectorAll('[data-starter]').forEach(function (b) {
        b.addEventListener('click', function () {
          var raw = b.getAttribute('data-starter');
          var next = (state.profile.customTasks || []).slice();
          next.push({ id: 'h_' + Date.now().toString(36), name: habitLabel({ name: raw }), emoji: habitEmoji(raw) || '📌' });
          saveHabits(next);
        });
      });
      list.appendChild(empty);
    }
  }

  function addHabit() {
    var raw = $('#new-habit').value.trim();
    if (!raw) return;
    var picked = emojiFieldValue('habit-emoji', '');
    var habits = (state.profile.customTasks || []).slice();
    habits.push({
      id: 'h_' + Date.now().toString(36),
      name: habitLabel({ name: raw }),
      emoji: picked || habitEmoji(raw) || '📌'
    });
    $('#new-habit').value = '';
    var btn = $('#habit-emoji-btn'); if (btn) btn.textContent = '📌';
    saveHabits(habits);
  }
  function removeHabit(id) {
    var habits = (state.profile.customTasks || []).filter(function (h) { return h.id !== id; });
    saveHabits(habits);
  }
  function saveHabits(habits) {
    var profile = Object.assign({}, state.profile, { customTasks: habits });
    state.profile = profile;
    renderExtraTasks(appDay());
    if (!$('#view-today').classList.contains('hidden')) renderTodayExtras();
    api('saveGoals', { profile: profile }).then(function (data) {
      if (data && data.profile) state.profile = data.profile;
    }).catch(function (e) { toast(e.message); });
  }
  // The Today-page copy: your extra habits, tickable alongside the challenge
  // checklist, plus a one-line add so you can start something *today*.
  function renderTodayExtras() {
    var wrap = $('#today-extra'); if (!wrap) return;
    var d = appDay();
    var habits = (state.profile && state.profile.customTasks) || [];
    var doneN = habits.filter(function (h) { return d.extra && d.extra[h.id]; }).length;
    wrap.innerHTML =
      '<div class="tx-head"><span class="eyebrow">Extra · not part of the challenge</span>' +
        (habits.length ? '<span class="muted tiny">' + doneN + '/' + habits.length + '</span>' : '') + '</div>' +
      '<div id="today-extra-list" class="tasklist"></div>' +
      '<div class="add-habit tx-add">' + emojiFieldHtml('tx-emoji', '📌') +
        '<input id="tx-new" placeholder="Add something you did today" maxlength="40" />' +
        '<button id="tx-add-btn" class="btn">Add</button></div>' +
      (habits.length ? '' : '<p class="muted tiny" style="margin:8px 2px 0">Anything you want to track on top of the challenge — it won’t affect your challenge score.</p>');
    renderExtraTasks(d, '#today-extra-list', true);
    bindEmojiField('tx-emoji');
    var add = function () {
      var raw = $('#tx-new').value.trim(); if (!raw) return;
      var habits2 = (state.profile.customTasks || []).slice();
      habits2.push({
        id: 'h_' + Date.now().toString(36),
        name: habitLabel({ name: raw }),
        emoji: emojiFieldValue('tx-emoji', '') || habitEmoji(raw) || '📌'
      });
      $('#tx-new').value = '';
      saveHabits(habits2);
      renderTodayExtras();
    };
    $('#tx-add-btn').addEventListener('click', add);
    $('#tx-new').addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
  }

  /* ----- Businesses: time + tasks per business per day (not part of 75 Hard) ----- */
  function businesses() { return (state.profile && state.profile.businesses) || []; }
  function hoursMin(min) {
    min = Math.round(Number(min) || 0);
    if (min <= 0) return '0m';
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + 'h ' : '') + (m ? m + 'm' : (h ? '' : '0m'));
  }
  function renderWorkApp() {
    var bar = $('#work-daybar');
    if (bar) { bar.innerHTML = dayBarHtml(); bindDayBar(bar, renderWorkApp); }
    renderBalance('#work-balance', false);
    renderWorkCheckin(appDay());
    renderWorkCalRange();
    renderBusinesses(appDay());
  }
  function renderBusinesses(d) {
    var box = $('#biz-list'); if (!box) return;
    if (!d.biz) d.biz = {};
    var list = businesses();
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="muted tiny" style="margin:2px 2px 10px">No businesses yet — add them in <b>Settings → My businesses</b> to log time &amp; tasks here each day.</p>';
      return;
    }

    // Overall totals for the whole day, across all businesses.
    var totM = 0, totT = 0, worked = 0;
    list.forEach(function (b) { var e = d.biz[b.id] || {}; var m = Number(e.m) || 0, t = Number(e.t) || 0; totM += m; totT += t; if (m > 0 || t > 0) worked++; });
    var overall = el('div', 'biz-overall');
    overall.innerHTML = '<span class="biz-ov-lbl">Day total</span>' +
      '<span class="biz-ov-val">⏱ <b>' + hoursMin(totM) + '</b> · ✅ <b>' + totT + '</b> tasks · ' + worked + '/' + list.length + ' worked</span>';
    box.appendChild(overall);

    // Business chips (Toggl-style): all visible, each shows its day total.
    if (!state.bizSelected || !list.some(function (b) { return b.id === state.bizSelected; })) state.bizSelected = list[0].id;
    var chips = el('div', 'biz-chips');
    list.forEach(function (b) {
      var e = d.biz[b.id] || {};
      var m = Number(e.m) || 0, t = Number(e.t) || 0;
      var c = el('button', 'biz-chip' + (b.id === state.bizSelected ? ' active' : '') + ((m > 0 || t > 0) ? ' worked' : ''));
      c.type = 'button';
      c.innerHTML = '<span class="bc-name">' + esc(b.name) + '</span>' +
        '<span class="bc-sub">' + ((m > 0 || t > 0) ? (hoursMin(m) + (t ? ' · ' + t + '✓' : '')) : '—') + '</span>';
      c.addEventListener('click', function () { state.bizSelected = b.id; renderBusinesses(d); });
      chips.appendChild(c);
    });
    box.appendChild(chips);

    // Editor for the selected business only.
    var b = list.filter(function (x) { return x.id === state.bizSelected; })[0];
    var e = d.biz[b.id] || { m: 0, t: 0 };
    var card = el('div', 'biz-card');
    card.innerHTML =
      '<div class="biz-row"><span class="biz-lbl">Time</span>' +
        '<button class="biz-q" data-add="15">+15m</button>' +
        '<button class="biz-q" data-add="30">+30m</button>' +
        '<button class="biz-q" data-add="60">+1h</button>' +
        '<input class="biz-min" type="number" inputmode="numeric" value="' + (Number(e.m) || 0) + '" /> <span class="muted tiny">min</span>' +
        '<button class="biz-clear" data-clear="m">✕</button></div>' +
      '<div class="biz-row"><span class="biz-lbl">Tasks</span>' +
        '<button class="biz-q" data-tadd="1">+1</button>' +
        '<input class="biz-task" type="number" inputmode="numeric" value="' + (Number(e.t) || 0) + '" />' +
        '<button class="biz-clear" data-clear="t">✕</button></div>';
    function commit(rerender) {
      d.biz[b.id] = { m: Math.max(0, Number(card.querySelector('.biz-min').value) || 0), t: Math.max(0, Number(card.querySelector('.biz-task').value) || 0) };
      queueSaveDay(d);
      if (rerender) renderBusinesses(d);
    }
    card.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var inp = card.querySelector('.biz-min'); inp.value = (Number(inp.value) || 0) + Number(btn.getAttribute('data-add')); commit(true);
      });
    });
    card.querySelector('[data-tadd]').addEventListener('click', function () {
      var inp = card.querySelector('.biz-task'); inp.value = (Number(inp.value) || 0) + 1; commit(true);
    });
    card.querySelectorAll('[data-clear]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        card.querySelector(btn.getAttribute('data-clear') === 'm' ? '.biz-min' : '.biz-task').value = 0; commit(true);
      });
    });
    card.querySelector('.biz-min').addEventListener('change', function () { commit(true); });
    card.querySelector('.biz-task').addEventListener('change', function () { commit(true); });
    box.appendChild(card);

    // Total minutes per day across all businesses (Toggl-style bars) — Day/Week/Month.
    var wk = el('div');
    box.appendChild(wk);
    renderWorkRange(wk, d);
  }
  function workVolOf(l) {
    if (!l || !l.biz) return 0;
    var t = 0;
    Object.keys(l.biz).forEach(function (id) { t += Number(l.biz[id] && l.biz[id].m) || 0; });
    return t;
  }
  function renderWorkRange(wk, todayDay) {
    var rs = rangeState('work');
    var range = rs.mode === 'day' ? rangeWeekOf(todayStr()) : rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(range.from, range.to, function (l, dte) {
      return workVolOf(dte === todayDay.date ? todayDay : l);
    });
    var worked = agg.perDay.filter(function (p) { return p.v > 0; }).length;
    wk.innerHTML = rangeBarHtml('work') +
      '<div class="card"><div class="eyebrow">' + (rs.mode === 'day' ? 'This week' : rangeLabelFor(rs.mode, rs.anchor)) +
        ' · ' + hoursMin(agg.sum) + ' · ' + worked + '/' + agg.days + ' days worked</div>' +
        rangeBarChart(agg.perDay.map(function (p) { return { date: p.date, v: p.v / 60 }; }), 'var(--life-c)', 'h', 1) +
      '</div>';
    bindRangeBar(wk, 'work', function () { renderWorkApp(); });
  }
  function addBusiness() {
    var name = $('#new-biz').value.trim();
    if (!name) return;
    var list = businesses().slice();
    if (list.length >= 8) { toast('Up to 8 businesses'); return; }
    list.push({ id: 'b_' + Date.now().toString(36), name: name });
    $('#new-biz').value = '';
    saveBusinesses(list);
  }
  function removeBusiness(id) {
    if (!confirm('Remove this business? Past logged time/tasks stay in your history.')) return;
    var list = businesses().filter(function (b) { return b.id !== id; });
    saveBusinesses(list);
  }
  function saveBusinesses(list) {
    var profile = Object.assign({}, state.profile, { businesses: list });
    state.profile = profile;
    renderBusinesses(appDay());
    renderBizSettings();
    api('saveGoals', { profile: profile }).then(function (data) {
      if (data && data.profile) state.profile = data.profile;
    }).catch(function (e) { toast(e.message); });
  }
  function renderBizSettings() {
    var box = $('#biz-settings-list'); if (!box) return;
    var list = businesses();
    box.innerHTML = list.length ? '' : '<p class="muted tiny">No businesses yet.</p>';
    list.forEach(function (b) {
      var row = el('div', 'biz-setting-row');
      row.innerHTML = '<span>' + esc(b.name) + '</span><button class="habit-del" data-rm="' + esc(b.id) + '">✕</button>';
      row.querySelector('[data-rm]').addEventListener('click', function () { removeBusiness(b.id); });
      box.appendChild(row);
    });
  }

  function litres(ml) {
    return (ml / 1000).toFixed(1).replace(/\.0$/, '');
  }

  // Compact water widget for Today — quick-add buttons + a small jar on the
  // right that fills as you tap (mirrors the big Water-app jar, no glasses).
  var lastJarPctMini = -1;
  function renderWaterCompact(d) {
    var ml = Number(d.waterMl) || 0, pct = pctOf(ml, WATER_GOAL);
    var goalMet = ml >= WATER_GOAL;
    var prev = lastJarPctMini < 0 ? pct : lastJarPctMini;
    var wrap = el('div', 'task water-task-compact' + (goalMet ? ' done' : ''));
    wrap.innerHTML =
      '<div class="wtc-side">' +
        '<div class="water-head">' +
          '<div class="check"' + (goalMet ? ' style="background:#4aa8ff;border-color:#4aa8ff;color:#04223f"' : '') + '>✓</div>' +
          '<div class="t-emoji">💧</div>' +
          '<div class="t-body"><div class="t-title">Drink ' + litres(WATER_GOAL) + ' L of water</div>' +
          '<div class="t-sub"><b>' + litres(ml) + ' L</b> / ' + litres(WATER_GOAL) + ' L · ' + pct + '%</div></div>' +
        '</div>' +
        '<div class="water-quick wtc-quick">' +
          '<button class="btn" data-w="250">+250 ml</button>' +
          '<button class="btn" data-w="500">+500 ml</button>' +
          '<button class="btn" data-w="1000">+1 L</button>' +
          '<button class="btn danger" data-w="-250">−250</button>' +
        '</div>' +
      '</div>' +
      '<div class="wtc-jar">' + jarSvgHtml(jarYFor(prev, 90), 'jar-mini', 'jarclip-mini') + '</div>';
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      var w = wrap.querySelector('.jar-water');
      if (w) w.style.transform = 'translateY(' + jarYFor(pct, 90) + 'px)';
    }); });
    lastJarPctMini = pct;
    bindWaterQuick(wrap, d);
    return wrap;
  }

  function toggleTask(t) {
    var d = appDay();
    var before = dayXp(d).total;
    taskSetDone(d, t, !taskDone(d, t));
    var delta = dayXp(d).total - before;
    renderToday();
    queueSaveDay(d);   // routes to queueSave() for today, past-day save otherwise
    gamifyAfterToggle(delta);   // XP floater + level-up
  }

  /* ---------------- Saving ---------------- */
  function queueSave() {
    var wasComplete = !!state.today.completed;
    state.today.completed = goalMet(state.today);
    upsertLocal(state.today);
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      pushToday(false);
      if (state.today.completed && !wasComplete) refreshCharge();   // a newly-completed day earns Charge
    }, 700);
  }
  function upsertLocal(day) {
    var i = state.logs.findIndex(function (l) { return l.date === day.date; });
    var copy = Object.assign({}, day);
    if (i >= 0) state.logs[i] = copy; else state.logs.push(copy);
    cacheState();
  }
  function pushToday(announce) {
    state.today.completed = goalMet(state.today);
    api('saveDay', { day: state.today }).then(function () {
      if (announce) toast(state.today.completed ? (challengeMode() === 'soft' ? 'Goal met — nice! 🔥' : 'Day complete — beast! 🔥') : 'Saved ✓');
    }).catch(function (err) {
      toast('Saved locally · ' + err.message);
    });
  }
  // Fire any queued (debounced) save right now. Called before a sync/reload and
  // when the app is backgrounded, so an in-flight change (e.g. tapping "I did
  // it") is never lost to a stale server re-read or a killed background timer.
  function flushPendingSaves() {
    var pending = false;
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; if (state.today) pushToday(false); pending = true; }
    if (state.pendingPastSaves) {
      Object.keys(state.pendingPastSaves).forEach(function (date) {
        var p = state.pendingPastSaves[date];
        clearTimeout(p.timer); p.fn(); pending = true;
      });
    }
    return pending;
  }

  /* ---------------- Mini-app day selection (edit any past date) ----------------
     Every mini-app reads/writes appDay() instead of state.today. A shared date
     bar (‹ date ›, tap for a month picker) sets state.appDate; null = today. */
  function appDate() { return state.appDate || todayStr(); }
  function appDay() {
    var date = appDate();
    if (date === todayStr()) return state.today;
    var found = logFor(date);
    if (!found) {
      found = emptyDay(date);
      state.logs.push(found);
      state.logs.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    }
    return found;
  }
  function queueSaveDay(d) {
    if (!d || d.date === todayStr()) return queueSave();
    d.completed = goalMet(d);
    upsertLocal(d);
    var payload = Object.assign({}, d);
    var date = payload.date;
    // Keyed by date (not a single global slot) so editing two different past
    // days within the same debounce window queues both saves instead of the
    // second edit silently cancelling and dropping the first one's network save.
    state.pendingPastSaves = state.pendingPastSaves || {};
    var existing = state.pendingPastSaves[date];
    if (existing) clearTimeout(existing.timer);
    var slot = { timer: null, fn: null };
    slot.fn = function () {
      delete state.pendingPastSaves[date];
      api('saveDay', { day: payload }).then(function () {
        toast('Saved ' + shortDate(payload.date) + ' ✓');
      }).catch(function (err) { toast('Saved locally · ' + err.message); });
    };
    slot.timer = setTimeout(slot.fn, 700);
    state.pendingPastSaves[date] = slot;
  }
  function dayBarHtml() {
    var date = appDate(), isToday = date === todayStr();
    return '<div class="daybar">' +
      '<button class="icon-btn db-prev" type="button" aria-label="Previous day">‹</button>' +
      '<button class="db-mid" type="button">📅 <b>' + (isToday ? 'Today' : prettyDate(date)) + '</b> <span class="db-carat">▾</span></button>' +
      '<button class="icon-btn db-next" type="button"' + (isToday ? ' disabled' : '') + ' aria-label="Next day">›</button>' +
    '</div>' +
    '<div class="db-pick card hidden"></div>' +
    (isToday ? '' : '<p class="db-editing tiny">✏️ Editing a past day — <button class="link-btn db-today" type="button">back to today</button></p>');
  }
  function bindDayBar(scope, rerender) {
    var prev = scope.querySelector('.db-prev'); if (!prev) return;
    var next = scope.querySelector('.db-next'), mid = scope.querySelector('.db-mid');
    var pick = scope.querySelector('.db-pick'), tdy = scope.querySelector('.db-today');
    prev.addEventListener('click', function () { state.appDate = addDays(appDate(), -1); rerender(); });
    if (next) next.addEventListener('click', function () {
      var n = addDays(appDate(), 1);
      state.appDate = (n >= todayStr()) ? null : n;
      rerender();
    });
    if (tdy) tdy.addEventListener('click', function () { state.appDate = null; rerender(); });
    mid.addEventListener('click', function () {
      if (pick.classList.contains('hidden')) {
        buildDayPicker(pick, ymOf(appDate()), rerender, null);
        pick.classList.remove('hidden');
      } else pick.classList.add('hidden');
    });
  }
  // Month grid picker. colorFn(date) may return a CSS color to tint a day
  // (used by Mood/Gut to double as a "status calendar").
  function buildDayPicker(pick, ym, rerender, colorFn) {
    var today = todayStr();
    pick.innerHTML =
      '<div class="cal-nav" style="margin-bottom:8px">' +
        '<button class="icon-btn dp-prev" type="button">‹</button>' +
        '<div class="cal-month-label">' + ymLabel(ym) + '</div>' +
        '<button class="icon-btn dp-next" type="button"' + (ym >= ymOf(today) ? ' disabled' : '') + '>›</button>' +
      '</div><div class="calendar-grid month dp-grid"></div>';
    var grid = pick.querySelector('.dp-grid');
    var p = ym.split('-'), first = new Date(+p[0], +p[1] - 1, 1), lead = (first.getDay() + 6) % 7;
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (w) {
      var h = el('div', 'cal-dow mono'); h.textContent = w; grid.appendChild(h);
    });
    for (var b = 0; b < lead; b++) grid.appendChild(el('div', 'cal-blank'));
    var days = daysInYm(ym);
    for (var day = 1; day <= days; day++) {
      (function (date) {
        var cell = el('div', 'cal-cell dp-cell');
        cell.innerHTML = '<span class="cc-num">' + Number(date.slice(8)) + '</span>';
        if (date > today) cell.classList.add('pre');
        else {
          var col = colorFn && colorFn(date);
          if (col) { cell.style.background = 'color-mix(in srgb, ' + col + ' 30%, var(--bg-soft))'; cell.style.borderColor = col; cell.style.color = 'var(--text)'; }
          cell.classList.add('editable');
          if (date === appDate()) cell.classList.add('today');
          cell.addEventListener('click', function () {
            state.appDate = (date === today) ? null : date;
            rerender();
          });
        }
        grid.appendChild(cell);
      })(ym + '-' + pad(day));
    }
    pick.querySelector('.dp-prev').addEventListener('click', function () { buildDayPicker(pick, ymShift(ym, -1), rerender, colorFn); });
    pick.querySelector('.dp-next').addEventListener('click', function () { buildDayPicker(pick, ymShift(ym, 1), rerender, colorFn); });
  }

  /* ---------------- Generic Day/Week/Month range engine ----------------
     Reusable across mini-apps whose data already lives in state.logs
     (water, steps, sleep, mood, gut, gym, detox, meds, work) — everything
     needed is already synced client-side, so switching to Week/Month is
     instant with zero extra network calls. (Diet uses its own variant
     because food entries are a separate, non-preloaded sheet.) */
  function rangeState(key) {
    if (!state.range) state.range = {};
    if (!state.range[key]) state.range[key] = { mode: 'day', anchor: todayStr() };
    return state.range[key];
  }
  function rangeWeekOf(dateStr) {
    var dow = (parse(dateStr).getDay() + 6) % 7; // 0 = Monday
    var from = addDays(dateStr, -dow);
    return { from: from, to: addDays(from, 6) };
  }
  function rangeSpan(mode, anchor) {
    if (mode === 'month') { var ym = ymOf(anchor); return { from: ym + '-01', to: ym + '-' + pad(daysInYm(ym)) }; }
    if (mode === 'week') return rangeWeekOf(anchor);
    return { from: anchor, to: anchor };
  }
  function rangeLabelFor(mode, anchor) {
    if (mode === 'month') return ymLabel(ymOf(anchor));
    var r = rangeWeekOf(anchor);
    return parse(r.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' – ' +
      parse(r.to).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function rangeAtLatest(rs) {
    if (rs.mode === 'week') return rangeWeekOf(rs.anchor).to >= todayStr();
    if (rs.mode === 'month') return ymOf(rs.anchor) >= ymOf(todayStr());
    return true;
  }
  function rangeShift(key, dir) {
    var rs = rangeState(key);
    if (rs.mode === 'week') {
      var n = addDays(rs.anchor, dir * 7);
      if (dir > 0 && n > todayStr()) return;
      rs.anchor = n;
    } else if (rs.mode === 'month') {
      var ny = ymShift(ymOf(rs.anchor), dir);
      if (dir > 0 && ny > ymOf(todayStr())) return;
      rs.anchor = (ny === ymOf(todayStr())) ? todayStr() : ny + '-01';
    }
  }
  // Segmented Day/Week/Month + (for week/month) a prev/label/next nav bar.
  function rangeBarHtml(key) {
    var rs = rangeState(key);
    return '<div class="seg rg-mode" data-rk="' + key + '">' +
      ['day', 'week', 'month'].map(function (m) {
        return '<button data-rm="' + m + '"' + (rs.mode === m ? ' class="active"' : '') + '>' + (m === 'day' ? 'Day' : m === 'week' ? 'Week' : 'Month') + '</button>';
      }).join('') + '</div>' +
      (rs.mode === 'day' ? '' :
        '<div class="date-bar rg-nav" data-rk="' + key + '">' +
          '<button class="icon-btn rg-prev" type="button">‹</button>' +
          '<div class="rg-label mono">' + rangeLabelFor(rs.mode, rs.anchor) + '</div>' +
          '<button class="icon-btn rg-next" type="button"' + (rangeAtLatest(rs) ? ' disabled' : '') + '>›</button>' +
        '</div>');
  }
  function bindRangeBar(box, key, rerender) {
    var seg = box.querySelector('.rg-mode[data-rk="' + key + '"]');
    if (seg) seg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-rm]'); if (!b) return;
      rangeState(key).mode = b.getAttribute('data-rm');
      rerender();
    });
    var nav = box.querySelector('.rg-nav[data-rk="' + key + '"]');
    if (nav) {
      nav.querySelector('.rg-prev').addEventListener('click', function () { rangeShift(key, -1); rerender(); });
      var nx = nav.querySelector('.rg-next');
      if (nx) nx.addEventListener('click', function () { rangeShift(key, 1); rerender(); });
    }
  }
  function rangeDatesList(from, to) {
    var out = [], d = from, guard = 0;
    while (d <= to && guard++ < 400) { out.push(d); d = addDays(d, 1); }
    return out;
  }
  // Averages an arbitrary per-day value (extractFn(log, date) -> number|null)
  // over the range, ignoring future dates. "hits" counts truthy values —
  // handy for "X of Y days goal met" style stats.
  function rangeAgg(from, to, extractFn) {
    var dates = rangeDatesList(from, to).filter(function (d) { return d <= todayStr(); });
    var sum = 0, n = 0, hits = 0, perDay = [];
    dates.forEach(function (d) {
      var v = extractFn(logFor(d), d);
      perDay.push({ date: d, v: v || 0 });
      if (v != null) { sum += v; n++; if (v) hits++; }
    });
    return { avg: n ? sum / n : 0, sum: sum, days: dates.length, logged: n, hits: hits, perDay: perDay };
  }
  // One label format per chart, chosen from that chart's max — so 1,046 and
  // 1,072 stay distinguishable instead of both collapsing to "1k". Only shorten
  // to "k" once the values are big enough that the dropped digits don't matter.
  function rcFormatter(max, dec) {
    if (max >= 10000) return function (v) { return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k'; };
    return function (v) {
      return v.toFixed(dec || 0).replace(/\.0+$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    };
  }
  // Small per-day bar chart shared by every range-aware mini-app.
  // Tall plot + a value printed on each cap + an average reference line: squat
  // full-width blocks whose only value was a hover tooltip were unreadable on a
  // phone (nothing to hover), so day-to-day change was impossible to spot.
  function rangeBarChart(perDay, colorVar, unit, dec, ref) {
    var today = todayStr();
    var H = 104;                       // tallest bar, px — sets the plot's aspect
    var max = 0, sum = 0, n = 0;
    perDay.forEach(function (p) {
      if (p.date > today) return;
      if (p.v > max) max = p.v;
      if (p.v > 0) { sum += p.v; n++; }
    });
    // A reference line (e.g. your calorie goal) is part of the scale, so a day
    // under it still reads as under it.
    if (ref && ref.v > max) max = ref.v;
    var avg = n ? sum / n : 0;
    var fmt = rcFormatter(max, dec);
    var dense = perDay.length > 10;    // a month — 31 labelled caps is unreadable
    var peak = null;
    if (max > 0) perDay.forEach(function (p) { if (!peak && p.date <= today && p.v === max) peak = p.date; });
    var cols = perDay.map(function (p) {
      var isFuture = p.date > today;
      var h = max && p.v > 0 ? Math.max(3, Math.round(p.v / max * H)) : 3;
      // Label every cap across a week; on a month only the peak gets one and
      // the average line carries the rest.
      var showVal = p.v > 0 && !isFuture && (!dense || p.date === peak);
      return '<div class="rc-col">' +
        (showVal ? '<span class="rc-val">' + fmt(p.v) + '</span>' : '') +
        '<div class="rc-bar' + (isFuture ? ' future' : p.v ? '' : ' empty') + '"' +
          ' style="height:' + h + 'px' + (p.v > 0 && !isFuture ? ';background:' + colorVar : '') + '"' +
          ' title="' + shortDate(p.date) + ': ' + p.v.toFixed(dec || 0) + (unit || '') + '"></div>' +
        '</div>';
    }).join('');
    var axis = perDay.map(function (p, i) {
      var lbl = dense
        ? ((i === 0 || (i + 1) % 5 === 0) ? String(Number(p.date.slice(8, 10))) : '')
        : parse(p.date).toLocaleDateString(undefined, { weekday: 'narrow' });
      return '<span class="rc-lbl">' + lbl + '</span>';
    }).join('');
    // One reference line: an explicit one (a goal) when given, else the average.
    var line = null;
    if (ref && ref.v > 0 && max) line = { h: Math.round(ref.v / max * H), label: ref.label || ('goal ' + fmt(ref.v)) };
    else if (n >= 2 && max && avg > 0) line = { h: Math.round(avg / max * H), label: 'avg ' + fmt(avg) };
    // The line's value rides a small legend above the plot, not the line itself:
    // an on-line label always ends up colliding with whichever bar cap sits at
    // roughly average height.
    var showLine = line && line.h > 8;
    return '<div class="rc-chart">' +
      (showLine ? '<div class="rc-legend"><i></i>' + esc(line.label) + '</div>' : '') +
      '<div class="rc-plot">' +
        (showLine ? '<div class="rc-avg" style="bottom:' + line.h + 'px"></div>' : '') +
        '<div class="rc-cols">' + cols + '</div>' +
      '</div>' +
      '<div class="rc-axis">' + axis + '</div>' +
    '</div>';
  }

  /* ---------------- Calendar (real month grid) ---------------- */
  function shortDate(date) {
    return parse(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function ymOf(dateStr) { return String(dateStr).slice(0, 7); }
  function ymShift(ym, n) {
    var p = ym.split('-');
    var d = new Date(+p[0], +p[1] - 1 + n, 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function ymLabel(ym) {
    var p = ym.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function ymShort(ym) {
    var p = ym.split('-');
    return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString(undefined, { month: 'short' });
  }
  function daysInYm(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
  // Dates of `ym` between the user's start date and today (the scoreable days).
  function monthElapsedDates(ym) {
    var start = fmt(parse(state.user.startDate)), today = todayStr();
    var from = ym + '-01', to = ym + '-' + pad(daysInYm(ym));
    if (from < start) from = start;
    if (to > today) to = today;
    var out = [];
    for (var d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }

  function renderCalendar() {
    if (!state.calMonth) state.calMonth = ymOf(todayStr());
    var ym = state.calMonth;
    var startYm = ymOf(fmt(parse(state.user.startDate)));
    $('#cal-month-label').textContent = ymLabel(ym);
    $('#cal-prev').disabled = ym <= startYm;
    $('#cal-next').disabled = ym >= ymOf(todayStr());
    renderJourneySummary(ym);
    buildMonthCalendar('#calendar-grid', ym);
    renderMonthReport('#month-report', ym);
  }

  function buildMonthCalendar(gridSel, ym) {
    var grid = $(gridSel); if (!grid) return;
    grid.innerHTML = '';
    var today = todayStr();
    var start = fmt(parse(state.user.startDate));
    var p = ym.split('-');
    var first = new Date(+p[0], +p[1] - 1, 1);
    var lead = (first.getDay() + 6) % 7; // Monday-first offset
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (w) {
      var h = el('div', 'cal-dow mono'); h.textContent = w; grid.appendChild(h);
    });
    for (var b = 0; b < lead; b++) grid.appendChild(el('div', 'cal-blank'));
    var days = daysInYm(ym);
    for (var day = 1; day <= days; day++) {
      var date = ym + '-' + pad(day);
      var dn = dayNumber(start, date);
      var cell = el('div', 'cal-cell');
      cell.innerHTML = '<span class="cc-num">' + day + '</span>' +
        '<span class="cc-date">' + (dn >= 1 && date <= today ? 'd' + dn : '') + '</span>';
      if (date < start) cell.classList.add('pre');
      else if (date <= today) {
        var log = logFor(date);
        if (log && goalMet(log)) cell.classList.add('done');
        else if (log && completedCount(log) > 0) cell.classList.add('partial');
        else if (date < today) cell.classList.add('miss');
      }
      if (date === today) cell.classList.add('today');
      if (date <= today) {
        cell.classList.add('editable');
        (function (dt) { cell.addEventListener('click', function () { openDayEditor(dt); }); })(date);
      }
      grid.appendChild(cell);
    }
  }

  function renderJourneySummary(ym) {
    var box = $('#journey-summary'); if (!box) return;
    var dates = monthElapsedDates(ym);
    var completed = 0, taskHits = 0, taskTotal = 0;
    dates.forEach(function (date) {
      var log = logFor(date);
      if (log && goalMet(log)) completed++;
      taskTotal += TOTAL_ITEMS;
      if (log) taskHits += completedCount(log);
    });
    var rate = taskTotal ? Math.round((taskHits / taskTotal) * 100) : 0;
    box.innerHTML =
      '<div class="js-stat"><b>' + completed + ' / ' + dates.length + '</b><span>days complete</span></div>' +
      '<div class="js-stat"><b>' + rate + '%</b><span>tasks done</span></div>';
  }

  /* ---------------- Life Score — monthly pillar grades ---------------- */
  // Per-day sub-scores (0–100). A day with no log scores 0 — discipline counts.
  function dayPillarScores(d) {
    d = d || {};
    var waterPct = pctOf(Number(d.waterMl) || 0, WATER_GOAL);
    var moves = ((d.workout1 ? 1 : 0) + (d.outdoor ? 1 : 0) + (d.diet ? 1 : 0)) / 3 * 100;
    var body = Math.round(moves * 0.7 + waterPct * 0.3);
    // MIND — reading + mood (journalling adds a bonus)
    var mind = d.mood
      ? Math.round((d.reading ? 100 : 0) * 0.6 + (d.mood / 5 * 100) * 0.4)
      : (d.reading ? 100 : 0);
    if (d.notes && String(d.notes).trim()) mind = Math.min(100, mind + 10);
    // LIFE — discipline (photo + no alcohol) blended with habits + work
    var parts = [((d.photo ? 1 : 0) + (d.noAlcohol ? 1 : 0)) / 2 * 100];
    var habits = (state.profile && state.profile.customTasks) || [];
    if (habits.length) parts.push(pctOf(habits.filter(function (h) { return d.extra && d.extra[h.id]; }).length, habits.length));
    var bizList = businesses();
    if (bizList.length) {
      var worked = 0;
      bizList.forEach(function (b) { var e = (d.biz || {})[b.id] || {}; if ((Number(e.m) || 0) > 0 || (Number(e.t) || 0) > 0) worked++; });
      parts.push(pctOf(worked, bizList.length));
    }
    var life = Math.round(parts.reduce(function (a, b) { return a + b; }, 0) / parts.length);
    return { body: body, mind: mind, life: life };
  }

  /* ================= Gamification =================
     XP is DERIVED from history, never a stored counter — xpTotals() sums dayXp()
     over every log, so it is idempotent, offline-safe and needs zero backend.
     Levels and the four skill tracks fall straight out of the same day logs that
     already drive the pillar scores. */
  var XP_K = 140;            // curve: cumulative XP to reach level L = XP_K·L(L+1)/2
  var XP_PER_GLASS = 3, XP_PERFECT = 40;
  var lastXpLevel = null;    // seeded on first render; a rise fires the level-up burst
  function dayXp(d) {
    d = d || {};
    var m = d.metrics || {};
    var body = 0, mind = 0, life = 0;
    // BODY — training + hydration + movement
    if (d.workout1) body += 25;
    if (d.outdoor) body += 25;
    if (d.diet) body += 15;
    body += Math.min(GLASS_COUNT, Math.round((Number(d.waterMl) || 0) / GLASS)) * XP_PER_GLASS;
    if (m.steps) body += Math.min(15, Math.floor(Number(m.steps) / 1000));
    // MIND — reading + reflection + calm
    if (d.reading) mind += 15;
    if (d.mood) mind += Math.round(Number(d.mood) / 5 * 10);
    if (d.notes && String(d.notes).trim()) mind += 10;
    if (m.meditMin) mind += Math.min(20, Math.round(Number(m.meditMin) / 3));
    if (m.breathMin) mind += Math.min(10, Math.round(Number(m.breathMin)));
    // LIFE — discipline + habits + work
    if (d.photo) life += 10;
    if (d.noAlcohol) life += 10;
    if (d.extra && d.extra.noCig) life += 10;
    ((state.profile && state.profile.customTasks) || []).forEach(function (h) { if (d.extra && d.extra[h.id]) life += 8; });
    businesses().forEach(function (b) { var e = (d.biz || {})[b.id] || {}; if ((Number(e.m) || 0) > 0 || (Number(e.t) || 0) > 0) life += 10; });
    if (m.detoxMin) life += Math.min(15, Math.round(Number(m.detoxMin) / 10));
    // Relationship check-in (Us). The connection score itself earns nothing —
    // only concrete actions do — so there's no incentive to inflate the rating.
    var rel = relOf(d);
    if (rel.qt) life += 10;
    if (rel.act) life += 10;                    // did the day's small connection act
    if (rel.note && String(rel.note).trim()) life += 8;
    if (rel.hardNote && String(rel.hardNote).trim()) life += 8;   // naming a hard day counts too
    if (rel.langs) REL_LANGS.forEach(function (l) { if (rel.langs[l.key]) life += 4; });
    // Work check-in — rewards focus & BOUNDARIES, not raw hours. The focus score
    // and the honest "overworked" flag deliberately earn nothing.
    var wk = (d.extra && d.extra.work) || {};
    if (wk.clockOut) life += 12;                // protected the evening — the boundary win
    if (Number(wk.deep)) life += Math.min(12, Number(wk.deep) * 4);
    if (wk.note && String(wk.note).trim()) life += 5;
    var bonus = goalMet(d) ? XP_PERFECT : 0;   // perfect-day reward
    return { body: body, mind: mind, life: life, bonus: bonus, total: body + mind + life + bonus };
  }
  // Merge today (live, maybe unsaved) over the saved logs so XP updates instantly.
  function xpLogs() {
    var byDate = {};
    (state.logs || []).forEach(function (d) { if (d && d.date) byDate[d.date] = d; });
    if (state.today && state.today.date) byDate[state.today.date] = state.today;
    return Object.keys(byDate).map(function (k) { return byDate[k]; });
  }
  function xpTotals() {
    var t = { body: 0, mind: 0, life: 0, total: 0 };
    xpLogs().forEach(function (d) { var x = dayXp(d); t.body += x.body; t.mind += x.mind; t.life += x.life; t.total += x.total; });
    return t;
  }
  function levelInfo(xp) {              // cumulative XP -> {level, inLevel, span, pct, next}
    xp = Math.max(0, xp || 0);
    var L = Math.floor((Math.sqrt(1 + 8 * xp / XP_K) - 1) / 2);
    if (L < 0) L = 0;
    var floor = XP_K * L * (L + 1) / 2, next = XP_K * (L + 1) * (L + 2) / 2;
    return { level: L + 1, xp: xp, inLevel: Math.round(xp - floor), span: Math.round(next - floor), next: next, pct: Math.round((xp - floor) / (next - floor) * 100) };
  }
  function pillarLevel(xp) { return levelInfo(xp).level; }

  // A "+N XP" floater — pure visual, fired on a positive change.
  function showXpFloat(text) {
    var f = document.createElement('div');
    f.className = 'xp-float'; f.textContent = text;
    document.body.appendChild(f);
    setTimeout(function () { f.remove(); }, 1100);
    if (state.haptics && navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
  }
  // Level-up burst — deterministic confetti (no Math.random needed) + toast.
  function fireLevelUp(level) {
    toast('⭐ Level up! You reached LV ' + level);
    var host = document.createElement('div'); host.className = 'lvlup';
    for (var i = 0; i < 22; i++) {
      var p = document.createElement('i');
      p.style.cssText = '--a:' + (i * 16.4) + 'deg;--d:' + (620 + (i % 5) * 130) + 'ms;--h:' + ((i * 47) % 360);
      host.appendChild(p);
    }
    document.body.appendChild(host);
    setTimeout(function () { host.remove(); }, 1500);
    if (state.haptics && navigator.vibrate) { try { navigator.vibrate([20, 40, 20]); } catch (e) {} }
  }
  // Called after a task toggle: float the XP delta and celebrate a new level.
  function gamifyAfterToggle(delta) {
    if (delta > 0) showXpFloat('+' + delta + ' XP');
    var lv = levelInfo(xpTotals().total).level;
    if (lastXpLevel !== null && lv > lastXpLevel) fireLevelUp(lv);
    lastXpLevel = lv;
    if (!$('#view-home').classList.contains('hidden')) renderHome();
  }

  /* ================= Charge — the AI-cost battery =================
     A monthly budget for the API-cost features (food scans, searches, coach
     chat). The real cap is enforced server-side; this is the battery UI +
     out-of-Charge handling. Charge refills on the 1st and grows as you complete
     days, so consistent trackers unlock more AI. */
  var CHARGE_LABELS = { scanLabel: 'Food scan', foodSearch: 'Food search', coachChat: 'Coach message', parseScreenTime: 'Screen-time scan', moneyParseScreenshot: 'Money scan', moneyParseMessage: 'Money parse', moneyCoachChat: 'Money coach' };
  function chargeCostOf(action) { return (state.charge && state.charge.costs && state.charge.costs[action]) || 0; }
  function updateCharge(c) {
    if (!c) return;
    state.charge = c;
    if (!$('#view-home').classList.contains('hidden')) renderChargeCard();
  }
  function refreshCharge() {
    if (!state.token && !OFFLINE) return;
    api('getCharge', {}).then(updateCharge).catch(function () {});
  }
  function chargePct() { var c = state.charge; if (!c || !c.cap) return 0; return Math.max(0, Math.min(100, Math.round(c.balance / c.cap * 100))); }
  function chargeColor(pct) { return pct <= 15 ? '#ef4444' : pct <= 40 ? '#f59e0b' : '#22c55e'; }
  // A compact battery pill — reused near AI actions.
  function chargeChipHtml() {
    var c = state.charge; if (!c) return '';
    if (c.unlimited) return '<span class="charge-chip unlimited">🔋 ∞</span>';
    var pct = chargePct();
    return '<span class="charge-chip" style="--cc:' + chargeColor(pct) + '"><span class="cc-batt"><span style="width:' + pct + '%"></span></span>' + c.balance + '</span>';
  }
  function renderChargeCard() {
    var box = $('#home-charge'); if (!box) return;
    var c = state.charge;
    if (!c) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    if (c.unlimited) {
      box.innerHTML = '<div class="card charge-card"><div class="ch-top"><span class="eyebrow">🔋 Charge</span><span class="ch-bal mono">Unlimited</span></div>' +
        '<div class="muted tiny">Admin account — AI features aren’t metered for you.</div></div>';
      return;
    }
    var pct = chargePct(), col = chargeColor(pct);
    box.innerHTML =
      '<div class="card charge-card"><div class="ch-top">' +
        '<span class="eyebrow">🔋 Charge · powers AI</span>' +
        '<span class="ch-bal mono">' + c.balance + ' / ' + c.cap + '</span></div>' +
        '<div class="ch-batt"><span style="width:' + pct + '%;background:' + col + '"></span></div>' +
        '<div class="muted tiny ch-sub">Refills on the 1st · +' + c.earnPerDay + ' each day you complete' +
          (c.balance <= 15 ? ' · <b style="color:' + col + '">running low</b>' : '') + '</div>' +
      '</div>';
  }
  function handleChargeEmpty(msg) {
    var text = msg.indexOf('|') >= 0 ? msg.split('|')[1] : 'You’re out of Charge for this month.';
    toast('🔋 ' + text);
    refreshCharge();
  }

  /* ================= Character (RPG avatar) =================
     A FIFA-style card built from the SAME logged behaviour that drives the
     pillar scores — you can't fake it, you earn it by living it. Six traits,
     each 0–99, derived from your real history: 60% recent-30-day form + a
     saturating lifetime-mastery bonus. On top of the earned base, each level
     grants skill points you can spend to shape your build (capped, so effort
     always dominates). All derived + a small profile.avatar allocation blob,
     synced through saveGoals — zero backend. */
  var AV_ALLOC_CAP = 15;   // max points you can pour into one trait
  var AV_PTS_PER_LVL = 2;  // skill points earned per character level
  var AVATAR_TRAITS = [
    { key: 'pow', label: 'Power',     abbr: 'POW', emoji: '💪', pillar: 'body', color: 'var(--body-c)', blurb: 'strength & training' },
    { key: 'end', label: 'Endurance', abbr: 'END', emoji: '🏃', pillar: 'body', color: '#f97316', blurb: 'cardio & hydration' },
    { key: 'foc', label: 'Focus',     abbr: 'FOC', emoji: '🎯', pillar: 'mind', color: 'var(--mind-c)', blurb: 'calm & deep work' },
    { key: 'mnd', label: 'Mind',      abbr: 'MND', emoji: '🧠', pillar: 'mind', color: '#818cf8', blurb: 'reading & reflection' },
    { key: 'wlt', label: 'Wealth',    abbr: 'WLT', emoji: '💰', pillar: 'money', color: 'var(--money-c)', blurb: 'money discipline' },
    { key: 'wil', label: 'Willpower', abbr: 'WIL', emoji: '🔥', pillar: 'life', color: 'var(--life-c)', blurb: 'streak & discipline' }
  ];
  // Generic 0–99 rating: recent-30-day avg intensity (0..1) + saturating volume.
  function avTrait(intensityFn, volFn, volSat, formW, masteryW) {
    var today = todayStr(), sum = 0, n = 0;
    for (var i = 0; i < 30; i++) { var dt = addDays(today, -i); var l = dt === today ? (state.today || {}) : (logFor(dt) || {}); sum += intensityFn(l); n++; }
    var rate = n ? sum / n : 0;
    var vol = 0; xpLogs().forEach(function (l) { vol += volFn(l || {}); });
    var mastery = Math.min(1, vol / volSat);
    return Math.max(1, Math.min(99, Math.round(12 + rate * (formW || 58) + mastery * (masteryW || 29))));
  }
  function avMetric(l, k) { return Number((l.metrics || {})[k]) || 0; }
  function avatarBase() {
    var habits = (state.profile && state.profile.customTasks) || [];
    var streak = streakOf(state.logs || []);
    var pow = avTrait(
      function (l) { return l.workout1 ? 1 : 0; },
      function (l) { return l.workout1 ? 1 : 0; }, 120);
    var end = avTrait(
      function (l) { return Math.min(1, (l.outdoor ? 0.6 : 0) + Math.min(0.5, avMetric(l, 'steps') / 12000) + Math.min(0.3, (Number(l.waterMl) || 0) / WATER_GOAL * 0.3)); },
      function (l) { return (l.outdoor || avMetric(l, 'steps') >= 6000) ? 1 : 0; }, 120);
    var foc = avTrait(
      function (l) { var wk = (l.extra && l.extra.work) || {}; var min = avMetric(l, 'meditMin') + avMetric(l, 'detoxMin') + avMetric(l, 'breathMin') + (Number(wk.deep) || 0) * 30; return Math.min(1, min / 60); },
      function (l) { var wk = (l.extra && l.extra.work) || {}; return (avMetric(l, 'meditMin') + avMetric(l, 'detoxMin') + avMetric(l, 'breathMin') + (Number(wk.deep) || 0) * 30) / 60; }, 30);
    var mnd = avTrait(
      function (l) { return Math.min(1, (l.reading ? 0.7 : 0) + (l.mood ? Number(l.mood) / 5 * 0.2 : 0) + (l.notes && String(l.notes).trim() ? 0.1 : 0)); },
      function (l) { return l.reading ? 1 : 0; }, 120);
    var wil = avTrait(
      function (l) {
        var hp = habits.length ? habits.filter(function (h) { return l.extra && l.extra[h.id]; }).length / habits.length : 0;
        return Math.min(1, (l.noAlcohol ? 0.28 : 0) + (l.extra && l.extra.noCig ? 0.18 : 0) + (l.diet ? 0.22 : 0) + hp * 0.32);
      },
      function (l) { return goalMet(l) ? 1 : 0; }, 75, 45, 42);
    // Streak is the strongest willpower signal — fold it in.
    wil = Math.max(1, Math.min(99, Math.round(wil * 0.6 + Math.min(1, streak / 60) * 99 * 0.4)));
    // Wealth: from the budget score + lifetime budget wins. Low until a budget
    // exists — honestly reflecting that money isn't being tracked yet.
    var msc = moneyScoreFor(ymOf(todayStr()));
    var wltScore = (typeof msc === 'number') ? msc : 0;
    var wlt = Math.max(1, Math.min(99, Math.round(12 + wltScore / 100 * 58 + Math.min(1, moneyXp() / 300) * 29)));
    return { pow: pow, end: end, foc: foc, mnd: mnd, wlt: wlt, wil: wil };
  }
  function avatarProfile() { return (state.profile && state.profile.avatar) || {}; }
  function avatarAlloc() { return avatarProfile().alloc || {}; }
  function avatarSkill() {
    var lvl = levelInfo(xpTotals().total).level;
    var earned = Math.max(0, (lvl - 1) * AV_PTS_PER_LVL);
    var a = avatarAlloc(), spent = 0;
    for (var k in a) spent += Math.max(0, Number(a[k]) || 0);
    return { earned: earned, spent: spent, avail: Math.max(0, earned - spent) };
  }
  function avatarTraits() {
    var base = avatarBase(), a = avatarAlloc(), out = {};
    AVATAR_TRAITS.forEach(function (t) {
      var b = base[t.key] || 1, add = Math.max(0, Math.min(AV_ALLOC_CAP, Number(a[t.key]) || 0));
      out[t.key] = { base: b, alloc: add, val: Math.min(99, b + add) };
    });
    return out;
  }
  function avatarOverall(tr) { var s = 0; AVATAR_TRAITS.forEach(function (t) { s += tr[t.key].val; }); return Math.round(s / AVATAR_TRAITS.length); }
  function avatarTier(ovr) {
    if (ovr >= 90) return { name: 'Icon', cls: 'icon', emoji: '👑' };
    if (ovr >= 82) return { name: 'Legend', cls: 'legend', emoji: '⭐' };
    if (ovr >= 72) return { name: 'Elite', cls: 'elite', emoji: '🥇' };
    if (ovr >= 60) return { name: 'Pro', cls: 'pro', emoji: '🥈' };
    if (ovr >= 45) return { name: 'Rising', cls: 'rising', emoji: '🥉' };
    return { name: 'Rookie', cls: 'rookie', emoji: '🌱' };
  }
  function avatarArchetype(tr) {
    var pil = { body: (tr.pow.val + tr.end.val) / 2, mind: (tr.foc.val + tr.mnd.val) / 2, money: tr.wlt.val, life: tr.wil.val };
    var arr = Object.keys(pil).map(function (k) { return { k: k, v: pil[k] }; }).sort(function (a, b) { return b.v - a.v; });
    if (arr[0].v - arr[3].v <= 8) return { name: 'All-Rounder', emoji: '🌟', pos: 'ALL' };
    var map = {
      body: { name: 'Athlete', emoji: '🏃', pos: 'ATH' },
      mind: { name: 'Sage', emoji: '🧘', pos: 'SGE' },
      money: { name: 'Mogul', emoji: '💼', pos: 'MGL' },
      life: { name: 'Monk', emoji: '🛡️', pos: 'MNK' }
    };
    return map[arr[0].k];
  }
  // Form: last-7-day XP vs the 7 before — momentum arrow.
  function avatarForm() {
    var today = todayStr(), a = 0, b = 0;
    for (var i = 0; i < 7; i++) { var l = logFor(addDays(today, -i)) || (addDays(today, -i) === today ? state.today : null); if (l) a += dayXp(l).total; }
    for (var j = 7; j < 14; j++) { var l2 = logFor(addDays(today, -j)); if (l2) b += dayXp(l2).total; }
    if (a > b * 1.15) return { label: 'Hot', arrow: '▲', cls: 'up' };
    if (a < b * 0.85) return { label: 'Cooling', arrow: '▼', cls: 'down' };
    return { label: 'Steady', arrow: '●', cls: 'flat' };
  }
  function saveAvatar(patch) {
    var av = Object.assign({}, avatarProfile(), patch);
    var profile = Object.assign({}, state.profile, { avatar: av });
    state.profile = profile;
    api('saveGoals', { profile: profile }).then(function (data) { if (data && data.profile) state.profile = data.profile; }).catch(function (e) { toast(e.message); });
  }
  function avatarAllocSet(key, delta) {
    var a = Object.assign({}, avatarAlloc());
    var sk = avatarSkill();
    var cur = Math.max(0, Number(a[key]) || 0);
    if (delta > 0) { if (sk.avail <= 0) { toast('No skill points left — level up to earn more'); return; } if (cur >= AV_ALLOC_CAP) { toast('Maxed this trait (+' + AV_ALLOC_CAP + ')'); return; } }
    if (delta < 0 && cur <= 0) return;
    a[key] = cur + delta;
    saveAvatar({ alloc: a });
    renderAvatar();
  }

  function renderAvatar() {
    var box = $('#avatar-app'); if (!box) return;
    var tr = avatarTraits(), ovr = avatarOverall(tr), tier = avatarTier(ovr), arch = avatarArchetype(tr);
    var li = levelInfo(xpTotals().total), sk = avatarSkill(), form = avatarForm();
    var name = avatarProfile().name || (state.user && state.user.displayName) || 'You';
    var nextTier = [45, 60, 72, 82, 90].filter(function (x) { return x > ovr; })[0];

    var traitRows = AVATAR_TRAITS.map(function (t) {
      var v = tr[t.key];
      return '<div class="av-trait"><div class="av-tr-top">' +
          '<span class="av-tr-name">' + t.emoji + ' ' + t.abbr + ' <span class="muted tiny">' + t.blurb + '</span></span>' +
          '<span class="av-tr-val">' + v.val + (v.alloc ? '<span class="av-tr-alloc">+' + v.alloc + '</span>' : '') + '</span></div>' +
        '<div class="av-tr-bar"><span style="width:' + v.val + '%;background:' + t.color + '"></span></div>' +
        '<div class="av-tr-ctl"><button class="av-pt" data-avdec="' + t.key + '">−</button>' +
          '<button class="av-pt" data-avinc="' + t.key + '">+</button></div></div>';
    }).join('');

    box.innerHTML =
      '<div class="card av-card av-' + tier.cls + '">' +
        '<div class="av-card-top">' +
          '<div class="av-ovr"><div class="av-ovr-num">' + ovr + '</div><div class="av-ovr-lbl">OVR</div>' +
            '<div class="av-pos">' + arch.pos + '</div></div>' +
          '<div class="av-portrait">' + arch.emoji + '<span class="av-tierbadge">' + tier.emoji + '</span></div>' +
        '</div>' +
        '<div class="av-name">' + esc(name) + ' <button class="av-edit" id="av-rename" title="Rename">✎</button></div>' +
        '<div class="av-sub"><span class="av-tier-chip av-' + tier.cls + '">' + tier.emoji + ' ' + tier.name + '</span>' +
          '<span class="muted">' + arch.emoji + ' ' + arch.name + '</span>' +
          '<span class="av-form av-form-' + form.cls + '">' + form.arrow + ' ' + form.label + '</span></div>' +
        '<div class="av-lvl"><div class="lv-bar"><span style="width:' + Math.min(100, li.pct) + '%"></span></div>' +
          '<div class="muted tiny" style="margin-top:5px">LV ' + li.level + ' · ' + li.inLevel + ' / ' + li.span + ' XP to LV ' + (li.level + 1) +
            (nextTier ? ' · next tier at OVR ' + nextTier : ' · top tier reached 👑') + '</div></div>' +
      '</div>' +
      '<div class="card av-pts-card"><div class="av-pts-head"><span class="eyebrow">Skill points</span>' +
        '<span class="av-pts-bal ' + (sk.avail ? 'has' : '') + '">' + sk.avail + ' to spend</span></div>' +
        '<p class="muted tiny" style="margin:2px 0 10px">Earn ' + AV_PTS_PER_LVL + ' per level. Spend them to shape your build (up to +' + AV_ALLOC_CAP + ' per trait). Your base rating is earned by showing up — points just add on top.</p>' +
        '<div class="av-traits">' + traitRows + '</div>' +
        (sk.spent ? '<button class="btn block" id="av-reset" style="margin-top:12px">↺ Reset points</button>' : '') +
      '</div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:6px">How your character grows</div>' +
        '<p class="muted tiny" style="margin:0">Every trait is computed from what you actually log — 60% your last 30 days, 40% lifetime mastery. Run and train → POW/END climb. Meditate, unplug, read → FOC/MND. Stay under budget → WLT. Keep your streak and habits → WIL. Live it and the card rises on its own.</p></div>';

    box.querySelectorAll('[data-avinc]').forEach(function (b) { b.addEventListener('click', function () { avatarAllocSet(b.getAttribute('data-avinc'), 1); }); });
    box.querySelectorAll('[data-avdec]').forEach(function (b) { b.addEventListener('click', function () { avatarAllocSet(b.getAttribute('data-avdec'), -1); }); });
    var reset = $('#av-reset');
    if (reset) reset.addEventListener('click', function () { if (!confirm('Reset all allocated skill points?')) return; saveAvatar({ alloc: {} }); renderAvatar(); });
    var rename = $('#av-rename');
    if (rename) rename.addEventListener('click', function () {
      var n = prompt('Name your character', name); if (n == null) return;
      saveAvatar({ name: String(n).slice(0, 24) }); renderAvatar();
    });
  }

  // Month aggregates from the day logs (money is added separately, async).
  function monthScores(ym) {
    var dates = monthElapsedDates(ym);
    if (!dates.length) return null;
    var b = 0, m = 0, l = 0;
    dates.forEach(function (dt) {
      var s = dayPillarScores(logFor(dt));
      b += s.body; m += s.mind; l += s.life;
    });
    var n = dates.length;
    return { ym: ym, days: n, body: Math.round(b / n), mind: Math.round(m / n), life: Math.round(l / n) };
  }

  // Money score per month — fetched once per month & cached.
  // Daily-win driven: every day you stay under your daily budget counts FOR you.
  var moneyMonthCache = {};   // ym -> { spent, limit, perDay: {date: spend} } | 'loading'
  function ensureMoneyMonth(ym, onReady) {
    var c = moneyMonthCache[ym];
    if (c && c !== 'loading') return c;
    if (c === 'loading' || OFFLINE) return null;
    moneyMonthCache[ym] = 'loading';
    var from = ym + '-01', to = ym + '-' + pad(daysInYm(ym));
    Promise.all([
      api('moneyDashboard', { from: from, to: to }),
      api('moneyGetTxns', { from: from, to: to })
    ]).then(function (res) {
      var perDay = {};
      ((res[1] && res[1].transactions) || []).forEach(function (t) {
        if (t.type !== 'expense') return;
        var dte = String(t.date).slice(0, 10);
        perDay[dte] = (perDay[dte] || 0) + (Number(t.amount) || 0);
      });
      moneyMonthCache[ym] = {
        spent: Number(res[0] && res[0].totalSpend) || 0,
        limit: Number(res[0] && res[0].status && res[0].status.limit) || 0,
        perDay: perDay
      };
      if (onReady) onReady();
    }).catch(function () {
      // Don't poison the cache with zeros — clear so the next render retries.
      delete moneyMonthCache[ym];
      if (onReady) onReady();
    });
    return null;
  }
  // Per-month money detail for the report: daily wins + pace.
  function moneyDetailFor(ym) {
    var c = moneyMonthCache[ym];
    if (!c || c === 'loading' || !c.limit) return null;
    var dailyLimit = c.limit / daysInYm(ym);
    var today = todayStr();
    var from = ym + '-01', to = ym + '-' + pad(daysInYm(ym));
    if (to > today) to = today;
    var wins = 0, days = 0;
    for (var d = from; d <= to; d = addDays(d, 1)) {
      days++;
      if ((c.perDay[d] || 0) <= dailyLimit) wins++;
    }
    if (!days) return null;
    // Pace: how total spend compares to the elapsed share of the budget.
    var pace = c.limit * (days / daysInYm(ym));
    var paceScore = Math.max(0, Math.min(100, Math.round(100 * (2 - c.spent / Math.max(1, pace)) / 1.1)));
    var winScore = Math.round(wins / days * 100);
    return {
      dailyLimit: dailyLimit, wins: wins, days: days,
      winScore: winScore, paceScore: paceScore,
      score: Math.round(winScore * 0.7 + paceScore * 0.3)
    };
  }
  // Money skill XP — the money pillar has no day-log track, so its level comes
  // from budget wins in whatever months are cached (each day under the daily
  // limit = 6 XP, parallel to a completed day). Grows as spending is logged.
  function moneyXp() {
    var xp = 0;
    for (var ym in moneyMonthCache) { var det = moneyDetailFor(ym); if (det) xp += det.wins * 6; }
    return xp;
  }
  // → number (scored), null (no budget set), undefined (still loading)
  function moneyScoreFor(ym) {
    var c = moneyMonthCache[ym];
    if (!c || c === 'loading') return OFFLINE ? null : undefined;
    if (!c.limit) return null;
    var det = moneyDetailFor(ym);
    return det ? det.score : null;
  }

  function gradeOf(v) {
    if (typeof v !== 'number') return { g: '—', cls: 'na' };
    if (v >= 90) return { g: 'S', cls: 's' };
    if (v >= 80) return { g: 'A', cls: 'a' };
    if (v >= 70) return { g: 'B', cls: 'b' };
    if (v >= 55) return { g: 'C', cls: 'c' };
    if (v >= 40) return { g: 'D', cls: 'd' };
    return { g: 'F', cls: 'f' };
  }
  function monthOverall(ym) {
    var sc = monthScores(ym);
    if (!sc) return null;
    var vals = [sc.body, sc.mind, sc.life];
    var mv = moneyScoreFor(ym);
    if (typeof mv === 'number') vals.push(mv);
    return Math.round(vals.reduce(function (a, b) { return a + b; }, 0) / vals.length);
  }
  function verdictLine(overall, ym) {
    var now = ym === ymOf(todayStr());
    if (overall == null) return '';
    var t = overall >= 90 ? 'Legendary. All pillars firing 👑'
      : overall >= 80 ? 'Strong month — the machine is running 🔥'
      : overall >= 70 ? 'Solid. Tighten the weakest pillar to level up.'
      : overall >= 55 ? 'Coasting. Discipline beats motivation — lock in.'
      : overall >= 40 ? 'Slipping. Pick ONE pillar and win it this week.'
      : 'Rock bottom is a foundation. Restart today 💪';
    return now ? t + ' (scored on days so far)' : t;
  }

  function renderMonthReport(sel, ym) {
    var box = $(sel); if (!box) return;
    var sc = monthScores(ym);
    if (!sc) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    ensureMoneyMonth(ym, function () {
      // Re-render whichever surface is on screen once money data lands.
      if (!$('#view-calendar').classList.contains('hidden')) renderCalendar();
      if (!$('#view-home').classList.contains('hidden')) renderHome();
    });
    var money = moneyScoreFor(ym);
    var pillars = [
      { name: 'Body', v: sc.body, c: 'var(--body-c)' },
      { name: 'Mind', v: sc.mind, c: 'var(--mind-c)' },
      { name: 'Money', v: money, c: 'var(--money-c)' },
      { name: 'Life', v: sc.life, c: 'var(--life-c)' }
    ];
    var overall = monthOverall(ym);
    var og = gradeOf(overall);
    box.innerHTML =
      '<div class="mr-head">' +
        '<div><span class="eyebrow">Life Score · ' + ymLabel(ym) + '</span>' +
        '<div class="mr-sub muted tiny">' + sc.days + ' day' + (sc.days === 1 ? '' : 's') + ' scored · missed days count as 0</div></div>' +
        '<div class="grade-badge g-' + og.cls + '">' + og.g + '</div>' +
      '</div>' +
      pillars.map(function (p) {
        var loading = p.v === undefined;
        var g = gradeOf(p.v);
        var w = typeof p.v === 'number' ? p.v : 0;
        return '<div class="mr-row">' +
          '<span class="mr-name">' + p.name + '</span>' +
          '<div class="mr-bar"><span style="width:' + w + '%;background:' + p.c + '"></span></div>' +
          '<span class="mr-val mono">' + (loading ? '…' : (p.v == null ? '—' : p.v)) + '</span>' +
          '<span class="grade-chip g-' + (loading ? 'na' : g.cls) + '">' + (loading ? '…' : g.g) + '</span>' +
        '</div>';
      }).join('') +
      (function () {
        if (pillars[2].v === null && !OFFLINE) return '<div class="muted tiny" style="margin-top:6px">Set a monthly budget in Money to score the 💸 pillar.</div>';
        var det = moneyDetailFor(ym);
        if (!det) return '';
        return '<div class="muted tiny" style="margin-top:6px">💸 Money: <b>' + det.wins + '/' + det.days + '</b> days under your ' +
          rupee(det.dailyLimit) + '/day budget — every controlled day scores for you.</div>';
      })() +
      '<div class="mr-note muted tiny">' + verdictLine(overall, ym) + '</div>' +
      '<button type="button" class="link-btn mr-how-btn" id="mr-how-btn">ⓘ How scores work</button>' +
      '<div id="mr-how" class="mr-how hidden muted tiny">' +
        '<p><b style="color:var(--body-c)">Body</b> — daily average of: indoor + outdoor workout and diet (70%) + water goal (30%). A day with nothing logged scores 0.</p>' +
        '<p><b style="color:var(--mind-c)">Mind</b> — reading (60%) + mood (40% when logged), with a +10 bonus for journalling.</p>' +
        '<p><b style="color:var(--money-c)">Money</b> — 70% is <i>daily wins</i>: days you spent under your daily budget (monthly limit ÷ days in month). 30% is overall pace vs budget. Staying under your daily limit is a plus point every single day.</p>' +
        '<p><b style="color:var(--life-c)">Life</b> — discipline (progress photo + no alcohol) blended with your habits done and businesses worked.</p>' +
        '<p>Overall grade = average of available pillars. S ≥ 90 · A ≥ 80 · B ≥ 70 · C ≥ 55 · D ≥ 40.</p>' +
      '</div>' +
      monthHistoryHtml(ym);
    var howBtn = $('#mr-how-btn');
    if (howBtn) howBtn.addEventListener('click', function () { $('#mr-how').classList.toggle('hidden'); });
  }

  // Grade chips for every month since the journey started — the "game map".
  function monthHistoryHtml(activeYm) {
    var startYm = ymOf(fmt(parse(state.user.startDate)));
    var cur = ymOf(todayStr());
    var months = [], ym = startYm, guard = 0;
    while (ym <= cur && guard++ < 36) { months.push(ym); ym = ymShift(ym, 1); }
    if (months.length <= 1) return '';
    return '<div class="mr-hist">' + months.map(function (m) {
      ensureMoneyMonth(m, function () {
        if (!$('#view-calendar').classList.contains('hidden')) renderCalendar();
      });
      var g = gradeOf(monthOverall(m));
      return '<button type="button" class="mr-hchip' + (m === activeYm ? ' active' : '') + '" data-ym="' + m + '">' +
        ymShort(m) + ' <b class="gtext-' + g.cls + '">' + g.g + '</b></button>';
    }).join('') + '</div>';
  }

  /* ----- Day editor (edit any date from Journey) ----- */
  function openDayEditor(date) {
    state.editDay = Object.assign(emptyDay(date), logFor(date) || {});
    state.editDay.date = date;
    $('#day-modal-title').textContent = 'Day ' + dayNumber(state.user.startDate, date) + ' · ' + prettyDate(date);
    renderDayEditorBody();
    dayEditorRenderMood(); dayEditorRenderGut(); dayEditorRenderHabits(); dayEditorRenderWork(); dayEditorRenderMetrics();
    $('#de-notes').value = state.editDay.notes || '';
    show('#day-modal');
  }
  // ----- Day editor: mood / gut / habits / work log / metrics for ANY past day -----
  // Each mutates state.editDay directly; nothing auto-saves — "Save this day" persists it all.
  function dayEditorRenderMood() {
    var box = $('#de-mood'); if (!box) return;
    var d = state.editDay;
    box.innerHTML = '';
    MOODS.forEach(function (m) {
      var on = d.mood === m.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', m.color);
      b.innerHTML = '<span class="mood-emoji">' + m.emoji + '</span><span class="mood-label">' + m.label + '</span>';
      b.addEventListener('click', function () { d.mood = (d.mood === m.v) ? 0 : m.v; dayEditorRenderMood(); });
      box.appendChild(b);
    });
  }
  function dayEditorRenderGut() {
    var box = $('#de-gut'); if (!box) return;
    var d = state.editDay;
    box.innerHTML = '';
    GUT.forEach(function (g) {
      var on = d.gut === g.v;
      var b = el('button', 'mood-btn' + (on ? ' sel' : ''));
      b.style.setProperty('--mc', g.color);
      b.innerHTML = '<span class="mood-emoji">' + g.emoji + '</span><span class="mood-label">' + g.short + '</span>';
      b.addEventListener('click', function () { gutPatch(d, { bristol: (d.gut === g.v) ? 0 : g.v }); dayEditorRenderGut(); });
      box.appendChild(b);
    });
  }
  function dayEditorRenderHabits() {
    var box = $('#de-habits'); if (!box) return;
    var d = state.editDay; if (!d.extra) d.extra = {};
    var habits = (state.profile && state.profile.customTasks) || [];
    box.innerHTML = '';
    if (!habits.length) { box.innerHTML = '<p class="muted tiny">No habits set up yet — add them in the Habits app.</p>'; return; }
    habits.forEach(function (h) {
      var done = !!d.extra[h.id];
      var row = el('div', 'task habit' + (done ? ' done' : ''));
      row.innerHTML = '<div class="check">✓</div><div class="t-emoji">📌</div><div class="t-body"><div class="t-title">' + esc(h.name) + '</div></div>';
      row.addEventListener('click', function () { d.extra[h.id] = !d.extra[h.id]; dayEditorRenderHabits(); });
      box.appendChild(row);
    });
  }
  function dayEditorRenderWork() {
    var box = $('#de-work'); if (!box) return;
    var d = state.editDay; if (!d.biz) d.biz = {};
    var list = businesses();
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<p class="muted tiny">No businesses set up yet — add them in Settings.</p>'; return; }
    list.forEach(function (b) {
      var e = d.biz[b.id] || { m: 0, t: 0 };
      var card = el('div', 'biz-card');
      card.innerHTML = '<div class="biz-top"><span class="biz-name">' + esc(b.name) + '</span></div>' +
        '<div class="biz-row"><span class="biz-lbl">Time</span><input class="de-biz-min" type="number" inputmode="numeric" value="' + (Number(e.m) || 0) + '" /> <span class="muted tiny">min</span></div>' +
        '<div class="biz-row"><span class="biz-lbl">Tasks</span><input class="de-biz-task" type="number" inputmode="numeric" value="' + (Number(e.t) || 0) + '" /></div>';
      card.querySelector('.de-biz-min').addEventListener('input', function () {
        d.biz[b.id] = Object.assign({ m: 0, t: 0 }, d.biz[b.id] || {}, { m: Number(this.value) || 0 });
      });
      card.querySelector('.de-biz-task').addEventListener('input', function () {
        d.biz[b.id] = Object.assign({ m: 0, t: 0 }, d.biz[b.id] || {}, { t: Number(this.value) || 0 });
      });
      box.appendChild(card);
    });
  }
  function dayEditorRenderMetrics() {
    var box = $('#de-metrics'); if (!box) return;
    var m = metricsOf(state.editDay);
    box.innerHTML =
      '<div class="manual-grid">' +
      '<label>Steps<input id="de-steps" type="number" inputmode="numeric" value="' + (m.steps || '') + '" /></label>' +
      '<label>Weight (kg)<input id="de-weight" type="number" inputmode="decimal" value="' + (m.weight || '') + '" /></label>' +
      '<label>Sleep (h)<input id="de-sleep-h" type="number" inputmode="numeric" value="' + (m.sleepMin ? Math.floor(m.sleepMin / 60) : '') + '" /></label>' +
      '<label>Sleep (m)<input id="de-sleep-m" type="number" inputmode="numeric" value="' + (m.sleepMin ? m.sleepMin % 60 : '') + '" /></label>' +
      '</div>';
    $('#de-steps').addEventListener('input', function () { m.steps = Number(this.value) || 0; });
    $('#de-weight').addEventListener('input', function () { m.weight = Number(this.value) || 0; });
    function updateSleep() { m.sleepMin = (Number($('#de-sleep-h').value) || 0) * 60 + (Number($('#de-sleep-m').value) || 0); }
    $('#de-sleep-h').addEventListener('input', updateSleep);
    $('#de-sleep-m').addEventListener('input', updateSleep);
  }
  function renderDayEditorBody() {
    var d = state.editDay;
    var list = $('#day-editor-list');
    list.innerHTML = '';
    TASKS.forEach(function (t) {
      var row = el('div', 'task' + (taskDone(d, t) ? ' done' : ''));
      row.innerHTML = '<div class="check">✓</div><div class="t-emoji">' + t.emoji + '</div>' +
        '<div class="t-body"><div class="t-title">' + t.title + '</div><div class="t-sub">' + t.sub + '</div></div>';
      row.addEventListener('click', function () { taskSetDone(d, t, !taskDone(d, t)); renderDayEditorBody(); });
      list.appendChild(row);
    });
    // water stepper
    var ml = Number(d.waterMl) || 0;
    var w = el('div', 'task water-edit');
    w.innerHTML =
      '<div class="check"' + (ml >= WATER_GOAL ? ' style="background:#4aa8ff;border-color:#4aa8ff;color:#04223f"' : '') + '>✓</div>' +
      '<div class="t-emoji">💧</div>' +
      '<div class="t-body"><div class="t-title">Water</div><div class="t-sub">' + litres(ml) + ' L / ' + litres(WATER_GOAL) + ' L</div></div>' +
      '<button class="wstep" data-d="-1">–</button><button class="wstep" data-d="1">＋</button>';
    w.querySelectorAll('.wstep').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        d.waterMl = Math.max(0, Math.min(WATER_GOAL, (Number(d.waterMl) || 0) + (+b.dataset.d) * GLASS));
        renderDayEditorBody();
      });
    });
    list.appendChild(w);
  }
  function saveDayEditor() {
    var d = state.editDay;
    d.completed = isComplete(d);
    api('saveDay', { day: d }).then(function () {
      var i = state.logs.findIndex(function (l) { return l.date === d.date; });
      var copy = Object.assign({}, d);
      if (i >= 0) state.logs[i] = copy; else state.logs.push(copy);
      state.logs.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      cacheState();
      if (d.date === todayStr()) { state.today = Object.assign(emptyDay(todayStr()), d); }
      hide('#day-modal');
      renderCalendar(); renderAll();
      toast('Saved ' + shortDate(d.date) + ' ✓');
    }).catch(function (e) { toast(e.message); });
  }

  /* ---------------- Stats ---------------- */
  function statsCacheKey() { return 'hard_stats_' + (state.username || ''); }
  // Fetch the network-backed averages and cache them. Returns a Promise of the vals.
  function loadStatsVals() {
    var fast = api('getFasts', {}).then(function (d) { return avgFastLabel(d.fasts || []); }).catch(function () { return '—'; });
    var food = api('foodSummary', {}).then(function (d) { return d; }).catch(function () { return {}; });
    return Promise.all([fast, food]).then(function (res) {
      var d = res[1] || {};
      var g = function (v) { return v != null ? (v + ' g') : '—'; };
      var vals = {
        avgFast: res[0],
        avgCal: d.avgCalories ? (d.avgCalories + ' kcal') : '—',
        avgProtein: g(d.avgProtein), avgCarbs: g(d.avgCarbs), avgFat: g(d.avgFat),
        avgSugar: g(d.avgSugar), avgFiber: g(d.avgFiber)
      };
      try { localStorage.setItem(statsCacheKey(), JSON.stringify(vals)); } catch (e) {}
      return vals;
    });
  }
  // Warm the cache in the background at launch so Stats is instant on first open.
  function prefetchStats() { try { loadStatsVals(); } catch (e) {} }
  function renderStats() {
    // Show last-known averages instantly (Apps Script calls are slow), then refresh.
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(statsCacheKey()) || 'null'); } catch (e) {}
    renderStatsBody(cached || { avgFast: '…', avgCal: '…' });
    loadStatsVals().then(renderStatsBody);
  }

  function avgFastLabel(fasts) {
    var done = (fasts || []).filter(function (f) { return f.endAt; });
    if (!done.length) return '—';
    var avg = done.reduce(function (s, f) {
      return s + (new Date(f.endAt).getTime() - new Date(f.startAt).getTime());
    }, 0) / done.length;
    return Math.floor(avg / 3600000) + 'h ' + Math.floor((avg % 3600000) / 60000) + 'm';
  }

  function renderStatsBody(vals) {
    var logs = state.logs;
    var curDay = Math.max(1, chDay());
    var start = fmt(parse(chStart()));
    var today = todayStr();
    // Count complete days only within the challenge window (ignores stray logs).
    var done = logs.filter(function (l) {
      return l.date >= start && l.date <= today && goalMet(l);
    }).length;

    var grid = $('#stats-grid');
    grid.innerHTML = '';
    [
      ['Current day', !LEN ? curDay : (curDay <= LEN ? curDay + ' / ' + LEN : curDay)],
      ['Streak', streakOf(logs) + '🔥'],
      ['Days completed', done],
      [(LEN && curDay > LEN) ? activeCh().name : 'Days left', (LEN && curDay > LEN) ? 'Done 🏆' : (LEN ? Math.max(0, LEN - curDay) : '∞')],
      ['Avg fast', vals.avgFast],
      ['Avg calories / day', vals.avgCal],
      ['Avg protein / day', vals.avgProtein || '…'],
      ['Avg carbs / day', vals.avgCarbs || '…'],
      ['Avg fat / day', vals.avgFat || '…'],
      ['Avg sugar / day', vals.avgSugar || '…'],
      ['Avg fibre / day', vals.avgFiber || '…']
    ].forEach(function (s) {
      var c = el('div', 'stat');
      c.innerHTML = '<div class="num">' + s[1] + '</div><div class="lbl">' + s[0] + '</div>';
      grid.appendChild(c);
    });

    // per-task consistency over elapsed days
    var elapsed = logs.length || 1;
    var bars = $('#task-bars');
    bars.innerHTML = '';
    var defs = TASKS.concat([{ key: '__water', title: '💧 Water goal' }]);
    defs.forEach(function (t) {
      var hit = logs.filter(function (l) {
        return t.key === '__water' ? Number(l.waterMl) >= WATER_GOAL : taskDone(l, t);
      }).length;
      var pct = Math.round((hit / elapsed) * 100);
      var row = el('div', 'bar-row');
      var label = t.emoji ? (t.emoji + ' ' + t.title) : t.title;
      row.innerHTML = '<div class="bl"><span>' + label + '</span><span>' + pct + '%</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>';
      bars.appendChild(row);
    });

    renderMoodTrend();
    renderGutTrend();
    renderBizStats();
  }

  function renderBizStats() {
    var box = $('#biz-stats'), card = $('#biz-stats-card'); if (!box) return;
    var list = businesses();
    if (!list.length) { if (card) card.classList.add('hidden'); return; }
    if (card) card.classList.remove('hidden');
    var today = todayStr(), weekAgo = addDays(today, -6);
    var agg = {};
    list.forEach(function (b) { agg[b.id] = { name: b.name, min: 0, tasks: 0, days: {}, wkMin: 0, wkTasks: 0 }; });
    (state.logs || []).forEach(function (l) {
      var biz = l.biz || {};
      Object.keys(biz).forEach(function (id) {
        if (!agg[id]) return; // business since removed
        var e = biz[id] || {}, m = Number(e.m) || 0, t = Number(e.t) || 0;
        if (m <= 0 && t <= 0) return;
        agg[id].min += m; agg[id].tasks += t; agg[id].days[l.date] = true;
        if (l.date >= weekAgo && l.date <= today) { agg[id].wkMin += m; agg[id].wkTasks += t; }
      });
    });
    box.innerHTML = list.map(function (b) {
      var a = agg[b.id], days = Object.keys(a.days).length;
      return '<div class="biz-stat">' +
        '<div class="biz-stat-name">' + esc(a.name) + '</div>' +
        '<div class="biz-stat-nums"><span>⏱ <b>' + hoursMin(a.min) + '</b></span>' +
        '<span>✅ <b>' + a.tasks + '</b></span>' +
        '<span>📅 <b>' + days + '</b>d</span></div>' +
        '<div class="muted tiny">This week: ' + hoursMin(a.wkMin) + ' · ' + a.wkTasks + ' tasks</div>' +
        '</div>';
    }).join('');
  }

  function renderMoodTrend(sel) {
    var box = $(sel || '#mood-trend'); if (!box) return;
    var today = todayStr(), dots = '', sum = 0, n = 0;
    for (var i = 13; i >= 0; i--) {
      var date = addDays(today, -i);
      var log = logFor(date);
      var mv = log && log.mood ? log.mood : 0;
      var col = moodColor(mv) || 'var(--bg-soft)';
      dots += '<span class="mt-dot" title="' + shortDate(date) + '" style="background:' + col + '"></span>';
      if (mv) { sum += mv; n++; }
    }
    var avg = n ? (sum / n) : 0;
    var avgM = avg ? MOODS.reduce(function (a, b) { return Math.abs(b.v - avg) < Math.abs(a.v - avg) ? b : a; }) : null;
    box.innerHTML = '<div class="mt-dots">' + dots + '</div>' +
      '<div class="muted tiny" style="margin-top:8px">' +
      (n ? ('Average: ' + avgM.emoji + ' ' + avgM.label + ' (' + avg.toFixed(1) + '/5) over ' + n + ' logged day' + (n > 1 ? 's' : '')) : 'No mood logged yet — set it on the Today screen.') +
      '</div>';
  }
  function renderGutTrend(sel) {
    var box = $(sel || '#gut-trend'); if (!box) return;
    var today = todayStr(), dots = '', counts = {}, n = 0;
    for (var i = 13; i >= 0; i--) {
      var date = addDays(today, -i);
      var log = logFor(date);
      var gv = log && log.gut ? log.gut : 0;
      var col = gutColor(gv) || 'var(--bg-soft)';
      dots += '<span class="mt-dot" title="' + shortDate(date) + (gv ? (' · ' + gutLabel(gv)) : '') + '" style="background:' + col + '"></span>';
      if (gv) { counts[gv] = (counts[gv] || 0) + 1; n++; }
    }
    var legend = GUT.map(function (g) {
      return '<span class="gt-key"><i style="background:' + g.color + '"></i>' + g.label + (counts[g.v] ? (' ' + counts[g.v]) : '') + '</span>';
    }).join('');
    box.innerHTML = '<div class="mt-dots">' + dots + '</div>' +
      '<div class="gt-legend">' + legend + '</div>' +
      '<div class="muted tiny" style="margin-top:6px">' +
      (n ? (n + ' logged day' + (n > 1 ? 's' : '') + ' in the last 14') : 'No gut entries yet — log it on the Today screen.') + '</div>';
  }
  function bestStreak(logs) {
    var best = 0, cur = 0;
    logs.forEach(function (l) { if (goalMet(l)) { cur++; best = Math.max(best, cur); } else cur = 0; });
    return best;
  }

  /* ---------------- Friends ---------------- */
  function renderBoard() {
    renderFeed();
    renderFriends();
  }
  function renderFeed() {
    var box = $('#leaderboard');
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('leaderboard', {}).then(function (data) {
      var list = data.leaderboard || [];
      box.innerHTML = '';
      if (list.length <= 1) {
        box.innerHTML = '<p class="muted">Add friends to see their progress here. Tap <b>Add</b> above to find people.</p>';
        if (!list.length) return;
      }
      list.forEach(function (u, i) {
        var mine = u.displayName === state.user.displayName;
        var medal = ['🥇', '🥈', '🥉'][i] || ('#' + (i + 1));
        var done = u.todayDone || 0, total = u.todayTotal || 8;
        var pending = Math.max(0, total - done);
        var pct = Math.round(done / total * 100);
        var water = litres(u.todayWaterMl || 0) + ' L';
        var cal = Math.round(u.todayCalories || 0);
        var calStr = u.calorieGoal ? (cal + ' / ' + u.calorieGoal) : ('' + cal);
        var badge = u.todayComplete
          ? '<span class="fc-badge done">Day done ✓</span>'
          : '<span class="fc-badge pend">' + pending + ' left</span>';
        var card = el('div', 'friend-card' + (mine ? ' me' : ''));
        card.innerHTML =
          '<div class="fc-top">' +
            '<div class="fc-rank">' + medal + '</div>' +
            '<div class="fc-name">' + esc(u.displayName) + (mine ? ' <span class="muted">(you)</span>' : '') +
              (u.mode === 'soft' ? ' <span class="soft-tag">SOFT</span>' : '') +
              '<small>Day ' + u.currentDay + (u.currentDay > LEN ? ' 🏆' : '') + ' · 🔥 ' + u.streak + ' · ' + u.completedDays + ' days done</small></div>' +
            badge +
          '</div>' +
          '<div class="fc-bar"><span style="width:' + pct + '%"></span></div>' +
          '<div class="fc-stats">' +
            '<span>✅ <b>' + done + '/' + total + '</b> tasks</span>' +
            '<span>💧 <b>' + water + '</b></span>' +
            '<span>🍽️ <b>' + calStr + '</b> kcal</span>' +
          '</div>';
        box.appendChild(card);
      });
    }).catch(function (err) { box.innerHTML = '<p class="muted">' + esc(err.message) + '</p>'; });
  }

  // Load friends + requests; render the Requests pane and the badge.
  function renderFriends() {
    api('getFriends', {}).then(function (d) {
      state.friends = d;
      var inc = d.incoming || [], out = d.outgoing || [];
      var badge = $('#req-badge');
      badge.textContent = inc.length;
      badge.classList.toggle('hidden', !inc.length);

      $('#req-incoming').innerHTML = inc.length
        ? inc.map(function (u) {
            return '<div class="fr-row"><span class="fr-id">' + esc(u.displayName) + ' <span class="muted tiny">@' + esc(u.username) + '</span></span>' +
              '<span class="fr-acts"><button class="btn primary fr-mini" data-accept="' + esc(u.username) + '">Accept</button>' +
              '<button class="btn fr-mini" data-decline="' + esc(u.username) + '">Decline</button></span></div>';
          }).join('')
        : '<p class="muted tiny">No new requests.</p>';

      $('#req-outgoing').innerHTML = out.length
        ? out.map(function (u) {
            return '<div class="fr-row"><span class="fr-id">' + esc(u.displayName) + ' <span class="muted tiny">@' + esc(u.username) + '</span></span>' +
              '<span class="muted tiny">Pending · <a href="#" class="fr-cancel" data-cancel="' + esc(u.username) + '">cancel</a></span></div>';
          }).join('')
        : '<p class="muted tiny">No pending sent requests.</p>';
    }).catch(function () {});
  }

  var friendSearchTimer;
  function runFriendSearch(q) {
    var box = $('#friend-results');
    if (!q || q.trim().length < 2) { box.innerHTML = '<p class="muted tiny">Type at least 2 letters.</p>'; return; }
    box.innerHTML = '<p class="muted tiny">Searching…</p>';
    api('searchUsers', { query: q.trim() }).then(function (d) {
      var list = d.users || [];
      if (!list.length) { box.innerHTML = '<p class="muted tiny">No users found.</p>'; return; }
      box.innerHTML = list.map(function (u) {
        var right;
        if (u.relation === 'friend') right = '<span class="muted tiny">✓ Friend</span>';
        else if (u.relation === 'outgoing') right = '<span class="muted tiny">Requested</span>';
        else if (u.relation === 'incoming') right = '<button class="btn primary fr-mini" data-accept="' + esc(u.username) + '">Accept</button>';
        else right = '<button class="btn primary fr-mini" data-add="' + esc(u.username) + '">+ Add</button>';
        return '<div class="fr-row"><span class="fr-id">' + esc(u.displayName) + ' <span class="muted tiny">@' + esc(u.username) + '</span></span>' + right + '</div>';
      }).join('');
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  function addFriend(username) {
    api('addFriend', { to: username }).then(function (r) {
      toast(r.status === 'friend' ? 'You are now friends ✓' : 'Request sent ✓');
      runFriendSearch($('#friend-search').value); renderFriends();
      if (r.status === 'friend') renderFeed();
    }).catch(function (e) { toast(e.message); });
  }
  function respondFriend(username, accept) {
    api('respondFriend', { from: username, accept: accept }).then(function () {
      toast(accept ? 'Friend added ✓' : 'Request declined');
      renderFriends(); renderFeed();
      if ($('#friend-search').value) runFriendSearch($('#friend-search').value);
    }).catch(function (e) { toast(e.message); });
  }
  function removeFriend(username) {
    api('removeFriend', { username: username }).then(function () {
      toast('Removed'); renderFriends(); renderFeed();
    }).catch(function (e) { toast(e.message); });
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---------------- Settings ---------------- */
  function renderSettings() {
    $('#set-displayname').value = state.user.displayName;
    $('#set-username').textContent = state.user.username;
    $('#admin-entry').classList.toggle('hidden', !isAdmin());
    $('#fx-sound').checked = FX.sound;
    $('#fx-haptics').checked = FX.haptics;
    renderAccount();
    renderModeCard();
    renderBizSettings();
    var sd = fmt(parse(state.user.startDate));
    // Guard against a corrupted/ancient stored date (e.g. year 2000) — show today instead.
    if (sd < '2025-01-01' || sd > todayStr()) sd = todayStr();
    var inp = $('#set-startdate');
    inp.value = sd; inp.min = '2025-01-01'; inp.max = todayStr();
    prefillGoals();
    renderThemes();
  }

  /* ----- Challenge mode (quick Hard/Soft toggle; full picker in Challenges app) ----- */
  function renderModeCard() {
    var c = activeCh();
    var is75 = c.id === 'hard75' || c.id === 'soft75';
    var mode = c.pass === 'all' ? 'hard' : 'soft';
    // Show a live "current challenge" line + link to the full picker.
    var em = $('#set-ch-emoji'); if (em) em.textContent = c.emoji;
    var nm = $('#set-ch-name'); if (nm) nm.textContent = c.name;
    var link = $('#mode-current');
    if (link) link.textContent = (LEN ? 'Day ' + Math.max(1, chDay()) + ' of ' + LEN : 'Day ' + Math.max(1, chDay()) + ' · open-ended') +
      ' · ' + (c.pass === 'all' ? 'all tasks daily' : 'flexible target');
    var seg = $('#mode-seg'); if (seg) seg.classList.toggle('hidden', !is75);
    var stw = $('#soft-target-wrap'); if (stw) stw.classList.toggle('hidden', !is75 || mode !== 'soft');
    var sb = $('#save-mode'); if (sb) sb.classList.toggle('hidden', !is75);
    if (is75) {
      document.querySelectorAll('#mode-seg [data-mode]').forEach(function (b) { b.classList.toggle('active', b.dataset.mode === mode); });
      if ($('#soft-target')) $('#soft-target').value = String(softTarget());
    }
  }
  function pickMode(mode) {
    document.querySelectorAll('#mode-seg [data-mode]').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    $('#soft-target-wrap').classList.toggle('hidden', mode !== 'soft');
  }
  function saveMode() {
    var mode = $('#mode-seg [data-mode].active') ? $('#mode-seg [data-mode].active').dataset.mode : 'hard';
    var target = Number($('#soft-target').value) || 70;
    var def = chInstantiate(chPreset(mode === 'soft' ? 'soft75' : 'hard75'), chStart());
    def.water = 4000;
    if (mode === 'soft') def.pass = Math.min(100, Math.max(20, target));
    setChallenge(def, function () {
      toast(mode === 'soft' ? 'Switched to 75 Soft (' + chNeeded() + '/' + TOTAL_ITEMS + '/day) ✓' : 'Switched to 75 Hard ✓');
      renderAll();
    });
  }

  /* ----- Account: email, username, password ----- */
  function renderAccount() {
    var u = state.user || {};
    if (!document.activeElement || document.activeElement.id !== 'acct-email') $('#acct-email').value = u.email || '';
  }
  function acctEmailSave() {
    var email = $('#acct-email').value.trim();
    var btn = $('#acct-email-btn'); btn.disabled = true;
    api('updateEmail', { email: email }).then(function (d) {
      state.user = Object.assign(state.user, d.user); cacheState();
      toast(email ? 'Email saved ✓' : 'Email cleared');
    }).catch(function (e) { toast(e.message); }).then(function () { btn.disabled = false; });
  }
  function acctChangeUsername() {
    var newName = $('#acct-username').value.trim().toLowerCase();
    var pw = $('#acct-username-pw').value;
    if (newName.length < 3 || !pw) { toast('Enter a new username (3+) and your password'); return; }
    if (!confirm('Change your username to "' + newName + '"? You\'ll use it to log in from now on.')) return;
    api('changeUsername', { newUsername: newName, password: pw }).then(function (d) {
      state.token = d.token; state.username = d.user.username; state.user = Object.assign(state.user, d.user);
      localStorage.setItem('hard_token', state.token); localStorage.setItem('hard_user', state.username);
      cacheState();
      $('#acct-username').value = ''; $('#acct-username-pw').value = '';
      $('#set-username').textContent = state.user.username;
      toast('Username changed ✓'); renderAll();
    }).catch(function (e) { toast(e.message); });
  }
  function acctChangePassword() {
    var cur = $('#acct-curpw').value, next = $('#acct-newpw').value;
    if (!cur || next.length < 4) { toast('Enter current + a new password (4+ chars)'); return; }
    api('changePassword', { currentPassword: cur, newPassword: next }).then(function () {
      $('#acct-curpw').value = ''; $('#acct-newpw').value = '';
      toast('Password updated ✓');
    }).catch(function (e) { toast(e.message); });
  }

  function saveStartDate() {
    var v = $('#set-startdate').value;
    if (!v) { toast('Pick a date'); return; }
    if (v < '2025-01-01' || v > todayStr()) { toast('Pick a valid recent date (this year)'); return; }
    api('reset', { startDate: v })
      .then(function () { return loadState(); }) // re-read to confirm it persisted
      .then(function () {
        renderAll(); renderSettings();
        toast('Start date saved ✓ — Day ' + Math.max(1, state.user.currentDay));
      })
      .catch(function (e) { toast(e.message); });
  }
  function saveProfile() {
    var name = $('#set-displayname').value.trim();
    if (!name) return;
    api('updateProfile', { displayName: name }).then(function (data) {
      state.user = data.user; cacheState(); renderAll(); toast('Name saved');
    }).catch(function (e) { toast(e.message); });
  }
  function resetChallenge() {
    if (!confirm('Restart from Day 1? Your start date moves to today. This is what 75 Hard requires after a miss.')) return;
    api('reset', { startDate: todayStr() }).then(function (data) {
      state.user = data.user; state.logs = data.logs || [];
      state.today = emptyDay(todayStr()); cacheState();
      renderAll(); switchView('today'); toast('Fresh start — Day 1. Go.');
    }).catch(function (e) { toast(e.message); });
  }
  function deleteAccount() {
    var pw = $('#del-password').value;
    if (!pw) { toast('Enter your password to confirm'); return; }
    if (!confirm('Delete your account and ALL your data permanently? This cannot be undone.')) return;
    api('deleteAccount', { password: pw }).then(function () {
      localStorage.removeItem('hard_token');
      localStorage.removeItem('hard_user');
      localStorage.removeItem('hard_cache');
      alert('Your account has been deleted. Take care! 👋');
      location.reload();
    }).catch(function (e) { toast(e.message); });
  }

  function logout() {
    localStorage.removeItem('hard_token');
    localStorage.removeItem('hard_user');
    localStorage.removeItem('hard_cache');
    state.token = ''; state.username = ''; state.user = null; state.logs = [];
    location.reload();
  }

  /* ---------------- Diet & calories ---------------- */
  // Per 100 g unless the item is naturally counted per piece (then grams = avg weight).
  var COMMON_FOODS = [
    // Grains & breads
    { name: 'White rice (cooked)', kcal: 130, p: 2.7, c: 28, f: 0.3, s: 0.1, fb: 0.4, serving: 150 },
    { name: 'Brown rice (cooked)', kcal: 123, p: 2.7, c: 26, f: 1, s: 0.4, fb: 1.8, serving: 150 },
    { name: 'Roti / Chapati', kcal: 297, p: 11, c: 50, f: 7, s: 1.5, fb: 4.9, serving: 40 },
    { name: 'Paratha (plain)', kcal: 320, p: 6, c: 40, f: 14, s: 1.5, fb: 4, serving: 60 },
    { name: 'Aloo paratha', kcal: 280, p: 5, c: 38, f: 11, s: 2, fb: 3, serving: 100 },
    { name: 'Naan', kcal: 310, p: 9, c: 50, f: 8, s: 3, fb: 2.2, serving: 90 },
    { name: 'Bread (white slice)', kcal: 265, p: 9, c: 49, f: 3.2, s: 5, fb: 2.7, serving: 30 },
    { name: 'Brown bread (slice)', kcal: 247, p: 13, c: 41, f: 4, s: 4, fb: 7, serving: 30 },
    { name: 'Oats (dry)', kcal: 389, p: 17, c: 66, f: 7, s: 1, fb: 10, serving: 40 },
    { name: 'Poha (cooked)', kcal: 130, p: 2.5, c: 27, f: 1.5, s: 1, fb: 1, serving: 150 },
    { name: 'Upma', kcal: 145, p: 3, c: 24, f: 4, s: 1, fb: 1.5, serving: 150 },
    { name: 'Idli', kcal: 130, p: 4, c: 25, f: 0.8, s: 0.5, fb: 1, serving: 80 },
    { name: 'Dosa (plain)', kcal: 168, p: 3.9, c: 30, f: 3.7, s: 1, fb: 1.5, serving: 80 },
    // Noodles / pasta / wraps
    { name: 'Pasta (cooked)', kcal: 131, p: 5, c: 25, f: 1.1, s: 0.6, fb: 1.8, serving: 150 },
    { name: 'Hakka noodles (cooked)', kcal: 138, p: 4, c: 25, f: 2, s: 1, fb: 1.8, serving: 150 },
    { name: 'Rice vermicelli (cooked)', kcal: 109, p: 1.8, c: 24, f: 0.2, s: 0, fb: 0.9, serving: 150 },
    { name: 'Shirataki noodles (cooked)', kcal: 10, p: 0.2, c: 3, f: 0, s: 0, fb: 3, serving: 100 },
    { name: 'Rice paper / spring roll wrapper', kcal: 330, p: 0.9, c: 81, f: 0.2, s: 0.5, fb: 1.6, serving: 10 },
    // Dals, legumes, soy
    { name: 'Dal (cooked)', kcal: 116, p: 7, c: 17, f: 1.5, s: 1, fb: 4, serving: 150 },
    { name: 'Dal makhani', kcal: 230, p: 9, c: 20, f: 13, s: 3, fb: 5, serving: 150 },
    { name: 'Rajma (cooked)', kcal: 127, p: 8.7, c: 22, f: 0.5, s: 0.6, fb: 6.4, serving: 150 },
    { name: 'Chole / chana masala', kcal: 180, p: 8, c: 22, f: 7, s: 3, fb: 6, serving: 150 },
    { name: 'Boiled chana', kcal: 164, p: 8.9, c: 27, f: 2.6, s: 5, fb: 7.6, serving: 100 },
    { name: 'Tofu', kcal: 76, p: 8, c: 1.9, f: 4.8, s: 0.6, fb: 0.9, serving: 100 },
    { name: 'Soya chunks (dry)', kcal: 345, p: 52, c: 33, f: 0.5, s: 9, fb: 13, serving: 30 },
    // Dairy & fats
    { name: 'Milk (full fat)', kcal: 61, p: 3.2, c: 4.8, f: 3.3, s: 5, fb: 0, serving: 200 },
    { name: 'Milk (toned)', kcal: 47, p: 3.1, c: 4.7, f: 1.5, s: 5, fb: 0, serving: 200 },
    { name: 'Curd / Yogurt', kcal: 98, p: 11, c: 3.4, f: 4.3, s: 4.7, fb: 0, serving: 150 },
    { name: 'Greek yogurt', kcal: 97, p: 9, c: 4, f: 5, s: 4, fb: 0, serving: 150 },
    { name: 'Buttermilk', kcal: 40, p: 3.3, c: 4.8, f: 0.9, s: 4.8, fb: 0, serving: 200 },
    { name: 'Paneer', kcal: 296, p: 18, c: 4, f: 22, s: 1.2, fb: 0, serving: 50 },
    { name: 'Cheddar cheese', kcal: 402, p: 25, c: 1.3, f: 33, s: 0.5, fb: 0, serving: 30 },
    { name: 'Mozzarella', kcal: 280, p: 28, c: 3.1, f: 17, s: 1, fb: 0, serving: 30 },
    { name: 'Fresh cream', kcal: 292, p: 2.1, c: 3, f: 30, s: 3, fb: 0, serving: 30 },
    { name: 'Butter', kcal: 717, p: 0.9, c: 0.1, f: 81, s: 0.1, fb: 0, serving: 10 },
    { name: 'Ghee', kcal: 900, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Coconut oil', kcal: 862, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Mustard oil', kcal: 884, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Olive oil', kcal: 884, p: 0, c: 0, f: 100, s: 0, fb: 0, serving: 10 },
    { name: 'Peanut butter', kcal: 588, p: 25, c: 20, f: 50, s: 9, fb: 6, serving: 20 },
    // Proteins
    { name: 'Egg (whole)', kcal: 155, p: 13, c: 1.1, f: 11, s: 1.1, fb: 0, serving: 50 },
    { name: 'Egg white', kcal: 52, p: 11, c: 0.7, f: 0.2, s: 0.7, fb: 0, serving: 33 },
    { name: 'Chicken breast (cooked)', kcal: 165, p: 31, c: 0, f: 3.6, s: 0, fb: 0, serving: 120 },
    { name: 'Chicken curry', kcal: 180, p: 14, c: 6, f: 11, s: 3, fb: 1, serving: 200 },
    { name: 'Butter chicken', kcal: 240, p: 14, c: 8, f: 16, s: 4, fb: 1, serving: 200 },
    { name: 'Fish (cooked)', kcal: 206, p: 22, c: 0, f: 12, s: 0, fb: 0, serving: 120 },
    { name: 'Mutton (cooked)', kcal: 258, p: 25, c: 0, f: 17, s: 0, fb: 0, serving: 120 },
    { name: 'Whey protein (scoop)', kcal: 400, p: 80, c: 8, f: 6, s: 6, fb: 0, serving: 30 },
    // Veg, fruit
    { name: 'Mixed vegetables', kcal: 65, p: 2.6, c: 13, f: 0.4, s: 5, fb: 4, serving: 150 },
    { name: 'Mixed veg sabzi', kcal: 110, p: 3, c: 12, f: 6, s: 4, fb: 4, serving: 150 },
    { name: 'Palak paneer', kcal: 180, p: 8, c: 8, f: 13, s: 3, fb: 3, serving: 150 },
    { name: 'Potato (boiled)', kcal: 87, p: 1.9, c: 20, f: 0.1, s: 0.8, fb: 1.8, serving: 150 },
    { name: 'Spinach (cooked)', kcal: 23, p: 2.9, c: 3.6, f: 0.4, s: 0.4, fb: 2.4, serving: 100 },
    { name: 'Cucumber', kcal: 15, p: 0.7, c: 3.6, f: 0.1, s: 1.7, fb: 0.5, serving: 100 },
    { name: 'Tomato', kcal: 18, p: 0.9, c: 3.9, f: 0.2, s: 2.6, fb: 1.2, serving: 100 },
    { name: 'Banana', kcal: 89, p: 1.1, c: 23, f: 0.3, s: 12, fb: 2.6, serving: 120 },
    { name: 'Apple', kcal: 52, p: 0.3, c: 14, f: 0.2, s: 10, fb: 2.4, serving: 180 },
    { name: 'Mango', kcal: 60, p: 0.8, c: 15, f: 0.4, s: 14, fb: 1.6, serving: 150 },
    // Fruits
    { name: 'Pineapple', kcal: 50, p: 0.5, c: 13, f: 0.1, s: 10, fb: 1.4, serving: 165 },
    { name: 'Guava (Amrood)', kcal: 68, p: 2.6, c: 14, f: 1, s: 9, fb: 5.4, serving: 100 },
    { name: 'Orange', kcal: 47, p: 0.9, c: 12, f: 0.1, s: 9, fb: 2.4, serving: 130 },
    { name: 'Sweet lime (Mosambi)', kcal: 43, p: 0.8, c: 9.3, f: 0.3, s: 8, fb: 2, serving: 130 },
    { name: 'Grapes', kcal: 69, p: 0.7, c: 18, f: 0.2, s: 16, fb: 0.9, serving: 100 },
    { name: 'Watermelon', kcal: 30, p: 0.6, c: 8, f: 0.2, s: 6, fb: 0.4, serving: 150 },
    { name: 'Muskmelon (Cantaloupe)', kcal: 34, p: 0.8, c: 8, f: 0.2, s: 8, fb: 0.9, serving: 150 },
    { name: 'Papaya', kcal: 43, p: 0.5, c: 11, f: 0.3, s: 8, fb: 1.7, serving: 140 },
    { name: 'Pomegranate (Anar)', kcal: 83, p: 1.7, c: 19, f: 1.2, s: 14, fb: 4, serving: 100 },
    { name: 'Pear', kcal: 57, p: 0.4, c: 15, f: 0.1, s: 10, fb: 3.1, serving: 150 },
    { name: 'Peach', kcal: 39, p: 0.9, c: 10, f: 0.3, s: 8, fb: 1.5, serving: 150 },
    { name: 'Plum', kcal: 46, p: 0.7, c: 11, f: 0.3, s: 10, fb: 1.4, serving: 65 },
    { name: 'Kiwi', kcal: 61, p: 1.1, c: 15, f: 0.5, s: 9, fb: 3, serving: 75 },
    { name: 'Strawberry', kcal: 32, p: 0.7, c: 8, f: 0.3, s: 5, fb: 2, serving: 100 },
    { name: 'Litchi (Lychee)', kcal: 66, p: 0.8, c: 17, f: 0.4, s: 15, fb: 1.3, serving: 100 },
    { name: 'Sapota (Chikoo)', kcal: 83, p: 0.4, c: 20, f: 1.1, s: 15, fb: 5.3, serving: 100 },
    { name: 'Custard apple (Sitaphal)', kcal: 94, p: 2.1, c: 24, f: 0.3, s: 19, fb: 4.4, serving: 100 },
    { name: 'Jackfruit', kcal: 95, p: 1.7, c: 23, f: 0.6, s: 19, fb: 1.5, serving: 100 },
    { name: 'Fig (Anjeer, fresh)', kcal: 74, p: 0.8, c: 19, f: 0.3, s: 16, fb: 2.9, serving: 50 },
    { name: 'Amla (Indian gooseberry)', kcal: 44, p: 0.9, c: 10, f: 0.6, s: 6, fb: 3.4, serving: 50 },
    { name: 'Dates (Khajoor)', kcal: 277, p: 1.8, c: 75, f: 0.2, s: 66, fb: 6.7, serving: 24 },
    { name: 'Coconut (fresh)', kcal: 354, p: 3.3, c: 15, f: 33, s: 6, fb: 9, serving: 50 },
    { name: 'Avocado', kcal: 160, p: 2, c: 9, f: 15, s: 0.7, fb: 6.7, serving: 100 },
    { name: 'Blueberries', kcal: 57, p: 0.7, c: 14, f: 0.3, s: 10, fb: 2.4, serving: 100 },
    // Nuts
    { name: 'Almonds', kcal: 579, p: 21, c: 22, f: 50, s: 4, fb: 12.5, serving: 28 },
    { name: 'Peanuts', kcal: 567, p: 26, c: 16, f: 49, s: 4, fb: 8.5, serving: 30 },
    { name: 'Cashews', kcal: 553, p: 18, c: 30, f: 44, s: 6, fb: 3.3, serving: 30 },
    { name: 'Walnuts', kcal: 654, p: 15, c: 14, f: 65, s: 2.6, fb: 6.7, serving: 30 },
    { name: 'Pistachios', kcal: 562, p: 20, c: 28, f: 45, s: 8, fb: 10, serving: 30 },
    { name: 'Hazelnuts', kcal: 628, p: 15, c: 17, f: 61, s: 4.3, fb: 9.7, serving: 28 },
    // Dry fruits & seeds
    { name: 'Raisins (Kishmish)', kcal: 299, p: 3.1, c: 79, f: 0.5, s: 59, fb: 3.7, serving: 30 },
    { name: 'Dried apricots (Khubani)', kcal: 241, p: 3.4, c: 63, f: 0.5, s: 53, fb: 7.3, serving: 30 },
    { name: 'Prunes (dried plums)', kcal: 240, p: 2.2, c: 64, f: 0.4, s: 38, fb: 7, serving: 30 },
    { name: 'Dried figs (Anjeer)', kcal: 249, p: 3.3, c: 64, f: 0.9, s: 48, fb: 9.8, serving: 30 },
    { name: 'Pumpkin seeds', kcal: 559, p: 30, c: 11, f: 49, s: 1, fb: 6, serving: 28 },
    { name: 'Sunflower seeds', kcal: 584, p: 21, c: 20, f: 51, s: 2.6, fb: 8.6, serving: 28 },
    { name: 'Chia seeds', kcal: 486, p: 17, c: 42, f: 31, s: 0, fb: 34, serving: 15 },
    { name: 'Flax seeds (Alsi)', kcal: 534, p: 18, c: 29, f: 42, s: 1.5, fb: 27, serving: 15 },
    // Vegetables (raw unless noted)
    { name: 'Broccoli', kcal: 34, p: 2.8, c: 7, f: 0.4, s: 1.7, fb: 2.6, serving: 100 },
    { name: 'Cauliflower (Gobi)', kcal: 25, p: 1.9, c: 5, f: 0.3, s: 1.9, fb: 2, serving: 100 },
    { name: 'Cabbage (Patta gobi)', kcal: 25, p: 1.3, c: 6, f: 0.1, s: 3.2, fb: 2.5, serving: 100 },
    { name: 'Capsicum / Bell pepper', kcal: 31, p: 1, c: 6, f: 0.3, s: 4.2, fb: 2.1, serving: 100 },
    { name: 'French beans', kcal: 31, p: 1.8, c: 7, f: 0.2, s: 3.3, fb: 3.4, serving: 100 },
    { name: 'Okra (Bhindi)', kcal: 33, p: 1.9, c: 7, f: 0.2, s: 1.5, fb: 3.2, serving: 100 },
    { name: 'Carrot', kcal: 41, p: 0.9, c: 10, f: 0.2, s: 4.7, fb: 2.8, serving: 100 },
    { name: 'Onion', kcal: 40, p: 1.1, c: 9, f: 0.1, s: 4.2, fb: 1.7, serving: 100 },
    { name: 'Green peas', kcal: 81, p: 5.4, c: 14, f: 0.4, s: 6, fb: 5.5, serving: 100 },
    { name: 'Brinjal / Eggplant (Baingan)', kcal: 25, p: 1, c: 6, f: 0.2, s: 3.5, fb: 3, serving: 100 },
    { name: 'Bottle gourd (Lauki)', kcal: 14, p: 0.6, c: 3.4, f: 0, s: 1.4, fb: 1.2, serving: 100 },
    { name: 'Bitter gourd (Karela)', kcal: 17, p: 1, c: 3.7, f: 0.2, s: 0, fb: 2.8, serving: 100 },
    { name: 'Pumpkin (Kaddu)', kcal: 26, p: 1, c: 7, f: 0.1, s: 2.8, fb: 0.5, serving: 100 },
    { name: 'Beetroot', kcal: 43, p: 1.6, c: 10, f: 0.2, s: 7, fb: 2.8, serving: 100 },
    { name: 'Sweet potato (Shakarkandi)', kcal: 86, p: 1.6, c: 20, f: 0.1, s: 4.2, fb: 3, serving: 100 },
    { name: 'Mushroom', kcal: 22, p: 3.1, c: 3.3, f: 0.3, s: 2, fb: 1, serving: 100 },
    { name: 'Sweet corn', kcal: 86, p: 3.2, c: 19, f: 1.2, s: 6.3, fb: 2.7, serving: 100 },
    { name: 'Radish (Mooli)', kcal: 16, p: 0.7, c: 3.4, f: 0.1, s: 1.9, fb: 1.6, serving: 100 },
    // Raw meat & seafood (per 100 g, uncooked)
    { name: 'Chicken breast (raw, skinless)', kcal: 120, p: 22.5, c: 0, f: 2.6, s: 0, fb: 0, serving: 100 },
    { name: 'Chicken thigh (raw, skinless)', kcal: 121, p: 19.7, c: 0, f: 4.3, s: 0, fb: 0, serving: 100 },
    { name: 'Chicken (whole, raw, with skin)', kcal: 215, p: 18, c: 0, f: 15, s: 0, fb: 0, serving: 100 },
    { name: 'Mutton / Goat (raw)', kcal: 109, p: 20.6, c: 0, f: 2.3, s: 0, fb: 0, serving: 100 },
    { name: 'Lamb (raw)', kcal: 294, p: 25, c: 0, f: 21, s: 0, fb: 0, serving: 100 },
    { name: 'Pork (raw)', kcal: 242, p: 27, c: 0, f: 14, s: 0, fb: 0, serving: 100 },
    { name: 'Pork (lean, raw)', kcal: 143, p: 21, c: 0, f: 6, s: 0, fb: 0, serving: 100 },
    { name: 'Beef (raw)', kcal: 250, p: 26, c: 0, f: 15, s: 0, fb: 0, serving: 100 },
    { name: 'Fish (raw, white)', kcal: 96, p: 20, c: 0, f: 1.5, s: 0, fb: 0, serving: 100 },
    { name: 'Rohu fish (raw)', kcal: 97, p: 16.6, c: 0, f: 1.4, s: 0, fb: 0, serving: 100 },
    { name: 'Salmon (raw)', kcal: 208, p: 20, c: 0, f: 13, s: 0, fb: 0, serving: 100 },
    { name: 'Prawns / Shrimp (raw)', kcal: 99, p: 24, c: 0.2, f: 0.3, s: 0, fb: 0, serving: 100 },
    { name: 'Egg (raw, whole)', kcal: 143, p: 12.6, c: 0.7, f: 9.5, s: 0.4, fb: 0, serving: 50 },
    // Snacks, sweets, drinks
    { name: 'Samosa', kcal: 308, p: 5, c: 32, f: 18, s: 2, fb: 3, serving: 50 },
    { name: 'Veg biryani', kcal: 180, p: 4, c: 28, f: 6, s: 2, fb: 2, serving: 200 },
    { name: 'Chicken biryani', kcal: 200, p: 9, c: 26, f: 7, s: 2, fb: 1.5, serving: 200 },
    { name: 'Curd rice', kcal: 150, p: 4, c: 22, f: 5, s: 3, fb: 0.5, serving: 200 },
    { name: 'Dark chocolate', kcal: 546, p: 4.9, c: 61, f: 31, s: 48, fb: 7, serving: 20 },
    { name: 'Honey', kcal: 304, p: 0.3, c: 82, f: 0, s: 82, fb: 0.2, serving: 20 },
    { name: 'Jaggery', kcal: 383, p: 0.4, c: 98, f: 0.1, s: 97, fb: 0, serving: 10 },
    { name: 'Sugar', kcal: 387, p: 0, c: 100, f: 0, s: 100, fb: 0, serving: 5 },
    { name: 'Tea with milk & sugar', kcal: 40, p: 1, c: 6, f: 1, s: 5, fb: 0, serving: 150 },
    { name: 'Black coffee (no sugar)', kcal: 1, p: 0.1, c: 0, f: 0, s: 0, fb: 0, serving: 240 },
    { name: 'Cola / soft drink', kcal: 42, p: 0, c: 10.6, f: 0, s: 10.6, fb: 0, serving: 330 },
    { name: 'Orange juice', kcal: 45, p: 0.7, c: 10, f: 0.2, s: 8, fb: 0.2, serving: 200 }
  ];

  // Bundled Indian dish database. Source values are per serving; we estimate a
  // serving weight so every dish also has per-100g values (supports both units).
  function round1(v) { return Math.round((Number(v) || 0) * 10) / 10; }
  function estServingGrams(name) {
    var n = name.toLowerCase();
    if (/tea|coffee|chai|juice|lassi|shake|panna|sharbat|drink|smoothie|milk|buttermilk|chaas|soup|rasam|water/.test(n)) return 200;
    if (/rice|biryani|biriyani|pulao|pulav|khichdi|khichri/.test(n)) return 200;
    if (/idli/.test(n)) return 80;
    if (/roti|chapati|chapathi|paratha|parantha|naan|dosa|thepla|puri|poori|bhatura|kulcha|appam|uttapam/.test(n)) return 60;
    if (/samosa|pakora|pakoda|tikki|vada|bonda|cutlet|spring roll|\broll\b|kebab|kabab|tikka|momo/.test(n)) return 60;
    if (/halwa|kheer|barfi|burfi|laddu|ladoo|jalebi|gulab|rasgulla|rasmalai|sweet|dessert|ice cream|custard|payasam/.test(n)) return 100;
    if (/salad|raita|chutney|pickle|achar|papad/.test(n)) return 100;
    if (/dal|daal|sabzi|sabji|curry|paneer|gravy|kofta|korma|masala|bhaji|rajma|chole|chana|sambar|kadhi/.test(n)) return 150;
    return 150;
  }
  var INDIAN_POOL = (window.INDIAN_FOODS || []).map(function (a) {
    var sg = estServingGrams(a[0]);
    var k = 100 / sg;
    return { name: a[0], kcal: Math.round(a[1] * k), c: round1(a[2] * k), p: round1(a[3] * k), f: round1(a[4] * k), s: round1(a[5] * k), fb: 0, serving: sg };
  });

  function dietGoals() {
    var p = state.profile || {};
    return {
      cal: Number(p.calorieGoal) || 0,
      protein: Number(p.proteinGoal) || 0,
      carbs: Number(p.carbGoal) || 0,
      fat: Number(p.fatGoal) || 0,
      sugar: Number(p.sugarGoal) || 0,
      fiber: Number(p.fiberGoal) || 0
    };
  }

  function loadFoods(date) {
    return api('getFood', { date: date }).then(function (data) {
      state.foods = data.foods || [];
      state.foodsDate = date;
    });
  }

  /* ----- Diet Week/Month averages ----- */
  function dietWeekRange(dateStr) {
    var dow = (parse(dateStr).getDay() + 6) % 7; // 0 = Monday
    var from = addDays(dateStr, -dow);
    return { from: from, to: addDays(from, 6) };
  }
  function dietRangeFor(mode, anchor) {
    if (mode === 'month') { var ym = ymOf(anchor); return { from: ym + '-01', to: ym + '-' + pad(daysInYm(ym)) }; }
    return dietWeekRange(anchor);
  }
  function dietRangeLabel(mode, anchor) {
    if (mode === 'month') return ymLabel(ymOf(anchor));
    var r = dietWeekRange(anchor);
    var af = parse(r.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var bf = parse(r.to).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return af + ' – ' + bf;
  }
  if (!state.dietRangeCache) state.dietRangeCache = {};
  function loadFoodRange(from, to) {
    var key = from + '_' + to;
    if (state.dietRangeCache[key]) return Promise.resolve(state.dietRangeCache[key]);
    return api('getFoodRange', { from: from, to: to }).then(function (data) {
      state.dietRangeCache[key] = data;
      return data;
    });
  }
  function dietRangeChart(range) {
    var byDate = {}; (range.perDay || []).forEach(function (d) { byDate[d.date] = d.cal; });
    var perDay = [], d = range.from;
    while (d <= range.to) { perDay.push({ date: d, v: byDate[d] || 0 }); d = addDays(d, 1); }
    var goal = dietGoals().cal;
    return rangeBarChart(perDay, 'var(--primary)', ' kcal', 0, goal > 0 ? { v: goal } : null);
  }

  function renderDiet() {
    if (!state.dietDate) state.dietDate = todayStr();
    if (!state.dietMode) state.dietMode = 'day';
    var mode = state.dietMode, date = state.dietDate;

    document.querySelectorAll('#diet-mode [data-mode]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === mode);
    });
    $('#diet-range-extra').classList.toggle('hidden', mode === 'day');
    $('#meals').classList.toggle('hidden', mode !== 'day');
    $('#diet-date').classList.toggle('hidden', mode !== 'day');

    if (mode === 'day') {
      var di = $('#diet-date');
      if (di) { di.value = date; di.max = todayStr(); }
      var lbl = $('#diet-date-label');
      if (lbl) { lbl.classList.remove('hidden'); lbl.textContent = (date === todayStr()) ? 'Today' : prettyDate(date); }
      if (state.foodsDate !== date) {
        $('#meals').innerHTML = '<p class="muted tiny center">Loading…</p>';
        loadFoods(date).then(renderDietBody).catch(function (e) {
          $('#meals').innerHTML = '<p class="muted tiny center">' + esc(e.message) + '</p>';
        });
      } else renderDietBody();
      return;
    }

    // Week / Month averages
    var lbl2 = $('#diet-date-label');
    if (lbl2) { lbl2.classList.remove('hidden'); lbl2.textContent = dietRangeLabel(mode, date); }
    var r = dietRangeFor(mode, date);
    $('#cal-eaten').textContent = '…';
    loadFoodRange(r.from, r.to).then(function (range) {
      renderDietRangeBody(mode, range);
    }).catch(function (e) { toast(e.message); });
  }
  function renderDietRangeBody(mode, range) {
    var g = dietGoals();
    var a = range.avg || {};
    $('#cal-eaten').textContent = a.cal || 0;
    $('#cal-goal').textContent = g.cal ? g.cal : '—';
    var totalDays = mode === 'month' ? daysInYm(ymOf(range.from)) : 7;
    var loggedDays = range.daysLogged || 0;
    var cutTo = range.to < todayStr() ? range.to : todayStr();
    var elapsedDays = Math.min(totalDays, Math.max(1,
      Math.round((parse(cutTo) - parse(range.from)) / 86400000) + 1));
    $('#cal-sub').textContent = 'avg/day · ' + loggedDays + ' of ' + elapsedDays + ' day' + (elapsedDays === 1 ? '' : 's') + ' logged';

    var ring =$('#cal-ring');
    var circ = 2 * Math.PI * 34;
    var frac = g.cal ? Math.min(1, a.cal / g.cal) : 0;
    ring.style.strokeDashoffset = circ * (1 - frac);
    ring.style.stroke = (g.cal && a.cal > g.cal) ? 'var(--red)' : '#2fd47a';

    var bars = $('#macro-bars'); bars.innerHTML = '';
    [['p', 'Protein (avg)', a.p, g.protein], ['c', 'Carbs (avg)', a.c, g.carbs],
     ['f', 'Fat (avg)', a.f, g.fat], ['s', 'Sugar (avg)', a.s, g.sugar], ['fb', 'Fibre (avg)', a.fb, g.fiber]].forEach(function (m) {
      var over = m[0] !== 'fb' && m[3] && m[2] > m[3];
      var pct = m[3] ? Math.min(100, Math.round((m[2] / m[3]) * 100)) : 0;
      var row = el('div', 'macro ' + m[0] + (over ? ' over' : ''));
      var goalTxt = m[3] ? ' / ' + m[3] + 'g' + (m[0] === 's' ? ' max' : (m[0] === 'fb' ? ' goal' : '')) : '';
      row.innerHTML = '<div class="ml"><span>' + m[1] + '</span><span><b>' + Math.round(m[2] || 0) + 'g</b>' + goalTxt + '</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>';
      bars.appendChild(row);
    });
    $('#goal-hint').classList.toggle('hidden', !!g.cal);
    $('#diet-range-chart').innerHTML = dietRangeChart(range) +
      '<p class="muted tiny" style="margin-top:8px">Total this ' + mode + ': <b>' + (range.total ? Math.round(range.total.cal) : 0) + ' kcal</b> across ' + (range.daysLogged || 0) + ' logged day' + ((range.daysLogged || 0) === 1 ? '' : 's') + '.</p>';
  }
  function setDietDate(date) {
    if (date > todayStr()) return;
    state.dietDate = date;
    renderDiet();
  }
  function setDietMode(mode) {
    state.dietMode = mode;
    renderDiet();
  }
  function shiftDietRange(dir) {
    var mode = state.dietMode || 'day';
    if (mode === 'day') { setDietDate(addDays(state.dietDate || todayStr(), dir)); return; }
    if (mode === 'week') {
      var n = addDays(state.dietDate || todayStr(), dir * 7);
      if (n > todayStr() && dir > 0) return;
      state.dietDate = n; renderDiet(); return;
    }
    // month
    var ny = ymShift(ymOf(state.dietDate || todayStr()), dir);
    if (ny > ymOf(todayStr()) && dir > 0) return;
    // Landing back on the current month restores today as the anchor date
    // (so switching to Day mode afterwards shows today, not the 1st).
    state.dietDate = (ny === ymOf(todayStr())) ? todayStr() : ny + '-01';
    renderDiet();
  }

  /* ----- Intermittent fasting ----- */
  // Milestones (hours). The "mark" you earn is the highest one you reach.
  // Every hour from 12h to 24h (so 17/19/21h fasts get their own mark), then long-haul marks.
  var MILESTONES = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 36, 48];

  function stopFastTimer() { if (state.fastTimer) { clearInterval(state.fastTimer); state.fastTimer = null; } }

  function fmtDur(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(sec);
  }
  function durLabel(ms) {
    if (ms < 0) ms = 0;
    var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h + 'h ' + m + 'm';
  }
  function clockTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function milestoneInfo(hours) {
    var reached = 0, next = null;
    for (var i = 0; i < MILESTONES.length; i++) {
      if (hours >= MILESTONES[i]) reached = MILESTONES[i];
      else { next = MILESTONES[i]; break; }
    }
    return { reached: reached, next: next };
  }
  // datetime-local <-> ISO helpers (local time)
  function toLocalInput(iso) {
    var x = new Date(iso);
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate()) +
      'T' + pad(x.getHours()) + ':' + pad(x.getMinutes());
  }
  function fromLocalInput(v) { return new Date(v).toISOString(); }

  // The fast calendar "dates box" — shown whether or not a fast is currently
  // running (populated by loadFastCalendar via its element ids). The calendar
  // is the single source of truth for past fasts; tapping a day opens an
  // inline edit/delete form right here instead of a separate list.
  function fastCalHtml() {
    return '<div class="card">' +
      '<div class="cal-nav" style="margin-bottom:8px">' +
        '<button id="fc-prev" class="icon-btn" type="button">‹</button>' +
        '<div id="fc-label" class="cal-month-label"></div>' +
        '<button id="fc-next" class="icon-btn" type="button">›</button>' +
      '</div>' +
      '<div id="fast-cal" class="calendar-grid month"></div>' +
      '<div class="gt-legend" style="margin-top:10px">' +
        '<span class="gt-key"><i style="background:var(--green)"></i>18h+</span>' +
        '<span class="gt-key"><i style="background:#38bdf8"></i>16–18h</span>' +
        '<span class="gt-key"><i style="background:var(--amber)"></i>14–16h</span>' +
        '<span class="gt-key"><i style="background:#8da3c4"></i>under 14h</span>' +
      '</div>' +
      '<p class="muted tiny" style="margin:8px 0 0">Tap a fast to edit it · tap an empty day to log one.</p>' +
      '<div id="fast-day-edit" class="fh-edit-form hidden"></div>' +
    '</div>';
  }
  function renderFasting() {
    stopFastTimer();
    var box = $('#fasting');
    if (!box) return;
    var f = state.activeFast;

    if (f) {
      box.innerHTML =
        '<div class="card fast-card active">' +
          '<div class="fast-head"><span class="fast-title">⏳ Fasting</span>' +
            '<span id="fast-mark" class="fast-mark">—</span></div>' +
          '<div class="fast-ring-wrap">' +
            '<svg viewBox="0 0 120 120" class="ring"><circle class="ring-bg" cx="60" cy="60" r="52"></circle>' +
            '<circle id="fast-ring" class="ring-fg" cx="60" cy="60" r="52"></circle></svg>' +
            '<div class="fast-center"><div id="fast-elapsed" class="fast-elapsed">00:00:00</div>' +
            '<div id="fast-state" class="muted tiny">elapsed</div></div>' +
          '</div>' +
          '<div class="fast-chips">' + [12, 14, 16, 18, 20, 24].map(function (h) {
            return '<span class="fast-chip" data-fm="' + h + '">' + h + 'h</span>';
          }).join('') + '</div>' +
          '<div class="fast-times"><span>Started <b id="fast-started">' + clockTime(f.startAt) + '</b></span>' +
            '<button id="fast-edit-start" class="link-btn">Edit start</button></div>' +
          '<div id="fast-edit-box" class="fast-edit-box hidden">' +
            '<label>Start time<input type="datetime-local" id="fast-start-edit"></label>' +
            '<div class="row-2"><button id="fast-save-start" class="btn primary">Save</button>' +
            '<button id="fast-cancel-start" class="btn">Cancel</button></div></div>' +
          '<button id="fast-end" class="btn danger block">End fast</button>' +
        '</div>' +
        fastCalHtml();   // keep the dates/history box visible during a fast too
      $('#fast-end').addEventListener('click', endFast);
      $('#fast-edit-start').addEventListener('click', function () {
        $('#fast-start-edit').value = toLocalInput(f.startAt);
        $('#fast-edit-box').classList.toggle('hidden');
      });
      $('#fast-cancel-start').addEventListener('click', function () { $('#fast-edit-box').classList.add('hidden'); });
      $('#fast-save-start').addEventListener('click', function () {
        var v = $('#fast-start-edit').value; if (!v) return;
        if (new Date(v).getTime() > Date.now()) { toast('Start time can’t be in the future'); return; }
        api('updateFast', { id: f.id, startAt: fromLocalInput(v) }).then(function (data) {
          state.activeFast = data.fast; cacheActiveFast(data.fast); renderFasting(); toast('Start time updated ✓');
        }).catch(function (e) { toast(e.message); });
      });
      updateFastTimer();
      state.fastTimer = setInterval(updateFastTimer, 1000);
      loadFastCalendar();   // populate the dates box shown below the active fast
    } else {
      box.innerHTML =
        '<div class="card fast-card">' +
          '<div class="fast-head"><span class="fast-title">⏳ Intermittent fasting</span></div>' +
          '<p class="muted tiny">Start a fast — the timer counts up and logs the milestone you reach when you end it. Adjust the start time if you began earlier.</p>' +
          '<label>Start time<input type="datetime-local" id="fast-start-input"></label>' +
          '<button id="fast-start" class="btn primary block">Start fast</button>' +
          '<button id="fast-manual-toggle" class="link-btn" style="margin-top:8px">＋ Log a past fast</button>' +
          '<div id="fast-manual" class="fast-edit-box hidden">' +
            '<label class="tiny">Start<input type="datetime-local" id="fm-start"></label>' +
            '<label class="tiny">End<input type="datetime-local" id="fm-end"></label>' +
            '<div class="row-2"><button id="fm-save" class="btn primary">Save fast</button>' +
            '<button id="fm-cancel" class="btn">Cancel</button></div></div>' +
        '</div>' +
        fastCalHtml();
      $('#fast-start-input').value = toLocalInput(new Date().toISOString());
      $('#fast-start').addEventListener('click', function () {
        var v = $('#fast-start-input').value;
        if (v && new Date(v).getTime() > Date.now()) { toast('Start time can’t be in the future'); return; }
        startFast(v ? fromLocalInput(v) : new Date().toISOString());
      });
      $('#fast-manual-toggle').addEventListener('click', function () { fastManualOpen(); });
      $('#fm-cancel').addEventListener('click', function () { $('#fast-manual').classList.add('hidden'); });
      $('#fm-save').addEventListener('click', saveManualFast);
      loadFastCalendar();
    }
  }

  // Prefill + open the manual past-fast form (dateStr optional: 8pm that day → noon next).
  function fastManualOpen(dateStr) {
    var fm = $('#fast-manual'); if (!fm) return;
    fm.classList.remove('hidden');
    if (dateStr) {
      $('#fm-start').value = dateStr + 'T20:00';
      $('#fm-end').value = addDays(dateStr, 1) + 'T12:00';
    } else if (!$('#fm-start').value) {
      var y = addDays(todayStr(), -1);
      $('#fm-start').value = y + 'T20:00';
      $('#fm-end').value = todayStr() + 'T12:00';
    }
    fm.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function saveManualFast() {
    var s = $('#fm-start').value, e = $('#fm-end').value;
    if (!s || !e) { toast('Set both times'); return; }
    var sT = new Date(s).getTime(), eT = new Date(e).getTime();
    if (eT <= sT) { toast('End must be after start'); return; }
    if (eT > Date.now()) { toast('End time can’t be in the future'); return; }
    if (eT - sT > 72 * 3600000) { toast('That’s over 72h — double-check the dates'); return; }
    var btn = $('#fm-save'); btn.disabled = true; btn.textContent = 'Saving…';
    // A dedicated action that always creates its own row — this must NEVER
    // reuse startFast+updateFast: if a real fast is currently active,
    // startFast hands back THAT fast instead of a new one, and the follow-up
    // updateFast would silently overwrite (and end) it with these past dates.
    // Also never touch state.activeFast here — logging a past fast has no
    // bearing on whether one is currently running.
    var startIso = fromLocalInput(s), endIso = fromLocalInput(e);
    var done = function () {
      var mark = milestoneInfo((eT - sT) / 3600000).reached;
      toast(mark ? 'Past fast logged — ' + mark + 'h mark 🎉' : 'Past fast logged ✓');
      renderFasting();
    };
    var fail = function (msg) { toast(msg); btn.disabled = false; btn.textContent = 'Save fast'; };
    var step = function (t) { btn.textContent = t; };
    // Each Apps Script call is a slow round-trip, so say which one is in flight
    // rather than sitting on a silent "Saving…".
    var onRetry = function (n, total) { step('Retrying ' + n + '/' + total + '…'); };
    // The old two-call fallback needs THREE round-trips including the probe.
    // Once we've learned this deployment lacks the action, skip straight to it.
    var legacy = function () {
      step('Saving (legacy)…');
      api('startFast', { startAt: startIso }, onRetry).then(function (data) {
        var f = data && data.fast;
        if (!f || f.startAt !== startIso || f.endAt) {
          fail('Update the Apps Script backend to log past fasts — a fast is already running, so it isn’t safe to log this one on the old version.');
          return;
        }
        step('Finishing…');
        api('updateFast', { id: f.id, startAt: startIso, endAt: endIso }, onRetry).then(function () {
          if (state.activeFast && state.activeFast.id === f.id) { state.activeFast = null; cacheActiveFast(null); }
          done();
        }).catch(function (e2) { fail(e2.message); });
      }).catch(function (e2) { fail(e2.message); });
    };
    if (state.noLogPastFast) { legacy(); return; }
    api('logPastFast', { startAt: startIso, endAt: endIso }, onRetry).then(done).catch(function (err) {
      if (!/unknown action/i.test(err.message || '')) { fail(err.message); return; }
      // The deployed backend predates logPastFast. Fall back to the old
      // startFast+updateFast pair — but ONLY when startFast actually hands
      // back a brand-new row. If it returns an already-running fast instead
      // (its dedup behaviour), bail out untouched: continuing is exactly the
      // bug that used to overwrite and end a real in-progress fast.
      state.noLogPastFast = true;
      legacy();
    });
  }

  // Month calendar of fasts (colored by duration tier, keyed to the START date).
  function fastTierColor(hours) {
    if (hours >= 18) return 'var(--green)';
    if (hours >= 16) return '#38bdf8';
    if (hours >= 14) return 'var(--amber)';
    return '#8da3c4';
  }
  function buildFastCal(fasts) {
    var grid = $('#fast-cal'), label = $('#fc-label');
    if (!grid || !label) return;
    var ym = state.fastCalYm || (state.fastCalYm = ymOf(todayStr()));
    label.textContent = ymLabel(ym);
    $('#fc-next').disabled = ym >= ymOf(todayStr());
    var byDate = {};
    (fasts || []).forEach(function (f) {
      var dte = fmt(parse(new Date(f.startAt)));
      var h = (new Date(f.endAt) - new Date(f.startAt)) / 3.6e6;
      if (!byDate[dte] || h > byDate[dte].h) byDate[dte] = { h: h, f: f };
    });
    grid.innerHTML = '';
    var today = todayStr();
    var p = ym.split('-'), first = new Date(+p[0], +p[1] - 1, 1), lead = (first.getDay() + 6) % 7;
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function (w) {
      var h = el('div', 'cal-dow mono'); h.textContent = w; grid.appendChild(h);
    });
    for (var b = 0; b < lead; b++) grid.appendChild(el('div', 'cal-blank'));
    var days = daysInYm(ym);
    for (var day = 1; day <= days; day++) {
      (function (date) {
        var cell = el('div', 'cal-cell');
        var hit = byDate[date];
        cell.innerHTML = '<span class="cc-num">' + Number(date.slice(8)) + '</span>' +
          '<span class="cc-date">' + (hit ? Math.floor(hit.h) + 'h' : '') + '</span>';
        if (date > today) cell.classList.add('pre');
        else {
          cell.classList.add('editable');
          if (hit) {
            var col = fastTierColor(hit.h);
            cell.style.background = 'color-mix(in srgb, ' + col + ' 30%, var(--bg-soft))';
            cell.style.borderColor = col; cell.style.color = 'var(--text)';
            cell.addEventListener('click', function () { openFastEdit(hit.f); });
          } else {
            cell.addEventListener('click', function () { fastManualOpen(date); });
          }
        }
        if (date === today) cell.classList.add('today');
        grid.appendChild(cell);
      })(ym + '-' + pad(day));
    }
  }

  function updateFastTimer() {
    var f = state.activeFast; if (!f) { stopFastTimer(); return; }
    var elapsed = Date.now() - new Date(f.startAt).getTime();
    var hours = elapsed / 3600000;
    var mi = milestoneInfo(hours);
    var elEl = $('#fast-elapsed'); if (!elEl) { stopFastTimer(); return; }
    elEl.textContent = fmtDur(elapsed);

    var ring = $('#fast-ring');
    var circ = 2 * Math.PI * 52;
    var frac = mi.next ? Math.min(1, hours / mi.next) : 1;
    if (ring) {
      ring.style.strokeDashoffset = circ * (1 - frac);
      ring.style.stroke = mi.reached >= 16 ? 'var(--green)' : 'var(--primary)';
    }
    var mark = $('#fast-mark');
    if (mark) mark.textContent = mi.reached ? mi.reached + 'h mark' : 'warming up';
    var st = $('#fast-state');
    if (st) {
      var mins = mi.next ? Math.max(0, Math.round((mi.next - hours) * 60)) : 0;
      st.textContent = mi.next ? ('next: ' + mi.next + 'h in ' + (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm')) : 'beast mode 🦾';
    }
    document.querySelectorAll('[data-fm]').forEach(function (c) {
      c.classList.toggle('hit', hours >= Number(c.getAttribute('data-fm')));
    });
  }

  // A started fast used to live ONLY in memory + whatever the server confirmed
  // — if that single request failed (even after retries) it vanished without
  // a trace, with nothing to recover on the next load. It's now also cached
  // locally the instant you tap Start, and reconciled (pushed to the server)
  // on the next successful loadState() if it never made it through.
  function fastCacheKey() { return 'hard_fast_' + (state.username || ''); }
  function cacheActiveFast(f) {
    try { if (f) localStorage.setItem(fastCacheKey(), JSON.stringify(f)); else localStorage.removeItem(fastCacheKey()); } catch (e) {}
  }
  function cachedActiveFast() {
    try { return JSON.parse(localStorage.getItem(fastCacheKey()) || 'null'); } catch (e) { return null; }
  }
  function reconcilePendingFast() {
    var cached = cachedActiveFast();
    if (cached && cached.pending && !state.activeFast) {
      // Started locally, never confirmed by the server, and the server still
      // shows nothing active — push it now instead of silently losing it.
      api('startFast', { startAt: cached.startAt }).then(function (data) {
        state.activeFast = data.fast; cacheActiveFast(data.fast);
        if (!$('#view-fast').classList.contains('hidden')) renderFasting();
      }).catch(function () {});
    } else if (state.activeFast) {
      cacheActiveFast(state.activeFast);          // keep the cache aligned with confirmed server truth
    } else if (cached) {
      cacheActiveFast(null);                      // server says nothing active and it wasn't just pending — stale, clear it
    }
  }
  function startFast(startIso) {
    // Cache immediately, before the network round-trip — a reload mid-request
    // (or a request that fails even after retries) can no longer lose this;
    // reconcilePendingFast() will push it on the next successful load.
    var optimistic = { id: 'pending', startAt: startIso, endAt: '', pending: true };
    state.activeFast = optimistic; cacheActiveFast(optimistic); renderFasting();
    api('startFast', { startAt: startIso }).then(function (data) {
      state.activeFast = data.fast; cacheActiveFast(data.fast); renderFasting(); toast('Fast started — stay strong 💪');
    }).catch(function (e) { toast('Saved locally · will sync when back online · ' + e.message); });
  }
  function endFast() {
    var f = state.activeFast; if (!f) return;
    var elapsed = Date.now() - new Date(f.startAt).getTime();
    if (!confirm('End your fast? You fasted ' + durLabel(elapsed) + '.')) return;
    api('endFast', {}).then(function (data) {
      state.activeFast = null; cacheActiveFast(null);
      var done = data.fast;
      var ms = done ? (new Date(done.endAt).getTime() - new Date(done.startAt).getTime()) : elapsed;
      var mark = milestoneInfo(ms / 3600000).reached;
      renderFasting();
      toast(mark ? ('Fast ended — ' + mark + 'h mark! 🎉') : ('Fast ended — ' + durLabel(ms)));
    }).catch(function (e) { toast(e.message); });
  }

  function loadFastCalendar() {
    api('getFasts', {}).then(function (data) {
      var all = data.fasts || [];
      buildFastCal(all);
      var fcPrev = $('#fc-prev'), fcNext = $('#fc-next');
      if (fcPrev && !fcPrev._bound) {
        fcPrev._bound = true;
        fcPrev.addEventListener('click', function () { state.fastCalYm = ymShift(state.fastCalYm, -1); buildFastCal(all); });
        fcNext.addEventListener('click', function () { state.fastCalYm = ymShift(state.fastCalYm, 1); buildFastCal(all); });
      }
    }).catch(function () {});
  }

  // Inline edit/delete for a past fast, opened by tapping its day on the
  // calendar — the calendar is now the only place past fasts are browsed.
  function openFastEdit(f) {
    var box = $('#fast-day-edit'); if (!box) return;
    var dur = new Date(f.endAt).getTime() - new Date(f.startAt).getTime();
    var mark = milestoneInfo(dur / 3600000).reached;
    box.classList.remove('hidden');
    box.innerHTML =
      '<div class="fh-row"><span class="fh-date">' + new Date(f.startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + '</span>' +
        '<span class="fh-dur">' + durLabel(dur) + '</span>' +
        '<span class="fh-mark">' + (mark ? mark + 'h mark' : '—') + '</span></div>' +
      '<label class="tiny">Start<input type="datetime-local" class="fh-s" value="' + toLocalInput(f.startAt) + '"></label>' +
      '<label class="tiny">End<input type="datetime-local" class="fh-e" value="' + toLocalInput(f.endAt) + '"></label>' +
      '<button class="btn primary block fh-save">Save changes</button>' +
      '<div class="row-2"><button class="btn danger fh-del">Delete fast</button>' +
        '<button class="btn fh-cancel">Cancel</button></div>';
    box.querySelector('.fh-cancel').addEventListener('click', function () { box.classList.add('hidden'); });
    box.querySelector('.fh-save').addEventListener('click', function () {
      var s = box.querySelector('.fh-s').value, e = box.querySelector('.fh-e').value;
      if (!s || !e) { toast('Set both times'); return; }
      if (new Date(e).getTime() <= new Date(s).getTime()) { toast('End must be after start'); return; }
      api('updateFast', { id: f.id, startAt: fromLocalInput(s), endAt: fromLocalInput(e) })
        .then(function () { box.classList.add('hidden'); loadFastCalendar(); toast('Fast updated ✓'); })
        .catch(function (err) { toast(err.message); });
    });
    box.querySelector('.fh-del').addEventListener('click', function () {
      if (!confirm('Delete this fast?')) return;
      api('deleteFast', { id: f.id })
        .then(function () { box.classList.add('hidden'); loadFastCalendar(); toast('Deleted'); })
        .catch(function (err) { toast(err.message); });
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderDietBody() {
    var g = dietGoals();
    var t = state.foods.reduce(function (s, f) {
      s.cal += f.calories; s.p += f.protein; s.c += f.carbs; s.f += f.fat; s.s += (f.sugar || 0); s.fb += (f.fiber || 0); return s;
    }, { cal: 0, p: 0, c: 0, f: 0, s: 0, fb: 0 });

    $('#cal-eaten').textContent = Math.round(t.cal);
    $('#cal-goal').textContent = g.cal ? g.cal : '—';
    $('#cal-sub').textContent = (g.cal ? Math.round(g.cal - t.cal) : '—') + ' remaining';
    $('#goal-hint').classList.toggle('hidden', !!g.cal);

    var ring = $('#cal-ring');
    var circ = 2 * Math.PI * 34;
    var frac = g.cal ? Math.min(1, t.cal / g.cal) : 0;
    ring.style.strokeDashoffset = circ * (1 - frac);
    ring.style.stroke = (g.cal && t.cal > g.cal) ? 'var(--red)' : '#2fd47a';

    var bars = $('#macro-bars');
    bars.innerHTML = '';
    [['p', 'Protein', t.p, g.protein], ['c', 'Carbs', t.c, g.carbs],
     ['f', 'Fat', t.f, g.fat], ['s', 'Sugar', t.s, g.sugar], ['fb', 'Fibre', t.fb, g.fiber]].forEach(function (m) {
      // Sugar is a cap (going over is bad); fibre is a target (more is good).
      var over = m[0] !== 'fb' && m[3] && m[2] > m[3];
      var pct = m[3] ? Math.min(100, Math.round((m[2] / m[3]) * 100)) : 0;
      var row = el('div', 'macro ' + m[0] + (over ? ' over' : ''));
      var goalTxt = m[3] ? ' / ' + m[3] + 'g' + (m[0] === 's' ? ' max' : (m[0] === 'fb' ? ' goal' : '')) : '';
      row.innerHTML = '<div class="ml"><span>' + m[1] + '</span><span><b>' + Math.round(m[2]) + 'g</b>' +
        goalTxt + '</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>';
      bars.appendChild(row);
    });

    renderMeals();
  }

  function renderMeals() {
    var meals = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
    var box = $('#meals');
    box.innerHTML = '';
    meals.forEach(function (meal) {
      var items = state.foods.filter(function (f) { return f.meal === meal; });
      var cals = items.reduce(function (s, f) { return s + f.calories; }, 0);
      var card = el('div', 'meal-card');
      var head = el('div', 'meal-top');
      head.innerHTML = '<span class="mt-name">' + meal + '</span><span class="mt-cal">' + Math.round(cals) + ' kcal</span>';
      card.appendChild(head);
      items.forEach(function (f) {
        var it = el('div', 'food-item');
        it.innerHTML =
          '<div class="fi-body"><div class="fi-name">' + esc(f.name) + '</div>' +
          '<div class="fi-sub">' + (f.grams ? Math.round(f.grams) + ' g · ' : '') + 'P' + Math.round(f.protein) + ' C' + Math.round(f.carbs) + ' F' + Math.round(f.fat) + ' S' + Math.round(f.sugar || 0) + ' Fb' + Math.round(f.fiber || 0) + ' · <span class="fi-edit-hint">tap to edit</span></div></div>' +
          '<div class="fi-cal">' + Math.round(f.calories) + '</div>' +
          '<button class="fi-del" title="Remove">✕</button>';
        it.querySelector('.fi-body').addEventListener('click', function () { editFoodEntry(f); });
        it.querySelector('.fi-del').addEventListener('click', function (e) { e.stopPropagation(); deleteFood(f.id); });
        card.appendChild(it);
      });
      var add = el('button', 'add-food-btn', '+ Add food');
      add.addEventListener('click', function () { openFoodModal(meal); });
      card.appendChild(add);
      box.appendChild(card);
    });
  }

  /* ----- Food modal ----- */
  var searchTimer;
  function openFoodModal(meal) {
    $('#food-modal-title').textContent = 'Add to ' + meal;
    state.editingFoodId = null;
    $('#p-meal').value = meal;
    showSearchStep();
    $('#food-search').value = '';
    showRecents();
    loadCustomFoods();   // refresh shared foods so newly-added ones are searchable
    state.scanData = null;
    $('#food-manual').classList.add('hidden');
    show('#food-modal');
    setTimeout(function () { $('#food-search').focus(); }, 100);
  }

  /* Per-device food stats: frequency (most used) + recency (recent). */
  function getFoodStats() {
    try { return JSON.parse(localStorage.getItem('hard_foodstats') || '{}'); } catch (e) { return {}; }
  }
  function addRecent(food) {
    if (!food || !food.name) return;
    var m = getFoodStats();
    var k = food.name.toLowerCase();
    var ex = m[k] || { count: 0 };
    m[k] = {
      name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s, fb: food.fb || 0,
      serving: food.serving || 100, perServing: !!food.perServing,
      count: (ex.count || 0) + 1, last: Date.now()
    };
    localStorage.setItem('hard_foodstats', JSON.stringify(m));
  }
  function showRecents() {
    var box = $('#food-results');
    box.innerHTML = '';
    var m = getFoodStats();
    var all = Object.keys(m).map(function (k) { return m[k]; });
    var most = all.filter(function (x) { return (x.count || 0) >= 2; })
                  .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);
    var taken = {};
    most.forEach(function (x) { taken[x.name.toLowerCase()] = 1; });
    var recent = all.slice().sort(function (a, b) { return (b.last || 0) - (a.last || 0); })
                    .filter(function (x) { return !taken[x.name.toLowerCase()]; }).slice(0, 8);
    if (most.length) { box.appendChild(el('div', 'fr-head muted tiny', '⭐ Most used')); appendResults(most); }
    if (recent.length) { box.appendChild(el('div', 'fr-head muted tiny', 'Recent')); appendResults(recent); }
    if (!most.length && !recent.length) { box.appendChild(el('div', 'fr-head muted tiny', 'Popular')); appendResults(COMMON_FOODS.slice(0, 12)); }
  }
  function closeFoodModal() { hide('#food-modal'); state.pendingFood = null; state.editingFoodId = null; $('#food-modal-title').textContent = 'Add food'; }
  function showSearchStep() { $('#food-step-search').classList.remove('hidden'); $('#food-step-portion').classList.add('hidden'); }
  function showPortionStep() { $('#food-step-search').classList.add('hidden'); $('#food-step-portion').classList.remove('hidden'); }

  // Token-based match: every result must contain at least one query word,
  // ranked by how many words it matches (so "chicken boiled" surfaces all chicken).
  function localMatches(q) {
    var tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    var pool = COMMON_FOODS.concat(state.customFoods || [], INDIAN_POOL);
    return pool.map(function (f) {
      var n = f.name.toLowerCase();
      var score = 0;
      tokens.forEach(function (t) { if (n.indexOf(t) !== -1) score++; });
      return { f: f, score: score };
    }).filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; })
      .map(function (x) { return x.f; })
      .slice(0, 40);
  }

  function runSearch(q) {
    q = q.trim();
    var results = $('#food-results');
    if (!q) { showRecents(); return; }
    var local = localMatches(q);
    renderResults(local, true);
    results.insertAdjacentHTML('beforeend', '<p class="fr-loading" id="fr-loading">Searching database…</p>');

    searchOFF(q).then(function (items) {
      var l = $('#fr-loading'); if (l) l.remove();
      var seen = {};
      local.forEach(function (x) { seen[x.name.toLowerCase()] = true; });
      var add = items.filter(function (x) {
        var k = x.name.toLowerCase();
        if (seen[k]) return false; seen[k] = true; return true;
      });
      if (!local.length && !add.length) {
        results.innerHTML = '<p class="fr-loading">No matches in the database. Use “+ Add a custom food” below to enter it from the label.</p>';
        return;
      }
      appendResults(add);
    });
  }

  function mapProduct(p) {
    var n = p.nutriments || {};
    var kcal = n['energy-kcal_100g'];
    if (kcal == null) kcal = n['energy-kcal'];
    if (kcal == null || !p.product_name) return null;
    return {
      name: p.product_name + (p.brands ? ' · ' + String(p.brands).split(',')[0] : ''),
      kcal: kcal, p: n.proteins_100g || 0, c: n.carbohydrates_100g || 0, f: n.fat_100g || 0,
      s: n.sugars_100g || 0, serving: Number(p.serving_quantity) || 100
    };
  }

  // Newer Open Food Facts search first; fall back to the legacy endpoint.
  function searchOFF(q) {
    var sal = 'https://search.openfoodfacts.org/search?q=' + encodeURIComponent(q) +
      '&page_size=30&fields=product_name,brands,nutriments,serving_quantity';
    return fetch(sal).then(function (r) { return r.json(); }).then(function (d) {
      var hits = d.hits || d.products || [];
      var items = hits.map(mapProduct).filter(Boolean);
      return items.length ? items : legacySearch(q);
    }).catch(function () { return legacySearch(q); });
  }
  function legacySearch(q) {
    var url = 'https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q) +
      '&search_simple=1&action=process&json=1&page_size=40' +
      '&fields=product_name,brands,nutriments,serving_quantity';
    return fetch(url).then(function (r) { return r.json(); })
      .then(function (d) { return (d.products || []).map(mapProduct).filter(Boolean); })
      .catch(function () { return []; });
  }

  function renderResults(list, replace) {
    var box = $('#food-results');
    if (replace) box.innerHTML = '';
    appendResults(list);
  }
  function appendResults(list) {
    var box = $('#food-results');
    list.forEach(function (f) {
      var it = el('div', 'fr-item');
      it.innerHTML = '<div><div class="fr-name">' + esc(f.name) + '</div>' +
        '<div class="fr-sub">' + (f.perServing ? 'per serving' : 'per 100g') + ' · P' + Math.round(f.p) + ' C' + Math.round(f.c) + ' F' + Math.round(f.f) + '</div></div>' +
        '<div class="fr-cal">' + Math.round(f.kcal) + ' kcal</div>';
      it.addEventListener('click', function () { pickFood(f); });
      box.appendChild(it);
    });
  }

  function pickFood(f) {
    state.pendingFood = f;
    state.editingFoodId = null;
    $('#p-add').textContent = 'Add to diary';
    $('#p-name').textContent = f.name;
    setPortionUnit('serving');
    showPortionStep();
  }

  // Edit the quantity (and meal) of a food already in the diary.
  function editFoodEntry(f) {
    var g = Number(f.grams) > 0 ? Number(f.grams) : 100;
    state.pendingFood = {
      name: f.name, serving: 100,
      kcal: f.calories / g * 100, p: f.protein / g * 100,
      c: f.carbs / g * 100, f: f.fat / g * 100, s: (f.sugar || 0) / g * 100, fb: (f.fiber || 0) / g * 100
    };
    state.editingFoodId = f.id;
    $('#food-modal-title').textContent = 'Edit quantity';
    $('#p-meal').value = f.meal;
    $('#p-name').textContent = f.name;
    show('#food-modal');
    showPortionStep();
    setPortionUnit('grams');
    $('#p-grams').value = Math.round(g);
    updatePortion();
    $('#p-add').textContent = 'Save changes';
  }
  function setPortionUnit(unit) {
    state.portionUnit = unit;
    $('#unit-serving').classList.toggle('active', unit === 'serving');
    $('#unit-grams').classList.toggle('active', unit === 'grams');
    var f = state.pendingFood; if (!f) return;
    if (unit === 'serving') {
      $('#p-amount-label').textContent = 'Servings (1 ≈ ' + (f.serving || 100) + ' g)';
      $('#p-grams').value = 1; $('#p-grams').step = '0.25';
    } else {
      $('#p-amount-label').textContent = 'Amount (g / ml)';
      $('#p-grams').value = f.serving || 100; $('#p-grams').step = 'any';
    }
    updatePortion();
  }
  function portionGrams() {
    var f = state.pendingFood; var amt = Number($('#p-grams').value) || 0;
    return state.portionUnit === 'serving' ? amt * (f.serving || 100) : amt;
  }
  function updatePortion() {
    var f = state.pendingFood; if (!f) return;
    var x = portionGrams() / 100;
    var k = f.kcal * x, p = f.p * x, c = f.c * x, ft = f.f * x, su = (f.s || 0) * x, fi = (f.fb || 0) * x;
    $('#p-macros').innerHTML =
      '<div class="pm-chip"><b>' + Math.round(k) + '</b>kcal</div>' +
      '<div class="pm-chip"><b>' + Math.round(p) + '</b>protein</div>' +
      '<div class="pm-chip"><b>' + Math.round(c) + '</b>carbs</div>' +
      '<div class="pm-chip"><b>' + Math.round(ft) + '</b>fat</div>' +
      '<div class="pm-chip"><b>' + Math.round(su) + '</b>sugar</div>' +
      '<div class="pm-chip"><b>' + Math.round(fi) + '</b>fibre</div>';
  }
  function addPortion() {
    var f = state.pendingFood; if (!f) return;
    var grams = portionGrams();
    var x = grams / 100;
    var macros = { calories: f.kcal * x, protein: f.p * x, carbs: f.c * x, fat: f.f * x, sugar: (f.s || 0) * x, fiber: (f.fb || 0) * x };
    if (state.editingFoodId) {
      var id = state.editingFoodId;
      api('updateFood', { id: id, food: Object.assign({ grams: Math.round(grams), meal: $('#p-meal').value }, macros) })
        .then(function (data) {
          for (var i = 0; i < state.foods.length; i++) { if (state.foods[i].id === id && data.food) { state.foods[i] = data.food; break; } }
          state.editingFoodId = null;
          state.dietRangeCache = {};
          closeFoodModal(); renderDietBody(); toast('Updated ✓');
        }).catch(function (e) { toast(e.message); });
      return;
    }
    addRecent(f);
    saveFood(Object.assign({ meal: $('#p-meal').value, name: f.name, grams: Math.round(grams) }, macros));
  }
  // Custom food entered per 100 g/ml -> share it, then set the amount.
  function manualNext() {
    var name = $('#m-name').value.trim();
    if (!name) { toast('Enter a food name'); return; }
    var sd = state.scanData || {};
    var fibre = Number($('#m-fiber').value) || sd.fiber || 0;
    var food = {
      name: name,
      kcal: Number($('#m-cal').value) || 0,
      p: Number($('#m-protein').value) || 0,
      c: Number($('#m-carbs').value) || 0,
      f: Number($('#m-fat').value) || 0,
      s: Number($('#m-sugar').value) || 0,
      fb: fibre,
      serving: 100,
      // full panel (from a scan) — stored in the backend dataset, not shown here
      satFat: sd.saturatedFat || 0, transFat: sd.transFat || 0, fiber: fibre, addedSugar: sd.addedSugar || 0,
      sodium: sd.sodium || 0, cholesterol: sd.cholesterol || 0, calcium: sd.calcium || 0, iron: sd.iron || 0,
      servingSize: sd.servingSize || '', data: state.scanData
    };
    saveCustomFood(food);   // share with everyone so it's searchable
    pickFood(food);
    state.scanData = null;
    $('#m-name').value = $('#m-cal').value = $('#m-protein').value = $('#m-carbs').value = $('#m-fat').value = $('#m-sugar').value = $('#m-fiber').value = '';
  }
  function saveCustomFood(food) {
    var exists = (state.customFoods || []).some(function (f) { return f.name.toLowerCase() === food.name.toLowerCase(); });
    if (!exists) state.customFoods.push({ name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s, fb: food.fb || food.fiber || 0, serving: 100, shared: true });
    api('addCustomFood', { food: {
      name: food.name, kcal: food.kcal, p: food.p, c: food.c, f: food.f, s: food.s,
      satFat: food.satFat || 0, transFat: food.transFat || 0, fiber: food.fiber || 0, addedSugar: food.addedSugar || 0,
      sodium: food.sodium || 0, cholesterol: food.cholesterol || 0, calcium: food.calcium || 0, iron: food.iron || 0,
      servingSize: food.servingSize || '', data: food.data || null
    } }).catch(function () {});
  }
  function saveFood(food) {
    food.date = state.dietDate || todayStr();
    api('addFood', { food: food }).then(function (data) {
      state.foods.push(data.food);
      state.dietRangeCache = {};
      closeFoodModal();
      renderDietBody();
      toast('Added ✓');
    }).catch(function (e) { toast(e.message); });
  }
  function deleteFood(id) {
    api('deleteFood', { id: id }).then(function () {
      state.foods = state.foods.filter(function (f) { return f.id !== id; });
      state.dietRangeCache = {};
      renderDietBody();
    }).catch(function (e) { toast(e.message); });
  }

  /* ----- Scan a nutrition label (on-device OCR via Tesseract.js) ----- */
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = res; s.onerror = function () { rej(new Error('Could not load the scanner (no internet?)')); };
      document.head.appendChild(s);
    });
  }
  function scanStatus(msg) { var e = $('#scan-status'); if (e) e.textContent = msg || ''; }

  // Grayscale + upscale + contrast to give Tesseract a better chance.
  function fileToCanvas(file) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(2.5, Math.max(1, 1300 / img.width));
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        var ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
        try {
          var d = ctx.getImageData(0, 0, w, h), p = d.data;
          for (var i = 0; i < p.length; i += 4) {
            var g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
            g = (g - 128) * 1.5 + 128;
            p[i] = p[i + 1] = p[i + 2] = g < 0 ? 0 : g > 255 ? 255 : g;
          }
          ctx.putImageData(d, 0, 0);
        } catch (e) { /* ignore */ }
        res(c);
      };
      img.onerror = function () { res(null); };
      img.src = URL.createObjectURL(file);
    });
  }

  // Compress to a JPEG base64 string for the AI scanner payload.
  function compressImage(file) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1000 / img.width);
        var w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        var c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { res(c.toDataURL('image/jpeg', 0.6).split(',')[1]); }
        catch (e) { rej(new Error('Could not read this image.')); }
      };
      img.onerror = function () { rej(new Error('Could not open this image.')); };
      img.src = URL.createObjectURL(file);
    });
  }
  // Fill the form from an AI result (works for label reads, front-photo or name lookups).
  function applyScanResult(d) {
    state.scanData = d;   // full panel kept for the backend dataset
    var any = false;
    function put(sel, v, intval) { if (v) { $(sel).value = intval ? Math.round(v) : Math.round(v * 10) / 10; any = true; } }
    put('#m-cal', d.calories, true); put('#m-protein', d.protein); put('#m-carbs', d.carbs); put('#m-fat', d.fat); put('#m-sugar', d.sugar); put('#m-fiber', d.fiber);
    if (d.name && !$('#m-name').value) $('#m-name').value = d.name;
    var warn = d.estimated ? ' ⚠️ AI estimate — please double-check the values.' : '';
    scanStatus(any
      ? ((d.estimated ? 'AI estimate ✓' : 'AI read ✓') + ' — check the values, then add.' + warn)
      : 'AI couldn’t find nutrition values. Try a clear photo of the nutrition panel.');
  }
  // Send one or more already-compressed base64 JPEGs to the Gemini scanner.
  function scanWithGemini(b64list) {
    if (!b64list || !b64list.length) return;
    scanStatus(b64list.length > 1 ? 'Sending front + back to AI…' : 'Sending to AI…');
    var payload = b64list.length > 1
      ? { images: b64list, mime: 'image/jpeg' }
      : { image: b64list[0], mime: 'image/jpeg' };
    api('scanLabel', payload).then(function (d) { applyScanResult(d); resetScanImages(); })
      .catch(function (e) { scanStatus(e.message || 'AI scan failed.'); });
  }
  // Look a product up by name (no photo) — AI returns typical per-100g values.
  function aiLookupByName() {
    var name = $('#m-name').value.trim();
    if (!name) { scanStatus('Type a product name above first.'); return; }
    scanStatus('Asking AI about “' + name + '”…');
    api('scanLabel', { query: name }).then(applyScanResult)
      .catch(function (e) { scanStatus(e.message || 'AI lookup failed.'); });
  }

  // Front + back collection (AI mode only).
  function resetScanImages() {
    state.scanImages = [];
    var t = $('#scan-thumbs'); if (t) t.innerHTML = '';
    var go = $('#scan-go-btn'); if (go) go.classList.add('hidden');
  }
  function renderScanThumbs() {
    var t = $('#scan-thumbs'); if (!t) return;
    t.innerHTML = '';
    (state.scanImages || []).forEach(function (b64, i) {
      var img = document.createElement('img');
      img.src = 'data:image/jpeg;base64,' + b64;
      img.title = (i === 0 ? 'Front' : 'Back') + ' — tap to remove';
      img.addEventListener('click', function () {
        state.scanImages.splice(i, 1); renderScanThumbs();
        $('#scan-go-btn').classList.toggle('hidden', !state.scanImages.length);
      });
      t.appendChild(img);
    });
  }
  function addScanImage(file) {
    compressImage(file).then(function (b64) {
      if (!state.scanImages) state.scanImages = [];
      if (state.scanImages.length >= 2) state.scanImages.shift();   // keep latest two
      state.scanImages.push(b64);
      renderScanThumbs();
      $('#scan-go-btn').classList.remove('hidden');
      scanStatus(state.scanImages.length < 2
        ? 'Front added ✓ — now add the back (nutrition table), then tap Scan now.'
        : 'Front + back added ✓ — tap Scan now.');
    }).catch(function (e) { scanStatus(e.message || 'Could not read image.'); });
  }

  function handleScanFile(file) {
    if (!file) return;
    $('#food-manual').classList.remove('hidden');
    var ai = $('#ai-scan') && $('#ai-scan').checked;
    if (ai && $('#two-img') && $('#two-img').checked) { addScanImage(file); return; }
    if (ai) { compressImage(file).then(function (b64) { scanWithGemini([b64]); }).catch(function (e) { scanStatus(e.message || 'AI scan failed.'); }); return; }
    scanStatus('Loading scanner…');
    var imgSource = file;
    loadTesseract()
      .then(function () { return fileToCanvas(file); })
      .then(function (canvas) {
        if (canvas) imgSource = canvas;
        scanStatus('Reading label… 0%');
        return Tesseract.recognize(imgSource, 'eng', {
          logger: function (m) {
            if (m.status === 'recognizing text') scanStatus('Reading label… ' + Math.round(m.progress * 100) + '%');
          }
        });
      })
      .then(function (out) {
        var r = applyLabel((out && out.data && out.data.text) || '');
        if (r.any) scanStatus('Read ✓ (' + r.note + ') — check the values, then add.');
        else scanStatus('Couldn’t read this label clearly. Try a straight, close, well-lit shot — or type the values in.');
      })
      .catch(function (e) { scanStatus(e.message || 'Scan failed.'); });
  }

  function firstNumAfter(text, kw) {
    var re = new RegExp(kw.replace(/ /g, '\\s*') + '[^0-9\\n]{0,25}?(\\d+(?:[.,]\\d+)?)', 'i');
    var m = text.match(re);
    return m ? parseFloat(m[1].replace(',', '.')) : null;
  }
  function applyLabel(text) {
    var t = ' ' + text.replace(/\n/g, ' ').replace(/\s+/g, ' ') + ' ';
    var kcal = firstNumAfter(t, 'energy');
    if (kcal == null) { var mk = t.match(/(\d+(?:[.,]\d+)?)\s*kcal/i) || t.match(/kcal[^0-9]{0,10}(\d+(?:[.,]\d+)?)/i); if (mk) kcal = parseFloat(mk[1].replace(',', '.')); }
    if (kcal == null) kcal = firstNumAfter(t, 'calorie');
    var protein = firstNumAfter(t, 'protein');
    var carbs = firstNumAfter(t, 'carbohydrate'); if (carbs == null) carbs = firstNumAfter(t, 'carb');
    var fat = firstNumAfter(t, 'total fat'); if (fat == null) fat = firstNumAfter(t, 'fat');
    var sugar = firstNumAfter(t, 'total sugar'); if (sugar == null) sugar = firstNumAfter(t, 'sugar');
    var fiber = firstNumAfter(t, 'dietary fibre'); if (fiber == null) fiber = firstNumAfter(t, 'dietary fiber');
    if (fiber == null) fiber = firstNumAfter(t, 'fibre'); if (fiber == null) fiber = firstNumAfter(t, 'fiber');

    // Convert per-serving labels to per-100.
    var scale = 1, note = 'per 100';
    var ps = t.match(/per\s*serv\w*[^0-9]{0,14}(\d+(?:[.,]\d+)?)\s*(ml|g)/i) || t.match(/serving\s*size[^0-9]{0,14}(\d+(?:[.,]\d+)?)\s*(ml|g)/i);
    if (ps) { var sz = parseFloat(ps[1].replace(',', '.')); if (sz > 0 && Math.abs(sz - 100) > 1) { scale = 100 / sz; note = 'converted from per ' + sz + ps[2]; } }

    var any = false;
    function put(sel, v, intval) { if (v != null) { var x = v * scale; $(sel).value = intval ? Math.round(x) : Math.round(x * 10) / 10; any = true; } }
    put('#m-cal', kcal, true); put('#m-protein', protein); put('#m-carbs', carbs); put('#m-fat', fat); put('#m-sugar', sugar); put('#m-fiber', fiber);
    return { any: any, note: note };
  }

  /* ----- Diet goals ----- */
  function bindDietEvents() {
    $('#food-close').addEventListener('click', closeFoodModal);
    $('#food-modal').addEventListener('click', function (e) { if (e.target.id === 'food-modal') closeFoodModal(); });
    $('#food-back').addEventListener('click', showSearchStep);
    $('#food-search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = this.value;
      searchTimer = setTimeout(function () { runSearch(q); }, 350);
    });
    $('#food-manual-toggle').addEventListener('click', function () { $('#food-manual').classList.toggle('hidden'); });
    $('#scan-camera-btn').addEventListener('click', function () { $('#scan-camera').click(); });
    $('#scan-upload-btn').addEventListener('click', function () { $('#scan-upload').click(); });
    function onScanChange() { if (this.files && this.files[0]) handleScanFile(this.files[0]); this.value = ''; }
    $('#scan-camera').addEventListener('change', onScanChange);
    $('#scan-upload').addEventListener('change', onScanChange);
    $('#ai-scan').checked = localStorage.getItem('hard_aiscan') === '1';
    function syncTwoImg() {
      var on = $('#ai-scan').checked;
      $('#two-img-wrap').classList.toggle('hidden', !on);
      $('#ai-name-btn').classList.toggle('hidden', !on);
      $('#ai-hint').classList.toggle('hidden', !on);
      if (!on) { $('#two-img').checked = false; resetScanImages(); }
    }
    $('#ai-scan').addEventListener('change', function () { localStorage.setItem('hard_aiscan', this.checked ? '1' : '0'); syncTwoImg(); });
    syncTwoImg();
    $('#ai-name-btn').addEventListener('click', aiLookupByName);
    $('#two-img').addEventListener('change', function () {
      resetScanImages();
      scanStatus(this.checked ? 'Add the FRONT (name/brand), then the BACK (nutrition table), then tap Scan now.' : '');
    });
    $('#scan-go-btn').addEventListener('click', function () {
      if (state.scanImages && state.scanImages.length) scanWithGemini(state.scanImages.slice());
      else scanStatus('Add a photo first.');
    });
    $('#m-next').addEventListener('click', manualNext);
    $('#p-grams').addEventListener('input', updatePortion);
    $('#unit-serving').addEventListener('click', function () { setPortionUnit('serving'); });
    $('#unit-grams').addEventListener('click', function () { setPortionUnit('grams'); });
    $('#p-add').addEventListener('click', addPortion);
    $('#calc-goals').addEventListener('click', calcGoals);
    $('#save-goals').addEventListener('click', saveGoals);
    // Diet date navigation + Day/Week/Month averages
    $('#diet-prev').addEventListener('click', function () { shiftDietRange(-1); });
    $('#diet-next').addEventListener('click', function () { shiftDietRange(1); });
    $('#diet-date').addEventListener('change', function () { if (this.value) setDietDate(this.value); });
    $('#diet-mode').addEventListener('click', function (e) {
      var b = e.target.closest('[data-mode]'); if (!b) return;
      setDietMode(b.getAttribute('data-mode'));
    });
  }

  function calcGoals() {
    var sex = $('#g-sex').value;
    var age = parseFloat($('#g-age').value), cm = parseFloat($('#g-height').value), kg = parseFloat($('#g-weight').value);
    var missing = [];
    if (!(age > 0)) missing.push('age');
    if (!(cm > 0)) missing.push('height');
    if (!(kg > 0)) missing.push('weight');
    if (missing.length) { toast('Please enter your ' + missing.join(', ')); return; }
    var bmr = 10 * kg + 6.25 * cm - 5 * age + (sex === 'female' ? -161 : 5);
    var act = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 }[$('#g-activity').value] || 1.2;
    var adj = { lose: -500, maintain: 0, gain: 300 }[$('#g-goaltype').value] || 0;
    var cal = Math.max(1200, Math.round((bmr * act + adj) / 10) * 10);
    var protein = Math.round(1.8 * kg);
    var fat = Math.round(cal * 0.25 / 9);
    var carbs = Math.max(0, Math.round((cal - protein * 4 - fat * 9) / 4));
    var sugar = Math.round(cal * 0.10 / 4); // WHO: keep free sugars under ~10% of calories
    var fiber = Math.round(cal / 1000 * 14); // ~14 g fibre per 1000 kcal (USDA guideline)
    $('#g-cal').value = cal; $('#g-protein').value = protein; $('#g-carbs').value = carbs; $('#g-fat').value = fat;
    $('#g-sugar').value = sugar; $('#g-fiber').value = fiber;
    toast('Targets calculated — tap Save');
  }

  function saveGoals() {
    // Merge into the existing profile so we don't wipe mode/softTarget/customTasks.
    var profile = Object.assign({}, state.profile, {
      sex: $('#g-sex').value, age: +$('#g-age').value || '', heightCm: +$('#g-height').value || '',
      weightKg: +$('#g-weight').value || '', activity: $('#g-activity').value, goalType: $('#g-goaltype').value,
      calorieGoal: +$('#g-cal').value || 0, proteinGoal: +$('#g-protein').value || 0,
      carbGoal: +$('#g-carbs').value || 0, fatGoal: +$('#g-fat').value || 0, sugarGoal: +$('#g-sugar').value || 0,
      fiberGoal: +$('#g-fiber').value || 0
    });
    api('saveGoals', { profile: profile }).then(function (data) {
      state.profile = data.profile || profile;
      toast('Diet goals saved ✓');
    }).catch(function (e) { toast(e.message); });
  }

  function prefillGoals() {
    var p = state.profile || {};
    if (p.sex) $('#g-sex').value = p.sex;
    if (p.activity) $('#g-activity').value = p.activity;
    if (p.goalType) $('#g-goaltype').value = p.goalType;
    $('#g-age').value = p.age || '';
    $('#g-height').value = p.heightCm || '';
    // Prefer the latest weight logged in Body over the older manual profile value.
    $('#g-weight').value = (lastMetric('weight') || {}).v || p.weightKg || '';
    $('#g-cal').value = p.calorieGoal || '';
    $('#g-protein').value = p.proteinGoal || '';
    $('#g-carbs').value = p.carbGoal || '';
    $('#g-fat').value = p.fatGoal || '';
    $('#g-sugar').value = p.sugarGoal || '';
    $('#g-fiber').value = p.fiberGoal || '';
  }

  /* ---------------- Fitness calculators ---------------- */
  var ACT_FACTORS = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 };

  // Auto-fills a field from Body/profile data, unless the user has directly
  // edited that field this session (tracked via state.calcTouched). Always
  // re-syncs untouched fields, so a fresh Body log shows up immediately.
  if (!state.calcTouched) state.calcTouched = {};
  function calcAutoFill(sel, v) {
    var e = $(sel); if (!e || state.calcTouched[e.id]) return;
    if (!(v || v === 0)) return;
    e.value = v;
  }
  function calcAutoSelect(sel, v) {
    var e = $(sel); if (!e || !v || state.calcTouched[e.id]) return;
    e.value = v;
  }
  function renderCalc() {
    var p = state.profile || {};
    var weight = (lastMetric('weight') || {}).v || p.weightKg;
    var neck = (lastMetric('neck') || {}).v;
    var waist = (lastMetric('waist') || {}).v;
    var hip = (lastMetric('hips') || {}).v;

    calcAutoFill('#bmi-h', p.heightCm); calcAutoFill('#bmi-w', weight);
    calcAutoFill('#bf-h', p.heightCm); calcAutoSelect('#bf-sex', p.sex);
    calcAutoFill('#bf-neck', neck); calcAutoFill('#bf-waist', waist); calcAutoFill('#bf-hip', hip);
    $('#bf-hip-wrap').classList.toggle('hidden', $('#bf-sex').value !== 'female');
    calcAutoSelect('#cal-sex', p.sex); calcAutoFill('#cal-age', p.age); calcAutoFill('#cal-h', p.heightCm); calcAutoFill('#cal-w', weight);
    calcAutoSelect('#cal-act', p.activity); calcAutoSelect('#cal-goal', p.goalType);
    calcAutoFill('#mac-cal', p.calorieGoal);
    calcAutoSelect('#iw-sex', p.sex); calcAutoFill('#iw-h', p.heightCm);
    calcAutoFill('#wtr-w', weight);
  }

  function calcOut(sel, html) { $(sel).innerHTML = html; }

  function calcDispatch(type) {
    var num = function (sel) { return parseFloat($(sel).value) || 0; };
    if (type === 'bmi') {
      var h = num('#bmi-h') / 100, w = num('#bmi-w');
      if (!h || !w) return calcOut('#bmi-out', 'Enter height & weight.');
      var bmi = w / (h * h);
      var cat = bmi < 18.5 ? 'Underweight' : bmi < 25 ? 'Normal' : bmi < 30 ? 'Overweight' : 'Obese';
      calcOut('#bmi-out', '<b>' + bmi.toFixed(1) + '</b> BMI · ' + cat);
    }
    else if (type === 'bodyfat') {
      var sex = $('#bf-sex').value, H = num('#bf-h'), neck = num('#bf-neck'), waist = num('#bf-waist'), hip = num('#bf-hip');
      if (!H || !neck || !waist) return calcOut('#bf-out', 'Enter height, neck & waist.');
      if (sex === 'female' && !hip) return calcOut('#bf-out', 'Enter hip measurement.');
      if (sex !== 'female' && waist - neck <= 0) return calcOut('#bf-out', 'Waist must be larger than neck.');
      var bf = navyBodyFat(sex, H, neck, waist, hip);
      // ACE body-fat categories differ by sex.
      var tag = sex === 'female'
        ? (bf < 14 ? 'essential' : bf < 21 ? 'athlete' : bf < 25 ? 'fitness' : bf < 32 ? 'acceptable' : 'obese range')
        : (bf < 6 ? 'essential' : bf < 14 ? 'athlete' : bf < 18 ? 'fitness' : bf < 25 ? 'acceptable' : 'obese range');
      calcOut('#bf-out', '<b>' + bf.toFixed(1) + '%</b> body fat (' + (sex === 'female' ? 'women' : 'men') + ', US Navy estimate) · ' + tag);
    }
    else if (type === 'calories') {
      var s = $('#cal-sex').value, age = num('#cal-age'), ch = num('#cal-h'), cw = num('#cal-w');
      if (!age || !ch || !cw) return calcOut('#cal-out', 'Enter age, height & weight.');
      var bmr = 10 * cw + 6.25 * ch - 5 * age + (s === 'female' ? -161 : 5);
      var tdee = bmr * (ACT_FACTORS[$('#cal-act').value] || 1.2);
      var adj = { lose: -500, maintain: 0, gain: 300 }[$('#cal-goal').value] || 0;
      var target = Math.max(1200, Math.round((tdee + adj) / 10) * 10);
      calcOut('#cal-out', 'BMR <b>' + Math.round(bmr) + '</b> · Maintain <b>' + Math.round(tdee) +
        '</b> · Target <b>' + target + '</b> kcal/day');
    }
    else if (type === 'macros') {
      var cal = num('#mac-cal');
      if (!cal) return calcOut('#mac-out', 'Enter a calorie target.');
      var r = { balanced: [.30, .40, .30], highprotein: [.40, .35, .25], lowcarb: [.40, .20, .40], keto: [.30, .10, .60] }[$('#mac-split').value];
      var prot = Math.round(cal * r[0] / 4), carb = Math.round(cal * r[1] / 4), fat = Math.round(cal * r[2] / 9);
      calcOut('#mac-out', 'Protein <b>' + prot + 'g</b> · Carbs <b>' + carb + 'g</b> · Fat <b>' + fat + 'g</b>');
    }
    else if (type === 'ideal') {
      var is = $('#iw-sex').value, ih = num('#iw-h');
      if (!ih) return calcOut('#iw-out', 'Enter height.');
      var inches = ih / 2.54;
      var devine = (is === 'female' ? 45.5 : 50) + 2.3 * Math.max(0, inches - 60);
      var m = ih / 100;
      var lo = (18.5 * m * m), hi = (24.9 * m * m);
      calcOut('#iw-out', 'Ideal <b>' + devine.toFixed(1) + ' kg</b> · healthy range ' + lo.toFixed(0) + '–' + hi.toFixed(0) + ' kg');
    }
    else if (type === 'orm') {
      var w = num('#orm-w'), reps = num('#orm-reps');
      if (!w || !reps) return calcOut('#orm-out', 'Enter weight & reps.');
      var orm = w * (1 + reps / 30);
      calcOut('#orm-out', '1RM <b>' + orm.toFixed(1) + ' kg</b> · ' +
        '80%: ' + (orm * .8).toFixed(0) + ' · 90%: ' + (orm * .9).toFixed(0) + ' kg');
    }
    else if (type === 'water') {
      var ww = num('#wtr-w');
      if (!ww) return calcOut('#wtr-out', 'Enter weight.');
      var ml = 35 * ww;
      calcOut('#wtr-out', '<b>' + (ml / 1000).toFixed(1) + ' L/day</b> (~' + Math.round(ml / 250) + ' glasses)');
    }
  }
  function log10(x) { return Math.log(x) / Math.LN10; }

  /* ---------------- Themes ---------------- */
  var THEMES = [
    { id: 'midnight', name: 'Midnight',  bg: '#0b1220', accent: '#ff5a3c' },
    { id: 'neon',     name: 'Neon Lime', bg: '#0a0a0a', accent: '#c8ff00' },
    { id: 'violet',   name: 'Violet',    bg: '#0c0a14', accent: '#a855f7' },
    { id: 'ocean',    name: 'Ocean',     bg: '#04141b', accent: '#22d3ee' },
    { id: 'crimson',  name: 'Crimson',   bg: '#140a0d', accent: '#ff4d5e' },
    { id: 'pastel',   name: 'Pastel',    bg: '#f3f1ee', accent: '#b07cff' },
    { id: 'academia', name: 'Academia',  bg: '#241c14', accent: '#c8a86a' },
    { id: 'arsenal',  name: 'Arsenal',   bg: '#ffffff', accent: '#ef0107' }
  ];
  function currentTheme() { return localStorage.getItem('hard_theme') || CFG.DEFAULT_THEME || 'midnight'; }
  function applyTheme(id) {
    var t = THEMES.filter(function (x) { return x.id === id; })[0] || THEMES[0];
    if (t.id === 'midnight') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t.id);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bg);
    localStorage.setItem('hard_theme', t.id);
  }
  function renderThemes() {
    var grid = $('#theme-grid'); if (!grid) return;
    var active = currentTheme();
    grid.innerHTML = '';
    THEMES.forEach(function (t) {
      var s = el('button', 'swatch' + (t.id === active ? ' active' : ''));
      s.innerHTML = '<span class="sw-preview" style="background:' + t.bg + '">' +
        '<i style="background:' + t.accent + '"></i></span><span class="sw-name">' + t.name + '</span>';
      s.addEventListener('click', function () { applyTheme(t.id); renderThemes(); });
      grid.appendChild(s);
    });
  }

  /* ---------------- Admin dashboard ---------------- */
  function renderAdmin() {
    if (!isAdmin()) { switchView('today'); return; }
    $('#admin-scan-cards').innerHTML = '<p class="muted tiny">Loading…</p>';
    $('#admin-users-list').innerHTML = '<p class="muted tiny">Loading…</p>';
    $('#admin-foods-list').innerHTML = '<p class="muted tiny">Loading…</p>';
    api('adminScans', {}).then(renderAdminScans).catch(function (e) { $('#admin-scan-cards').innerHTML = '<p class="muted tiny">' + (e.message || 'Failed') + '</p>'; });
    api('adminUsers', {}).then(renderAdminUsers).catch(function (e) { $('#admin-users-list').innerHTML = '<p class="muted tiny">' + (e.message || 'Failed') + '</p>'; });
    api('adminFoods', {}).then(function (d) { state.adminFoods = d.foods || []; renderAdminFoods(); })
      .catch(function (e) { $('#admin-foods-list').innerHTML = '<p class="muted tiny">' + (e.message || 'Failed') + '</p>'; });
  }

  function inr(v) { return '₹' + (Number(v) || 0).toFixed(Math.abs(v) >= 1 ? 2 : 3); }

  function renderAdminScans(d) {
    var cards = [
      ['Total scans', d.totalScans || 0],
      ['Total cost', inr(d.totalCostInr)],
      ['Avg / scan', inr(d.avgCostInr)],
      ['This month', inr(d.monthCostInr)],
      ['Avg tokens', (d.avgTokens || 0).toLocaleString()],
      ['≈ USD total', '$' + (Number(d.totalCostUsd) || 0).toFixed(4)]
    ];
    $('#admin-scan-cards').innerHTML = cards.map(function (c) {
      return '<div class="stat"><div class="num">' + c[1] + '</div><div class="lbl">' + c[0] + '</div></div>';
    }).join('');

    var KIND_LABEL = { food: '🥗 Food scans', money: '💰 Money scans', screentime: '📱 Screen Time', coach: '💬 Coach / Penny' };
    $('#admin-scan-bykind').innerHTML = (d.byKind || []).length
      ? d.byKind.map(function (k) {
          return '<div class="admin-row"><span>' + esc(KIND_LABEL[k.kind] || k.kind) + '</span><span class="amono">' + k.scans + ' · ' + inr(k.costInr) + (k.monthInr ? ' · ' + inr(k.monthInr) + '/mo' : '') + '</span></div>';
        }).join('')
      : '<p class="muted tiny">No scans yet.</p>';

    $('#admin-scan-byuser').innerHTML = (d.byUser || []).length
      ? d.byUser.map(function (u) {
          return '<div class="admin-row"><span>' + esc(u.username) + '</span><span class="amono">' + u.scans + ' · ' + inr(u.costInr) + '</span></div>';
        }).join('')
      : '<p class="muted tiny">No scans yet.</p>';

    $('#admin-scan-bymodel').innerHTML = (d.byModel || []).length
      ? d.byModel.map(function (m) {
          return '<div class="admin-row"><span>' + esc(m.model) + '</span><span class="amono">' + m.scans + ' · ' + inr(m.costInr) + '</span></div>';
        }).join('')
      : '<p class="muted tiny">—</p>';

    $('#admin-scan-recent').innerHTML = (d.recent || []).length
      ? d.recent.map(function (r) {
          var when = String(r.at || '').slice(0, 16).replace('T', ' ');
          var label = (r.name || '(unnamed)') + (r.images > 1 ? ' · ' + r.images + ' imgs' : '');
          return '<div class="admin-row"><span>' + esc(label) + '<br><span class="muted tiny">' + when + ' · ' + esc(r.username) + ' · ' + r.tokens.toLocaleString() + ' tok</span></span>' +
                 '<span class="amono">' + inr(r.costInr) + '</span></div>';
        }).join('')
      : '<p class="muted tiny">No scans yet.</p>';
  }

  function renderAdminUsers(d) {
    var list = $('#admin-users-list');
    if (!d.users || !d.users.length) { list.innerHTML = '<p class="muted tiny">No users.</p>'; return; }
    // Newest signups first so the admin can spot who just joined.
    var users = (d.users || []).slice().sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
    var weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    var newCount = users.filter(function (u) { return u.createdAt && u.createdAt >= weekAgo; }).length;
    list.innerHTML = '<p class="muted tiny" style="margin:2px">' + d.total + ' user' + (d.total === 1 ? '' : 's') +
        (newCount ? ' · 🆕 ' + newCount + ' joined this week' : '') + '</p>' +
      users.map(function (u) {
        var isNew = u.createdAt && u.createdAt >= weekAgo;
        var joined = u.createdAt ? String(u.createdAt).slice(0, 10) : '—';
        return '<div class="admin-user"><div class="au-top"><span class="au-name">' + esc(u.displayName) +
          (isNew ? ' <span class="new-badge">NEW</span>' : '') +
          (u.isAdmin ? ' <span class="muted tiny">· admin</span>' : '') + '</span>' +
          '<span class="muted tiny">Day ' + u.currentDay + '</span></div>' +
          '<div class="au-sub">@' + esc(u.username) + ' · 🔥 ' + u.streak + ' streak · ✅ ' + u.completedDays + ' days done · today ' + u.todayDone + '/7<br>' +
          '🍽 ' + u.foodLogs + ' food logs · joined ' + esc(joined) + ' · started ' + esc(u.startDate) + ' · last active ' + (u.lastActive ? esc(u.lastActive) : '—') +
          (u.email ? ' · ✉️ ' + esc(u.email) : '') + '</div>' +
          '<button class="btn fr-mini au-reset" data-resetpw="' + esc(u.username) + '">Reset password</button></div>';
      }).join('');
  }
  function adminResetUserPassword(username) {
    var npw = prompt('Set a new password for @' + username + ' (tell them this; they can change it later):');
    if (npw == null) return;
    npw = String(npw).trim();
    if (npw.length < 4) { toast('Password must be at least 4 characters'); return; }
    api('adminResetPassword', { username: username, newPassword: npw }).then(function () {
      toast('Password reset for @' + username + ' ✓');
    }).catch(function (e) { toast(e.message); });
  }

  function renderAdminFoods() {
    var list = $('#admin-foods-list');
    var all = state.adminFoods || [];
    var q = ($('#admin-food-filter').value || '').trim().toLowerCase();
    var foods = q ? all.filter(function (f) { return f.name.toLowerCase().indexOf(q) >= 0; }) : all;
    if (!foods.length) { list.innerHTML = '<p class="muted tiny">' + (all.length ? 'No matches.' : 'No scanned foods yet.') + '</p>'; return; }
    var fields = [
      ['kcal', 'Cal'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat'], ['sugar', 'Sugar'],
      ['satFat', 'Sat fat'], ['transFat', 'Trans'], ['fiber', 'Fibre'], ['addedSugar', 'Add sugar'],
      ['sodium', 'Sodium'], ['cholesterol', 'Chol'], ['calcium', 'Calcium'], ['iron', 'Iron']
    ];
    list.innerHTML = foods.map(function (f) {
      var grid = fields.map(function (fl) {
        return '<label>' + fl[1] + '<input type="number" inputmode="decimal" data-f="' + fl[0] + '" value="' + (f[fl[0]] || 0) + '" /></label>';
      }).join('');
      return '<div class="admin-food" data-id="' + esc(f.id) + '">' +
        '<div class="af-head"><input data-f="name" value="' + esc(f.name) + '" /></div>' +
        '<div class="af-grid">' + grid +
        '<label>Serving<input data-f="servingSize" value="' + esc(f.servingSize || '') + '" /></label></div>' +
        '<div class="af-meta">by ' + esc(f.createdBy || '—') + ' · ' + String(f.createdAt || '').slice(0, 10) + '</div>' +
        '<div class="af-actions"><button class="btn primary" data-save="' + esc(f.id) + '">Save</button>' +
        '<button class="btn danger" data-del="' + esc(f.id) + '">Delete</button></div></div>';
    }).join('');
  }

  function adminSaveFood(id, btn) {
    var card = btn.closest('.admin-food'); if (!card) return;
    var patch = { id: id };
    card.querySelectorAll('[data-f]').forEach(function (el) { patch[el.getAttribute('data-f')] = el.value; });
    btn.disabled = true; btn.textContent = 'Saving…';
    api('adminUpdateFood', patch).then(function () {
      btn.textContent = 'Saved ✓';
      // reflect locally so a re-filter keeps the new values
      var rec = (state.adminFoods || []).filter(function (x) { return x.id === id; })[0];
      if (rec) Object.keys(patch).forEach(function (k) { if (k !== 'id') rec[k] = k === 'name' || k === 'servingSize' ? patch[k] : (Number(patch[k]) || 0); });
      setTimeout(function () { btn.disabled = false; btn.textContent = 'Save'; }, 1200);
      toast('Saved ✓');
    }).catch(function (e) { btn.disabled = false; btn.textContent = 'Save'; toast(e.message); });
  }

  function adminDeleteFood(id) {
    var rec = (state.adminFoods || []).filter(function (x) { return x.id === id; })[0];
    if (!confirm('Delete "' + (rec ? rec.name : 'this food') + '" from the shared directory? This can’t be undone.')) return;
    api('adminDeleteFood', { id: id }).then(function () {
      state.adminFoods = (state.adminFoods || []).filter(function (x) { return x.id !== id; });
      renderAdminFoods(); toast('Deleted');
    }).catch(function (e) { toast(e.message); });
  }

  /* ---------------- ATLAS home + app library ---------------- */
  var APPS = [
    { id: 'challenge', name: 'Challenge', icon: '🔥', pillar: 'body', open: function () { switchView('today'); } },
    { id: 'challenges', name: 'Challenges', icon: '🏁', pillar: 'life', open: function () { switchView('challenges'); } },
    { id: 'diet',      name: 'Diet',      icon: '🥗', pillar: 'body', open: function () { switchView('diet'); } },
    { id: 'fast',      name: 'Fast',      icon: '⏳', pillar: 'body', open: function () { switchView('fast'); } },
    { id: 'water',     name: 'Water',     icon: '💧', pillar: 'body', open: function () { switchView('water'); } },
    { id: 'mood',      name: 'Mood',      icon: '🙂', pillar: 'body', open: function () { switchView('mood'); } },
    { id: 'gut',       name: 'Gut',       icon: '🌿', pillar: 'body', open: function () { switchView('gut'); } },
    { id: 'steps',     name: 'Steps',     icon: '👟', pillar: 'body', open: function () { switchView('steps'); } },
    { id: 'sleep',     name: 'Sleep',     icon: '😴', pillar: 'body', open: function () { switchView('sleep'); } },
    { id: 'body',      name: 'Body',      icon: '⚖️', pillar: 'body', open: function () { switchView('body'); } },
    { id: 'gym',       name: 'Gym Log',   icon: '🏋️', pillar: 'body', open: function () { switchView('gym'); } },
    { id: 'meds',      name: 'Meds',      icon: '💊', pillar: 'body', open: function () { switchView('meds'); } },
    { id: 'calc',      name: 'Calc',      icon: '🧮', pillar: 'body', open: function () { switchView('calc'); } },
    { id: 'journal',   name: 'Journal',   icon: '📓', pillar: 'mind', open: function () { switchView('journal'); } },
    { id: 'reading',   name: 'Reading',   icon: '📖', pillar: 'mind', open: function () { switchView('reading'); } },
    { id: 'breathe',   name: 'Breathe',   icon: '🫁', pillar: 'mind', open: function () { switchView('breathe'); } },
    { id: 'meditate',  name: 'Meditate',  icon: '🧘', pillar: 'mind', open: function () { switchView('meditate'); } },
    { id: 'manifest',  name: 'Manifest',  icon: '✨', pillar: 'mind', open: function () { switchView('manifest'); } },
    { id: 'detox',     name: 'Detox',     icon: '📵', pillar: 'mind', open: function () { switchView('detox'); } },
    { id: 'money',     name: 'Money',     icon: '💸', pillar: 'money', open: function () { switchView('money'); } },
    { id: 'subs',      name: 'Subs',      icon: '🔁', pillar: 'money', open: function () { switchView('subs'); } },
    { id: 'savings',   name: 'Savings',   icon: '🐷', pillar: 'money', open: function () { switchView('savings'); } },
    { id: 'us',        name: 'Us',        icon: '💞', pillar: 'life', open: function () { switchView('us'); } },
    { id: 'habits',    name: 'Habits',    icon: '🔗', pillar: 'life', open: function () { switchView('habits'); } },
    { id: 'work',      name: 'Work',      icon: '💼', pillar: 'life', open: function () { switchView('work'); } },
    { id: 'tasks',     name: 'Tasks',     icon: '✅', pillar: 'life', open: function () { switchView('tasks'); } },
    { id: 'goals',     name: 'Goals',     icon: '🎯', pillar: 'life', open: function () { switchView('goals'); } },
    { id: 'friends',   name: 'Friends',   icon: '👥', pillar: 'life', open: function () { switchView('board'); } },
    { id: 'coach',     name: 'Coach',     icon: '✨', pillar: 'life', open: function () { openCoach(); } },
    { id: 'stats',     name: 'Stats',     icon: '📈', pillar: 'life', open: function () { switchView('stats'); } },
    { id: 'journey',   name: 'Journey',   icon: '🗓️', pillar: 'life', open: function () { switchView('calendar'); } }
  ];
  var PILLARS = [
    { id: 'body', name: 'BODY', color: 'var(--body-c)' },
    { id: 'mind', name: 'MIND', color: 'var(--mind-c)' },
    { id: 'money', name: 'MONEY', color: 'var(--money-c)' },
    { id: 'life', name: 'LIFE', color: 'var(--life-c)' }
  ];

  function pctOf(a, b) { return b ? Math.min(100, Math.round(a / b * 100)) : 0; }
  function pillarScores() {
    var d = state.today || {};
    var taskPct = pctOf(completedCount(d), TOTAL_ITEMS);
    var waterPct = pctOf(Number(d.waterMl) || 0, WATER_GOAL);
    var body = Math.round(taskPct * 0.6 + waterPct * 0.4);
    // MIND — mood + reading
    var moodPct = d.mood ? Math.round(d.mood / 5 * 100) : null;
    var readPct = d.reading ? 100 : 0;
    var mind = moodPct == null ? readPct : Math.round(moodPct * 0.6 + readPct * 0.4);
    // LIFE — habits done + businesses worked today
    var habits = (state.profile && state.profile.customTasks) || [];
    var hPct = habits.length ? pctOf(habits.filter(function (h) { return d.extra && d.extra[h.id]; }).length, habits.length) : null;
    var bizList = businesses(), worked = 0;
    bizList.forEach(function (b) { var e = (d.biz || {})[b.id] || {}; if ((Number(e.m) || 0) > 0 || (Number(e.t) || 0) > 0) worked++; });
    var wPct = bizList.length ? pctOf(worked, bizList.length) : null;
    var lp = [hPct, wPct].filter(function (x) { return x != null; });
    var life = lp.length ? Math.round(lp.reduce(function (a, b) { return a + b; }, 0) / lp.length) : null;
    return { body: body, mind: mind, money: null, life: life }; // money apps arrive later
  }

  // Monthly average per pillar (0–100 | null) — the running month grade shown in
  // the home rings. Body/Mind/Life come from the day logs; Money is the budget
  // score (null when no budget / still loading).
  function pillarScoresMonthly(ym) {
    var sc = monthScores(ym);
    var money = moneyScoreFor(ym); // number | null | undefined
    return {
      body: sc ? sc.body : null,
      mind: sc ? sc.mind : null,
      money: (typeof money === 'number') ? money : null,
      life: sc ? sc.life : null
    };
  }

  function renderHome() {
    if (!state.user) return;
    var d = state.today || {};
    var cd = Math.max(1, chDay());
    var chip = $('#home-daychip');
    if (chip) chip.innerHTML = 'DAY ' + cd + (LEN && cd > LEN ? ' 🏆' : '') + ' · ' + streakOf(state.logs) + '🔥';

    // Gamification — level + XP progress bar, derived from history.
    var xt = xpTotals();
    var lvBox = $('#home-level');
    if (lvBox) {
      var li = levelInfo(xt.total);
      lvBox.innerHTML =
        '<div class="lv-top"><span class="lv-badge">LV ' + li.level + '</span>' +
          '<span class="lv-xp mono">' + xt.total.toLocaleString() + ' XP</span></div>' +
        '<div class="lv-bar"><span style="width:' + Math.min(100, li.pct) + '%"></span></div>' +
        '<div class="lv-sub muted tiny">' + li.inLevel + ' / ' + li.span + ' XP to LV ' + (li.level + 1) + '</div>';
      if (lastXpLevel === null) lastXpLevel = li.level;   // seed without firing a burst
    }
    renderChargeCard();

    // Top rings show this MONTH's average score per pillar (same source as the
    // Life Score card below), so they read as a running monthly grade — not just
    // today. Money loads async; ensureMoneyMonth is triggered by the score card.
    var homeYm = ymOf(todayStr());
    var sc = pillarScoresMonthly(homeYm);
    var plv = { body: pillarLevel(xt.body), mind: pillarLevel(xt.mind), money: pillarLevel(moneyXp()), life: pillarLevel(xt.life) };
    var ringsCap = $('#home-rings-cap');
    if (ringsCap) ringsCap.textContent = ymShort(homeYm) + ' · monthly average · skill levels';
    var rings = $('#home-rings');
    if (rings) {
      var circ = 2 * Math.PI * 26;
      rings.innerHTML = PILLARS.map(function (p) {
        var v = sc[p.id];
        var frac = v == null ? 0 : v / 100;
        var lvl = plv[p.id];   // all four pillars now carry a skill level
        return '<button class="pillar" data-pillar="' + p.id + '" style="--pc:' + p.color + '">' +
          '<span class="pring-wrap"><svg viewBox="0 0 64 64" class="pring">' +
          '<circle class="pring-bg" cx="32" cy="32" r="26"></circle>' +
          '<circle class="pring-fg" cx="32" cy="32" r="26" stroke-dasharray="' + circ + '" stroke-dashoffset="' + (circ * (1 - frac)) + '"></circle></svg>' +
          (lvl ? '<span class="pillar-lvl">L' + lvl + '</span>' : '') +
          '<span class="pillar-val">' + (v == null ? '—' : v) + '</span></span>' +
          '<span class="pillar-name eyebrow">' + p.name + '</span></button>';
      }).join('');
    }

    var brief = $('#home-brief');
    if (brief) {
      var parts = [];
      parts.push(completedCount(d) + '/' + TOTAL_ITEMS + ' tasks');
      parts.push(litres(Number(d.waterMl) || 0) + '/' + litres(WATER_GOAL) + ' L water');
      if (state.activeFast) parts.push('fasting');
      if (d.mood) parts.push('mood ' + d.mood + '/5');
      brief.innerHTML = '<span class="eyebrow">ATLAS Brief</span><div class="brief-line">' +
        (goalMet(d) ? '🎉 Day goal met — keep the streak alive.' : 'Today so far: ' + parts.join(' · ') + '.') + '</div>';
    }

    var spot = $('#home-spotlight');
    if (spot) {
      var left = TOTAL_ITEMS - completedCount(d);
      var html;
      if (!goalMet(d)) {
        var dayLine = !LEN ? 'Day ' + cd + ' · ' + activeCh().name
          : cd <= LEN ? 'Day ' + cd + ' of ' + LEN + ' · ' + activeCh().name
          : 'Day ' + cd + ' · ' + activeCh().name + ' conquered 🏆';
        html = '<span class="eyebrow">Spotlight · Challenge</span>' +
          '<div class="spot-big">' + left + ' task' + (left === 1 ? '' : 's') + ' left today</div>' +
          '<div class="muted tiny">' + dayLine + ' · ' + streakOf(state.logs) + '-day streak</div>' +
          '<button class="btn primary block spot-cta" data-qa="today">Open Challenge</button>';
      } else {
        html = '<span class="eyebrow">Spotlight · Coach</span>' +
          '<div class="spot-big">Nice work today 💪</div>' +
          '<div class="muted tiny">Ask your AI coach what to focus on next.</div>' +
          '<button class="btn primary block spot-cta" data-qa="coach">Ask Coach</button>';
      }
      spot.innerHTML = html;
    }

    // Attention balance — work vs connection this week, surfaced where you'll see it.
    renderBalance('#home-balance', true);

    // Relationship countdown — a small persistent nudge once dates are set.
    var relBox = $('#home-rel');
    if (relBox) {
      var cds = relCountdowns();
      if (!cds.length) relBox.classList.add('hidden');
      else {
        relBox.classList.remove('hidden');
        var near = cds[0];
        relBox.innerHTML = '<span class="eyebrow">💞 ' + esc(relInfo().partnerName || 'Us') + '</span>' +
          '<div class="rel-home-cd">' + near.emoji + ' <b>' + (near.days === 0 ? 'Today!' : near.days + ' days') + '</b> — ' + esc(near.label) + '</div>' +
          (cds[1] ? '<div class="muted tiny">' + cds[1].emoji + ' ' + cds[1].days + 'd — ' + esc(cds[1].label) + '</div>' : '');
        relBox.onclick = function () { switchView('us'); };
      }
    }

    // Life Score card — this month's game grade
    var scoreBox = $('#home-score');
    if (scoreBox) {
      var ym = ymOf(todayStr());
      ensureMoneyMonth(ym, function () {
        if (!$('#view-home').classList.contains('hidden')) renderHome();
      });
      var msc = monthScores(ym);
      if (!msc) scoreBox.classList.add('hidden');
      else {
        scoreBox.classList.remove('hidden');
        var money = moneyScoreFor(ym);
        var overall = monthOverall(ym);
        var og = gradeOf(overall);
        var minis = [
          ['Body', msc.body, 'var(--body-c)'], ['Mind', msc.mind, 'var(--mind-c)'],
          ['Money', money, 'var(--money-c)'], ['Life', msc.life, 'var(--life-c)']
        ];
        scoreBox.innerHTML =
          '<div class="mr-head">' +
            '<div><span class="eyebrow">Life Score · ' + ymShort(ym) + '</span>' +
            '<div class="hs-minis">' + minis.map(function (x) {
              var g = gradeOf(x[1]);
              return '<span class="hs-mini" style="--pc:' + x[2] + '">' + x[0] + ' <b class="gtext-' + g.cls + '">' + (x[1] === undefined ? '…' : g.g) + '</b></span>';
            }).join('') + '</div></div>' +
            '<div class="grade-badge g-' + og.cls + '">' + og.g + '</div>' +
          '</div>';
      }
    }

    var tiles = $('#home-tiles');
    if (tiles) {
      var t = [
        ['💧 Water', chHasWater() ? litres(Number(d.waterMl) || 0) + ' / ' + litres(WATER_GOAL) + ' L' : '—'],
        ['✓ Tasks', completedCount(d) + ' / ' + TOTAL_ITEMS],
        ['🔥 Streak', streakOf(state.logs) + ' days'],
        ['🏁 Challenge', activeCh().emoji + ' ' + activeCh().name]
      ];
      tiles.innerHTML = t.map(function (x) {
        return '<div class="htile"><div class="htile-lbl eyebrow">' + x[0] + '</div><div class="htile-val">' + x[1] + '</div></div>';
      }).join('');
    }
    buildMonthCalendar('#home-calendar', ymOf(todayStr()));
  }

  // Re-render every visible view that shows water, so a change reflects everywhere.
  function afterWaterChange(d) {
    if (d && d.date !== todayStr()) queueSaveDay(d); else queueSave();
    if (!$('#view-today').classList.contains('hidden')) renderToday();
    if (!$('#view-water').classList.contains('hidden')) renderWaterApp();
    if (!$('#view-home').classList.contains('hidden')) renderHome();
  }
  // Animated water jar — the level glides to the new value on every sip.
  var lastJarPct = -1;
  function waterNote(ml, pct) {
    if (pct >= 100) return 'Goal smashed — hydration king 👑';
    if (pct >= 75) return 'Almost there — one more push 💪';
    if (pct >= 50) return 'Halfway. Keep sipping 🌊';
    if (ml > 0) return 'Good start — stay on it.';
    return 'First sip of the day?';
  }
  // Shared jar SVG markup — used by the big Water-app jar and the small Today
  // jar. clipId must be unique per instance since both can be in the DOM at
  // once (other views stay mounted, just hidden).
  function jarYFor(p, h) { return Math.round(h * (1 - p / 100)); } // interior height -> translateY
  function jarSvgHtml(startY, extraClass, clipId) {
    return '<svg viewBox="0 0 150 200" class="jar' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true">' +
      '<defs><clipPath id="' + clipId + '"><rect x="25" y="24" width="100" height="150" rx="16"/></clipPath></defs>' +
      '<rect class="jar-lid" x="43" y="8" width="64" height="12" rx="6"/>' +
      '<rect class="jar-glass" x="25" y="24" width="100" height="150" rx="16"/>' +
      '<g clip-path="url(#' + clipId + ')"><g class="jar-water" style="transform:translateY(' + startY + 'px)">' +
        '<path class="wave w2" d="M0 30 Q 15 22, 30 30 T 60 30 T 90 30 T 120 30 T 150 30 T 180 30 T 210 30 T 240 30 T 270 30 T 300 30 V 240 H 0 Z"/>' +
        '<path class="wave w1" d="M0 32 Q 12 25, 24 32 T 48 32 T 72 32 T 96 32 T 120 32 T 144 32 T 168 32 T 192 32 T 216 32 T 240 32 T 264 32 T 288 32 V 240 H 0 Z"/>' +
        '<circle class="bub b1" cx="55" cy="150" r="3"/>' +
        '<circle class="bub b2" cx="82" cy="165" r="2.4"/>' +
        '<circle class="bub b3" cx="102" cy="145" r="2"/>' +
      '</g></g>' +
      '<rect class="jar-glass-line" x="25" y="24" width="100" height="150" rx="16"/>' +
      '<line class="jar-tick" x1="112" y1="61" x2="122" y2="61"/>' +
      '<line class="jar-tick" x1="112" y1="99" x2="122" y2="99"/>' +
      '<line class="jar-tick" x1="112" y1="136" x2="122" y2="136"/>' +
    '</svg>';
  }
  function waterQuickAdd(d, v) {
    var was = Number(d.waterMl) || 0;
    d.waterMl = Math.max(0, Math.min(WATER_GOAL * 3, was + v));
    if (was < WATER_GOAL && d.waterMl >= WATER_GOAL) toast('4 L done — goal smashed! 💧👑');
    afterWaterChange(d);
  }
  function bindWaterQuick(scope, d) {
    scope.querySelectorAll('[data-w]').forEach(function (b) {
      b.addEventListener('click', function () { waterQuickAdd(d, Number(b.getAttribute('data-w'))); });
    });
  }
  function renderWaterApp() {
    var box = $('#water-app'); if (!box) return;
    var rs = rangeState('water');
    if (rs.mode !== 'day') { renderWaterRange(box, rs); return; }
    var d = appDay();
    var ml = Number(d.waterMl) || 0, pct = pctOf(ml, WATER_GOAL);
    var prev = lastJarPct < 0 ? pct : lastJarPct;
    box.innerHTML = rangeBarHtml('water') + dayBarHtml();
    bindRangeBar(box, 'water', renderWaterApp);
    bindDayBar(box, renderWaterApp);
    // Loss mechanic: an untouched jar TODAY reads as dry/wilted — the cost of
    // inaction is visible on open, no notification needed.
    var dry = d.date === todayStr() && ml === 0;
    var card = el('div', 'card water-card' + (pct >= 100 ? ' full' : '') + (pct >= 20 ? ' has-water' : '') + (dry ? ' jar-dry' : ''));
    card.innerHTML =
      '<div class="jar-wrap">' +
        jarSvgHtml(jarYFor(prev, 150), '', 'jarclip-main') +
        '<div class="jar-side">' +
          '<div class="water-big"><b>' + litres(ml) + '</b> <span class="muted">/ ' + litres(WATER_GOAL) + ' L</span></div>' +
          '<div class="jar-pct mono">' + pct + '%</div>' +
          '<div class="muted tiny jar-note">' + waterNote(ml, pct) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="water-quick">' +
        '<button class="btn" data-w="250">+250 ml</button>' +
        '<button class="btn" data-w="500">+500 ml</button>' +
        '<button class="btn" data-w="1000">+1 L</button>' +
        '<button class="btn danger" data-w="-250">−250</button>' +
      '</div>';
    box.appendChild(card);
    // Two rAFs so the browser paints the previous level first, then glides.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      var w = card.querySelector('.jar-water');
      if (w) w.style.transform = 'translateY(' + jarYFor(pct, 150) + 'px)';
    }); });
    lastJarPct = pct;
    bindWaterQuick(card, d);
  }
  function renderWaterRange(box, rs) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { return l ? Number(l.waterMl) || 0 : 0; });
    var hits = agg.perDay.filter(function (p) { return p.date <= todayStr() && p.v >= WATER_GOAL; }).length;
    var pct = pctOf(agg.avg, WATER_GOAL);
    box.innerHTML = rangeBarHtml('water') +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, '#38bdf8', 92, '<b>' + litres(agg.avg) + '</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + litres(agg.avg) + ' L</b> <span class="muted">avg/day</span></div>' +
        '<div class="muted tiny">' + hits + ' of ' + agg.logged + ' day' + (agg.logged === 1 ? '' : 's') + ' hit ' + litres(WATER_GOAL) + ' L</div></div></div>' +
      '<div class="card"><div class="eyebrow">Water per day</div>' + rangeBarChart(agg.perDay, '#38bdf8', ' ml') + '</div>';
    bindRangeBar(box, 'water', renderWaterApp);
  }
  function renderReading() {
    var box = $('#reading-app'); if (!box) return;
    var d = appDay(), r = (state.profile && state.profile.reading) || {};
    box.innerHTML = dayBarHtml() +
      '<div class="card"><div class="eyebrow">' + (appDate() === todayStr() ? 'Today' : prettyDate(appDate())) + ' · 75 Hard</div>' +
        '<label class="fx-toggle" style="margin-top:8px"><input type="checkbox" id="reading-done"' + (d.reading ? ' checked' : '') + ' /> Read 10 pages</label></div>' +
      '<div class="card"><div class="eyebrow">Current book</div>' +
        '<label style="margin-top:8px">Title<input id="rd-book" value="' + esc(r.book || '') + '" placeholder="e.g. Atomic Habits" /></label>' +
        '<div class="manual-grid"><label>Current page<input id="rd-page" type="number" inputmode="numeric" value="' + (r.page || '') + '" /></label>' +
        '<label>Total pages<input id="rd-total" type="number" inputmode="numeric" value="' + (r.total || '') + '" /></label></div>' +
        (r.total ? '<div class="fc-bar" style="margin:6px 0 12px"><span style="width:' + pctOf(r.page || 0, r.total) + '%"></span></div><div class="muted tiny">Page ' + (r.page || 0) + ' / ' + r.total + ' · ' + pctOf(r.page || 0, r.total) + '%</div>' : '') +
        '<button id="rd-save" class="btn primary block" style="margin-top:10px">Save book</button></div>';
    bindDayBar(box, renderReading);
    $('#reading-done').addEventListener('change', function () { d.reading = this.checked; queueSaveDay(d); });
    $('#rd-save').addEventListener('click', function () {
      var prof = Object.assign({}, state.profile, { reading: { book: $('#rd-book').value.trim(), page: Number($('#rd-page').value) || 0, total: Number($('#rd-total').value) || 0 } });
      state.profile = prof;
      api('saveGoals', { profile: prof }).then(function (dd) { if (dd && dd.profile) state.profile = dd.profile; toast('Saved ✓'); renderReading(); }).catch(function (e) { toast(e.message); });
    });
  }

  /* ----- Steps / Sleep / Body — stored in day-log metrics {} ----- */
  function metricsOf(d) { if (!d.metrics) d.metrics = {}; return d.metrics; }
  function setMetric(k, v) { metricsOf(state.today)[k] = v; queueSave(); }
  // Small progress ring used by mini-app heroes.
  function ringMini(pct, color, size, inner) {
    var circ = 2 * Math.PI * 26;
    var off = circ * (1 - Math.min(100, Math.max(0, pct)) / 100);
    return '<span class="ring-mini" style="width:' + size + 'px;height:' + size + 'px">' +
      '<svg viewBox="0 0 64 64"><circle class="rm-bg" cx="32" cy="32" r="26"></circle>' +
      '<circle class="rm-fg" cx="32" cy="32" r="26" style="stroke:' + color + ';stroke-dasharray:' + circ + ';stroke-dashoffset:' + off + '"></circle></svg>' +
      '<span class="rm-center">' + inner + '</span></span>';
  }
  // Latest non-zero metric value on or before today, scanning back through logs.
  function lastMetric(key) {
    var today = todayStr();
    for (var i = state.logs.length - 1; i >= 0; i--) {
      var l = state.logs[i];
      if (l.date > today) continue;
      var v = l.metrics && Number(l.metrics[key]);
      if (v) return { v: v, date: l.date };
    }
    return null;
  }
  // First (earliest) non-zero metric value — the baseline.
  function firstMetric(key) {
    for (var i = 0; i < state.logs.length; i++) {
      var v = state.logs[i].metrics && Number(state.logs[i].metrics[key]);
      if (v) return { v: v, date: state.logs[i].date };
    }
    return null;
  }
  function metricTrend(key, sel, unit, div) {
    var box = $(sel); if (!box) return;
    var today = todayStr(), bars = '', max = 0, vals = [];
    for (var i = 6; i >= 0; i--) { var lg = logFor(addDays(today, -i)); var v = lg && lg.metrics ? Number(lg.metrics[key]) || 0 : 0; vals.push(v); if (v > max) max = v; }
    vals.forEach(function (v) {
      var h = max ? Math.max(4, Math.round(v / max * 46)) : 4;
      bars += '<div class="mbar" style="height:' + h + 'px"' + (v ? ' title="' + (div ? (v / div).toFixed(1) : v) + unit + '"' : '') + '></div>';
    });
    box.innerHTML = '<div class="mbars">' + bars + '</div><div class="muted tiny" style="margin-top:6px">Last 7 days</div>';
  }
  /* ================= Walk Mode — live pedometer (sensor + GPS) =================
     Web apps can't count steps in the background like Google Fit (that needs a
     native app). While ATLAS is open, though, we CAN: accelerometer peak
     detection counts steps, GPS measures distance, a wake-lock keeps the screen
     on, and ending the walk banks steps/kcal/minutes into the day log. */
  var walk = {
    running: false, steps: 0, km: 0, startAt: 0,
    lastStepAt: 0, gravity: 9.8, lastPos: null,
    watchId: null, wakeLock: null, tick: null, motionOn: false, gpsOn: false
  };
  function walkWeight() {
    return (lastMetric('weight') || {}).v || Number(state.profile && state.profile.weightKg) || 70;
  }
  // Calories: prefer GPS distance (0.53 kcal/kg/km walking), else per-step.
  function walkKcal() {
    var w = walkWeight();
    if (walk.km > 0.05) return walk.km * 0.53 * w;
    return walk.steps * 0.04 * (w / 70);
  }
  // Steps estimated from distance when motion sensors are unavailable.
  function walkStrideM() {
    var h = Number(state.profile && state.profile.heightCm) || 170;
    return h * 0.415 / 100;
  }
  function onWalkMotion(e) {
    var a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    var mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    // Slow-follow gravity baseline, then peak-detect the walking bounce.
    walk.gravity = walk.gravity * 0.94 + mag * 0.06;
    var dev = mag - walk.gravity;
    var now = Date.now();
    // A step: clear upward spike, at most ~3.3 steps/sec.
    if (dev > 1.1 && now - walk.lastStepAt > 300) {
      walk.lastStepAt = now;
      walk.steps++;
    }
  }
  function walkHaversine(a, b) {
    var R = 6371, toR = Math.PI / 180;
    var dLat = (b.latitude - a.latitude) * toR, dLon = (b.longitude - a.longitude) * toR;
    var s = Math.sin(dLat / 2), t = Math.sin(dLon / 2);
    var h = s * s + Math.cos(a.latitude * toR) * Math.cos(b.latitude * toR) * t * t;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function onWalkPos(pos) {
    var c = pos.coords;
    if (!c || c.accuracy > 35) return;  // ignore sloppy fixes
    if (walk.lastPos) {
      var km = walkHaversine(walk.lastPos, c);
      // Ignore jitter (< accuracy) and teleports (> 100 m in one fix).
      if (km * 1000 > Math.max(8, c.accuracy / 2) && km < 0.1) walk.km += km;
      else if (km >= 0.1) return; // teleport — don't move the anchor
    }
    walk.lastPos = { latitude: c.latitude, longitude: c.longitude };
  }
  function walkAcquireWakeLock() {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (wl) { walk.wakeLock = wl; }).catch(function () {});
    }
  }
  function startWalk() {
    var begin = function () {
      walk.running = true; walk.steps = 0; walk.km = 0; walk.lastPos = null;
      walk.startAt = Date.now(); walk.lastStepAt = 0; walk.gravity = 9.8;
      window.addEventListener('devicemotion', onWalkMotion);
      if (navigator.geolocation) {
        try {
          walk.watchId = navigator.geolocation.watchPosition(onWalkPos, function () { walk.gpsOn = false; },
            { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 });
          walk.gpsOn = true;
        } catch (e) { walk.gpsOn = false; }
      }
      walkAcquireWakeLock();
      document.addEventListener('visibilitychange', walkOnVisible);
      walk.tick = setInterval(walkUpdateLive, 1000);
      toast('Walk started — keep ATLAS open 🚶');
      renderSteps();
    };
    // iOS requires an in-gesture permission request for motion sensors.
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().then(function (res) {
        walk.motionOn = res === 'granted';
        begin();
      }).catch(function () { walk.motionOn = false; begin(); });
    } else {
      walk.motionOn = typeof DeviceMotionEvent !== 'undefined';
      begin();
    }
  }
  function walkOnVisible() {
    if (walk.running && document.visibilityState === 'visible') walkAcquireWakeLock();
  }
  function walkLiveSteps() {
    // No motion sensor? Estimate steps from GPS distance and stride length.
    if (!walk.motionOn || walk.steps < 5) {
      var est = Math.round(walk.km * 1000 / walkStrideM());
      if (est > walk.steps) return est;
    }
    return walk.steps;
  }
  function walkUpdateLive() {
    var elS = $('#walk-steps'), elK = $('#walk-kcal'), elM = $('#walk-min'), elD = $('#walk-km');
    if (!elS) return;
    var mins = Math.floor((Date.now() - walk.startAt) / 60000);
    var s = walkLiveSteps();
    elS.textContent = s.toLocaleString();
    elK.textContent = Math.round(walk.km > 0.05 ? walkKcal() : s * 0.04 * (walkWeight() / 70));
    elM.textContent = mins;
    if (elD) elD.textContent = walk.km >= 0.01 ? walk.km.toFixed(2) : '—';
  }
  function stopWalk(bank) {
    window.removeEventListener('devicemotion', onWalkMotion);
    document.removeEventListener('visibilitychange', walkOnVisible);
    if (walk.watchId != null && navigator.geolocation) { try { navigator.geolocation.clearWatch(walk.watchId); } catch (e) {} }
    if (walk.wakeLock) { try { walk.wakeLock.release(); } catch (e) {} walk.wakeLock = null; }
    if (walk.tick) { clearInterval(walk.tick); walk.tick = null; }
    walk.running = false;
    if (bank) {
      var s = walkLiveSteps();
      var mins = Math.max(1, Math.round((Date.now() - walk.startAt) / 60000));
      var kcal = Math.round(walkKcal());
      if (s > 0 || walk.km > 0.05) {
        var m = metricsOf(state.today);
        m.steps = (Number(m.steps) || 0) + s;
        m.burn = (Number(m.burn) || 0) + kcal;
        m.active = (Number(m.active) || 0) + mins;
        queueSave();
        toast('+' + s.toLocaleString() + ' steps · ' + kcal + ' kcal banked 🔥');
      } else {
        toast('No movement detected — nothing banked.');
      }
    }
    renderSteps();
  }
  function walkCardHtml() {
    if (appDate() !== todayStr()) return '';
    if (!walk.running) {
      return '<div class="card walk-card">' +
        '<div class="eyebrow">Walk mode · live tracker</div>' +
        '<p class="muted tiny" style="margin:8px 0 10px">Counts steps with your phone\'s motion sensor and distance via GPS while ATLAS is open — screen stays awake. Ends by banking steps, calories (from your logged weight) and active minutes into today. <b>Note:</b> web apps can\'t count in the background like Google Fit; keep the app open during the walk.</p>' +
        '<button id="walk-start" class="btn primary block">🚶 Start walk</button></div>';
    }
    return '<div class="card walk-card live">' +
      '<div class="eyebrow"><span class="walk-dot"></span> Walking · keep app open</div>' +
      '<div class="walk-grid">' +
        '<div><b id="walk-steps">' + walkLiveSteps().toLocaleString() + '</b><span>steps</span></div>' +
        '<div><b id="walk-kcal">' + Math.round(walkKcal()) + '</b><span>kcal</span></div>' +
        '<div><b id="walk-min">' + Math.floor((Date.now() - walk.startAt) / 60000) + '</b><span>min</span></div>' +
        '<div><b id="walk-km">' + (walk.km >= 0.01 ? walk.km.toFixed(2) : '—') + '</b><span>km' + (walk.gpsOn ? '' : ' (no GPS)') + '</span></div>' +
      '</div>' +
      (!walk.motionOn ? '<p class="muted tiny" style="margin:2px 0 8px">Motion sensor unavailable — steps estimated from GPS distance.</p>' : '') +
      '<div class="row-2"><button id="walk-stop" class="btn primary">✅ End &amp; bank</button>' +
      '<button id="walk-cancel" class="btn danger">Discard</button></div></div>';
  }

  function renderSteps() {
    var box = $('#steps-app'); if (!box) return;
    var goal = Number(state.profile && state.profile.stepGoal) || 10000;
    var rs = rangeState('steps');
    if (rs.mode !== 'day') { renderStepsRange(box, rs, goal); return; }
    var day = appDay(), m = metricsOf(day);
    var steps = Number(m.steps) || 0;
    var pct = pctOf(steps, goal);
    box.innerHTML = rangeBarHtml('steps') + dayBarHtml() +
      walkCardHtml() +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--body-c)', 92, '<b>' + pct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + steps.toLocaleString() + '</b></div>' +
        '<div class="muted tiny">of <button class="inline-edit" id="steps-goal-btn">' + goal.toLocaleString() + '</button> steps' +
        (pct >= 100 ? ' · crushed 🎉' : '') + '</div></div></div>' +
      '<div class="card"><div class="water-quick">' +
        '<button class="btn" data-s="1000">+1,000</button><button class="btn" data-s="2500">+2,500</button>' +
        '<button class="btn" data-s="5000">+5,000</button><button class="btn" data-s="set">Set exact</button></div>' +
      '<div class="manual-grid" style="margin-top:12px">' +
      '<label>Calories burned<input id="mt-burn" type="number" inputmode="numeric" value="' + (m.burn || '') + '" /></label>' +
      '<label>Active min<input id="mt-active" type="number" inputmode="numeric" value="' + (m.active || '') + '" /></label></div>' +
      '<button id="mt-save" class="btn block">Save</button></div>' +
      '<div class="card"><div class="eyebrow">Steps · last 7 days</div><div id="steps-trend"></div></div>';
    bindRangeBar(box, 'steps', renderSteps);
    bindDayBar(box, renderSteps);
    var ws = $('#walk-start'), we = $('#walk-stop'), wc = $('#walk-cancel');
    if (ws) ws.addEventListener('click', startWalk);
    if (we) we.addEventListener('click', function () { stopWalk(true); });
    if (wc) wc.addEventListener('click', function () { if (confirm('Discard this walk?')) stopWalk(false); });
    box.querySelectorAll('[data-s]').forEach(function (b) {
      b.addEventListener('click', function () {
        var v = b.getAttribute('data-s');
        if (v === 'set') { var x = prompt('Steps:', steps); if (x == null) return; m.steps = Math.max(0, Number(x) || 0); }
        else m.steps = steps + Number(v);
        queueSaveDay(day); renderSteps();
      });
    });
    $('#steps-goal-btn').addEventListener('click', function () {
      var x = prompt('Daily step goal:', goal); if (x == null) return;
      saveProfileKey('stepGoal', Math.max(1000, Number(x) || 10000), renderSteps);
    });
    $('#mt-save').addEventListener('click', function () { m.burn = Number($('#mt-burn').value) || 0; m.active = Number($('#mt-active').value) || 0; queueSaveDay(day); toast('Saved ✓'); });
    metricTrend('steps', '#steps-trend', '');
  }
  function renderStepsRange(box, rs, goal) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { return l && l.metrics ? Number(l.metrics.steps) || 0 : 0; });
    var burn = rangeAgg(r.from, r.to, function (l) { return l && l.metrics ? Number(l.metrics.burn) || 0 : 0; });
    var hits = agg.perDay.filter(function (p) { return p.v >= goal; }).length;
    var pct = pctOf(agg.avg, goal);
    box.innerHTML = rangeBarHtml('steps') +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--body-c)', 92, '<b>' + pct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + Math.round(agg.avg).toLocaleString() + '</b> <span class="muted">avg/day</span></div>' +
        '<div class="muted tiny">' + hits + ' of ' + agg.logged + ' days hit ' + goal.toLocaleString() + ' · ' + Math.round(burn.sum) + ' kcal total</div></div></div>' +
      '<div class="card"><div class="eyebrow">Steps per day</div>' + rangeBarChart(agg.perDay, 'var(--body-c)') + '</div>';
    bindRangeBar(box, 'steps', renderSteps);
  }
  function renderSleep() {
    var box = $('#sleep-app'); if (!box) return;
    var goalH = Number(state.profile && state.profile.sleepGoal) || 8;
    var rs = rangeState('sleep');
    if (rs.mode !== 'day') { renderSleepRange(box, rs, goalH); return; }
    var day = appDay(), m = metricsOf(day);
    var mins = Number(m.sleepMin) || 0;
    var pct = pctOf(mins, goalH * 60);
    var q = Number(m.sleepQ) || 0;
    var note = !mins ? 'Log last night to see your trend.'
      : mins >= goalH * 60 ? 'Fully charged 🔋' : mins >= goalH * 60 * 0.8 ? 'Decent — a little short.' : 'Running on fumes — sleep earlier tonight 😴';
    var win = (m.bedtime && m.waketime) ? '<div class="muted tiny" style="margin-top:2px">🌙 ' + esc(hhmm12(m.bedtime)) + ' → ☀️ ' + esc(hhmm12(m.waketime)) + (m.sleepSrc === 'screentime' ? ' · from Screen Time' : '') + '</div>' : '';
    box.innerHTML = rangeBarHtml('sleep') + dayBarHtml() +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + (mins ? Math.floor(mins / 60) + 'h' + (mins % 60 ? (mins % 60) + '' : '') : '—') + '</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + (mins ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : 'No log yet') + '</b></div>' +
        '<div class="muted tiny">goal <button class="inline-edit" id="sleep-goal-btn">' + goalH + 'h</button> · ' + note + '</div>' + win + '</div></div>' +
      '<button id="sl-screentime" class="btn block st-btn">📱 Auto-detect sleep from Screen Time</button>' +
      '<div class="card"><div class="manual-grid"><label>Hours<input id="sl-h" type="number" inputmode="numeric" value="' + (mins ? Math.floor(mins / 60) : '') + '" /></label>' +
      '<label>Minutes<input id="sl-m" type="number" inputmode="numeric" value="' + (mins ? mins % 60 : '') + '" /></label></div>' +
      '<div class="eyebrow" style="margin:6px 0 6px">Sleep quality</div>' +
      '<div class="star-row" id="sl-stars">' + [1, 2, 3, 4, 5].map(function (s) {
        return '<button class="star' + (q >= s ? ' on' : '') + '" data-star="' + s + '">★</button>';
      }).join('') + '</div>' +
      '<button id="sl-save" class="btn primary block" style="margin-top:10px">Save sleep</button></div>' +
      '<div class="card"><div class="eyebrow">Sleep · hours · last 7 days</div><div id="sleep-trend"></div></div>';
    $('#sleep-goal-btn').addEventListener('click', function () {
      var x = prompt('Sleep goal (hours):', goalH); if (x == null) return;
      saveProfileKey('sleepGoal', Math.min(14, Math.max(4, Number(x) || 8)), renderSleep);
    });
    $('#sl-screentime').addEventListener('click', function () { openScreenTimeUpload(renderSleep); });
    bindRangeBar(box, 'sleep', renderSleep);
    bindDayBar(box, renderSleep);
    box.querySelectorAll('[data-star]').forEach(function (b) {
      b.addEventListener('click', function () {
        // Update stars in place — a re-render would wipe unsaved hour/min inputs.
        m.sleepQ = Number(b.getAttribute('data-star'));
        box.querySelectorAll('[data-star]').forEach(function (s) {
          s.classList.toggle('on', Number(s.getAttribute('data-star')) <= m.sleepQ);
        });
        queueSaveDay(day);
      });
    });
    $('#sl-save').addEventListener('click', function () {
      m.sleepMin = (Number($('#sl-h').value) || 0) * 60 + (Number($('#sl-m').value) || 0);
      queueSaveDay(day); toast('Saved ✓'); renderSleep();
    });
    metricTrend('sleepMin', '#sleep-trend', 'h', 60);
  }
  function renderSleepRange(box, rs, goalH) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { return l && l.metrics ? Number(l.metrics.sleepMin) || 0 : 0; });
    var qAgg = rangeAgg(r.from, r.to, function (l) { return l && l.metrics && l.metrics.sleepQ ? Number(l.metrics.sleepQ) : null; });
    var hits = agg.perDay.filter(function (p) { return p.v >= goalH * 60; }).length;
    var pct = pctOf(agg.avg, goalH * 60);
    var avgH = Math.floor(agg.avg / 60), avgM = Math.round(agg.avg % 60);
    box.innerHTML = rangeBarHtml('sleep') +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + avgH + 'h</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + avgH + 'h ' + avgM + 'm</b> <span class="muted">avg/night</span></div>' +
        '<div class="muted tiny">' + hits + ' of ' + agg.logged + ' nights hit ' + goalH + 'h' + (qAgg.logged ? ' · ' + qAgg.avg.toFixed(1) + '★ avg quality' : '') + '</div></div></div>' +
      '<div class="card"><div class="eyebrow">Sleep hours per night</div>' + rangeBarChart(agg.perDay.map(function (p) { return { date: p.date, v: p.v / 60 }; }), 'var(--mind-c)', 'h', 1) + '</div>';
    bindRangeBar(box, 'sleep', renderSleep);
  }

  /* ================= Screen Time → sleep + phone usage =================
     Upload iOS/Android usage screenshots; Gemini reads total usage, top apps,
     and infers the overnight sleep window from the hourly chart. */
  function hmDur(min) {
    min = Math.round(Number(min) || 0);
    var h = Math.floor(min / 60), m = min % 60;
    return h ? (h + 'h' + (m ? ' ' + m + 'm' : '')) : (m + 'm');
  }
  function hhmm12(s) {
    var p = String(s || '').split(':'); if (p.length < 2) return s || '';
    var h = Number(p[0]), m = p[1];
    var ap = h >= 12 ? 'PM' : 'AM'; var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + ':' + m + ' ' + ap;
  }
  var stFileInput = null;
  function openScreenTimeUpload(afterApply) {
    state.stAfterApply = afterApply || null;
    if (!stFileInput) {
      stFileInput = document.createElement('input');
      stFileInput.type = 'file'; stFileInput.accept = 'image/*'; stFileInput.multiple = true;
      stFileInput.id = 'st-file'; stFileInput.style.display = 'none';
      document.body.appendChild(stFileInput);
      stFileInput.addEventListener('change', function () {
        var files = Array.prototype.slice.call(this.files || []);
        this.value = '';
        if (files.length) stAnalyse(files);
      });
    }
    // Intro screen inside the modal.
    $('#st-body').innerHTML =
      '<p class="muted tiny" style="margin:0 0 12px">Open <b>Settings → Screen Time → See All Activity</b> (or Android <b>Digital Wellbeing</b>), switch to the <b>Day</b> view, and screenshot each day. Upload up to 7 — the AI reads your total usage, top apps, and works out when you slept from the quiet overnight hours.</p>' +
      '<button id="st-pick" class="btn primary block">🖼️ Choose screenshots</button>' +
      '<p class="muted tiny center" style="margin-top:10px">Uses the AI scanner (Gemini). Logged under “Screen Time” in the API costs.</p>';
    show('#st-modal');
    $('#st-pick').addEventListener('click', function () { stFileInput.click(); });
    if (!openScreenTimeUpload.bound) {
      openScreenTimeUpload.bound = true;
      $('#st-close').addEventListener('click', function () { hide('#st-modal'); });
      $('#st-modal').addEventListener('click', function (e) { if (e.target.id === 'st-modal') hide('#st-modal'); });
    }
  }
  function stAnalyse(files) {
    $('#st-body').innerHTML = '<p class="muted tiny center" style="padding:20px 0">📱 Analysing ' + files.length + ' screenshot' + (files.length === 1 ? '' : 's') + '… this can take a few seconds.</p>';
    Promise.all(files.slice(0, 7).map(compressImage)).then(function (b64s) {
      return api('parseScreenTime', { images: b64s, mime: 'image/jpeg', todayIso: todayStr() });
    }).then(function (res) {
      stRenderResults((res && res.days) || []);
    }).catch(function (e) {
      $('#st-body').innerHTML = '<p class="muted tiny center" style="padding:16px 0">' + esc(e.message || 'Analysis failed.') + '</p>' +
        '<button id="st-retry" class="btn block">Try again</button>';
      $('#st-retry').addEventListener('click', function () { openScreenTimeUpload(state.stAfterApply); });
    });
  }
  function stRenderResults(days) {
    state.stDays = days;
    if (!days.length) {
      $('#st-body').innerHTML = '<p class="muted tiny center" style="padding:16px 0">Couldn’t read those as Screen Time screenshots. Try the <b>Day</b> view with the hourly chart visible.</p>' +
        '<button id="st-retry" class="btn block">Try again</button>';
      $('#st-retry').addEventListener('click', function () { openScreenTimeUpload(state.stAfterApply); });
      return;
    }
    var html = days.map(function (d, i) {
      var conf = d.sleepConfidence >= 0.66 ? 'high' : d.sleepConfidence >= 0.33 ? 'medium' : 'low';
      var apps = (d.topApps || []).slice(0, 3).map(function (a) { return esc(a.name) + ' ' + hmDur(a.minutes); }).join(' · ');
      return '<div class="card st-day">' +
        '<div class="st-day-head"><b>' + (d.date ? esc(prettyDate(d.date)) : 'Unknown day') + '</b>' +
          '<span class="mono">📱 ' + hmDur(d.totalMinutes) + '</span></div>' +
        (d.sleepMinutes
          ? '<div class="st-sleep"><span class="st-sleep-main">😴 ' + hmDur(d.sleepMinutes) + ' sleep</span>' +
            '<span class="muted tiny">' + esc(hhmm12(d.sleepStart)) + ' → ' + esc(hhmm12(d.sleepEnd)) + '</span>' +
            '<span class="st-conf st-' + conf + '">' + conf + ' confidence</span></div>'
          : '<p class="muted tiny" style="margin:6px 0">No clear sleep window detected in the chart.</p>') +
        (apps ? '<div class="muted tiny" style="margin-top:6px">Top: ' + apps + '</div>' : '') +
        '<button class="btn block st-apply" data-stapply="' + i + '"' + (d.date ? '' : ' disabled') + ' style="margin-top:10px">Apply to ' + (d.date ? shortDate(d.date) : 'day') + '</button>' +
      '</div>';
    }).join('');
    var applicable = days.filter(function (d) { return d.date; }).length;
    $('#st-body').innerHTML =
      '<p class="muted tiny" style="margin:0 0 10px">Review, then apply. Sleep goes to the <b>Sleep</b> app, phone usage to <b>Detox</b>.</p>' +
      html +
      (applicable > 1 ? '<button id="st-apply-all" class="btn primary block">✓ Apply all ' + applicable + ' days</button>' : '');
    $('#st-body').querySelectorAll('[data-stapply]').forEach(function (b) {
      b.addEventListener('click', function () {
        b.textContent = 'Saving…'; b.disabled = true;
        stApplyDay(state.stDays[Number(b.getAttribute('data-stapply'))]).then(function () {
          b.textContent = 'Applied ✓';
        }).catch(function (e) {
          b.textContent = 'Retry — not saved'; b.disabled = false; toast('Didn’t save: ' + e.message);
        });
      });
    });
    var all = $('#st-apply-all');
    if (all) all.addEventListener('click', function () {
      var days = state.stDays.filter(function (d) { return d.date; });
      all.textContent = 'Saving…'; all.disabled = true;
      Promise.all(days.map(function (d) { return stApplyDay(d).then(function () { return true; }).catch(function () { return false; }); })).then(function (results) {
        var ok = results.filter(Boolean).length, failed = results.length - ok;
        toast(ok + ' day' + (ok === 1 ? '' : 's') + ' applied ✓' + (failed ? ' · ' + failed + ' failed, still shown locally' : ''));
        hide('#st-modal');
        if (state.stAfterApply) state.stAfterApply();
      });
    });
  }
  function stApplyDay(dd) {
    if (!dd || !dd.date) return Promise.resolve();
    var d = logFor(dd.date);
    if (!d) { d = emptyDay(dd.date); state.logs.push(d); state.logs.sort(function (a, b) { return a.date < b.date ? -1 : 1; }); }
    var m = d.metrics || (d.metrics = {});
    if (dd.totalMinutes) m.screenMin = dd.totalMinutes;
    if (dd.topApps && dd.topApps.length) m.screenApps = dd.topApps.slice(0, 4);
    if (dd.categories && dd.categories.length) m.screenCats = dd.categories.slice(0, 6);
    if (dd.sleepMinutes) {
      m.sleepMin = dd.sleepMinutes; m.bedtime = dd.sleepStart; m.waketime = dd.sleepEnd; m.sleepSrc = 'screentime';
    }
    d.completed = goalMet(d);
    upsertLocal(d);
    if (!$('#view-sleep').classList.contains('hidden')) renderSleep();
    if (!$('#view-detox').classList.contains('hidden')) renderDetox();
    return api('saveDay', { day: Object.assign({}, d) });
  }

  /* ----- Body metric engine: series, trend, chart ----- */
  var BODY_METRICS = [
    { k: 'weight',  label: 'Weight', unit: 'kg', dec: 1, downGood: true },
    { k: 'bodyfat', label: 'Fat',    unit: '%',  dec: 1, downGood: true },
    { k: 'waist',   label: 'Waist',  unit: 'cm', dec: 0, downGood: true },
    { k: 'chest',   label: 'Chest',  unit: 'cm', dec: 0, downGood: false },
    { k: 'arms',    label: 'Arms',   unit: 'cm', dec: 0, downGood: false },
    { k: 'hips',    label: 'Hips',   unit: 'cm', dec: 0, downGood: true },
    { k: 'neck',    label: 'Neck',   unit: 'cm', dec: 0, downGood: true }
  ];
  function bodyMetricDef(k) { return BODY_METRICS.filter(function (x) { return x.k === k; })[0] || BODY_METRICS[0]; }
  // Body fat for a day: manual reading wins; otherwise auto-computed with the
  // U.S. Navy formula from that day's tape measurements + profile height/sex.
  function bodyfatOf(l) {
    if (!l || !l.metrics) return 0;
    var v = Number(l.metrics.bodyfat);
    if (v) return v;
    var est = navyBodyFat(
      (state.profile && state.profile.sex) || '',
      Number(state.profile && state.profile.heightCm) || 0,
      Number(l.metrics.neck) || 0,
      Number(l.metrics.waist) || 0,
      Number(l.metrics.hips) || 0
    );
    return est && est > 0 && est < 75 ? Math.round(est * 10) / 10 : 0;
  }
  // All logged points for a metric, oldest → newest. Body fat auto-fills from
  // measurements on days without a manual reading, so the trend "just works".
  function metricSeries(key) {
    var today = todayStr(), out = [];
    (state.logs || []).forEach(function (l) {
      if (l.date > today) return;
      var v = key === 'bodyfat' ? bodyfatOf(l) : (l.metrics && Number(l.metrics[key]));
      if (v) out.push({ date: l.date, v: v });
    });
    return out;
  }
  // Least-squares slope in units/week over the last `days` (default 42).
  function metricTrendWk(key, days) {
    var cut = addDays(todayStr(), -(days || 42));
    var pts = metricSeries(key).filter(function (p) { return p.date >= cut; });
    if (pts.length < 3) return null;
    var x0 = parseDateLocal(pts[0].date);
    var sx = 0, sy = 0, sxx = 0, sxy = 0, n = pts.length;
    pts.forEach(function (p) {
      var x = (parseDateLocal(p.date) - x0) / 864e5;
      sx += x; sy += p.v; sxx += x * x; sxy += x * p.v;
    });
    var denom = n * sxx - sx * sx;
    if (!denom) return null;
    return (n * sxy - sx * sy) / denom * 7;
  }
  function parseDateLocal(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime(); }

  // Mock-style area chart for any body metric: gradient fill, start/trend/today axis.
  function bodyChartSvg(def) {
    var pts = metricSeries(def.k);
    if (pts.length < 2) return '<p class="muted tiny" style="margin:10px 0 4px">Log ' + def.label.toLowerCase() + ' on a few days to unlock the trend chart.</p>';
    var min = pts[0].v, max = pts[0].v;
    pts.forEach(function (p) { if (p.v < min) min = p.v; if (p.v > max) max = p.v; });
    var padV = Math.max(def.dec ? 0.5 : 1, (max - min) * 0.2); min -= padV; max += padV;
    var t0 = parseDateLocal(pts[0].date), t1 = parseDateLocal(pts[pts.length - 1].date);
    var span = Math.max(1, t1 - t0);
    var W = 320, H = 96, L = 4, R = 4, T = 8, B = 6;
    var X = function (p) { return L + (parseDateLocal(p.date) - t0) / span * (W - L - R); };
    var Y = function (v) { return T + (1 - (v - min) / (max - min)) * (H - T - B); };
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p).toFixed(1) + ' ' + Y(p.v).toFixed(1); }).join(' ');
    var area = line + ' L' + X(pts[pts.length - 1]).toFixed(1) + ' ' + (H - B) + ' L' + X(pts[0]).toFixed(1) + ' ' + (H - B) + ' Z';
    var last = pts[pts.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" class="bchart" preserveAspectRatio="none">' +
      '<defs><linearGradient id="bgrad" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="var(--green)" stop-opacity=".28"/>' +
        '<stop offset="100%" stop-color="var(--green)" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<path class="bc-area" d="' + area + '"/><path class="bc-line" d="' + line + '"/>' +
      '<circle class="bc-end" cx="' + X(last).toFixed(1) + '" cy="' + Y(last.v).toFixed(1) + '" r="3.5"/>' +
    '</svg>';
  }

  // Latest value + change since the first log of that metric.
  function metricNow(key) {
    var s = metricSeries(key);
    if (!s.length) return null;
    var first = s[0], last = s[s.length - 1];
    return { v: last.v, delta: s.length > 1 ? last.v - first.v : null, firstV: first.v, firstDate: first.date };
  }

  // Auto insight: trend + recomposition + ETA to goal weight.
  function bodyInsight(goal) {
    var bits = [];
    var w = metricNow('weight'), tw = metricTrendWk('weight');
    var wa = metricNow('waist'), ch = metricNow('chest');
    var waistDown = wa && wa.delta != null && wa.delta < 0;
    var chestUp = ch && ch.delta != null && ch.delta > 0;
    if (waistDown && chestUp) {
      bits.push('Waist down ' + Math.abs(wa.delta).toFixed(0) + ' cm, chest up ' + ch.delta.toFixed(0) + ' cm — that’s recomposition, not just loss');
    } else if (waistDown) {
      bits.push('Waist down ' + Math.abs(wa.delta).toFixed(0) + ' cm since day 1');
    }
    if (tw != null && Math.abs(tw) >= 0.05) {
      bits.push('weight trending ' + (tw < 0 ? '−' : '+') + Math.abs(tw).toFixed(2) + ' kg/wk');
    }
    if (goal && w && tw != null && Math.abs(tw) >= 0.05) {
      var gap = goal - w.v;
      if (gap * tw > 0) { // moving toward the goal
        var daysToGoal = Math.round(gap / (tw / 7));
        if (daysToGoal > 0 && daysToGoal < 400) {
          var eta = parse(addDays(todayStr(), daysToGoal)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          bits.push('on pace for ' + goal + ' kg by ' + eta);
        }
      }
    }
    if (!bits.length) return null;
    var s = bits.join(' — ');
    return s.charAt(0).toUpperCase() + s.slice(1) + '.';
  }

  // Shared U.S. Navy circumference body-fat formula — used by Body's live
  // estimate AND the Calculators app, so both always agree.
  function navyBodyFat(sex, heightCm, neck, waist, hip) {
    if (!heightCm || !neck || !waist) return null;
    if (sex === 'female') {
      if (!hip) return null;
      return 495 / (1.29579 - 0.35004 * log10(waist + hip - neck) + 0.22100 * log10(heightCm)) - 450;
    }
    if (waist - neck <= 0) return null;
    return 495 / (1.0324 - 0.19077 * log10(waist - neck) + 0.15456 * log10(heightCm)) - 450;
  }

  function renderBody() {
    var box = $('#body-app'); if (!box) return;
    var day = appDay(), m = metricsOf(day);
    var goal = Number(state.profile && state.profile.weightGoal) || 0;
    var heightCm = Number(state.profile && state.profile.heightCm) || 0;
    var sex = (state.profile && state.profile.sex) || '';
    var neckV = Number(m.neck) || (lastMetric('neck') || {}).v || 0;
    var waistV = Number(m.waist) || (lastMetric('waist') || {}).v || 0;
    var hipV = Number(m.hips) || (lastMetric('hips') || {}).v || 0;
    // Manual reading for THIS day wins; otherwise the Navy estimate kicks in
    // (metricSeries already auto-computes past days from their measurements).
    var manualBf = Number(m.bodyfat) || 0;
    var autoBf = manualBf ? null : navyBodyFat(sex, heightCm, neckV, waistV, hipV);

    // Selected hero metric (chips at top switch it).
    if (!state.bodyMetric) state.bodyMetric = 'weight';
    var def = bodyMetricDef(state.bodyMetric);
    var now = metricNow(def.k);
    // Fat has a computed fallback when never logged manually.
    if (!now && def.k === 'bodyfat' && autoBf) now = { v: autoBf, delta: null, firstV: null, firstDate: null };
    var cur = now ? now.v : 0;
    var heroDelta = now && now.delta != null && Math.abs(now.delta) >= 0.05 ? now.delta : null;
    var deltaGood = heroDelta != null && ((heroDelta < 0) === def.downGood);
    var tw = metricTrendWk(def.k);
    var bmiW = metricNow('weight');
    var bmi = bmiW && heightCm ? bmiW.v / Math.pow(heightCm / 100, 2) : 0;
    var bmiTag = !bmi ? '' : bmi < 18.5 ? 'underweight' : bmi < 25 ? 'healthy' : bmi < 30 ? 'overweight' : 'obese';
    var series = metricSeries(def.k);
    var insight = bodyInsight(goal);

    box.innerHTML = dayBarHtml() +
      // Metric selector
      '<div class="bm-chips">' + BODY_METRICS.map(function (x) {
        return '<button type="button" class="bm-chip' + (x.k === def.k ? ' active' : '') + '" data-bm="' + x.k + '">' + x.label + '</button>';
      }).join('') + '</div>' +
      // Hero: current value + delta + area chart
      '<div class="card body-hero2">' +
        '<div class="bh2-top"><span class="eyebrow">Current · ' + def.label + '</span>' +
          (def.k === 'weight' && goal ? '<span class="eyebrow">Goal ' + goal + ' kg</span>' : '') + '</div>' +
        '<div class="bh2-main">' +
          '<div class="bh2-val"><b>' + (cur ? cur.toFixed(def.dec) : '—') + '</b><span class="bh2-unit">' + def.unit + '</span>' +
            (!manualBf && def.k === 'bodyfat' && cur ? '<span class="muted tiny" style="margin-left:6px">Navy est.</span>' : '') + '</div>' +
          (heroDelta != null ? '<div class="bh2-delta ' + (deltaGood ? 'good' : 'warn') + '">' +
            (heroDelta < 0 ? '−' : '+') + Math.abs(heroDelta).toFixed(def.dec) + ' ' + def.unit +
            '<small>since day 1</small></div>' : '') +
        '</div>' +
        bodyChartSvg(def) +
        (series.length >= 2 ?
          '<div class="bh2-axis mono">' +
            '<span>' + parse(series[0].date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase() + ' · ' + series[0].v.toFixed(def.dec) + '</span>' +
            '<span>' + (tw != null ? 'TREND ' + (tw < 0 ? '−' : '+') + Math.abs(tw).toFixed(2) + ' ' + def.unit.toUpperCase() + '/WK' : '') + '</span>' +
            '<span>TODAY</span>' +
          '</div>' : '') +
      '</div>' +
      // Comparison tiles for every other metric (tap = switch)
      '<div class="bm-tiles">' + BODY_METRICS.filter(function (x) { return x.k !== def.k; }).map(function (x) {
        var n = metricNow(x.k);
        if (!n && x.k === 'bodyfat' && autoBf) n = { v: autoBf, delta: null, est: true };
        var dTxt = n && n.delta != null && Math.abs(n.delta) >= 0.05
          ? '<span class="bmt-delta ' + (((n.delta < 0) === x.downGood) ? 'good' : 'warn') + '">' + (n.delta < 0 ? '−' : '+') + Math.abs(n.delta).toFixed(x.dec) + '</span>' : '';
        return '<button type="button" class="bm-tile" data-bm="' + x.k + '">' +
          '<span class="eyebrow">' + x.label + '</span>' +
          '<span class="bmt-val">' + (n ? (n.est ? '~' : '') + n.v.toFixed(x.dec) : '—') + ' <small>' + x.unit + '</small>' + dTxt + '</span></button>';
      }).join('') +
        (bmi ? '<button type="button" class="bm-tile" data-bm="weight"><span class="eyebrow">BMI</span><span class="bmt-val">' + bmi.toFixed(1) + ' <small>' + bmiTag + '</small></span></button>' : '') +
      '</div>' +
      // Insight
      (insight ? '<div class="card body-insight"><span class="bi-ico">◆</span><span>' + insight + '</span></div>' : '') +
      '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Log this day</div>' +
        '<div class="manual-grid">' +
        '<label>Weight (kg)<input id="bd-w" type="number" inputmode="decimal" value="' + (m.weight || '') + '" /></label>' +
        '<label>Body fat (%) <span class="muted tiny">auto if blank</span><input id="bd-bf" type="number" inputmode="decimal" value="' + (m.bodyfat || '') + '" placeholder="' + (autoBf ? autoBf.toFixed(1) : 'auto') + '" />' +
        '<span id="bd-bf-hint" class="muted tiny bf-hint"></span></label>' +
        '<label>Neck (cm)<input id="bd-neck" type="number" inputmode="decimal" value="' + (m.neck || '') + '" /></label>' +
        '<label>Waist (cm)<input id="bd-waist" type="number" inputmode="decimal" value="' + (m.waist || '') + '" /></label>' +
        '<label>Chest (cm)<input id="bd-chest" type="number" inputmode="decimal" value="' + (m.chest || '') + '" /></label>' +
        '<label>Arms (cm)<input id="bd-arms" type="number" inputmode="decimal" value="' + (m.arms || '') + '" /></label>' +
        '<label>Hips (cm)<input id="bd-hips" type="number" inputmode="decimal" value="' + (m.hips || '') + '" /></label>' +
        '</div>' +
        '<div class="manual-grid">' +
        '<label>Sex <span class="muted tiny">for BMR/body-fat calcs</span><select id="bd-sex"><option value="">—</option><option value="male"' + (sex === 'male' ? ' selected' : '') + '>Male</option><option value="female"' + (sex === 'female' ? ' selected' : '') + '>Female</option></select></label>' +
        '<label>Height (cm)<input id="bd-height" type="number" inputmode="decimal" value="' + (heightCm || '') + '" /></label>' +
        '<label>Goal weight (kg)<input id="bd-goal" type="number" inputmode="decimal" value="' + (goal || '') + '" /></label>' +
        '</div>' +
        '<p class="muted tiny" style="margin:4px 2px 10px">These feed straight into the <b>Calc</b> app — log once here, use everywhere.</p>' +
        '<button id="bd-save" class="btn primary block">Log this day</button></div>';
    bindDayBar(box, renderBody);
    box.querySelectorAll('[data-bm]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.bodyMetric = b.getAttribute('data-bm');
        renderBody();
        window.scrollTo(0, 0);
      });
    });
    // Live Navy estimate while typing — updates the moment the inputs allow it.
    function bfLive() {
      var hint = $('#bd-bf-hint'); if (!hint) return;
      if (Number($('#bd-bf').value)) { hint.textContent = 'Using your manual reading — clear it to auto-calculate.'; return; }
      var sx = $('#bd-sex').value;
      var est = navyBodyFat(sx,
        Number($('#bd-height').value) || 0,
        Number($('#bd-neck').value) || 0,
        Number($('#bd-waist').value) || 0,
        Number($('#bd-hips').value) || 0);
      if (est && est > 0 && est < 75) {
        hint.textContent = '≈ ' + est.toFixed(1) + '% auto (US Navy) — used automatically when left blank';
        $('#bd-bf').placeholder = est.toFixed(1);
      } else {
        hint.textContent = 'Auto-calculates from sex, height, neck, waist' + (sx === 'female' ? ' & hips' : '') + ' — fill those in.';
      }
    }
    ['#bd-bf', '#bd-neck', '#bd-waist', '#bd-hips', '#bd-height'].forEach(function (s) {
      var e2 = $(s); if (e2) e2.addEventListener('input', bfLive);
    });
    $('#bd-sex').addEventListener('change', bfLive);
    bfLive();
    $('#bd-save').addEventListener('click', function () {
      m.weight = Number($('#bd-w').value) || 0; m.waist = Number($('#bd-waist').value) || 0; m.bodyfat = Number($('#bd-bf').value) || 0;
      m.neck = Number($('#bd-neck').value) || 0;
      m.chest = Number($('#bd-chest').value) || 0; m.arms = Number($('#bd-arms').value) || 0; m.hips = Number($('#bd-hips').value) || 0;
      state.profile = Object.assign({}, state.profile, {
        sex: $('#bd-sex').value || state.profile.sex || '',
        weightGoal: Number($('#bd-goal').value) || 0,
        heightCm: Number($('#bd-height').value) || 0
      });
      queueSaveDay(day);   // reports its own "Saved ✓" once the day metrics are confirmed
      api('saveGoals', { profile: state.profile }).then(function (d) {
        if (d && d.profile) state.profile = d.profile;
      }).catch(function (e) { toast('Profile fields didn’t save: ' + e.message); });
      renderBody();
    });
  }

  /* ================= Gym Log (Body) =================
     Hevy/Strong-style per-set logging. Entry shape: { n, sets: [{r, w, s}, …], tm }.
     `r` = reps, `w` = added weight in kg, `s` = seconds (held/worked) for
     time-based moves. `tm` on the entry forces time mode (1) or rep mode (0),
     overriding the library default, so any exercise can be timed. Legacy
     entries ({ n, sets: 3, reps: 10, kg: 40 }) are normalized on read. */
  // Categorised exercise library (like the food database).
  // Row shape: [name, bodyweight?, timeBased?]
  var GYM_LIBRARY = {
    'Chest':     [['Bench Press'], ['Incline Bench Press'], ['Dumbbell Press'], ['Incline Dumbbell Press'], ['Chest Fly'], ['Cable Fly'], ['Push-ups', 1], ['Dips', 1], ['Machine Chest Press']],
    'Back':      [['Deadlift'], ['Barbell Row'], ['Pull-ups', 1], ['Chin-ups', 1], ['Lat Pulldown'], ['Seated Row'], ['T-Bar Row'], ['Dumbbell Row'], ['Face Pulls'], ['Back Extension', 1], ['Dead Hang', 1, 1]],
    'Shoulders': [['Overhead Press'], ['Shoulder Press'], ['Arnold Press'], ['Lateral Raise'], ['Front Raise'], ['Rear Delt Fly'], ['Upright Row'], ['Shrugs']],
    'Arms':      [['Bicep Curl'], ['Hammer Curl'], ['Preacher Curl'], ['Concentration Curl'], ['Tricep Pushdown'], ['Overhead Tricep Extension'], ['Skull Crushers'], ['Close-grip Bench Press'], ['Cable Curl']],
    'Legs':      [['Squat'], ['Front Squat'], ['Leg Press'], ['Romanian Deadlift'], ['Lunges'], ['Bulgarian Split Squat'], ['Leg Extension'], ['Leg Curl'], ['Calf Raise'], ['Hip Thrust'], ['Goblet Squat'], ['Wall Sit', 1, 1]],
    'Core':      [['Plank', 1, 1], ['Side Plank', 1, 1], ['Hollow Hold', 1, 1], ['Crunches', 1], ['Sit-ups', 1], ['Leg Raise', 1], ['Russian Twist', 1], ['Cable Crunch'], ['Hanging Knee Raise', 1], ['Mountain Climbers', 1]],
    'Cardio':    [['Running', 1, 1], ['Cycling', 1, 1], ['Rowing', 1, 1], ['Jump Rope', 1, 1], ['Elliptical', 1, 1], ['Stair Climber', 1, 1], ['Walking', 1, 1], ['Swimming', 1, 1]],
    'Full Body': [['Clean & Press'], ['Kettlebell Swing'], ['Burpees', 1], ['Thrusters'], ['Farmer Carry', 0, 1], ['Battle Ropes', 1, 1], ['Box Jumps', 1]]
  };
  // Flat lookup: name -> { cat, bw, tm }
  var GYM_INDEX = (function () {
    var idx = {};
    Object.keys(GYM_LIBRARY).forEach(function (cat) {
      GYM_LIBRARY[cat].forEach(function (row) { idx[row[0]] = { cat: cat, bw: !!row[1], tm: !!row[2] }; });
    });
    return idx;
  })();
  function gymIsBodyweight(name) { var i = GYM_INDEX[name]; return i ? i.bw : false; }
  // Time mode: the entry's own `tm` wins (set by the ⏱ toggle), else the
  // library default, else fall back to name-matching so custom-typed names
  // like "Plank hold" or "Wall sit 60s" still log in seconds.
  function gymIsTimedName(name) {
    var i = GYM_INDEX[name];
    if (i) return i.tm;
    return /plank|wall ?sit|hold|hang|carry|jump ?rope|run|cycl|row(ing)?\b|swim|walk|elliptical|stair/i.test(String(name || ''));
  }
  function gymIsTimed(e) {
    if (e && e.tm != null) return !!e.tm;
    return gymIsTimedName(e && e.n);
  }
  // "45s" / "1:30" / "1:05:00" — compact, readable hold durations.
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    if (sec < 60) return sec + 's';
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }
  function gymOf(d) { var m = metricsOf(d); if (!m.gym) m.gym = []; return m.gym; }
  function gymExercises() { return (state.profile && state.profile.gymExercises) || []; }
  function gymSetsOf(e) {
    if (Array.isArray(e.sets)) return e.sets;
    var out = [], n = Math.max(1, Number(e.sets) || 1);
    for (var i = 0; i < n; i++) out.push({ r: Number(e.reps) || 0, w: Number(e.kg) || 0 });
    return out;
  }
  // Migrate a legacy entry in place so set edits stick.
  function gymEnsureSets(e) { if (!Array.isArray(e.sets)) { e.sets = gymSetsOf(e); delete e.reps; delete e.kg; } return e.sets; }
  /* ---- Bodyweight load ----
     A push-up moves real weight, but the bar is your own body, so logging it
     with kg = 0 made every bodyweight session count as 0 volume. Each movement
     lifts a known FRACTION of bodyweight (a push-up ≈ 64% — the rest is carried
     by your feet), so effective load = bodyweight × fraction + any added weight
     (vest, belt, dumbbell). These are the standard biomechanics estimates.
     Volume is derived at read time, never stored, so every past workout is
     recalculated the moment this ships — no backfill needed. */
  var GYM_BW_LOAD = {
    'push-ups': 0.64, 'dips': 0.95, 'pull-ups': 1, 'chin-ups': 1, 'dead hang': 1,
    'squat': 0.65, 'lunges': 0.65, 'bulgarian split squat': 0.85, 'wall sit': 0.65,
    'box jumps': 0.65, 'burpees': 0.65, 'mountain climbers': 0.6,
    'crunches': 0.3, 'sit-ups': 0.35, 'russian twist': 0.3, 'leg raise': 0.35,
    'hanging knee raise': 0.35, 'plank': 0.6, 'side plank': 0.55, 'hollow hold': 0.45,
    'back extension': 0.45, 'battle ropes': 0.15, 'jump rope': 0.35,
    'running': 0.35, 'walking': 0.2, 'cycling': 0.15, 'rowing': 0.25,
    'swimming': 0.25, 'elliptical': 0.2, 'stair climber': 0.4
  };
  // Isometric holds have no reps, so convert time to rep-equivalents at a
  // steady 3 s per rep — the usual convention for scoring a hold against
  // rep-based work, and what keeps one "volume" number in consistent units.
  var GYM_SEC_PER_REP = 3;
  function gymBodyLoadFactor(name) {
    var k = String(name || '').trim().toLowerCase();
    if (GYM_BW_LOAD[k] != null) return GYM_BW_LOAD[k];
    // Normalize punctuation/spacing so "Push ups"/"pushups"/"Diamond Push-Ups"
    // all resolve, then fall back to a substring match for prefixed variants.
    var flat = k.replace(/[^a-z]/g, '');
    var keys = Object.keys(GYM_BW_LOAD);
    for (var i = 0; i < keys.length; i++) {
      var kf = keys[i].replace(/[^a-z]/g, '');
      if (flat === kf || flat.indexOf(kf) >= 0) return GYM_BW_LOAD[keys[i]];
    }
    return 0.65;   // unknown bodyweight move — assume a compound, most are
  }
  // Bodyweight as of a given date: what you actually weighed then, so old
  // sessions aren't rescored using today's weight. Falls back forward to the
  // earliest weigh-in, then the profile value, then a neutral 70 kg.
  function bodyWeightAsOf(date) {
    var logs = state.logs || [], best = 0;
    for (var i = 0; i < logs.length; i++) {
      var v = logs[i].metrics && Number(logs[i].metrics.weight);
      if (!v) continue;
      if (logs[i].date <= date) best = v;          // logs are date-sorted
      else if (!best) { best = v; break; }         // only ever weighed in later
    }
    return best || Number(state.profile && state.profile.weightKg) || 70;
  }
  // Does this movement carry bodyweight? Library moves say so directly; a
  // custom-typed name counts as bodyweight only while no kg has been entered,
  // so "Sled Push @ 60kg" isn't inflated by a phantom bodyweight component.
  function gymCarriesBodyweight(name, added) {
    if (gymIsBodyweight(name)) return true;
    return GYM_INDEX[name] == null && !added;
  }
  // Effective load for one set: added weight plus the share of bodyweight the
  // movement actually lifts (0 for machine/barbell work, where kg IS the load).
  function gymSetLoad(e, st, bw) {
    var added = Number(st.w) || 0;
    return gymCarriesBodyweight(e.n, added) ? added + bw * gymBodyLoadFactor(e.n) : added;
  }
  // Reps, or rep-equivalents for a timed hold.
  function gymSetReps(e, st) {
    if (gymIsTimed(e)) return (Number(st.s) || 0) / GYM_SEC_PER_REP;
    return Number(st.r) || 0;
  }
  function gymEntryVol(e, bw) {
    if (bw == null) bw = bodyWeightAsOf(todayStr());
    return gymSetsOf(e).reduce(function (s, x) {
      return s + gymSetReps(e, x) * gymSetLoad(e, x, bw);
    }, 0);
  }
  function gymEntryBest(e) {
    return gymSetsOf(e).reduce(function (m, x) { return Math.max(m, Number(x.w) || 0); }, 0);
  }
  // Longest set of a timed exercise, in seconds — the PR that matters for holds.
  function gymEntryBestHold(e) {
    return gymSetsOf(e).reduce(function (m, x) { return Math.max(m, Number(x.s) || 0); }, 0);
  }
  function gymVolOf(l) {
    if (!l || !l.metrics || !l.metrics.gym) return 0;
    var bw = bodyWeightAsOf(l.date);
    return l.metrics.gym.reduce(function (s, e) { return s + gymEntryVol(e, bw); }, 0);
  }
  function gymSetCountOf(l) {
    if (!l || !l.metrics || !l.metrics.gym) return 0;
    return l.metrics.gym.reduce(function (s, e) { return s + gymSetsOf(e).length; }, 0);
  }
  function gymPRs() {
    var prs = {};
    (state.logs || []).forEach(function (l) {
      ((l.metrics && l.metrics.gym) || []).forEach(function (e) {
        var k = String(e.n || '').trim(); if (!k) return;
        gymSetsOf(e).forEach(function (st) {
          var w = Number(st.w) || 0;
          if (!prs[k] || w > prs[k].kg) prs[k] = { kg: w, reps: Number(st.r) || 0, date: l.date };
        });
      });
    });
    return prs;
  }
  function lastGymDay() {
    var today = todayStr();
    for (var i = state.logs.length - 1; i >= 0; i--) {
      var l = state.logs[i];
      if (l.date >= today) continue;
      if (l.metrics && l.metrics.gym && l.metrics.gym.length) return l;
    }
    return null;
  }
  // Most recent logged entry for an exercise before `beforeDate` — powers the
  // "prev" hints and prefills a newly-added exercise with last session's sets.
  function gymLastEntry(name, beforeDate) {
    for (var i = state.logs.length - 1; i >= 0; i--) {
      var l = state.logs[i];
      if (l.date >= beforeDate) continue;
      var hit = ((l.metrics && l.metrics.gym) || []).filter(function (e) { return e.n === name; })[0];
      if (hit) return hit;
    }
    return null;
  }
  function gymRememberExercise(name) {
    if (GYM_INDEX[name] || gymExercises().indexOf(name) >= 0) return;
    var p = Object.assign({}, state.profile);
    p.gymExercises = gymExercises().concat([name]).slice(-60);
    state.profile = p;
    api('saveGoals', { profile: p }).catch(function () {});
  }
  // How often each exercise has been logged — powers "recent / frequent".
  function gymFreq() {
    var f = {};
    (state.logs || []).forEach(function (l) {
      ((l.metrics && l.metrics.gym) || []).forEach(function (e) { f[e.n] = (f[e.n] || 0) + 1; });
    });
    return f;
  }
  // Headline label for an exercise, adaptive to how it's logged: a timed hold
  // leads with total time, a bodyweight move with total reps, and both append
  // the volume load now that bodyweight counts toward it. Barbell/machine work
  // is unchanged — "1,250 kg vol".
  function gymEntrySummary(e, bw) {
    var sets = gymSetsOf(e);
    var vol = gymEntryVol(e, bw);
    var volTxt = vol > 0 ? Math.round(vol).toLocaleString() + ' kg vol' : '';
    if (gymIsTimed(e)) {
      var secs = sets.reduce(function (s, x) { return s + (Number(x.s) || 0); }, 0);
      return fmtDur(secs) + (volTxt ? ' · ' + volTxt : '');
    }
    var reps = sets.reduce(function (s, x) { return s + (Number(x.r) || 0); }, 0);
    var lifted = sets.some(function (x) { return (Number(x.w) || 0) > 0; });
    if (lifted) return volTxt || (reps + ' rep' + (reps === 1 ? '' : 's'));
    return reps + ' rep' + (reps === 1 ? '' : 's') + (volTxt ? ' · ' + volTxt : '');
  }
  // Matches "Push-ups", "Push ups", "Diamond push-ups", etc. — any variant,
  // not just the exact library spelling — so the daily count tile doesn't
  // miss custom-typed entries.
  function gymIsPushupName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z]/g, '').indexOf('pushup') >= 0;
  }
  function gymPushupTotal(list) {
    var total = 0;
    (list || []).forEach(function (e) {
      if (!gymIsPushupName(e.n)) return;
      gymSetsOf(e).forEach(function (s) { total += Number(s.r) || 0; });
    });
    return total;
  }
  // Whether an exercise has ever been logged with real weight — used to pick
  // the right unit (reps vs kg) for its trend chart, independent of whether
  // it's in the built-in library (custom-typed names have no GYM_INDEX entry).
  function gymExerciseIsBodyweight(name) {
    if (gymIsBodyweight(name)) return true;
    var hasWeight = false;
    (state.logs || []).forEach(function (l) {
      ((l.metrics && l.metrics.gym) || []).forEach(function (e) {
        if (e.n !== name || hasWeight) return;
        gymSetsOf(e).forEach(function (s) { if ((Number(s.w) || 0) > 0) hasWeight = true; });
      });
    });
    return !hasWeight;
  }
  // Whether an exercise is logged in seconds — checks the library/name default
  // AND what's actually on record, so an entry the user flipped to ⏱ still
  // charts as time.
  function gymExerciseIsTimed(name) {
    if (gymIsTimedName(name)) return true;
    var timed = false;
    (state.logs || []).forEach(function (l) {
      ((l.metrics && l.metrics.gym) || []).forEach(function (e) {
        if (e.n === name && e.tm) timed = true;
      });
    });
    return timed;
  }
  // Per-day value for one exercise across a range: total seconds for a timed
  // hold, total reps for a bodyweight movement, total volume load otherwise.
  function gymExerciseMetricOf(name, bw, timed) {
    return function (l) {
      if (!l || !l.metrics || !l.metrics.gym) return 0;
      var entries = l.metrics.gym.filter(function (e) { return e.n === name; });
      if (!entries.length) return 0;
      var key = timed ? 's' : 'r';
      if (timed || bw) return entries.reduce(function (s, e) { return s + gymSetsOf(e).reduce(function (s2, st) { return s2 + (Number(st[key]) || 0); }, 0); }, 0);
      return entries.reduce(function (s, e) { return s + gymEntryVol(e, bodyWeightAsOf(l.date)); }, 0);
    };
  }
  // Exercises the user has ever logged, most-frequent first — powers the
  // trend dropdown regardless of what's in the currently-viewed range.
  function gymAllExerciseNames() {
    var freq = gymFreq();
    return Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
  }

  // Rest timer — survives re-renders, chimes when done.
  var gymRest = { left: 0, tick: null };
  function gymRestStop() { if (gymRest.tick) { clearInterval(gymRest.tick); gymRest.tick = null; } gymRest.left = 0; }
  function gymRestStart(sec) {
    gymRestStop();
    gymRest.left = sec;
    gymRest.tick = setInterval(function () {
      gymRest.left--;
      var e2 = $('#gym-rest-left');
      if (e2) e2.textContent = Math.floor(gymRest.left / 60) + ':' + pad(Math.max(0, gymRest.left) % 60);
      if (gymRest.left <= 0) {
        gymRestStop();
        meditChime();
        toast('Rest over — next set 💪');
        renderGym();
      }
    }, 1000);
    renderGym();
  }

  function renderGym() {
    var box = $('#gym-app'); if (!box) return;
    var rs = rangeState('gym');
    if (rs.mode !== 'day') { renderGymRange(box, rs); return; }
    var day = appDay();
    var list = gymOf(day);
    var vol = gymVolOf(day), setCount = gymSetCountOf(day);
    var dayBw = bodyWeightAsOf(day.date);
    var pushups = gymPushupTotal(list);
    // "This week" = the calendar week (Mon-first) the viewed day sits in,
    // counted only up to today — NOT a rolling 7-day window, which used to
    // bleed in last week's sessions and could read 6/7 on a Wednesday.
    var today = todayStr(), wk = rangeWeekOf(day.date);
    var wkEnd = wk.to < today ? wk.to : today;
    var weekDays = 0;
    for (var d = wk.from; d <= wkEnd; d = addDays(d, 1)) {
      var l = logFor(d);
      if (l && l.metrics && l.metrics.gym && l.metrics.gym.length) weekDays++;
    }
    var prs = gymPRs();
    var names = Object.keys(prs);
    var isToday = appDate() === todayStr();
    var prev = lastGymDay();
    // Quick-add chips: your most-frequently-logged exercises (not already in today's list).
    var freq = gymFreq();
    var inList = {}; list.forEach(function (e) { inList[e.n] = 1; });
    var recent = Object.keys(freq).filter(function (n) { return !inList[n]; })
      .sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 8);

    box.innerHTML = rangeBarHtml('gym') + dayBarHtml() +
      (list.length ? '<button id="gym-done" class="btn primary block gym-done">✓ Save workout</button>' : '') +
      '<div class="card"><div class="gym-stats">' +
        '<div class="js-stat"><b>' + list.length + '</b><span>exercises</span></div>' +
        '<div class="js-stat"><b>' + setCount + '</b><span>sets</span></div>' +
        '<div class="js-stat"><b>' + (vol ? (vol >= 1000 ? (vol / 1000).toFixed(1) + 't' : Math.round(vol) + 'kg') : '0') + '</b><span>volume</span></div>' +
        '<div class="js-stat"><b>' + pushups + '</b><span>push-ups</span></div>' +
        '<div class="js-stat"><b>' + weekDays + '/7</b><span>this week</span></div>' +
      '</div>' +
      (vol ? '<p class="muted tiny" style="margin:8px 0 0">Volume counts bodyweight moves at ' + Math.round(dayBw) + ' kg body weight — a push-up is ' +
        Math.round(GYM_BW_LOAD['push-ups'] * 100) + '% of it, a pull-up 100%.</p>' : '') +
      '</div>' +
      (isToday ?
        '<div class="card gym-rest">' +
          (gymRest.left > 0
            ? '<span class="eyebrow"><span class="walk-dot"></span> Resting</span><b id="gym-rest-left" class="mono">' + Math.floor(gymRest.left / 60) + ':' + pad(gymRest.left % 60) + '</b><button class="btn fr-mini" id="gym-rest-stop">Skip</button>'
            : '<span class="eyebrow">⏱ Rest timer</span>' + [60, 90, 120].map(function (s) {
                return '<button class="btn fr-mini" data-rest="' + s + '">' + s + 's</button>';
              }).join('')) +
        '</div>' : '') +
      // Workout — one card per exercise, one row per set
      (list.length ? list.map(function (e, i) {
        var sets = gymSetsOf(e);
        var timed = gymIsTimed(e);
        var best = gymEntryBest(e);
        var pr = prs[e.n] && best >= prs[e.n].kg && best > 0;
        var last = gymLastEntry(e.n, day.date);
        // PREV = last session's AVERAGE across all its sets — avg weight ×
        // avg reps, or the avg hold for a timed move. One "last time" benchmark,
        // shown identically on every row.
        var pv = '—';
        if (last) {
          var ls = gymSetsOf(last);
          if (ls.length) {
            if (timed) {
              var ss = 0;
              ls.forEach(function (s) { ss += Number(s.s) || 0; });
              pv = ss ? fmtDur(ss / ls.length) : '—';
            } else {
              var sw = 0, sr = 0;
              ls.forEach(function (s) { sw += Number(s.w) || 0; sr += Number(s.r) || 0; });
              var aw = Math.round(sw / ls.length), ar = Math.round(sr / ls.length);
              pv = (aw ? aw : '—') + '×' + ar;
            }
          }
        }
        return '<div class="card gx-card">' +
          '<div class="gx-head">' +
            '<b class="gx-name" data-gxedit="' + i + '">' + esc(e.n) + '</b>' + (pr ? ' <span class="pr-badge">PR 🏅</span>' : '') +
            '<span class="gx-vol mono">' + gymEntrySummary(e, dayBw) + '</span>' +
            '<button class="icon-mini gx-timebtn' + (timed ? ' on' : '') + '" data-gxtime="' + i + '" title="' +
              (timed ? 'Switch to reps' : 'Switch to timed (seconds)') + '">' + (timed ? '⏱' : '#') + '</button>' +
            '<button class="icon-mini gx-editbtn" data-gxedit="' + i + '" title="Rename">✎</button>' +
            '<button class="list-del" data-gxdel="' + i + '">✕</button></div>' +
          '<div class="gx-row gx-lbls"><span>SET</span><span>PREV avg</span><span>KG</span><span>' +
            (timed ? 'SECS' : 'REPS') + '</span><span></span></div>' +
          sets.map(function (st, j) {
            var held = Number(st.s) || 0;
            return '<div class="gx-row">' +
              '<span class="gx-num mono">' + (j + 1) + '</span>' +
              '<span class="gx-prev mono">' + pv + '</span>' +
              '<input class="gx-in" type="number" inputmode="decimal" value="' + (st.w || '') + '" placeholder="0" data-gx="' + i + ':' + j + ':w" />' +
              (timed
                ? '<input class="gx-in" type="number" inputmode="numeric" value="' + (held || '') + '" placeholder="0" data-gx="' + i + ':' + j + ':s" />'
                : '<input class="gx-in" type="number" inputmode="numeric" value="' + (st.r || '') + '" placeholder="0" data-gx="' + i + ':' + j + ':r" />') +
              '<button class="list-del gx-sdel" data-sdel="' + i + ':' + j + '">✕</button>' +
            '</div>' +
            // Anything past a minute is hard to read as raw seconds — echo it back.
            (timed && held >= 60 ? '<div class="gx-hint mono">' + fmtDur(held) + '</div>' : '');
          }).join('') +
          '<button class="gx-addset" data-addset="' + i + '">＋ Add set</button>' +
        '</div>';
      }).join('') : '<div class="card"><p class="muted tiny" style="margin:0">Nothing logged ' + (isToday ? 'yet — pick an exercise below and hit your first set 💪' : 'on this day.') + '</p></div>') +
      // Add exercise — opens the searchable library picker (like the food app)
      '<button id="gym-add-open" class="btn primary block gx-addex">＋ Add exercise</button>' +
      (recent.length ? '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Quick add · your regulars</div>' +
        '<div class="gx-chips">' + recent.map(function (n) {
          return '<button type="button" class="starter-chip gx-chip" data-gadd="' + esc(n) + '">' + esc(n) + '</button>';
        }).join('') + '</div></div>' : '') +
      (!list.length && prev ? '<button id="gym-copy" class="btn block" style="margin-bottom:14px">↻ Repeat ' + shortDate(prev.date) + ' workout (' + prev.metrics.gym.length + ' lifts)</button>' : '') +
      (names.length ? '<div class="card"><div class="eyebrow" style="margin-bottom:4px">Personal records · heaviest set</div>' +
        names.sort(function (a, b) { return prs[b].kg - prs[a].kg; }).slice(0, 8).map(function (n) {
          return '<div class="list-row"><div><b>' + esc(n) + '</b><div class="muted tiny">' + shortDate(prs[n].date) + (prs[n].reps ? ' · ×' + prs[n].reps : '') + '</div></div>' +
            '<span class="mono">' + prs[n].kg + ' kg</span></div>';
        }).join('') + '</div>' : '');

    bindRangeBar(box, 'gym', renderGym);
    bindDayBar(box, renderGym);

    function addExercise(name) {
      name = String(name || '').trim().slice(0, 40);
      if (!name) return;
      var last = gymLastEntry(name, day.date);
      var timed = last ? gymIsTimed(last) : gymIsTimedName(name);
      var sets = last
        ? gymSetsOf(last).map(function (s) { return { r: Number(s.r) || 0, w: Number(s.w) || 0, s: Number(s.s) || 0 }; })
        : [timed ? { r: 0, w: 0, s: 30 } : { r: 10, w: 0, s: 0 }];
      var entry = { n: name, sets: sets };
      // Carry the previous entry's explicit rep/time choice forward.
      if (last && last.tm != null) entry.tm = last.tm;
      else if (timed) entry.tm = 1;
      gymOf(day).push(entry);
      gymRememberExercise(name);
      queueSaveDay(day);
      toast(last ? name + ' added — last session loaded, beat it 🔥' : name + ' added');
      renderGym();
    }
    gymAddExercise = addExercise;   // expose so the picker modal can add
    box.querySelectorAll('[data-gadd]').forEach(function (b) {
      b.addEventListener('click', function () { addExercise(b.getAttribute('data-gadd')); });
    });
    var openBtn = $('#gym-add-open');
    if (openBtn) openBtn.addEventListener('click', openGymPicker);
    var doneBtn = $('#gym-done');
    if (doneBtn) doneBtn.addEventListener('click', function () {
      queueSaveDay(day); pushToday(false);
      toast('Workout saved ✓'); window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    // Rename an exercise (tap the name or the pencil).
    box.querySelectorAll('[data-gxedit]').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = list[Number(b.getAttribute('data-gxedit'))]; if (!e) return;
        var v = prompt('Rename exercise:', e.n);
        if (v == null) return;
        v = v.trim().slice(0, 40); if (!v) return;
        e.n = v; gymRememberExercise(v);
        queueSaveDay(day); renderGym();
      });
    });

    // Flip one exercise between reps and timed seconds. Seeds a sensible first
    // hold so the row isn't blank, and remembers the choice on the entry.
    box.querySelectorAll('[data-gxtime]').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = list[Number(b.getAttribute('data-gxtime'))]; if (!e) return;
        var now = gymIsTimed(e);
        e.tm = now ? 0 : 1;
        var sets = gymEnsureSets(e);
        if (!now) sets.forEach(function (st) { if (!(Number(st.s) || 0)) st.s = 30; });
        else sets.forEach(function (st) { if (!(Number(st.r) || 0)) st.r = 10; });
        queueSaveDay(day);
        toast(e.n + (now ? ' → reps' : ' → timed (seconds) ⏱'));
        renderGym();
      });
    });

    // Per-set weight/rep/time edits — save on change (blur), PR toast when beaten.
    box.querySelectorAll('[data-gx]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var pk = inp.getAttribute('data-gx').split(':');
        var e = list[Number(pk[0])]; if (!e) return;
        var sets = gymEnsureSets(e);
        var st = sets[Number(pk[1])]; if (!st) return;
        var v = Math.max(0, Number(inp.value) || 0);
        var prevBest = prs[e.n] ? prs[e.n].kg : 0;
        var prevHold = gymEntryBestHold(e);
        if (pk[2] === 'w') st.w = v;
        else if (pk[2] === 's') st.s = v;
        else st.r = v;
        queueSaveDay(day);
        if (pk[2] === 'w' && v > 0 && v > prevBest) toast('New PR on ' + e.n + ' — ' + v + ' kg! 🏅');
        if (pk[2] === 's' && v > 0 && v > prevHold) toast('Longest ' + e.n + ' yet — ' + fmtDur(v) + '! 🏅');
        renderGym();
      });
    });
    box.querySelectorAll('[data-addset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var e = list[Number(b.getAttribute('data-addset'))]; if (!e) return;
        var sets = gymEnsureSets(e);
        var lastSet = sets[sets.length - 1] || { r: 10, w: 0, s: 0 };
        sets.push({ r: Number(lastSet.r) || 0, w: Number(lastSet.w) || 0, s: Number(lastSet.s) || 0 });
        queueSaveDay(day); renderGym();
      });
    });
    box.querySelectorAll('[data-sdel]').forEach(function (b) {
      b.addEventListener('click', function () {
        var pk = b.getAttribute('data-sdel').split(':');
        var e = list[Number(pk[0])]; if (!e) return;
        var sets = gymEnsureSets(e);
        sets.splice(Number(pk[1]), 1);
        if (!sets.length) list.splice(Number(pk[0]), 1);
        queueSaveDay(day); renderGym();
      });
    });
    box.querySelectorAll('[data-gxdel]').forEach(function (b) {
      b.addEventListener('click', function () {
        list.splice(Number(b.getAttribute('data-gxdel')), 1);
        queueSaveDay(day); renderGym();
      });
    });
    box.querySelectorAll('[data-rest]').forEach(function (b) {
      b.addEventListener('click', function () { gymRestStart(Number(b.getAttribute('data-rest'))); });
    });
    var rstop = $('#gym-rest-stop');
    if (rstop) rstop.addEventListener('click', function () { gymRestStop(); renderGym(); });
    var copyBtn = $('#gym-copy');
    if (copyBtn) copyBtn.addEventListener('click', function () {
      prev.metrics.gym.forEach(function (e) {
        var copy = { n: e.n, sets: gymSetsOf(e).map(function (s) { return { r: Number(s.r) || 0, w: Number(s.w) || 0, s: Number(s.s) || 0 }; }) };
        if (e.tm != null) copy.tm = e.tm;
        gymOf(day).push(copy);
      });
      queueSaveDay(day); toast('Workout copied — beat it today 🔥'); renderGym();
    });
  }
  function renderGymRange(box, rs) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, gymVolOf);
    var setsAgg = rangeAgg(r.from, r.to, gymSetCountOf);
    var trained = agg.perDay.filter(function (p) { return p.v > 0; }).length;

    var exNames = gymAllExerciseNames();
    if (state.gymExSel && exNames.indexOf(state.gymExSel) < 0) state.gymExSel = '';
    var sel = state.gymExSel || '';

    var exBlock = '';
    if (sel) {
      var timedEx = gymExerciseIsTimed(sel);
      var bw = gymExerciseIsBodyweight(sel);
      var exAgg = rangeAgg(r.from, r.to, gymExerciseMetricOf(sel, bw, timedEx));
      var unit = timedEx ? ' s' : (bw ? ' reps' : ' kg');
      var noun = timedEx ? 'time' : (bw ? 'reps' : 'volume');
      var sessions = exAgg.hits;
      var avgSession = sessions ? Math.round(exAgg.sum / sessions) : 0;
      exBlock = '<div class="card"><div class="gym-stats">' +
          '<div class="js-stat"><b>' + sessions + '</b><span>sessions</span></div>' +
          '<div class="js-stat"><b>' + (timedEx ? fmtDur(exAgg.sum) : Math.round(exAgg.sum).toLocaleString()) + '</b><span>total' + (timedEx ? ' time' : (bw ? ' reps' : ' kg')) + '</span></div>' +
          '<div class="js-stat"><b>' + (timedEx ? fmtDur(avgSession) : avgSession) + '</b><span>avg/session</span></div>' +
        '</div></div>' +
        '<div class="card"><div class="eyebrow">' + esc(sel) + ' — ' + noun + ' per day</div>' + rangeBarChart(exAgg.perDay, 'var(--body-c)', unit) + '</div>';
    }

    box.innerHTML = rangeBarHtml('gym') +
      '<div class="card"><div class="gym-stats">' +
        '<div class="js-stat"><b>' + trained + '/' + agg.days + '</b><span>days trained</span></div>' +
        '<div class="js-stat"><b>' + Math.round(setsAgg.sum) + '</b><span>total sets</span></div>' +
        '<div class="js-stat"><b>' + (agg.sum >= 1000 ? (agg.sum / 1000).toFixed(1) + 't' : Math.round(agg.sum) + 'kg') + '</b><span>total volume</span></div>' +
        '<div class="js-stat"><b>' + (agg.avg >= 1000 ? (agg.avg / 1000).toFixed(1) + 't' : Math.round(agg.avg) + 'kg') + '</b><span>avg/day</span></div>' +
      '</div></div>' +
      '<div class="card"><div class="eyebrow">Volume per day</div>' + rangeBarChart(agg.perDay, 'var(--body-c)', ' kg') + '</div>' +
      (exNames.length ? '<div class="card"><div class="eyebrow" style="margin-bottom:8px">📈 Trend for one exercise</div>' +
        '<select id="gym-ex-sel" class="gym-ex-select">' +
          '<option value="">Pick an exercise…</option>' +
          exNames.map(function (n) { return '<option value="' + esc(n) + '"' + (n === sel ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') +
        '</select></div>' : '') +
      exBlock;

    bindRangeBar(box, 'gym', renderGym);
    var selEl = $('#gym-ex-sel');
    if (selEl) selEl.addEventListener('change', function () { state.gymExSel = this.value; renderGymRange(box, rs); });
  }

  /* ----- Exercise picker modal (searchable library, like the food app) ----- */
  var gymAddExercise = null;                 // set by renderGym (closes over the active day)
  var gymPicker = { q: '', cat: 'All' };
  function openGymPicker() {
    gymBindPickerOnce();
    gymPicker.q = ''; gymPicker.cat = 'All';
    $('#gym-search').value = '';
    gymRenderPickerCats();
    gymRenderPickerResults();
    show('#gym-modal');
    setTimeout(function () { $('#gym-search').focus(); }, 100);
  }
  function gymBindPickerOnce() {
    if (gymBindPickerOnce.done) return; gymBindPickerOnce.done = true;
    $('#gym-modal-close').addEventListener('click', function () { hide('#gym-modal'); });
    $('#gym-modal').addEventListener('click', function (e) { if (e.target.id === 'gym-modal') hide('#gym-modal'); });
    $('#gym-search').addEventListener('input', function () { gymPicker.q = this.value; gymRenderPickerResults(); });
    var addCustom = function () {
      var v = $('#gym-modal-custom').value.trim(); if (!v) return;
      $('#gym-modal-custom').value = ''; hide('#gym-modal');
      if (gymAddExercise) gymAddExercise(v);
    };
    $('#gym-modal-custom-add').addEventListener('click', addCustom);
    $('#gym-modal-custom').addEventListener('keydown', function (e) { if (e.key === 'Enter') addCustom(); });
  }
  function gymRenderPickerCats() {
    var cats = ['All'].concat(Object.keys(GYM_LIBRARY));
    var hasCustom = gymExercises().some(function (n) { return !GYM_INDEX[n]; });
    if (hasCustom) cats.push('Mine');
    $('#gym-cats').innerHTML = cats.map(function (c) {
      return '<button type="button" class="gym-cat' + (c === gymPicker.cat ? ' active' : '') + '" data-gcat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    $('#gym-cats').querySelectorAll('[data-gcat]').forEach(function (b) {
      b.addEventListener('click', function () {
        gymPicker.cat = b.getAttribute('data-gcat');
        gymRenderPickerCats(); gymRenderPickerResults();
      });
    });
  }
  function gymRenderPickerResults() {
    var box = $('#gym-results'); if (!box) return;
    var q = gymPicker.q.toLowerCase().trim();
    var items = [], freq = gymFreq();
    var lib = function () {
      var all = [];
      Object.keys(GYM_LIBRARY).forEach(function (cat) { GYM_LIBRARY[cat].forEach(function (row) { all.push({ n: row[0], cat: cat, bw: !!row[1] }); }); });
      gymExercises().forEach(function (n) { if (!GYM_INDEX[n]) all.push({ n: n, cat: 'Mine', bw: false }); });
      return all;
    };
    if (q) {
      items = lib().filter(function (x) { return x.n.toLowerCase().indexOf(q) >= 0; });
    } else if (gymPicker.cat === 'Mine') {
      items = gymExercises().slice().reverse().map(function (n) { return { n: n, cat: GYM_INDEX[n] ? GYM_INDEX[n].cat : 'Custom', bw: gymIsBodyweight(n) }; });
    } else if (gymPicker.cat === 'All') {
      var seen = {};
      Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).forEach(function (n) {
        seen[n] = 1; items.push({ n: n, cat: GYM_INDEX[n] ? GYM_INDEX[n].cat : 'Custom', bw: gymIsBodyweight(n), freq: true });
      });
      lib().forEach(function (x) { if (!seen[x.n]) items.push(x); });
    } else {
      items = (GYM_LIBRARY[gymPicker.cat] || []).map(function (row) { return { n: row[0], cat: gymPicker.cat, bw: !!row[1] }; });
    }
    if (!items.length) {
      box.innerHTML = '<p class="muted tiny" style="padding:14px 4px">No match — add “' + esc(gymPicker.q) + '” as your own exercise below.</p>';
      return;
    }
    box.innerHTML = items.slice(0, 90).map(function (x) {
      return '<button type="button" class="gym-res" data-gpick="' + esc(x.n) + '">' +
        '<span class="gr-name">' + esc(x.n) + (x.freq ? ' <span class="gr-star">★</span>' : '') + '</span>' +
        '<span class="gr-cat">' + esc(x.cat) + (x.bw ? ' · bodyweight' : '') +
          (gymIsTimedName(x.n) ? ' · timed ⏱' : '') + '</span></button>';
    }).join('');
    box.querySelectorAll('[data-gpick]').forEach(function (b) {
      b.addEventListener('click', function () {
        hide('#gym-modal');
        if (gymAddExercise) gymAddExercise(b.getAttribute('data-gpick'));
      });
    });
  }

  /* ================= Breathe (Mind) ================= */
  var BREATHE_MODES = [
    { id: 'box', name: 'Box', desc: '4·4·4·4 — focus', phases: [['Breathe in', 4, 1.35], ['Hold', 4, 1.35], ['Breathe out', 4, 1], ['Hold', 4, 1]] },
    { id: '478', name: '4-7-8', desc: 'calm & sleep', phases: [['Breathe in', 4, 1.35], ['Hold', 7, 1.35], ['Breathe out', 8, 1]] },
    { id: 'coh', name: '5-5', desc: 'coherent balance', phases: [['Breathe in', 5, 1.35], ['Breathe out', 5, 1]] }
  ];
  var breathe = { mode: 'box', mins: 3, running: false, tick: null, phaseAt: 0, endAt: 0 };
  function stopBreathe(silent) {
    if (breathe.tick) { clearInterval(breathe.tick); breathe.tick = null; }
    breathe.running = false;
    if (!silent) {
      var c = $('#br-circle');
      if (c) { c.style.transitionDuration = '.8s'; c.style.transform = 'scale(1)'; }
    }
  }
  function renderBreathe() {
    var box = $('#breathe-app'); if (!box) return;
    stopBreathe(true);
    var day = appDay(), m = metricsOf(day);
    var doneMin = Number(m.breathMin) || 0;
    var mode = BREATHE_MODES.filter(function (x) { return x.id === breathe.mode; })[0] || BREATHE_MODES[0];
    if (appDate() !== todayStr()) {
      // Past day: sessions are live-only — show/edit that day's banked minutes.
      box.innerHTML = dayBarHtml() +
        '<div class="card"><div class="eyebrow">' + prettyDate(appDate()) + '</div>' +
        '<div class="metric-big" style="margin-top:8px"><b>' + doneMin + '</b> <span class="muted">min breathed</span></div>' +
        '<div class="manual-grid" style="margin-top:10px"><label>Adjust minutes<input id="br-past" type="number" inputmode="numeric" value="' + (doneMin || '') + '" /></label></div>' +
        '<button id="br-past-save" class="btn primary block">Save</button></div>';
      bindDayBar(box, renderBreathe);
      $('#br-past-save').addEventListener('click', function () {
        m.breathMin = Math.max(0, Number($('#br-past').value) || 0);
        queueSaveDay(day); toast('Saved ✓'); renderBreathe();
      });
      return;
    }
    box.innerHTML = dayBarHtml() +
      '<div class="seg" id="br-modes">' + BREATHE_MODES.map(function (x) {
        return '<button data-brm="' + x.id + '"' + (x.id === breathe.mode ? ' class="active"' : '') + '>' + x.name + '</button>';
      }).join('') + '</div>' +
      '<p class="muted tiny center" style="margin:0 0 6px">' + mode.desc + '</p>' +
      '<div class="card breathe-card">' +
        '<div class="br-stage"><div class="br-ring"></div><div id="br-circle" class="br-circle"><span id="br-label">Ready?</span><span id="br-count" class="br-count"></span></div></div>' +
        '<div class="seg" id="br-mins" style="max-width:240px;margin:14px auto 10px">' +
          [1, 3, 5].map(function (n) { return '<button data-brt="' + n + '"' + (n === breathe.mins ? ' class="active"' : '') + '>' + n + ' min</button>'; }).join('') +
        '</div>' +
        '<button id="br-start" class="btn primary block">Start session</button>' +
        (doneMin ? '<p class="muted tiny center" style="margin:10px 0 0">🫁 ' + doneMin + ' min breathed today</p>' : '') +
      '</div>';
    bindDayBar(box, renderBreathe);
    $('#br-modes').addEventListener('click', function (e) {
      var b = e.target.closest('[data-brm]'); if (!b) return;
      breathe.mode = b.getAttribute('data-brm'); renderBreathe();
    });
    $('#br-mins').addEventListener('click', function (e) {
      var b = e.target.closest('[data-brt]'); if (!b) return;
      breathe.mins = Number(b.getAttribute('data-brt')); renderBreathe();
    });
    $('#br-start').addEventListener('click', function () {
      if (breathe.running) { stopBreathe(); $('#br-start').textContent = 'Start session'; $('#br-label').textContent = 'Paused'; $('#br-count').textContent = ''; return; }
      startBreathe(mode);
    });
  }
  function startBreathe(mode) {
    breathe.running = true;
    breathe.endAt = Date.now() + breathe.mins * 60000;
    $('#br-start').textContent = 'Stop';
    var phaseIdx = -1, phaseLeft = 0;
    var next = function () {
      phaseIdx = (phaseIdx + 1) % mode.phases.length;
      var p = mode.phases[phaseIdx];
      phaseLeft = p[1];
      $('#br-label').textContent = p[0];
      $('#br-count').textContent = phaseLeft;
      var c = $('#br-circle');
      c.style.transitionDuration = p[1] + 's';
      c.style.transform = 'scale(' + p[2] + ')';
    };
    next();
    breathe.tick = setInterval(function () {
      if (!breathe.running) return;
      phaseLeft--;
      if (Date.now() >= breathe.endAt) {
        stopBreathe();
        var m = metricsOf(state.today);
        m.breathMin = (Number(m.breathMin) || 0) + breathe.mins;
        queueSave();
        toast('Session complete — ' + breathe.mins + ' min of calm 🫁✨');
        renderBreathe();
        return;
      }
      if (phaseLeft <= 0) next();
      else $('#br-count').textContent = phaseLeft;
    }, 1000);
  }

  /* ================= Digital Detox (Mind) ================= */
  function detoxKey() { return 'hard_detox_' + (state.username || ''); }
  // A running detox session used to live ONLY in localStorage until it was
  // stopped — the exact bug class the fasting fix addressed: a crash, a
  // cleared cache, or a switch to another device meant the whole session's
  // minutes were gone with no way to recover them. detoxActiveSince mirrors
  // the local timer into the profile blob (already durably synced via
  // saveGoals) so the session survives all of that; reconcileDetoxSession()
  // brings the two back in sync on every load.
  function detoxPersistStart(ts) {
    var p = Object.assign({}, state.profile, { detoxActiveSince: ts });
    state.profile = p;
    api('saveGoals', { profile: p }).then(function (d) { if (d && d.profile) state.profile = d.profile; }).catch(function () {});
  }
  function detoxPersistEnd() {
    var p = Object.assign({}, state.profile, { detoxActiveSince: 0 });
    state.profile = p;
    api('saveGoals', { profile: p }).catch(function () {});
  }
  function reconcileDetoxSession() {
    var local = Number(localStorage.getItem(detoxKey())) || 0;
    var server = Number(state.profile && state.profile.detoxActiveSince) || 0;
    if (server && !local) localStorage.setItem(detoxKey(), String(server));
    else if (local && !server) detoxPersistStart(local);
  }
  function renderDetox() {
    var box = $('#detox-app'); if (!box) return;
    if (state.detoxTimer) { clearInterval(state.detoxTimer); state.detoxTimer = null; }
    var goal = Number(state.profile && state.profile.detoxGoal) || 60;
    var rs = rangeState('detox');
    if (rs.mode !== 'day') { renderDetoxRange(box, rs, goal); return; }
    var day = appDay(), m = metricsOf(day);
    var total = Number(m.detoxMin) || 0;
    var isToday = appDate() === todayStr();
    var startedAt = isToday ? (Number(localStorage.getItem(detoxKey())) || Number(state.profile && state.profile.detoxActiveSince) || 0) : 0;
    var pct = pctOf(total, goal);
    var screenMin = Number(m.screenMin) || 0;
    var screenApps = m.screenApps || [];
    box.innerHTML = rangeBarHtml('detox') + dayBarHtml() +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + pct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + total + '</b> <span class="muted">min offline</span></div>' +
        '<div class="muted tiny">goal <button class="inline-edit" id="dx-goal-btn">' + goal + ' min</button> / day' + (pct >= 100 ? ' · unplugged 🏆' : '') + '</div></div></div>' +
      // Phone usage (from Screen Time)
      '<div class="card dx-phone">' +
        (screenMin
          ? '<div class="dx-phone-head"><span class="eyebrow">📱 Phone usage</span><b class="mono">' + hmDur(screenMin) + '</b></div>' +
            (screenApps.length ? '<div class="muted tiny" style="margin-top:6px">Top: ' + screenApps.slice(0, 3).map(function (a) { return esc(a.name) + ' ' + hmDur(a.minutes); }).join(' · ') + '</div>' : '') +
            '<button id="dx-screentime" class="btn block st-btn" style="margin-top:10px">📱 Update from Screen Time</button>'
          : '<div class="eyebrow">📱 Track phone usage</div>' +
            '<p class="muted tiny" style="margin:8px 0 10px">Upload your Screen Time screenshots — the AI logs your total phone usage and top apps here, and detects your sleep for the Sleep app.</p>' +
            '<button id="dx-screentime" class="btn primary block">📱 Analyse Screen Time</button>') +
      '</div>' +
      (isToday
        ? '<div class="card detox-card' + (startedAt ? ' active' : '') + '">' +
          (startedAt
            ? '<div class="eyebrow">Detox running</div><div id="dx-elapsed" class="dx-elapsed mono">00:00</div>' +
              '<p class="muted tiny center" style="margin:4px 0 12px">Phone down. Live a little 🌿</p>' +
              '<button id="dx-stop" class="btn primary block">End detox &amp; bank minutes</button>'
            : '<div class="eyebrow">Start a phone-free block</div>' +
              '<p class="muted tiny" style="margin:8px 0 12px">Start the timer, put the phone face-down. End it when you pick the phone back up — the minutes get banked here.</p>' +
              '<button id="dx-start" class="btn primary block">📵 Start detox</button>') +
          '</div>'
        : '<div class="card"><div class="eyebrow">Edit ' + prettyDate(appDate()) + '</div>' +
          '<div class="manual-grid" style="margin-top:8px"><label>Offline minutes<input id="dx-past" type="number" inputmode="numeric" value="' + (total || '') + '" /></label></div>' +
          '<button id="dx-past-save" class="btn primary block">Save</button></div>') +
      '<div class="card"><div class="eyebrow">Offline minutes · last 7 days</div><div id="detox-trend"></div></div>';
    bindRangeBar(box, 'detox', renderDetox);
    bindDayBar(box, renderDetox);
    var stBtn = $('#dx-screentime');
    if (stBtn) stBtn.addEventListener('click', function () { openScreenTimeUpload(renderDetox); });
    $('#dx-goal-btn').addEventListener('click', function () {
      var x = prompt('Daily phone-free goal (minutes):', goal); if (x == null) return;
      saveProfileKey('detoxGoal', Math.max(10, Number(x) || 60), renderDetox);
    });
    if (!isToday) {
      $('#dx-past-save').addEventListener('click', function () {
        m.detoxMin = Math.max(0, Number($('#dx-past').value) || 0);
        queueSaveDay(day); toast('Saved ✓'); renderDetox();
      });
      metricTrend('detoxMin', '#detox-trend', 'm');
      return;
    }
    if (startedAt) {
      var elapsedEl = $('#dx-elapsed');
      var tickFn = function () {
        var s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        var hh = Math.floor(s / 3600), mm2 = Math.floor((s % 3600) / 60), ss = s % 60;
        elapsedEl.textContent = (hh ? hh + ':' : '') + (mm2 < 10 ? '0' : '') + mm2 + ':' + (ss < 10 ? '0' : '') + ss;
      };
      tickFn();
      state.detoxTimer = setInterval(tickFn, 1000);
      $('#dx-stop').addEventListener('click', function () {
        var mins = Math.round((Date.now() - startedAt) / 60000);
        localStorage.removeItem(detoxKey());
        detoxPersistEnd();
        if (state.detoxTimer) { clearInterval(state.detoxTimer); state.detoxTimer = null; }
        if (mins >= 1) {
          // A session left running for a very long time (app closed and
          // reopened days later, etc.) is almost certainly stale, not a real
          // multi-day detox — cap what gets auto-banked and point the user
          // at manual edit instead of silently crediting bogus minutes.
          var banked = Math.min(mins, 480);
          m.detoxMin = (Number(m.detoxMin) || 0) + banked;
          queueSave();
          if (mins > 480) toast('That ran ' + Math.round(mins / 60) + 'h — capped at 8h. Fix the number below if needed.');
          else toast('+' + banked + ' min banked 📵✨');
        } else {
          toast('Under a minute — not banked.');
        }
        renderDetox();
      });
    } else {
      $('#dx-start').addEventListener('click', function () {
        var ts = Date.now();
        localStorage.setItem(detoxKey(), String(ts));
        detoxPersistStart(ts);
        renderDetox();
      });
    }
    metricTrend('detoxMin', '#detox-trend', 'm');
  }
  function renderDetoxRange(box, rs, goal) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { return l && l.metrics ? Number(l.metrics.detoxMin) || 0 : 0; });
    var hits = agg.perDay.filter(function (p) { return p.v >= goal; }).length;
    var pct = pctOf(agg.avg, goal);
    box.innerHTML = rangeBarHtml('detox') +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + Math.round(agg.avg) + '</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + Math.round(agg.avg) + ' min</b> <span class="muted">avg/day</span></div>' +
        '<div class="muted tiny">' + hits + ' of ' + agg.logged + ' days hit ' + goal + ' min · ' + Math.round(agg.sum) + ' min total</div></div></div>' +
      '<div class="card"><div class="eyebrow">Offline minutes per day</div>' + rangeBarChart(agg.perDay, 'var(--mind-c)', 'm') + '</div>';
    bindRangeBar(box, 'detox', renderDetox);
  }

  /* ================= Meditate — timer + minutes bank (Mind) ================= */
  var medit = { running: false, paused: false, mins: 10, leftMs: 0, lastTick: 0, tick: null };
  function meditStreak() {
    var d = todayStr();
    var l = logFor(d);
    if (!l || !l.metrics || !Number(l.metrics.meditMin)) d = addDays(d, -1);
    var s = 0;
    while (true) {
      var lg = logFor(d);
      if (!lg || !lg.metrics || !Number(lg.metrics.meditMin)) break;
      s++; d = addDays(d, -1);
    }
    return s;
  }
  // Soft two-tone chime via Web Audio — no asset needed; silently skipped if blocked.
  function meditChime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      var ctx = new Ctx();
      [523.25, 659.25].forEach(function (freq, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        o.connect(g); g.connect(ctx.destination);
        var t = ctx.currentTime + i * 0.35;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
        o.start(t); o.stop(t + 1.5);
      });
    } catch (e) {}
  }
  function stopMeditation(bank, silent) {
    if (medit.tick) { clearInterval(medit.tick); medit.tick = null; }
    if (!medit.running) return;
    var doneMs = medit.mins * 60000 - medit.leftMs;
    medit.running = false; medit.paused = false;
    if (bank) {
      var mins = Math.max(0, Math.round(doneMs / 60000));
      if (mins >= 1) {
        var m = metricsOf(state.today);
        m.meditMin = (Number(m.meditMin) || 0) + mins;
        queueSave();
        toast('+' + mins + ' min of stillness banked 🧘✨');
      } else toast('Under a minute — not banked.');
    }
    if (!silent) renderMeditate();
  }
  function startMeditation() {
    medit.running = true; medit.paused = false;
    medit.leftMs = medit.mins * 60000;
    medit.lastTick = Date.now();
    medit.tick = setInterval(function () {
      if (!medit.running || medit.paused) { medit.lastTick = Date.now(); return; }
      var now = Date.now();
      medit.leftMs -= now - medit.lastTick;
      medit.lastTick = now;
      if (medit.leftMs <= 0) {
        medit.leftMs = 0;
        meditChime();
        stopMeditation(true);
        return;
      }
      meditUpdateLive();
    }, 500);
    renderMeditate();
  }
  function meditUpdateLive() {
    var elT = $('#mdt-left'); if (!elT) return;
    var s = Math.max(0, Math.ceil(medit.leftMs / 1000));
    elT.textContent = Math.floor(s / 60) + ':' + pad(s % 60);
    var ring = $('#mdt-ring');
    if (ring) {
      var circ = 2 * Math.PI * 52;
      var frac = 1 - medit.leftMs / (medit.mins * 60000);
      ring.style.strokeDashoffset = circ * (1 - frac);
    }
  }
  function renderMeditate() {
    var box = $('#meditate-app'); if (!box) return;
    var goal = Number(state.profile && state.profile.meditGoal) || 10;
    var rs = rangeState('meditate');
    if (rs.mode !== 'day') { renderMeditateRange(box, rs, goal); return; }
    var day = appDay(), m = metricsOf(day);
    var doneMin = Number(m.meditMin) || 0;
    var isToday = appDate() === todayStr();
    var pct = pctOf(doneMin, goal);

    if (medit.running && isToday) {
      var sLeft = Math.max(0, Math.ceil(medit.leftMs / 1000));
      box.innerHTML =
        '<div class="card medit-card live">' +
          '<div class="mdt-stage"><svg viewBox="0 0 120 120" class="ring"><circle class="ring-bg" cx="60" cy="60" r="52"></circle>' +
          '<circle id="mdt-ring" class="ring-fg mdt-fg" cx="60" cy="60" r="52"></circle></svg>' +
          '<div class="mdt-center"><div id="mdt-left" class="mdt-left mono">' + Math.floor(sLeft / 60) + ':' + pad(sLeft % 60) + '</div>' +
          '<div class="muted tiny">' + (medit.paused ? 'paused' : 'remaining') + '</div></div></div>' +
          '<p class="muted tiny center" style="margin:4px 0 12px">' + (medit.paused ? 'Take your time.' : 'Eyes closed. Follow the breath 🌊') + '</p>' +
          '<div class="row-2"><button id="mdt-pause" class="btn">' + (medit.paused ? '▶ Resume' : '⏸ Pause') + '</button>' +
          '<button id="mdt-end" class="btn primary">End &amp; bank</button></div>' +
        '</div>';
      $('#mdt-pause').addEventListener('click', function () { medit.paused = !medit.paused; renderMeditate(); });
      $('#mdt-end').addEventListener('click', function () { stopMeditation(true); });
      meditUpdateLive();
      return;
    }

    box.innerHTML = rangeBarHtml('meditate') + dayBarHtml() +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + pct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + doneMin + '</b> <span class="muted">min today</span></div>' +
        '<div class="muted tiny">goal <button class="inline-edit" id="mdt-goal-btn">' + goal + ' min</button> / day · 🔥 ' + meditStreak() + '-day streak</div></div></div>' +
      (isToday
        ? '<div class="card medit-card"><div class="eyebrow">Start a sit</div>' +
          '<div class="seg" id="mdt-mins" style="margin:10px 0">' + [5, 10, 15, 20].map(function (n) {
            return '<button data-mm="' + n + '"' + (n === medit.mins ? ' class="active"' : '') + '>' + n + ' min</button>';
          }).join('') + '</div>' +
          '<button id="mdt-start" class="btn primary block">🧘 Begin</button>' +
          '<p class="muted tiny center" style="margin:10px 0 0">A soft chime rings when time is up.</p></div>'
        : '<div class="card"><div class="eyebrow">Edit ' + prettyDate(appDate()) + '</div>' +
          '<div class="manual-grid" style="margin-top:8px"><label>Minutes meditated<input id="mdt-past" type="number" inputmode="numeric" value="' + (doneMin || '') + '" /></label></div>' +
          '<button id="mdt-past-save" class="btn primary block">Save</button></div>') +
      '<div class="card"><div class="eyebrow">Minutes · last 7 days</div><div id="mdt-trend"></div></div>';
    bindRangeBar(box, 'meditate', renderMeditate);
    bindDayBar(box, renderMeditate);
    $('#mdt-goal-btn').addEventListener('click', function () {
      var x = prompt('Daily meditation goal (minutes):', goal); if (x == null) return;
      saveProfileKey('meditGoal', Math.max(1, Number(x) || 10), renderMeditate);
    });
    if (isToday) {
      $('#mdt-mins').addEventListener('click', function (e) {
        var b = e.target.closest('[data-mm]'); if (!b) return;
        medit.mins = Number(b.getAttribute('data-mm')); renderMeditate();
      });
      $('#mdt-start').addEventListener('click', startMeditation);
    } else {
      $('#mdt-past-save').addEventListener('click', function () {
        m.meditMin = Math.max(0, Number($('#mdt-past').value) || 0);
        queueSaveDay(day); toast('Saved ✓'); renderMeditate();
      });
    }
    metricTrend('meditMin', '#mdt-trend', 'm');
  }
  function renderMeditateRange(box, rs, goal) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { return l && l.metrics ? Number(l.metrics.meditMin) || 0 : 0; });
    var hits = agg.perDay.filter(function (p) { return p.v >= goal; }).length;
    var pct = pctOf(agg.avg, goal);
    box.innerHTML = rangeBarHtml('meditate') +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + Math.round(agg.avg) + '</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + Math.round(agg.avg) + ' min</b> <span class="muted">avg/day</span></div>' +
        '<div class="muted tiny">' + hits + ' of ' + agg.logged + ' days hit ' + goal + ' min · ' + Math.round(agg.sum) + ' min total</div></div></div>' +
      '<div class="card"><div class="eyebrow">Minutes per day</div>' + rangeBarChart(agg.perDay, 'var(--mind-c)', 'm') + '</div>';
    bindRangeBar(box, 'meditate', renderMeditate);
  }

  /* ================= Manifest — affirmations + visualization (Mind) ================= */
  var AFFIRM_STARTERS = [
    'I am disciplined and consistent', 'Money flows to me with ease',
    'I am becoming my strongest self', 'I attract the right people and opportunities',
    'My body is healthy and full of energy', 'Everything is always working out for me'
  ];
  function affirmations() { return (state.profile && state.profile.affirmations) || []; }
  function manifestStreak() {
    var d = todayStr();
    var l = logFor(d);
    if (!l || !l.metrics || !l.metrics.manifested) d = addDays(d, -1);
    var s = 0;
    while (true) {
      var lg = logFor(d);
      if (!lg || !lg.metrics || !lg.metrics.manifested) break;
      s++; d = addDays(d, -1);
    }
    return s;
  }
  var manifest = { step: -1, vizLeft: 0, vizTick: null };  // step: -1 idle, 0..n-1 affirmation cards, 'viz'
  function stopManifestViz() { if (manifest.vizTick) { clearInterval(manifest.vizTick); manifest.vizTick = null; } }
  function manifestFinish(day) {
    stopManifestViz();
    manifest.step = -1;
    var m = metricsOf(day);
    m.manifested = 1;
    queueSaveDay(day);
    toast('Practice complete — it’s already yours ✨');
    renderManifest();
  }
  function renderManifest() {
    var box = $('#manifest-app'); if (!box) return;
    var list = affirmations();
    var day = appDay(), m = metricsOf(day);
    var isToday = appDate() === todayStr();
    var rs = rangeState('manifest');

    // Mid-practice flow (affirmation cards → 68s visualization)
    if (manifest.step !== -1 && isToday) {
      if (manifest.step === 'viz') {
        box.innerHTML =
          '<div class="card manifest-card live">' +
            '<div class="eyebrow">Visualise · 68 seconds</div>' +
            '<div class="mf-viz mono" id="mf-viz">' + manifest.vizLeft + '</div>' +
            '<p class="muted tiny center" style="margin:0 0 14px">Close your eyes. See the life you’re building — already real, already yours.</p>' +
            '<button id="mf-done" class="btn primary block">Done ✨</button>' +
          '</div>';
        $('#mf-done').addEventListener('click', function () { manifestFinish(day); });
        if (!manifest.vizTick) {
          manifest.vizTick = setInterval(function () {
            manifest.vizLeft--;
            var e2 = $('#mf-viz');
            if (e2) e2.textContent = Math.max(0, manifest.vizLeft);
            if (manifest.vizLeft <= 0) manifestFinish(day);
          }, 1000);
        }
        return;
      }
      var a = list[manifest.step];
      box.innerHTML =
        '<div class="card manifest-card live">' +
          '<div class="eyebrow">Affirmation ' + (manifest.step + 1) + ' / ' + list.length + '</div>' +
          '<div class="mf-text">“' + esc(a) + '”</div>' +
          '<p class="muted tiny center" style="margin:0 0 14px">Say it out loud — or in your head — like you mean it.</p>' +
          '<button id="mf-next" class="btn primary block">' + (manifest.step + 1 < list.length ? 'Next ›' : 'Visualise →') + '</button>' +
          '<button id="mf-quit" class="link-btn" style="margin-top:8px">Exit practice</button>' +
        '</div>';
      $('#mf-next').addEventListener('click', function () {
        if (manifest.step + 1 < list.length) { manifest.step++; renderManifest(); }
        else { manifest.step = 'viz'; manifest.vizLeft = 68; renderManifest(); }
      });
      $('#mf-quit').addEventListener('click', function () { manifest.step = -1; stopManifestViz(); renderManifest(); });
      return;
    }

    if (rs.mode !== 'day') { renderManifestRange(box, rs); return; }

    var practiced = !!m.manifested;
    var html = rangeBarHtml('manifest') + dayBarHtml() +
      '<div class="card hero-row' + (practiced ? ' goal-hit' : '') + '">' +
        ringMini(practiced ? 100 : 0, 'var(--mind-c)', 92, practiced ? '<b>✓</b>' : '<b>—</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + (practiced ? 'Practiced ✨' : 'Not yet') + '</b></div>' +
        '<div class="muted tiny">🔥 ' + manifestStreak() + '-day streak · ' + list.length + ' affirmation' + (list.length === 1 ? '' : 's') + '</div></div></div>';

    if (isToday) {
      html += list.length
        ? '<button id="mf-start" class="btn primary block" style="margin-bottom:14px">✨ Practice now (' + list.length + ' + 68s visualise)</button>'
        : '';
    } else {
      html += '<div class="card"><label class="fx-toggle"><input type="checkbox" id="mf-past"' + (practiced ? ' checked' : '') + ' /> Practiced on ' + prettyDate(appDate()) + '</label></div>';
    }

    // Affirmation manager
    html += '<div class="card"><div class="eyebrow" style="margin-bottom:6px">My affirmations</div>' +
      (list.length ? list.map(function (a, i) {
        return '<div class="list-row"><span class="mf-item">“' + esc(a) + '”</span><button class="list-del" data-afrm="' + i + '">✕</button></div>';
      }).join('') : '<p class="muted tiny" style="margin:0 0 10px">Write affirmations in the present tense, as if already true. Start with one of these:</p>' +
        '<div class="starter-chips" style="margin-bottom:4px">' + AFFIRM_STARTERS.map(function (s) {
          return '<button type="button" class="starter-chip" data-astart="' + esc(s) + '">' + esc(s) + '</button>';
        }).join('') + '</div>') +
      '<div class="add-habit" style="margin:10px 0 0"><input id="mf-new" placeholder="e.g. I am unstoppable" maxlength="120" /><button id="mf-add" class="btn">Add</button></div></div>';

    // Practiced-days calendar (doubles as date picker)
    html += '<div class="card"><h3>Practice calendar</h3><p class="muted tiny" style="margin:0 0 8px">Tap a day to view or edit it.</p><div id="mf-cal"></div></div>';

    box.innerHTML = html;
    bindRangeBar(box, 'manifest', renderManifest);
    bindDayBar(box, renderManifest);
    var st = $('#mf-start');
    if (st) st.addEventListener('click', function () { manifest.step = 0; renderManifest(); });
    var pastCb = $('#mf-past');
    if (pastCb) pastCb.addEventListener('change', function () {
      m.manifested = this.checked ? 1 : 0;
      queueSaveDay(day); renderManifest();
    });
    $('#mf-add').addEventListener('click', function () {
      var v = $('#mf-new').value.trim(); if (!v) return;
      saveProfileKey('affirmations', affirmations().concat([v.slice(0, 120)]), renderManifest);
    });
    box.querySelectorAll('[data-astart]').forEach(function (b) {
      b.addEventListener('click', function () {
        saveProfileKey('affirmations', affirmations().concat([b.getAttribute('data-astart')]), renderManifest);
      });
    });
    box.querySelectorAll('[data-afrm]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-afrm'));
        saveProfileKey('affirmations', affirmations().filter(function (_, j) { return j !== i; }), renderManifest);
      });
    });
    var cal = $('#mf-cal');
    if (cal) buildDayPicker(cal, ymOf(appDate()), renderManifest, function (date) {
      var l = logFor(date);
      return l && l.metrics && l.metrics.manifested ? 'var(--mind-c)' : null;
    });
  }
  function renderManifestRange(box, rs) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { return l && l.metrics && l.metrics.manifested ? 1 : 0; });
    var pct = pctOf(agg.hits, agg.days);
    box.innerHTML = rangeBarHtml('manifest') +
      '<div class="card hero-row' + (pct >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(pct, 'var(--mind-c)', 92, '<b>' + pct + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + agg.hits + ' of ' + agg.days + '</b> <span class="muted">days practiced</span></div>' +
        '<div class="muted tiny">' + rangeLabelFor(rs.mode, rs.anchor) + '</div></div></div>' +
      '<div class="card"><div class="eyebrow">Practice per day</div>' + rangeBarChart(agg.perDay, 'var(--mind-c)') + '</div>';
    bindRangeBar(box, 'manifest', renderManifest);
  }

  /* ================= Challenges app (pick / build / track) ================= */
  // First day (on/after the run start) that failed the challenge — used for the
  // hard-reset banner and the "perfect run" state.
  function chFirstFail() {
    var start = chStart(), today = todayStr();
    var d = start;
    while (d < today) {                 // don't judge an unfinished today
      var l = logFor(d);
      if (!l || !chGoalLive(l)) return d;
      d = addDays(d, 1);
    }
    return null;
  }
  function chAdherence() {
    var start = chStart(), today = todayStr(), hit = 0, n = 0;
    for (var d = start; d <= today; d = addDays(d, 1)) {
      n++; var l = logFor(d); if (l && chGoalLive(l)) hit++;
    }
    return { hit: hit, days: n, pct: n ? Math.round(hit / n * 100) : 0 };
  }
  // Banner shown on the Today screen for reset:'hard' challenges after a miss.
  function chResetBannerHtml() {
    var c = activeCh();
    if (c.reset !== 'hard') return '';
    var fail = chFirstFail();
    if (!fail || fail >= todayStr()) return '';
    var dn = dayNumber(chStart(), fail);
    return '<div class="card ch-reset"><div><b>Day ' + dn + ' broke the streak</b>' +
      '<div class="muted tiny" style="margin-top:2px">' + c.emoji + ' ' + esc(c.name) + ' resets to Day 1 on a miss.</div></div>' +
      '<div class="row-2" style="margin-top:10px"><button class="btn primary" id="ch-restart">Restart Day 1</button>' +
      '<button class="btn" id="ch-keepgoing">Keep going</button></div></div>';
  }
  function bindResetBanner(scope) {
    var r = scope.querySelector('#ch-restart');
    if (r) r.addEventListener('click', function () {
      if (!confirm('Restart from Day 1? Your attempt is saved to history and the counter goes back to Day 1.')) return;
      chArchiveRun('reset');
      var def = chInstantiate(activeCh(), todayStr());
      setChallenge(def, function () { toast('Fresh start — Day 1 🔁'); renderAll(); });
    });
    var k = scope.querySelector('#ch-keepgoing');
    if (k) k.addEventListener('click', function () {
      var c = activeCh(); c.reset = 'kept'; setChallenge(c, function () { renderAll(); });
    });
  }
  function chArchiveRun(outcome) {
    var c = activeCh();
    var hist = (state.profile.challenge && state.profile.challenge.history) || c.history || [];
    hist = hist.slice();
    hist.push({ id: c.id, name: c.name, emoji: c.emoji, days: c.days, startDate: c.startDate, endDate: todayStr(), outcome: outcome, adherence: chAdherence().pct });
    c.history = hist.slice(-30);
  }

  function renderChallenges() {
    var box = $('#challenges-app'); if (!box) return;
    if (state.chBuilder) { renderChallengeBuilder(box); return; }
    var c = activeCh(), day = Math.max(1, chDay()), adh = chAdherence();
    var complete = LEN && day > LEN;
    var pctToday = pctOf(chCount(state.today || {}), TOTAL_ITEMS);
    // Active-run card
    var rulesDots = chRules().map(function (rule) {
      var v = ruleView(rule);
      var dots = '';
      for (var i = 6; i >= 0; i--) {
        var dte = addDays(todayStr(), -i);
        var l = dte === todayStr() ? state.today : logFor(dte);
        dots += '<i class="hdot' + (l && ruleMet(l, rule) ? ' on' : '') + (dte === todayStr() ? ' td' : '') + '"></i>';
      }
      return '<div class="ch-rule"><span class="ch-rule-name">' + v.emoji + ' ' + esc(v.title) + '</span><div class="hdots">' + dots + '</div></div>';
    }).join('');
    var isBase = c.id === 'dailyLife';   // the everyday baseline, not a challenge
    var html =
      '<div class="card ch-active">' +
        '<div class="ch-active-top"><div><span class="eyebrow">' + (isBase ? 'Baseline' : 'Active challenge') + '</span>' +
          '<div class="ch-name">' + c.emoji + ' ' + esc(c.name) + '</div></div>' +
          ringMini(complete ? 100 : pctToday, 'var(--life-c)', 74, '<b>' + (complete ? '🏆' : 'D' + day) + '</b>') +
        '</div>' +
        '<div class="ch-meta">' + (LEN ? 'Day ' + day + ' / ' + LEN : 'Day ' + day + ' · open-ended') +
          ' · ' + adh.hit + '/' + adh.days + ' days (' + adh.pct + '%)' +
          ' · ' + (c.reset === 'hard' ? 'resets on miss' : 'no reset') + '</div>' +
        '<div class="ch-rules">' + rulesDots + '</div>' +
        (complete ? '<div class="ch-done">🏆 Challenge complete — ' + adh.pct + '% adherence. Legend.</div>' : '') +
        (isBase
          ? '<div class="muted tiny" style="margin-top:12px">You’re on the everyday baseline — no streak to break. Pick a difficulty below when you’re ready to level up.</div>'
          : '<div class="row-2" style="margin-top:12px"><button class="btn" id="ch-restart2">↻ Restart</button>' +
            '<button class="btn danger" id="ch-end">End challenge</button></div>') +
      '</div>' +
      '<div class="lib-head" style="margin:18px 0 12px"><div><span class="eyebrow">Choose your mode</span></div>' +
        '<button class="btn link-btn" id="ch-custom-new" type="button" style="margin:0">＋ Custom ›</button></div>' +
      CH_TIERS.map(function (tier) {
        var cards = CH_PRESETS.filter(function (p) { return (p.tier || 'medium') === tier.id; });
        if (!cards.length) return '';
        return '<div class="ch-tier"><div class="ch-tier-head t-' + tier.id + '"><b>' + tier.label + '</b><span class="muted tiny">' + tier.sub + '</span></div>' +
          '<div class="ch-gallery">' + cards.map(function (p) {
            var active = p.id === c.id;
            return '<button type="button" class="ch-card' + (active ? ' active' : '') + '" data-preset="' + p.id + '">' +
              '<div class="ch-card-top"><span class="ch-emoji">' + p.emoji + '</span>' +
                '<span class="ch-days">' + (p.days ? p.days + 'd · ' + (p.reset === 'hard' ? 'strict' : 'flex') : 'ongoing') + '</span></div>' +
              '<div class="ch-card-name">' + esc(p.name) + '</div>' +
              '<div class="ch-card-desc">' + esc(p.desc) + '</div>' +
              (active ? '<div class="ch-card-active">● Active</div>' : '') + '</button>';
          }).join('') + '</div></div>';
      }).join('') +
      // Custom mode — build your own daily task list from any blocks.
      '<div class="ch-tier"><div class="ch-tier-head t-custom"><b>Custom</b><span class="muted tiny">your own daily tasks</span></div>' +
        '<button type="button" class="ch-card ch-card-custom" id="ch-custom-card">' +
          '<div class="ch-card-top"><span class="ch-emoji">🛠️</span><span class="ch-days">build</span></div>' +
          '<div class="ch-card-name">Build your own</div>' +
          '<div class="ch-card-desc">Pick exactly which tasks, metrics, habits and your own items become your daily checklist.</div>' +
        '</button></div>';
    // History
    var hist = (c.history || []).slice().reverse();
    if (hist.length) {
      html += '<div class="card" style="margin-top:6px"><div class="eyebrow" style="margin-bottom:6px">Past runs</div>' +
        hist.map(function (h) {
          return '<div class="list-row"><div><b>' + (h.emoji || '') + ' ' + esc(h.name) + '</b>' +
            '<div class="muted tiny">' + shortDate(h.startDate) + '–' + shortDate(h.endDate) + ' · ' + (h.outcome === 'reset' ? 'reset' : h.outcome === 'completed' ? 'completed 🏆' : 'ended') + '</div></div>' +
            '<span class="mono">' + (h.adherence != null ? h.adherence + '%' : '') + '</span></div>';
        }).join('') + '</div>';
    }
    box.innerHTML = html;

    box.querySelectorAll('[data-preset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = chPreset(b.getAttribute('data-preset'));
        if (p.id === c.id) { toast('Already on ' + p.name); return; }
        if (!confirm('Start ' + p.emoji + ' ' + p.name + '? Your current run is saved to history and Day 1 begins today.')) return;
        chArchiveRun('switched');
        var startLabel = p.id === 'dailyLife' ? 'Back to Daily Life 🌤️' : p.emoji + ' ' + p.name + ' — Day 1! Go.';
        setChallenge(chInstantiate(p, todayStr()), function () { toast(startLabel); renderAll(); renderChallenges(); });
      });
    });
    $('#ch-custom-new').addEventListener('click', function () { chStartBuilder(); });
    var customCard = $('#ch-custom-card');
    if (customCard) customCard.addEventListener('click', function () { chStartBuilder(); });
    var restartBtn = $('#ch-restart2');
    if (restartBtn) restartBtn.addEventListener('click', function () {
      if (!confirm('Restart this challenge from Day 1? The current run is archived.')) return;
      chArchiveRun('reset');
      setChallenge(chInstantiate(c, todayStr()), function () { toast('Restarted — Day 1 🔁'); renderAll(); renderChallenges(); });
    });
    var endBtn = $('#ch-end');
    if (endBtn) endBtn.addEventListener('click', function () {
      if (!confirm('End this challenge and return to Daily Life (the everyday baseline)?')) return;
      chArchiveRun('ended');
      setChallenge(chInstantiate(chPreset('dailyLife'), todayStr()), function () { toast('Challenge ended — back to Daily Life 🌤️'); renderAll(); renderChallenges(); });
    });
  }

  /* ----- Custom challenge builder ----- */
  function chStartBuilder() {
    state.chBuilder = { name: '', emoji: '🏁', days: 30, reset: 'none', pass: 'all', water: 4000, hasWater: true,
      tasks: {}, metrics: {}, habits: {}, manual: [] };
    renderChallenges();
  }
  // Builder items used to be plain strings; they now carry their own emoji.
  // Read both shapes so an in-progress draft doesn't break.
  function cbManualLabel(m) { return typeof m === 'string' ? m : (m && m.label) || ''; }
  function cbManualEmoji(m) { return (m && typeof m === 'object' && m.emoji) || '📌'; }
  function renderChallengeBuilder(box) {
    var B = state.chBuilder;
    var habits = (state.profile && state.profile.customTasks) || [];
    box.innerHTML =
      '<button class="btn link-btn" id="cb-back">‹ Back</button>' +
      '<div class="card"><div class="manual-grid">' +
        '<label>Name<input id="cb-name" value="' + esc(B.name) + '" placeholder="e.g. My Arc" maxlength="30" /></label>' +
        '<label>Icon' + emojiFieldHtml('cb-emoji', B.emoji || '🏁') + '</label>' +
      '</div>' +
      '<div class="eyebrow" style="margin:6px 0 6px">Length</div>' +
      '<div class="seg" id="cb-days">' + [21, 30, 66, 75, 90, 0].map(function (n) {
        return '<button type="button" data-cbd="' + n + '"' + (n === B.days ? ' class="active"' : '') + '>' + (n === 0 ? '∞' : n) + '</button>';
      }).join('') + '</div>' +
      '<div class="eyebrow" style="margin:10px 0 6px">On a missed day</div>' +
      '<div class="seg" id="cb-reset">' +
        '<button type="button" data-cbr="none"' + (B.reset === 'none' ? ' class="active"' : '') + '>Keep going</button>' +
        '<button type="button" data-cbr="hard"' + (B.reset === 'hard' ? ' class="active"' : '') + '>Reset to Day 1</button>' +
      '</div></div>' +
      '<div class="card"><div class="eyebrow" style="margin-bottom:8px">Daily rules — pick what counts</div>' +
        '<div class="cb-sec">Core tasks</div>' +
        TASKS.map(function (t) { return cbCheck('task_' + t.key, t.emoji + ' ' + t.title, !!B.tasks[t.key]); }).join('') +
        '<label class="cb-check"><input type="checkbox" id="cb-water"' + (B.hasWater ? ' checked' : '') + ' /> 💧 Water goal ' +
          '<input id="cb-water-ml" class="cb-inline" type="number" inputmode="numeric" value="' + (B.water || 4000) + '" /> ml</label>' +
        '<div class="cb-sec">Metrics (from your apps)</div>' +
        Object.keys(CH_METRICS).map(function (k) {
          var m = CH_METRICS[k], on = !!B.metrics[k];
          return '<label class="cb-check"><input type="checkbox" data-cbm="' + k + '"' + (on ? ' checked' : '') + ' /> ' + m.emoji + ' ' + m.label +
            ' ≥ <input class="cb-inline" type="number" inputmode="numeric" data-cbmin="' + k + '" value="' + (B.metrics[k] || (k === 'steps' ? 8000 : 10)) + '" /></label>';
        }).join('') +
        (habits.length ? '<div class="cb-sec">Your habits</div>' + habits.map(function (h) { return cbCheck('habit_' + h.id, habitIcon(h) + ' ' + habitLabel(h), !!B.habits[h.id]); }).join('') : '') +
        '<div class="cb-sec">Your own items</div>' +
        (B.manual.length
          ? B.manual.map(function (mm, i) {
              return '<div class="list-row"><span>' + cbManualEmoji(mm) + ' ' + esc(cbManualLabel(mm)) + '</span>' +
                '<button class="list-del" data-cbmanrm="' + i + '">✕</button></div>';
            }).join('')
          : '<p class="muted tiny" style="margin:2px 2px 8px">Write your own daily items — anything the blocks above don’t cover.</p>') +
        '<div class="add-habit" style="margin-top:8px">' + emojiFieldHtml('cb-emoji-pick', '📌') +
          '<input id="cb-manual" placeholder="e.g. Deep work 2h" maxlength="30" /><button id="cb-manual-add" class="btn">Add</button></div>' +
      '</div>' +
      '<button id="cb-start" class="btn primary block">Start challenge</button>';

    function cbCheck(id, label, on) { return '<label class="cb-check"><input type="checkbox" data-cbt="' + id + '"' + (on ? ' checked' : '') + ' /> ' + esc(label) + '</label>'; }

    $('#cb-back').addEventListener('click', function () { state.chBuilder = null; renderChallenges(); });
    var sync = function () {
      B.name = $('#cb-name').value; B.emoji = emojiFieldValue('cb-emoji', '🏁');
      B.hasWater = $('#cb-water').checked; B.water = Number($('#cb-water-ml').value) || 4000;
      B.manual = B.manual; // unchanged here
      // tasks & habits
      B.tasks = {}; B.habits = {};
      box.querySelectorAll('[data-cbt]').forEach(function (c) {
        if (!c.checked) return;
        var id = c.getAttribute('data-cbt');
        if (id.indexOf('task_') === 0) B.tasks[id.slice(5)] = true;
        else if (id.indexOf('habit_') === 0) B.habits[id.slice(6)] = true;
      });
      B.metrics = {};
      box.querySelectorAll('[data-cbm]').forEach(function (c) {
        if (c.checked) B.metrics[c.getAttribute('data-cbm')] = Number(box.querySelector('[data-cbmin="' + c.getAttribute('data-cbm') + '"]').value) || 10;
      });
    };
    box.querySelectorAll('#cb-days [data-cbd]').forEach(function (b) { b.addEventListener('click', function () { sync(); B.days = Number(b.getAttribute('data-cbd')); renderChallenges(); }); });
    box.querySelectorAll('#cb-reset [data-cbr]').forEach(function (b) { b.addEventListener('click', function () { sync(); B.reset = b.getAttribute('data-cbr'); renderChallenges(); }); });
    bindEmojiField('cb-emoji');
    bindEmojiField('cb-emoji-pick');
    $('#cb-manual-add').addEventListener('click', function () {
      sync();
      var v = $('#cb-manual').value.trim();
      if (!v) return;
      B.manual.push({ label: v.slice(0, 30), emoji: emojiFieldValue('cb-emoji-pick', '📌') });
      renderChallenges();
    });
    box.querySelectorAll('[data-cbmanrm]').forEach(function (b) { b.addEventListener('click', function () { sync(); B.manual.splice(Number(b.getAttribute('data-cbmanrm')), 1); renderChallenges(); }); });
    $('#cb-start').addEventListener('click', function () {
      sync();
      var rules = [];
      TASKS.forEach(function (t) { if (B.tasks[t.key]) rules.push({ t: 'task', key: t.key }); });
      Object.keys(B.metrics).forEach(function (k) { rules.push({ t: 'metric', key: k, min: B.metrics[k] }); });
      (habits).forEach(function (h) { if (B.habits[h.id]) rules.push({ t: 'habit', id: h.id }); });
      B.manual.forEach(function (mm, i) {
        rules.push({ t: 'manual', id: 'm' + i + '_' + Date.now().toString(36), label: cbManualLabel(mm), emoji: cbManualEmoji(mm) });
      });
      if (B.hasWater) rules.push({ t: 'water' });
      if (!rules.length) { toast('Pick at least one daily rule'); return; }
      var def = { id: 'custom', name: B.name.trim() || 'My Challenge', emoji: B.emoji || '🏁',
        days: Number(B.days) || 0, reset: B.reset, pass: 'all', water: B.hasWater ? B.water : 0,
        rules: rules, startDate: todayStr(), history: (activeCh().history || []) };
      chArchiveRun('switched');
      state.chBuilder = null;
      setChallenge(def, function () { toast(def.emoji + ' ' + def.name + ' — Day 1! 🏁'); renderAll(); renderChallenges(); });
    });
  }

  /* ================= Meds — medicines & supplements (Body) ================= */
  var MED_SLOTS = [
    { id: 'morning',   label: 'Morning',   emoji: '☀️' },
    { id: 'afternoon', label: 'Afternoon', emoji: '🌤️' },
    { id: 'evening',   label: 'Evening',   emoji: '🌇' },
    { id: 'night',     label: 'Night',     emoji: '🌙' }
  ];
  function medsList() { return (state.profile && state.profile.meds) || []; }
  function medTakenMap(d) { var m = metricsOf(d); if (!m.meds) m.meds = {}; return m.meds; }
  function medDoseCount(list) {
    return list.reduce(function (s, md) { return s + ((md.times || []).length || 0); }, 0);
  }
  function medTakenCount(d, list) {
    var taken = (d.metrics && d.metrics.meds) || {};
    var n = 0;
    list.forEach(function (md) {
      (md.times || []).forEach(function (t) { if (taken[md.id + '@' + t]) n++; });
    });
    return n;
  }
  // Adherence color for a date: green = all doses, amber = some, null = none logged.
  function medDayColor(date) {
    var l = logFor(date); if (!l) return null;
    var list = medsList(); if (!list.length) return null;
    var taken = medTakenCount(l, list);
    if (!taken) return null;
    return taken >= medDoseCount(list) ? 'var(--green)' : 'var(--amber)';
  }
  function medStreak() {
    var list = medsList(); if (!list.length || !medDoseCount(list)) return 0;
    var d = todayStr();
    // an unfinished today shouldn't zero the streak
    var l = logFor(d);
    if (!l || medTakenCount(l, list) < medDoseCount(list)) d = addDays(d, -1);
    var s = 0;
    while (true) {
      var lg = logFor(d);
      if (!lg || medTakenCount(lg, list) < medDoseCount(list)) break;
      s++; d = addDays(d, -1);
    }
    return s;
  }
  function renderMeds() {
    var box = $('#meds-app'); if (!box) return;
    var list = medsList();
    var rs = rangeState('meds');
    if (rs.mode !== 'day') { renderMedsRange(box, rs, list); return; }
    var day = appDay(), taken = medTakenMap(day);
    var total = medDoseCount(list), done = medTakenCount(day, list);
    var pct = pctOf(done, total);
    var html = rangeBarHtml('meds') + dayBarHtml();

    if (list.length) {
      html +=
        '<div class="card hero-row' + (total && done >= total ? ' goal-hit' : '') + '">' +
          ringMini(pct, 'var(--body-c)', 92, '<b>' + done + '/' + total + '</b>') +
          '<div class="hero-meta"><div class="metric-big"><b>' + (total && done >= total ? 'All taken 🎉' : (total - done) + ' dose' + (total - done === 1 ? '' : 's') + ' left') + '</b></div>' +
          '<div class="muted tiny">💊 ' + list.length + ' med' + (list.length === 1 ? '' : 's') + ' · 🔥 ' + medStreak() + '-day streak</div></div></div>';
      MED_SLOTS.forEach(function (slot) {
        var rows = list.filter(function (md) { return (md.times || []).indexOf(slot.id) >= 0; });
        if (!rows.length) return;
        html += '<div class="extra-head">' + slot.emoji + ' ' + slot.label + '</div><div class="tasklist">' +
          rows.map(function (md) {
            var key = md.id + '@' + slot.id;
            var on = !!taken[key];
            return '<div class="task med' + (on ? ' done' : '') + '" data-med="' + key + '">' +
              '<div class="check">✓</div><div class="t-emoji">💊</div>' +
              '<div class="t-body"><div class="t-title">' + esc(md.name) + '</div>' +
              (md.dose ? '<div class="t-sub">' + esc(md.dose) + '</div>' : '') + '</div></div>';
          }).join('') + '</div>';
      });
    } else {
      html += '<div class="card"><p class="muted tiny" style="margin:0">No meds yet — add your medicines or supplements below, pick when to take them, and tick them off each day.</p></div>';
    }

    // Adherence calendar (doubles as the date picker)
    if (list.length) {
      html += '<div class="card"><h3>Adherence</h3><p class="muted tiny" style="margin:0 0 8px">Tap a day to view or edit it.</p><div id="meds-cal"></div>' +
        '<div class="gt-legend" style="margin-top:10px">' +
          '<span class="gt-key"><i style="background:var(--green)"></i>All taken</span>' +
          '<span class="gt-key"><i style="background:var(--amber)"></i>Partial</span>' +
        '</div></div>';
    }

    // Manage meds
    html += '<div class="card"><div class="eyebrow" style="margin-bottom:6px">My meds</div><div id="meds-manage">' +
      list.map(function (md) {
        var slots = (md.times || []).map(function (t) {
          var s = MED_SLOTS.filter(function (x) { return x.id === t; })[0];
          return s ? s.emoji : '';
        }).join(' ');
        return '<div class="list-row"><div><b>' + esc(md.name) + '</b>' +
          '<div class="muted tiny">' + (md.dose ? esc(md.dose) + ' · ' : '') + slots + '</div></div>' +
          '<button class="list-del" data-medrm="' + md.id + '">✕</button></div>';
      }).join('') + '</div>' +
      '<div class="manual-grid" style="margin-top:10px">' +
        '<label>Name<input id="med-name" placeholder="e.g. Vitamin D3" maxlength="40" /></label>' +
        '<label>Dose <span class="muted tiny">(optional)</span><input id="med-dose" placeholder="e.g. 1 tab · after food" maxlength="40" /></label>' +
      '</div>' +
      '<div class="med-slot-picker" id="med-slots">' + MED_SLOTS.map(function (s) {
        return '<button type="button" class="med-slot' + (s.id === 'morning' ? ' on' : '') + '" data-slot="' + s.id + '">' + s.emoji + ' ' + s.label + '</button>';
      }).join('') + '</div>' +
      '<button id="med-add" class="btn primary block">Add med</button></div>';

    box.innerHTML = html;
    bindRangeBar(box, 'meds', renderMeds);
    bindDayBar(box, renderMeds);

    // Tick off a dose
    box.querySelectorAll('[data-med]').forEach(function (row) {
      row.addEventListener('click', function () {
        var key = row.getAttribute('data-med');
        taken[key] = !taken[key];
        queueSaveDay(day);
        if (taken[key] && medTakenCount(day, list) >= total && total > 1) toast('All doses done today 💊✨');
        renderMeds();
      });
    });
    // Adherence calendar
    var cal = $('#meds-cal');
    if (cal) buildDayPicker(cal, ymOf(appDate()), renderMeds, medDayColor);
    // Manage: slot chips toggle
    box.querySelectorAll('[data-slot]').forEach(function (b) {
      b.addEventListener('click', function () { b.classList.toggle('on'); });
    });
    $('#med-add').addEventListener('click', function () {
      var name = $('#med-name').value.trim();
      if (!name) { toast('Give the med a name'); return; }
      var times = [];
      box.querySelectorAll('[data-slot].on').forEach(function (b) { times.push(b.getAttribute('data-slot')); });
      if (!times.length) { toast('Pick at least one time of day'); return; }
      var next = medsList().slice();
      next.push({ id: 'md_' + Date.now().toString(36), name: name.slice(0, 40), dose: $('#med-dose').value.trim().slice(0, 40), times: times });
      saveProfileKey('meds', next, renderMeds);
    });
    box.querySelectorAll('[data-medrm]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('Remove this med? Past taken-history stays in your logs.')) return;
        saveProfileKey('meds', medsList().filter(function (md) { return md.id !== b.getAttribute('data-medrm'); }), renderMeds);
      });
    });
  }
  function renderMedsRange(box, rs, list) {
    if (!list.length) {
      box.innerHTML = rangeBarHtml('meds') + '<div class="card"><p class="muted tiny" style="margin:0">Add a med in Day view first, then come back here for adherence trends.</p></div>';
      bindRangeBar(box, 'meds', renderMeds);
      return;
    }
    var total = medDoseCount(list);
    var r = rangeSpan(rs.mode, rs.anchor);
    var agg = rangeAgg(r.from, r.to, function (l) { return total ? pctOf(medTakenCount(l || {}, list), total) : 0; });
    var fullDays = agg.perDay.filter(function (p) { return p.v >= 100; }).length;
    box.innerHTML = rangeBarHtml('meds') +
      '<div class="card hero-row' + (agg.avg >= 100 ? ' goal-hit' : '') + '">' +
        ringMini(agg.avg, 'var(--body-c)', 92, '<b>' + Math.round(agg.avg) + '%</b>') +
        '<div class="hero-meta"><div class="metric-big"><b>' + Math.round(agg.avg) + '%</b> <span class="muted">avg adherence</span></div>' +
        '<div class="muted tiny">' + fullDays + ' of ' + agg.logged + ' days — all doses taken</div></div></div>' +
      '<div class="card"><div class="eyebrow">Adherence per day</div>' + rangeBarChart(agg.perDay, 'var(--body-c)', '%') + '</div>';
    bindRangeBar(box, 'meds', renderMeds);
  }

  /* ----- Money / Subs / Savings / Tasks / Goals (generic list apps) ----- */
  function rupee(v) { return '₹' + (Math.round(Number(v) || 0)).toLocaleString('en-IN'); }
  function saveProfileKey(key, val, cb) {
    var p = Object.assign({}, state.profile); p[key] = val; state.profile = p;
    api('saveGoals', { profile: p }).then(function (d) { if (d && d.profile) state.profile = d.profile; toast('Saved ✓'); if (cb) cb(); }).catch(function (e) { toast(e.message); });
  }
  function truthy(v) { return v === true || v === 1 || String(v).toLowerCase() === 'true'; }

  /* ================= Money Manager (full) ================= */
  var GUARD_LABEL = { ok: 'On track', warn: 'Slow down', critical: 'Critical', stop: 'Over budget', none: 'No budget set' };
  var GUARD_CLASS = { ok: 'g-ok', warn: 'g-warn', critical: 'g-critical', stop: 'g-stop', none: 'g-none' };
  function moneyCatById(id) { return (state.money.categories || []).filter(function (c) { return c.id === id; })[0]; }
  function moneyAcctById(id) { return (state.money.accounts || []).filter(function (a) { return a.id === id; })[0]; }
  function moneyCatOptions(selectedId) {
    var groups = {};
    (state.money.categories || []).forEach(function (c) { (groups[c.group] = groups[c.group] || []).push(c); });
    return Object.keys(groups).sort().map(function (g) {
      return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (c) {
        return '<option value="' + c.id + '"' + (c.id === selectedId ? ' selected' : '') + '>' + c.icon + ' ' + esc(c.name) + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
  }
  function moneyAcctOptions(selectedId) {
    var accts = state.money.accounts || [];
    if (!accts.length) return '<option value="">No accounts yet</option>';
    return '<option value="">—</option>' + accts.map(function (a) {
      return '<option value="' + a.id + '"' + (a.id === selectedId ? ' selected' : '') + '>' + esc(a.name) + '</option>';
    }).join('');
  }

  function moneyCacheKey() { return 'hard_money_' + (state.username || ''); }
  function moneyBlank() { return { accounts: [], categories: [], budget: {}, status: {}, dashboard: null, loaded: false, tab: 'overview' }; }
  // moneyGetState now returns accounts+categories+budget+status+dashboard in ONE round-trip
  // (previously Overview made a second 'moneyDashboard' call after this — two slow Apps
  // Script calls in sequence). Cache the result so reopening Money is instant.
  function moneyInit() {
    if (!state.money) state.money = moneyBlank();
    return api('moneyGetState', {}).then(function (d) {
      state.money.accounts = d.accounts || []; state.money.categories = d.categories || [];
      state.money.budget = d.budget || {}; state.money.status = d.status || {};
      state.money.dashboard = d.dashboard || null; state.money.loaded = true;
      try { localStorage.setItem(moneyCacheKey(), JSON.stringify({ accounts: state.money.accounts, categories: state.money.categories, budget: state.money.budget, status: state.money.status, dashboard: state.money.dashboard })); } catch (e) {}
    });
  }
  function renderMoney() {
    if (!state.money) state.money = moneyBlank();
    if (!renderMoney.bound) {
      renderMoney.bound = true;
      document.querySelectorAll('#money-tabs [data-mtab]').forEach(function (b) {
        b.addEventListener('click', function () {
          document.querySelectorAll('#money-tabs [data-mtab]').forEach(function (x) { x.classList.toggle('active', x === b); });
          var t = b.getAttribute('data-mtab'); state.money.tab = t;
          document.querySelectorAll('.money-pane').forEach(function (p) { p.classList.add('hidden'); });
          $('#money-pane-' + t).classList.remove('hidden');
          moneyRenderTab(t);
        });
      });
      $('#money-ask-penny').addEventListener('click', function () { openCoach('money'); });
    }
    if (!state.money.loaded) {
      // Show last-known data instantly (if any), then refresh in the background.
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(moneyCacheKey()) || 'null'); } catch (e) {}
      if (cached) {
        state.money.accounts = cached.accounts || []; state.money.categories = cached.categories || [];
        state.money.budget = cached.budget || {}; state.money.status = cached.status || {}; state.money.dashboard = cached.dashboard || null;
        moneyRenderTab(state.money.tab || 'overview');
      } else {
        $('#money-overview').innerHTML = '<p class="muted tiny">Loading…</p>';
      }
      moneyInit().then(function () { moneyRenderTab(state.money.tab || 'overview'); });
    } else {
      moneyRenderTab(state.money.tab || 'overview');
    }
  }
  function moneyRenderTab(t) {
    if (t === 'overview') moneyRenderOverview();
    else if (t === 'add') moneyRenderAdd();
    else if (t === 'history') moneyRenderHistory();
    else if (t === 'accounts') moneyRenderAccounts();
    else if (t === 'categories') moneyRenderCategories();
    else if (t === 'recurring') moneyRenderRecurring();
    else if (t === 'budget') moneyRenderBudget();
  }

  // Renders synchronously from state.money.dashboard (already fetched by moneyGetState /
  // cached) — no separate network call, so switching to Overview is instant.
  // A Day/Week/Month range picker lets you view any period; only "this month" uses the
  // preloaded dashboard (with its budget guard-rail) — other periods fetch moneyDashboard
  // fresh (cached per range) since the guard-rail is inherently month-scoped.
  if (!state.moneyRangeCache) state.moneyRangeCache = {};
  function moneyRenderOverview() {
    var box = $('#money-overview'); if (!box) return;
    var rs = rangeState('money');
    var isCurrentMonth = rs.mode === 'month' && ymOf(rs.anchor) === ymOf(todayStr());
    if (rs.mode === 'day' || rs.mode === 'week' || (rs.mode === 'month' && !isCurrentMonth)) {
      moneyRenderOverviewRange(box, rs);
      return;
    }
    var d = state.money.dashboard;
    if (!d) { box.innerHTML = rangeBarHtml('money') + '<p class="muted tiny">Loading…</p>'; return; }
    var s = state.money.status || d.status || {};
    var level = s.level || 'none';
    var groups = { need: 0, want: 0, saving: 0 };
    if (d.byKind) { groups.need = d.byKind.need; groups.want = d.byKind.want; groups.saving = d.byKind.saving; }
    var totalKind = (groups.need + groups.want + groups.saving) || 1;
    box.innerHTML = rangeBarHtml('money') +
      '<div class="card guard-card ' + GUARD_CLASS[level] + '">' +
        '<div class="guard-top"><span class="eyebrow">This month</span><span class="guard-chip">' + esc(GUARD_LABEL[level]) + '</span></div>' +
        '<div class="metric-big"><b>' + rupee(s.spent) + '</b> <span class="muted">' + (s.limit ? ('/ ' + rupee(s.limit)) : 'spent · no budget set') + '</span></div>' +
        (s.limit ? '<div class="fc-bar' + (s.pct >= 1 ? ' over' : '') + '" style="margin:10px 0"><span style="width:' + Math.min(100, Math.round(s.pct * 100)) + '%"></span></div>' +
          '<div class="guard-grid">' +
            '<div><span class="muted tiny">Remaining</span><b>' + rupee(s.remaining) + '</b></div>' +
            '<div><span class="muted tiny">Safe / day</span><b>' + rupee(s.safePerDay) + '</b></div>' +
            '<div><span class="muted tiny">Days left</span><b>' + s.daysLeft + '</b></div>' +
            '<div><span class="muted tiny">Projected</span><b>' + rupee(s.projection) + '</b></div>' +
          '</div>' : '<p class="muted tiny" style="margin-top:8px">Set a monthly budget in the <b>Budget</b> tab to see your guard-rail.</p>') +
      '</div>' +
      (s.limit ? '<div class="card"><div class="eyebrow">Daily discipline · last 7 days</div><div id="money-discipline" class="disc-row"><span class="muted tiny">Loading…</span></div>' +
        '<p class="muted tiny" style="margin-top:8px">Green = you stayed under ' + rupee(s.limit / (s.daysInMonth || 30)) + '/day. Every green day lifts your Money score.</p></div>' : '') +
      '<div class="card"><div class="eyebrow">Needs / Wants / Savings</div>' +
        '<div class="nws-bar"><span class="nws-need" style="width:' + Math.round(groups.need / totalKind * 100) + '%"></span>' +
        '<span class="nws-want" style="width:' + Math.round(groups.want / totalKind * 100) + '%"></span>' +
        '<span class="nws-save" style="width:' + Math.round(groups.saving / totalKind * 100) + '%"></span></div>' +
        '<div class="nws-legend"><span><i class="nws-dot nws-need"></i>Needs ' + rupee(groups.need) + '</span><span><i class="nws-dot nws-want"></i>Wants ' + rupee(groups.want) + '</span><span><i class="nws-dot nws-save"></i>Savings ' + rupee(groups.saving) + '</span></div>' +
        '<p class="muted tiny" style="margin-top:8px">Target roughly 50 / 30 / 20.</p></div>' +
      '<div class="card"><div class="eyebrow">Top categories</div>' + (
        (d.byCategory || []).length ? d.byCategory.slice(0, 6).map(function (c) {
          var pct = d.totalSpend ? Math.round(c.total / d.totalSpend * 100) : 0;
          return '<div class="bar-row"><div class="bl"><span>' + c.icon + ' ' + esc(c.name) + '</span><span>' + rupee(c.total) + '</span></div><div class="bar"><span style="width:' + pct + '%;background:' + c.color + '"></span></div></div>';
        }).join('') : '<p class="muted tiny">No spending logged yet this month.</p>'
      ) + '</div>' +
      '<div class="card"><div class="eyebrow">Top merchants</div>' + (
        (d.topMerchants || []).length ? d.topMerchants.map(function (m) {
          return '<div class="list-row"><span>' + esc(m.merchant) + '</span><b>' + rupee(m.total) + '</b></div>';
        }).join('') : '<p class="muted tiny">—</p>'
      ) + '</div>';
    bindRangeBar(box, 'money', moneyRenderOverview);
    if (s.limit) moneyRenderDiscipline();
  }
  // Day / Week / any-other-Month view: fetches moneyDashboard(from,to) fresh (no
  // preloaded guard-rail card since safe-to-spend-per-day only means something
  // for the current month), cached per range so flipping back and forth is instant.
  function moneyRenderOverviewRange(box, rs) {
    var r = rangeSpan(rs.mode, rs.anchor);
    var key = r.from + '_' + r.to;
    box.innerHTML = rangeBarHtml('money') + '<p class="muted tiny">Loading…</p>';
    bindRangeBar(box, 'money', moneyRenderOverview);
    var cached = state.moneyRangeCache[key];
    var go = function (d) {
      var groups = { need: 0, want: 0, saving: 0 };
      if (d.byKind) { groups.need = d.byKind.need; groups.want = d.byKind.want; groups.saving = d.byKind.saving; }
      var totalKind = (groups.need + groups.want + groups.saving) || 1;
      var label = rs.mode === 'day' ? (rs.anchor === todayStr() ? 'Today' : prettyDate(rs.anchor)) : rangeLabelFor(rs.mode, rs.anchor);
      box.innerHTML = rangeBarHtml('money') +
        '<div class="card"><span class="eyebrow">' + esc(label) + '</span>' +
        '<div class="metric-big" style="margin-top:6px"><b>' + rupee(d.totalSpend) + '</b> <span class="muted">spent · ' + (d.txnCount || 0) + ' txns</span></div></div>' +
        '<div class="card"><div class="eyebrow">Needs / Wants / Savings</div>' +
          '<div class="nws-bar"><span class="nws-need" style="width:' + Math.round(groups.need / totalKind * 100) + '%"></span>' +
          '<span class="nws-want" style="width:' + Math.round(groups.want / totalKind * 100) + '%"></span>' +
          '<span class="nws-save" style="width:' + Math.round(groups.saving / totalKind * 100) + '%"></span></div>' +
          '<div class="nws-legend"><span><i class="nws-dot nws-need"></i>Needs ' + rupee(groups.need) + '</span><span><i class="nws-dot nws-want"></i>Wants ' + rupee(groups.want) + '</span><span><i class="nws-dot nws-save"></i>Savings ' + rupee(groups.saving) + '</span></div></div>' +
        '<div class="card"><div class="eyebrow">Top categories</div>' + (
          (d.byCategory || []).length ? d.byCategory.slice(0, 6).map(function (c) {
            var pct = d.totalSpend ? Math.round(c.total / d.totalSpend * 100) : 0;
            return '<div class="bar-row"><div class="bl"><span>' + c.icon + ' ' + esc(c.name) + '</span><span>' + rupee(c.total) + '</span></div><div class="bar"><span style="width:' + pct + '%;background:' + c.color + '"></span></div></div>';
          }).join('') : '<p class="muted tiny">No spending in this period.</p>'
        ) + '</div>' +
        '<div class="card"><div class="eyebrow">Top merchants</div>' + (
          (d.topMerchants || []).length ? d.topMerchants.map(function (m) {
            return '<div class="list-row"><span>' + esc(m.merchant) + '</span><b>' + rupee(m.total) + '</b></div>';
          }).join('') : '<p class="muted tiny">—</p>'
        ) + '</div>';
      bindRangeBar(box, 'money', moneyRenderOverview);
    };
    if (cached) { go(cached); return; }
    api('moneyDashboard', { from: r.from, to: r.to }).then(function (d) {
      state.moneyRangeCache[key] = d;
      go(d);
    }).catch(function (e) { box.innerHTML = rangeBarHtml('money') + '<p class="muted tiny">' + esc(e.message) + '</p>'; bindRangeBar(box, 'money', moneyRenderOverview); });
  }
  // Last-7-days under/over daily-budget dots on the Money overview.
  function moneyRenderDiscipline() {
    var slot = $('#money-discipline'); if (!slot) return;
    var ym = ymOf(todayStr());
    var c = ensureMoneyMonth(ym, moneyRenderDiscipline);
    if (!c) return; // still loading — callback re-renders
    if (!c.limit) { slot.innerHTML = '<span class="muted tiny">Set a budget to track this.</span>'; return; }
    var dailyLimit = c.limit / daysInYm(ym);
    var today = todayStr(), out = '';
    for (var i = 6; i >= 0; i--) {
      var dte = addDays(today, -i);
      var inMonth = ymOf(dte) === ym;
      var spend = inMonth ? (c.perDay[dte] || 0) : 0;
      var win = spend <= dailyLimit;
      out += '<div class="disc-day' + (!inMonth ? ' na' : win ? ' win' : ' over') + '">' +
        '<span class="disc-dot">' + (!inMonth ? '·' : win ? '✓' : '✗') + '</span>' +
        '<span class="disc-lbl">' + parse(dte).toLocaleDateString(undefined, { weekday: 'narrow' }) + '</span>' +
        '<span class="disc-amt">' + (inMonth ? '₹' + Math.round(spend) : '') + '</span></div>';
    }
    slot.innerHTML = out;
  }
  // Fire-and-forget refresh after a mutation (add/delete txn, save budget) so
  // the Overview breakdown catches up without blocking the UI on a network call.
  function moneyRefreshSilently() {
    delete moneyMonthCache[ymOf(todayStr())]; // txns changed — recompute daily wins & Life Score
    state.moneyRangeCache = {}; // and any custom Day/Week/Month range views
    moneyInit().then(function () { if (state.money.tab === 'overview') moneyRenderOverview(); }).catch(function () {});
  }

  var moneyAddKey = '';   // idempotency key for the in-progress manual add
  function moneyRenderAdd() {
    var box = $('#money-add'); if (!box) return;
    var today = todayStr();
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Add manually</div>' +
        '<div class="manual-grid">' +
          '<label>Amount (₹)<input id="mo-amt" type="number" inputmode="decimal" /></label>' +
          '<label>Type<select id="mo-type"><option value="expense">Expense</option><option value="income">Income</option><option value="transfer">Transfer</option></select></label>' +
          '<label>Category<select id="mo-cat">' + moneyCatOptions() + '</select></label>' +
          '<label>Account<select id="mo-acct">' + moneyAcctOptions() + '</select></label>' +
          '<label>Date<input id="mo-date" type="date" value="' + today + '" max="' + today + '" /></label>' +
          '<label>Merchant<input id="mo-merch" placeholder="e.g. Swiggy" /></label>' +
        '</div><label>Note<input id="mo-note" placeholder="optional" /></label>' +
        '<button id="mo-add-btn" class="btn primary block">Add transaction</button></div>' +
      '<div class="card"><div class="eyebrow">📷 Scan a screenshot</div>' +
        '<p class="muted tiny">Banking app, UPI (GPay/PhonePe/Paytm), card statement, or order history.</p>' +
        '<div class="scan-row"><button id="mo-scan-btn" class="btn" type="button">🖼️ Upload image</button></div>' +
        '<input type="file" id="mo-scan-file" accept="image/*" class="hidden" />' +
        '<div id="mo-scan-status" class="muted tiny scan-status"></div></div>' +
      '<div class="card"><div class="eyebrow">📋 Paste a bank / UPI message</div>' +
        '<textarea id="mo-sms" rows="3" placeholder="Paste the SMS or notification text…"></textarea>' +
        '<button id="mo-sms-btn" class="btn block" style="margin-top:8px">Parse message</button></div>' +
      '<div id="mo-review"></div>';
    $('#mo-add-btn').addEventListener('click', function () {
      var amt = Number($('#mo-amt').value) || 0;
      if (amt <= 0) { toast('Enter an amount'); return; }
      // A stable key for THIS filled-in form: it survives a failed attempt so
      // retrying can't create a second copy, and is only rotated once the save
      // lands and the form is cleared.
      if (!moneyAddKey) moneyAddKey = 'mo_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      var t = { date: $('#mo-date').value || today, amount: amt, type: $('#mo-type').value, categoryId: $('#mo-cat').value, accountId: $('#mo-acct').value, merchant: $('#mo-merch').value.trim(), note: $('#mo-note').value.trim(), source: 'manual', clientId: moneyAddKey };
      var ab = $('#mo-add-btn'); ab.disabled = true; ab.textContent = 'Saving…';
      api('moneyAddTxn', { transaction: t }).then(function (d) {
        state.money.status = d.status || state.money.status;
        toast(d.duplicate ? 'Already saved ✓' : 'Added ✓');
        moneyAddKey = '';
        $('#mo-amt').value = ''; $('#mo-merch').value = ''; $('#mo-note').value = '';
        moneyRefreshSilently();
      }).catch(function (e) { toast(e.message); })
        .then(function () { ab.disabled = false; ab.textContent = 'Add transaction'; });
    });
    $('#mo-scan-btn').addEventListener('click', function () { $('#mo-scan-file').click(); });
    $('#mo-scan-file').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = ''; if (!f) return;
      $('#mo-scan-status').textContent = 'Reading screenshot…';
      compressImage(f).then(function (b64) { return api('moneyParseScreenshot', { image: b64, mime: 'image/jpeg' }); })
        .then(function (d) {
          $('#mo-scan-status').textContent = (d.transactions || []).length ? '' : 'No transactions found in that image.';
          moneyRenderReview(d.transactions || []);
        }).catch(function (e) { $('#mo-scan-status').textContent = e.message || 'Scan failed.'; });
    });
    $('#mo-sms-btn').addEventListener('click', function () {
      var text = $('#mo-sms').value.trim(); if (!text) { toast('Paste a message first'); return; }
      var btn = $('#mo-sms-btn'); btn.disabled = true; btn.textContent = 'Parsing…';
      api('moneyParseMessage', { text: text }).then(function (d) {
        moneyRenderReview(d.transactions || []);
        if ((d.transactions || []).length) $('#mo-sms').value = '';
      }).catch(function (e) { toast(e.message); }).then(function () { btn.disabled = false; btn.textContent = 'Parse message'; });
    });
  }
  function moneyRenderReview(list) {
    var box = $('#mo-review'); if (!box) return;
    if (!list.length) { box.innerHTML = ''; return; }
    // One idempotency key per row, minted HERE rather than at save time. If a
    // save times out and you tap again, the retry carries the same key and the
    // backend recognises it instead of writing the transaction twice.
    var batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    box.innerHTML = '<div class="card"><div class="eyebrow">Review · ' + list.length + ' found</div>' +
      list.map(function (t, i) {
        var cat = moneyCatById(t.categoryId);
        var acctNote = t.accountId ? '<span class="muted tiny">✓ matched from label</span>' : (!state.money.accounts || !state.money.accounts.length ? '<span class="muted tiny">Add a bank/card in the Accounts tab to tag transactions</span>' : '');
        return '<div class="review-row" data-i="' + i + '" data-cid="rv_' + batch + '_' + i + '">' +
          '<div class="manual-grid">' +
            '<label>Amount<input class="rv-amt" type="number" value="' + t.amount + '" /></label>' +
            '<label>Category<select class="rv-cat">' + moneyCatOptions(t.categoryId) + '</select></label>' +
            '<label>Date<input class="rv-date" type="date" value="' + t.date + '" /></label>' +
            '<label>Type<select class="rv-type"><option value="expense"' + (t.type === 'expense' ? ' selected' : '') + '>Expense</option><option value="income"' + (t.type === 'income' ? ' selected' : '') + '>Income</option><option value="transfer"' + (t.type === 'transfer' ? ' selected' : '') + '>Transfer</option></select></label>' +
            '<label>Account<select class="rv-acct">' + moneyAcctOptions(t.accountId) + '</select></label>' +
          '</div>' + acctNote +
          '<label>Merchant<input class="rv-merch" value="' + esc(t.merchant || '') + '" /></label>' +
          '<button class="list-del" data-rv-remove="' + i + '">✕ Skip this one</button></div>';
      }).join('') +
      '<button id="mo-review-save" class="btn primary block">Add all to Money</button></div>';
    box.querySelectorAll('[data-rv-remove]').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('.review-row').remove(); });
    });
    $('#mo-review-save').addEventListener('click', function () {
      var rows = box.querySelectorAll('.review-row');
      var txns = [];
      rows.forEach(function (r) {
        txns.push({
          amount: Number(r.querySelector('.rv-amt').value) || 0, categoryId: r.querySelector('.rv-cat').value,
          date: r.querySelector('.rv-date').value, type: r.querySelector('.rv-type').value,
          accountId: r.querySelector('.rv-acct').value,
          merchant: r.querySelector('.rv-merch').value.trim(), source: 'screenshot',
          clientId: r.getAttribute('data-cid')
        });
      });
      txns = txns.filter(function (t) { return t.amount > 0; });
      if (!txns.length) { toast('Nothing to add'); return; }
      var sb = $('#mo-review-save'); sb.disabled = true; sb.textContent = 'Saving…';
      api('moneyAddTxns', { transactions: txns }).then(function (d) {
        state.money.status = d.status || state.money.status;
        toast('Added ' + d.added + ' transaction' + (d.added === 1 ? '' : 's') + ' ✓');
        box.innerHTML = '';
        moneyRefreshSilently();
      }).catch(function (e) {
        toast(e.message);
        sb.disabled = false; sb.textContent = 'Add all to Money';
      });
    });
  }

  function moneyRenderHistory() {
    var box = $('#money-history'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('moneyGetTxns', { limit: 100 }).then(function (d) {
      state.money.editingTxnId = null;
      moneyRenderHistoryList(d.transactions || []);
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }
  function moneyRenderHistoryList(items) {
    var box = $('#money-history'); if (!box) return;
    if (!items.length) { box.innerHTML = '<p class="muted tiny">No transactions yet — add one in the Add tab.</p>'; return; }
    var editingId = state.money.editingTxnId;
    var today = todayStr();
    box.innerHTML = items.map(function (t) {
      if (t.id === editingId) {
        return '<div class="txn-edit-card" data-editcard="' + t.id + '">' +
          '<div class="manual-grid">' +
            '<label>Amount (₹)<input class="te-amt" type="number" inputmode="decimal" value="' + t.amount + '" /></label>' +
            '<label>Type<select class="te-type">' +
              '<option value="expense"' + (t.type === 'expense' ? ' selected' : '') + '>Expense</option>' +
              '<option value="income"' + (t.type === 'income' ? ' selected' : '') + '>Income</option>' +
              '<option value="transfer"' + (t.type === 'transfer' ? ' selected' : '') + '>Transfer</option>' +
            '</select></label>' +
            '<label>Category<select class="te-cat">' + moneyCatOptions(t.categoryId) + '</select></label>' +
            '<label>Account<select class="te-acct">' + moneyAcctOptions(t.accountId) + '</select></label>' +
            '<label>Date<input class="te-date" type="date" value="' + esc(t.date) + '" max="' + today + '" /></label>' +
            '<label>Merchant<input class="te-merch" value="' + esc(t.merchant || '') + '" /></label>' +
          '</div><label>Note<input class="te-note" value="' + esc(t.note || '') + '" /></label>' +
          '<div class="fr-acts" style="margin-top:10px">' +
            '<button class="btn primary" data-save="' + t.id + '">Save</button>' +
            '<button class="btn" data-cancel="1">Cancel</button>' +
          '</div></div>';
      }
      var cat = moneyCatById(t.categoryId);
      var acct = moneyAcctById(t.accountId);
      var sign = t.type === 'income' ? '+' : (t.type === 'transfer' ? '' : '−');
      var cls = t.type === 'income' ? 'amt-income' : (t.type === 'transfer' ? 'amt-transfer' : 'amt-expense');
      return '<div class="list-row txn-row" data-edit="' + t.id + '">' +
        '<div><b>' + (cat ? cat.icon + ' ' : '') + esc(t.merchant || (cat ? cat.name : 'Uncategorised')) + '</b>' +
        '<div class="muted tiny">' + esc(t.date) + (acct ? ' · ' + esc(acct.name) : '') + (t.note ? ' · ' + esc(t.note) : '') + '</div></div>' +
        '<span class="fr-acts"><b class="' + cls + '">' + sign + rupee(t.amount) + '</b><button class="list-del" data-del="' + t.id + '">✕</button></span></div>';
    }).join('');
    box.querySelectorAll('[data-edit]').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('[data-del]')) return;
        state.money.editingTxnId = row.getAttribute('data-edit');
        moneyRenderHistoryList(items);
      });
    });
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        api('moneyDeleteTxn', { id: b.getAttribute('data-del') }).then(function (d) {
          state.money.status = d.status || state.money.status; moneyRenderHistory(); moneyRefreshSilently();
        });
      });
    });
    box.querySelectorAll('[data-cancel]').forEach(function (b) {
      b.addEventListener('click', function () { state.money.editingTxnId = null; moneyRenderHistoryList(items); });
    });
    box.querySelectorAll('[data-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-save');
        var card = b.closest('.txn-edit-card');
        var amt = Number(card.querySelector('.te-amt').value) || 0;
        if (amt <= 0) { toast('Enter a valid amount'); return; }
        var payload = {
          transaction: {
            id: id, amount: amt, type: card.querySelector('.te-type').value,
            categoryId: card.querySelector('.te-cat').value, accountId: card.querySelector('.te-acct').value,
            date: card.querySelector('.te-date').value, merchant: card.querySelector('.te-merch').value.trim(),
            note: card.querySelector('.te-note').value.trim()
          }
        };
        b.disabled = true; b.textContent = 'Saving…';
        api('moneyUpdateTxn', payload).then(function (d) {
          state.money.status = d.status || state.money.status;
          state.money.editingTxnId = null;
          toast('Updated ✓');
          moneyRenderHistory();
          moneyRefreshSilently();
        }).catch(function (e) { toast(e.message); b.disabled = false; b.textContent = 'Save'; });
      });
    });
  }

  function moneyRenderAccounts() {
    var box = $('#money-accounts'); if (!box) return;
    var accts = state.money.accounts || [];
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Add account / card</div>' +
        '<div class="manual-grid">' +
          '<label>Name<input id="ac-name" placeholder="e.g. HDFC Bank" /></label>' +
          '<label>Type<select id="ac-type"><option value="bank">Bank</option><option value="credit_card">Credit card</option><option value="cash">Cash</option><option value="wallet">Wallet</option></select></label>' +
          '<label>Issuer<input id="ac-issuer" placeholder="optional" /></label>' +
          '<label>Last 4 digits<input id="ac-last4" inputmode="numeric" maxlength="4" /></label>' +
        '</div><button id="ac-add-btn" class="btn primary block">Add account</button></div>' +
      (accts.length ? accts.map(function (a) {
        return '<div class="card"><div class="list-row"><div><b>' + esc(a.name) + '</b><div class="muted tiny">' + esc(a.type.replace('_', ' ')) + (a.last4 ? ' · •••• ' + esc(a.last4) : '') + '</div></div><button class="list-del" data-ac-del="' + a.id + '">✕</button></div></div>';
      }).join('') : '<p class="muted tiny">No accounts yet.</p>');
    $('#ac-add-btn').addEventListener('click', function () {
      var name = $('#ac-name').value.trim(); if (!name) { toast('Enter a name'); return; }
      api('moneyAddAccount', { account: { name: name, type: $('#ac-type').value, issuer: $('#ac-issuer').value.trim(), last4: $('#ac-last4').value.trim() } })
        .then(function (d) { state.money.accounts.push(d.account); toast('Added ✓'); moneyRenderAccounts(); }).catch(function (e) { toast(e.message); });
    });
    box.querySelectorAll('[data-ac-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-ac-del');
        api('moneyDeleteAccount', { id: id }).then(function () { state.money.accounts = state.money.accounts.filter(function (a) { return a.id !== id; }); moneyRenderAccounts(); });
      });
    });
  }

  // Every group already in use, so a category can be filed under an existing
  // one by picking it rather than re-typing it (and mis-typing it into a new
  // near-duplicate group).
  function moneyGroupNames() {
    var seen = {};
    (state.money.categories || []).forEach(function (c) { if (c.group) seen[c.group] = 1; });
    return Object.keys(seen).sort();
  }
  var MONEY_KINDS = [['need', 'Need'], ['want', 'Want'], ['saving', 'Saving']];
  function moneyGroupSelect(id, sel) {
    var groups = moneyGroupNames();
    if (sel && groups.indexOf(sel) < 0) groups.push(sel);
    return '<select id="' + id + '">' +
      groups.map(function (g) {
        return '<option value="' + esc(g) + '"' + (g === sel ? ' selected' : '') + '>' + esc(g) + '</option>';
      }).join('') +
      '<option value="__new">＋ New group…</option></select>' +
      '<input id="' + id + '-new" class="hidden" placeholder="New group name" maxlength="30" />';
  }
  function moneyKindSelect(id, sel) {
    return '<select id="' + id + '">' + MONEY_KINDS.map(function (k) {
      return '<option value="' + k[0] + '"' + (k[0] === sel ? ' selected' : '') + '>' + k[1] + '</option>';
    }).join('') + '</select>';
  }
  function moneyBindGroupSelect(id) {
    var s = $('#' + id), i = $('#' + id + '-new'); if (!s || !i) return;
    var sync = function () {
      var isNew = s.value === '__new';
      i.classList.toggle('hidden', !isNew);
      if (isNew) i.focus();
    };
    s.addEventListener('change', sync); sync();
  }
  function moneyGroupValue(id) {
    var s = $('#' + id), i = $('#' + id + '-new');
    if (s && s.value === '__new') return ((i && i.value) || '').trim().slice(0, 30) || 'Other';
    return (s && s.value) || 'Other';
  }
  function moneyRenderCategories() {
    var box = $('#money-categories'); if (!box) return;
    var cats = state.money.categories || [];
    var editId = state.money.editCat || '';
    var groups = {}; cats.forEach(function (c) { (groups[c.group] = groups[c.group] || []).push(c); });
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Add custom category</div>' +
        '<div class="manual-grid">' +
          '<label>Name<input id="ct-name" placeholder="e.g. Side project" /></label>' +
          '<label>Group' + moneyGroupSelect('ct-group', '') + '</label>' +
          '<label>Kind' + moneyKindSelect('ct-kind', 'want') + '</label>' +
          '<label>Icon (emoji)<input id="ct-icon" placeholder="📦" maxlength="4" /></label>' +
        '</div><button id="ct-add-btn" class="btn primary block">Add category</button></div>' +
      Object.keys(groups).sort().map(function (g) {
        return '<div class="card"><div class="eyebrow">' + esc(g) + '</div>' + groups[g].map(function (c) {
          if (c.id === editId) {
            return '<div class="ct-edit">' +
              '<div class="manual-grid">' +
                '<label>Name<input id="ce-name" value="' + esc(c.name) + '" /></label>' +
                '<label>Group' + moneyGroupSelect('ce-group', c.group) + '</label>' +
                '<label>Kind' + moneyKindSelect('ce-kind', c.kind) + '</label>' +
                '<label>Icon (emoji)<input id="ce-icon" value="' + esc(c.icon || '') + '" maxlength="4" /></label>' +
              '</div>' +
              '<div class="ct-edit-btns">' +
                '<button id="ce-save" class="btn primary">Save</button>' +
                '<button id="ce-cancel" class="btn">Cancel</button>' +
              '</div></div>';
          }
          return '<div class="list-row"><span>' + c.icon + ' ' + esc(c.name) + ' <span class="cat-kind">' + c.kind + '</span></span>' +
            '<button class="icon-mini ct-editbtn" data-ct-edit="' + c.id + '" title="Edit">✎</button>' +
            '<button class="list-del" data-ct-del="' + c.id + '">✕</button></div>';
        }).join('') + '</div>';
      }).join('');
    moneyBindGroupSelect('ct-group');
    $('#ct-add-btn').addEventListener('click', function () {
      var name = $('#ct-name').value.trim(); if (!name) { toast('Enter a name'); return; }
      api('moneyAddCategory', { category: { name: name, group: moneyGroupValue('ct-group'), kind: $('#ct-kind').value, icon: $('#ct-icon').value.trim() || '📦' } })
        .then(function (d) { state.money.categories.push(d.category); toast('Added ✓'); moneyRenderCategories(); }).catch(function (e) { toast(e.message); });
    });
    box.querySelectorAll('[data-ct-edit]').forEach(function (b) {
      b.addEventListener('click', function () { state.money.editCat = b.getAttribute('data-ct-edit'); moneyRenderCategories(); });
    });
    if (editId) {
      moneyBindGroupSelect('ce-group');
      var cancel = function () { state.money.editCat = ''; moneyRenderCategories(); };
      $('#ce-cancel').addEventListener('click', cancel);
      $('#ce-save').addEventListener('click', function () {
        var name = $('#ce-name').value.trim(); if (!name) { toast('Enter a name'); return; }
        var patch = { id: editId, name: name, group: moneyGroupValue('ce-group'), kind: $('#ce-kind').value, icon: $('#ce-icon').value.trim() || '📦' };
        var btn = $('#ce-save'); btn.disabled = true; btn.textContent = 'Saving…';
        api('moneyUpdateCategory', { category: patch }).then(function (d) {
          var i = state.money.categories.findIndex(function (c) { return c.id === editId; });
          if (i >= 0) state.money.categories[i] = d.category || Object.assign(state.money.categories[i], patch);
          state.money.editCat = ''; toast('Category updated ✓'); moneyRenderCategories();
        }).catch(function (e) {
          toast(e.message); btn.disabled = false; btn.textContent = 'Save';
        });
      });
    }
    box.querySelectorAll('[data-ct-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-ct-del');
        api('moneyDeleteCategory', { id: id }).then(function () { state.money.categories = state.money.categories.filter(function (c) { return c.id !== id; }); moneyRenderCategories(); });
      });
    });
  }

  /* ================= Recurring payments & installments =================
     Covers both shapes of "the same payment, again and again":
       · a subscription / bill — open-ended, `count` = 0
       · an EMI / instalment plan — a fixed `count` of payments, then done
     Rules live in the profile blob (saveGoals), which round-trips as free-form
     JSON — no new sheet column and no Apps Script redeploy needed. Marking one
     paid writes a REAL transaction through the normal moneyAddTxn path, so
     recurring spend lands in the dashboard, budget and Penny's context exactly
     like anything else. Nothing is auto-charged: a rule is a schedule, and only
     you confirm that money actually moved. */
  function moneyRules() { return (state.profile && state.profile.moneyRecurring) || []; }
  function moneySaveRules(rules, cb) {
    var p = Object.assign({}, state.profile, { moneyRecurring: rules });
    state.profile = p;
    return api('saveGoals', { profile: p }).then(function (d) {
      if (d && d.profile) state.profile = d.profile;
      if (cb) cb();
    });
  }
  function ymKey(date) { return String(date).slice(0, 7); }
  function daysInMonthOf(y, m) { return new Date(y, m + 1, 0).getDate(); }
  // The n-th due date of a rule, clamped into short months: a rule due on the
  // 31st falls on the 30th in April and the 28th/29th in February.
  function ruleDueDate(rule, n) {
    var start = parse(rule.startDate || todayStr());
    var day = Number(rule.dayOfMonth) || start.getDate();
    var d = new Date(start.getFullYear(), start.getMonth(), 1);
    if (rule.freq === 'yearly') d.setFullYear(d.getFullYear() + n); else d.setMonth(d.getMonth() + n);
    var dim = daysInMonthOf(d.getFullYear(), d.getMonth());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(Math.min(day, dim));
  }
  function rulePaidList(rule) { return Array.isArray(rule.paid) ? rule.paid : []; }
  // Instalments are finite; a subscription just keeps going.
  function ruleTotalCount(rule) { return Math.max(0, Number(rule.count) || 0); }
  function ruleIsDone(rule) {
    var total = ruleTotalCount(rule);
    return total > 0 && rulePaidList(rule).length >= total;
  }
  // The next unpaid instalment — index + its due date. null once a plan is finished.
  function ruleNext(rule) {
    var paid = rulePaidList(rule), total = ruleTotalCount(rule);
    var limit = total > 0 ? total : rulePaidList(rule).length + 240;
    for (var n = 0; n < limit; n++) {
      var due = ruleDueDate(rule, n);
      if (paid.indexOf(due) < 0) return { n: n, due: due };
    }
    return null;
  }
  function ruleMonthlyCost(rule) {
    var a = Number(rule.amount) || 0;
    return rule.freq === 'yearly' ? a / 12 : a;
  }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function moneyRenderRecurring() {
    var box = $('#money-recurring'); if (!box) return;
    var rules = moneyRules();
    var today = todayStr();
    var live = rules.filter(function (r) { return truthy(r.active) && !ruleIsDone(r); });
    var burn = live.reduce(function (s, r) { return s + ruleMonthlyCost(r); }, 0);
    // Everything already due (or due within a week), soonest first.
    var upcoming = [];
    rules.forEach(function (r) {
      if (!truthy(r.active) || ruleIsDone(r)) return;
      var nx = ruleNext(r); if (!nx) return;
      upcoming.push({ rule: r, due: nx.due, n: nx.n, days: daysBetween(today, nx.due) });
    });
    upcoming.sort(function (a, b) { return a.due < b.due ? -1 : 1; });
    var dueNow = upcoming.filter(function (u) { return u.days <= 7; });

    box.innerHTML =
      '<div class="card"><div class="eyebrow">Committed each month</div>' +
        '<div class="metric-big"><b>' + rupee(Math.round(burn)) + '</b> <span class="muted">/mo</span></div>' +
        '<div class="muted tiny">' + live.length + ' active · ' + rupee(Math.round(burn * 12)) + ' a year</div></div>' +
      (dueNow.length
        ? '<div class="card"><div class="eyebrow" style="margin-bottom:8px">⏰ Due now</div>' + dueNow.map(function (u) {
            var late = u.days < 0;
            return '<div class="list-row rc-due' + (late ? ' late' : '') + '">' +
              '<div><b>' + esc(u.rule.name) + '</b> <span class="muted tiny">' + rupee(u.rule.amount) + '</span>' +
                '<div class="muted tiny">' + (late ? Math.abs(u.days) + 'd overdue' : u.days === 0 ? 'due today' : 'in ' + u.days + 'd') +
                ' · ' + shortDate(u.due) + moneyRuleProgress(u.rule, u.n) + '</div></div>' +
              '<button class="btn fr-mini" data-rc-pay="' + u.rule.id + '">Mark paid</button></div>';
          }).join('') + '</div>'
        : '') +
      '<div class="card"><div class="eyebrow">Add recurring payment</div>' +
        '<label>Name<input id="rc-name" placeholder="e.g. Netflix, Bike EMI" /></label>' +
        '<div class="manual-grid">' +
          '<label>Amount (₹)<input id="rc-amt" type="number" inputmode="numeric" /></label>' +
          '<label>Every<select id="rc-freq"><option value="monthly">Month</option><option value="yearly">Year</option></select></label>' +
          '<label>First payment<input id="rc-start" type="date" value="' + today + '" /></label>' +
          '<label>Instalments <span class="muted tiny">blank = ongoing</span><input id="rc-count" type="number" inputmode="numeric" placeholder="e.g. 12" /></label>' +
          '<label>Card / account<select id="rc-acct">' + moneyAcctOptions() + '</select></label>' +
          '<label>Category<select id="rc-cat">' + moneyCatOptions() + '</select></label>' +
        '</div>' +
        '<button id="rc-add" class="btn primary block">Add recurring payment</button></div>' +
      (rules.length
        ? '<div class="card"><div class="eyebrow" style="margin-bottom:8px">All recurring · ' + rules.length + '</div>' +
          rules.map(function (r) { return moneyRuleRow(r, today); }).join('') + '</div>'
        : '<div class="card"><p class="muted tiny" style="margin:0">Nothing recurring yet. Add a subscription, a bill, or an EMI above and it’ll show up here with its next due date.</p></div>');

    $('#rc-add').addEventListener('click', function () {
      var name = $('#rc-name').value.trim();
      var amt = Number($('#rc-amt').value) || 0;
      if (!name) { toast('Enter a name'); return; }
      if (amt <= 0) { toast('Enter an amount'); return; }
      var start = $('#rc-start').value || today;
      var rule = {
        id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: name.slice(0, 40), amount: amt, freq: $('#rc-freq').value,
        startDate: start, dayOfMonth: parse(start).getDate(),
        count: Math.max(0, Number($('#rc-count').value) || 0),
        accountId: $('#rc-acct').value, categoryId: $('#rc-cat').value,
        paid: [], active: true
      };
      var btn = $('#rc-add'); btn.disabled = true; btn.textContent = 'Saving…';
      moneySaveRules(moneyRules().concat([rule])).then(function () {
        toast('Added ✓'); moneyRenderRecurring();
      }).catch(function (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Add recurring payment'; });
    });

    box.querySelectorAll('[data-rc-pay]').forEach(function (b) {
      b.addEventListener('click', function () { moneyPayRule(b.getAttribute('data-rc-pay'), b); });
    });
    box.querySelectorAll('[data-rc-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-rc-toggle');
        var rules2 = moneyRules().map(function (r) { return r.id === id ? Object.assign({}, r, { active: !truthy(r.active) }) : r; });
        moneySaveRules(rules2).then(moneyRenderRecurring).catch(function (e) { toast(e.message); });
      });
    });
    box.querySelectorAll('[data-rc-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-rc-del');
        if (!confirm('Delete this recurring payment? Transactions already logged from it are kept.')) return;
        moneySaveRules(moneyRules().filter(function (r) { return r.id !== id; })).then(moneyRenderRecurring).catch(function (e) { toast(e.message); });
      });
    });
    box.querySelectorAll('[data-rc-undo]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-rc-undo');
        var rules2 = moneyRules().map(function (r) {
          if (r.id !== id) return r;
          var paid = rulePaidList(r).slice(); paid.pop();
          return Object.assign({}, r, { paid: paid });
        });
        // Only the schedule is rewound — the transaction it created stays put,
        // so delete that from History if it shouldn't have been logged.
        moneySaveRules(rules2).then(function () { toast('Marked unpaid — the transaction is still in History'); moneyRenderRecurring(); })
          .catch(function (e) { toast(e.message); });
      });
    });
  }
  function moneyRuleProgress(rule, n) {
    var total = ruleTotalCount(rule);
    if (!total) return '';
    return ' · instalment ' + (n + 1) + ' of ' + total;
  }
  function moneyRuleRow(rule, today) {
    var done = ruleIsDone(rule), on = truthy(rule.active);
    var nx = done ? null : ruleNext(rule);
    var total = ruleTotalCount(rule), paidN = rulePaidList(rule).length;
    var acct = moneyAcctById(rule.accountId), cat = moneyCatById(rule.categoryId);
    var sub = [];
    if (done) sub.push('✅ all ' + total + ' paid');
    else if (!on) sub.push('paused');
    else if (nx) {
      var d = daysBetween(today, nx.due);
      sub.push(d < 0 ? '⚠️ ' + Math.abs(d) + 'd overdue' : d === 0 ? 'due today' : 'next ' + shortDate(nx.due));
    }
    if (total) sub.push(paidN + '/' + total + ' paid');
    if (acct) sub.push(esc(acct.name));
    if (cat) sub.push(cat.icon + ' ' + esc(cat.name));
    var pct = total ? Math.min(100, Math.round(paidN / total * 100)) : 0;
    return '<div class="rc-item' + (on && !done ? '' : ' off') + '">' +
      '<div class="list-row">' +
        '<div><b>' + esc(rule.name) + '</b> <span class="muted tiny">' + rupee(rule.amount) + '/' + (rule.freq === 'yearly' ? 'yr' : 'mo') + '</span>' +
          '<div class="muted tiny">' + sub.join(' · ') + '</div></div>' +
        '<span class="fr-acts">' +
          (paidN ? '<button class="btn fr-mini" data-rc-undo="' + rule.id + '" title="Undo last payment">↶</button>' : '') +
          (done ? '' : '<button class="btn fr-mini" data-rc-toggle="' + rule.id + '">' + (on ? 'Pause' : 'Resume') + '</button>') +
          '<button class="list-del" data-rc-del="' + rule.id + '">✕</button></span>' +
      '</div>' +
      (total ? '<div class="fc-bar rc-bar"><span style="width:' + pct + '%"></span></div>' : '') +
    '</div>';
  }
  // Marking paid logs a genuine transaction, then records that instalment as
  // settled. The rule is only advanced once the transaction is confirmed —
  // otherwise a failed save would silently skip a payment.
  function moneyPayRule(id, btn) {
    var rule = moneyRules().filter(function (r) { return r.id === id; })[0];
    if (!rule) return;
    var nx = ruleNext(rule); if (!nx) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Logging…'; }
    var txn = {
      date: nx.due > todayStr() ? todayStr() : nx.due,
      amount: Number(rule.amount) || 0, type: 'expense',
      categoryId: rule.categoryId || '', accountId: rule.accountId || '',
      merchant: rule.name, note: ruleTotalCount(rule) ? 'Instalment ' + (nx.n + 1) + ' of ' + ruleTotalCount(rule) : 'Recurring payment',
      source: 'recurring'
    };
    api('moneyAddTxn', { transaction: txn }).then(function (d) {
      state.money.status = d.status || state.money.status;
      var rules = moneyRules().map(function (r) {
        return r.id === id ? Object.assign({}, r, { paid: rulePaidList(r).concat([nx.due]) }) : r;
      });
      return moneySaveRules(rules).then(function () {
        var after = rules.filter(function (r) { return r.id === id; })[0];
        toast(ruleIsDone(after) ? rule.name + ' — final instalment paid 🎉' : rule.name + ' logged ✓');
        moneyRenderRecurring(); moneyRefreshSilently();
      });
    }).catch(function (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Mark paid'; }
    });
  }

  function moneyRenderBudget() {
    var box = $('#money-budget'); if (!box) return;
    var b = state.money.budget || {};
    var caps = b.perCategory || {};
    box.innerHTML =
      '<div class="card"><div class="eyebrow">Monthly budget</div>' +
        '<label>Overall limit (₹)<input id="bg-limit" type="number" inputmode="numeric" value="' + (b.limit || '') + '" /></label>' +
        '<div class="manual-grid"><label>Monthly income (₹)<input id="bg-income" type="number" inputmode="numeric" value="' + (b.monthlyIncome || '') + '" /></label>' +
        '<label>Savings goal (₹/mo)<input id="bg-savings" type="number" inputmode="numeric" value="' + (b.savingsGoal || '') + '" /></label></div>' +
        '<button id="bg-save-btn" class="btn primary block">Save budget</button></div>' +
      '<div class="card"><div class="eyebrow">Per-category caps</div>' +
        '<div class="manual-grid"><label>Category<select id="bg-cat">' + moneyCatOptions() + '</select></label>' +
        '<label>Cap (₹/mo)<input id="bg-cap-amt" type="number" inputmode="numeric" /></label></div>' +
        '<button id="bg-cap-add" class="btn block">Set cap</button>' +
        '<div id="bg-cap-list" style="margin-top:8px">' + Object.keys(caps).map(function (cid) {
          var c = moneyCatById(cid); if (!c) return '';
          return '<div class="list-row"><span>' + c.icon + ' ' + esc(c.name) + '</span><span>' + rupee(caps[cid]) + ' <button class="list-del" data-cap-del="' + cid + '">✕</button></span></div>';
        }).join('') + '</div></div>';
    $('#bg-save-btn').addEventListener('click', function () {
      var payload = { overall: Number($('#bg-limit').value) || 0, perCategory: caps, monthlyIncome: Number($('#bg-income').value) || 0, savingsGoal: Number($('#bg-savings').value) || 0 };
      api('moneySaveBudget', payload).then(function (d) { state.money.budget = d.budget; state.money.status = d.status; toast('Saved ✓'); moneyRenderBudget(); moneyRefreshSilently(); }).catch(function (e) { toast(e.message); });
    });
    $('#bg-cap-add').addEventListener('click', function () {
      var cid = $('#bg-cat').value, amt = Number($('#bg-cap-amt').value) || 0;
      if (!cid || amt <= 0) { toast('Pick a category and amount'); return; }
      caps[cid] = amt;
      api('moneySaveBudget', { overall: Number(b.limit) || 0, perCategory: caps, monthlyIncome: b.monthlyIncome || 0, savingsGoal: b.savingsGoal || 0 })
        .then(function (d) { state.money.budget = d.budget; state.money.status = d.status; toast('Cap set ✓'); moneyRenderBudget(); moneyRefreshSilently(); }).catch(function (e) { toast(e.message); });
    });
    box.querySelectorAll('[data-cap-del]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cid = btn.getAttribute('data-cap-del'); delete caps[cid];
        api('moneySaveBudget', { overall: Number(b.limit) || 0, perCategory: caps, monthlyIncome: b.monthlyIncome || 0, savingsGoal: b.savingsGoal || 0 })
          .then(function (d) { state.money.budget = d.budget; state.money.status = d.status; toast('Removed'); moneyRenderBudget(); moneyRefreshSilently(); });
      });
    });
  }

  function renderSubs() {
    var box = $('#subs-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'sub' }).then(function (dd) {
      var items = (dd.items || []);
      function monthly(x) { var a = Number(x.amount) || 0; return String(x.cycle) === 'yearly' ? a / 12 : a; }
      var active = items.filter(function (x) { return truthy(x.active); });
      var burn = active.reduce(function (s, x) { return s + monthly(x); }, 0);
      box.innerHTML =
        '<div class="card"><div class="eyebrow">Monthly burn</div><div class="metric-big"><b>' + rupee(burn) + '</b> <span class="muted">/mo</span></div><div class="muted tiny">' + rupee(burn * 12) + ' / year · ' + active.length + ' active</div></div>' +
        '<div class="card"><div class="eyebrow">Add subscription</div>' +
          '<label>Name<input id="sb-name" placeholder="e.g. Spotify" /></label>' +
          '<div class="manual-grid"><label>Amount (₹)<input id="sb-amt" type="number" inputmode="numeric" /></label>' +
          '<label>Cycle<select id="sb-cycle"><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label></div>' +
          '<button id="sb-add" class="btn primary block">Add</button></div>' +
        '<div class="card"><div class="eyebrow">Your subscriptions · ' + items.length + '</div><div id="sb-list">' +
          (items.length ? items.map(function (x) { var on = truthy(x.active); return '<div class="list-row' + (on ? '' : ' off') + '"><div><b>' + esc(x.name) + '</b> <span class="muted tiny">' + rupee(x.amount) + '/' + (String(x.cycle) === 'yearly' ? 'yr' : 'mo') + '</span></div><span class="fr-acts"><button class="btn fr-mini" data-toggle="' + x.id + '">' + (on ? 'Pause' : 'Resume') + '</button><button class="list-del" data-del="' + x.id + '">✕</button></span></div>'; }).join('') : '<p class="muted tiny">No subscriptions yet.</p>') +
          '</div></div>';
      $('#sb-add').addEventListener('click', function () {
        var name = $('#sb-name').value.trim(), amt = Number($('#sb-amt').value) || 0;
        if (!name || amt <= 0) { toast('Enter name & amount'); return; }
        api('listAdd', { kind: 'sub', item: { name: name, amount: amt, cycle: $('#sb-cycle').value, renewDay: '', active: true } }).then(function () { toast('Added ✓'); renderSubs(); }).catch(function (e) { toast(e.message); });
      });
      $('#sb-list').addEventListener('click', function (e) {
        var del = e.target.closest('[data-del]'), tg = e.target.closest('[data-toggle]');
        if (del) api('listDelete', { kind: 'sub', id: del.getAttribute('data-del') }).then(renderSubs);
        else if (tg) { var id = tg.getAttribute('data-toggle'); var it = items.filter(function (x) { return x.id === id; })[0]; api('listUpdate', { kind: 'sub', id: id, item: { active: !truthy(it.active) } }).then(renderSubs); }
      });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  function renderSavings() {
    var box = $('#savings-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'saving' }).then(function (dd) {
      var items = (dd.items || []);
      var total = items.reduce(function (s, x) { return s + (Number(x.saved) || 0); }, 0);
      box.innerHTML =
        '<div class="card"><div class="eyebrow">Total saved</div><div class="metric-big"><b>' + rupee(total) + '</b></div></div>' +
        '<div class="card"><div class="eyebrow">New goal</div>' +
          '<label>Name<input id="sv-name" placeholder="e.g. Emergency fund" /></label>' +
          '<label>Target (₹)<input id="sv-target" type="number" inputmode="numeric" /></label>' +
          '<button id="sv-add" class="btn primary block">Create goal</button></div>' +
        items.map(function (x) { var saved = Number(x.saved) || 0, target = Number(x.target) || 0, pct = target ? Math.min(100, Math.round(saved / target * 100)) : 0; return '<div class="card"><div class="list-row"><b>' + esc(x.name) + '</b><button class="list-del" data-del="' + x.id + '">✕</button></div><div class="muted tiny">' + rupee(saved) + ' / ' + rupee(target) + ' · ' + pct + '%</div><div class="fc-bar" style="margin:8px 0"><span style="width:' + pct + '%"></span></div><button class="btn block" data-add-amt="' + x.id + '">+ Add money</button></div>'; }).join('');
      $('#sv-add').addEventListener('click', function () {
        var name = $('#sv-name').value.trim(), target = Number($('#sv-target').value) || 0;
        if (!name) { toast('Enter a name'); return; }
        api('listAdd', { kind: 'saving', item: { name: name, target: target, saved: 0 } }).then(function () { toast('Created ✓'); renderSavings(); }).catch(function (e) { toast(e.message); });
      });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { api('listDelete', { kind: 'saving', id: b.getAttribute('data-del') }).then(renderSavings); }); });
      box.querySelectorAll('[data-add-amt]').forEach(function (b) { b.addEventListener('click', function () { var id = b.getAttribute('data-add-amt'); var it = items.filter(function (x) { return x.id === id; })[0]; var x = prompt('Add how much to ' + it.name + '? (₹)'); if (x == null) return; var add = Number(x) || 0; if (add <= 0) return; api('listUpdate', { kind: 'saving', id: id, item: { saved: (Number(it.saved) || 0) + add } }).then(function () { toast('Added ✓'); renderSavings(); }); }); });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  /* ---------------- Tasks (to-do with due dates + priority alerts) ---------- */
  var TK_PRI = {
    high:   { label: 'High',   c: '#fb5570', rank: 0 },
    normal: { label: 'Normal', c: '#38bdf8', rank: 1 },
    low:    { label: 'Low',    c: '#8b909c', rank: 2 }
  };
  // Google Sheets round-trips a date input as a full ISO string; accept both.
  function taskDueInfo(due) {
    if (!due) return null;
    var s = String(due);
    var d = s.length <= 10 ? new Date(s + 'T23:59:00') : new Date(s);
    if (isNaN(d.getTime())) return null;
    var dayMs = 86400000, ms = d.getTime() - Date.now();
    var diffDays = Math.round((new Date(fmt(d)).getTime() - new Date(todayStr()).getTime()) / dayMs);
    var hasTime = s.length > 10;
    var label;
    if (diffDays < 0) label = (diffDays === -1 ? '1 day' : Math.abs(diffDays) + ' days') + ' overdue';
    else if (diffDays === 0) label = hasTime ? 'Today ' + clockTime(d.toISOString()) : 'Today';
    else if (diffDays === 1) label = hasTime ? 'Tomorrow ' + clockTime(d.toISOString()) : 'Tomorrow';
    else if (diffDays <= 6) label = 'in ' + diffDays + ' days';
    else label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    var urgency = ms < 0 ? 'over' : ms < dayMs ? 'soon' : diffDays <= 3 ? 'near' : 'later';
    return { date: d, label: label, urgency: urgency, ms: ms, diffDays: diffDays };
  }
  function tasksAlertsEnabled() { return localStorage.getItem('hard_taskalert') === '1'; }
  function taskNotified() { try { return JSON.parse(localStorage.getItem('hard_tasknotified') || '{}'); } catch (e) { return {}; } }
  // Fire a browser notification for each urgent high-priority task, once per day.
  function fireTaskAlerts(urgent) {
    if (!tasksAlertsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;
    var m = taskNotified(), changed = false;
    urgent.forEach(function (x) {
      if (m[x.id] === todayStr()) return;
      var di = taskDueInfo(x.due);
      try {
        new Notification((di && di.urgency === 'over' ? '⚠️ Overdue' : '⏰ Due soon') + ': ' + x.title, { body: di ? di.label : '', tag: 'task-' + x.id });
        m[x.id] = todayStr(); changed = true;
      } catch (e) {}
    });
    if (changed) localStorage.setItem('hard_tasknotified', JSON.stringify(m));
  }
  function renderTasks() {
    var box = $('#tasks-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'task' }).then(function (dd) {
      var items = (dd.items || []);
      var open = items.filter(function (x) { return !truthy(x.done); });
      var done = items.filter(function (x) { return truthy(x.done); });
      // Sort open: soonest due first (overdue at the very top), then by priority.
      open.sort(function (a, b) {
        var da = taskDueInfo(a.due), db = taskDueInfo(b.due);
        var am = da ? da.ms : Infinity, bm = db ? db.ms : Infinity;
        if (am !== bm) return am - bm;
        return (TK_PRI[a.priority] || TK_PRI.normal).rank - (TK_PRI[b.priority] || TK_PRI.normal).rank;
      });
      // Urgent = high priority that's overdue or due within 24h.
      var urgent = open.filter(function (x) { var di = taskDueInfo(x.due); return (x.priority === 'high') && di && di.ms < 86400000; });
      fireTaskAlerts(urgent);

      function row(x) {
        var di = taskDueInfo(x.due), pri = TK_PRI[x.priority] || TK_PRI.normal, isDone = truthy(x.done);
        return '<div class="tk-item' + (di && !isDone ? ' u-' + di.urgency : '') + (isDone ? ' done' : '') + '" style="--pc:' + pri.c + '">' +
          '<label class="tk-check"><input type="checkbox" data-done="' + x.id + '"' + (isDone ? ' checked' : '') + ' /><span class="tk-box">✓</span></label>' +
          '<div class="tk-body"><div class="tk-title-line' + (isDone ? ' tk-done' : '') + '">' + esc(x.title) + '</div>' +
            '<div class="tk-meta">' +
              (x.priority && x.priority !== 'normal' ? '<span class="tk-pri" style="--pc:' + pri.c + '">' + pri.label + '</span>' : '') +
              (di ? '<span class="tk-duechip u-' + di.urgency + '">' + (di.urgency === 'over' ? '⚠️ ' : di.urgency === 'soon' ? '⏰ ' : '📅 ') + esc(di.label) + '</span>' : '') +
            '</div></div>' +
          '<button class="tk-del" data-del="' + x.id + '" aria-label="Delete">✕</button></div>';
      }

      var alertOn = tasksAlertsEnabled() && ('Notification' in window) && Notification.permission === 'granted';
      var banner = urgent.length
        ? '<div class="card tk-alert-banner"><span class="tk-alert-ico">🔔</span><div><b>' + urgent.length + ' high-priority task' + (urgent.length === 1 ? '' : 's') + ' need attention</b>' +
            '<div class="muted tiny">' + esc(urgent.slice(0, 2).map(function (x) { var di = taskDueInfo(x.due); return x.title + (di ? ' · ' + di.label : ''); }).join(' · ')) + (urgent.length > 2 ? ' …' : '') + '</div></div></div>'
        : '';

      box.innerHTML = banner +
        '<div class="card"><div class="tk-add-head"><span class="eyebrow">Add task</span>' +
          '<button id="tk-bell" class="tk-bell' + (alertOn ? ' on' : '') + '" type="button" title="Deadline alerts">' + (alertOn ? '🔔 Alerts on' : '🔕 Enable alerts') + '</button></div>' +
          '<label>Task<input id="tk-title" placeholder="e.g. Submit tax documents" /></label>' +
          '<div class="manual-grid"><label>Due date<input id="tk-due" type="date" /></label>' +
          '<label>Time (optional)<input id="tk-time" type="time" /></label></div>' +
          '<label>Priority<select id="tk-pri"><option value="high">🔴 High</option><option value="normal" selected>🔵 Normal</option><option value="low">⚪ Low</option></select></label>' +
          '<button id="tk-add" class="btn primary block" style="margin-top:12px">Add task</button></div>' +
        '<div class="card"><div class="eyebrow">Open · ' + open.length + '</div>' + (open.length ? open.map(row).join('') : '<p class="muted tiny">Nothing open 🎉</p>') + '</div>' +
        (done.length ? '<div class="card"><div class="eyebrow">Done · ' + done.length + '</div>' + done.map(row).join('') + '</div>' : '');

      $('#tk-add').addEventListener('click', function () {
        var t = $('#tk-title').value.trim(); if (!t) { toast('Enter a task'); return; }
        var date = $('#tk-due').value, time = $('#tk-time').value;
        var due = date ? (time ? date + 'T' + time : date) : '';
        api('listAdd', { kind: 'task', item: { title: t, due: due, priority: $('#tk-pri').value, done: false } }).then(function () { toast('Added ✓'); renderTasks(); }).catch(function (e) { toast(e.message); });
      });
      var bell = $('#tk-bell');
      if (bell) bell.addEventListener('click', function () {
        if (!('Notification' in window)) { toast('This device doesn’t support notifications'); return; }
        if (tasksAlertsEnabled() && Notification.permission === 'granted') { localStorage.setItem('hard_taskalert', '0'); toast('Alerts off'); renderTasks(); return; }
        Notification.requestPermission().then(function (perm) {
          if (perm === 'granted') { localStorage.setItem('hard_taskalert', '1'); toast('Deadline alerts on 🔔'); }
          else toast('Allow notifications in your browser to enable alerts');
          renderTasks();
        });
      });
      box.querySelectorAll('[data-done]').forEach(function (c) { c.addEventListener('change', function () { api('listUpdate', { kind: 'task', id: c.getAttribute('data-done'), item: { done: c.checked } }).then(renderTasks); }); });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { api('listDelete', { kind: 'task', id: b.getAttribute('data-del') }).then(renderTasks); }); });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  // Per-goal progress % lives in the profile blob (no backend schema change).
  function goalProgress() { return (state.profile && state.profile.goalProgress) || {}; }
  var GOAL_STATUS = {
    'on-track': { label: 'On track', cls: 'gs-ok' },
    'behind':   { label: 'At risk',  cls: 'gs-warn' },
    'done':     { label: 'Done 🏆',  cls: 'gs-done' }
  };
  function renderGoals() {
    var box = $('#goals-app'); if (!box) return;
    box.innerHTML = '<p class="muted tiny">Loading…</p>';
    api('listGet', { kind: 'goal' }).then(function (dd) {
      var items = (dd.items || []);
      var prog = goalProgress();
      // Year pace header (Strides-style): where the year is vs where your goals are.
      var now = new Date();
      var year = now.getFullYear();
      var dayOfYear = Math.floor((now - new Date(year, 0, 1)) / 864e5) + 1;
      var yearPct = Math.round(dayOfYear / 365 * 100);
      var doneCount = items.filter(function (x) { return String(x.status) === 'done'; }).length;
      var avg = items.length ? Math.round(items.reduce(function (s, x) {
        return s + (String(x.status) === 'done' ? 100 : (Number(prog[x.id]) || 0));
      }, 0) / items.length) : 0;
      box.innerHTML =
        (items.length ?
          '<div class="card"><div class="eyebrow">' + year + ' · Year check</div>' +
          '<div class="yeartrack"><div class="yt-row"><span>Year gone</span><b>' + yearPct + '%</b></div>' +
          '<div class="fc-bar"><span style="width:' + yearPct + '%;background:var(--muted)"></span></div>' +
          '<div class="yt-row" style="margin-top:8px"><span>Goals progress</span><b>' + avg + '%' + (avg >= yearPct ? ' · ahead 🔥' : ' · behind pace') + '</b></div>' +
          '<div class="fc-bar"><span style="width:' + avg + '%"></span></div></div>' +
          '<div class="muted tiny" style="margin-top:8px">' + doneCount + '/' + items.length + ' goals completed</div></div>' : '') +
        (items.length ? items.map(function (x) {
          var st = GOAL_STATUS[String(x.status)] || GOAL_STATUS['on-track'];
          var p = String(x.status) === 'done' ? 100 : Math.max(0, Math.min(100, Number(prog[x.id]) || 0));
          return '<div class="card goal-card">' +
            '<div class="list-row" style="border:0;padding:0"><b>' + esc(x.title) + '</b>' +
              '<span style="display:flex;gap:6px;align-items:center"><button class="goal-status ' + st.cls + '" data-cycle="' + x.id + '" data-cur="' + esc(String(x.status || 'on-track')) + '">' + st.label + '</button>' +
              '<button class="list-del" data-del="' + x.id + '">✕</button></span></div>' +
            '<div class="goal-progress"><input type="range" min="0" max="100" step="5" value="' + p + '" data-prog="' + x.id + '"' + (String(x.status) === 'done' ? ' disabled' : '') + ' />' +
              '<span class="mono goal-pct" id="gp-' + x.id + '">' + p + '%</span></div>' +
            '<div class="fc-bar' + (p >= 100 ? '' : '') + '" style="margin-top:2px"><span id="gpb-' + x.id + '" style="width:' + p + '%"></span></div>' +
            (x.note ? '<div class="muted tiny" style="margin-top:8px">' + esc(x.note) + '</div>' : '') +
          '</div>';
        }).join('') : '<div class="card"><p class="muted tiny" style="margin:0">No goals yet — what do you want ' + year + ' to be remembered for? Add the first one below 🎯</p></div>') +
        '<div class="card"><div class="eyebrow">New yearly goal</div>' +
          '<label>Goal<input id="gl-title" placeholder="e.g. Read 12 books" /></label>' +
          '<div class="manual-grid"><label>Status<select id="gl-status"><option value="on-track">On track</option><option value="behind">At risk</option><option value="done">Done</option></select></label>' +
          '<label>Note<input id="gl-note" placeholder="optional" /></label></div>' +
          '<button id="gl-add" class="btn primary block">Add goal</button></div>';
      $('#gl-add').addEventListener('click', function () { var t = $('#gl-title').value.trim(); if (!t) { toast('Enter a goal'); return; } api('listAdd', { kind: 'goal', item: { title: t, status: $('#gl-status').value, note: $('#gl-note').value.trim() } }).then(function () { toast('Added ✓'); renderGoals(); }).catch(function (e) { toast(e.message); }); });
      box.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { api('listDelete', { kind: 'goal', id: b.getAttribute('data-del') }).then(renderGoals); }); });
      // Tap the status chip to cycle On track → At risk → Done.
      box.querySelectorAll('[data-cycle]').forEach(function (b) {
        b.addEventListener('click', function () {
          var order = ['on-track', 'behind', 'done'];
          var next = order[(order.indexOf(b.getAttribute('data-cur')) + 1) % order.length];
          api('listUpdate', { kind: 'goal', id: b.getAttribute('data-cycle'), item: { status: next } })
            .then(function () { if (next === 'done') toast('Goal done — legend! 🏆'); renderGoals(); })
            .catch(function (e) { toast(e.message); });
        });
      });
      // Progress slider: live bar update, save on release (debounced via change).
      box.querySelectorAll('[data-prog]').forEach(function (r) {
        var id = r.getAttribute('data-prog');
        r.addEventListener('input', function () {
          $('#gp-' + id).textContent = r.value + '%';
          $('#gpb-' + id).style.width = r.value + '%';
        });
        r.addEventListener('change', function () {
          var gp = Object.assign({}, goalProgress()); gp[id] = Number(r.value) || 0;
          saveProfileKey('goalProgress', gp);
        });
      });
    }).catch(function (e) { box.innerHTML = '<p class="muted tiny">' + esc(e.message) + '</p>'; });
  }

  function renderLibrary() {
    var box = $('#library-groups'); if (!box) return;
    var live = APPS.filter(function (a) { return a.open; }).length;
    $('#lib-count').textContent = APPS.length + ' apps · ' + live + ' live';
    box.innerHTML = PILLARS.map(function (p) {
      var apps = APPS.filter(function (a) { return a.pillar === p.id; });
      var tiles = apps.map(function (a) {
        return '<button class="app-tile' + (a.open ? '' : ' soon') + '" data-app="' + a.id + '" style="--pc:' + p.color + '">' +
          '<span class="app-ico">' + a.icon + '</span><span class="app-name">' + a.name + '</span>' +
          (a.open ? '' : '<span class="app-soon">soon</span>') + '</button>';
      }).join('');
      return '<div class="lib-group"><div class="lib-group-head eyebrow" style="color:' + p.color + '">' + p.name + '</div>' +
        '<div class="app-grid">' + tiles + '</div></div>';
    }).join('');
  }
  function openApp(id) {
    var a = APPS.filter(function (x) { return x.id === id; })[0];
    if (!a) return;
    if (a.open) a.open();
    else toast(a.name + ' — coming soon ✨');
  }
  function homeQuickAction(qa) {
    if (qa === 'water') {
      state.today.waterMl = (Number(state.today.waterMl) || 0) + 250;
      afterWaterChange();
      toast('+250 ml 💧');
    } else if (qa === 'scan') {
      openFoodModal('Snacks');
      setTimeout(function () { $('#food-manual').classList.remove('hidden'); }, 150);
    } else if (qa === 'coach') {
      openCoach();
    } else if (qa === 'today') {
      switchView('today');
    }
  }

  /* ---------------- AI Coach chat ---------------- */
  function coachKey() { return 'hard_coach_' + (state.coachDomain || 'hard') + '_' + (state.username || ''); }
  function loadCoachHistory() {
    try { return JSON.parse(localStorage.getItem(coachKey()) || '[]'); } catch (e) { return []; }
  }
  function saveCoachHistory() {
    try { localStorage.setItem(coachKey(), JSON.stringify((state.coachHistory || []).slice(-20))); } catch (e) {}
  }
  function openCoach(domain) {
    state.coachDomain = domain || 'hard';
    state.coachHistory = loadCoachHistory();
    $('#coach-title').textContent = state.coachDomain === 'money' ? '💰 Penny' : '✨ AI Coach';
    show('#coach-modal');
    renderCoachMsgs();
    setTimeout(function () { $('#coach-text').focus(); }, 120);
  }
  function coachFormat(text) {
    var s = esc(text);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/^\s*[-*]\s+/gm, '• ');
    return s.replace(/\n/g, '<br>');
  }
  function renderCoachMsgs(typing) {
    var box = $('#coach-msgs'); if (!box) return;
    var hist = state.coachHistory || [];
    var html = '';
    if (!hist.length) {
      html += state.coachDomain === 'money'
        ? '<div class="cm cm-model">Hi ' + esc(firstName(state.user.displayName)) + '! I’m Penny, your money coach — I can see your spending, budget and categories. ' +
          'Ask me about your budget pace, where you’re overspending, or how to hit a savings goal. 💰</div>'
        : '<div class="cm cm-model">Hey ' + esc(firstName(state.user.displayName)) +
          '! I’m your AI coach and I can see your 75 Hard progress, diet, fasting and mood. ' +
          'Ask me anything — how you’re tracking, diet tweaks, workout ideas, or a motivation boost. 💪</div>';
    }
    hist.forEach(function (m) {
      html += '<div class="cm cm-' + (m.role === 'model' ? 'model' : 'user') + '">' + coachFormat(m.text) + '</div>';
    });
    if (typing) html += '<div class="cm cm-model cm-typing"><span></span><span></span><span></span></div>';
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }
  function sendCoach() {
    if (state.coachBusy) return;
    var inp = $('#coach-text');
    var msg = (inp.value || '').trim();
    if (!msg) return;
    inp.value = ''; inp.style.height = 'auto';
    if (state.coachHistory == null) state.coachHistory = [];
    var priorHistory = state.coachHistory.slice();   // exclude the new message
    state.coachHistory.push({ role: 'user', text: msg });
    state.coachBusy = true; $('#coach-send').disabled = true;
    renderCoachMsgs(true);
    var action = state.coachDomain === 'money' ? 'moneyCoachChat' : 'coachChat';
    api(action, { message: msg, history: priorHistory }).then(function (d) {
      state.coachHistory.push({ role: 'model', text: d.reply || '(no reply)' });
      saveCoachHistory();
    }).catch(function (e) {
      state.coachHistory.push({ role: 'model', text: '⚠️ ' + (e.message || 'Coach unavailable right now.') });
    }).then(function () {
      state.coachBusy = false; $('#coach-send').disabled = false;
      renderCoachMsgs();
    });
  }
  function clearCoach() {
    if (!(state.coachHistory && state.coachHistory.length)) return;
    if (!confirm('Clear this conversation?')) return;
    state.coachHistory = []; saveCoachHistory(); renderCoachMsgs();
  }

  /* ---------------- Start ---------------- */
  function boot() {
    applyTheme(currentTheme());
    initAuth();
    var splash = $('#splash');
    setTimeout(function () { splash.classList.add('fade'); }, 600);

    if (state.token && state.username) {
      // optimistic: show cached immediately, then refresh
      var cache = JSON.parse(localStorage.getItem('hard_cache') || 'null');
      var before = null;
      if (cache && cache.user) {
        state.user = cache.user; state.logs = cache.logs || [];
        state.today = Object.assign(emptyDay(todayStr()), logFor(todayStr()) || {});
        before = bootSignature();
        enterApp();
      }
      loadState().then(function () {
        if (!state.user) return;
        if (!cache) { enterApp(); renderAll(); return; }
        // Re-render only when the fetch actually brought something new.
        // Repainting identical data was a visible flash on every launch.
        if (bootSignature() !== before) renderAll();
      }).catch(function () { if (!cache) showAuth(); });
    } else {
      showAuth();
    }
  }
  function showAuth() { show('#auth-screen'); }
  // Cheap fingerprint of everything the first screen draws from, so boot can
  // tell "the server agreed with the cache" from "there's new data".
  function bootSignature() {
    var p = state.profile || {};
    return [
      (state.logs || []).length,
      JSON.stringify(logFor(todayStr()) || {}),
      state.user && state.user.startDate,
      state.user && state.user.displayName,
      JSON.stringify(p.challenge || ''),
      (p.customTasks || []).length
    ].join('|');
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) {
        // Actively check for a newer build each launch so updates aren't missed.
        try { reg.update(); } catch (e) {}
      }).catch(function () {});
    });
    // When a new service worker takes control (a fresh build shipped), reload
    // so the page runs the new code instead of the stale cached version — but
    // only in the first few seconds, while you're still looking at the splash.
    // Yanking the page out from under someone mid-tap reads as the app
    // glitching; a build that lands later simply applies on the next launch.
    var swReloaded = false;
    var bootedAt = Date.now();
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (swReloaded) return;
      if (Date.now() - bootedAt > 5000) return;   // mid-session: wait for next launch
      swReloaded = true;
      window.location.reload();
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
