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
var USERS_SHEET = 'Users';
var LOGS_SHEET = 'Logs';

var FOOD_SHEET = 'Food';
var PROFILE_SHEET = 'Profiles';
var FAST_SHEET = 'Fasts';

var USER_HEADERS = ['username', 'displayName', 'passwordHash', 'salt', 'token', 'startDate', 'createdAt'];
var LOG_HEADERS = ['username', 'date', 'dayNumber', 'workout1', 'workout2', 'outdoor',
                   'waterMl', 'reading', 'photo', 'diet', 'noAlcohol', 'completed', 'notes', 'updatedAt'];
var FOOD_HEADERS = ['id', 'username', 'date', 'meal', 'name', 'grams',
                    'calories', 'protein', 'carbs', 'fat', 'createdAt'];
var PROFILE_HEADERS = ['username', 'dataJson', 'updatedAt'];
var FAST_HEADERS = ['id', 'username', 'startAt', 'endAt', 'goalHours', 'createdAt'];

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
      case 'saveGoals':  data = handleSaveGoals(body);  break;
      case 'getFood':    data = handleGetFood(body);    break;
      case 'addFood':    data = handleAddFood(body);    break;
      case 'deleteFood': data = handleDeleteFood(body); break;
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
  var startDate = body.startDate ? String(body.startDate) : todayStr();

  if (username.length < 3) throw new Error('Username must be at least 3 characters.');
  if (password.length < 4) throw new Error('Password must be at least 4 characters.');

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  if (findUserRow(sheet, username)) throw new Error('That username is already taken.');

  var salt = Utilities.getUuid();
  var token = Utilities.getUuid();
  sheet.appendRow([
    username, displayName, hashPassword(password, salt), salt, token, startDate, new Date().toISOString()
  ]);

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
    fat: Number(r[idx.fat]) || 0
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
    notes: String(day.notes || '')
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
  var newStart = body.startDate ? String(body.startDate) : todayStr();

  var sheet = getSheet(USERS_SHEET, USER_HEADERS);
  var found = findUserRow(sheet, user.username);
  var idx = colIndex(USER_HEADERS);
  sheet.getRange(found.row, idx.startDate + 1).setValue(newStart);

  return { user: publicUser(user.username, user.displayName, newStart), logs: getUserLogs(user.username) };
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
    board.push({
      displayName: u[uIdx.displayName] || name,
      currentDay: dayNumberFor(u[uIdx.startDate], today),
      completedDays: logs.filter(function (l) { return l.completed; }).length,
      streak: currentStreak(logs),
      todayDone: todayLog ? tasksDoneCount(todayLog) : 0,
      todayTotal: 8,
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
  ['workout1', 'workout2', 'outdoor', 'reading', 'photo', 'diet', 'noAlcohol'].forEach(function (k) {
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
    startDate: String(startDate),
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
    notes: String(r[idx.notes] || '')
  };
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
  return d.workout1 && d.workout2 && d.outdoor && d.reading &&
         d.photo && d.diet && d.noAlcohol && (Number(d.waterMl) >= WATER_GOAL_ML);
}

function currentStreak(logs) {
  var streak = 0;
  for (var i = logs.length - 1; i >= 0; i--) {
    if (logs[i].completed) streak++;
    else break;
  }
  return streak;
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
}
