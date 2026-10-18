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

const HEADERS = ['ID', 'Создано', 'Дата', 'Время', 'Машинка', 'Фамилия и имя', 'Комната', 'Оплата, ₽', 'Квитанция', 'Статус', 'Устройство', 'Пачка'];
const COL = { id: 0, created: 1, date: 2, slot: 3, machine: 4, name: 5, room: 6, paid: 7, receipt: 8, status: 9, device: 10, batch: 11 };

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
  const rows = readRows_().filter(r => days.indexOf(r[COL.date]) >= 0 && r[COL.status] === 'active');
  const taken = rows.map(r => ({
    date: r[COL.date],
    slot: r[COL.slot],
    machine: Number(r[COL.machine]),
    room: String(r[COL.room]),
    mine: r[COL.device] === device,
    id: r[COL.id],
  }));
  return { today: days[0], days: days, slots: SLOTS, machines: MACHINES, price: PRICE, taken: taken, closed: closedSlots_() };
}

/**
 * Записывает пачку ячеек одним запросом.
 * req = { deviceId, name, room, consent, cells: [{date, slot, machine}], receipt?: {name, mime, base64} }
 */
function book(req) {
  const name = String(req.name || '').trim();
  const room = String(req.room || '').trim();
  // Ошибки — кодами, текст на нужном языке подставляет страница
  if (!name || !room) throw new Error('ERR_PROFILE');
  if (!req.consent) throw new Error('ERR_CONSENT');
  const days = days_();
  const cells = (req.cells || []).filter(c => days.indexOf(c.date) >= 0 && SLOTS.indexOf(c.slot) >= 0 && c.machine >= 1 && c.machine <= MACHINES);
  if (!cells.length) throw new Error('ERR_EMPTY');
  ensureTrigger_();

  let receiptUrl = '';
  if (req.receipt && req.receipt.base64) receiptUrl = saveReceipt_(req.receipt, name, room);

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const today = days[0];
    const closed = closedSlots_();
    const busy = {};
    readRows_().forEach(r => {
      if (r[COL.status] === 'active') busy[r[COL.date] + '#' + r[COL.slot] + '#' + r[COL.machine]] = true;
    });
    const conflicts = cells.filter(c => busy[c.date + '#' + c.slot + '#' + c.machine] || (c.date === today && closed.indexOf(c.slot) >= 0));
    if (conflicts.length) {
      return { ok: false, conflicts: conflicts, state: getState(req.deviceId) };
    }
    const now = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm:ss');
    const device = hash_(req.deviceId);
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
      r[COL.status] = 'active';
      r[COL.device] = device;
      r[COL.batch] = batch;
      return r;
    });
    const sh = sheet_();
    // Пишем текстом, иначе таблица превратит комнату «012» в 12, а время — в дату
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setNumberFormat('@').setValues(rows);
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
        break;
      }
    }
  } finally {
    lock.releaseLock();
  }
  return getState(deviceId);
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
  }
  return sh;
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
  return file.getUrl();
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

/** Ручная настройка из редактора: создаёт лист и триггер. */
function setup() {
  sheet_();
  ensureTrigger_();
}
