/**
 * 值班记录归档（append-only）
 *
 * 目的：duty_schedule.txt 只保存当前及未来排班，历史无法回溯。
 *      本模块把所有排班变更追加写入 duty_records.csv，支持长期查询与统计。
 *
 * CSV 列：recorded_at,date,person,action,note
 *   action: import(基线导入) / set(手动设置) / clear(轮空) / swap(换班) / autofill(一键排班)
 */
const fs = require('fs');
const path = require('path');

const RECORDS_FILE = path.join(__dirname, 'duty_records.csv');
const HEADER = 'recorded_at,date,person,action,note';

function pad2(n) { return String(n).padStart(2, '0'); }

function nowText() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function escField(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 追加记录：[{ date, person, action, note }] */
function appendRecords(rows) {
  if (!rows || !rows.length) return 0;
  const ts = nowText();
  const lines = rows.map(r => [ts, r.date, r.person || '', r.action || 'set', r.note || '']
    .map(escField).join(','));
  const needHeader = !fs.existsSync(RECORDS_FILE) || fs.statSync(RECORDS_FILE).size === 0;
  fs.appendFileSync(RECORDS_FILE, (needHeader ? HEADER + '\n' : '') + lines.join('\n') + '\n', 'utf8');
  return lines.length;
}

/** 读取全部记录（带可选过滤） */
function readRecords(opts) {
  const o = opts || {};
  if (!fs.existsSync(RECORDS_FILE)) return [];
  const raw = fs.readFileSync(RECORDS_FILE, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {          // 跳过表头
    const f = splitCsvLine(lines[i]);
    if (f.length < 4) continue;
    const rec = { recorded_at: f[0], date: f[1], person: f[2], action: f[3], note: f[4] || '' };
    if (o.from && rec.date < o.from) continue;
    if (o.to && rec.date > o.to) continue;
    if (o.person && rec.person !== o.person) continue;
    rows.push(rec);
  }
  return rows;
}

/** 读取人员名单（address.txt 第一列） */
function readContactNames() {
  try {
    const f = path.join(__dirname, 'address.txt');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)
      .map(l => l.split(',').map(x => (x || '').trim()))
      .filter(p => p[0] && (p[2] || '在岗') === '在岗')   // 只统计「在岗」人员
      .map(p => p[0]);
  } catch (e) { return []; }
}

/** 以「每个日期最后一条记录」为准，汇总每人天数（含未值班的 0 天人员） */
function stats(records, opts) {
  const o = opts || {};
  const latest = new Map();      // date -> record（后写覆盖先写）
  for (const r of records) latest.set(r.date, r);

  const byPerson = {};
  const byMonth = {};
  let assigned = 0;
  for (const r of latest.values()) {
    if (!r.person) continue;     // 轮空不计入人次
    assigned++;
    byPerson[r.person] = (byPerson[r.person] || 0) + 1;
    const m = r.date.slice(0, 7);
    byMonth[m] = (byMonth[m] || 0) + 1;
  }
  // 补全名单：本月/本期完全没排班的人也列出（0 天）
  let names = Array.isArray(o.names) ? o.names : readContactNames();
  if (o.person) names = names.filter(n => n === o.person);   // 按人员筛选时只留该人
  for (const n of names) if (!(n in byPerson)) byPerson[n] = 0;

  const people = Object.keys(byPerson)
    .map(name => ({ name, days: byPerson[name] }))
    .sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));

  return {
    totalRecords: records.length,
    dates: latest.size,
    assignedDays: assigned,
    idleCount: people.filter(p => p.days === 0).length,
    people,
    byMonth
  };
}

function toCsv(records) {
  const body = records.map(r => [r.recorded_at, r.date, r.person, r.action, r.note]
    .map(escField).join(',')).join('\n');
  return HEADER + '\n' + body + '\n';
}

/** 首次启用时，把当前排班文件里的条目作为基线导入 */
function backfillFrom(scheduleMap) {
  if (fs.existsSync(RECORDS_FILE) && fs.statSync(RECORDS_FILE).size > 0) return 0;
  const rows = Object.keys(scheduleMap).sort().map(date => ({
    date, person: scheduleMap[date], action: 'import', note: '基线导入'
  }));
  if (!rows.length) {
    fs.writeFileSync(RECORDS_FILE, HEADER + '\n', 'utf8');
    return 0;
  }
  const n = appendRecords(rows);
  return n;
}

function mountRoutes(app, BASE_PATH) {
  // 查询记录 + 统计
  app.get(BASE_PATH + '/api/records', (req, res) => {
    try {
      const from = req.query.from ? String(req.query.from) : '';
      const to = req.query.to ? String(req.query.to) : '';
      const person = req.query.person ? String(req.query.person) : '';
      const all = readRecords({ from, to, person });
      const rows = all.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      res.json({
        filters: { from, to, person },
        stats: stats(all, { person }),
        records: rows.slice(0, 3000),
        truncated: rows.length > 3000
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 导出 CSV
  app.get(BASE_PATH + '/api/records.csv', (req, res) => {
    try {
      const from = req.query.from ? String(req.query.from) : '';
      const to = req.query.to ? String(req.query.to) : '';
      const person = req.query.person ? String(req.query.person) : '';
      const rows = readRecords({ from, to, person })
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      const name = 'duty_records_' + (from || 'all') + '_' + (to || 'all') + '.csv';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
      res.send('\ufeff' + toCsv(rows));   // BOM 让 Excel 正确识别中文
    } catch (err) {
      res.status(500).send(err.message);
    }
  });
}

module.exports = { appendRecords, readRecords, stats, toCsv, backfillFrom, mountRoutes, readContactNames, RECORDS_FILE };
