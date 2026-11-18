/**
 * Запись на стирку — бэкенд на Google Apps Script.
 * Привязан к Google-таблице (Расширения → Apps Script), данные лежат в листе «Записи».
 */

const MACHINES = 6;
const SLOTS = ['10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00', '18:00-20:00', '20:00-22:00', '22:00-00:00'];
const PRICE = 50;
const TZ = 'Europe/Moscow';
const SHEET = 'Записи';
const RECEIPTS_FOLDER = 'Стирка — квитанции';
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

// Новые колонки добавляем только в конец: в таблице уже есть живые записи
const HEADERS = ['ID', 'Создано', 'Дата', 'Время', 'Машинка', 'Фамилия и имя', 'Комната', 'Оплата, ₽', 'Квитанция', 'Статус', 'Устройство', 'Пачка', 'Контакт'];
const COL = { id: 0, created: 1, date: 2, slot: 3, machine: 4, name: 5, room: 6, paid: 7, receipt: 8, status: 9, device: 10, batch: 11, contact: 12 };
const MAX_CONTACT_LEN = 100;
// Не больше стольких машинок в день на человека: 5–6 за раз можно, занять всю неделю — нет
const MAX_PER_DAY = 6;
const MAX_NOTE_LEN = 140; // заметка админа к машинке
const ADMIN_MAX_FAILS = 10; // неудачных входов в админку за 15 минут, потом пауза
const ADMIN_TOKEN_DAYS = 365; // сколько живёт вход с устройства без повторного пароля
const ADMIN_MAX_TOKENS = 30; // запомненных устройств админов; самые старые вытесняются

/**
 * GET без параметров — страница (запасной вариант), GET ?action=state&device=… — JSON для GitHub Pages.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'state') return json_(() => getState(p.device));
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Запись на стирку')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * POST с телом {action: 'book'|'cancel', …} в text/plain (без CORS-preflight) — JSON-ответ.
 * Страница на GitHub Pages ходит сюда без cookies Google, поэтому несколько аккаунтов в браузере не мешают.
 */
function doPost(e) {
  return json_(() => {
    const req = JSON.parse(e.postData.contents);
    if (req.action === 'book') return book(req);
    if (req.action === 'cancel') return cancel(req.deviceId, req.id);
    if (req.action === 'admin') return adminApi(req);
    throw new Error('ERR_ACTION');
  });
}

function json_(fn) {
  let out;
  try { out = { result: fn() }; } catch (err) { out = { error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Состояние на неделю: какие ячейки заняты, какие мои, какие уже прошли. */
function getState(deviceId) {
  const days = days_();
  const device = hash_(deviceId);
  const rows = rowsCached_().filter(r => days.indexOf(r[COL.date]) >= 0 && r[COL.status] === 'active');
  const taken = rows.map(r => ({
    date: r[COL.date],
    slot: r[COL.slot],
    machine: Number(r[COL.machine]),
    // Номер комнаты наружу не отдаём: он есть только в Google-таблице
    name: String(r[COL.name]), // имя и контакт показываются по нажатию на занятую ячейку
    contact: String(r[COL.contact] || ''),
    mine: r[COL.device] === device,
    id: r[COL.id],
  }));
  return {
    today: days[0], days: days, slots: SLOTS, machines: MACHINES, price: PRICE, maxPerDay: MAX_PER_DAY,
    taken: taken, closed: closedSlots_(), disabled: disabled_(), notes: notes_(),
  };
}

/**
 * Записывает пачку ячеек одним запросом.
 * req = { deviceId, name, room, contact?, consent, cells: [{date, slot, machine}], receipt: {name, mime, base64} } — квитанция обязательна
 */
function book(req) {
  const name = String(req.name || '').trim();
  const room = String(req.room || '').trim();
  const contact = String(req.contact || '').trim().slice(0, MAX_CONTACT_LEN);
  // Ошибки — кодами, текст на нужном языке подставляет страница
  if (!name || !room) throw new Error('ERR_PROFILE');
  if (!req.consent) throw new Error('ERR_CONSENT');
  const days = days_();
  const cells = (req.cells || []).filter(c => days.indexOf(c.date) >= 0 && SLOTS.indexOf(c.slot) >= 0 && c.machine >= 1 && c.machine <= MACHINES);
  if (!cells.length) throw new Error('ERR_EMPTY');
  const off = disabled_();
  if (cells.some(c => Object.prototype.hasOwnProperty.call(off, String(c.machine)))) throw new Error('ERR_MACHINE_OFF');
  ensureTrigger_();

  // Квитанция об оплате обязательна (одна на всю запись)
  if (!req.receipt || !req.receipt.base64) throw new Error('ERR_RECEIPT');
  const receiptUrl = saveReceipt_(req.receipt, name, room);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const today = days[0];
    const closed = closedSlots_();
    const device = hash_(req.deviceId);
    const norm = v => String(v).trim().toLowerCase().replace(/\s+/g, ' ');
    // «Тот же человек» — то же устройство или та же пара «имя + комната»
    const isSamePerson = r => r[COL.device] === device || (norm(r[COL.room]) === norm(room) && norm(r[COL.name]) === norm(name));
    const busy = {}, perDay = {};
    readRows_().forEach(r => {
      if (r[COL.status] !== 'active') return;
      busy[r[COL.date] + '#' + r[COL.slot] + '#' + r[COL.machine]] = true;
      if (isSamePerson(r)) perDay[r[COL.date]] = (perDay[r[COL.date]] || 0) + 1;
    });
    const conflicts = cells.filter(c => busy[c.date + '#' + c.slot + '#' + c.machine] || (c.date === today && closed.indexOf(c.slot) >= 0));
    if (conflicts.length) {
      return { ok: false, conflicts: conflicts, state: getState(req.deviceId) };
    }
    const newPerDay = {};
    cells.forEach(c => { newPerDay[c.date] = (newPerDay[c.date] || 0) + 1; });
    if (Object.keys(newPerDay).some(d => (perDay[d] || 0) + newPerDay[d] > MAX_PER_DAY)) throw new Error('ERR_LIMIT');
    const now = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm:ss');
    const batch = Utilities.getUuid().slice(0, 8);
    const rows = cells.map(c => {
      const r = new Array(HEADERS.length).fill('');
      r[COL.id] = Utilities.getUuid().slice(0, 8);
      r[COL.created] = now;
      r[COL.date] = c.date;
      r[COL.slot] = c.slot;
      r[COL.machine] = c.machine;
      r[COL.name] = name;
      r[COL.room] = room;
      r[COL.paid] = PRICE;
      r[COL.receipt] = receiptUrl;
      r[COL.contact] = contact;
      r[COL.status] = 'active';
      r[COL.device] = device;
      r[COL.batch] = batch;
      return r;
    });
    const sh = sheet_();
    // Пишем текстом, иначе таблица превратит комнату «012» в 12, а время — в дату
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setNumberFormat('@').setValues(rows);
    dropRowsCache_();
  } finally {
    lock.releaseLock();
  }
  return { ok: true, state: getState(req.deviceId) };
}

/** Отменяет свою запись. Отменить можно только с того устройства, с которого записывались. */
function cancel(deviceId, id) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_();
    const values = sh.getDataRange().getValues();
    const device = hash_(deviceId);
    for (let i = 1; i < values.length; i++) {
      if (values[i][COL.id] === id) {
        if (values[i][COL.device] !== device) throw new Error('ERR_NOT_MINE');
        sh.getRange(i + 1, COL.status + 1).setValue('cancelled');
        dropRowsCache_();
        break;
      }
    }
  } finally {
    lock.releaseLock();
  }
  return getState(deviceId);
}

// ---------- админка ----------

/**
 * req = { password, op: 'login' | 'setMachines', machines?: { "<номер>": "" }, notes?: { "<номер>": "текст" } }
 * В machines передаются только неработающие машинки; остальные считаются рабочими.
 * notes — заметки админа к машинкам (видны всем): у работающей — особенность, у выключенной — пояснение.
 */
function adminApi(req) {
  // Вход по паролю выдаёт устройству токен: дальше админка открывается без пароля
  if (req.op === 'login') {
    checkAdmin_(req.password);
    return { token: issueAdminToken_(), disabled: disabled_(), notes: notes_() };
  }
  if (req.op === 'logout') { revokeAdminToken_(req.token); return { ok: true }; }
  checkAdminToken_(req.token);
  if (req.op === 'get') return { disabled: disabled_(), notes: notes_() };
  if (req.op === 'shareReceipts') return { shared: shareReceipts() };
  if (req.op === 'paidTotal') { const sh = sheet_(); setPaidTotal_(sh); SpreadsheetApp.flush(); return { header: sh.getRange(1, COL.paid + 1).getDisplayValue(), formula: sh.getRange(1, COL.paid + 1).getFormula() }; }
  if (req.op === 'setMachines') {
    const out = {};
    Object.keys(req.machines || {}).forEach(k => {
      const n = Number(k);
      if (n >= 1 && n <= MACHINES) out[n] = '';
    });
    const notes = {};
    Object.keys(req.notes || {}).forEach(k => {
      const n = Number(k), text = String(req.notes[k] || '').trim().slice(0, MAX_NOTE_LEN);
      if (n >= 1 && n <= MACHINES && text) notes[n] = text;
    });
    const props = PropertiesService.getScriptProperties();
    props.setProperty('disabled', JSON.stringify(out));
    props.setProperty('notes', JSON.stringify(notes));
    return { disabled: out, notes: notes };
  }
  throw new Error('ERR_ACTION');
}

/** Токены устройств админов: в свойствах лежат только их хэши { hash: выдан_мс }. */
function adminTokens_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('adminTokens') || '{}'); }
  catch (e) { return {}; }
}
function saveAdminTokens_(t) {
  PropertiesService.getScriptProperties().setProperty('adminTokens', JSON.stringify(t));
}
function tokenHash_(token) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8));
}
function issueAdminToken_() {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    const t = adminTokens_(), now = Date.now(), ttl = ADMIN_TOKEN_DAYS * 864e5;
    Object.keys(t).forEach(h => { if (now - t[h] > ttl) delete t[h]; });
    t[tokenHash_(token)] = now;
    const keys = Object.keys(t).sort((a, b) => t[a] - t[b]);
    keys.slice(0, Math.max(0, keys.length - ADMIN_MAX_TOKENS)).forEach(h => delete t[h]);
    saveAdminTokens_(t);
  } finally { lock.releaseLock(); }
  return token;
}
function checkAdminToken_(token) {
  if (!token) throw new Error('ERR_ADMIN_TOKEN');
  const issued = adminTokens_()[tokenHash_(token)];
  if (!issued || Date.now() - issued > ADMIN_TOKEN_DAYS * 864e5) throw new Error('ERR_ADMIN_TOKEN');
}
function revokeAdminToken_(token) {
  if (!token) return;
  const lock = LockService.getScriptLock(); lock.waitLock(10000);
  try { const t = adminTokens_(); delete t[tokenHash_(token)]; saveAdminTokens_(t); }
  finally { lock.releaseLock(); }
}
/** Запустить вручную в редакторе после смены пароля: разлогинит все устройства админов. */
function revokeAllAdminTokens() {
  PropertiesService.getScriptProperties().deleteProperty('adminTokens');
}

/** Пароль сверяется с солёным хэшем из Secrets.gs (файл не попадает в git). */
function checkAdmin_(password) {
  if (typeof ADMIN_PASSWORD_HASH === 'undefined') throw new Error('ERR_ADMIN_OFF');
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('adminFails') || 0);
  if (fails >= ADMIN_MAX_FAILS) throw new Error('ERR_ADMIN_LOCKED');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, ADMIN_SALT + String(password || ''), Utilities.Charset.UTF_8);
  if (Utilities.base64Encode(bytes) !== ADMIN_PASSWORD_HASH) {
    cache.put('adminFails', String(fails + 1), 900);
    throw new Error('ERR_ADMIN_PASSWORD');
  }
}

/** Неработающие машинки: { "5": "" }. Действуют на все дни, пока админ не включит обратно. */
function disabled_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('disabled') || '{}'); }
  catch (e) { return {}; }
}

/** Заметки админа к машинкам: { "3": "только программы 180–210 минут" }. */
function notes_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('notes') || '{}'); }
  catch (e) { return {}; }
}

// ---------- helpers ----------

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET, 0);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    setPaidTotal_(sh);
  }
  return sh;
}

/**
 * В шапке столбца «Оплата, ₽» — сумма по неотменённым записям (Статус = active).
 * Суммы пишутся текстом, поэтому VALUE; пустые и нечисловые ячейки считаются нулём.
 */
function setPaidTotal_(sh) {
  const col = c => String.fromCharCode(65 + c);
  const paid = col(COL.paid), status = col(COL.status);
  const cell = sh.getRange(1, COL.paid + 1);
  const f = '="' + HEADERS[COL.paid] + ' (итого: "&SUMPRODUCT((' + status + '2:' + status + '="active")*IFERROR(VALUE(' + paid + '2:' + paid + '),0))&")"';
  cell.setFormula(f);
  SpreadsheetApp.flush();
  // В русской локали таблицы аргументы иногда разбираются только через «;»
  if (/^#/.test(cell.getDisplayValue())) { cell.setFormula(f.replace(/,0\)/, ';0)')); SpreadsheetApp.flush(); }
  if (/^#/.test(cell.getDisplayValue())) cell.setValue(HEADERS[COL.paid]);
}

// Кэш строк таблицы на 30 секунд: чтение таблицы — самая медленная часть ответа.
// Запись проверяет конфликты по свежим данным (readRows_), а после записи/отмены кэш сбрасывается.
// Ручные правки в таблице появятся на сайте с задержкой до ROWS_CACHE_SEC.
const ROWS_CACHE_SEC = 30;
function rowsCached_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('rows');
  if (hit) return JSON.parse(hit);
  const rows = readRows_();
  try { cache.put('rows', JSON.stringify(rows), ROWS_CACHE_SEC); } catch (e) {} // > 100 КБ — просто без кэша
  return rows;
}
function dropRowsCache_() {
  CacheService.getScriptCache().remove('rows');
}

function readRows_() {
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues();
}

/** Дни, на которые открыта запись: с сегодня до ближайшего воскресенья включительно. */
function days_() {
  const now = new Date();
  const dow = Number(Utilities.formatDate(now, TZ, 'u')); // 1 = пн … 7 = вс
  const out = [];
  for (let i = 0; i <= 7 - dow; i++) out.push(Utilities.formatDate(new Date(now.getTime() + i * 86400000), TZ, 'dd.MM.yyyy'));
  return out;
}

/** Слоты сегодняшнего дня, которые уже закончились: на них записаться нельзя. */
function closedSlots_() {
  const nowMin = Number(Utilities.formatDate(new Date(), TZ, 'H')) * 60 + Number(Utilities.formatDate(new Date(), TZ, 'm'));
  return SLOTS.filter(s => {
    const end = s.split('-')[1];
    const endMin = end === '00:00' ? 24 * 60 : Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
    return nowMin >= endMin;
  });
}

function hash_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s || ''));
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 22);
}

function saveReceipt_(receipt, name, room) {
  const bytes = Utilities.base64Decode(receipt.base64);
  if (bytes.length > MAX_RECEIPT_BYTES) throw new Error('ERR_FILE_SIZE');
  const folders = DriveApp.getFoldersByName(RECEIPTS_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(RECEIPTS_FOLDER);
  const fileName = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH-mm') + ' ' + room + ' ' + name + ' — ' + (receipt.name || 'квитанция');
  const file = folder.createFile(Utilities.newBlob(bytes, receipt.mime || 'application/octet-stream', fileName));
  // Квитанцию по ссылке из таблицы может открыть любой, без входа в Google
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { console.warn('setSharing: ' + e); }
  return file.getUrl();
}

/** Открыть по ссылке (только просмотр) папку и все уже загруженные квитанции. Возвращает число файлов. */
function shareReceipts() {
  let n = 0;
  const folders = DriveApp.getFoldersByName(RECEIPTS_FOLDER);
  while (folders.hasNext()) {
    const folder = folders.next();
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const files = folder.getFiles();
    while (files.hasNext()) { files.next().setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); n++; }
  }
  return n;
}

/**
 * Еженедельный сброс: в ночь с воскресенья на понедельник удаляет записи прошедших дней,
 * в таблице остаётся только текущая неделя. Запускается триггером, см. ensureTrigger_.
 */
function weeklyReset() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < 2) return;
    const today = Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
    const values = sh.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues();
    const keep = values.filter(r => {
      const p = r[COL.date].split('.');
      return p.length === 3 && p[2] + p[1] + p[0] >= today;
    });
    sh.getRange(2, 1, last - 1, HEADERS.length).clearContent();
    if (keep.length) sh.getRange(2, 1, keep.length, HEADERS.length).setValues(keep);
    dropRowsCache_();
  } finally {
    lock.releaseLock();
  }
}

/** Ставит еженедельный триггер сброса (пн 00:00 по Москве), если его ещё нет. */
function ensureTrigger_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('resetTrigger')) return;
  const exists = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'weeklyReset');
  if (!exists) {
    ScriptApp.newTrigger('weeklyReset').timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(0).nearMinute(0).inTimezone(TZ).create();
  }
  props.setProperty('resetTrigger', '1');
}

/**
 * Пересоздаёт еженедельный триггер от имени того, кто запускает функцию.
 * Нужно после смены владельца: триггеры принадлежат конкретному аккаунту.
 */
function reinstallTrigger() {
  removeMyTriggers();
  ScriptApp.newTrigger('weeklyReset').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(0).nearMinute(0).inTimezone(TZ).create();
  PropertiesService.getScriptProperties().setProperty('resetTrigger', '1');
  Logger.log('Триггер weeklyReset установлен от имени ' + Session.getEffectiveUser().getEmail());
}

/** Удаляет триггеры weeklyReset текущего аккаунта (например, бывшего владельца). */
function removeMyTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'weeklyReset')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

/** Ручная настройка из редактора: создаёт лист и триггер. */
function setup() {
  sheet_();
  ensureTrigger_();
}
