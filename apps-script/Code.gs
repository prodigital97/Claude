/**
 * 75 Hard Dashboard — Google Apps Script backend
 * ------------------------------------------------
 * Stores all data in a Google Sheet and exposes a small JSON API that the
 * mobile web app talks to.
 *
 * SHEETS (auto-created on first run):
 *   Users : username | displayName | passwordHash | salt | token | startDate | createdAt
 *   Logs  : username | date | dayNumber | workout1 | workout2 | outdoor |
 *           waterMl | reading | photo | diet | noAlcohol | completed | notes | updatedAt
 *
 * Deploy:  Deploy > New deployment > Web app
 *          Execute as: Me   |   Who has access: Anyone
 *          Copy the /exec URL into js/config.js (API_URL).
 */

var WATER_GOAL_ML = 4000;         // 4 L (comfortably meets the 1-gallon rule)
var CHALLENGE_LENGTH = 75;        // days
var GEMINI_MODEL = 'gemini-2.5-flash';   // cheap vision model for label scanning
var USERS_SHEET = 'Users';
var LOGS_SHEET = 'Logs';

var FOOD_SHEET = 'Food';
var PROFILE_SHEET = 'Profiles';
var FAST_SHEET = 'Fasts';
var CUSTOM_SHEET = 'CustomFoods';

var USER_HEADERS = ['username', 'displayName', 'passwordHash', 'salt', 'token', 'startDate', 'createdAt'];
var LOG_HEADERS = ['username', 'date', 'dayNumber', 'workout1', 'workout2', 'outdoor',
                   'waterMl', 'reading', 'photo', 'diet', 'noAlcohol', 'completed', 'notes', 'updatedAt', 'extra', 'mood'];
// 'sugar' appended at the end so older Food rows keep their column positions.
var FOOD_HEADERS = ['id', 'username', 'date', 'meal', 'name', 'grams',
                    'calories', 'protein', 'carbs', 'fat', 'createdAt', 'sugar'];
var PROFILE_HEADERS = ['username', 'dataJson', 'updatedAt'];
var FAST_HEADERS = ['id', 'username', 'startAt', 'endAt', 'goalHours', 'createdAt'];
var CUSTOM_HEADERS = ['id', 'name', 'kcal', 'protein', 'carbs', 'fat', 'sugar', 'createdBy', 'createdAt',
                      'satFat', 'transFat', 'fiber', 'addedSugar', 'sodium', 'cholesterol', 'calcium', 'iron', 'servingSize', 'dataJson'];

/* ----------------------------------------------------------------------- *
 *  HTTP entry points
 * ----------------------------------------------------------------------- */

function doGet(e) {
  // Health check / lets you confirm the deployment works in a browser.
  return jsonOutput({ ok: true, service: '75hard', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var action = body.action || '';
    var data;

    switch (action) {
      case 'register':   data = handleRegister(body);  break;
      case 'login':      data = handleLogin(body);     break;
      case 'getState':   data = handleGetState(body);  break;
      case 'saveDay':    data = handleSaveDay(body);   break;
      case 'reset':      data = handleReset(body);     break;
      case 'leaderboard':data = handleLeaderboard(body); break;
      case 'updateProfile': data = handleUpdateProfile(body); break;
      case 'deleteAccount': data = handleDeleteAccount(body); break;
      case 'saveGoals':  data = handleSaveGoals(body);  break;
      case 'getFood':    data = handleGetFood(body);    break;
      case 'addFood':    data = handleAddFood(body);    break;
      case 'deleteFood': data = handleDeleteFood(body); break;
      case 'foodSummary':data = handleFoodSummary(body); break;
      case 'getCustomFoods': data = handleGetCustomFoods(body); break;
      case 'addCustomFood':  data = handleAddCustomFood(body);  break;
      case 'foodSearch':     data = handleFoodSearch(body);     break;
      case 'scanLabel':      data = handleScanLabel(body);      break;
      case 'startFast':  data = handleStartFast(body);  break;
      case 'endFast':    data = handleEndFast(body);    break;
      case 'getFasts':   data = handleGetFasts(body);   break;
      case 'updateFast': data = handleUpdateFast(body); break;
      case 'deleteFast': data = handleDeleteFast(body); break;
      default:
        return jsonOutput({ ok: false, error: 'Unknown action: ' + action });
    }
    return jsonOutput({ ok: true, data: data });
  } catch (err) {
    return jsonOutput({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/* ----------------------------------------------------------------------- *
 *  Actions
 * ----------------------------------------------------------------------- */

function handleRegister(body) {
  var username = normalizeUsername(body.username);
  var password = String(body.password || '');
  var displayName = String(body.displayName || username).trim() || username;
  var startDate = normIso(body.startDate) || todayStr();

  if (username.length < 3) throw new Error('Username must be at least 3 characters.');
  if (password.length < 4) throw new Error('Password must be at least 4 characters.');

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  if (findUserRow(sheet, username)) throw new Error('That username is already taken.');

  var salt = Utilities.getUuid();
  var token = Utilities.getUuid();
  var idx = colIndex(USER_HEADERS);
  sheet.appendRow([
    username, displayName, hashPassword(password, salt), salt, token, startDate, new Date().toISOString()
  ]);
  // Force the start-date cell to plain text so Sheets can never re-interpret it.
  setStartDateCell(sheet, sheet.getLastRow(), idx.startDate + 1, startDate);

  return { token: token, user: publicUser(username, displayName, startDate) };
}

function handleLogin(body) {
  var username = normalizeUsername(body.username);
  var password = String(body.password || '');

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, username);
  if (!found) throw new Error('Invalid username or password.');

  var row = found.values;
  var idx = colIndex(USER_HEADERS);
  if (hashPassword(password, row[idx.salt]) !== row[idx.passwordHash]) {
    throw new Error('Invalid username or password.');
  }

  // Rotate a fresh token on every login.
  var token = Utilities.getUuid();
  sheet.getRange(found.row, idx.token + 1).setValue(token);

  return {
    token: token,
    user: publicUser(username, row[idx.displayName], row[idx.startDate])
  };
}

function handleGetState(body) {
  var user = authUser(body);
  return {
    user: publicUser(user.username, user.displayName, user.startDate),
    logs: getUserLogs(user.username),
    profile: getProfile(user.username),
    activeFast: getActiveFast(user.username)
  };
}

/* ---------------- Intermittent fasting ---------------- */

function getActiveFast(username) {
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = values.length - 1; i >= 1; i--) {
    if (normalizeUsername(values[i][idx.username]) === username && !values[i][idx.endAt]) {
      return fastFromRow(values[i], idx);
    }
  }
  return null;
}

function handleStartFast(body) {
  var user = authUser(body);
  var existing = getActiveFast(user.username);
  if (existing) return { fast: existing };

  var record = {
    id: Utilities.getUuid(),
    username: user.username,
    startAt: body.startAt ? String(body.startAt) : new Date().toISOString(),
    endAt: '',
    goalHours: 0,  // unused — milestone is derived from actual duration
    createdAt: new Date().toISOString()
  };
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  sheet.appendRow(FAST_HEADERS.map(function (h) { return record[h]; }));
  return { fast: record };
}

function handleEndFast(body) {
  var user = authUser(body);
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = values.length - 1; i >= 1; i--) {
    if (normalizeUsername(values[i][idx.username]) === user.username && !values[i][idx.endAt]) {
      var endAt = new Date().toISOString();
      sheet.getRange(i + 1, idx.endAt + 1).setValue(endAt);
      values[i][idx.endAt] = endAt;
      return { fast: fastFromRow(values[i], idx) };
    }
  }
  return { fast: null };
}

function handleGetFasts(body) {
  var user = authUser(body);
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  var active = null, done = [];
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) !== user.username) continue;
    var f = fastFromRow(values[i], idx);
    if (!f.endAt) active = f; else done.push(f);
  }
  done.sort(function (a, b) { return a.startAt < b.startAt ? 1 : -1; });
  return { active: active, fasts: done.slice(0, 30) };
}

function handleUpdateFast(body) {
  var user = authUser(body);
  var id = String(body.id || '');
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      if (body.startAt) {
        sheet.getRange(i + 1, idx.startAt + 1).setValue(String(body.startAt));
        values[i][idx.startAt] = String(body.startAt);
      }
      if (body.endAt != null) {
        sheet.getRange(i + 1, idx.endAt + 1).setValue(String(body.endAt));
        values[i][idx.endAt] = String(body.endAt);
      }
      return { fast: fastFromRow(values[i], idx) };
    }
  }
  throw new Error('Fast not found.');
}

function handleDeleteFast(body) {
  var user = authUser(body);
  var id = String(body.id || '');
  var sheet = getSheet(FAST_SHEET, FAST_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FAST_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.id]) === id && normalizeUsername(values[i][idx.username]) === user.username) {
      sheet.deleteRow(i + 1);
      return { deleted: id };
    }
  }
  return { deleted: null };
}

function fastFromRow(r, idx) {
  return {
    id: String(r[idx.id]),
    startAt: String(r[idx.startAt]),
    endAt: r[idx.endAt] ? String(r[idx.endAt]) : ''
  };
}

/* ---------------- Diet: goals + food log ---------------- */

function getProfile(username) {
  var sheet = getSheet(PROFILE_SHEET, PROFILE_HEADERS);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][0]) === username) {
      try { return JSON.parse(values[i][1] || '{}'); } catch (e) { return {}; }
    }
  }
  return {};
}

function handleSaveGoals(body) {
  var user = authUser(body);
  var profile = body.profile || {};
  var sheet = getSheet(PROFILE_SHEET, PROFILE_HEADERS);
  var values = sheet.getDataRange().getValues();
  var json = JSON.stringify(profile);
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][0]) === user.username) {
      sheet.getRange(i + 1, 1, 1, 3).setValues([[user.username, json, new Date().toISOString()]]);
      return { profile: profile };
    }
  }
  sheet.appendRow([user.username, json, new Date().toISOString()]);
  return { profile: profile };
}

function handleGetFood(body) {
  var user = authUser(body);
  var date = String(body.date || todayStr());
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FOOD_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== user.username) continue;
    if (formatDate(r[idx.date]) !== date) continue;
    out.push(foodFromRow(r, idx));
  }
  return { foods: out };
}

function handleAddFood(body) {
  var user = authUser(body);
  var f = body.food || {};
  var record = {
    id: Utilities.getUuid(),
    username: user.username,
    date: String(f.date || todayStr()),
    meal: String(f.meal || 'Other'),
    name: String(f.name || 'Food').slice(0, 120),
    grams: round1(f.grams),
    calories: Math.round(Number(f.calories) || 0),
    protein: round1(f.protein),
    carbs: round1(f.carbs),
    fat: round1(f.fat),
    sugar: round1(f.sugar),
    createdAt: new Date().toISOString()
  };
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  sheet.appendRow(FOOD_HEADERS.map(function (h) { return record[h]; }));
  return { food: record };
}

function handleDeleteFood(body) {
  var user = authUser(body);
  var id = String(body.id || '');
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === id && normalizeUsername(values[i][1]) === user.username) {
      sheet.deleteRow(i + 1);
      return { deleted: id };
    }
  }
  return { deleted: null };
}

/* ---------------- Shared custom foods (visible to all users) ---------------- */

function handleGetCustomFoods(body) {
  authUser(body);
  var sheet = getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CUSTOM_HEADERS);
  var out = [], seen = {};
  for (var i = 1; i < values.length; i++) {
    if (!values[i][idx.name]) continue;
    var key = String(values[i][idx.name]).trim().toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    out.push(customFromRow(values[i], idx));
  }
  return { foods: out };
}

function handleAddCustomFood(body) {
  var user = authUser(body);
  var f = body.food || {};
  var name = String(f.name || '').trim();
  if (!name) throw new Error('Food name required.');

  var rec = {
    id: Utilities.getUuid(), name: name,
    kcal: Math.round(Number(f.kcal) || 0),
    protein: round1(f.p), carbs: round1(f.c), fat: round1(f.f), sugar: round1(f.s),
    createdBy: user.username, createdAt: new Date().toISOString(),
    satFat: round1(f.satFat), transFat: round1(f.transFat), fiber: round1(f.fiber),
    addedSugar: round1(f.addedSugar), sodium: round1(f.sodium), cholesterol: round1(f.cholesterol),
    calcium: round1(f.calcium), iron: round1(f.iron), servingSize: String(f.servingSize || ''),
    dataJson: f.data ? JSON.stringify(f.data) : ''
  };

  var sheet = getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(CUSTOM_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.name]).trim().toLowerCase() === name.toLowerCase()) {
      // Already shared — enrich it with full-panel data if this came from a scan.
      if (rec.dataJson) {
        ['satFat', 'transFat', 'fiber', 'addedSugar', 'sodium', 'cholesterol', 'calcium', 'iron', 'servingSize', 'dataJson'].forEach(function (col) {
          sheet.getRange(i + 1, idx[col] + 1).setValue(rec[col]);
        });
      }
      return { food: customFromRow(values[i], idx) };
    }
  }
  sheet.appendRow(CUSTOM_HEADERS.map(function (h) { return rec[h]; }));
  return { food: rec };
}

function customFromRow(r, idx) {
  return {
    id: String(r[idx.id]), name: String(r[idx.name]),
    kcal: Number(r[idx.kcal]) || 0, protein: Number(r[idx.protein]) || 0,
    carbs: Number(r[idx.carbs]) || 0, fat: Number(r[idx.fat]) || 0, sugar: Number(r[idx.sugar]) || 0
  };
}

/* ---------------- FatSecret proxy (optional) ---------------- *
 * Set FATSECRET_CLIENT_ID and FATSECRET_CLIENT_SECRET in
 * Project Settings -> Script properties. If not set, this is skipped and the
 * app falls back to Open Food Facts.
 * ------------------------------------------------------------ */

function fatsecretToken() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FATSECRET_CLIENT_ID');
  var secret = props.getProperty('FATSECRET_CLIENT_SECRET');
  if (!id || !secret) return null;

  var cache = CacheService.getScriptCache();
  var cached = cache.get('fs_token');
  if (cached) return cached;

  var resp = UrlFetchApp.fetch('https://oauth.fatsecret.com/connect/token', {
    method: 'post',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) },
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=client_credentials&scope=basic',
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText() || '{}');
  if (!data.access_token) throw new Error('FatSecret auth failed: ' + resp.getContentText());
  cache.put('fs_token', data.access_token, Math.max(60, (Number(data.expires_in) || 86400) - 120));
  return data.access_token;
}

function handleFoodSearch(body) {
  authUser(body);
  return fatsecretSearch(String(body.q || '').trim());
}

function fatsecretSearch(q) {
  if (!q) return { foods: [], source: 'none' };

  var token;
  try { token = fatsecretToken(); } catch (e) { return { foods: [], source: 'error', error: String(e.message || e) }; }
  if (!token) return { foods: [], source: 'unconfigured' };

  var url = 'https://platform.fatsecret.com/rest/server.api?method=foods.search&format=json&max_results=30&search_expression=' + encodeURIComponent(q);
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
  var data = JSON.parse(resp.getContentText() || '{}');
  if (data.error) return { foods: [], source: 'error', error: data.error.message };

  var list = data.foods && data.foods.food ? data.foods.food : [];
  if (!Array.isArray(list)) list = [list];

  var out = [];
  list.forEach(function (f) {
    var parsed = parseFsDesc(String(f.food_description || ''));
    if (!parsed) return;
    out.push({
      name: String(f.food_name) + (f.brand_name ? ' · ' + f.brand_name : ''),
      kcal: parsed.kcal, p: parsed.p, c: parsed.c, f: parsed.f, s: 0,
      serving: 100
    });
  });
  return { foods: out, source: 'fatsecret' };
}

/* Parse "Per 100g - Calories: 717kcal | Fat: 81.00g | Carbs: 0.10g | Protein: 0.85g"
 * (or "Per 1 serving (30g) - ...") into per-100g values. */
function parseFsDesc(desc) {
  var cal = desc.match(/Calories:\s*([\d.]+)\s*kcal/i);
  if (!cal) return null;
  var kcal = Number(cal[1]);
  var fat = fsNum(desc, /Fat:\s*([\d.]+)\s*g/i);
  var carbs = fsNum(desc, /Carbs:\s*([\d.]+)\s*g/i);
  var protein = fsNum(desc, /Protein:\s*([\d.]+)\s*g/i);

  var grams = null;
  var g = desc.match(/Per\s+([\d.]+)\s*g\b/i) || desc.match(/\(([\d.]+)\s*g\)/i);
  if (g) grams = Number(g[1]);

  if (grams && grams > 0) {
    var k = 100 / grams;
    return { kcal: Math.round(kcal * k), p: round1(protein * k), c: round1(carbs * k), f: round1(fat * k) };
  }
  // Unknown gram weight (e.g. "Per 1 cup") — present the listed values as-is.
  return { kcal: Math.round(kcal), p: round1(protein), c: round1(carbs), f: round1(fat) };
}
function fsNum(s, re) { var m = s.match(re); return m ? Number(m[1]) : 0; }

/* ---------------- Gemini AI label scanner ---------------- *
 * Set GEMINI_API_KEY in Project Settings -> Script properties.
 * Get a free key at https://aistudio.google.com  (no IP whitelist needed).
 * ------------------------------------------------------------ */
function handleScanLabel(body) {
  authUser(body);
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('AI scanner not set up (missing GEMINI_API_KEY).');
  var img = String(body.image || '');
  if (!img) throw new Error('No image received.');
  var mime = String(body.mime || 'image/jpeg');

  var prompt = 'Read this packaged-food nutrition label. Return ONLY JSON with ALL nutrients you can see, ' +
    'each value PER 100 g (or per 100 ml). If the label shows values per serving, convert to per 100 using the ' +
    'serving size. Use 0 for any nutrient not shown. Numbers only, no units. Schema: ' +
    '{"name":string,"servingSize":string,"calories":number,"protein":number,"carbs":number,"fat":number,' +
    '"sugar":number,"addedSugar":number,"saturatedFat":number,"transFat":number,"fiber":number,' +
    '"sodium":number,"cholesterol":number,"calcium":number,"iron":number}.';

  var payload = {
    contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: mime, data: img } } ] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };

  // Try the configured model, then fall back if Google has retired it.
  var models = dedupe([GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest']);
  var txt = null, lastErr = '';
  for (var i = 0; i < models.length; i++) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + encodeURIComponent(key);
    var resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
    var data = JSON.parse(resp.getContentText() || '{}');
    if (data.error) {
      lastErr = data.error.message || 'request failed';
      if (/not found|not available|not supported|unsupported|retired|deprecated/i.test(lastErr)) continue;
      throw new Error('Gemini: ' + lastErr);
    }
    try { txt = data.candidates[0].content.parts[0].text; break; } catch (e) { lastErr = 'No response from the AI.'; }
  }
  if (txt == null) throw new Error('Gemini: ' + lastErr);

  var p;
  try { p = JSON.parse(txt); }
  catch (e) { var m = txt.match(/\{[\s\S]*\}/); p = m ? JSON.parse(m[0]) : {}; }
  function n(x) { return Number(x) || 0; }
  return {
    name: String(p.name || ''), servingSize: String(p.servingSize || ''),
    calories: n(p.calories), protein: n(p.protein), carbs: n(p.carbs), fat: n(p.fat), sugar: n(p.sugar),
    addedSugar: n(p.addedSugar), saturatedFat: n(p.saturatedFat), transFat: n(p.transFat),
    fiber: n(p.fiber), sodium: n(p.sodium), cholesterol: n(p.cholesterol), calcium: n(p.calcium), iron: n(p.iron)
  };
}
function dedupe(arr) { var s = {}, o = []; arr.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }

/* Run this from the editor after setting the script properties to verify the key. */
function testFatSecret() {
  var token = fatsecretToken();
  Logger.log(token ? 'Token OK' : 'No credentials set in Script properties');
  if (token) Logger.log(JSON.stringify(fatsecretSearch('amul butter')));
}

/* Run this a bunch of times (over a day) to discover the outbound IPs Apps
 * Script uses, then add each unique one to FatSecret's IP whitelist slots. */
function myOutboundIp() {
  var resp = UrlFetchApp.fetch('https://api.ipify.org', { muteHttpExceptions: true });
  Logger.log('Outbound IP: ' + resp.getContentText());
  return resp.getContentText();
}

function handleFoodSummary(body) {
  var user = authUser(body);
  var sheet = getSheet(FOOD_SHEET, FOOD_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(FOOD_HEADERS);
  var total = 0, days = {};
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) !== user.username) continue;
    total += Number(values[i][idx.calories]) || 0;
    days[formatDate(values[i][idx.date])] = true;
  }
  var n = Object.keys(days).length;
  return { totalCalories: Math.round(total), daysLogged: n, avgCalories: n ? Math.round(total / n) : 0 };
}

function foodFromRow(r, idx) {
  return {
    id: String(r[idx.id]),
    date: formatDate(r[idx.date]),
    meal: String(r[idx.meal]),
    name: String(r[idx.name]),
    grams: Number(r[idx.grams]) || 0,
    calories: Number(r[idx.calories]) || 0,
    protein: Number(r[idx.protein]) || 0,
    carbs: Number(r[idx.carbs]) || 0,
    fat: Number(r[idx.fat]) || 0,
    sugar: Number(r[idx.sugar]) || 0
  };
}

function round1(v) { var n = Number(v) || 0; return Math.round(n * 10) / 10; }

function handleSaveDay(body) {
  var user = authUser(body);
  var day = body.day || {};
  var date = String(day.date || todayStr());

  var sheet = getSheet(LOGS_SHEET, LOG_HEADERS);
  var idx = colIndex(LOG_HEADERS);

  var record = {
    username: user.username,
    date: date,
    dayNumber: Number(day.dayNumber) || dayNumberFor(user.startDate, date),
    workout1: !!day.workout1,
    workout2: !!day.workout2,
    outdoor: !!day.outdoor,
    waterMl: Number(day.waterMl) || 0,
    reading: !!day.reading,
    photo: !!day.photo,
    diet: !!day.diet,
    noAlcohol: !!day.noAlcohol,
    notes: String(day.notes || ''),
    extra: JSON.stringify(day.extra || {}),
    mood: Number(day.mood) || 0
  };
  record.completed = isDayComplete(record);
  record.updatedAt = new Date().toISOString();

  var rowValues = LOG_HEADERS.map(function (h) { return record[h]; });

  var existing = findLogRow(sheet, user.username, date);
  if (existing) {
    sheet.getRange(existing.row, 1, 1, LOG_HEADERS.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
  }
  return { day: record };
}

function handleReset(body) {
  var user = authUser(body);
  var newStart = normIso(body.startDate) || todayStr();

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, user.username);
  var idx = colIndex(USER_HEADERS);
  setStartDateCell(sheet, found.row, idx.startDate + 1, newStart);

  return { user: publicUser(user.username, user.displayName, newStart), logs: getUserLogs(user.username) };
}

/* Writes a start date as PLAIN TEXT so Google Sheets never converts it to a
 * date serial (which is what was corrupting years to ~2000). */
function setStartDateCell(sheet, row, col, isoDate) {
  sheet.getRange(row, col).setNumberFormat('@').setValue(String(isoDate));
}

/* Returns a clean yyyy-MM-dd string for a plausible date, else null. */
function normIso(s) {
  if (s == null || s === '') return null;
  var str = formatDate(s);                 // handles Date objects + slices strings
  var p = str.split('-');
  if (p.length === 3 && p[0].length === 4) {
    var y = Number(p[0]);
    if (y >= 2024 && y <= 2100) return p[0] + '-' + pad2(p[1]) + '-' + pad2(p[2]);
  }
  var d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 2024) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return null;
}
function pad2(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

/* ----------------------------------------------------------------------- *
 *  MAINTENANCE — run once from the Apps Script editor to repair accounts.
 *  Edit the date below, pick this function in the toolbar, click Run.
 *  It rewrites EVERY user's start date (as text) so corrupted year-2000
 *  dates are fixed in one shot.
 * ----------------------------------------------------------------------- */
function setAllStartDates() {
  var ISO_DATE = '2026-06-16';   // <-- change to your real Day 1, then Run
  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var idx = colIndex(USER_HEADERS);
  var last = sheet.getLastRow();
  for (var r = 2; r <= last; r++) {
    setStartDateCell(sheet, r, idx.startDate + 1, ISO_DATE);
  }
}

/* ONE-SHOT REPAIR for the year-2000 bug.
 * For every user whose start date is corrupt (year < 2024), this sets the
 * start date to NEW_START (as text) AND shifts that user's broken (year<2024)
 * day-logs onto the matching new dates, so completed days are preserved.
 * Edit NEW_START to your real Day 1, then Run this once. */
function healStartAndLogs() {
  var NEW_START = '2026-06-16';   // <-- your real Day 1

  var usersSheet = getSheet(USERS_SHEET, USER_HEADERS);
  var uidx = colIndex(USER_HEADERS);
  var users = usersSheet.getDataRange().getValues();

  var logsSheet = getSheet(LOGS_SHEET, LOG_HEADERS);
  var lidx = colIndex(LOG_HEADERS);
  var logVals = logsSheet.getDataRange().getValues();

  for (var u = 1; u < users.length; u++) {
    var name = normalizeUsername(users[u][uidx.username]);
    if (!name) continue;
    var oldStart = formatDate(users[u][uidx.startDate]);
    if (Number(oldStart.split('-')[0]) >= 2024) continue;   // already fine
    var offset = daysBetweenIso(oldStart, NEW_START);

    for (var r = 1; r < logVals.length; r++) {
      if (normalizeUsername(logVals[r][lidx.username]) !== name) continue;
      var d = formatDate(logVals[r][lidx.date]);
      if (Number(d.split('-')[0]) >= 2024) continue;        // only shift broken logs
      var nd = addDaysIso(d, offset);
      logsSheet.getRange(r + 1, lidx.date + 1).setNumberFormat('@').setValue(nd);
      logVals[r][lidx.date] = nd;
    }
    setStartDateCell(usersSheet, u + 1, uidx.startDate + 1, NEW_START);
  }
}

function daysBetweenIso(aIso, bIso) {
  return Math.round((parseDate(bIso) - parseDate(aIso)) / 86400000);
}
function addDaysIso(iso, n) {
  var d = parseDate(iso); d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}



function handleUpdateProfile(body) {
  var user = authUser(body);
  var displayName = String(body.displayName || user.displayName).trim() || user.displayName;

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, user.username);
  var idx = colIndex(USER_HEADERS);
  sheet.getRange(found.row, idx.displayName + 1).setValue(displayName);

  return { user: publicUser(user.username, displayName, user.startDate) };
}

function handleDeleteAccount(body) {
  var user = authUser(body);
  var usersSheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(usersSheet, user.username);
  if (!found) throw new Error('Account not found.');

  // Require the correct password before destroying anything.
  var uidx = colIndex(USER_HEADERS);
  if (hashPassword(String(body.password || ''), found.values[uidx.salt]) !== found.values[uidx.passwordHash]) {
    throw new Error('Password is incorrect.');
  }

  deleteRowsFor(getSheet(LOGS_SHEET, LOG_HEADERS), colIndex(LOG_HEADERS).username, user.username);
  deleteRowsFor(getSheet(FOOD_SHEET, FOOD_HEADERS), colIndex(FOOD_HEADERS).username, user.username);
  deleteRowsFor(getSheet(FAST_SHEET, FAST_HEADERS), colIndex(FAST_HEADERS).username, user.username);
  deleteRowsFor(getSheet(PROFILE_SHEET, PROFILE_HEADERS), 0, user.username);

  // Re-find the user row (indexes are stable here) and remove it last.
  usersSheet.deleteRow(found.row);
  return { deleted: true };
}

function deleteRowsFor(sheet, usernameCol, username) {
  var values = sheet.getDataRange().getValues();
  for (var i = values.length - 1; i >= 1; i--) {
    if (normalizeUsername(values[i][usernameCol]) === username) sheet.deleteRow(i + 1);
  }
}

function handleLeaderboard(body) {
  authUser(body); // any logged-in user may view the friends feed
  var today = todayStr();

  var users = getSheet(USERS_SHEET, USER_HEADERS).getDataRange().getValues();
  var uIdx = colIndex(USER_HEADERS);

  // Read each sheet once and bucket by username (avoids per-user full scans).
  var logRows = getSheet(LOGS_SHEET, LOG_HEADERS).getDataRange().getValues();
  var lIdx = colIndex(LOG_HEADERS);
  var logsByUser = {};
  for (var a = 1; a < logRows.length; a++) {
    var un = normalizeUsername(logRows[a][lIdx.username]);
    if (!un) continue;
    (logsByUser[un] = logsByUser[un] || []).push(logFromRow(logRows[a], lIdx));
  }

  var foodRows = getSheet(FOOD_SHEET, FOOD_HEADERS).getDataRange().getValues();
  var fIdx = colIndex(FOOD_HEADERS);
  var calToday = {};
  for (var b = 1; b < foodRows.length; b++) {
    if (formatDate(foodRows[b][fIdx.date]) !== today) continue;
    var fu = normalizeUsername(foodRows[b][fIdx.username]);
    calToday[fu] = (calToday[fu] || 0) + (Number(foodRows[b][fIdx.calories]) || 0);
  }

  var profRows = getSheet(PROFILE_SHEET, PROFILE_HEADERS).getDataRange().getValues();
  var goalByUser = {};
  for (var c = 1; c < profRows.length; c++) {
    var pu = normalizeUsername(profRows[c][0]);
    try { goalByUser[pu] = (JSON.parse(profRows[c][1] || '{}').calorieGoal) || 0; } catch (e) { goalByUser[pu] = 0; }
  }

  var board = [];
  for (var i = 1; i < users.length; i++) {
    var u = users[i];
    var name = normalizeUsername(u[uIdx.username]);
    if (!name) continue;
    var logs = (logsByUser[name] || []).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    var todayLog = logs.filter(function (l) { return l.date === today; })[0];
    // Count distinct complete days within the challenge window (ignores stray/duplicate rows).
    var startDay = formatDate(u[uIdx.startDate]);
    var doneDates = {};
    logs.forEach(function (l) {
      if (l.completed && l.date >= startDay && l.date <= today) doneDates[l.date] = true;
    });
    board.push({
      displayName: u[uIdx.displayName] || name,
      currentDay: dayNumberFor(u[uIdx.startDate], today),
      completedDays: Object.keys(doneDates).length,
      streak: currentStreak(logs),
      todayDone: todayLog ? tasksDoneCount(todayLog) : 0,
      todayTotal: 7,
      todayComplete: todayLog ? !!todayLog.completed : false,
      todayWaterMl: todayLog ? (Number(todayLog.waterMl) || 0) : 0,
      todayCalories: Math.round(calToday[name] || 0),
      calorieGoal: goalByUser[name] || 0
    });
  }
  board.sort(function (a, b) { return b.completedDays - a.completedDays || b.todayDone - a.todayDone; });
  return { leaderboard: board };
}

function tasksDoneCount(l) {
  var c = 0;
  ['workout1', 'outdoor', 'reading', 'photo', 'diet', 'noAlcohol'].forEach(function (k) {
    if (l[k]) c++;
  });
  if (Number(l.waterMl) >= WATER_GOAL_ML) c++;
  return c;
}

/* ----------------------------------------------------------------------- *
 *  Helpers — auth & users
 * ----------------------------------------------------------------------- */

function authUser(body) {
  var username = normalizeUsername(body.username);
  var token = String(body.token || '');
  if (!username || !token) throw new Error('Not authenticated. Please log in again.');

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, username);
  var idx = colIndex(USER_HEADERS);
  if (!found || found.values[idx.token] !== token) {
    throw new Error('Session expired. Please log in again.');
  }
  return {
    username: username,
    displayName: found.values[idx.displayName],
    startDate: String(found.values[idx.startDate])
  };
}

function publicUser(username, displayName, startDate) {
  return {
    username: username,
    displayName: displayName,
    startDate: formatDate(startDate),
    currentDay: dayNumberFor(startDate, todayStr()),
    challengeLength: CHALLENGE_LENGTH,
    waterGoalMl: WATER_GOAL_ML
  };
}

function findUserRow(sheet, username) {
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(USER_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) === username) {
      return { row: i + 1, values: values[i] };
    }
  }
  return null;
}

function hashPassword(password, salt) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + '::' + salt, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/* ----------------------------------------------------------------------- *
 *  Helpers — logs
 * ----------------------------------------------------------------------- */

function getUserLogs(username) {
  var sheet = getSheet(LOGS_SHEET, LOG_HEADERS);
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(LOG_HEADERS);
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (normalizeUsername(r[idx.username]) !== username) continue;
    out.push(logFromRow(r, idx));
  }
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return out;
}

function logFromRow(r, idx) {
  return {
    date: formatDate(r[idx.date]),
    dayNumber: Number(r[idx.dayNumber]) || 0,
    workout1: toBool(r[idx.workout1]),
    workout2: toBool(r[idx.workout2]),
    outdoor: toBool(r[idx.outdoor]),
    waterMl: Number(r[idx.waterMl]) || 0,
    reading: toBool(r[idx.reading]),
    photo: toBool(r[idx.photo]),
    diet: toBool(r[idx.diet]),
    noAlcohol: toBool(r[idx.noAlcohol]),
    completed: toBool(r[idx.completed]),
    notes: String(r[idx.notes] || ''),
    extra: parseJsonObj(r[idx.extra]),
    mood: Number(r[idx.mood]) || 0
  };
}
function parseJsonObj(v) {
  try { return JSON.parse(v || '{}'); } catch (e) { return {}; }
}

function findLogRow(sheet, username, date) {
  var values = sheet.getDataRange().getValues();
  var idx = colIndex(LOG_HEADERS);
  for (var i = 1; i < values.length; i++) {
    if (normalizeUsername(values[i][idx.username]) === username &&
        formatDate(values[i][idx.date]) === date) {
      return { row: i + 1, values: values[i] };
    }
  }
  return null;
}

function isDayComplete(d) {
  return d.workout1 && d.outdoor && d.reading &&
         d.photo && d.diet && d.noAlcohol && (Number(d.waterMl) >= WATER_GOAL_ML);
}

function currentStreak(logs) {
  // Consecutive complete days ending today (or yesterday if today's in progress).
  var set = {};
  logs.forEach(function (l) { if (l.completed) set[l.date] = true; });
  var d = parseDate(todayStr());
  if (!set[formatDate(d)]) d.setDate(d.getDate() - 1);
  var s = 0;
  while (set[formatDate(d)]) { s++; d.setDate(d.getDate() - 1); }
  return s;
}

/* ----------------------------------------------------------------------- *
 *  Helpers — sheets & utilities
 * ----------------------------------------------------------------------- */

function getSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function colIndex(headers) {
  var map = {};
  headers.forEach(function (h, i) { map[h] = i; });
  return map;
}

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function todayStr() {
  return formatDate(new Date());
}

function formatDate(d) {
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  // Already a yyyy-MM-dd string (or similar) — keep the date portion only.
  return String(d).slice(0, 10);
}

function dayNumberFor(startDate, date) {
  var start = parseDate(startDate);
  var d = parseDate(date);
  if (!start || !d) return 1;
  var diff = Math.floor((d - start) / 86400000) + 1;
  if (diff < 1) return 0;            // challenge hasn't started yet
  return diff;
}

function parseDate(s) {
  var str = formatDate(s);
  var parts = str.split('-');
  if (parts.length !== 3) return null;
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Run once manually to pre-create the sheets/headers (optional). */
function setup() {
  getSheet(USERS_SHEET, USER_HEADERS);
  getSheet(LOGS_SHEET, LOG_HEADERS);
  getSheet(FOOD_SHEET, FOOD_HEADERS);
  getSheet(PROFILE_SHEET, PROFILE_HEADERS);
  getSheet(FAST_SHEET, FAST_HEADERS);
  getSheet(CUSTOM_SHEET, CUSTOM_HEADERS);
}
