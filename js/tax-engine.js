/* ═══════════════════════════════════════════════════════════════════════════
   tax-engine.js — Canonical 2026 Kenya Individual Self-Assessment (IT1) Engine
                   (Zero DOM dependencies; one implementation of all tax math)

   Basis: KRA Individual Income Tax (Cap 470, Resident IT1 Self-Assessment),
          Social Health Insurance Act (SHIF 2.75%), Affordable Housing Act 2024
          (AHL 1.5% for non-salaried individuals), Tax Laws (Amendment) Act 2024
          (SHIF & AHL deductible pre-tax), NSSF voluntary (0% default).
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
      grossTax: 0, relief: 0, incomeTax: 0, totalYearTax: 0,
      totalDed: 0, net: 0
    };
  }

  function calcProgressiveBands(taxable, period) {
    var t = Math.max(0, Number(taxable || 0));
    var caps = (period === 'monthly')
      ? [24000, 32333, 500000, 800000]
      : [288000, 388000, 6000000, 9600000];

    var b1 = Math.min(t, caps[0]) * 0.10;
    var b2 = Math.max(0, Math.min(t, caps[1]) - caps[0]) * 0.25;
    var b3 = Math.max(0, Math.min(t, caps[2]) - caps[1]) * 0.30;
    var b4 = Math.max(0, Math.min(t, caps[3]) - caps[2]) * 0.325;
    var b5 = Math.max(0, t - caps[3]) * 0.35;
    return { b1: b1, b2: b2, b3: b3, b4: b4, b5: b5, grossTax: b1 + b2 + b3 + b4 + b5 };
  }

  function calcForward(gross, params, opts) {
    var p = params || DEFAULT_PARAMS;
    var o = opts || {};
    var period = (o.period === 'monthly') ? 'monthly' : 'annual';
    var g = Math.max(0, Number(gross || 0));
    if (g <= 0) return emptyPeriod();

    var monthScale = (period === 'monthly') ? 1 : 12;
    var shifMonths = (period === 'monthly') ? 1 : Math.max(1, Number(o.shifMonths || 12));
    var priorTaxable = (period === 'monthly') ? 0 : Math.max(0, Number(o.priorTaxable || 0));
    var expenses = Math.max(0, Number(o.expenses || 0));

    var nssf = (p.nssfRate > 0) ? Math.min(g, p.nssfCap * monthScale) * p.nssfRate : 0;
    var shif = (p.shifRate > 0) ? Math.max(p.shifMin * shifMonths, g * p.shifRate) : 0;
    var ahl = g * p.ahlRate;
    var preTaxDed = nssf + shif + ahl;
    var taxable = Math.max(0, g - preTaxDed - expenses);

    var reliefCap = (period === 'monthly') ? Number(p.monthlyRelief || 2400) : Number(p.annualRelief || 28800);
    var totalYearTaxable = priorTaxable + taxable;
    var totalBands = calcProgressiveBands(totalYearTaxable, period);
    var priorBands = calcProgressiveBands(priorTaxable, period);

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
      grossTax: grossTax, relief: reliefUsed, incomeTax: incomeTax, totalYearTax: totalYearTax,
      totalDed: totalDed, net: g - totalDed
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

  function computeSchedule(state, params) {
    var p = params || DEFAULT_PARAMS;
    var dRate = Math.max(0, Number(state.daughterRate || 0));
    var sRate = Math.max(0, Number(state.sonRate || 0));
    var maxDays = Math.max(1, Number(state.maxDaysMonth || 20));
    var rows = Array.isArray(state.months) ? state.months : [];

    var totD = 0, totS = 0, totBase = 0;
    var taxD = 0, taxS = 0, taxBase = 0;
    var legD = 0, legS = 0, legBase = 0;

    var monthItems = rows.map(function (m) {
      var d = Math.max(0, Number(m.dDays || 0));
      var s = Math.max(0, Number(m.sDays || 0));
      var legacy = Boolean(m.legacy);
      var base = d * dRate + s * sRate;
      totD += d; totS += s; totBase += base;
      if (legacy) {
        legD += d; legS += s; legBase += base;
      } else {
        taxD += d; taxS += s; taxBase += base;
      }
      return {
        month: m.month, year: m.year, label: m.month + ' ' + m.year,
        legacy: legacy, dDays: d, sDays: s, totalDays: d + s,
        c1Base: d * dRate, c2Base: s * sRate, baseAmt: base,
        gross: base, totalDed: 0, net: base,
        c1EffDay: legacy && d > 0 ? dRate : 0,
        c2EffDay: legacy && s > 0 ? sRate : 0
      };
    });

    var solveFn = (state.calcMode === 'forward') ? calcForward : solveGrossFromNet;
    var taxedMonths = monthItems.filter(function (item) { return !item.legacy; });
    var expenses = Math.max(0, Number(state.expenses || 0));
    var stackLegacy = (state.stackLegacyInYear !== false);
    var otherPrior = Math.max(0, Number(state.otherPriorIncome || 0));
    var priorYearTaxable = (stackLegacy ? legBase : 0) + otherPrior;
    var taxedOverall;

    if (state.billingMode === 'monthly') {
      var perMonthExp = taxedMonths.length > 0 ? (expenses / taxedMonths.length) : 0;
      var perMonth = taxedMonths.map(function (item) {
        var r = solveFn(item.baseAmt, p, { period: 'monthly', expenses: perMonthExp });
        var mMult = (item.baseAmt > 0) ? (r.gross / item.baseAmt) : 0;
        item.gross = r.gross; item.totalDed = r.totalDed; item.net = r.net;
        item.c1EffDay = (item.dDays > 0) ? (dRate * mMult) : 0;
        item.c2EffDay = (item.sDays > 0) ? (sRate * mMult) : 0;
        return r;
      });
      taxedOverall = sumPeriods(perMonth);
    } else {
      var activeMonthsCount = Math.max(1, taxedMonths.filter(function (m) { return m.totalDays > 0; }).length || taxedMonths.length);
      taxedOverall = solveFn(taxBase, p, {
        period: 'annual',
        priorTaxable: priorYearTaxable,
        expenses: expenses,
        shifMonths: activeMonthsCount
      });
      var lMult = (taxBase > 0) ? (taxedOverall.gross / taxBase) : 0;
      taxedMonths.forEach(function (item) {
        var share = (taxBase > 0) ? (item.baseAmt / taxBase) : 0;
        item.gross = taxedOverall.gross * share;
        item.totalDed = taxedOverall.totalDed * share;
        item.net = taxedOverall.net * share;
        item.c1EffDay = (item.dDays > 0) ? (dRate * lMult) : 0;
        item.c2EffDay = (item.sDays > 0) ? (sRate * lMult) : 0;
      });
    }

    var combinedNet = legBase + taxedOverall.net;
    var combinedGross = legBase + taxedOverall.gross;
    var additionalPay = taxedOverall.gross - taxedOverall.net;
    var totDays = totD + totS;
    var taxDays = taxD + taxS;
    var legDays = legD + legS;

    var payments = Array.isArray(state.payments) ? state.payments : [];
    var recordedPaid = payments.reduce(function (sum, pay) {
      return sum + Math.max(0, Number(pay.amount || 0));
    }, 0);
    var extraPrior = Math.max(0, Number(state.priorPaid || 0));
    var totalPriorPaid = recordedPaid + extraPrior;
    var manualAdj = Number(state.manualAdj || 0);
    var childRates = computeChildRates(dRate, sRate, taxD, taxS, taxBase, taxedOverall, maxDays, state.calcMode, p);

    return {
      overall: taxedOverall,
      combinedNet: combinedNet,
      combinedGross: combinedGross,
      legacyDays: legDays,
      legacyBaseTotal: legBase,
      priorYearTaxable: priorYearTaxable,
      taxedDays: taxDays,
      taxedNetTotal: taxedOverall.net,
      taxedGrossTotal: taxedOverall.gross,
      months: monthItems,
      hasLegacyMonths: monthItems.some(function (m) { return m.legacy; }),
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
