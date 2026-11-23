/* ═══════════════════════════════════════════════════════════════════════════
   app.js — UI Controller, Hash Router, Persistent Google Sheet Sync & Exports
            (Depends on window.TaxEngine from js/tax-engine.js)
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var DEFAULT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbzkhx1VIdOvVpoQ83s9KjxeArzkQ6Qa_jvXeriUHbJjVeCXBZooSQTJf6QMerNOt05GMQ/exec';

  var STORAGE_KEYS = {
    HISTORY_CACHE: 'mom_tax_cloud_cache_v3',
    RATES: 'mom_tax_base_rates_v3',
    WEBHOOK: 'mom_tax_sheet_webhook_v3',
    THEME: 'mom_tax_theme_v3'
  };

  var MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  var ROUTES = ['calculator', 'rates', 'history', 'settings'];

  function currentMonthRow() {
    var now = new Date();
    return { month: MONTH_NAMES[now.getMonth()], year: now.getFullYear(), dDays: 0, sDays: 0 };
  }

  function nextMonthRow(lastRow) {
    if (!lastRow) return currentMonthRow();
    var idx = MONTH_NAMES.indexOf(lastRow.month);
    if (idx === -1 || idx === 11) {
      return { month: MONTH_NAMES[0], year: Number(lastRow.year || 2026) + 1, dDays: 0, sDays: 0 };
    }
    return { month: MONTH_NAMES[idx + 1], year: Number(lastRow.year || 2026), dDays: 0, sDays: 0 };
  }

  var appState = {
    calcMode: 'reverse',
    billingMode: 'lump',
    daughterRate: 3500,
    sonRate: 2500,
    maxDaysMonth: 20,
    priorPaid: 0,
    manualAdj: 0,
    correctionReason: '',
    supersedesId: '',
    previousGross: 0,
    months: [currentMonthRow()]
  };

  var lastComputed = null;
  var historyCache = [];
  var activeSheetUrl = '';

  function fmt(num) {
    return Number(num || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function el(id) {
    return document.getElementById(id);
  }

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getActiveWebhookUrl() {
    var custom = (localStorage.getItem(STORAGE_KEYS.WEBHOOK) || '').trim();
    if (custom) return custom;
    if (DEFAULT_WEBHOOK_URL && DEFAULT_WEBHOOK_URL.indexOf('https://') === 0) return DEFAULT_WEBHOOK_URL;
    return '';
  }

  /* ── Router ────────────────────────────────────────────────────────────── */
  function navigateTo(route) {
    var target = ROUTES.indexOf(route) !== -1 ? route : 'calculator';
    ROUTES.forEach(function (r) {
      var view = el('view-' + r);
      var tab = el('tab-' + r);
      if (view) view.classList.toggle('is-active', r === target);
      if (tab) tab.classList.toggle('is-active', r === target);
    });
    if (window.location.hash !== '#' + target) {
      history.replaceState(null, '', '#' + target);
    }
  }

  function syncRouteFromHash() {
    var h = (window.location.hash || '#calculator').replace('#', '');
    navigateTo(h);
  }

  /* ── Theme & Base Rates ────────────────────────────────────────────────── */
  function initThemeAndRates() {
    var savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    el('btnThemeToggle').textContent = (savedTheme === 'dark') ? 'Light Mode' : 'Dark Mode';

    try {
      var savedRates = JSON.parse(localStorage.getItem(STORAGE_KEYS.RATES) || 'null');
      if (savedRates) {
        if (savedRates.daughterRate !== undefined) appState.daughterRate = Number(savedRates.daughterRate);
        if (savedRates.sonRate !== undefined) appState.sonRate = Number(savedRates.sonRate);
        if (savedRates.maxDaysMonth !== undefined) appState.maxDaysMonth = Number(savedRates.maxDaysMonth);
      }
    } catch (e) {}

    el('daughterRate').value = appState.daughterRate;
    el('sonRate').value = appState.sonRate;
    el('maxDaysMonth').value = appState.maxDaysMonth;
    el('webhookUrl').value = getActiveWebhookUrl();
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var next = (cur === 'dark') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(STORAGE_KEYS.THEME, next);
    el('btnThemeToggle').textContent = (next === 'dark') ? 'Light Mode' : 'Dark Mode';
  }

  function readTaxParams() {
    var nssfRate = Number(el('pNssfRate').value || 6) / 100;
    var nssfCap = Number(el('pNssfCap').value || 108000);
    return {
      nssfRate: nssfRate,
      nssfCap: nssfCap,
      nssfMax: nssfRate * nssfCap,
      shifRate: Number(el('pShifRate').value || 2.75) / 100,
      shifMin: Number(el('pShifMin').value || 300),
      ahlRate: Number(el('pAhlRate').value || 1.5) / 100,
      relief: Number(el('pRelief').value || 2400)
    };
  }

  /* ── Month Cards ───────────────────────────────────────────────────────── */
  function buildMonthOptions(selected) {
    return MONTH_NAMES.map(function (m) {
      return '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + '</option>';
    }).join('');
  }

  function renderMonthCards() {
    var canRemove = appState.months.length > 1;
    el('monthsContainer').innerHTML = appState.months.map(function (m, i) {
      return (
        '<div class="c-month-item">' +
          '<div class="c-month-top">' +
            '<div class="c-month-pickers">' +
              '<select class="c-input" data-idx="' + i + '" data-field="month" aria-label="Month">' + buildMonthOptions(m.month) + '</select>' +
              '<input type="number" class="c-input" style="max-width:105px;" data-idx="' + i + '" data-field="year" value="' + Number(m.year || 2026) + '" min="2024" max="2035" aria-label="Year">' +
            '</div>' +
            (canRemove ? '<button type="button" class="c-btn c-btn--danger c-btn--sm" data-remove="' + i + '">Remove Month</button>' : '') +
          '</div>' +
          '<div class="c-month-grid">' +
            '<div class="c-field">' +
              '<label class="c-label">Daughter Days Worked</label>' +
              '<div class="c-stepper">' +
                '<button type="button" class="c-step-btn" data-step="-1" data-idx="' + i + '" data-field="dDays" aria-label="Decrease Daughter days">&minus;</button>' +
                '<input type="number" class="c-input" data-idx="' + i + '" data-field="dDays" value="' + Number(m.dDays || 0) + '" min="0" max="31" step="0.5">' +
                '<button type="button" class="c-step-btn" data-step="1" data-idx="' + i + '" data-field="dDays" aria-label="Increase Daughter days">+</button>' +
              '</div>' +
            '</div>' +
            '<div class="c-field">' +
              '<label class="c-label">Son Days Worked</label>' +
              '<div class="c-stepper">' +
                '<button type="button" class="c-step-btn" data-step="-1" data-idx="' + i + '" data-field="sDays" aria-label="Decrease Son days">&minus;</button>' +
                '<input type="number" class="c-input" data-idx="' + i + '" data-field="sDays" value="' + Number(m.sDays || 0) + '" min="0" max="31" step="0.5">' +
                '<button type="button" class="c-step-btn" data-step="1" data-idx="' + i + '" data-field="sDays" aria-label="Increase Son days">+</button>' +
              '</div>' +
            '</div>' +
            '<div class="c-month-summary" id="mSummary_' + i + '"></div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  /* ── Main Recalculate & Render ─────────────────────────────────────────── */
  function recalculate() {
    appState.daughterRate = Math.max(0, Number(el('daughterRate').value || 0));
    appState.sonRate = Math.max(0, Number(el('sonRate').value || 0));
    appState.maxDaysMonth = Math.max(1, Number(el('maxDaysMonth').value || 20));
    appState.billingMode = el('billingMode').value;
    appState.priorPaid = Math.max(0, Number(el('priorPaid').value || 0));
    appState.manualAdj = Number(el('manualAdj').value || 0);
    appState.correctionReason = el('correctionReason').value.trim();

    localStorage.setItem(STORAGE_KEYS.RATES, JSON.stringify({
      daughterRate: appState.daughterRate,
      sonRate: appState.sonRate,
      maxDaysMonth: appState.maxDaysMonth
    }));

    var params = readTaxParams();
    var res = window.TaxEngine.computeSchedule(appState, params);
    lastComputed = { state: JSON.parse(JSON.stringify(appState)), params: params, result: res };

    updateMonthSummaries(res);
    updateHeadlineCards(res);
    renderProofTable(res, params);
    renderPlannerView(params);
    renderPrintableStatement(res, params);
  }

  function updateMonthSummaries(res) {
    res.months.forEach(function (m, i) {
      var box = el('mSummary_' + i);
      if (!box) return;
      box.innerHTML =
        '<div class="c-month-summary-line"><span>Total Days:</span><strong>' + m.totalDays + ' days</strong></div>' +
        '<div class="c-month-summary-line"><span>Take-Home:</span><strong>KES ' + fmt(m.net) + '</strong></div>' +
        '<div class="c-month-summary-line"><span>Invoice Share:</span><strong>KES ' + fmt(m.gross) + '</strong></div>';
    });
  }

  function updateHeadlineCards(res) {
    var ov = res.overall;
    el('statNet').textContent = 'KES ' + fmt(ov.net);
    el('statNetNote').textContent = res.totalDays + ' total days (' + res.daughterDays + 'd Daughter, ' + res.sonDays + 'd Son)';
    el('statTax').textContent = '+ KES ' + fmt(res.additionalPay);
    el('statTaxNote').textContent = (ov.gross > 0) ? (fmt((res.additionalPay / ov.gross) * 100) + '% of invoice goes to tax & deductions') : 'PAYE + NSSF + SHA + Housing Levy';
    el('statGross').textContent = 'KES ' + fmt(ov.gross);
    el('statGrossNote').textContent = (res.totalDays > 0) ? ('Effective tax-inclusive rate: KES ' + fmt(res.effectiveDaily) + ' / day') : 'Total amount to bill on KRA invoice';

    var hasPrior = (res.priorPaid > 0 || res.manualAdj !== 0);
    el('statBalanceCard').style.display = hasPrior ? 'block' : 'none';
    el('statBalance').textContent = 'KES ' + fmt(res.balanceOwed);
    el('statBalanceNote').textContent = 'Gross ' + fmt(ov.gross) + ' minus Paid ' + fmt(res.priorPaid) + (res.manualAdj !== 0 ? (' (Adj: ' + fmt(res.manualAdj) + ')') : '');

    if (appState.supersedesId) {
      var delta = ov.gross - appState.previousGross;
      var sign = delta >= 0 ? '+' : '';
      el('correctionBannerText').textContent =
        'Fixing Past Entry ' + appState.supersedesId + ' | Old Invoice: KES ' + fmt(appState.previousGross) +
        ' \u2192 Corrected Invoice: KES ' + fmt(ov.gross) + ' (Difference: ' + sign + 'KES ' + fmt(delta) + ')';
    }
  }

  function getProofRows(res, p) {
    var ov = res.overall;
    var rows = [
      ['is-sub', 'Total Gross Invoice Amount', ov.gross, 'Pre-tax total on KRA invoice'],
      ['', 'Less: NSSF Contribution (Tier I + II)', -ov.nssf, fmt(p.nssfRate * 100) + '% up to KES ' + fmt(p.nssfCap) + '/mo (max KES ' + fmt(p.nssfMax) + '/mo)'],
      ['', 'Less: SHA / SHIF Health Insurance', -ov.shif, fmt(p.shifRate * 100) + '% of Gross (min KES ' + fmt(p.shifMin) + ')'],
      ['', 'Less: Affordable Housing Levy (AHL)', -ov.ahl, fmt(p.ahlRate * 100) + '% of Gross'],
      ['is-sub', 'Taxable Income (After Pre-Tax Deductions)', ov.taxable, 'Gross minus NSSF, SHA/SHIF, and Housing Levy'],
      ['', 'PAYE Band 1 (First KES 24,000 @ 10%)', ov.b1, '10% tax bracket'],
      ['', 'PAYE Band 2 (Next KES 8,333 @ 25%)', ov.b2, '25% tax bracket'],
      ['', 'PAYE Band 3 (32,334 – 500,000 @ 30%)', ov.b3, '30% tax bracket'],
      ['is-sub', 'Gross Income Tax', ov.grossTax, 'Total tax before Personal Relief'],
      ['', 'Less: Monthly Personal Relief', -ov.relief, 'KES ' + fmt(p.relief) + ' per tax period'],
      ['is-tax', 'Net PAYE Tax Payable to KRA', ov.paye, 'Gross Tax minus Personal Relief'],
      ['is-tax', 'Total Extra Needed for All Taxes & Deductions', ov.totalDed, 'NSSF + SHA/SHIF + Housing Levy + Net PAYE'],
      ['is-total', 'Money for Mom (Final Take-Home Pay)', ov.net, 'Exact net amount kept after all deductions']
    ];
    if (res.priorPaid > 0 || res.manualAdj !== 0) {
      rows.push(['', 'Less: Already Paid / Previously Billed', -res.priorPaid, 'Prior payment deducted']);
      if (res.manualAdj !== 0) rows.push(['', 'Plus/Minus: Manual Error Adjustment', res.manualAdj, esc(appState.correctionReason || 'Adjustment')]);
      rows.push(['is-tax', 'Remaining Corrective Balance Still Owed', res.balanceOwed, 'Net balance to collect now']);
    }
    return rows;
  }

  function renderProofTable(res, p) {
    var rows = getProofRows(res, p);
    el('proofTableBody').innerHTML = rows.map(function (r) {
      return '<tr class="' + r[0] + '"><td>' + r[1] + '</td><td class="num">KES ' + fmt(r[2]) + '</td><td>' + r[3] + '</td></tr>';
    }).join('');
  }

  function renderPlannerView(params) {
    var list = window.TaxEngine.computeDailyPlanner(appState.daughterRate, appState.sonRate, appState.maxDaysMonth, params);
    el('plannerDaysLabel').textContent = appState.maxDaysMonth;
    el('plannerCardsContainer').innerHTML = list.map(function (item) {
      return (
        '<div class="c-card">' +
          '<div class="ed-eyebrow">' + esc(item.title) + ' (' + item.days + ' Days/Month)</div>' +
          '<div class="c-stats" style="margin-bottom:0;margin-top:8px;">' +
            '<div class="c-stat">' +
              '<div class="c-stat-label">Current Net Daily Rate</div>' +
              '<div class="c-stat-value">KES ' + fmt(item.netDay) + '</div>' +
              '<div class="c-stat-note">Monthly Take-Home: KES ' + fmt(item.targetMonthNet) + '</div>' +
            '</div>' +
            '<div class="c-stat c-stat--invoice">' +
              '<div class="c-stat-label">New Tax-Inclusive Daily Rate</div>' +
              '<div class="c-stat-value">KES ' + fmt(item.revisedGrossDay) + ' / day</div>' +
              '<div class="c-stat-note">Adds +KES ' + fmt(item.dailyTopUp) + '/day for taxes</div>' +
            '</div>' +
            '<div class="c-stat c-stat--tax">' +
              '<div class="c-stat-label">Monthly Gross Invoice</div>' +
              '<div class="c-stat-value">KES ' + fmt(item.requiredMonthGross) + '</div>' +
              '<div class="c-stat-note">Includes +KES ' + fmt(item.monthlyTopUp) + ' total tax &amp; deductions</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  /* ── Presentable PDF / Print Statement Builder ─────────────────────────── */
  function renderPrintableStatement(res, p) {
    var ov = res.overall;
    var dateStr = new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' });
    var basisStr = (appState.billingMode === 'lump') ? 'Single Consolidated Lump-Sum Invoice' : 'Month-by-Month Taxed Schedule';
    var monthRowsHtml = res.months.map(function (m) {
      return (
        '<tr>' +
          '<td>' + esc(m.label) + '</td>' +
          '<td class="num">' + m.dDays + ' days @ KES ' + fmt(appState.daughterRate) + '</td>' +
          '<td class="num">' + m.sDays + ' days @ KES ' + fmt(appState.sonRate) + '</td>' +
          '<td class="num">' + m.totalDays + ' days</td>' +
          '<td class="num">KES ' + fmt(m.net) + '</td>' +
          '<td class="num">KES ' + fmt(m.gross) + '</td>' +
        '</tr>'
      );
    }).join('');

    var proofRowsHtml = getProofRows(res, p).map(function (r) {
      var boldCls = (r[0] === 'is-total' || r[0] === 'is-tax') ? 'is-bold' : '';
      return '<tr class="' + boldCls + '"><td>' + r[1] + '</td><td>' + r[3] + '</td><td class="num">KES ' + fmt(r[2]) + '</td></tr>';
    }).join('');

    el('printStatementSheet').innerHTML =
      '<div class="p-head">' +
        '<div>' +
          '<div class="p-eyebrow">Kenya 2026 Statutory Tax &amp; Gross-Up Statement</div>' +
          '<h1 class="p-title">Teaching Services Tax &amp; Invoice Breakdown</h1>' +
        '</div>' +
        '<div class="p-meta">' +
          '<div><strong>Date:</strong> ' + esc(dateStr) + '</div>' +
          '<div><strong>Basis:</strong> ' + esc(basisStr) + '</div>' +
          (appState.supersedesId ? '<div><strong>Supersedes:</strong> ' + esc(appState.supersedesId) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="p-summary-grid">' +
        '<div class="p-box">' +
          '<div class="p-box-label">1. Net Take-Home Pay</div>' +
          '<div class="p-box-val">KES ' + fmt(ov.net) + '</div>' +
        '</div>' +
        '<div class="p-box">' +
          '<div class="p-box-label">2. Total Tax &amp; Deductions</div>' +
          '<div class="p-box-val">+ KES ' + fmt(res.additionalPay) + '</div>' +
        '</div>' +
        '<div class="p-box p-box--strong">' +
          '<div class="p-box-label">3. Total Gross Invoice Due</div>' +
          '<div class="p-box-val">KES ' + fmt((res.priorPaid > 0 || res.manualAdj !== 0) ? res.balanceOwed : ov.gross) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="p-section-title">1. Monthly Teaching Schedule (' + res.totalDays + ' Total Days)</div>' +
      '<table class="p-table">' +
        '<thead><tr><th>Month</th><th class="num">Daughter</th><th class="num">Son</th><th class="num">Total Days</th><th class="num">Take-Home (KES)</th><th class="num">Gross Invoice (KES)</th></tr></thead>' +
        '<tbody>' + monthRowsHtml + '</tbody>' +
      '</table>' +
      '<div class="p-section-title">2. Itemized 2026 Kenya Statutory &amp; PAYE Tax Calculation</div>' +
      '<table class="p-table">' +
        '<thead><tr><th>Line Item</th><th>Statutory Basis (2026 Kenya Law)</th><th class="num">Amount (KES)</th></tr></thead>' +
        '<tbody>' + proofRowsHtml + '</tbody>' +
      '</table>' +
      '<div class="p-footer">' +
        '<span>Computed under 2026 KRA PAYE Bands, NSSF Year 4 (6% up to KES 108,000), SHA/SHIF (2.75%), and Affordable Housing Levy (1.5%).</span>' +
        '<span>Effective Gross Daily Rate: KES ' + fmt(res.effectiveDaily) + ' / day</span>' +
      '</div>';
  }

  /* ── Presentable CSV / Excel Export (UTF-8 BOM) ────────────────────────── */
  function exportCleanCsv() {
    if (!lastComputed) return;
    var r = lastComputed.result;
    var p = lastComputed.params;
    var ov = r.overall;
    var rows = [
      ['TEACHING SERVICES — KENYA 2026 TAX & INVOICE STATEMENT', '', '', '', '', ''],
      ['Generated Date', new Date().toLocaleString('en-KE'), 'Billing Basis', (appState.billingMode === 'lump' ? 'Single Lump-Sum Invoice' : 'Month-by-Month'), '', ''],
      ['Daughter Net Rate (KES/day)', appState.daughterRate.toFixed(2), 'Son Net Rate (KES/day)', appState.sonRate.toFixed(2), 'Total Working Days', r.totalDays],
      ['', '', '', '', '', ''],
      ['SECTION 1: HEADLINE SUMMARY', 'Amount (KES)', 'Notes', '', '', ''],
      ['1. Money for Mom (Final Take-Home Pay)', ov.net.toFixed(2), 'Exact net pay kept after all taxes & deductions', '', '', ''],
      ['2. Extra Needed for Taxes & Deductions', r.additionalPay.toFixed(2), 'PAYE + NSSF + SHA/SHIF + Housing Levy', '', '', ''],
      ['3. Total Gross Invoice Amount', ov.gross.toFixed(2), 'Effective Gross Daily Rate: KES ' + r.effectiveDaily.toFixed(2) + '/day', '', '', '']
    ];
    if (r.priorPaid > 0 || r.manualAdj !== 0) {
      rows.push(['4. Less Amount Already Paid', (-r.priorPaid).toFixed(2), appState.correctionReason || 'Prior payment', '', '', '']);
      rows.push(['5. Net Balance Still Owed Now', r.balanceOwed.toFixed(2), 'Remaining balance to invoice/collect', '', '', '']);
    }
    rows.push(['', '', '', '', '', '']);
    rows.push(['SECTION 2: MONTHLY TEACHING SCHEDULE', 'Daughter Days', 'Son Days', 'Total Days', 'Net Take-Home (KES)', 'Gross Invoice Share (KES)']);
    r.months.forEach(function (m) {
      rows.push([m.label, m.dDays, m.sDays, m.totalDays, m.net.toFixed(2), m.gross.toFixed(2)]);
    });
    rows.push(['TOTAL', r.daughterDays, r.sonDays, r.totalDays, ov.net.toFixed(2), ov.gross.toFixed(2)]);
    rows.push(['', '', '', '', '', '']);
    rows.push(['SECTION 3: ITEMIZED 2026 KENYA STATUTORY & PAYE BREAKDOWN', 'Amount (KES)', 'Statutory Rule / Basis', '', '', '']);
    getProofRows(r, p).forEach(function (pr) {
      rows.push([pr[1], pr[2].toFixed(2), pr[3], '', '', '']);
    });

    var csvContent = '\uFEFF' + rows.map(function (row) {
      return row.map(function (cell) { return '"' + String(cell).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');

    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Tax_Statement_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showFeedback('Exported clean Excel-ready statement (.CSV).', false);
  }

  /* ── Reset Days (Keeps Base Daily Rates & Tax Parameters) ──────────────── */
  function resetEnteredDays() {
    appState.months = [currentMonthRow()];
    appState.priorPaid = 0;
    appState.manualAdj = 0;
    appState.correctionReason = '';
    appState.supersedesId = '';
    appState.previousGross = 0;
    el('priorPaid').value = 0;
    el('manualAdj').value = 0;
    el('correctionReason').value = '';
    el('correctionBanner').classList.remove('is-visible');
    el('btnSaveCalc').textContent = 'Save to Google Sheet Ledger';
    renderMonthCards();
    recalculate();
    showFeedback('Cleared entered days and adjustments. Your daily rates and tax rules were kept.', false);
  }

  /* ── Persistent Google Sheet Ledger & History ──────────────────────────── */
  function updateSheetButton(sheetUrl) {
    if (!sheetUrl) return;
    activeSheetUrl = sheetUrl;
    var btn = el('btnOpenSheetTop');
    if (btn) {
      btn.href = sheetUrl;
      btn.style.display = 'inline-flex';
    }
  }

  function renderHistoryView() {
    var tbody = el('historyTableBody');
    if (!historyCache.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);">No saved calculations yet. Click "Save to Google Sheet Ledger" on the calculator tab to store your first record.</td></tr>';
      return;
    }
    tbody.innerHTML = historyCache.map(function (item, i) {
      var st = String(item.status || 'ACTIVE');
      var inactive = (st.indexOf('SUPERSEDED') === 0 || st.indexOf('VOIDED') === 0);
      var badge = inactive ? 'c-badge--old' : 'c-badge--active';
      var notes = [];
      if (item.supersedesId) notes.push('Fixed ' + item.supersedesId);
      if (item.correctionReason) notes.push(item.correctionReason);
      return (
        '<tr class="' + (inactive ? 'is-superseded' : '') + '">' +
          '<td><strong>' + esc(item.calcId) + '</strong><div class="c-hint">' + esc(item.timestamp) + '</div></td>' +
          '<td><span class="c-badge ' + badge + '">' + esc(st) + '</span></td>' +
          '<td class="num">' + Number(item.totalDays || 0) + ' days</td>' +
          '<td class="num">KES ' + fmt(item.targetNet) + '</td>' +
          '<td class="num"><strong>KES ' + fmt(item.gross) + '</strong></td>' +
          '<td>' + esc(notes.join(' — ') || 'Standard calculation') + '</td>' +
          '<td>' +
            '<div class="c-btn-row">' +
              '<button type="button" class="c-btn c-btn--ghost c-btn--sm" data-fix="' + i + '">Fix / Correct</button>' +
              (!inactive ? '<button type="button" class="c-btn c-btn--danger c-btn--sm" data-void="' + i + '">Void</button>' : '') +
            '</div>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
  }

  function buildHistoryRecord() {
    recalculate();
    var r = lastComputed.result;
    var ov = r.overall;
    var stamp = new Date();
    var id = 'CALC-' + stamp.toISOString().replace(/[-:T]/g, '').slice(2, 14);
    return {
      calcId: id,
      timestamp: stamp.toLocaleString('en-KE'),
      status: 'ACTIVE',
      supersedesId: appState.supersedesId || '',
      correctionReason: appState.correctionReason || '',
      calcMode: appState.calcMode,
      billingMode: appState.billingMode,
      monthCount: appState.months.length,
      daughterDays: r.daughterDays,
      daughterRate: appState.daughterRate,
      sonDays: r.sonDays,
      sonRate: appState.sonRate,
      totalDays: r.totalDays,
      targetNet: ov.net,
      gross: ov.gross,
      additionalPay: r.additionalPay,
      priorPaid: r.priorPaid,
      manualAdj: r.manualAdj,
      balanceOwed: r.balanceOwed,
      nssf: ov.nssf,
      shif: ov.shif,
      ahl: ov.ahl,
      taxable: ov.taxable,
      paye: ov.paye,
      net: ov.net,
      effectiveDaily: r.effectiveDaily,
      months: r.months,
      rawState: JSON.parse(JSON.stringify(appState))
    };
  }

  function fetchCloudHistory(silent) {
    if (typeof google !== 'undefined' && google.script && google.script.run) {
      google.script.run.withSuccessHandler(function (res) {
        if (res && res.ok) {
          historyCache = res.history || [];
          localStorage.setItem(STORAGE_KEYS.HISTORY_CACHE, JSON.stringify(historyCache));
          updateSheetButton(res.sheetUrl);
          renderHistoryView();
        }
      }).listSavedCalculations();
      return;
    }
    var url = getActiveWebhookUrl();
    if (!url) return;
    fetch(url + '?action=list', { method: 'GET', redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res && res.ok) {
          historyCache = res.history || [];
          localStorage.setItem(STORAGE_KEYS.HISTORY_CACHE, JSON.stringify(historyCache));
          updateSheetButton(res.sheetUrl);
          renderHistoryView();
          if (!silent) showFeedback('Synced persistent ledger from Google Sheets (' + historyCache.length + ' records).', false);
        }
      })
      .catch(function () {
        if (!silent) showFeedback('Could not reach Google Sheet endpoint; showing last cached ledger.', true);
      });
  }

  function saveCurrentCalculation() {
    var rec = buildHistoryRecord();
    if (rec.totalDays <= 0 && rec.gross <= 0) {
      showFeedback('Please enter at least 1 working day before saving.', true);
      return;
    }

    var btn = el('btnSaveCalc');
    var url = getActiveWebhookUrl();

    if (typeof google !== 'undefined' && google.script && google.script.run) {
      btn.disabled = true;
      btn.textContent = 'Saving to Google Sheet...';
      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          if (appState.supersedesId) exitCorrectionMode();
          historyCache = (res && res.history) ? res.history : historyCache;
          updateSheetButton(res && res.sheetUrl);
          renderHistoryView();
          showFeedback('Saved ' + rec.calcId + ' persistently to Google Sheet.', false);
        })
        .withFailureHandler(function (err) {
          btn.disabled = false;
          btn.textContent = 'Save to Google Sheet Ledger';
          showFeedback('Google Sheet save error: ' + err, true);
        })
        .saveCalculationToSheet(rec);
      return;
    }

    if (!url) {
      showFeedback('Google Sheet endpoint is not configured in Tab 4.', true);
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving to Google Sheet...';
    fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'save', payload: rec })
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        btn.disabled = false;
        btn.textContent = 'Save to Google Sheet Ledger';
        if (res && res.ok) {
          if (appState.supersedesId) exitCorrectionMode();
          historyCache = res.history || historyCache;
          localStorage.setItem(STORAGE_KEYS.HISTORY_CACHE, JSON.stringify(historyCache));
          updateSheetButton(res.sheetUrl);
          renderHistoryView();
          showFeedback('Saved ' + res.calcId + ' persistently to Google Sheets!', false);
        } else {
          showFeedback('Google Sheet returned an error: ' + (res && res.error ? res.error : 'Unknown'), true);
        }
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Save to Google Sheet Ledger';
        showFeedback('Network error while saving to Google Sheet: ' + err, true);
      });
  }

  function voidRecordInCloud(idx) {
    var item = historyCache[idx];
    if (!item) return;
    var url = getActiveWebhookUrl();
    item.status = 'VOIDED';
    renderHistoryView();
    if (url) {
      fetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'void', calcId: item.calcId, reason: 'Voided from web app' })
      })
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (res && res.history) {
            historyCache = res.history;
            localStorage.setItem(STORAGE_KEYS.HISTORY_CACHE, JSON.stringify(historyCache));
            renderHistoryView();
          }
          showFeedback('Marked ' + item.calcId + ' as VOIDED in Google Sheet.', false);
        })
        .catch(function () {});
    }
  }

  function loadRecordForCorrection(idx) {
    var item = historyCache[idx];
    if (!item) return;
    var rs = item.rawState || {};
    appState.calcMode = rs.calcMode || 'reverse';
    appState.billingMode = rs.billingMode || 'lump';
    appState.daughterRate = Number(rs.daughterRate || 3500);
    appState.sonRate = Number(rs.sonRate || 2500);
    appState.months = Array.isArray(rs.months) && rs.months.length ? JSON.parse(JSON.stringify(rs.months)) : [currentMonthRow()];
    appState.priorPaid = Number(item.gross || 0);
    appState.manualAdj = Number(rs.manualAdj || 0);
    appState.correctionReason = item.correctionReason || ('Fixing ' + item.calcId);
    appState.supersedesId = item.calcId;
    appState.previousGross = Number(item.gross || 0);

    el('daughterRate').value = appState.daughterRate;
    el('sonRate').value = appState.sonRate;
    el('billingMode').value = appState.billingMode;
    el('priorPaid').value = appState.priorPaid.toFixed(2);
    el('manualAdj').value = appState.manualAdj;
    el('correctionReason').value = appState.correctionReason;
    el('priorDetailsBox').open = true;
    el('correctionBanner').classList.add('is-visible');
    el('btnSaveCalc').textContent = 'Save Corrected Calculation (Replaces ' + item.calcId + ')';

    syncModeButtons();
    renderMonthCards();
    recalculate();
    navigateTo('calculator');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exitCorrectionMode() {
    appState.supersedesId = '';
    appState.previousGross = 0;
    el('correctionBanner').classList.remove('is-visible');
    el('btnSaveCalc').textContent = 'Save to Google Sheet Ledger';
    recalculate();
  }

  function showFeedback(msg, isErr) {
    var box = el('feedbackBanner');
    box.className = 'c-banner is-visible ' + (isErr ? 'c-banner--err' : 'c-banner--ok');
    box.textContent = msg;
  }

  function syncModeButtons() {
    el('modeBtnReverse').classList.toggle('is-selected', appState.calcMode === 'reverse');
    el('modeBtnForward').classList.toggle('is-selected', appState.calcMode === 'forward');
  }

  function copyWhatsAppSummary() {
    if (!lastComputed) return;
    var r = lastComputed.result;
    var ov = r.overall;
    var lines = [
      'KENYA TAX & INVOICE SUMMARY (2026)',
      appState.supersedesId ? ('Correction of ' + appState.supersedesId + ': ' + appState.correctionReason) : '',
      'Working Days: ' + r.totalDays + ' days (Daughter: ' + r.daughterDays + 'd @ KES ' + fmt(appState.daughterRate) + ', Son: ' + r.sonDays + 'd @ KES ' + fmt(appState.sonRate) + ')',
      '----------------------------------',
      '1. Money for Mom (Take-Home): KES ' + fmt(ov.net),
      '2. Extra for Taxes & Deductions: +KES ' + fmt(r.additionalPay),
      '   - PAYE Income Tax: KES ' + fmt(ov.paye),
      '   - SHA / SHIF (2.75%): KES ' + fmt(ov.shif),
      '   - NSSF (6%): KES ' + fmt(ov.nssf),
      '   - Housing Levy (1.5%): KES ' + fmt(ov.ahl),
      '3. TOTAL GROSS INVOICE: KES ' + fmt(ov.gross)
    ].filter(Boolean);
    if (r.priorPaid > 0 || r.manualAdj !== 0) {
      lines.push('Less Already Paid: -KES ' + fmt(r.priorPaid));
      if (r.manualAdj !== 0) lines.push('Adjustment: KES ' + fmt(r.manualAdj));
      lines.push('BALANCE STILL OWED: KES ' + fmt(r.balanceOwed));
    }
    navigator.clipboard.writeText(lines.join('\n')).then(function () {
      showFeedback('Copied summary! You can now paste it directly into WhatsApp.', false);
    }).catch(function () {
      showFeedback('Could not copy automatically on this browser.', true);
    });
  }

  /* ── Event Wiring ──────────────────────────────────────────────────────── */
  function bindEvents() {
    window.addEventListener('hashchange', syncRouteFromHash);
    ROUTES.forEach(function (r) {
      el('tab-' + r).addEventListener('click', function (e) {
        e.preventDefault();
        navigateTo(r);
      });
    });

    el('btnThemeToggle').addEventListener('click', toggleTheme);

    el('modeBtnReverse').addEventListener('click', function () {
      appState.calcMode = 'reverse';
      syncModeButtons();
      recalculate();
    });
    el('modeBtnForward').addEventListener('click', function () {
      appState.calcMode = 'forward';
      syncModeButtons();
      recalculate();
    });

    el('monthsContainer').addEventListener('click', function (e) {
      var stepBtn = e.target.closest('[data-step]');
      if (stepBtn) {
        var idx = Number(stepBtn.getAttribute('data-idx'));
        var field = stepBtn.getAttribute('data-field');
        var delta = Number(stepBtn.getAttribute('data-step'));
        if (appState.months[idx]) {
          appState.months[idx][field] = Math.max(0, Math.min(31, Number(appState.months[idx][field] || 0) + delta));
          renderMonthCards();
          recalculate();
        }
        return;
      }
      var remBtn = e.target.closest('[data-remove]');
      if (remBtn) {
        var rIdx = Number(remBtn.getAttribute('data-remove'));
        if (appState.months.length > 1) {
          appState.months.splice(rIdx, 1);
          renderMonthCards();
          recalculate();
        }
      }
    });

    el('monthsContainer').addEventListener('input', function (e) {
      var idx = Number(e.target.getAttribute('data-idx'));
      var field = e.target.getAttribute('data-field');
      if (!isNaN(idx) && field && appState.months[idx]) {
        appState.months[idx][field] = (field === 'month') ? e.target.value : Number(e.target.value || 0);
        recalculate();
      }
    });

    el('btnAddMonth').addEventListener('click', function () {
      var last = appState.months[appState.months.length - 1];
      appState.months.push(nextMonthRow(last));
      renderMonthCards();
      recalculate();
    });

    el('btnResetDays').addEventListener('click', resetEnteredDays);
    el('btnCancelCorrection').addEventListener('click', exitCorrectionMode);
    el('btnSaveCalc').addEventListener('click', saveCurrentCalculation);
    el('btnPrintPdf').addEventListener('click', function () {
      recalculate();
      window.print();
    });
    el('btnDownloadCsv').addEventListener('click', exportCleanCsv);
    el('btnCopyWhatsApp').addEventListener('click', copyWhatsAppSummary);
    el('btnRefreshHistory').addEventListener('click', function () { fetchCloudHistory(false); });

    el('historyTableBody').addEventListener('click', function (e) {
      var fixBtn = e.target.closest('[data-fix]');
      if (fixBtn) {
        loadRecordForCorrection(Number(fixBtn.getAttribute('data-fix')));
        return;
      }
      var voidBtn = e.target.closest('[data-void]');
      if (voidBtn) {
        voidRecordInCloud(Number(voidBtn.getAttribute('data-void')));
      }
    });

    el('btnSaveWebhook').addEventListener('click', function () {
      var url = el('webhookUrl').value.trim();
      localStorage.setItem(STORAGE_KEYS.WEBHOOK, url);
      showFeedback('Updated Google Sheet persistent endpoint.', false);
      fetchCloudHistory(false);
    });

    ['daughterRate', 'sonRate', 'maxDaysMonth', 'billingMode', 'priorPaid', 'manualAdj', 'correctionReason',
     'pNssfRate', 'pNssfCap', 'pShifRate', 'pShifMin', 'pAhlRate', 'pRelief'].forEach(function (id) {
      el(id).addEventListener('input', recalculate);
      el(id).addEventListener('change', recalculate);
    });
  }

  /* ── Boot ──────────────────────────────────────────────────────────────── */
  initThemeAndRates();
  try {
    historyCache = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY_CACHE) || '[]');
  } catch (e) {
    historyCache = [];
  }
  renderMonthCards();
  syncModeButtons();
  bindEvents();
  recalculate();
  renderHistoryView();
  syncRouteFromHash();
  fetchCloudHistory(true);
})();
