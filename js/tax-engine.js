/* ═══════════════════════════════════════════════════════════════════════════
   tax-engine.js — Canonical 2026 Kenya Individual Self-Assessment (IT1) Engine
                   (Zero DOM dependencies; one implementation of all tax math)

   Basis:
     - Paid & received amounts = Pre-Tax (0% eTIMS gross-up) via chronological FIFO.
     - Unpaid balances across any month = eTIMS Taxed through KRA IT1.
     - Time-apportioned progressive IT1 bands & KES 28,800/yr Personal Relief
       (N/12 based on active unpaid eTIMS months), SHA/SHIF 2.75% pre-tax,
       Affordable Housing Levy 1.5% pre-tax, 0% default NSSF, optional expenses.
     - Supports issuing 1 consolidated eTIMS invoice or 2 split eTIMS invoices.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var DEFAULT_PARAMS = {
    nssfRate: 0,
    nssfCap: 108000,
    shifRate: 0.0275,
    shifMin: 300,
    ahlRate: 0.015,
    annualRelief: 28800,
    monthlyRelief: 2400,
    installmentThreshold: 40000
  };

  function emptyPeriod() {
    return {
      gross: 0, nssf: 0, shif: 0, ahl: 0, expenses: 0, preTaxDed: 0,
      taxable: 0, priorTaxable: 0, totalYearTaxable: 0,
      b1: 0, b2: 0, b3: 0, b4: 0, b5: 0,
      grossTax: 0, relief: 0, reliefCap: 0, monthsCount: 0,
      incomeTax: 0, totalYearTax: 0, totalDed: 0, net: 0
    };
  }

  function calcApportionedBands(taxable, monthsCount) {
    var t = Math.max(0, Number(taxable || 0));
    var scale = Math.max(0.1, Number(monthsCount || 12)) / 12;
    var c1 = 288000 * scale;
    var c2 = 388000 * scale;
    var c3 = 6000000 * scale;
    var c4 = 9600000 * scale;

    var b1 = Math.min(t, c1) * 0.10;
    var b2 = Math.max(0, Math.min(t, c2) - c1) * 0.25;
    var b3 = Math.max(0, Math.min(t, c3) - c2) * 0.30;
    var b4 = Math.max(0, Math.min(t, c4) - c3) * 0.325;
    var b5 = Math.max(0, t - c4) * 0.35;
    return { b1: b1, b2: b2, b3: b3, b4: b4, b5: b5, grossTax: b1 + b2 + b3 + b4 + b5 };
  }

  function calcForward(gross, params, opts) {
    var p = params || DEFAULT_PARAMS;
    var o = opts || {};
    var g = Math.max(0, Number(gross || 0));
    if (g <= 0) return emptyPeriod();

    var monthsCount = (o.period === 'monthly') ? 1 : Math.max(0.1, Number(o.monthsCount || 12));
    var priorTaxable = (o.period === 'monthly') ? 0 : Math.max(0, Number(o.priorTaxable || 0));
    var expenses = Math.max(0, Number(o.expenses || 0));

    var nssf = (p.nssfRate > 0) ? Math.min(g, p.nssfCap * monthsCount) * p.nssfRate : 0;
    var shif = (p.shifRate > 0) ? Math.max(p.shifMin * monthsCount, g * p.shifRate) : 0;
    var ahl = g * p.ahlRate;
    var preTaxDed = nssf + shif + ahl;
    var taxable = Math.max(0, g - preTaxDed - expenses);

    var annualRel = Number(p.annualRelief !== undefined ? p.annualRelief : 28800);
    var reliefCap = (annualRel / 12) * monthsCount;
    var totalYearTaxable = priorTaxable + taxable;
    var totalBands = calcApportionedBands(totalYearTaxable, monthsCount);
    var priorBands = calcApportionedBands(priorTaxable, monthsCount);

    var totalYearTax = Math.max(0, totalBands.grossTax - reliefCap);
    var priorNetTax = Math.max(0, priorBands.grossTax - reliefCap);
    var incomeTax = Math.max(0, totalYearTax - priorNetTax);

    var b1 = totalBands.b1 - priorBands.b1;
    var b2 = totalBands.b2 - priorBands.b2;
    var b3 = totalBands.b3 - priorBands.b3;
    var b4 = totalBands.b4 - priorBands.b4;
    var b5 = totalBands.b5 - priorBands.b5;
    var grossTax = totalBands.grossTax - priorBands.grossTax;
    var reliefUsed = Math.max(0, grossTax - incomeTax);

    var totalDed = preTaxDed + incomeTax;

    return {
      gross: g, nssf: nssf, shif: shif, ahl: ahl, expenses: expenses, preTaxDed: preTaxDed,
      taxable: taxable, priorTaxable: priorTaxable, totalYearTaxable: totalYearTaxable,
      b1: b1, b2: b2, b3: b3, b4: b4, b5: b5,
      grossTax: grossTax, relief: reliefUsed, reliefCap: reliefCap, monthsCount: monthsCount,
      incomeTax: incomeTax, totalYearTax: totalYearTax, totalDed: totalDed, net: g - totalDed
    };
  }

  function solveGrossFromNet(targetNet, params, opts) {
    var p = params || DEFAULT_PARAMS;
    var net = Math.max(0, Number(targetNet || 0));
    if (net <= 0) return emptyPeriod();

    var lo = net;
    var hi = Math.max(net * 2.2 + 5000, 20000);
    while (calcForward(hi, p, opts).net < net) { hi *= 2; }
    for (var i = 0; i < 64; i++) {
      var mid = (lo + hi) / 2;
      if (calcForward(mid, p, opts).net < net) { lo = mid; } else { hi = mid; }
    }
    return calcForward((lo + hi) / 2, p, opts);
  }

  function sumPeriods(list) {
    var acc = emptyPeriod();
    var keys = Object.keys(acc);
    for (var i = 0; i < list.length; i++) {
      for (var k = 0; k < keys.length; k++) {
        acc[keys[k]] += Number(list[i][keys[k]] || 0);
      }
    }
    return acc;
  }

  function computeChildRates(dRate, sRate, taxD, taxS, taxBase, taxedOverall, maxDays, calcMode, params) {
    var solveFn = (calcMode === 'forward') ? calcForward : solveGrossFromNet;
    var mult = (taxBase > 0) ? (taxedOverall.gross / taxBase) : 0;
    var mOpts = { period: 'monthly' };
    var dStand = solveFn(dRate * maxDays, params, mOpts).gross / maxDays;
    var sStand = solveFn(sRate * maxDays, params, mOpts).gross / maxDays;

    return {
      c1Active: taxD > 0,
      c2Active: taxS > 0,
      c1BaseTotal: taxD * dRate,
      c2BaseTotal: taxS * sRate,
      c1GrossTotal: taxD * dRate * mult,
      c2GrossTotal: taxS * sRate * mult,
      c1EffDay: (taxD > 0 && mult > 0) ? (dRate * mult) : dStand,
      c2EffDay: (taxS > 0 && mult > 0) ? (sRate * mult) : sStand,
      c1StandDay: dStand,
      c2StandDay: sStand
    };
  }

  function buildSplitInvoices(state, monthItems, taxedMonths, taxBase, taxedOverall, reliefMonthsCount, expenses, priorYearTaxable, params) {
    var invCount = Number(state.invoiceCount || 1) === 2 ? 2 : 1;
    var activeLabels = taxedMonths.map(function (m) { return m.label; });
    if (invCount === 1 || taxBase <= 0) {
      return [{
        number: 1,
        title: 'eTIMS Invoice 1 (Consolidated)',
        periodLabel: activeLabels.length ? (activeLabels[0] + (activeLabels.length > 1 ? (' – ' + activeLabels[activeLabels.length - 1]) : '')) : 'None',
        monthsCount: reliefMonthsCount,
        result: taxedOverall
      }];
    }

    var solveFn = (state.calcMode === 'forward') ? calcForward : solveGrossFromNet;
    var splitMode = (state.splitMode === 'percent') ? 'percent' : 'cutoff';
    var n1Base = 0, n2Base = 0, m1 = 0, m2 = 0, lbl1 = '', lbl2 = '';

    if (splitMode === 'percent') {
      var pct = Math.min(95, Math.max(5, Number(state.splitPercent || 50))) / 100;
      n1Base = taxBase * pct;
      n2Base = taxBase * (1 - pct);
      m1 = Math.max(0.1, reliefMonthsCount * pct);
      m2 = Math.max(0.1, reliefMonthsCount * (1 - pct));
      lbl1 = Math.round(pct * 100) + '% Tranche (' + (activeLabels.length ? (activeLabels[0] + ' – ' + activeLabels[activeLabels.length - 1]) : '') + ')';
      lbl2 = Math.round((1 - pct) * 100) + '% Tranche (' + (activeLabels.length ? (activeLabels[0] + ' – ' + activeLabels[activeLabels.length - 1]) : '') + ')';
    } else {
      var cutIdx = Number(state.splitCutoffIdx);
      if (isNaN(cutIdx) || cutIdx < 0 || cutIdx >= monthItems.length - 1) {
        cutIdx = Math.max(0, Math.floor(monthItems.length / 2) - 1);
      }
      var g1 = [], g2 = [];
      monthItems.forEach(function (item, idx) {
        if (item.unpaidNet > 0) {
          if (idx <= cutIdx) { n1Base += item.unpaidNet; g1.push(item.label); }
          else { n2Base += item.unpaidNet; g2.push(item.label); }
        }
      });
      if (n1Base <= 0 || n2Base <= 0) {
        // Fallback to 50/50 if cutoff puts everything on one side
        n1Base = taxBase * 0.5; n2Base = taxBase * 0.5;
        m1 = Math.max(0.1, reliefMonthsCount * 0.5); m2 = Math.max(0.1, reliefMonthsCount * 0.5);
        lbl1 = '50% Tranche 1'; lbl2 = '50% Tranche 2';
      } else {
        m1 = g1.length; m2 = g2.length;
        lbl1 = g1[0] + (g1.length > 1 ? (' – ' + g1[g1.length - 1]) : '');
        lbl2 = g2[0] + (g2.length > 1 ? (' – ' + g2[g2.length - 1]) : '');
      }
    }

    var exp1 = (taxBase > 0) ? expenses * (n1Base / taxBase) : 0;
    var exp2 = expenses - exp1;
    var r1 = solveFn(n1Base, params, { period: 'apportioned', monthsCount: m1, priorTaxable: priorYearTaxable, expenses: exp1 });
    var r2 = solveFn(n2Base, params, { period: 'apportioned', monthsCount: m2, priorTaxable: priorYearTaxable, expenses: exp2 });

    return [
      { number: 1, title: 'eTIMS Invoice 1', periodLabel: lbl1, monthsCount: m1, result: r1 },
      { number: 2, title: 'eTIMS Invoice 2', periodLabel: lbl2, monthsCount: m2, result: r2 }
    ];
  }

  function computeSchedule(state, params) {
    var p = params || DEFAULT_PARAMS;
    var dRate = Math.max(0, Number(state.daughterRate || 0));
    var sRate = Math.max(0, Number(state.sonRate || 0));
    var maxDays = Math.max(1, Number(state.maxDaysMonth || 20));
    var rows = Array.isArray(state.months) ? state.months : [];
    var isAutoFifo = (state.allocationMode !== 'manual');

    var payments = Array.isArray(state.payments) ? state.payments : [];
    var recordedPaid = payments.reduce(function (sum, pay) {
      return sum + Math.max(0, Number(pay.amount || 0));
    }, 0);
    var extraPrior = Math.max(0, Number(state.priorPaid || 0));
    var totalPriorPaid = recordedPaid + extraPrior;
    var fifoRemaining = totalPriorPaid;

    var totD = 0, totS = 0, totBase = 0;
    var taxD = 0, taxS = 0, taxBase = 0;
    var legD = 0, legS = 0, legBase = 0;

    var monthItems = rows.map(function (m) {
      var d = Math.max(0, Number(m.dDays || 0));
      var s = Math.max(0, Number(m.sDays || 0));
      var base = d * dRate + s * sRate;
      totD += d; totS += s; totBase += base;

      var paidShare = 0;
      var unpaidNet = 0;
      var isLegacy = Boolean(m.legacy);

      if (isAutoFifo) {
        paidShare = Math.min(base, fifoRemaining);
        unpaidNet = Math.max(0, base - paidShare);
        fifoRemaining = Math.max(0, fifoRemaining - paidShare);
        legBase += paidShare;
        taxBase += unpaidNet;
        if (base > 0) {
          var unpaidFrac = unpaidNet / base;
          taxD += d * unpaidFrac;
          taxS += s * unpaidFrac;
          legD += d * (1 - unpaidFrac);
          legS += s * (1 - unpaidFrac);
        }
        isLegacy = (unpaidNet <= 0.004);
      } else {
        if (isLegacy) {
          paidShare = base;
          unpaidNet = 0;
          legD += d; legS += s; legBase += base;
        } else {
          paidShare = 0;
          unpaidNet = base;
          taxD += d; taxS += s; taxBase += base;
        }
      }

      return {
        month: m.month, year: m.year, label: m.month + ' ' + m.year,
        legacy: isLegacy, partialPaid: (isAutoFifo && paidShare > 0.004 && unpaidNet > 0.004),
        dDays: d, sDays: s, totalDays: d + s,
        c1Base: d * dRate, c2Base: s * sRate, baseAmt: base,
        paidShare: paidShare, unpaidNet: unpaidNet,
        gross: base, totalDed: 0, net: base,
        c1EffDay: (isLegacy && d > 0) ? dRate : 0,
        c2EffDay: (isLegacy && s > 0) ? sRate : 0
      };
    });

    var solveFn = (state.calcMode === 'forward') ? calcForward : solveGrossFromNet;
    var taxedMonths = monthItems.filter(function (item) { return item.unpaidNet > 0.004; });
    var reliefMonthsList = taxedMonths;
    var reliefMonthsCount = reliefMonthsList.length;
    var expenses = Math.max(0, Number(state.expenses || 0));
    var stackLegacy = Boolean(state.stackLegacyInYear);
    var otherPrior = Math.max(0, Number(state.otherPriorIncome || 0));
    var priorYearTaxable = (stackLegacy ? legBase : 0) + otherPrior;
    var taxedOverall;

    if (state.billingMode === 'monthly') {
      var perMonthExp = reliefMonthsCount > 0 ? (expenses / reliefMonthsCount) : 0;
      var perMonth = monthItems.map(function (item) {
        if (item.unpaidNet <= 0.004) return emptyPeriod();
        var r = solveFn(item.unpaidNet, p, { period: 'monthly', expenses: perMonthExp });
        item.gross = item.paidShare + r.gross;
        item.totalDed = r.totalDed;
        item.net = item.paidShare + r.net;
        var uMult = (item.unpaidNet > 0) ? (r.gross / item.unpaidNet) : 1;
        item.c1EffDay = (item.dDays > 0) ? (dRate * uMult) : 0;
        item.c2EffDay = (item.sDays > 0) ? (sRate * uMult) : 0;
        return r;
      });
      taxedOverall = sumPeriods(perMonth);
    } else {
      taxedOverall = solveFn(taxBase, p, {
        period: 'apportioned',
        monthsCount: Math.max(1, reliefMonthsCount),
        priorTaxable: priorYearTaxable,
        expenses: expenses
      });
      var lMult = (taxBase > 0) ? (taxedOverall.gross / taxBase) : 1;
      monthItems.forEach(function (item) {
        if (item.unpaidNet <= 0.004) return;
        var share = (taxBase > 0) ? (item.unpaidNet / taxBase) : 0;
        var eGross = taxedOverall.gross * share;
        var eDed = taxedOverall.totalDed * share;
        var eNet = taxedOverall.net * share;
        item.gross = item.paidShare + eGross;
        item.totalDed = eDed;
        item.net = item.paidShare + eNet;
        item.c1EffDay = (item.dDays > 0) ? (dRate * lMult) : 0;
        item.c2EffDay = (item.sDays > 0) ? (sRate * lMult) : 0;
      });
    }

    var invoices = buildSplitInvoices(state, monthItems, taxedMonths, taxBase, taxedOverall, reliefMonthsCount, expenses, priorYearTaxable, p);
    var combinedNet = legBase + taxedOverall.net;
    var combinedGross = legBase + taxedOverall.gross;
    var additionalPay = taxedOverall.gross - taxedOverall.net;
    var totDays = totD + totS;
    var taxDays = taxD + taxS;
    var legDays = legD + legS;
    var annualRelief = Number(p.annualRelief !== undefined ? p.annualRelief : 28800);
    var manualAdj = Number(state.manualAdj || 0);
    var childRates = computeChildRates(dRate, sRate, taxD, taxS, taxBase, taxedOverall, maxDays, state.calcMode, p);

    return {
      overall: taxedOverall,
      invoices: invoices,
      isAutoFifo: isAutoFifo,
      overpaidPool: fifoRemaining,
      combinedNet: combinedNet,
      combinedGross: combinedGross,
      legacyDays: legDays,
      legacyBaseTotal: legBase,
      priorYearTaxable: priorYearTaxable,
      reliefMonthsCount: (taxBase > 0) ? reliefMonthsCount : 0,
      reliefMonthLabels: (taxBase > 0) ? reliefMonthsList.map(function (m) { return m.label; }) : [],
      remainingReliefMonths: Math.max(0, 12 - ((taxBase > 0) ? reliefMonthsCount : 0)),
      remainingAnnualRelief: Math.max(0, annualRelief - taxedOverall.relief),
      taxedDays: taxDays,
      taxedNetTotal: taxedOverall.net,
      taxedGrossTotal: taxedOverall.gross,
      months: monthItems,
      hasLegacyMonths: legBase > 0.004,
      childRates: childRates,
      daughterDays: totD,
      sonDays: totS,
      totalDays: totDays,
      baseTotal: totBase,
      additionalPay: additionalPay,
      effectiveDaily: (taxDays > 0) ? (taxedOverall.gross / taxDays) : 0,
      recordedPaid: recordedPaid,
      extraPriorPaid: extraPrior,
      priorPaid: totalPriorPaid,
      manualAdj: manualAdj,
      legacyVariance: totalPriorPaid - legBase,
      balanceOwed: combinedGross - totalPriorPaid + manualAdj,
      installmentTaxTriggered: taxedOverall.totalYearTax > Number(p.installmentThreshold || 40000)
    };
  }

  function computeDailyPlanner(dRate, sRate, maxDays, params) {
    var days = Math.max(1, Number(maxDays || 20));
    var cases = [
      { id: 'child1', title: 'Child 1 Only', netDay: dRate },
      { id: 'child2', title: 'Child 2 Only', netDay: sRate },
      { id: 'both', title: 'Both Children (Child 1 + Child 2)', netDay: dRate + sRate }
    ];
    return cases.map(function (c) {
      var targetMo = c.netDay * days;
      var solved = solveGrossFromNet(targetMo, params, { period: 'monthly' });
      return {
        id: c.id,
        title: c.title,
        days: days,
        netDay: c.netDay,
        targetMonthNet: targetMo,
        requiredMonthGross: solved.gross,
        monthlyTopUp: solved.gross - targetMo,
        revisedGrossDay: solved.gross / days,
        dailyTopUp: (solved.gross / days) - c.netDay
      };
    });
  }

  root.TaxEngine = {
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    calcForward: calcForward,
    solveGrossFromNet: solveGrossFromNet,
    sumPeriods: sumPeriods,
    computeSchedule: computeSchedule,
    computeDailyPlanner: computeDailyPlanner
  };
})(typeof window !== 'undefined' ? window : globalThis);
