/* ═══════════════════════════════════════════════════════════════════════════
   app.js — UI Controller, Hash Router, Persistent Google Sheet Sync & Exports
            (Depends on window.TaxEngine from js/tax-engine.js)
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var DEFAULT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbzkhx1VIdOvVpoQ83s9KjxeArzkQ6Qa_jvXeriUHbJjVeCXBZooSQTJf6QMerNOt05GMQ/exec';

  var STORAGE_KEYS = {
    HISTORY_CACHE: 'mom_tax_cloud_cache_v4',
    RATES: 'mom_tax_base_rates_v4',
    WEBHOOK: 'mom_tax_sheet_webhook_v4',
    THEME: 'mom_tax_theme_v4'
  };

  var MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  var ROUTES = ['calculator', 'rates', 'history', 'settings'];

  function currentMonthRow() {
    var now = new Date();
    return { month: MONTH_NAMES[now.getMonth()], year: now.getFullYear(), dDays: 0, sDays: 0, legacy: false };
  }

  function nextMonthRow(lastRow) {
    if (!lastRow) return currentMonthRow();
    var idx = MONTH_NAMES.indexOf(lastRow.month);
    if (idx === -1 || idx === 11) {
      return { month: MONTH_NAMES[0], year: Number(lastRow.year || 2026) + 1, dDays: 0, sDays: 0, legacy: false };
    }
    return { month: MONTH_NAMES[idx + 1], year: Number(lastRow.year || 2026), dDays: 0, sDays: 0, legacy: false };
  }

  var appState = {
    calcMode: 'reverse',
    billingMode: 'lump',
    allocationMode: 'auto',
    invoiceCount: 1,
    splitMode: 'cutoff',
    splitCutoffIdx: 5,
    splitPercent: 50,
    stackLegacyInYear: false,
    otherPriorIncome: 0,
    expenses: 0,
    daughterRate: 3500,
    sonRate: 2000,
    maxDaysMonth: 20,
    priorPaid: 0,
    manualAdj: 0,
    correctionReason: '',
    supersedesId: '',
    previousGross: 0,
    includeNarrative: true,
    payments: [],
    months: [currentMonthRow()]
  };

  var lastComputed = null;
  var historyCache = [];
  var activeSheetUrl = '';

  function fmt(num) {
    return Number(num || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtKes(num) {
    var n = Number(num || 0);
    return (n < -0.004 ? '-KES ' : 'KES ') + fmt(Math.abs(n));
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
    el('payDate').value = new Date().toISOString().slice(0, 10);
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var next = (cur === 'dark') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(STORAGE_KEYS.THEME, next);
    el('btnThemeToggle').textContent = (next === 'dark') ? 'Light Mode' : 'Dark Mode';
  }

  function numInput(id, fallback) {
    var raw = el(id) ? el(id).value : '';
    return (raw !== '' && !isNaN(Number(raw))) ? Number(raw) : fallback;
  }

  function readTaxParams() {
    var nssfRate = Math.max(0, numInput('pNssfRate', 0)) / 100;
    var nssfCap = Math.max(0, numInput('pNssfCap', 108000));
    var annualRelief = Math.max(0, numInput('pRelief', 28800));
    return {
      nssfRate: nssfRate,
      nssfCap: nssfCap,
      nssfMax: nssfRate * nssfCap,
      shifRate: Math.max(0, numInput('pShifRate', 2.75)) / 100,
      shifMin: Math.max(0, numInput('pShifMin', 300)),
      ahlRate: Math.max(0, numInput('pAhlRate', 1.5)) / 100,
      annualRelief: annualRelief,
      monthlyRelief: annualRelief / 12,
      installmentThreshold: 40000
    };
  }

  /* ── Month Cards ───────────────────────────────────────────────────────── */
  function buildMonthOptions(selected) {
    return MONTH_NAMES.map(function (m) {
      return '<option value="' + m + '"' + (m === selected ? ' selected' : '') + '>' + m + '</option>';
    }).join('');
  }

  function syncSplitControlsUI() {
    var inv2 = (Number(appState.invoiceCount || 1) === 2);
    if (el('splitModeWrap')) el('splitModeWrap').style.display = inv2 ? 'flex' : 'none';
    if (el('splitDetailRow')) el('splitDetailRow').style.display = inv2 ? 'grid' : 'none';
    if (el('splitCutoffWrap')) el('splitCutoffWrap').style.display = (inv2 && appState.splitMode !== 'percent') ? 'flex' : 'none';
    if (el('splitPercentWrap')) el('splitPercentWrap').style.display = (inv2 && appState.splitMode === 'percent') ? 'flex' : 'none';

    var sel = el('splitCutoffIdx');
    if (sel) {
      var opts = appState.months.slice(0, Math.max(1, appState.months.length - 1)).map(function (m, i) {
        return '<option value="' + i + '">Through ' + esc(m.month + ' ' + (m.year || 2026)) + '</option>';
      }).join('');
      sel.innerHTML = opts || '<option value="0">First Month</option>';
      var maxIdx = Math.max(0, appState.months.length - 2);
      if (appState.splitCutoffIdx > maxIdx) appState.splitCutoffIdx = maxIdx;
      sel.value = String(appState.splitCutoffIdx);
    }
  }

  function renderMonthCards() {
    var canRemove = appState.months.length > 1;
    var isAuto = (appState.allocationMode !== 'manual');
    el('monthsContainer').innerHTML = appState.months.map(function (m, i) {
      var isLeg = Boolean(m.legacy);
      var basisControl = isAuto
        ? '<span class="c-badge c-badge--old" id="mAutoTag_' + i + '">Auto FIFO: Paid = Pre-Tax, Unpaid = eTIMS</span>'
        : ('<select class="c-input" data-idx="' + i + '" data-field="legacy" aria-label="Tax Basis">' +
            '<option value="taxed"' + (!isLeg ? ' selected' : '') + '>eTIMS Taxed (2026)</option>' +
            '<option value="legacy"' + (isLeg ? ' selected' : '') + '>Pre-Tax / Legacy (No Tax)</option>' +
          '</select>');
      return (
        '<div class="c-month-item' + (!isAuto && isLeg ? ' is-legacy' : '') + '" id="mCard_' + i + '">' +
          '<div class="c-month-top">' +
            '<div class="c-month-pickers">' +
              '<select class="c-input" data-idx="' + i + '" data-field="month" aria-label="Month">' + buildMonthOptions(m.month) + '</select>' +
              '<input type="number" class="c-input" style="max-width:96px;" data-idx="' + i + '" data-field="year" value="' + Number(m.year || 2026) + '" min="2024" max="2035" aria-label="Year">' +
              basisControl +
            '</div>' +
            (canRemove ? '<button type="button" class="c-btn c-btn--danger c-btn--sm" data-remove="' + i + '">Remove</button>' : '') +
          '</div>' +
          '<div class="c-month-grid">' +
            '<div class="c-field">' +
              '<label class="c-label">Child 1 Days Worked</label>' +
              '<div class="c-stepper">' +
                '<button type="button" class="c-step-btn" data-step="-1" data-idx="' + i + '" data-field="dDays" aria-label="Decrease Child 1 days">&minus;</button>' +
                '<input type="number" class="c-input" data-idx="' + i + '" data-field="dDays" value="' + Number(m.dDays || 0) + '" min="0" max="31" step="0.5">' +
                '<button type="button" class="c-step-btn" data-step="1" data-idx="' + i + '" data-field="dDays" aria-label="Increase Child 1 days">+</button>' +
              '</div>' +
            '</div>' +
            '<div class="c-field">' +
              '<label class="c-label">Child 2 Days Worked</label>' +
              '<div class="c-stepper">' +
                '<button type="button" class="c-step-btn" data-step="-1" data-idx="' + i + '" data-field="sDays" aria-label="Decrease Child 2 days">&minus;</button>' +
                '<input type="number" class="c-input" data-idx="' + i + '" data-field="sDays" value="' + Number(m.sDays || 0) + '" min="0" max="31" step="0.5">' +
                '<button type="button" class="c-step-btn" data-step="1" data-idx="' + i + '" data-field="sDays" aria-label="Increase Child 2 days">+</button>' +
              '</div>' +
            '</div>' +
            '<div class="c-month-summary" id="mSummary_' + i + '"></div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  /* ── Recorded Payments Log (Cumulative / Non-Month-Bound) ──────────────── */
  function renderPaymentsTable() {
    var wrap = el('paymentsTableWrap');
    var tbody = el('paymentsTableBody');
    if (!appState.payments.length) {
      wrap.style.display = 'none';
      tbody.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    var rowsHtml = appState.payments.map(function (pay, idx) {
      return (
        '<tr>' +
          '<td>' + esc(pay.date || '—') + '</td>' +
          '<td><strong>' + esc(pay.ref || '—') + '</strong></td>' +
          '<td>' + esc(pay.note || 'On-account transfer') + '</td>' +
          '<td class="num">KES ' + fmt(pay.amount) + '</td>' +
          '<td><button type="button" class="c-btn c-btn--danger c-btn--sm" data-del-pay="' + idx + '">Remove</button></td>' +
        '</tr>'
      );
    }).join('');
    var totalPaid = appState.payments.reduce(function (s, p) { return s + Number(p.amount || 0); }, 0);
    rowsHtml +=
      '<tr class="is-sub">' +
        '<td colspan="3"><strong>Total Recorded Payments Received (' + appState.payments.length + ')</strong></td>' +
        '<td class="num"><strong>KES ' + fmt(totalPaid) + '</strong></td>' +
        '<td></td>' +
      '</tr>';
    tbody.innerHTML = rowsHtml;
  }

  function addRecordedPayment() {
    var dateVal = el('payDate').value || new Date().toISOString().slice(0, 10);
    var refVal = el('payRef').value.trim();
    var amtVal = Number(el('payAmount').value || 0);
    var noteVal = el('payNote').value.trim();
    if (amtVal <= 0) {
      showFeedback('Please enter a payment amount greater than 0.', true);
      return;
    }
    appState.payments.push({
      date: dateVal,
      ref: refVal || 'Unreferenced Transfer',
      amount: amtVal,
      note: noteVal || 'On-account payment'
    });
    el('payRef').value = '';
    el('payAmount').value = '';
    el('payNote').value = '';
    renderPaymentsTable();
    recalculate();
  }

  /* ── Explanatory Narrative Builder ─────────────────────────────────────── */
  function formatMonthRange(labels) {
    if (!labels || !labels.length) return 'None';
    if (labels.length === 1) return labels[0];
    return labels[0] + ' – ' + labels[labels.length - 1];
  }

  function buildNarrativeParagraphs(res) {
    var ov = res.overall;
    var cr = res.childRates;
    var rMonths = res.reliefMonthsCount || 0;
    var rRange = formatMonthRange(res.reliefMonthLabels);
    var reliefNote = rMonths > 0
      ? (' Income tax bands and resident Personal Relief are time-apportioned across the ' + rMonths + ' eTIMS month(s) (' + rRange + '): KES ' + fmt(ov.relief) + ' of the KES 28,800 annual relief applied (' + res.remainingReliefMonths + ' months / KES ' + fmt(res.remainingAnnualRelief) + ' remaining for the rest of the year), starting from KES 0 prior income.')
      : '';
    var p1 =
      'Why the Invoice Amount Is Adjusted for Self-Assessment Taxes: Issuing a formal eTIMS invoice as an independent service provider creates a direct tax and statutory levy obligation under Kenyan law (Individual Self-Assessment IT1, not employer PAYE). ' +
      'To preserve the agreed net take-home daily rates of KES ' + fmt(appState.daughterRate) + '/day for Child 1 and KES ' + fmt(appState.sonRate) + '/day for Child 2 ' +
      '(net eTIMS-assessed fee of KES ' + fmt(ov.net) + ' across ' + res.taxedDays + ' taxable working days), the gross eTIMS invoice amount is KES ' + fmt(ov.gross) + '. ' +
      'This corresponds to an effective tax-inclusive daily rate of KES ' + fmt(cr.c1EffDay) + '/day for Child 1 and KES ' + fmt(cr.c2EffDay) + '/day for Child 2.' +
      (res.hasLegacyMonths ? (' Prior settled work totaling KES ' + fmt(res.legacyBaseTotal) + ' is historical and excluded from current tax calculations.') : '') +
      reliefNote;
    var parts = [
      'KRA Individual Income Tax (IT1) of KES ' + fmt(ov.incomeTax) + ' (after KES ' + fmt(ov.relief) + ' time-apportioned Personal Relief)',
      'SHA / SHIF Health Insurance at 2.75% (KES ' + fmt(ov.shif) + ')',
      'Affordable Housing Levy at 1.5% (KES ' + fmt(ov.ahl) + ')'
    ];
    if (ov.nssf > 0) parts.push('Voluntary NSSF contribution (KES ' + fmt(ov.nssf) + ')');
    var p2 =
      'Direct Statutory Remittance (Zero Additional Markup): The additional KES ' + fmt(res.additionalPay) + ' added above the net service fee is not retained as extra earnings. ' +
      'It funds the interim self-assessment remittances due under Kenyan law: ' + parts.join(', ') + '. ' +
      'Remitted proactively during the year so the final annual IT1 return (due 30 June) stays compliant with zero shortfall or reduction in take-home pay.';
    return [p1, p2];
  }

  /* ── Main Recalculate & Render ─────────────────────────────────────────── */
  function recalculate() {
    appState.daughterRate = Math.max(0, Number(el('daughterRate').value || 0));
    appState.sonRate = Math.max(0, Number(el('sonRate').value || 0));
    appState.maxDaysMonth = Math.max(1, Number(el('maxDaysMonth').value || 20));
    appState.billingMode = el('billingMode').value;
    if (el('allocationMode')) appState.allocationMode = el('allocationMode').value;
    if (el('invoiceCount')) appState.invoiceCount = Number(el('invoiceCount').value || 1);
    if (el('splitMode')) appState.splitMode = el('splitMode').value;
    if (el('splitCutoffIdx') && el('splitCutoffIdx').value !== '') appState.splitCutoffIdx = Number(el('splitCutoffIdx').value);
    if (el('splitPercent')) appState.splitPercent = Math.min(95, Math.max(5, Number(el('splitPercent').value || 50)));
    appState.stackLegacyInYear = (el('stackLegacyMode').value === 'stack');
    appState.otherPriorIncome = Math.max(0, Number(el('otherPriorIncome').value || 0));
    appState.expenses = Math.max(0, Number(el('etimsExpenses').value || 0));
    appState.priorPaid = Math.max(0, Number(el('priorPaid').value || 0));
    appState.manualAdj = Number(el('manualAdj').value || 0);
    appState.correctionReason = el('correctionReason').value.trim();
    appState.includeNarrative = Boolean(el('includeNarrative').checked);

    syncSplitControlsUI();

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
    renderSplitInvoices(res);
    renderProofTable(res, params);
    renderNarrativePreview(res);
    renderPlannerView(params);
    renderPrintableStatement(res, params);
  }

  function updateMonthSummaries(res) {
    res.months.forEach(function (m, i) {
      var box = el('mSummary_' + i);
      if (!box) return;
      var tag = m.partialPaid ? 'Partial Paid / eTIMS' : (m.legacy ? 'Paid Pre-Tax (0%)' : 'Unpaid (eTIMS)');
      var card = el('mCard_' + i);
      if (card) card.classList.toggle('is-legacy', m.legacy);
      var autoBadge = el('mAutoTag_' + i);
      if (autoBadge) {
        autoBadge.textContent = m.partialPaid
          ? ('Partial: KES ' + fmt(m.paidShare) + ' Paid · KES ' + fmt(m.unpaidNet) + ' eTIMS')
          : (m.legacy ? 'Paid (Pre-Tax 0%)' : 'Unpaid (eTIMS Taxed)');
        autoBadge.className = 'c-badge ' + (m.legacy ? 'c-badge--active' : 'c-badge--old');
      }
      var paidLine = m.partialPaid
        ? ('<div class="c-month-summary-line"><span>Paid / Unpaid Net:</span><strong>' + fmt(m.paidShare) + ' / ' + fmt(m.unpaidNet) + '</strong></div>')
        : '';
      var c1Line = m.dDays > 0 ? ('<div class="c-month-summary-line"><span>Child 1 Rate:</span><strong>KES ' + fmt(m.c1EffDay) + '/d</strong></div>') : '';
      var c2Line = m.sDays > 0 ? ('<div class="c-month-summary-line"><span>Child 2 Rate:</span><strong>KES ' + fmt(m.c2EffDay) + '/d</strong></div>') : '';
      box.innerHTML =
        '<div class="c-month-summary-line"><span>' + tag + ':</span><strong>KES ' + fmt(m.net) + ' net</strong></div>' +
        paidLine +
        '<div class="c-month-summary-line"><span>Total Billed:</span><strong>KES ' + fmt(m.gross) + '</strong></div>' +
        c1Line + c2Line;
    });
  }

  function renderSplitInvoices(res) {
    var wrap = el('splitInvoicesContainer');
    if (!wrap) return;
    if (!res.invoices || res.invoices.length < 2) {
      wrap.style.display = 'none';
      wrap.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    wrap.innerHTML =
      '<div style="font-weight:700;font-size:0.92rem;margin-bottom:8px;">Split eTIMS Invoices (2-Installment Client Option)</div>' +
      '<div class="c-split-grid">' +
        res.invoices.map(function (inv) {
          var r = inv.result;
          return (
            '<div class="c-split-card">' +
              '<div class="c-split-card-head">' +
                '<strong>' + esc(inv.title) + '</strong>' +
                '<span class="c-badge c-badge--old">' + esc(inv.periodLabel) + '</span>' +
              '</div>' +
              '<div class="c-stat-value" style="font-size:1.3rem;">KES ' + fmt(r.gross) + '</div>' +
              '<div class="c-split-card-meta">' +
                'Net Take-Home: <strong>KES ' + fmt(r.net) + '</strong> &bull; Total Tax/Levies: +KES ' + fmt(r.totalDed) + '<br>' +
                'IT1 Tax: KES ' + fmt(r.incomeTax) + ' (Relief: KES ' + fmt(r.relief) + ') &bull; SHIF: KES ' + fmt(r.shif) + ' &bull; AHL: KES ' + fmt(r.ahl) +
              '</div>' +
            '</div>'
          );
        }).join('') +
      '</div>';
  }

  function updateHeadlineCards(res) {
    var ov = res.overall;
    var cr = res.childRates;
    el('statNet').textContent = 'KES ' + fmt(res.combinedNet);
    el('statNetNote').textContent = res.hasLegacyMonths
      ? ('Legacy Pre-Tax: KES ' + fmt(res.legacyBaseTotal) + ' | eTIMS Net: KES ' + fmt(res.taxedNetTotal))
      : (res.totalDays + ' total days (' + res.daughterDays + 'd Child 1, ' + res.sonDays + 'd Child 2)');

    el('statTax').textContent = '+ KES ' + fmt(res.additionalPay);
    var taxBodies = ov.nssf > 0 ? 'KRA IT1/SHA/AHL/NSSF' : 'KRA IT1 / SHA / AHL';
    el('statTaxNote').textContent = (ov.gross > 0)
      ? (fmt((res.additionalPay / ov.gross) * 100) + '% of eTIMS invoice remitted to ' + taxBodies)
      : 'IT1 Income Tax + SHA/SHIF + Housing Levy';

    el('statGross').textContent = 'KES ' + fmt(res.hasLegacyMonths ? res.taxedGrossTotal : res.combinedGross);
    el('statGrossNote').textContent = res.hasLegacyMonths
      ? ('Combined Value (Legacy + eTIMS): KES ' + fmt(res.combinedGross))
      : ((res.taxedDays > 0) ? ('Combined gross average: KES ' + fmt(res.effectiveDaily) + ' / day') : 'Total pre-tax invoice amount');

    el('c1DaysBadge').textContent = (cr.c1Active ? ('Active eTIMS Rate') : (appState.maxDaysMonth + 'd Benchmark'));
    el('c1EffRateVal').textContent = 'KES ' + fmt(cr.c1EffDay) + ' / day';
    el('c1EffRateSub').textContent =
      'Base Net: KES ' + fmt(appState.daughterRate) + '/day (Tax add-on: +KES ' + fmt(cr.c1EffDay - appState.daughterRate) + '/day)' +
      (cr.c1Active ? (' | eTIMS Share: KES ' + fmt(cr.c1GrossTotal)) : '');

    el('c2DaysBadge').textContent = (cr.c2Active ? ('Active eTIMS Rate') : (appState.maxDaysMonth + 'd Benchmark'));
    el('c2EffRateVal').textContent = 'KES ' + fmt(cr.c2EffDay) + ' / day';
    el('c2EffRateSub').textContent =
      'Base Net: KES ' + fmt(appState.sonRate) + '/day (Tax add-on: +KES ' + fmt(cr.c2EffDay - appState.sonRate) + '/day)' +
      (cr.c2Active ? (' | eTIMS Share: KES ' + fmt(cr.c2GrossTotal)) : '');

    var showBal = (res.priorPaid > 0 || res.manualAdj !== 0 || res.hasLegacyMonths);
    var balCard = el('statBalanceCard');
    var balLabel = el('statBalanceLabel');
    var verdictBox = el('reconVerdictBox');
    balCard.style.display = showBal ? 'block' : 'none';
    balCard.className = 'c-stat';

    if (showBal) {
      var bal = res.balanceOwed;
      if (bal > 0.005) {
        balLabel.textContent = '4. OVERALL UNDERPAID (STILL OWED)';
        el('statBalance').textContent = 'KES ' + fmt(bal);
        balCard.classList.add('c-stat--tax');
      } else if (bal < -0.005) {
        balLabel.textContent = '4. OVERALL OVERPAID (CREDIT)';
        el('statBalance').textContent = 'KES ' + fmt(-bal);
        balCard.classList.add('c-stat--takehome');
      } else {
        balLabel.textContent = '4. ACCOUNT FULLY SETTLED';
        el('statBalance').textContent = 'KES 0.00';
        balCard.classList.add('c-stat--takehome');
      }
      el('statBalanceNote').textContent =
        'Total Billed KES ' + fmt(res.combinedGross) + ' minus Paid KES ' + fmt(res.priorPaid) +
        (res.manualAdj !== 0 ? (' (Adj: ' + fmt(res.manualAdj) + ')') : '');

      var zeroLeg = res.months.filter(function (m) { return m.legacy && m.totalDays === 0; }).map(function (m) { return m.label; });
      var vHtml = '';
      if (res.hasLegacyMonths) {
        var legText = res.legacyVariance > 0.005
          ? ('<strong>Historical Period Overpaid by KES ' + fmt(res.legacyVariance) + '</strong> (Paid KES ' + fmt(res.priorPaid) + ' vs Legacy Work KES ' + fmt(res.legacyBaseTotal) + (zeroLeg.length ? ('; awaiting days for: ' + esc(zeroLeg.join(', '))) : '') + ')')
          : (res.legacyVariance < -0.005
            ? ('<strong>Historical Period Underpaid by KES ' + fmt(-res.legacyVariance) + '</strong> (Legacy Work KES ' + fmt(res.legacyBaseTotal) + ' vs Paid KES ' + fmt(res.priorPaid) + ')')
            : ('<strong>Historical Period Settled</strong> (KES ' + fmt(res.legacyBaseTotal) + ')'));
        var taxText = ' | <strong>eTIMS Taxed Period Unpaid: KES ' + fmt(res.taxedGrossTotal) + '</strong>';
        var ovText = bal > 0.005
          ? ('Overall Verdict: <strong>UNDERPAID BY KES ' + fmt(bal) + '</strong>')
          : (bal < -0.005 ? ('Overall Verdict: <strong>OVERPAID BY KES ' + fmt(-bal) + '</strong>') : 'Overall Verdict: <strong>SETTLED (KES 0.00)</strong>');
        vHtml = '<div>' + ovText + '<div style="font-weight:500;font-size:0.84rem;margin-top:3px;">' + legText + taxText + '</div></div>';
      } else {
        var simpleVerdict = bal > 0.005
          ? ('Account Verdict: <strong>UNDERPAID BY KES ' + fmt(bal) + '</strong> (Gross KES ' + fmt(res.combinedGross) + ' minus Paid KES ' + fmt(res.priorPaid) + ')')
          : (bal < -0.005 ? ('Account Verdict: <strong>OVERPAID BY KES ' + fmt(-bal) + '</strong> (Paid KES ' + fmt(res.priorPaid) + ' vs Gross KES ' + fmt(res.combinedGross) + ')') : 'Account Verdict: <strong>FULLY SETTLED (KES 0.00)</strong>');
        vHtml = '<div>' + simpleVerdict + '</div>';
      }
      verdictBox.style.display = 'flex';
      verdictBox.className = 'c-banner is-visible ' + (bal > 0.005 ? 'c-banner--warn' : 'c-banner--ok');
      verdictBox.innerHTML = vHtml;
    } else {
      verdictBox.style.display = 'none';
      verdictBox.className = 'c-banner';
    }

    if (appState.supersedesId) {
      var delta = res.combinedGross - appState.previousGross;
      var sign = delta >= 0 ? '+' : '';
      el('correctionBannerText').textContent =
        'Revising Past Entry ' + appState.supersedesId + ' | Previous Gross: KES ' + fmt(appState.previousGross) +
        ' \u2192 Revised Gross: KES ' + fmt(res.combinedGross) + ' (Variance: ' + sign + 'KES ' + fmt(delta) + ')';
    }
  }

  function renderNarrativePreview(res) {
    var paras = buildNarrativeParagraphs(res);
    var box = el('narrativePreview');
    box.style.opacity = appState.includeNarrative ? '1' : '0.5';
    box.innerHTML = paras.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('');
  }

  function getProofRows(res, p) {
    var ov = res.overall;
    var isMonthly = (appState.billingMode === 'monthly');
    var mCount = Math.max(1, ov.monthsCount || res.reliefMonthsCount || 1);
    var c1Cap = 24000 * (isMonthly ? 1 : mCount);
    var c2Cap = (100000 / 12) * (isMonthly ? 1 : mCount);
    var c3Low = c1Cap + c2Cap;
    var c3High = 500000 * (isMonthly ? 1 : mCount);
    var c4High = 800000 * (isMonthly ? 1 : mCount);
    var periodTag = isMonthly ? '/mo' : (' for ' + mCount + ' mo');

    var rows = [
      ['is-sub', 'Gross eTIMS Invoice Amount (Taxed Period)', ov.gross, 'Pre-tax total on eTIMS invoice (' + res.taxedDays + ' taxed days across ' + res.reliefMonthsCount + ' mo)']
    ];
    if (ov.nssf > 0) {
      rows.push(['', 'Less: Voluntary NSSF Contribution', -ov.nssf, fmt(p.nssfRate * 100) + '% up to KES ' + fmt(p.nssfCap) + '/mo cap']);
    }
    rows.push(['', 'Less: SHA / SHIF Health Insurance', -ov.shif, fmt(p.shifRate * 100) + '% of Gross (min KES ' + fmt(p.shifMin) + '/mo; pre-tax deductible)']);
    rows.push(['', 'Less: Affordable Housing Levy (AHL)', -ov.ahl, fmt(p.ahlRate * 100) + '% of Gross (non-salaried levy; pre-tax deductible)']);
    if (ov.expenses > 0) {
      rows.push(['', 'Less: Allowable eTIMS Business Expenses', -ov.expenses, 'Valid eTIMS-backed business costs (ITA s.15)']);
    }
    rows.push(['is-sub', 'Chargeable Income — eTIMS Period', ov.taxable, 'Gross minus SHIF, AHL' + (ov.nssf > 0 ? ', NSSF' : '') + (ov.expenses > 0 ? ', and eTIMS expenses' : '')]);
    if (!isMonthly && ov.priorTaxable > 0) {
      rows.push(['', 'Plus: Prior Income Stacked on Return', ov.priorTaxable, 'Included earlier income stacked under brackets']);
      rows.push(['is-sub', 'Total Chargeable Income Assessed', ov.totalYearTaxable, 'Combined taxable income']);
    }
    rows.push(['', 'IT1 Band 1 (First KES ' + fmt(c1Cap) + periodTag + ' @ 10%)', ov.b1, '10% time-apportioned bracket (' + mCount + '/12 of KES 288k/yr)']);
    if (ov.b2 > 0) rows.push(['', 'IT1 Band 2 (Next KES ' + fmt(c2Cap) + periodTag + ' @ 25%)', ov.b2, '25% time-apportioned bracket (' + mCount + '/12 of KES 100k/yr)']);
    if (ov.b3 > 0) rows.push(['', 'IT1 Band 3 (' + fmt(c3Low + 1) + ' – ' + fmt(c3High) + periodTag + ' @ 30%)', ov.b3, '30% time-apportioned bracket']);
    if (ov.b4 > 0) rows.push(['', 'IT1 Band 4 (' + fmt(c3High + 1) + ' – ' + fmt(c4High) + periodTag + ' @ 32.5%)', ov.b4, '32.5% time-apportioned bracket']);
    if (ov.b5 > 0) rows.push(['', 'IT1 Band 5 (Above KES ' + fmt(c4High) + periodTag + ' @ 35%)', ov.b5, '35% time-apportioned bracket']);

    rows.push(['is-sub', 'Gross Individual Income Tax (Before Relief)', ov.grossTax, 'Tax before Personal Relief']);
    var reliefDesc = res.reliefMonthsCount > 0
      ? (res.reliefMonthsCount + ' mo applied (' + formatMonthRange(res.reliefMonthLabels) + ') @ KES ' + fmt(p.monthlyRelief) + '/mo; ' + res.remainingReliefMonths + ' mo / KES ' + fmt(res.remainingAnnualRelief) + ' remaining')
      : ('KES ' + fmt(p.monthlyRelief) + '/mo time-apportioned relief');
    rows.push(['', 'Less: Time-Apportioned Personal Relief', -ov.relief, reliefDesc]);
    rows.push(['is-tax', 'Net Individual Income Tax Payable to KRA (IT1)', ov.incomeTax, 'Interim self-assessment tax (final IT1 return due 30 June)']);
    rows.push(['is-tax', 'Total Statutory Tax & Levy Remittance', ov.totalDed, (ov.nssf > 0 ? 'Voluntary NSSF + ' : '') + 'SHA/SHIF + Housing Levy + Net IT1 Income Tax']);
    rows.push(['is-total', 'Net Service Fee — eTIMS Period (Take-Home)', ov.net, 'Agreed net fee retained for taxable months']);

    if (res.hasLegacyMonths) {
      rows.push(['is-sub', 'Plus: Historical Pre-Tax Work (Old System, 0% Tax)', res.legacyBaseTotal, res.legacyDays + ' legacy days (past period, excluded from current tax)']);
      rows.push(['is-sub', 'Total Combined Account Value (Legacy + eTIMS Gross)', res.combinedGross, 'Legacy Work + eTIMS Gross Invoice']);
    }
    if (res.priorPaid > 0 || res.manualAdj !== 0) {
      rows.push(['', 'Less: Cumulative Payments Received', -res.priorPaid, (appState.payments.length ? (appState.payments.length + ' recorded payment(s)') : 'Prior payments deducted')]);
      if (res.manualAdj !== 0) rows.push(['', 'Balance Adjustment', res.manualAdj, esc(appState.correctionReason || 'Adjustment')]);
      rows.push(['is-tax', 'Net Account Reconciliation Balance Due', res.balanceOwed, res.hasLegacyMonths ? ('Combined value minus payments (Legacy variance: ' + (res.legacyVariance >= 0 ? ('+KES ' + fmt(res.legacyVariance) + ' credit') : ('-KES ' + fmt(-res.legacyVariance) + ' unpaid')) + ')') : 'Remaining balance to settle']);
    }
    return rows;
  }

  function renderProofTable(res, p) {
    var rows = getProofRows(res, p);
    el('proofTableBody').innerHTML = rows.map(function (r) {
      return '<tr class="' + r[0] + '"><td>' + r[1] + '</td><td class="num">' + fmtKes(r[2]) + '</td><td>' + r[3] + '</td></tr>';
    }).join('');
    var instBox = el('installmentNoticeBox');
    if (instBox) {
      if (res.taxedDays > 0) {
        instBox.style.display = 'flex';
        if (res.installmentTaxTriggered) {
          instBox.className = 'c-banner is-visible c-banner--warn';
          instBox.innerHTML =
            '<div><strong>Relief Ledger &amp; Installment Tax Notice:</strong> ' +
            'Personal Relief applied for <strong>' + res.reliefMonthsCount + ' month(s)</strong> (' + esc(formatMonthRange(res.reliefMonthLabels)) + ') = <strong>KES ' + fmt(res.overall.relief) + '</strong> (' + res.remainingReliefMonths + ' mo / KES ' + fmt(res.remainingAnnualRelief) + ' remaining of KES 28,800/yr). ' +
            'IT1 tax (<strong>KES ' + fmt(res.overall.totalYearTax) + '</strong>) exceeds KES ' + fmt(p.installmentThreshold) + '/yr — KRA Installment Tax (4 &times; 25% on the 20th of months 4, 6, 9, 12) applies.</div>';
        } else {
          instBox.className = 'c-banner is-visible c-banner--ok';
          instBox.innerHTML =
            '<div><strong>Relief Ledger &amp; Interim Remittance Status:</strong> ' +
            'Personal Relief applied for <strong>' + res.reliefMonthsCount + ' month(s)</strong> (' + esc(formatMonthRange(res.reliefMonthLabels)) + ') = <strong>KES ' + fmt(res.overall.relief) + '</strong> (' + res.remainingReliefMonths + ' mo / KES ' + fmt(res.remainingAnnualRelief) + ' unapplied out of KES 28,800/yr). ' +
            'IT1 tax (<strong>KES ' + fmt(res.overall.totalYearTax) + '</strong>) is below KRA&apos;s KES ' + fmt(p.installmentThreshold) + '/yr Installment Tax threshold; remit SHIF/AHL &amp; interim tax via iTax/eCitizen and file annual IT1 by 30 June.</div>';
        }
      } else {
        instBox.style.display = 'none';
        instBox.className = 'c-banner';
      }
    }
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
              '<div class="c-stat-label">Base Net Daily Rate</div>' +
              '<div class="c-stat-value">KES ' + fmt(item.netDay) + '</div>' +
              '<div class="c-stat-note">Monthly Net Service Fee: KES ' + fmt(item.targetMonthNet) + '</div>' +
            '</div>' +
            '<div class="c-stat c-stat--invoice">' +
              '<div class="c-stat-label">Effective Tax-Inclusive Daily Rate</div>' +
              '<div class="c-stat-value">KES ' + fmt(item.revisedGrossDay) + ' / day</div>' +
              '<div class="c-stat-note">Includes +KES ' + fmt(item.dailyTopUp) + '/day for taxes</div>' +
            '</div>' +
            '<div class="c-stat c-stat--tax">' +
              '<div class="c-stat-label">Monthly Gross eTIMS Invoice</div>' +
              '<div class="c-stat-value">KES ' + fmt(item.requiredMonthGross) + '</div>' +
              '<div class="c-stat-note">Includes +KES ' + fmt(item.monthlyTopUp) + ' statutory remittances</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  /* ── Presentable PDF / Print Statement Builder ─────────────────────────── */
  function renderPrintableStatement(res, p) {
    var ov = res.overall;
    var cr = res.childRates;
    var dateStr = new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' });
    var basisStr = (appState.billingMode === 'lump')
      ? ('Time-Apportioned IT1 (' + res.reliefMonthsCount + ' mo: ' + formatMonthRange(res.reliefMonthLabels) + ')')
      : 'Month-by-Month IT1 Schedule';
    var monthRowsHtml = res.months.map(function (m) {
      var basisTxt = m.partialPaid
        ? ('Partial (' + fmt(m.paidShare) + ' Paid / ' + fmt(m.unpaidNet) + ' eTIMS)')
        : (m.legacy ? 'Paid Pre-Tax (0%)' : 'Unpaid (eTIMS)');
      return (
        '<tr>' +
          '<td>' + esc(m.label) + '</td>' +
          '<td>' + basisTxt + '</td>' +
          '<td class="num">' + m.dDays + 'd (' + fmt(m.c1EffDay || appState.daughterRate) + '/d)</td>' +
          '<td class="num">' + m.sDays + 'd (' + fmt(m.c2EffDay || appState.sonRate) + '/d)</td>' +
          '<td class="num">KES ' + fmt(m.net) + '</td>' +
          '<td class="num">KES ' + fmt(m.gross) + '</td>' +
        '</tr>'
      );
    }).join('');

    var splitPrintHtml = '';
    if (res.invoices && res.invoices.length > 1) {
      splitPrintHtml =
        '<div class="p-section-title">Split eTIMS Invoice Option (2 Installments)</div>' +
        '<div class="p-split-grid">' +
          res.invoices.map(function (inv) {
            var ir = inv.result;
            return (
              '<div class="p-box p-box--strong">' +
                '<div class="p-box-label">' + esc(inv.title) + ' &mdash; ' + esc(inv.periodLabel) + '</div>' +
                '<div class="p-box-val">KES ' + fmt(ir.gross) + '</div>' +
                '<div class="p-box-sub">Net: KES ' + fmt(ir.net) + ' | Tax+Levies: KES ' + fmt(ir.totalDed) + ' (IT1 ' + fmt(ir.incomeTax) + ', SHIF ' + fmt(ir.shif) + ', AHL ' + fmt(ir.ahl) + ')</div>' +
              '</div>'
            );
          }).join('') +
        '</div>';
    }

    var proofRowsHtml = getProofRows(res, p).map(function (r) {
      var boldCls = (r[0] === 'is-total' || r[0] === 'is-tax') ? 'is-bold' : (r[0] === 'is-sub' ? 'is-sub' : '');
      return '<tr class="' + boldCls + '"><td>' + r[1] + '</td><td>' + r[3] + '</td><td class="num">' + fmtKes(r[2]) + '</td></tr>';
    }).join('');

    var secNum = 3;
    var paymentsHtml = '';
    if (appState.payments.length > 0) {
      var payRows = appState.payments.map(function (pay) {
        return '<tr><td>' + esc(pay.date) + '</td><td><strong>' + esc(pay.ref) + '</strong></td><td>' + esc(pay.note || 'On-account transfer') + '</td><td class="num">KES ' + fmt(pay.amount) + '</td></tr>';
      }).join('');
      paymentsHtml =
        '<div class="p-section-title">' + secNum + '. Recorded Payments Received (Cumulative / On-Account)</div>' +
        '<table class="p-table">' +
          '<thead><tr><th>Date of Receipt</th><th>M-PESA / Bank Reference</th><th>Channel / Description</th><th class="num">Amount Received (KES)</th></tr></thead>' +
          '<tbody>' + payRows +
            '<tr class="is-bold"><td colspan="3">Total Recorded Payments Received (' + appState.payments.length + ' transactions)</td><td class="num">KES ' + fmt(res.recordedPaid) + '</td></tr>' +
          '</tbody>' +
        '</table>';
      secNum += 1;
    }

    var installmentHtml = '';
    if (res.taxedDays > 0) {
      var reliefLine = 'Personal Relief Applied: ' + res.reliefMonthsCount + ' of 12 months (' + esc(formatMonthRange(res.reliefMonthLabels)) + ') = KES ' + fmt(ov.relief) + ' (' + res.remainingReliefMonths + ' mo / KES ' + fmt(res.remainingAnnualRelief) + ' remaining of KES 28,800/yr). ';
      installmentHtml = res.installmentTaxTriggered
        ? ('<div class="p-compliance-note"><strong>Relief Ledger &amp; Installment Tax (ITA s.12):</strong> ' + reliefLine + 'IT1 tax (KES ' + fmt(ov.totalYearTax) + ') exceeds KES ' + fmt(p.installmentThreshold) + '/yr; 4 &times; 25% quarterly installments apply (20th of months 4, 6, 9, 12); annual IT1 due 30 June.</div>')
        : ('<div class="p-compliance-note p-compliance-note--info"><strong>Relief Ledger &amp; Interim Remittance:</strong> ' + reliefLine + 'IT1 tax (KES ' + fmt(ov.totalYearTax) + ') is under KRA&apos;s KES ' + fmt(p.installmentThreshold) + '/yr Installment Tax threshold; interim remittances tracked toward annual 30 June IT1 filing.</div>');
    }

    var narrativeHtml = '';
    if (appState.includeNarrative) {
      var paras = buildNarrativeParagraphs(res);
      narrativeHtml =
        '<div class="p-section-title">' + secNum + '. Explanatory Note on eTIMS Tax Gross-Up &amp; Self-Assessment Remittance</div>' +
        '<div class="p-narrative">' +
          paras.map(function (para) { return '<p>' + esc(para) + '</p>'; }).join('') +
        '</div>';
    }

    el('printStatementSheet').innerHTML =
      '<div class="p-head">' +
        '<div>' +
          '<div class="p-eyebrow">Kenya 2026 Individual Self-Assessment (IT1) &amp; eTIMS Statement</div>' +
          '<h1 class="p-title">Teaching Services &amp; Statutory Tax Statement</h1>' +
          '<div class="p-subtitle">Independent Service Provider (Non-PAYE) &bull; Reconciliation &amp; Tax Schedule</div>' +
        '</div>' +
        '<div class="p-meta">' +
          '<div><strong>Statement Date:</strong> ' + esc(dateStr) + '</div>' +
          '<div><strong>Tax Regime:</strong> KRA Individual IT1 (Non-PAYE)</div>' +
          '<div><strong>Basis:</strong> ' + esc(basisStr) + '</div>' +
          (appState.supersedesId ? '<div><strong>Revision of:</strong> ' + esc(appState.supersedesId) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="p-summary-grid">' +
        '<div class="p-box">' +
          '<div class="p-box-label">1. Net Service Fee (Take-Home)</div>' +
          '<div class="p-box-val">KES ' + fmt(res.combinedNet) + '</div>' +
          '<div class="p-box-sub">' + res.totalDays + ' days total (' + res.daughterDays + 'd Child 1, ' + res.sonDays + 'd Child 2)</div>' +
        '</div>' +
        '<div class="p-box">' +
          '<div class="p-box-label">2. Statutory Tax &amp; Levy Remittance</div>' +
          '<div class="p-box-val">+ KES ' + fmt(res.additionalPay) + '</div>' +
          '<div class="p-box-sub">eTIMS Invoice: KES ' + fmt(ov.gross) + ' (Taxed Days Only)</div>' +
        '</div>' +
        '<div class="p-box p-box--strong">' +
          '<div class="p-box-label">' + ((res.priorPaid > 0 || res.manualAdj !== 0) ? '3. Net Reconciliation Balance Due' : '3. Total Gross eTIMS Invoice') + '</div>' +
          '<div class="p-box-val">KES ' + fmt((res.priorPaid > 0 || res.manualAdj !== 0) ? res.balanceOwed : res.combinedGross) + '</div>' +
          '<div class="p-box-sub">Combined Value: KES ' + fmt(res.combinedGross) + (res.priorPaid > 0 ? (' | Paid: KES ' + fmt(res.priorPaid)) : '') + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="p-rate-grid">' +
        '<div class="p-box">' +
          '<div class="p-box-label">Child 1 Effective Tax-Inclusive Daily Rate</div>' +
          '<div class="p-box-val">KES ' + fmt(cr.c1EffDay) + ' / day</div>' +
          '<div class="p-box-sub">Base Take-Home: KES ' + fmt(appState.daughterRate) + '/day (+KES ' + fmt(cr.c1EffDay - appState.daughterRate) + '/day tax allocation)</div>' +
        '</div>' +
        '<div class="p-box">' +
          '<div class="p-box-label">Child 2 Effective Tax-Inclusive Daily Rate</div>' +
          '<div class="p-box-val">KES ' + fmt(cr.c2EffDay) + ' / day</div>' +
          '<div class="p-box-sub">Base Take-Home: KES ' + fmt(appState.sonRate) + '/day (+KES ' + fmt(cr.c2EffDay - appState.sonRate) + '/day tax allocation)</div>' +
        '</div>' +
      '</div>' +
      '<div class="p-section-title">1. Monthly Teaching Schedule (' + res.totalDays + ' Total Working Days)</div>' +
      '<table class="p-table">' +
        '<thead><tr><th>Month</th><th>Tax Basis</th><th class="num">Child 1</th><th class="num">Child 2</th><th class="num">Net Fee (KES)</th><th class="num">Gross Amount (KES)</th></tr></thead>' +
        '<tbody>' + monthRowsHtml + '</tbody>' +
      '</table>' +
      splitPrintHtml +
      '<div class="p-section-title">2. Itemized 2026 Kenya Individual Self-Assessment (IT1) Calculation</div>' +
      '<table class="p-table">' +
        '<thead><tr><th>Line Item</th><th>Statutory Basis (2026 Kenya Law)</th><th class="num">Amount (KES)</th></tr></thead>' +
        '<tbody>' + proofRowsHtml + '</tbody>' +
      '</table>' +
      installmentHtml +
      paymentsHtml +
      narrativeHtml +
      '<div class="p-footer">' +
        '<span>Computed under Kenya Income Tax Act (Cap 470, Resident IT1 Self-Assessment), SHA/SHIF (' + fmt(p.shifRate * 100) + '%), and AHL (' + fmt(p.ahlRate * 100) + '%)' + (ov.nssf > 0 ? (', Voluntary NSSF (' + fmt(p.nssfRate * 100) + '%)') : ', 0% NSSF') + '.</span>' +
        '<span>Child 1 Gross: KES ' + fmt(cr.c1EffDay) + '/d | Child 2 Gross: KES ' + fmt(cr.c2EffDay) + '/d</span>' +
      '</div>';
  }

  /* ── Presentable CSV / Excel Export (UTF-8 BOM) ────────────────────────── */
  function exportCleanCsv() {
    if (!lastComputed) return;
    var r = lastComputed.result;
    var p = lastComputed.params;
    var ov = r.overall;
    var cr = r.childRates;
    var rows = [
      ['TEACHING SERVICES — KENYA 2026 INDIVIDUAL SELF-ASSESSMENT (IT1) & eTIMS STATEMENT', '', '', '', '', ''],
      ['Generated Date', new Date().toLocaleString('en-KE'), 'Assessment Basis', (appState.billingMode === 'lump' ? 'Annual IT1 Self-Assessment (Lump-Sum)' : 'Month-by-Month IT1 Schedule'), '', ''],
      ['Child 1 Base Net Rate (KES/day)', appState.daughterRate.toFixed(2), 'Child 1 Effective Tax-Inclusive Rate (KES/day)', cr.c1EffDay.toFixed(2), 'Child 1 Days', r.daughterDays],
      ['Child 2 Base Net Rate (KES/day)', appState.sonRate.toFixed(2), 'Child 2 Effective Tax-Inclusive Rate (KES/day)', cr.c2EffDay.toFixed(2), 'Child 2 Days', r.sonDays],
      ['', '', '', '', '', ''],
      ['SECTION 1: HEADLINE SUMMARY', 'Amount (KES)', 'Notes', '', '', ''],
      ['1. Combined Net Service Fee (Legacy + eTIMS)', r.combinedNet.toFixed(2), 'Legacy Net: KES ' + r.legacyBaseTotal.toFixed(2) + ' | eTIMS Net: KES ' + ov.net.toFixed(2), '', '', ''],
      ['2. Statutory Tax & Levy Remittance (eTIMS Portion)', r.additionalPay.toFixed(2), 'KRA IT1 Income Tax + SHA/SHIF + Housing Levy on taxed months only', '', '', ''],
      ['3. eTIMS Gross Invoice (Taxed Months)', ov.gross.toFixed(2), 'Combined Account Value (Legacy + eTIMS): KES ' + r.combinedGross.toFixed(2), '', '', '']
    ];
    if (r.priorPaid > 0 || r.manualAdj !== 0) {
      rows.push(['4. Less Cumulative Payments Received', (-r.priorPaid).toFixed(2), appState.correctionReason || 'Recorded payments received', '', '', '']);
      rows.push(['5. Net Reconciliation Balance Due', r.balanceOwed.toFixed(2), 'Remaining balance to settle', '', '', '']);
    }
    rows.push(['', '', '', '', '', '']);
    rows.push(['SECTION 2: MONTHLY SCHEDULE', 'Tax Basis', 'Child 1 Days', 'Child 2 Days', 'Net Fee (KES)', 'Gross Amount (KES)']);
    r.months.forEach(function (m) {
      rows.push([m.label, (m.legacy ? 'Legacy (Non-Tax)' : 'eTIMS Taxed'), m.dDays, m.sDays, m.net.toFixed(2), m.gross.toFixed(2)]);
    });
    rows.push(['TOTAL', r.totalDays + ' days total', r.daughterDays, r.sonDays, r.combinedNet.toFixed(2), r.combinedGross.toFixed(2)]);
    rows.push(['', '', '', '', '', '']);
    rows.push(['SECTION 3: ITEMIZED 2026 KENYA INDIVIDUAL SELF-ASSESSMENT (IT1) BREAKDOWN', 'Amount (KES)', 'Statutory Rule / Basis', '', '', '']);
    getProofRows(r, p).forEach(function (pr) {
      rows.push([pr[1], pr[2].toFixed(2), pr[3], '', '', '']);
    });

    if (r.invoices && r.invoices.length > 1) {
      rows.push(['', '', '', '', '', '']);
      rows.push(['2-INVOICE SPLIT OPTION', 'Period / Share', 'Net Fee (KES)', 'IT1 + Levies (KES)', 'Gross Invoice (KES)', '']);
      r.invoices.forEach(function (inv) {
        rows.push([inv.title, inv.periodLabel, inv.result.net.toFixed(2), inv.result.totalDed.toFixed(2), inv.result.gross.toFixed(2), '']);
      });
    }
    if (appState.payments.length > 0) {
      rows.push(['', '', '', '', '', '']);
      rows.push(['SECTION 4: RECORDED PAYMENTS RECEIVED (CUMULATIVE)', 'Date Received', 'M-PESA / Bank Reference', 'Amount (KES)', 'Channel / Note', '']);
      appState.payments.forEach(function (pay) {
        rows.push(['Payment Receipt', pay.date, pay.ref, Number(pay.amount || 0).toFixed(2), pay.note || '', '']);
      });
    }

    if (appState.includeNarrative) {
      var paras = buildNarrativeParagraphs(r);
      rows.push(['', '', '', '', '', '']);
      rows.push(['EXPLANATORY NOTE ON eTIMS TAX GROSS-UP & STATUTORY REMITTANCE', '', '', '', '', '']);
      paras.forEach(function (para) {
        rows.push([para, '', '', '', '', '']);
      });
    }

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
    showFeedback('Exported professional Excel-ready statement (.CSV).', false);
  }

  /* ── Reset Days & Payments (Keeps Base Daily Rates & Tax Parameters) ───── */
  function resetEnteredDays() {
    appState.months = [currentMonthRow()];
    appState.payments = [];
    appState.otherPriorIncome = 0;
    appState.expenses = 0;
    appState.priorPaid = 0;
    appState.manualAdj = 0;
    appState.correctionReason = '';
    appState.supersedesId = '';
    appState.previousGross = 0;
    el('otherPriorIncome').value = 0;
    el('etimsExpenses').value = 0;
    el('priorPaid').value = 0;
    el('manualAdj').value = 0;
    el('correctionReason').value = '';
    el('correctionBanner').classList.remove('is-visible');
    el('btnSaveCalc').textContent = 'Save to Google Sheet Ledger';
    renderMonthCards();
    renderPaymentsTable();
    recalculate();
    showFeedback('Cleared entered days, payments, expenses, and adjustments. Base daily rates and tax rules were kept.', false);
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
      tbody.innerHTML = '<tr><td colspan="8" style="color:var(--text-muted);">No saved statements yet. Click "Save to Google Sheet Ledger" on Tab 1 to store your first record.</td></tr>';
      return;
    }
    tbody.innerHTML = historyCache.map(function (item, i) {
      var st = String(item.status || 'ACTIVE');
      var inactive = (st.indexOf('SUPERSEDED') === 0 || st.indexOf('VOIDED') === 0);
      var badge = inactive ? 'c-badge--old' : 'c-badge--active';
      var paid = Number(item.priorPaid || 0);
      var bal = Number(item.balanceOwed !== undefined ? item.balanceOwed : (Number(item.gross || 0) - paid));
      var balHtml = '<span class="c-badge c-badge--active">SETTLED</span>';
      if (bal > 0.005) {
        balHtml = '<span class="c-badge" style="background:var(--status-warning-bg);color:var(--status-warning);border:1px solid var(--status-warning-border);">UNDERPAID KES ' + fmt(bal) + '</span>';
      } else if (bal < -0.005) {
        balHtml = '<span class="c-badge c-badge--active">OVERPAID KES ' + fmt(-bal) + '</span>';
      }
      var notes = [];
      if (item.supersedesId) notes.push('Revised ' + item.supersedesId);
      if (item.correctionReason) notes.push(item.correctionReason);
      var rs = item.rawState || {};
      if (rs.reliefMonthsCount > 0) {
        notes.push('Relief: ' + rs.reliefMonthsCount + ' mo (' + formatMonthRange(rs.reliefMonthLabels) + ', KES ' + fmt(rs.reliefApplied || 0) + ')');
      }
      return (
        '<tr class="' + (inactive ? 'is-superseded' : '') + '">' +
          '<td><strong>' + esc(item.calcId) + '</strong><div class="c-hint">' + esc(item.timestamp) + '</div></td>' +
          '<td><span class="c-badge ' + badge + '">' + esc(st) + '</span></td>' +
          '<td class="num">' + Number(item.totalDays || 0) + ' days</td>' +
          '<td class="num"><strong>KES ' + fmt(item.gross) + '</strong><div class="c-hint">Net: ' + fmt(item.targetNet) + '</div></td>' +
          '<td class="num">KES ' + fmt(paid) + '</td>' +
          '<td class="num">' + balHtml + '</td>' +
          '<td>' + esc(notes.join(' — ') || 'Standard statement') + '</td>' +
          '<td>' +
            '<div class="c-btn-row">' +
              '<button type="button" class="c-btn c-btn--ghost c-btn--sm" data-fix="' + i + '">Load &amp; Revise</button>' +
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
    var stateSnapshot = JSON.parse(JSON.stringify(appState));
    stateSnapshot.reliefMonthsCount = r.reliefMonthsCount;
    stateSnapshot.reliefMonthLabels = r.reliefMonthLabels;
    stateSnapshot.reliefApplied = ov.relief;
    stateSnapshot.remainingReliefMonths = r.remainingReliefMonths;
    stateSnapshot.remainingAnnualRelief = r.remainingAnnualRelief;

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
      targetNet: r.combinedNet,
      gross: r.combinedGross,
      additionalPay: r.additionalPay,
      priorPaid: r.priorPaid,
      manualAdj: r.manualAdj,
      balanceOwed: r.balanceOwed,
      nssf: ov.nssf,
      shif: ov.shif,
      ahl: ov.ahl,
      taxable: ov.taxable,
      paye: ov.incomeTax,
      net: r.combinedNet,
      effectiveDaily: r.effectiveDaily,
      months: r.months,
      payments: appState.payments,
      rawState: stateSnapshot
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
    if (rec.totalDays <= 0 && rec.gross <= 0 && (!appState.payments || !appState.payments.length)) {
      showFeedback('Please enter working days or record a payment before saving.', true);
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
    appState.allocationMode = rs.allocationMode || 'auto';
    appState.invoiceCount = Number(rs.invoiceCount || 1);
    appState.splitMode = rs.splitMode || 'cutoff';
    appState.splitCutoffIdx = (rs.splitCutoffIdx !== undefined) ? Number(rs.splitCutoffIdx) : 5;
    appState.splitPercent = Number(rs.splitPercent || 50);
    appState.stackLegacyInYear = Boolean(rs.stackLegacyInYear);
    appState.otherPriorIncome = Number(rs.otherPriorIncome || 0);
    appState.expenses = Number(rs.expenses || 0);
    appState.daughterRate = Number(rs.daughterRate || 3500);
    appState.sonRate = Number(rs.sonRate || 2000);
    appState.months = Array.isArray(rs.months) && rs.months.length ? JSON.parse(JSON.stringify(rs.months)) : [currentMonthRow()];
    appState.payments = Array.isArray(rs.payments) ? JSON.parse(JSON.stringify(rs.payments)) : [];
    appState.priorPaid = Number(rs.priorPaid || 0);
    appState.manualAdj = Number(rs.manualAdj || 0);
    appState.correctionReason = item.correctionReason || ('Revision of ' + item.calcId);
    appState.supersedesId = item.calcId;
    appState.previousGross = Number(item.gross || 0);

    el('daughterRate').value = appState.daughterRate;
    el('sonRate').value = appState.sonRate;
    el('billingMode').value = appState.billingMode;
    if (el('allocationMode')) el('allocationMode').value = appState.allocationMode;
    if (el('invoiceCount')) el('invoiceCount').value = String(appState.invoiceCount);
    if (el('splitMode')) el('splitMode').value = appState.splitMode;
    if (el('splitPercent')) el('splitPercent').value = appState.splitPercent;
    el('stackLegacyMode').value = appState.stackLegacyInYear ? 'stack' : 'standalone';
    el('otherPriorIncome').value = appState.otherPriorIncome;
    el('etimsExpenses').value = appState.expenses;
    el('priorPaid').value = appState.priorPaid.toFixed(2);
    el('manualAdj').value = appState.manualAdj;
    el('correctionReason').value = appState.correctionReason;
    el('priorDetailsBox').open = true;
    el('correctionBanner').classList.add('is-visible');
    el('btnSaveCalc').textContent = 'Save Revised Statement (Replaces ' + item.calcId + ')';

    syncModeButtons();
    renderMonthCards();
    renderPaymentsTable();
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
    var cr = r.childRates;
    var lines = [
      'TEACHING SERVICES & KENYA SELF-ASSESSMENT (IT1) STATEMENT (2026)',
      appState.supersedesId ? ('Revision of ' + appState.supersedesId + ': ' + appState.correctionReason) : '',
      'Working Days: ' + r.totalDays + ' days (Child 1: ' + r.daughterDays + 'd | Child 2: ' + r.sonDays + 'd)',
      'Effective Tax-Inclusive Daily Rates (eTIMS):',
      ' - Child 1: KES ' + fmt(cr.c1EffDay) + '/day (Base Net: KES ' + fmt(appState.daughterRate) + '/day)',
      ' - Child 2: KES ' + fmt(cr.c2EffDay) + '/day (Base Net: KES ' + fmt(appState.sonRate) + '/day)',
      '----------------------------------',
      '1. Combined Net Service Fee: KES ' + fmt(r.combinedNet),
      r.hasLegacyMonths ? ('   - Legacy Pre-Tax Work (' + r.legacyDays + 'd): KES ' + fmt(r.legacyBaseTotal)) : '',
      r.hasLegacyMonths ? ('   - eTIMS Net Fee (' + r.taxedDays + 'd): KES ' + fmt(ov.net)) : '',
      '2. Statutory Tax & Levy Remittance (eTIMS): +KES ' + fmt(r.additionalPay),
      '   - KRA Income Tax (IT1): KES ' + fmt(ov.incomeTax) + ' (after KES ' + fmt(ov.relief) + ' relief for ' + r.reliefMonthsCount + ' mo: ' + formatMonthRange(r.reliefMonthLabels) + ')',
      '   - Remaining Annual Relief Allowance: ' + r.remainingReliefMonths + ' mo (KES ' + fmt(r.remainingAnnualRelief) + ')',
      '   - SHA / SHIF (2.75%): KES ' + fmt(ov.shif),
      '   - Housing Levy (1.5%): KES ' + fmt(ov.ahl),
      ov.nssf > 0 ? ('   - Voluntary NSSF: KES ' + fmt(ov.nssf)) : '',
      '3. eTIMS GROSS INVOICE AMOUNT: KES ' + fmt(ov.gross),
      r.hasLegacyMonths ? ('   Combined Account Value (Legacy + eTIMS): KES ' + fmt(r.combinedGross)) : ''
    ].filter(Boolean);

    if (r.invoices && r.invoices.length > 1) {
      lines.push('----------------------------------');
      lines.push('2-INVOICE SPLIT OPTION:');
      r.invoices.forEach(function (inv) {
        lines.push(' - ' + inv.title + ' (' + inv.periodLabel + '): KES ' + fmt(inv.result.gross) + ' gross (Net KES ' + fmt(inv.result.net) + ')');
      });
    }
    if (appState.payments.length > 0) {
      lines.push('----------------------------------');
      lines.push('RECORDED PAYMENTS RECEIVED (' + appState.payments.length + '):');
      appState.payments.forEach(function (pay) {
        lines.push(' - ' + pay.date + ' [' + pay.ref + ']: KES ' + fmt(pay.amount));
      });
    }
    if (r.priorPaid > 0 || r.manualAdj !== 0 || r.hasLegacyMonths) {
      lines.push('Total Payments Deducted: -KES ' + fmt(r.priorPaid));
      if (r.manualAdj !== 0) lines.push('Adjustment: KES ' + fmt(r.manualAdj));
      lines.push('NET RECONCILIATION BALANCE DUE: KES ' + fmt(r.balanceOwed));
    }
    if (appState.includeNarrative) {
      var paras = buildNarrativeParagraphs(r);
      lines.push('----------------------------------');
      lines.push('EXPLANATORY NOTE:');
      lines.push(paras[0]);
      lines.push(paras[1]);
    }
    navigator.clipboard.writeText(lines.join('\n')).then(function () {
      showFeedback('Copied statement summary! Ready to paste into WhatsApp.', false);
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

    function onMonthFieldChange(e) {
      var idx = Number(e.target.getAttribute('data-idx'));
      var field = e.target.getAttribute('data-field');
      if (!isNaN(idx) && field && appState.months[idx]) {
        if (field === 'month') {
          appState.months[idx].month = e.target.value;
        } else if (field === 'legacy') {
          appState.months[idx].legacy = (e.target.value === 'legacy');
          renderMonthCards();
        } else {
          appState.months[idx][field] = Number(e.target.value || 0);
        }
        recalculate();
      }
    }

    el('monthsContainer').addEventListener('input', onMonthFieldChange);
    el('monthsContainer').addEventListener('change', onMonthFieldChange);

    el('btnAddMonth').addEventListener('click', function () {
      var last = appState.months[appState.months.length - 1];
      appState.months.push(nextMonthRow(last));
      renderMonthCards();
      recalculate();
    });

    el('btnAddPayment').addEventListener('click', addRecordedPayment);
    el('paymentsTableBody').addEventListener('click', function (e) {
      var delBtn = e.target.closest('[data-del-pay]');
      if (delBtn) {
        var pIdx = Number(delBtn.getAttribute('data-del-pay'));
        appState.payments.splice(pIdx, 1);
        renderPaymentsTable();
        recalculate();
      }
    });

    el('includeNarrative').addEventListener('change', recalculate);
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

    if (el('allocationMode')) {
      el('allocationMode').addEventListener('change', function () {
        appState.allocationMode = el('allocationMode').value;
        renderMonthCards();
        recalculate();
      });
    }
    ['daughterRate', 'sonRate', 'maxDaysMonth', 'billingMode', 'invoiceCount', 'splitMode', 'splitCutoffIdx', 'splitPercent',
     'stackLegacyMode', 'otherPriorIncome', 'etimsExpenses',
     'priorPaid', 'manualAdj', 'correctionReason', 'pNssfRate', 'pNssfCap', 'pShifRate', 'pShifMin', 'pAhlRate', 'pRelief'].forEach(function (id) {
      if (!el(id)) return;
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
  renderPaymentsTable();
  syncModeButtons();
  bindEvents();
  recalculate();
  renderHistoryView();
  syncRouteFromHash();
  fetchCloudHistory(true);
})();
