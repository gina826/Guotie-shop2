/**
 * 金脆鍋貼 — 線上訂單 → Google 試算表（Google Apps Script）
 *
 * 使用方式請看同資料夾的 SETUP.md。
 * 概念：網站把訂單 POST 到這支 Web App；這裡驗證、以「商品」工作表的價格重算金額、
 *       寫入「訂單」「訂單明細」，並寄通知信給店家。
 */

/* ================= 常數 ================= */
// 工作表名稱加上「網站」前綴，避免與你試算表裡既有的「訂單」「商品」「設定」等工作表撞名
const SHEET_ORDERS = '網站訂單';
const SHEET_ITEMS = '網站訂單明細';
const SHEET_PRODUCTS = '網站商品';
const SHEET_SETTINGS = '網站設定';

const ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '姓名', '手機', '外送地址', '期望時間', '備註', '品項摘要', '總金額', '來源', 'requestId', '系統備註'];
const ITEM_HEADERS = ['訂單編號', '品項ID', '品名', '單價', '數量', '小計'];
const PRODUCT_HEADERS = ['品項ID', '分類', '品名', '單價', '上架'];
const STATUS_LIST = ['待確認', '製作中', '可取餐', '已完成', '已取消'];
const TYPE_LABEL = { 'dine-in': '內用', 'takeout': '外帶', 'delivery': '宅配' };

// 欄位位置（1 起算），要與 ORDER_HEADERS 順序一致
const COL = { NO: 1, TIME: 2, STATUS: 3, TYPE: 4, NAME: 5, PHONE: 6, ADDR: 7, WANT: 8, NOTE: 9, SUMMARY: 10, TOTAL: 11, SRC: 12, REQ: 13, SYS: 14 };

const SEED_PRODUCTS = [
  ['p1', '招牌鍋貼', '招牌金脆豬肉鍋貼', 150, true],
  ['p2', '招牌鍋貼', '韭香豬肉鍋貼', 160, true],
  ['p3', '招牌鍋貼', '香蔥牛肉鍋貼', 180, true],
  ['p4', '招牌鍋貼', '素食菇菇鍋貼', 140, true],
  ['d1', '精選水餃', '高麗菜豬肉水餃', 140, true],
  ['d2', '精選水餃', '薑蔥鮮肉水餃', 160, true],
  ['d3', '精選水餃', '泡菜豬肉水餃', 170, true],
  ['t1', '湯品 / 飲料', '招牌酸辣湯', 60, true],
  ['t2', '湯品 / 飲料', '手工蛋花湯', 50, true],
  ['t3', '湯品 / 飲料', '梅子綠茶', 40, true],
  ['x1', '經典小菜', '拍黃瓜', 70, true],
  ['x2', '經典小菜', '涼拌海帶芽', 60, true],
  ['x3', '經典小菜', '蒜香青江菜', 80, true],
  ['g1', '冷凍禮盒', '招財鍋貼禮盒 50 入', 750, true],
  ['g2', '冷凍禮盒', '家庭團圓組 30 入', 460, true]
];

// 設定表：[key, value, 說明]
const SEED_SETTINGS = [
  ['SHOP_NAME', '金脆鍋貼', '店名（用於通知信標題）'],
  ['ACCEPT_ORDERS', 'TRUE', 'TRUE＝接單；FALSE＝暫停接單（打烊、賣完時用）'],
  ['NOTIFY_ENABLED', 'TRUE', '有新訂單時是否寄通知信'],
  ['NOTIFY_EMAIL', '', '通知信收件者（可用逗號分隔多個）；留空＝寄給部署此腳本的帳號'],
  ['DAILY_SUMMARY_ENABLED', 'TRUE', '是否每天寄送當日訂單彙總']
];

const LIMITS = { name: 30, address: 120, note: 200, maxItems: 30, maxQty: 99, ratePerPhone: 5, rateWindowSec: 600 };

/* ================= 對外入口 ================= */
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'ping') return json_({ ok: true, service: 'gyoza-orders', time: new Date().toISOString() });
  return json_({ ok: false, code: 'NOT_FOUND', message: '此網址僅供訂單系統使用。' });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents;
    if (!raw) return json_({ ok: false, code: 'EMPTY', message: '沒有收到訂單資料。' });
    let data;
    try { data = JSON.parse(raw); } catch (_) { return json_({ ok: false, code: 'BAD_JSON', message: '訂單資料格式錯誤。' }); }
    return json_(handleOrder_(data));
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, code: 'SERVER', message: '系統忙碌中，請稍後再試。' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ================= 訂單處理 ================= */
function handleOrder_(data) {
  // 1) 機器人陷阱：隱藏欄位 website 有值就假裝成功、不寫入
  if (data && data.website) return { ok: true, orderNo: 'GC000000-000', total: 0 };

  const settings = readSettings_();
  if (String(settings.ACCEPT_ORDERS).toUpperCase() === 'FALSE') {
    return { ok: false, code: 'CLOSED', message: '目前暫停接單，請稍後再試或來電洽詢。' };
  }

  const v = validate_(data);
  if (v.error) return { ok: false, code: 'INVALID', message: v.error };
  const o = v.order;

  // 2) 簡易頻率限制（同一手機 10 分鐘內最多 5 筆）
  const cache = CacheService.getScriptCache();
  const rateKey = 'rate_' + o.phone;
  const rate = parseInt(cache.get(rateKey), 10) || 0;
  if (rate >= LIMITS.ratePerPhone) return { ok: false, code: 'TOO_MANY', message: '送出次數過多，請稍後再試。' };

  // 3) 全程上鎖：避免同時下單造成編號重複
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, code: 'BUSY', message: '系統忙碌中，請稍後再試。' };

  let result;
  try {
    // 重送保護：同一個 requestId 只建立一次
    const dup = findByRequestId_(o.requestId);
    if (dup) return { ok: true, orderNo: dup.orderNo, total: dup.total, duplicate: true };

    // 以「商品」表的價格重算，不信任前端金額
    const priced = priceItems_(o.items);
    if (priced.error) return { ok: false, code: 'INVALID', message: priced.error };

    const sysNotes = [];
    if (o.clientTotal !== null && o.clientTotal !== priced.total) {
      sysNotes.push('前端金額 ' + o.clientTotal + ' 與系統金額 ' + priced.total + ' 不符，已以系統為準');
    }

    const orderNo = nextOrderNo_();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sOrders = ss.getSheetByName(SHEET_ORDERS);
    const sItems = ss.getSheetByName(SHEET_ITEMS);
    if (!sOrders || !sItems) return { ok: false, code: 'NOT_SETUP', message: '系統尚未初始化。' };

    const summary = priced.items.map(i => i.name + ' ×' + i.qty).join('、');
    const orderRow = [];
    orderRow[COL.NO - 1] = orderNo;
    orderRow[COL.TIME - 1] = new Date();
    orderRow[COL.STATUS - 1] = STATUS_LIST[0];
    orderRow[COL.TYPE - 1] = TYPE_LABEL[o.type];
    orderRow[COL.NAME - 1] = cell_(o.name);
    orderRow[COL.PHONE - 1] = o.phone;
    orderRow[COL.ADDR - 1] = cell_(o.address);
    orderRow[COL.WANT - 1] = o.time;
    orderRow[COL.NOTE - 1] = cell_(o.note);
    orderRow[COL.SUMMARY - 1] = summary;
    orderRow[COL.TOTAL - 1] = priced.total;
    orderRow[COL.SRC - 1] = o.source;
    orderRow[COL.REQ - 1] = o.requestId;
    orderRow[COL.SYS - 1] = sysNotes.join('；');

    appendRows_(sOrders, [orderRow]);
    appendRows_(sItems, priced.items.map(i => [orderNo, i.id, i.name, i.price, i.qty, i.price * i.qty]));
    SpreadsheetApp.flush();

    result = { orderNo: orderNo, total: priced.total, items: priced.items, order: o, summary: summary };
    cache.put('req_' + o.requestId, JSON.stringify({ orderNo: orderNo, total: priced.total }), 21600);
    cache.put(rateKey, String(rate + 1), LIMITS.rateWindowSec);
  } finally {
    lock.releaseLock();
  }

  // 4) 通知信（失敗不影響訂單）
  try { notifyShop_(settings, result); } catch (err) { console.error('通知信失敗', err); }

  return { ok: true, orderNo: result.orderNo, total: result.total };
}

/** 驗證並整理前端送來的資料（純函式，不碰試算表） */
function validate_(d) {
  if (!d || typeof d !== 'object') return { error: '訂單資料格式錯誤。' };
  const str = (x, max) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

  const type = String(d.type || '');
  if (!TYPE_LABEL[type]) return { error: '取餐方式不正確。' };
  const name = str(d.name, LIMITS.name);
  if (!name) return { error: '請填寫姓名。' };
  const phone = String(d.phone || '').trim();
  if (!/^09\d{8}$/.test(phone)) return { error: '請填寫正確的手機號碼（09 開頭，共 10 碼）。' };
  const address = str(d.address, LIMITS.address);
  if (type === 'delivery' && !address) return { error: '宅配需填寫外送地址。' };
  const time = String(d.time || '').trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: '期望時間格式不正確。' };
  const note = str(d.note, LIMITS.note);
  const requestId = String(d.requestId || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (requestId.length < 8) return { error: '訂單識別碼不正確，請重新整理頁面後再試。' };

  if (!Array.isArray(d.items) || d.items.length === 0) return { error: '購物車是空的。' };
  if (d.items.length > LIMITS.maxItems) return { error: '品項過多，請分次下單。' };
  const merged = {};
  for (const it of d.items) {
    const id = String(it && it.id || '').trim();
    const qty = Number(it && it.qty);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > LIMITS.maxQty) return { error: '品項數量不正確（1–' + LIMITS.maxQty + '）。' };
    merged[id] = (merged[id] || 0) + qty;
    if (merged[id] > LIMITS.maxQty) return { error: '單一品項數量過多，請洽門市。' };
  }
  const items = Object.keys(merged).map(id => ({ id: id, qty: merged[id] }));
  const clientTotal = Number.isFinite(Number(d.total)) && d.total !== '' && d.total != null ? Number(d.total) : null;

  return { order: { type: type, name: name, phone: phone, address: address, time: time, note: note, requestId: requestId, items: items, clientTotal: clientTotal, source: str(d.source, 12) || 'web' } };
}

/** 以「商品」表價格計價（上架=FALSE 或不存在的品項會被拒絕） */
function priceItems_(items) {
  const map = readProducts_();
  const out = [];
  let total = 0;
  for (const it of items) {
    const p = map[it.id];
    if (!p) return { error: '有品項已不存在，請重新整理頁面。' };
    if (!p.active) return { error: '「' + p.name + '」目前停售，請移除後再送出。' };
    out.push({ id: it.id, name: p.name, price: p.price, qty: it.qty });
    total += p.price * it.qty;
  }
  return { items: out, total: total };
}

function readProducts_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PRODUCTS);
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().forEach(r => {
    const id = String(r[0]).trim();
    if (!id) return;
    map[id] = { name: String(r[2]), price: Number(r[3]) || 0, active: r[4] === true || String(r[4]).toUpperCase() === 'TRUE' };
  });
  return map;
}

function readSettings_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const s = {};
  SEED_SETTINGS.forEach(r => s[r[0]] = r[1]);
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(r => { if (r[0]) s[String(r[0]).trim()] = r[1]; });
  }
  return s;
}

/** 每天流水號：GC261128-001 */
function nextOrderNo_() {
  const tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  const day = Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'SEQ_' + day;
  const n = (parseInt(props.getProperty(key), 10) || 0) + 1;
  props.setProperty(key, String(n));
  Object.keys(props.getProperties()).forEach(k => { if (k.indexOf('SEQ_') === 0 && k !== key) props.deleteProperty(k); });
  return 'GC' + day.slice(2) + '-' + String(n).padStart(3, '0');
}

function findByRequestId_(requestId) {
  const hit = CacheService.getScriptCache().get('req_' + requestId);
  if (hit) { try { return JSON.parse(hit); } catch (_) { /* 往下查表 */ } }
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORDERS);
  if (!sh || sh.getLastRow() < 2) return null;
  const last = sh.getLastRow();
  const from = Math.max(2, last - 299);
  const vals = sh.getRange(from, 1, last - from + 1, COL.REQ).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][COL.REQ - 1] === requestId) return { orderNo: vals[i][COL.NO - 1], total: vals[i][COL.TOTAL - 1] };
  }
  return null;
}

/** 防止公式注入：以 = + - @ 開頭的文字前面補單引號 */
function cell_(v) {
  v = String(v == null ? '' : v);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

/* ================= 通知信 ================= */
function notifyShop_(settings, r) {
  if (String(settings.NOTIFY_ENABLED).toUpperCase() === 'FALSE') return;
  const to = recipient_(settings);
  if (!to) { console.warn('找不到通知信收件者：請在「網站設定」填入 NOTIFY_EMAIL'); return; }
  const o = r.order, shop = settings.SHOP_NAME || '金脆鍋貼';
  const lines = [
    '訂單編號：' + r.orderNo,
    '取餐方式：' + TYPE_LABEL[o.type],
    '姓名：' + o.name,
    '手機：' + o.phone,
    o.type === 'delivery' ? '外送地址：' + o.address : null,
    o.time ? '期望時間：' + o.time : null,
    o.note ? '備註：' + o.note : null,
    '',
    '品項：'
  ].filter(x => x !== null);
  r.items.forEach(i => lines.push('  ' + i.name + ' × ' + i.qty + '　NT$ ' + (i.price * i.qty)));
  lines.push('', '總金額：NT$ ' + r.total, '', '試算表：' + SpreadsheetApp.getActiveSpreadsheet().getUrl());

  const rows = r.items.map(i => '<tr><td style="padding:4px 12px 4px 0">' + esc_(i.name) + '</td><td style="padding:4px 12px">× ' + i.qty + '</td><td style="padding:4px 0;text-align:right">NT$ ' + (i.price * i.qty) + '</td></tr>').join('');
  const html =
    '<div style="font-family:sans-serif;font-size:14px;color:#3B2A1E">' +
    '<h2 style="margin:0 0 8px">新訂單 ' + esc_(r.orderNo) + '</h2>' +
    '<p style="margin:0 0 12px">' + esc_(TYPE_LABEL[o.type]) + '｜' + esc_(o.name) + '｜' + esc_(o.phone) +
    (o.type === 'delivery' ? '<br>地址：' + esc_(o.address) : '') +
    (o.time ? '<br>期望時間：' + esc_(o.time) : '') +
    (o.note ? '<br>備註：' + esc_(o.note) : '') + '</p>' +
    '<table style="border-collapse:collapse">' + rows + '</table>' +
    '<p style="font-weight:bold;margin:12px 0">總金額：NT$ ' + r.total + '</p>' +
    '<p><a href="' + SpreadsheetApp.getActiveSpreadsheet().getUrl() + '">開啟訂單試算表</a></p></div>';

  MailApp.sendEmail({ to: to, subject: '[' + shop + '] 新訂單 ' + r.orderNo + '　NT$ ' + r.total, body: lines.join('\n'), htmlBody: html, name: shop + ' 訂單系統' });
}

/** 通知信收件者：優先用「網站設定」的 NOTIFY_EMAIL；留空才取部署者信箱（取不到就回傳空字串） */
function recipient_(settings) {
  const set = String(settings.NOTIFY_EMAIL || '').trim();
  if (set) return set;
  try { return Session.getEffectiveUser().getEmail(); } catch (err) { return ''; }
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 每日彙總（由定時觸發器呼叫；也可從選單手動執行） */
function sendDailySummary() {
  const settings = readSettings_();
  if (String(settings.DAILY_SUMMARY_ENABLED).toUpperCase() === 'FALSE') return;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ORDERS);
  if (!sh) return;
  const tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  let count = 0, total = 0, cancelled = 0;
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, COL.TOTAL).getValues().forEach(r => {
      const t = r[COL.TIME - 1];
      if (!(t instanceof Date) || Utilities.formatDate(t, tz, 'yyyy-MM-dd') !== today) return;
      if (r[COL.STATUS - 1] === '已取消') { cancelled++; return; }
      count++; total += Number(r[COL.TOTAL - 1]) || 0;
    });
  }
  const to = recipient_(settings);
  if (!to) return;
  const shop = settings.SHOP_NAME || '金脆鍋貼';
  MailApp.sendEmail({
    to: to,
    subject: '[' + shop + '] ' + today + ' 訂單彙總：' + count + ' 筆 / NT$ ' + total,
    body: today + ' 訂單彙總\n有效訂單：' + count + ' 筆\n營業額：NT$ ' + total + '\n已取消：' + cancelled + ' 筆\n\n' + SpreadsheetApp.getActiveSpreadsheet().getUrl()
  });
}

/* ================= 初始化（第一次手動執行一次即可） ================= */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('請從試算表的「擴充功能 → Apps Script」開啟此專案（需綁定試算表）。');

  const sOrders = ensureSheet_(ss, SHEET_ORDERS, ORDER_HEADERS);
  const sItems = ensureSheet_(ss, SHEET_ITEMS, ITEM_HEADERS);
  const sProducts = ensureSheet_(ss, SHEET_PRODUCTS, PRODUCT_HEADERS);
  const sSettings = ensureSheet_(ss, SHEET_SETTINGS, ['設定項目', '值', '說明']);

  if (sProducts.getLastRow() < 2) {
    sProducts.getRange(2, 1, SEED_PRODUCTS.length, 5).setValues(SEED_PRODUCTS);
  }
  sProducts.getRange(2, 5, 500, 1).insertCheckboxes();
  sProducts.getRange(2, 4, 500, 1).setNumberFormat('#,##0');

  if (sSettings.getLastRow() < 2) sSettings.getRange(2, 1, SEED_SETTINGS.length, 3).setValues(SEED_SETTINGS);
  sSettings.setColumnWidth(1, 190); sSettings.setColumnWidth(2, 220); sSettings.setColumnWidth(3, 460);

  // 訂單表：格式、下拉選單、顏色
  sOrders.getRange(2, COL.TIME, 2000, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sOrders.getRange(2, COL.PHONE, 2000, 1).setNumberFormat('@');   // 保留手機開頭的 0
  sOrders.getRange(2, COL.WANT, 2000, 1).setNumberFormat('@');
  sOrders.getRange(2, COL.TOTAL, 2000, 1).setNumberFormat('#,##0');
  sOrders.getRange(2, COL.STATUS, 2000, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUS_LIST, true).setAllowInvalid(false).build());
  const range = sOrders.getRange(2, 1, 2000, ORDER_HEADERS.length);
  const colors = { '待確認': '#fff4d6', '製作中': '#e3f0ff', '可取餐': '#e2f5e6', '已完成': '#f1f1f1', '已取消': '#fde4e4' };
  sOrders.setConditionalFormatRules(Object.keys(colors).map(s =>
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$C2="' + s + '"').setBackground(colors[s]).setRanges([range]).build()));
  [110, 150, 80, 80, 90, 110, 200, 80, 160, 320, 80, 60, 200, 220].forEach((w, i) => sOrders.setColumnWidth(i + 1, w));
  sOrders.hideColumns(COL.REQ);

  sItems.getRange(2, 4, 5000, 1).setNumberFormat('#,##0');
  sItems.getRange(2, 6, 5000, 1).setNumberFormat('#,##0');
  [110, 70, 200, 70, 60, 80].forEach((w, i) => sItems.setColumnWidth(i + 1, w));
  [70, 110, 200, 80, 60].forEach((w, i) => sProducts.setColumnWidth(i + 1, w));

  // 移除預設的空白工作表
  const blank = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  ss.setActiveSheet(sOrders);

  installTriggers_();
  SpreadsheetApp.getUi && safeAlert_('初始化完成！\n接著請：部署 → 新增部署作業 → 網頁應用程式（詳見 SETUP.md）。');
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
  } else {
    // 已存在：只有「空白」或「標題列與本系統完全相同（重複執行 setup）」才接手，
    // 否則停下來，避免覆蓋你原本的資料、資料驗證與格式。
    const cur = sh.getRange(1, 1, 1, headers.length).getValues()[0].map(String);
    const empty = sh.getLastRow() === 0 || (sh.getLastRow() === 1 && cur.every(c => c === ''));
    const same = headers.every((h, i) => cur[i] === h);
    if (!empty && !same) {
      throw new Error('已有名為「' + name + '」的工作表，且內容與本系統不同，為避免覆蓋已停止。請把它改名，或刪除後再執行 setup。');
    }
  }
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#3B2A1E').setFontColor('#FBF6EE').setHorizontalAlignment('center');
  sh.setFrozenRows(1);
  return sh;
}

function installTriggers_() {
  const have = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'sendDailySummary');
  if (!have) ScriptApp.newTrigger('sendDailySummary').timeBased().atHour(22).nearMinute(30).everyDays(1).create();
}

function safeAlert_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (_) { console.log(msg); } }

/* ================= 選單 / 測試工具 ================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('🥟 金脆鍋貼')
    .addItem('初始化（建立工作表）', 'setup')
    .addItem('寄送今日彙總', 'sendDailySummary')
    .addItem('寫入一筆測試訂單', 'testOrder')
    .addToUi();
}

function testOrder() {
  const r = handleOrder_({
    type: 'takeout', name: '測試訂單', phone: '0912345678', time: '12:30', note: '這是測試，可刪除',
    requestId: 'test-' + Utilities.getUuid(), total: 310, source: 'test',
    items: [{ id: 'p1', qty: 1 }, { id: 'p2', qty: 1 }]
  });
  console.log(JSON.stringify(r));
  // 用 toast（右下角小提示）而不是 alert，避免程式停下來等你按「確定」
  try { SpreadsheetApp.getActiveSpreadsheet().toast(r.ok ? '測試成功：' + r.orderNo : '失敗：' + r.message, '金脆鍋貼', 8); } catch (_) { /* 不在試算表環境時略過 */ }
  return r;
}
