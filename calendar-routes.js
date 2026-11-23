/**
 * 值班日历编辑 —— 后端路由
 * 挂载于 /zb/api/*，页面 /zb/（日历）、/zb/files（原始文件编辑）
 *
 * 数据源：
 *   address.txt        值班人员联系人（name,mobile 每行一条）
 *   duty_schedule.txt  排班（YYYY.MM.DD, 姓名 每行一条）
 *   节假日             timor.tech 中国法定节假日 API（按年缓存 7 天，失败回退旧缓存）
 */
const fs = require('fs');
const path = require('path');
const records = require('./duty-records');

// 农历库可选：缺失时日历只显示公历/节假日，不影响核心功能
let lunarLib = null;
try { lunarLib = require('lunar-javascript'); } catch (e) { lunarLib = null; }

const DIR = __dirname;
const ADDRESS_FILE = path.join(DIR, 'address.txt');
const SCHEDULE_FILE = path.join(DIR, 'duty_schedule.txt');
const HOLIDAY_CACHE = path.join(DIR, 'holidays-cache.json');
const CALENDAR_HTML = path.join(DIR, 'static', 'calendar.html');

const pad2 = n => String(n).padStart(2, '0');

// ---------- 文件读写 ----------
const STATUS_LIST = ['在岗', '不参与值班', '退出'];

function readContacts() {
  if (!fs.existsSync(ADDRESS_FILE)) return [];
  return fs.readFileSync(ADDRESS_FILE, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const parts = l.split(',').map(s => (s || '').trim());
      const [name, mobile] = parts;
      let status = parts[2] || '在岗';
      if (STATUS_LIST.indexOf(status) < 0) status = '在岗';   // 兼容旧文件与手写错值
      return { name, mobile: mobile || '', status };
    })
    .filter(c => c.name);
}

/** 写入联系人（固定 CRLF，状态缺省为「在岗」） */
function writeContacts(list) {
  const lines = list
    .filter(c => c && String(c.name || '').trim())
    .map(c => {
      const name = String(c.name).trim().replace(/[,\r\n]/g, '');
      const mobile = String(c.mobile || '').trim().replace(/[,\r\n]/g, '');
      let status = String(c.status || '在岗').trim();
      if (STATUS_LIST.indexOf(status) < 0) status = '在岗';
      return name + ',' + mobile + ',' + status;
    });
  fs.writeFileSync(ADDRESS_FILE, lines.join('\r\n') + (lines.length ? '\r\n' : ''), 'utf8');
  return lines.length;
}

function readSchedule() {
  const map = {};
  if (!fs.existsSync(SCHEDULE_FILE)) return map;
  fs.readFileSync(SCHEDULE_FILE, 'utf8').split(/\r?\n/).forEach(line => {
    const t = line.trim();
    if (!t) return;
    const [date, person] = t.split(',').map(s => (s || '').trim());
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date)) return;
    if (person) map[date] = person;
  });
  return map;
}

function writeSchedule(map) {
  const body = Object.keys(map).sort().map(k => k + ', ' + map[k]).join('\r\n');
  fs.writeFileSync(SCHEDULE_FILE, body + '\r\n', 'utf8');
}

// ---------- 节假日（按年缓存） ----------
const HOLIDAY_TTL = 7 * 24 * 3600 * 1000;

async function getHolidayYear(year) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(HOLIDAY_CACHE, 'utf8')); } catch (e) { cache = {}; }
  const hit = cache[year];
  if (hit && hit.fetchedAt && Date.now() - hit.fetchedAt < HOLIDAY_TTL) return hit.data;

  try {
    const res = await fetch('https://timor.tech/api/holiday/year/' + year, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const data = (json && json.holiday) || {};
    cache[year] = { fetchedAt: Date.now(), data };
    fs.writeFileSync(HOLIDAY_CACHE, JSON.stringify(cache), 'utf8');
    return data;
  } catch (err) {
    if (hit && hit.data) return hit.data; // 网络异常回退旧缓存
    return {};
  }
}

// ---------- 农历 / 节气 / 节日 ----------
function lunarInfo(y, m, d) {
  const out = { lunar: '', jieqi: '', festival: '' };
  if (!lunarLib) return out;
  try {
    const solar = lunarLib.Solar.fromYmd(y, m, d);
    const l = solar.getLunar();
    let dayText = l.getDayInChinese();
    if (dayText === '初一') dayText = l.getMonthInChinese() + '月';
    out.lunar = dayText;
    out.jieqi = l.getJieQi() || '';
    const fests = []
      .concat(l.getFestivals() || [])
      .concat(solar.getFestivals() || []);
    out.festival = fests.filter(Boolean).slice(0, 2).join(' ');
  } catch (e) { /* 忽略 */ }
  return out;
}

// ---------- 路由注册 ----------
module.exports = function mount(app, ctx) {
  const BASE_PATH = ctx.BASE_PATH;

  // 首次启用：把当前排班文件作为基线写入归档
  try {
    const n = records.backfillFrom(readSchedule());
    if (n) console.log('[值班归档] 基线导入 ' + n + ' 条历史排班 -> ' + records.RECORDS_FILE);
  } catch (e) {
    console.error('[值班归档] 基线导入失败:', e.message);
  }

  // 记录查询 / 统计 / 导出
  records.mountRoutes(app, BASE_PATH);

  // 日历页面
  app.get(BASE_PATH + '/', (req, res) => {
    if (!fs.existsSync(CALENDAR_HTML)) {
      return res.status(500).send('日历页面缺失：static/calendar.html');
    }
    res.type('html').send(fs.readFileSync(CALENDAR_HTML, 'utf8'));
  });

  // 联系人管理页面
  app.get(BASE_PATH + '/contacts', (req, res) => {
    const f = path.join(DIR, 'static', 'contacts.html');
    if (!fs.existsSync(f)) return res.status(500).send('联系人页面缺失：static/contacts.html');
    res.type('html').send(fs.readFileSync(f, 'utf8'));
  });

  // 联系人查询
  app.get(BASE_PATH + '/api/contacts', (req, res) => {
    try {
      const list = readContacts();
      res.json({
        contacts: list,
        counts: {
          total: list.length,
          active: list.filter(c => c.status === '在岗').length,
          paused: list.filter(c => c.status === '不参与值班').length,
          left: list.filter(c => c.status === '退出').length
        },
        statusList: STATUS_LIST
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 联系人保存（整表覆盖，保存前留备份）
  app.post(BASE_PATH + '/api/contacts/save', (req, res) => {
    try {
      const list = (req.body || {}).contacts;
      if (!Array.isArray(list)) return res.status(400).json({ error: 'contacts 必须是数组' });

      const cleaned = [];
      const seen = new Set();
      for (const c of list) {
        const name = String((c || {}).name || '').trim();
        if (!name) continue;
        if (seen.has(name)) return res.status(400).json({ error: '姓名重复：' + name });
        seen.add(name);
        cleaned.push({ name, mobile: String((c || {}).mobile || '').trim(), status: (c || {}).status });
      }
      if (!cleaned.length) return res.status(400).json({ error: '联系人不能为空' });
      if (!cleaned.filter(c => c.status === '在岗').length) {
        return res.status(400).json({ error: '至少要有一位「在岗」人员' });
      }

      // 备份旧文件
      if (fs.existsSync(ADDRESS_FILE)) {
        const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        fs.copyFileSync(ADDRESS_FILE, ADDRESS_FILE + '.bak.' + ts);
      }
      const n = writeContacts(cleaned);
      console.log('[联系人] 已保存 ' + n + ' 人（在岗 ' + cleaned.filter(c => c.status === '在岗').length + '）');
      res.json({ ok: true, count: n, contacts: readContacts() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 记录查询页面
  app.get(BASE_PATH + '/records', (req, res) => {
    const f = path.join(DIR, 'static', 'records.html');
    if (!fs.existsSync(f)) return res.status(500).send('记录页面缺失：static/records.html');
    res.type('html').send(fs.readFileSync(f, 'utf8'));
  });

  // 日历数据
  app.get(BASE_PATH + '/api/data', async (req, res) => {
    try {
      const now = new Date();
      const year = Number(req.query.year) || now.getFullYear();
      const month = Number(req.query.month) || (now.getMonth() + 1);
      if (month < 1 || month > 12) return res.status(400).json({ error: 'month 非法' });

      const contacts = readContacts();
      const schedule = readSchedule();
      const holidays = await getHolidayYear(year);

      const daysInMonth = new Date(year, month, 0).getDate();

      // 前后月（跨年时取对应年份的节假日数据）
      const shift = (y, m, delta) => { const t = new Date(y, m - 1 + delta, 1); return [t.getFullYear(), t.getMonth() + 1]; };
      const [py, pm] = shift(year, month, -1);
      const [ny, nm] = shift(year, month, 1);
      const holMap = {};
      holMap[year] = holidays;
      if (py !== year && !holMap[py]) holMap[py] = await getHolidayYear(py);
      if (ny !== year && !holMap[ny]) holMap[ny] = await getHolidayYear(ny);

      const mkDay = (y, m, d) => {
        const dt = new Date(y, m - 1, d);
        const key = pad2(m) + '-' + pad2(d);
        const h = (holMap[y] || {})[key];
        const li = lunarInfo(y, m, d);
        return {
          date: y + '.' + pad2(m) + '.' + pad2(d),
          day: d,
          month: m,
          weekday: dt.getDay(),               // 0=周日
          lunar: li.lunar,
          jieqi: li.jieqi,
          festival: li.festival,
          holiday: h ? !!h.holiday : null,     // true=放假 false=调休上班 null=普通日
          name: h && h.name ? h.name : ''
        };
      };

      const days = [];
      for (let d = 1; d <= daysInMonth; d++) days.push(mkDay(year, month, d));

      // 网格首尾过渡日期：只用于显示排班，不参与一键排班统计
      const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7;  // 周一=0
      const prevDays = [], nextDays = [];
      const pdim = new Date(py, pm, 0).getDate();
      for (let i = firstWeekday; i > 0; i--) prevDays.push(mkDay(py, pm, pdim - i + 1));
      const nextCount = (7 - ((firstWeekday + daysInMonth) % 7)) % 7;
      for (let i = 1; i <= nextCount; i++) nextDays.push(mkDay(ny, nm, i));

      res.json({
        year, month, contacts, schedule, days,
        prev: prevDays, next: nextDays,
        today: now.getFullYear() + '.' + pad2(now.getMonth() + 1) + '.' + pad2(now.getDate()),
        lunarReady: !!lunarLib
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 单日设置 / 轮空
  app.post(BASE_PATH + '/api/set', (req, res) => {
    try {
      const { date, person } = req.body || {};
      if (!/^\d{4}\.\d{2}\.\d{2}$/.test(String(date || ''))) {
        return res.status(400).json({ error: '日期格式应为 YYYY.MM.DD' });
      }
      const map = readSchedule();
      const name = String(person || '').trim();
      if (name) map[date] = name; else delete map[date];
      writeSchedule(map);
      records.appendRecords([{ date, person: name, action: name ? 'set' : 'clear' }]);
      res.json({ ok: true, date, person: name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 一键排满所选月份
  app.post(BASE_PATH + '/api/autofill', async (req, res) => {
    try {
      const now = new Date();
      const year = Number((req.body || {}).year) || now.getFullYear();
      const month = Number((req.body || {}).month) || (now.getMonth() + 1);
      const startPerson = String((req.body || {}).startPerson || '').trim();
      const skipWeekend = !!(req.body || {}).skipWeekend;
      const skipHoliday = !!(req.body || {}).skipHoliday;
      const overwrite = !!(req.body || {}).overwrite;

      const contacts = readContacts().filter(c => c.status === '在岗').map(c => c.name);
      if (!contacts.length) return res.status(400).json({ error: '没有「在岗」人员，请先在联系人管理中设置状态' });

      const map = readSchedule();
      const holidays = await getHolidayYear(year);
      const monthPrefix = year + '.' + pad2(month) + '.';

      // 起点：指定人员 > 接续上月最后一人
      let idx = 0;
      if (startPerson && contacts.indexOf(startPerson) >= 0) {
        idx = contacts.indexOf(startPerson);
      } else {
        const prev = Object.keys(map).filter(k => k < monthPrefix).sort();
        if (prev.length) {
          const lastPerson = map[prev[prev.length - 1]];
          const i = contacts.indexOf(lastPerson);
          idx = i >= 0 ? (i + 1) % contacts.length : 0;
        }
      }

      const daysInMonth = new Date(year, month, 0).getDate();
      let assigned = 0, skipped = 0, kept = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const date = monthPrefix + pad2(d);
        const dt = new Date(year, month - 1, d);
        const dow = dt.getDay();
        const h = holidays[pad2(month) + '-' + pad2(d)];

        if (!overwrite && map[date]) { kept++; continue; }
        if (skipWeekend && (dow === 0 || dow === 6)) { skipped++; continue; }
        if (skipHoliday && h && h.holiday) { skipped++; continue; }

        map[date] = contacts[idx % contacts.length];
        records.appendRecords([{ date, person: contacts[idx % contacts.length], action: 'autofill' }]);
        idx++;
        assigned++;
      }

      writeSchedule(map);
      res.json({ ok: true, assigned, skipped, kept, total: daysInMonth, contacts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 拖拽换班：交换两天的值班人员（任意一方为空则相当于移动）
  app.post(BASE_PATH + '/api/swap', (req, res) => {
    try {
      const a = String((req.body || {}).a || '');
      const b = String((req.body || {}).b || '');
      const okFmt = d => /^\d{4}\.\d{2}\.\d{2}$/.test(d);
      if (!okFmt(a) || !okFmt(b) || a === b) {
        return res.status(400).json({ error: '需要两个不同的合法日期' });
      }
      const map = readSchedule();
      const pa = map[a] || '';
      const pb = map[b] || '';
      if (pb) map[a] = pb; else delete map[a];
      if (pa) map[b] = pa; else delete map[b];
      writeSchedule(map);
      records.appendRecords([
        { date: a, person: pb, action: 'swap', note: '换班：' + (pa || '轮空') + ' -> ' + (pb || '轮空') },
        { date: b, person: pa, action: 'swap', note: '换班：' + (pb || '轮空') + ' -> ' + (pa || '轮空') }
      ]);
      res.json({ ok: true, a: pa, b: pb, schedule: map });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
};
