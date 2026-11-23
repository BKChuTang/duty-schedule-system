// ===== 加载项目根目录 .env（若已安装 dotenv；未安装则只用系统环境变量，不影响运行）=====
try { require('dotenv').config(); } catch (e) { /* dotenv 未安装，忽略 */ }

console.log("当前时区：", Intl.DateTimeFormat().resolvedOptions().timeZone);
console.log("当前时间：", new Date().toLocaleString());

const fs = require('fs').promises;
const path = require('path');
const schedule = require('node-schedule');
const axios = require('axios');

// 测试用：DUTY_DRYRUN=1 时只打印不真实发送
const DRY_RUN = process.env.DUTY_DRYRUN === '1';

/* ============================================================
 * 配置区（使用前请按实际情况修改，或改用环境变量注入）
 * ============================================================ */
const CONFIG = {
  // 【排班表】格式：每年每月每天一行 —— "2026.12.01, 张三"
  // 首次使用请把 duty_schedule.sample.txt 复制为 duty_schedule.txt 再改
  DUTY_SCHEDULE_FILE: path.resolve(__dirname, process.env.DUTY_SCHEDULE_FILE || './duty_schedule.txt'),

  // 【通讯录】格式："张三,13800000001,在岗"
  //   第一列 姓名（必须与排班表里的姓名完全一致）
  //   第二列 手机号（用于钉钉 @ 提醒，需与钉钉绑定手机号一致）
  //   第三列 状态（在岗 / 不参与值班 / 退出），缺省视为「在岗」
  // 首次使用请把 address.sample.txt 复制为 address.txt 再改
  ADDRESS_FILE: path.resolve(__dirname, process.env.ADDRESS_FILE || './address.txt'),

  // 【钉钉群机器人 Webhook】获取方式：
  //   钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 安全设置勾选「自定义关键词」或「加签」
  //   → 复制 Webhook 地址，形如：https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx
  // ⚠️ 这里是示例占位，请替换成你自己的；更推荐用环境变量 DINGTALK_WEBHOOK_URL 注入，
  //    这样真实 token 不会进入代码仓库。
  DINGTALK_WEBHOOK_URL: process.env.DINGTALK_WEBHOOK_URL
    || 'https://oapi.dingtalk.com/robot/send?access_token=YOUR_DINGTALK_ACCESS_TOKEN',

  // 【每日提醒时间】cron 表达式，默认每天 9:00 推送当日值班安排
  DAILY_CRON: process.env.DAILY_CRON || '0 9 * * *',

  // 通讯录/排班表的内存缓存时长（毫秒），文件有改动会自动失效
  CACHE_EXPIRE: 3600000
};

// 数据缓存
const cache = {
  addressBook: null,
  dutySchedule: null,
  lastUpdate: 0
};

// 格式化日期为 yyyy.mm.dd
function formatDate(date) {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

// 加载通讯录
async function loadAddressBook() {
  if (cache.addressBook && Date.now() - cache.lastUpdate < CONFIG.CACHE_EXPIRE) {
    return cache.addressBook;
  }
  try {
    const content = await fs.readFile(CONFIG.ADDRESS_FILE, 'utf8');
    const addressBook = {};
    content.split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      const [name, mobile] = line.split(',').map(item => item.trim());
      if (name && mobile) addressBook[name] = mobile;
    });
    cache.addressBook = addressBook;
    cache.lastUpdate = Date.now();
    return addressBook;
  } catch (error) {
    console.error('读取通讯录失败:', error.message);
    return {};
  }
}

// 加载值日安排（适配单人/轮空）
async function loadDutySchedule() {
  if (cache.dutySchedule && Date.now() - cache.lastUpdate < CONFIG.CACHE_EXPIRE) {
    return cache.dutySchedule;
  }
  try {
    const content = await fs.readFile(CONFIG.DUTY_SCHEDULE_FILE, 'utf8');
    const dutySchedule = {};
    content.split(/\r?\n/).forEach(line => {
      if (!line.trim()) return;
      const [date, person] = line.split(',').map(item => item.trim());
      if (date) dutySchedule[date] = person || null;
    });
    cache.dutySchedule = dutySchedule;
    return dutySchedule;
  } catch (error) {
    console.error('读取值日安排失败:', error.message);
    return {};
  }
}

// 根据姓名获取手机号
async function getMobileByName(name) {
  if (!name) return null;
  const addressBook = await loadAddressBook();
  return addressBook[name] || null;
}

// 发送钉钉消息
async function sendMessage(message, mobiles = []) {
  const validMobiles = mobiles.filter(mobile => mobile && /^\d{11}$/.test(mobile));
  if (DRY_RUN) {
    console.log('[DRY_RUN] 将发送:', message.replace(/\n/g, ' | '), '| @:', validMobiles.join(',') || '无');
    return true;
  }
  try {
    const response = await axios.post(CONFIG.DINGTALK_WEBHOOK_URL, {
      msgtype: 'text',
      text: { content: message },
      at: { isAtAll: false, atMobiles: validMobiles }
    }, { timeout: 10000 });
    if (response.data.errcode === 0) {
      console.log('消息发送成功:', message);
      return true;
    } else {
      console.error('钉钉接口错误:', response.data);
      return false;
    }
  } catch (error) {
    console.error('发送消息失败:', error.message);
    return false;
  }
}

// 发送钉钉 Markdown 消息
async function sendMarkdownMessage(title, markdownText) {
  try {
    const response = await axios.post(CONFIG.DINGTALK_WEBHOOK_URL, {
      msgtype: 'markdown',
      markdown: { title, text: markdownText }
    }, { timeout: 10000 });
    if (response.data.errcode === 0) {
      console.log('Markdown消息发送成功');
      return true;
    } else {
      console.error('钉钉Markdown接口错误:', response.data);
      return false;
    }
  } catch (error) {
    console.error('发送Markdown失败:', error.message);
    return false;
  }
}

// 获取指定日期的值日信息
async function getDutyByDate(dateStr) {
  const dutySchedule = await loadDutySchedule();
  return dutySchedule[dateStr] || null;
}

// 发送单日值日提醒
async function sendDailyReminder(dateStr) {
  const dutyPerson = await getDutyByDate(dateStr);
  let message = '';
  let mobile = null;

  if (!dutyPerson) {
    message = `📅 值日提醒：
${dateStr} 今日值日轮空，无需安排人员检查电脑～`;
    console.log(`【${dateStr}】值日轮空`);
  } else {
    mobile = await getMobileByName(dutyPerson);
    message = `📅 值日提醒：
${dateStr} 的值日人员是 ${dutyPerson}，请记得检查所有电脑是否关闭哦～`;
    console.log(`【${dateStr}】值日人员：${dutyPerson}`);
  }
  await sendMessage(message, [mobile]);
}

// 发送周五的周末汇总提醒（仅周六+周日）
async function sendWeekendSummaryReminder(fridayDate) {
  // 计算周六、周日（去掉周五）
  const friday = new Date(fridayDate);
  const saturday = new Date(friday);
  saturday.setDate(friday.getDate() + 1);
  const sunday = new Date(friday);
  sunday.setDate(friday.getDate() + 2);

  // 格式化周六、周日日期
  const satStr = formatDate(saturday);
  const sunStr = formatDate(sunday);

  // 获取周六、周日的值日信息
  const satDuty = await getDutyByDate(satStr);
  const sunDuty = await getDutyByDate(sunStr);

  // 收集周六+周日的手机号（避免重复@周五人员）
  const allNames = [satDuty, sunDuty].filter(name => name);
  const allMobiles = [];
  for (const name of allNames) {
    const mobile = await getMobileByName(name);
    if (mobile) allMobiles.push(mobile);
  }

  // 构造汇总消息（仅周六+周日）
  const summaryMessage = `📢 周末值日提醒：
【${satStr}（周六）】：${satDuty || '轮空'}
【${sunStr}（周日）】：${sunDuty || '轮空'}
请值日同学提前做好准备，记得检查电脑关闭情况～`;

  await sendMessage(summaryMessage, allMobiles);
}

// ==================== 节假日支持 ====================
// 与值班日历共用 holidays-cache.json（日历页写入缓存，这里读取/兜底抓取）
const HOLIDAY_CACHE_FILE = path.resolve(__dirname, './holidays-cache.json');
const HOLIDAY_TTL = 7 * 24 * 3600 * 1000;

function holidayKey(date) {
  return String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

async function getHolidayMap(year) {
  let store = {};
  try { store = JSON.parse(await fs.readFile(HOLIDAY_CACHE_FILE, 'utf8')); } catch (e) { store = {}; }
  const hit = store[year];
  if (hit && hit.fetchedAt && Date.now() - hit.fetchedAt < HOLIDAY_TTL) return hit.data || {};
  try {
    const res = await fetch('https://timor.tech/api/holiday/year/' + year, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const data = (json && json.holiday) || {};
    store[year] = { fetchedAt: Date.now(), data };
    await fs.writeFile(HOLIDAY_CACHE_FILE, JSON.stringify(store), 'utf8');
    return data;
  } catch (e) {
    console.error('[节假日] 获取失败，使用旧缓存:', e.message);
    return (hit && hit.data) || {};
  }
}

async function getHolidayInfo(date) {
  const map = await getHolidayMap(date.getFullYear());
  return map[holidayKey(date)] || null;   // { holiday: true/false, name }
}

// 节假日前一天提醒：明天开始放假 → 推送整个假期值班安排
async function sendHolidayEveReminder(today) {
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const tInfo = await getHolidayInfo(tomorrow);
  if (!tInfo || !tInfo.holiday) return;          // 明天不是放假
  const todayInfo = await getHolidayInfo(today);
  if (todayInfo && todayInfo.holiday) return;    // 已在假期中，只在假期前一天提醒

  // 收集连续假期（最多 15 天，防接口异常死循环）
  const days = [];
  const cursor = new Date(tomorrow);
  for (let i = 0; i < 15; i++) {
    const info = await getHolidayInfo(cursor);
    if (!info || !info.holiday) break;
    days.push({ date: new Date(cursor), name: info.name || '' });
    cursor.setDate(cursor.getDate() + 1);
  }
  if (!days.length) return;

  const dutySchedule = await loadDutySchedule();
  const lines = [];
  const mobiles = [];
  for (const d of days) {
    const ds = formatDate(d.date);
    const person = dutySchedule[ds] || '轮空';
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    lines.push(`【${ds}（${weekNames[d.date.getDay()]}）】：${person}`);
    if (person && person !== '轮空') {
      const m = await getMobileByName(person);
      if (m && !mobiles.includes(m)) mobiles.push(m);
    }
  }

  const holidayName = days[0].name || '假期';
  const message = `🏖 ${holidayName}假期提醒：\n明天（${formatDate(tomorrow)}）起放假 ${days.length} 天，假期值班安排如下：\n${lines.join('\n')}\n请值班同学提前做好准备，离开前检查电脑关闭情况～`;
  await sendMessage(message, mobiles);
  console.log(`【节假日】已发送「${holidayName}」假期前提醒（假期 ${days.length} 天）`);
}

// 发送周一本周7天汇总（Markdown 表格）
async function sendWeeklySummary(mondayDate) {
  const dutySchedule = await loadDutySchedule();

  // 计算周一到周日
  const weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const startDate = new Date(mondayDate);

  let tableRows = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const dateStr = formatDate(d);
    const person = dutySchedule[dateStr] || '轮空';
    tableRows += `| ${dateStr} | ${weekDays[i]} | ${person} |\n`;
  }

  const markdownText = `## 📅 本周值班安排（${formatDate(startDate)} ~ ${formatDate(new Date(startDate.getTime() + 6*86400000))}）\n\n| 日期 | 星期 | 值日人员 |\n|------|------|----------|\n${tableRows}\n> 请值日同学记得检查电脑关闭情况 🔌`;

  await sendMarkdownMessage('本周值班安排', markdownText);
}

// 核心任务：每日9点执行
async function runDailyTask() {
  const today = new Date();
  const todayStr = formatDate(today);
  const dayOfWeek = today.getDay(); // 0=周日, 1=周一...5=周五, 6=周六

  console.log(`===== 执行${todayStr}值日提醒任务 =====`);

  // 1. 发送当日值日提醒（每天都执行）
  await sendDailyReminder(todayStr);

  // 1.5 节假日前一天提醒（明天开始放假时）
  try {
    await sendHolidayEveReminder(today);
  } catch (e) {
    console.error('节假日提醒失败:', e.message);
  }

  // 2. 周一发送本周7天汇总
  if (dayOfWeek === 1) {
    console.log('今日是周一，发送本周值班汇总');
    await sendWeeklySummary(today);
  }

  // 3. 周五仅发送周六+周日的汇总提醒
  if (dayOfWeek === 5) {
    console.log('今日是周五，发送周六+周日值日提醒');
    await sendWeekendSummaryReminder(today);
  }
}

// 启动定时任务
function startSchedule() {
  schedule.scheduleJob(CONFIG.DAILY_CRON, runDailyTask);
  console.log(`✅ 值日提醒服务已启动
- 每日提醒时间：9:00
- 周一：发送本周7天汇总（Markdown表格）
- 周五：发送周六+周日提前预告\n- 节假日前一天：发送假期值班安排提醒
- 配置文件路径：${CONFIG.DUTY_SCHEDULE_FILE}`);
}

// 启动服务（被 require 时不自启，便于测试）
if (require.main === module) {
  startSchedule();
}

module.exports = { runDailyTask, sendHolidayEveReminder, sendDailyReminder, sendWeeklySummary };

// 全局异常捕获
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获异常:', error.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Promise拒绝:', reason);
});
