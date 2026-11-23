/* ═══════════════════════════════════════════════════════════════════════════
   tax-engine.js — Canonical 2026 Kenya Statutory Tax & Gross-Up Engine
                   (Zero DOM dependencies; one implementation of all tax math)
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var DEFAULT_PARAMS = {
    nssfRate: 0.06,
    nssfCap: 108000,
    shifRate: 0.0275,
    shifMin: 300,
    ahlRate: 0.015,
    relief: 2400
  };

  function emptyPeriod() {
    return {
      gross: 0, nssf: 0, shif: 0, ahl: 0, preTaxDed: 0, taxable: 0,
      b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, grossTax: 0, relief: 0,
      paye: 0, totalDed: 0, net: 0
    };
  }

  function calcPayeBands(taxable) {
    var b1 = Math.min(taxable, 24000) * 0.10;
    var b2 = Math.max(0, Math.min(taxable, 32333) - 24000) * 0.25;
    var b3 = Math.max(0, Math.min(taxable, 500000) - 32333) * 0.30;
    var b4 = Math.max(0, Math.min(taxable, 800000) - 500000) * 0.325;
    var b5 = Math.max(0, taxable - 800000) * 0.35;
    return { b1: b1, b2: b2, b3: b3, b4: b4, b5: b5, grossTax: b1 + b2 + b3 + b4 + b5 };
  }

  function calcForward(gross, params) {
    var p = params || DEFAULT_PARAMS;
    var g = Math.max(0, Number(gross || 0));
    if (g <= 0) return emptyPeriod();

    var nssf = Math.min(g, p.nssfCap) * p.nssfRate;
    var shif = Math.max(p.shifMin, g * p.shifRate);
    var ahl = g * p.ahlRate;
    var preTaxDed = nssf + shif + ahl;
    var taxable = Math.max(0, g - preTaxDed);
    var bands = calcPayeBands(taxable);
    var paye = Math.max(0, bands.grossTax - p.relief);
    var totalDed = preTaxDed + paye;

    return {
      gross: g, nssf: nssf, shif: shif, ahl: ahl, preTaxDed: preTaxDed,
      taxable: taxable, b1: bands.b1, b2: bands.b2, b3: bands.b3,
      b4: bands.b4, b5: bands.b5, grossTax: bands.grossTax,
      relief: p.relief, paye: paye, totalDed: totalDed, net: g - totalDed
    };
  }

  function solveGrossFromNet(targetNet, params) {
    var p = params || DEFAULT_PARAMS;
    var net = Math.max(0, Number(targetNet || 0));
    if (net <= 0) return emptyPeriod();

    var lo = net;
    var hi = Math.max(net * 2.2 + 5000, 20000);
    while (calcForward(hi, p).net < net) { hi *= 2; }
    for (var i = 0; i < 64; i++) {
      var mid = (lo + hi) / 2;
      if (calcForward(mid, p).net < net) { lo = mid; } else { hi = mid; }
    }
    return calcForward((lo + hi) / 2, p);
  }

  function sumPeriods(list) {
    var acc = emptyPeriod();
    var keys = Object.keys(acc);
    for (var i = 0; i < list.length; i++) {
      for (var k = 0; k < keys.length; k++) {
        acc[keys[k]] += list[i][keys[k]];
      }
    }
    return acc;
  }

  function computeSchedule(state, params) {
    var p = params || DEFAULT_PARAMS;
    var dRate = Math.max(0, Number(state.daughterRate || 0));
    var sRate = Math.max(0, Number(state.sonRate || 0));
    var rows = Array.isArray(state.months) ? state.months : [];
    var totD = 0, totS = 0, totBase = 0;

    var monthItems = rows.map(function (m) {
      var d = Math.max(0, Number(m.dDays || 0));
      var s = Math.max(0, Number(m.sDays || 0));
      var base = d * dRate + s * sRate;
      totD += d; totS += s; totBase += base;
      return { month: m.month, year: m.year, label: m.month + ' ' + m.year, dDays: d, sDays: s, totalDays: d + s, baseAmt: base };
    });

    var solveFn = (state.calcMode === 'forward') ? calcForward : solveGrossFromNet;
    var overall;
    if (state.billingMode === 'monthly') {
      var perMonth = monthItems.map(function (item) {
        var r = solveFn(item.baseAmt, p);
        item.gross = r.gross; item.totalDed = r.totalDed; item.net = r.net;
        return r;
      });
      overall = sumPeriods(perMonth);
    } else {
      overall = solveFn(totBase, p);
      monthItems.forEach(function (item) {
        var share = (totBase > 0) ? (item.baseAmt / totBase) : 0;
        item.gross = overall.gross * share;
        item.totalDed = overall.totalDed * share;
        item.net = overall.net * share;
      });
    }

    var totDays = totD + totS;
    var priorPaid = Math.max(0, Number(state.priorPaid || 0));
    var manualAdj = Number(state.manualAdj || 0);
    return {
      overall: overall,
      months: monthItems,
      daughterDays: totD,
      sonDays: totS,
      totalDays: totDays,
      baseTotal: totBase,
      additionalPay: overall.gross - overall.net,
      effectiveDaily: (totDays > 0) ? (overall.gross / totDays) : 0,
      priorPaid: priorPaid,
      manualAdj: manualAdj,
      balanceOwed: overall.gross - priorPaid + manualAdj
    };
  }

  function computeDailyPlanner(dRate, sRate, maxDays, params) {
    var days = Math.max(1, Number(maxDays || 20));
    var cases = [
      { id: 'daughter', title: 'Teaching Daughter Only', netDay: dRate },
      { id: 'son', title: 'Teaching Son Only', netDay: sRate },
      { id: 'both', title: 'Teaching Both in the Same Month', netDay: dRate + sRate }
    ];
    return cases.map(function (c) {
      var targetMo = c.netDay * days;
      var solved = solveGrossFromNet(targetMo, params);
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
