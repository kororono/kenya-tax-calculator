/**
 * Kenya Tax & Daily Rate Gross-Up Calculator (2026 Statutory Rates)
 * Google Apps Script Backend — Web App + Backward-Compatible Corrective Ledger + Payments Log in Google Sheets.
 */

var SHEET_PROP_KEY = 'LOG_SPREADSHEET_ID';
var DEFAULT_SHEET_NAME = 'Mom Tax Calculations Log (2026)';
var SUMMARY_TAB = 'Calculations Log';
var MONTHLY_TAB = 'Monthly Breakdown Log';
var PAYMENTS_TAB = 'Payments Log';

var SUMMARY_HEADERS = [
  'Calc ID', 'Saved At (EAT)', 'Status', 'Supersedes ID', 'Correction Reason',
  'Calc Mode', 'Billing Basis', 'Total Months', 'Child 1 Days', 'Child 1 Rate (KES)',
  'Child 2 Days', 'Child 2 Rate (KES)', 'Total Days', 'Target Net (KES)', 'Gross / Combined Value (KES)',
  'Additional Tax Top-Up (KES)', 'Payments Received / Prior Paid (KES)', 'Net Balance Due / Variance (KES)',
  'NSSF (KES)', 'SHA/SHIF (KES)', 'Housing Levy (KES)', 'Taxable Pay (KES)',
  'Net PAYE (KES)', 'Final Take-Home (KES)', 'Effective Taxed Daily Rate (KES)', 'State JSON'
];

var MONTHLY_HEADERS = [
  'Calc ID', 'Saved At (EAT)', 'Status', 'Month Label', 'Tax Basis', 'Child 1 Days', 'Child 2 Days',
  'Total Days', 'Base Amount (KES)', 'Gross Amount (KES)', 'Deductions + PAYE (KES)', 'Net Fee (KES)'
];

var PAYMENTS_HEADERS = [
  'Calc ID', 'Saved At (EAT)', 'Status', 'Payment Date', 'M-PESA / Bank Reference',
  'Channel / Note', 'Amount Received (KES)'
];

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'list') {
    var listRes = listSavedCalculations();
    return ContentService.createTextOutput(JSON.stringify(listRes))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({ ok: true, status: 'ready' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var body = e && e.postData && e.postData.contents ? JSON.parse(e.postData.contents) : {};
    if (body.action === 'void' && body.calcId) {
      var vRes = voidSavedCalculation(body.calcId, body.reason || 'Voided from web app');
      return ContentService.createTextOutput(JSON.stringify(vRes)).setMimeType(ContentService.MimeType.JSON);
    }
    var payload = body.payload || body;
    var res = saveCalculationToSheet(payload);
    return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;

  var props = PropertiesService.getScriptProperties();
  var savedId = props.getProperty(SHEET_PROP_KEY);
  if (savedId) {
    try {
      return SpreadsheetApp.openById(savedId);
    } catch (err) {
      // Recreate if deleted
    }
  }
  ss = SpreadsheetApp.create(DEFAULT_SHEET_NAME);
  props.setProperty(SHEET_PROP_KEY, ss.getId());
  return ss;
}

function ensureSheetWithHeaders_(ss, tabName, headers) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold').setBackground('#1B365D').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
  } else if (sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function markRowStatus_(sheet, targetCalcId, newStatus) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
  var updated = false;
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]) === String(targetCalcId)) {
      sheet.getRange(i + 2, 3).setValue(newStatus);
      updated = true;
    }
  }
  return updated;
}

function saveCalculationToSheet(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid calculation payload.');
  }
  var ss = getOrCreateSpreadsheet_();
  var timestamp = Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yyyy-MM-dd HH:mm:ss');
  var calcId = payload.calcId || ('CALC-' + Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yyyyMMdd-HHmmss'));
  var supersedesId = payload.supersedesId || '';
  var sumSheet = ensureSheetWithHeaders_(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  var mSheet = ensureSheetWithHeaders_(ss, MONTHLY_TAB, MONTHLY_HEADERS);
  var pSheet = ensureSheetWithHeaders_(ss, PAYMENTS_TAB, PAYMENTS_HEADERS);

  if (supersedesId) {
    markRowStatus_(sumSheet, supersedesId, 'SUPERSEDED BY ' + calcId);
    markRowStatus_(mSheet, supersedesId, 'SUPERSEDED BY ' + calcId);
    markRowStatus_(pSheet, supersedesId, 'SUPERSEDED BY ' + calcId);
  }

  sumSheet.appendRow([
    calcId,
    timestamp,
    'ACTIVE',
    supersedesId,
    payload.correctionReason || '',
    payload.calcMode || '',
    payload.billingMode || '',
    Number(payload.monthCount || 0),
    Number(payload.daughterDays || 0),
    Number(payload.daughterRate || 0),
    Number(payload.sonDays || 0),
    Number(payload.sonRate || 0),
    Number(payload.totalDays || 0),
    Number(payload.targetNet || 0),
    Number(payload.gross || 0),
    Number(payload.additionalPay || 0),
    Number(payload.priorPaid || 0),
    Number(payload.balanceOwed || 0),
    Number(payload.nssf || 0),
    Number(payload.shif || 0),
    Number(payload.ahl || 0),
    Number(payload.taxable || 0),
    Number(payload.paye || 0),
    Number(payload.net || 0),
    Number(payload.effectiveDaily || 0),
    JSON.stringify(payload.rawState || {})
  ]);

  if (Array.isArray(payload.months) && payload.months.length > 0) {
    for (var i = 0; i < payload.months.length; i++) {
      var m = payload.months[i];
      mSheet.appendRow([
        calcId, timestamp, 'ACTIVE', m.label || '', m.legacy ? 'Legacy (Non-Tax)' : 'eTIMS Taxed',
        Number(m.dDays || 0), Number(m.sDays || 0), Number(m.totalDays || 0),
        Number(m.baseAmt || 0), Number(m.gross || 0), Number(m.totalDed || 0), Number(m.net || 0)
      ]);
    }
  }

  if (Array.isArray(payload.payments) && payload.payments.length > 0) {
    for (var j = 0; j < payload.payments.length; j++) {
      var pay = payload.payments[j];
      pSheet.appendRow([
        calcId, timestamp, 'ACTIVE', pay.date || '', pay.ref || '',
        pay.note || '', Number(pay.amount || 0)
      ]);
    }
  }

  return {
    ok: true,
    calcId: calcId,
    timestamp: timestamp,
    sheetUrl: ss.getUrl(),
    sheetName: ss.getName(),
    history: listSavedCalculations().history
  };
}

function voidSavedCalculation(calcId, reason) {
  var ss = getOrCreateSpreadsheet_();
  var sumSheet = ensureSheetWithHeaders_(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  var mSheet = ensureSheetWithHeaders_(ss, MONTHLY_TAB, MONTHLY_HEADERS);
  var pSheet = ensureSheetWithHeaders_(ss, PAYMENTS_TAB, PAYMENTS_HEADERS);
  var label = 'VOIDED' + (reason ? ' (' + reason + ')' : '');
  markRowStatus_(sumSheet, calcId, label);
  markRowStatus_(mSheet, calcId, label);
  markRowStatus_(pSheet, calcId, label);
  return { ok: true, calcId: calcId, history: listSavedCalculations().history };
}

function listSavedCalculations() {
  var ss = getOrCreateSpreadsheet_();
  var sumSheet = ensureSheetWithHeaders_(ss, SUMMARY_TAB, SUMMARY_HEADERS);
  ensureSheetWithHeaders_(ss, PAYMENTS_TAB, PAYMENTS_HEADERS);
  var lastRow = sumSheet.getLastRow();
  if (lastRow < 2) {
    return { ok: true, sheetUrl: ss.getUrl(), history: [] };
  }
  var numRows = lastRow - 1;
  var values = sumSheet.getRange(2, 1, numRows, SUMMARY_HEADERS.length).getValues();
  var list = [];
  for (var i = values.length - 1; i >= 0 && list.length < 30; i--) {
    var r = values[i];
    var parsedState = {};
    try {
      parsedState = r[25] ? JSON.parse(String(r[25])) : {};
    } catch (e) {
      parsedState = {};
    }
    list.push({
      calcId: String(r[0]),
      timestamp: String(r[1]),
      status: String(r[2]),
      supersedesId: String(r[3] || ''),
      correctionReason: String(r[4] || ''),
      totalDays: Number(r[12] || 0),
      targetNet: Number(r[13] || 0),
      gross: Number(r[14] || 0),
      additionalPay: Number(r[15] || 0),
      priorPaid: Number(r[16] || 0),
      balanceOwed: Number(r[17] || 0),
      rawState: parsedState
    });
  }
  return { ok: true, sheetUrl: ss.getUrl(), history: list };
}
