/* Subbly metrics engine.
 * Pure functions, no DOM and no I/O: compact raw Subbly MCP records into
 * small rows for storage, and compute every dashboard metric from those rows
 * for any date range and interval (day, week, month, quarter, year).
 * Loaded by index.html and testable under Node (module.exports at the end). */
(function (root) {
  'use strict';

  const DAY = 86400;
  const MONTH_DAYS = 30.4375;
  const GRACE = 3 * DAY; // bridges the gap between a period ending and its renewal invoice
  const RECURRING_ITEM_TYPES = new Set(['subscription', 'addon']);
  const OPEN_STATUSES = ['pending', 'open', 'past_due', 'processing'];
  const INTERVALS = ['day', 'week', 'month', 'quarter', 'year'];

  const ts = (s) => (s ? Math.floor(Date.parse(s) / 1000) : 0);
  const monthKey = (t) => new Date(t * 1000).toISOString().slice(0, 7);

  /* ---------- compaction: raw MCP record -> small array row ---------- */

  // invoice row: [id, customerId, subscriptionId, status, createdAt, paidAt,
  //               periodStart, periodEnd, total, recurringNet, currency]
  function compactInvoice(i) {
    let recGross = 0, recDisc = 0, itemDisc = 0;
    for (const it of i.items || []) {
      const disc = it.discountAmount || 0;
      itemDisc += disc;
      if (RECURRING_ITEM_TYPES.has(it.type)) { recGross += it.amount || 0; recDisc += disc; }
    }
    let rec = recGross - recDisc;
    // invoice-level discount that items don't carry: share it out by the recurring portion
    const extra = (i.discountsAmount || 0) - itemDisc;
    if (extra > 0 && i.subTotal > 0) rec -= Math.round((extra * recGross) / i.subTotal);
    return [i.id, i.customerId, i.subscriptionId || 0, i.status, ts(i.createdAt), ts(i.paidAt),
      ts(i.periodStart), ts(i.periodEnd), i.total || 0, Math.max(0, rec), i.currencyCode || ''];
  }
  // subscription row: [id, customerId, status, createdAt, cancelledAt, productId]
  function compactSubscription(s) {
    return [s.id, s.customerId, s.status, ts(s.createdAt), ts(s.cancelledAt), s.productId || 0];
  }
  // customer row: [id, createdAt, name, email]
  function compactCustomer(c) {
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
    return [c.id, ts(c.createdAt), name, c.email || ''];
  }
  // failed charge row: [id, customerId, invoiceId, amount, createdAt, currency]
  function compactFailed(t) {
    return [t.id, t.customerId, t.invoiceId || 0, t.amount || 0, ts(t.createdAt), t.currencyCode || ''];
  }

  // rows grouped into storage chunks: month of the row's created date, split
  // into parts so one document stays well under the store's 256 KiB limit
  function chunkRows(rows, createdIdx, perPart) {
    const byMonth = new Map();
    for (const r of rows) {
      const k = r[createdIdx] ? monthKey(r[createdIdx]) : '0000-00';
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(r);
    }
    const out = {};
    for (const [k, list] of byMonth) {
      list.sort((a, b) => a[0] - b[0]);
      for (let p = 0; p * perPart < list.length; p++) out[`${k}.${p}`] = list.slice(p * perPart, (p + 1) * perPart);
    }
    return out;
  }

  /* ---------- time buckets ---------- */

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // first second of the interval containing t (UTC; weeks start Monday)
  function floorTo(t, interval) {
    const d = new Date(t * 1000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    switch (interval) {
      case 'day': return Date.UTC(y, m, day) / 1000;
      case 'week': { const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(y, m, day - dow) / 1000; }
      case 'month': return Date.UTC(y, m, 1) / 1000;
      case 'quarter': return Date.UTC(y, m - (m % 3), 1) / 1000;
      default: return Date.UTC(y, 0, 1) / 1000;
    }
  }
  function nextStart(t, interval) {
    const d = new Date(t * 1000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate();
    switch (interval) {
      case 'day': return Date.UTC(y, m, day + 1) / 1000;
      case 'week': return Date.UTC(y, m, day + 7) / 1000;
      case 'month': return Date.UTC(y, m + 1, 1) / 1000;
      case 'quarter': return Date.UTC(y, m + 3, 1) / 1000;
      default: return Date.UTC(y + 1, 0, 1) / 1000;
    }
  }
  function bucketLabels(start, interval) {
    const d = new Date(start * 1000);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), day = d.getUTCDate(), yy = String(y).slice(2);
    switch (interval) {
      case 'day': return { label: `${day} ${MON[m]}`, long: `${day} ${MON[m]} ${y}` };
      case 'week': return { label: `${day} ${MON[m]}`, long: `Week of ${day} ${MON[m]} ${y}` };
      case 'month': return { label: `${MON[m]} ${yy}`, long: `${MON[m]} ${y}` };
      case 'quarter': return { label: `Q${m / 3 + 1} ${yy}`, long: `Q${m / 3 + 1} ${y}` };
      default: return { label: String(y), long: String(y) };
    }
  }
  // buckets covering [from, to]; the last one is cut off at `now`
  function makeBuckets(from, to, interval, now) {
    const out = [];
    for (let s = floorTo(from, interval); s <= to; s = nextStart(s, interval)) {
      const end = nextStart(s, interval) - 1;
      out.push({ start: s, end, at: Math.min(end, now, to), partial: end > now || end > to, ...bucketLabels(s, interval) });
      if (out.length > 2000) break;
    }
    return out;
  }
  function bucketCount(from, to, interval) {
    let n = 0;
    for (let s = floorTo(from, interval); s <= to && n <= 2000; s = nextStart(s, interval)) n++;
    return n;
  }

  /* ---------- model ---------- */

  function median(a) {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  // service period in months; periods within a few days of whole months snap
  // to them, so a 29-day "monthly" period does not read as a 2% price rise
  function periodMonths(seconds) {
    const days = Math.max(seconds / DAY, 1);
    const months = days / MONTH_DAYS;
    const whole = Math.round(months);
    if (whole >= 1 && Math.abs(days - whole * MONTH_DAYS) <= 4 * whole) return whole;
    return months;
  }

  // everything the metrics need, built once from the stored rows
  function prepare({ invoices, subscriptions, customers, failed }) {
    const curCount = new Map();
    for (const r of invoices) if (r[10]) curCount.set(r[10], (curCount.get(r[10]) || 0) + r[8]);
    const currency = [...curCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'USD';
    const inv = invoices.filter((r) => r[10] === currency || !r[10]);

    const cancelAt = new Map();
    for (const s of subscriptions) if (s[4]) cancelAt.set(s[0], s[4]);

    const bySub = new Map();
    const firstStart = new Map();             // customer -> start of first recurring coverage
    const firstRecurringInvoice = new Map();  // customer -> earliest recurring invoice created
    for (const r of inv) {
      const [, cid, sid, status, created, , ps, pe, , rec] = r;
      if (!sid || rec <= 0 || status === 'voided') continue;
      const start = ps || created;
      const end = pe > start ? pe : start + MONTH_DAYS * DAY;
      if (!bySub.has(sid)) bySub.set(sid, []);
      bySub.get(sid).push([start, end, rec / periodMonths(end - start), cid]);
      if (!firstStart.has(cid) || start < firstStart.get(cid)) firstStart.set(cid, start);
      if (!firstRecurringInvoice.has(cid) || created < firstRecurringInvoice.get(cid)) firstRecurringInvoice.set(cid, created);
    }
    for (const list of bySub.values()) list.sort((a, b) => a[0] - b[0]);

    const firstInvoice = inv.length ? Math.min(...inv.map((r) => r[4])) : 0;
    return {
      currency, inv, bySub, cancelAt, firstStart, firstRecurringInvoice, firstInvoice,
      failed: failed.filter((f) => !f[5] || f[5] === currency),
      customers: new Map(customers.map((c) => [c[0], { created: c[1], name: c[2], email: c[3] }])),
      counts: { invoices: invoices.length, subscriptions: subscriptions.length, customers: customers.length,
        failed: failed.length, otherCurrencyInvoices: invoices.length - inv.length },
    };
  }

  // MRR per customer at instant T: each subscription's latest invoice that has started
  function mrrAt(model, T) {
    const out = new Map();
    for (const [sid, list] of model.bySub) {
      let lo = 0, hi = list.length - 1, idx = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid][0] <= T) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
      if (idx < 0) continue;
      const [, end, monthly, cid] = list[idx];
      const stop = Math.min(end + GRACE, model.cancelAt.get(sid) || Infinity);
      if (T < stop) out.set(cid, (out.get(cid) || 0) + monthly);
    }
    return out;
  }
  const sumMap = (m) => { let s = 0; for (const v of m.values()) s += v; return s; };

  /* ---------- series for a range and interval ---------- */

  function series(model, { from, to, interval, now }) {
    now = now || Math.floor(Date.now() / 1000);
    to = Math.min(to || now, now);
    from = from || model.firstInvoice || now;
    const buckets = makeBuckets(from, to, interval, now);
    const n = buckets.length;
    const zeros = () => buckets.map(() => 0);
    const snaps = buckets.map((b) => mrrAt(model, b.at));
    let prev = mrrAt(model, buckets[0].start - 1);
    let prevT = buckets[0].start - 1;

    const S = { mrr: [], subscribers: [], arpa: [],
      newMrr: [], expansion: [], reactivation: [], contraction: [], churn: [], net: [],
      newCount: [], expansionCount: [], reactivationCount: [], contractionCount: [], churnCount: [],
      customerChurnRate: [], netMrrChurnRate: [], grossMrrChurnRate: [] };
    snaps.forEach((cur, i) => {
      let nw = 0, ex = 0, re = 0, co = 0, ch = 0, nwC = 0, exC = 0, reC = 0, coC = 0, chC = 0;
      for (const [cid, v] of cur) {
        const p = prev.get(cid) || 0;
        if (p === 0) {
          // paid before the previous snapshot but not at it: they came back
          if ((model.firstStart.get(cid) || Infinity) <= prevT) { re += v; reC++; } else { nw += v; nwC++; }
        } else {
          const noise = Math.max(50, p * 0.01); // ignore sub-1% wobble from period lengths
          if (v > p + noise) { ex += v - p; exC++; } else if (v < p - noise) { co += p - v; coC++; }
        }
      }
      for (const [cid, p] of prev) if (!cur.has(cid)) { ch += p; chC++; }
      const mrr = sumMap(cur), startMrr = sumMap(prev), startSubs = prev.size;
      S.mrr.push(mrr); S.subscribers.push(cur.size); S.arpa.push(cur.size ? mrr / cur.size : 0);
      S.newMrr.push(nw); S.expansion.push(ex); S.reactivation.push(re); S.contraction.push(-co); S.churn.push(-ch);
      S.net.push(mrr - startMrr);
      S.newCount.push(nwC); S.expansionCount.push(exC); S.reactivationCount.push(reC); S.contractionCount.push(coC); S.churnCount.push(chC);
      S.customerChurnRate.push(startSubs ? chC / startSubs : null);
      S.netMrrChurnRate.push(startMrr ? (ch + co - ex) / startMrr : null);
      S.grossMrrChurnRate.push(startMrr ? (ch + co) / startMrr : null);
      prev = cur; prevT = buckets[i].at;
    });

    // MRR by the year customers started, every year up to the current one
    const yearOf = (cid) => new Date((model.firstStart.get(cid) || 0) * 1000).getUTCFullYear();
    const years = [...new Set([...model.firstStart.keys()].map(yearOf))].sort();
    const mrrByCohort = years.map((y) => ({ year: y, values: snaps.map((cur) => {
      let s = 0; for (const [cid, v] of cur) if (yearOf(cid) === y) s += v; return s;
    }) })).filter((c) => c.values.some((v) => v > 0));

    // event counts dropped into the bucket their timestamp falls in
    const starts = buckets.map((b) => b.start);
    const idxAt = (t) => {
      if (t < starts[0] || t > buckets[n - 1].at) return -1;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const cashRecurring = zeros(), cashOther = zeros(), failedCount = zeros(), failedAmount = zeros();
    for (const r of model.inv) {
      if (r[3] !== 'paid' || !r[5]) continue;
      const i = idxAt(r[5]);
      if (i < 0) continue;
      const recPaid = Math.min(r[9], r[8]);
      cashRecurring[i] += recPaid; cashOther[i] += Math.max(0, r[8] - recPaid);
    }
    for (const f of model.failed) { const i = idxAt(f[4]); if (i >= 0) { failedCount[i]++; failedAmount[i] += f[3]; } }

    const leads = zeros(), converted = zeros(), cycleDays = buckets.map(() => []);
    for (const [cid, info] of model.customers) {
      const first = model.firstRecurringInvoice.get(cid);
      const i = idxAt(info.created);
      if (i >= 0) { leads[i]++; if (first && first - info.created <= 30 * DAY) converted[i]++; }
      if (first) { const j = idxAt(first); if (j >= 0) cycleDays[j].push(Math.max(0, (first - info.created) / DAY)); }
    }

    return {
      interval, from, to, buckets: buckets.map(({ start, at, partial, label, long }) => ({ start, at, partial, label, long })),
      series: S, mrrByCohort,
      cash: { recurring: cashRecurring, other: cashOther },
      failed: { count: failedCount, amount: failedAmount },
      leads: { count: leads, conversion: leads.map((c, i) => (c ? converted[i] / c : null)), medianDaysToPay: cycleDays.map(median) },
    };
  }

  /* ---------- range-independent figures ---------- */

  function overview(model, now) {
    now = now || Math.floor(Date.now() / 1000);
    const nowSnap = mrrAt(model, now), ago30 = mrrAt(model, now - 30 * DAY);
    const custName = (cid) => model.customers.get(cid)?.name || `Customer ${cid}`;

    // subscriber retention by start quarter, from month-end snapshots over all history
    const months = makeBuckets(model.firstInvoice || now, now, 'month', now);
    const snaps = months.map((b) => mrrAt(model, b.at));
    const firstIdx = new Map();
    snaps.forEach((s, i) => { for (const cid of s.keys()) if (!firstIdx.has(cid)) firstIdx.set(cid, i); });
    const quarterOf = (b) => { const d = new Date(b.start * 1000); return `${d.getUTCFullYear()} Q${Math.floor(d.getUTCMonth() / 3) + 1}`; };
    const cohortQ = new Map();
    for (const [cid, idx] of firstIdx) {
      const q = quarterOf(months[idx]);
      if (!cohortQ.has(q)) cohortQ.set(q, []);
      cohortQ.get(q).push([cid, idx]);
    }
    const offsets = [0, 3, 6, 9, 12, 18, 24];
    const retention = [...cohortQ.entries()].sort().map(([q, members]) => ({
      cohort: q, size: members.length,
      cells: offsets.map((k) => {
        if (members.some(([, idx]) => idx + k >= months.length)) return null;
        return members.filter(([cid, idx]) => snaps[idx + k].has(cid)).length / members.length;
      }),
    }));

    let cash30 = 0, cashPrev30 = 0, failed30 = 0, failedPrev30 = 0;
    for (const r of model.inv) {
      if (r[3] !== 'paid' || !r[5]) continue;
      if (r[5] > now - 30 * DAY) cash30 += r[8]; else if (r[5] > now - 60 * DAY) cashPrev30 += r[8];
    }
    for (const f of model.failed) { if (f[4] > now - 30 * DAY) failed30++; else if (f[4] > now - 60 * DAY) failedPrev30++; }

    const pastDue = new Map();
    for (const r of model.inv) {
      if (r[3] !== 'past_due') continue;
      const p = pastDue.get(r[1]) || { customerId: r[1], amount: 0, since: r[4], invoices: 0 };
      p.amount += r[8]; p.since = Math.min(p.since, r[4]); p.invoices++;
      pastDue.set(r[1], p);
    }
    const pastDueList = [...pastDue.values()]
      .map((p) => ({ ...p, name: custName(p.customerId), mrr: nowSnap.get(p.customerId) || 0 }))
      .sort((a, b) => b.amount - a.amount);
    const newCustomers = [...model.firstRecurringInvoice.entries()]
      .filter(([cid, t]) => t > now - 30 * DAY && nowSnap.has(cid))
      .map(([cid, t]) => ({ customerId: cid, name: custName(cid), since: t, mrr: nowSnap.get(cid) }))
      .sort((a, b) => b.mrr - a.mrr).slice(0, 8);

    const mrrNow = sumMap(nowSnap), mrr30 = sumMap(ago30);
    return {
      retention, retentionOffsets: offsets,
      lists: { pastDue: pastDueList.slice(0, 50), pastDueTotal: pastDueList.reduce((s, p) => s + p.amount, 0),
        pastDueCustomers: pastDueList.length, newCustomers },
      headline: {
        mrr: mrrNow, mrr30, subscribers: nowSnap.size, subscribers30: ago30.size,
        arpa: nowSnap.size ? mrrNow / nowSnap.size : 0, arpa30: ago30.size ? mrr30 / ago30.size : 0,
        cash30, cashPrev30, failed30, failedPrev30,
      },
    };
  }

  // the stored summary: today's figures plus the default view (last 24 months by month)
  function compute(input) {
    const now = input.now || Math.floor(Date.now() / 1000);
    const model = prepare(input);
    const from = Math.max(model.firstInvoice || now, Date.UTC(new Date(now * 1000).getUTCFullYear() - 2, new Date(now * 1000).getUTCMonth() + 1, 1) / 1000);
    return {
      version: 2, generatedAt: now, currency: model.currency, counts: model.counts,
      firstInvoice: model.firstInvoice,
      view: series(model, { from, to: now, interval: 'month', now }),
      ...overview(model, now),
    };
  }

  const api = { compactInvoice, compactSubscription, compactCustomer, compactFailed, chunkRows,
    prepare, series, overview, compute, bucketCount, floorTo, monthKey, OPEN_STATUSES, INTERVALS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubblyMetrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
