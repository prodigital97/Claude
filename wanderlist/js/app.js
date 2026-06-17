/* Wanderlist — save travel spots from Instagram, filter by category.
 * Prototype: data lives in this device's localStorage. No backend required.
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- config */

  // Each category has an emoji and keywords used to auto-detect the category
  // from a shared caption / URL.
  var CATEGORIES = [
    { id: 'destination', label: 'Destinations', emoji: '🏞️', keywords: ['destination', 'city', 'town', 'village', 'island', 'mountain', 'valley', 'national park', 'trek', 'hike', 'roadtrip', 'wanderlust', 'travel', 'view', 'viewpoint', 'sightseeing'] },
    { id: 'restaurant',  label: 'Restaurants',  emoji: '🍽️', keywords: ['restaurant', 'dinner', 'lunch', 'eatery', 'bistro', 'fine dining', 'thali', 'cuisine', 'foodie', 'dine'] },
    { id: 'food',        label: 'Food joints',  emoji: '🍔', keywords: ['street food', 'food joint', 'snack', 'burger', 'pizza', 'biryani', 'momos', 'dessert', 'bakery', 'ice cream', 'shawarma', 'chaat', 'food'] },
    { id: 'cafe',        label: 'Cafés',        emoji: '☕', keywords: ['cafe', 'café', 'coffee', 'brunch', 'tea', 'roastery', 'espresso', 'bakery'] },
    { id: 'hotel',       label: 'Hotels',       emoji: '🏨', keywords: ['hotel', 'resort', 'stay', 'villa', 'homestay', 'hostel', 'airbnb', 'bnb', 'lodge', 'suite', 'room'] },
    { id: 'beach',       label: 'Beaches',      emoji: '🏖️', keywords: ['beach', 'shore', 'coast', 'bay', 'lagoon', 'sea', 'ocean', 'sunset', 'snorkel', 'surf'] },
    { id: 'bar',         label: 'Bars',         emoji: '🍸', keywords: ['bar', 'pub', 'cocktail', 'brewery', 'nightlife', 'lounge', 'rooftop', 'club', 'drinks'] },
    { id: 'activity',    label: 'Activities',   emoji: '🎟️', keywords: ['activity', 'tour', 'museum', 'park', 'adventure', 'scuba', 'diving', 'paragliding', 'rafting', 'experience', 'spa'] },
    { id: 'other',       label: 'Other',        emoji: '📌', keywords: [] }
  ];

  var STORE_KEY = 'wanderlist.saves.v1';
  var SEED_KEY = 'wanderlist.seeded.v1';

  /* ----------------------------------------------------------------- state */

  var saves = load();
  var activeCat = 'all';
  var query = '';
  var sortBy = 'new';
  var editingId = null; // null = new save

  /* -------------------------------------------------------------- elements */

  var $ = function (id) { return document.getElementById(id); };
  var listEl = $('list');
  var emptyEl = $('empty');
  var filtersEl = $('filters');
  var countEl = $('count');
  var searchEl = $('search');
  var sortEl = $('sort');
  var sheetEl = $('sheet');
  var catSelect = $('f-category');

  /* ----------------------------------------------------------------- utils */

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; }
    catch (e) { return []; }
  }
  function persist() { localStorage.setItem(STORE_KEY, JSON.stringify(saves)); }

  function cat(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i];
    return CATEGORIES[CATEGORIES.length - 1];
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  /* ------------------------------------------------------ content "reader"
   * Auto-reads shared text/URL to guess title, category, location & tags.
   * Instagram's API doesn't allow scraping post captions client-side, so for
   * a prototype we parse whatever text the share sheet hands us (caption,
   * title, URL) and make smart guesses the user can confirm.
   */

  function extractUrl(text) {
    if (!text) return '';
    var m = text.match(/https?:\/\/[^\s]+/i);
    return m ? m[0].replace(/[)\].,]+$/, '') : '';
  }

  function detectCategory(text) {
    var t = (text || '').toLowerCase();
    var best = 'other', bestScore = 0;
    for (var i = 0; i < CATEGORIES.length; i++) {
      var c = CATEGORIES[i], score = 0;
      for (var k = 0; k < c.keywords.length; k++) {
        if (t.indexOf(c.keywords[k]) !== -1) score++;
      }
      if (score > bestScore) { bestScore = score; best = c.id; }
    }
    return best;
  }

  function detectLocation(text) {
    if (!text) return '';
    // 1) explicit map pin emoji "📍 Place Name" — keep only the capitalised
    //    place words (e.g. "Canggu, Bali") and stop at the first ordinary word.
    var pin = text.match(/📍\s*([A-Z][\wÀ-ÿ'’.\-]*(?:[ ,]+[A-Z][\wÀ-ÿ'’.\-]*)*)/);
    if (pin) return pin[1].trim().replace(/[,\s]+$/, '');
    // 2) "in <Place>" / "at <Place>"
    var at = text.match(/\b(?:in|at)\s+([A-Z][A-Za-z'’\-]+(?:[ ,][A-Z][A-Za-z'’\-]+){0,3})/);
    if (at) return at[1].trim();
    return '';
  }

  function detectTitle(text, url) {
    if (text) {
      // first non-empty line that isn't just a URL/hashtags
      var lines = text.split(/\n+/);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/https?:\/\/[^\s]+/g, '').replace(/#[^\s]+/g, '').trim();
        if (line.length >= 3) return line.slice(0, 80);
      }
    }
    var d = domainOf(url);
    if (d.indexOf('instagram') !== -1) return 'Saved from Instagram';
    return d ? ('Saved from ' + d) : 'New saved place';
  }

  function extractTags(text) {
    if (!text) return [];
    var tags = [], m, re = /#([A-Za-z0-9_]{2,30})/g;
    while ((m = re.exec(text)) && tags.length < 6) {
      var tag = m[1].toLowerCase();
      if (tags.indexOf(tag) === -1) tags.push(tag);
    }
    return tags;
  }

  // Build a draft save from raw shared data.
  function parseShared(data) {
    var combined = [data.title, data.text, data.url].filter(Boolean).join('\n');
    var url = data.url || extractUrl(combined);
    return {
      url: url,
      title: detectTitle(data.title || data.text, url),
      category: detectCategory(combined),
      location: detectLocation(data.title || data.text),
      tags: extractTags(combined),
      note: ''
    };
  }

  function sourceOf(url) {
    var d = domainOf(url);
    if (d.indexOf('instagram') !== -1) return 'Instagram';
    if (d.indexOf('tiktok') !== -1) return 'TikTok';
    if (d.indexOf('youtu') !== -1) return 'YouTube';
    if (d.indexOf('maps') !== -1 || d.indexOf('goo.gl') !== -1) return 'Maps';
    return d || 'Link';
  }

  /* ------------------------------------------------------------- rendering */

  function renderFilters() {
    var counts = { all: saves.length };
    saves.forEach(function (s) { counts[s.category] = (counts[s.category] || 0) + 1; });

    var html = chipHtml('all', 'All', '✨', counts.all);
    CATEGORIES.forEach(function (c) {
      if ((counts[c.id] || 0) === 0 && c.id !== activeCat) return; // hide empty cats unless selected
      html += chipHtml(c.id, c.label, c.emoji, counts[c.id] || 0);
    });
    filtersEl.innerHTML = html;
  }

  function chipHtml(id, label, emoji, n) {
    return '<button class="chip' + (activeCat === id ? ' active' : '') + '" data-cat="' + id + '">' +
      '<span>' + emoji + '</span><span>' + escapeHtml(label) + '</span>' +
      '<span class="chip-count">' + n + '</span></button>';
  }

  function filteredSaves() {
    var q = query.trim().toLowerCase();
    var out = saves.filter(function (s) {
      if (activeCat !== 'all' && s.category !== activeCat) return false;
      if (!q) return true;
      var hay = [s.title, s.location, s.note, (s.tags || []).join(' '), cat(s.category).label].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    out.sort(function (a, b) {
      if (sortBy === 'old') return a.createdAt - b.createdAt;
      if (sortBy === 'az') return (a.title || '').localeCompare(b.title || '');
      return b.createdAt - a.createdAt;
    });
    return out;
  }

  function render() {
    renderFilters();
    var items = filteredSaves();

    countEl.textContent = items.length + (items.length === 1 ? ' save' : ' saves') +
      (activeCat !== 'all' ? ' in ' + cat(activeCat).label : '');

    if (saves.length === 0) {
      listEl.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    if (items.length === 0) {
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:30px 0">No saves match that filter.</p>';
      return;
    }

    listEl.innerHTML = items.map(cardHtml).join('');
  }

  function cardHtml(s) {
    var c = cat(s.category);
    var tags = (s.tags || []).map(function (t) { return '<span class="tag">#' + escapeHtml(t) + '</span>'; }).join('');
    var link = s.url
      ? '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">Open ↗</a>'
      : '';
    return '' +
      '<article class="card" data-id="' + s.id + '">' +
        '<div class="card-thumb">' + c.emoji + '</div>' +
        '<div class="card-body">' +
          (s.url ? '<span class="card-source">' + escapeHtml(sourceOf(s.url)) + '</span>' : '') +
          '<span class="card-cat">' + escapeHtml(c.label) + '</span>' +
          '<h3 class="card-title">' + escapeHtml(s.title) + '</h3>' +
          (s.location ? '<p class="card-loc"><span class="pin">📍</span>' + escapeHtml(s.location) + '</p>' : '') +
          (tags ? '<div class="card-tags">' + tags + '</div>' : '') +
          (s.note ? '<p class="card-note">' + escapeHtml(s.note) + '</p>' : '') +
          '<div class="card-actions">' +
            link +
            '<button class="edit" data-id="' + s.id + '">Edit</button>' +
            '<button class="del" data-id="' + s.id + '">Delete</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  /* ------------------------------------------------------------- the sheet */

  function buildCatOptions() {
    catSelect.innerHTML = CATEGORIES.map(function (c) {
      return '<option value="' + c.id + '">' + c.emoji + '  ' + c.label + '</option>';
    }).join('');
  }

  function openSheet(draft, isShared) {
    editingId = draft && draft.id ? draft.id : null;
    $('sheetTitle').textContent = editingId ? 'Edit save' : (isShared ? 'Save this place' : 'Save a place');
    $('f-url').value = (draft && draft.url) || '';
    $('f-title').value = (draft && draft.title) || '';
    $('f-category').value = (draft && draft.category) || 'other';
    $('f-location').value = (draft && draft.location) || '';
    $('f-tags').value = (draft && draft.tags) ? draft.tags.join(', ') : '';
    $('f-note').value = (draft && draft.note) || '';

    var hint = $('autohint');
    if (isShared) {
      hint.hidden = false;
      hint.innerHTML = '✨ Auto-read from your share as <b>' + escapeHtml(cat(draft.category).label) +
        '</b>. Tweak anything below, then Save.';
    } else {
      hint.hidden = true;
    }
    sheetEl.hidden = false;
    if (!editingId && !isShared) setTimeout(function () { $('f-url').focus(); }, 50);
  }

  function closeSheet() {
    sheetEl.hidden = true;
    editingId = null;
  }

  function saveFromSheet() {
    var url = $('f-url').value.trim();
    var title = $('f-title').value.trim();
    if (!title && !url) { toast('Add a title or a link first'); return; }

    var record = {
      url: url,
      title: title || detectTitle('', url),
      category: $('f-category').value,
      location: $('f-location').value.trim(),
      tags: $('f-tags').value.split(',').map(function (t) { return t.trim().replace(/^#/, ''); }).filter(Boolean),
      note: $('f-note').value.trim()
    };

    if (editingId) {
      for (var i = 0; i < saves.length; i++) {
        if (saves[i].id === editingId) { Object.assign(saves[i], record); break; }
      }
      toast('Updated ✓');
    } else {
      record.id = uid();
      record.createdAt = Date.now();
      saves.unshift(record);
      toast('Saved ✓');
    }
    persist();
    closeSheet();
    render();
  }

  /* ------------------------------------------------------ shared-link entry */

  // If launched from the OS share sheet (Web Share Target) the URL carries
  // ?title=&text=&url= — read it, auto-parse, and pop the review sheet.
  function handleShareLaunch() {
    var p = new URLSearchParams(location.search);
    if (!p.has('title') && !p.has('text') && !p.has('url')) return false;

    var draft = parseShared({
      title: p.get('title') || '',
      text: p.get('text') || '',
      url: p.get('url') || ''
    });
    var auto = p.get('autosave') === '1';

    // Clean the URL so a refresh doesn't re-trigger the sheet.
    history.replaceState({}, '', location.pathname);

    // From the iOS Shortcut we may want zero-tap saving: store it straight away
    // and just confirm with a toast instead of opening the review sheet.
    if (auto && (draft.url || draft.title)) {
      draft.id = uid();
      draft.createdAt = Date.now();
      saves.unshift(draft);
      persist();
      toast('Saved from share ✓');
      return true;
    }

    openSheet(draft, true);
    return true;
  }

  /* ---------------------------------------------------------------- events */

  filtersEl.addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    activeCat = chip.getAttribute('data-cat');
    render();
  });

  listEl.addEventListener('click', function (e) {
    var del = e.target.closest('.del');
    var edit = e.target.closest('.edit');
    if (del) {
      var id = del.getAttribute('data-id');
      saves = saves.filter(function (s) { return s.id !== id; });
      persist();
      render();
      toast('Deleted');
      return;
    }
    if (edit) {
      var eid = edit.getAttribute('data-id');
      var rec = saves.filter(function (s) { return s.id === eid; })[0];
      if (rec) openSheet(rec, false);
    }
  });

  searchEl.addEventListener('input', function () { query = searchEl.value; render(); });
  sortEl.addEventListener('change', function () { sortBy = sortEl.value; render(); });

  var helpEl = $('help');
  $('helpBtn').addEventListener('click', function () { helpEl.hidden = false; });
  $('helpCloseBtn').addEventListener('click', function () { helpEl.hidden = true; });
  helpEl.addEventListener('click', function (e) { if (e.target === helpEl) helpEl.hidden = true; });
  $('copyUrlBtn').addEventListener('click', function () {
    var text = $('shortcutUrl').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Link copied ✓'); })
        .catch(function () { toast('Copy failed — long-press to copy'); });
    } else {
      toast('Long-press the link to copy');
    }
  });

  $('addBtn').addEventListener('click', function () { openSheet(null, false); });
  $('emptyAddBtn').addEventListener('click', function () { openSheet(null, false); });
  $('emptyHelpBtn').addEventListener('click', function () { helpEl.hidden = false; });
  $('cancelBtn').addEventListener('click', closeSheet);
  $('saveBtn').addEventListener('click', saveFromSheet);
  sheetEl.addEventListener('click', function (e) { if (e.target === sheetEl) closeSheet(); });

  // Live auto-read while pasting a link/caption into the URL field.
  $('f-url').addEventListener('input', function () {
    var val = $('f-url').value;
    if (!val || (val.indexOf('http') === -1 && val.length < 8)) return;
    var draft = parseShared({ url: extractUrl(val) || val, text: val });
    if (!$('f-title').value) $('f-title').value = draft.title;
    if (!$('f-location').value && draft.location) $('f-location').value = draft.location;
    if (!$('f-tags').value && draft.tags.length) $('f-tags').value = draft.tags.join(', ');
    // only auto-set category if still on default
    if ($('f-category').value === 'other' && draft.category !== 'other') $('f-category').value = draft.category;
  });

  /* ------------------------------------------------------------ seed + boot */

  function seedDemo() {
    if (localStorage.getItem(SEED_KEY) || saves.length) return;
    var now = Date.now();
    var demo = [
      { title: 'Pinky Beach, secret cove', category: 'beach', location: 'Nusa Penida, Bali', tags: ['sunset', 'snorkel'], note: 'Go early before the crowds.', url: 'https://www.instagram.com/p/demo-beach/' },
      { title: 'La Brasa — wood-fired tacos', category: 'restaurant', location: 'Lisbon, Portugal', tags: ['tacos', 'dinner'], note: 'Book the terrace.', url: 'https://www.instagram.com/p/demo-resto/' },
      { title: 'Cloud 9 Boutique Stay', category: 'hotel', location: 'Ubud, Bali', tags: ['villa', 'jungle'], note: 'Infinity pool over the rice fields.', url: 'https://www.instagram.com/p/demo-hotel/' },
      { title: 'Tiny corner espresso bar', category: 'cafe', location: 'Hanoi, Vietnam', tags: ['coffee', 'egg coffee'], note: '', url: 'https://www.instagram.com/p/demo-cafe/' }
    ];
    demo.forEach(function (d, i) {
      d.id = uid();
      d.createdAt = now - i * 60000;
      saves.push(d);
    });
    persist();
    localStorage.setItem(SEED_KEY, '1');
  }

  buildCatOptions();
  var launchedFromShare = handleShareLaunch();
  if (!launchedFromShare) seedDemo();
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
