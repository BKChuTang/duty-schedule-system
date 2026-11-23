// ===== 加载项目根目录 .env（若已安装 dotenv；未安装则只用系统环境变量，不影响运行）=====
try { require('dotenv').config(); } catch (e) { /* dotenv 未安装，忽略 */ }

const express = require('express');
const fs = require('fs');
const path = require('path');
const cookieParser = require('cookie-parser');
const { execSync } = require('child_process');
// 【可选功能】仅 Hermes 反代时需要（本项目其余代码未使用此包）
// const { createProxyMiddleware } = require('http-proxy-middleware');
const app = express();

/* ============================================================
 * 配置区（使用前请修改，生产环境建议全部用环境变量注入）
 * ============================================================ */
const PORT = Number(process.env.PORT) || 8080;          // 本服务监听端口
const BASE_PATH = process.env.BASE_PATH || '/zb';       // 访问路径前缀，如 https://你的域名/zb/
/* ===== 【可选功能，默认关闭】以下三项仅用于原项目私有的 Hermes 反代 =====
 * 与本项目核心功能（排班/提醒/记录）无关，开源版本已注释。
 * 需要时取消注释，并 npm i http-proxy http-proxy-middleware
 * ===================================================================== */
// const HERMES_TARGET = process.env.HERMES_TARGET || 'http://127.0.0.1:9119'; // 可选功能：反代目标地址
// const HERMES_PATH = process.env.HERMES_PATH || '/hermes';                   // 可选功能：反代路径前缀

// 【登录密码】值班编辑器（/zb/ 页面）的访问密码 —— 示例值，请务必修改
const ZB_PASSWORD = process.env.ZB_PASSWORD || 'change-me';
// 【登录密码】Hermes Web UI 反代页面的访问密码（不用该功能可忽略）
// const HERMES_PASSWORD = process.env.HERMES_PASSWORD || 'change-me-too';  // 可选功能：反代页面密码
// 【Cookie 签名密钥】随便改成一串长随机字符，泄露会导致登录 Cookie 可被伪造
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'change-this-cookie-secret';
const ZB_AUTH_COOKIE = 'duty_auth';
// const HERMES_AUTH_COOKIE = 'hermes_auth';   // 可选功能：反代登录 Cookie 名

app.use(cookieParser(COOKIE_SECRET));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));  // 日历 API

// 值班编辑器认证中间件
const zbAuth = (req, res, next) => {
  const authCookie = req.signedCookies[ZB_AUTH_COOKIE];
  if (authCookie === 'authenticated') {
    return next();
  }
  // 接口请求返回 401 JSON（便于前端/脚本识别），页面请求返回登录页
  if (req.originalUrl.indexOf(BASE_PATH + '/api/') === 0) {
    return res.status(401).json({ error: '未登录或会话已过期，请刷新页面重新登录' });
  }
  // 未登录显示登录页
  let error = '';
  if (req.query.error) {
    error = '<div style="color: #f56c6c; margin-bottom: 20px;">密码错误，请重试</div>';
  }
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>登录 - 值班配置编辑器</title>
    <style>
      body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f7fa; }
      .login-box { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1); width: 300px; }
      h1 { text-align: center; margin-bottom: 30px; font-size: 20px; }
      .input-group { margin-bottom: 20px; }
      label { display: block; margin-bottom: 8px; font-weight: 500; }
      input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 16px; box-sizing: border-box; }
      button { width: 100%; background: #409eff; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-size: 16px; }
      button:hover { background: #66b1ff; }
    </style>
  </head>
  <body>
    <div class="login-box">
      <h1>值班配置编辑器</h1>
      ${error}
      <form method="POST" action="${BASE_PATH}/login">
        <div class="input-group">
          <label>请输入访问密码</label>
          <input type="password" name="password" placeholder="输入密码" required>
        </div>
        <button type="submit">登录</button>
      </form>
    </div>
  </body>
  </html>
  `);
};

// 值班编辑器登录接口
app.post(`${BASE_PATH}/login`, (req, res) => {
  const { password } = req.body;
  if (password === ZB_PASSWORD) {
    res.cookie(ZB_AUTH_COOKIE, 'authenticated', {
      signed: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7天有效期
      httpOnly: true
    });
    res.redirect(`${BASE_PATH}/`);
  } else {
    res.redirect(`${BASE_PATH}/?error=1`);
  }
});

// 值班编辑器登出接口
app.get(`${BASE_PATH}/logout`, (req, res) => {
  res.clearCookie(ZB_AUTH_COOKIE);
  res.redirect(`${BASE_PATH}/`);
});

// 值班编辑器路由
app.use(`${BASE_PATH}/`, (req, res, next) => {
  if (req.path === `${BASE_PATH}/login` || req.path === `${BASE_PATH}/logout`) {
    return next();
  }
  zbAuth(req, res, next);
});

// 要编辑的文件列表
const files = [
  { name: 'address.txt', path: path.join(__dirname, 'address.txt') },
  { name: 'duty_schedule.txt', path: path.join(__dirname, 'duty_schedule.txt') }
];

// 值班编辑器首页
app.get(`${BASE_PATH}/files`, (req, res) => {
  let html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>值班配置编辑器</title>
    <style>
      body { font-family: Arial, sans-serif; max-width: 1000px; margin: 20px auto; padding: 0 20px; }
      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
      .logout-btn { background: #909399; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; text-decoration: none; font-size: 14px; }
      .logout-btn:hover { background: #a6a9ad; }
      .file-block { margin-bottom: 30px; border: 1px solid #eee; padding: 20px; border-radius: 8px; }
      .action-block { margin-bottom: 30px; border: 1px solid #f56c6c; padding: 20px; border-radius: 8px; background: #fef0f0; }
      textarea { width: 100%; height: 300px; padding: 10px; font-family: monospace; font-size: 14px; border: 1px solid #ddd; border-radius: 4px; }
      .save-btn { background: #409eff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 16px; }
      .save-btn:hover { background: #66b1ff; }
      .restart-btn { background: #f56c6c; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 16px; }
      .restart-btn:hover { background: #f78989; }
      .success { color: #67c23a; margin: 10px 0; }
      .error { color: #f56c6c; margin: 10px 0; }
    </style>
  </head>
  <body>
    <div class="header">
      <h1>值班配置文件编辑器</h1>
      <a href="${BASE_PATH}/logout" class="logout-btn">退出登录</a>
    </div>
  `;

  if (req.query.success) {
    html += '<div class="success">保存成功！</div>';
  }
  if (req.query.restartSuccess) {
    html += '<div class="success">值班提醒服务重启成功！</div>';
  }
  if (req.query.restartError) {
    html += `<div class="error">服务重启失败：${decodeURIComponent(req.query.restartError)}</div>`;
  }

  // 服务说明区块
  html += `
  <div class="action-block">
    <h2 style="color:#f56c6c; font-weight:bold;">使用说明</h2>
    <p>系统默认在每日早9点发送值班提醒</p>
    <p>修改并保存下方值班人员信息和值班安排信息后系统会自动重启服务。<br>若没有生效可点击下方按钮：</p>
    <form method="POST" action="${BASE_PATH}/restart" onsubmit="return confirm('确定要重启值班提醒服务吗？')">
      <button type="submit" class="restart-btn">🔄 手动重启值班提醒服务</button>
    </form>
  </div>
  `;

  files.forEach(file => {
    const content = fs.readFileSync(file.path, 'utf8');
    let title, btnText;
    if (file.name === 'address.txt') {
      title = '值班人员联系人 <span style="color:#f56c6c; font-size:14px; font-weight:normal;">（要求人员在全员群中找得到，且手机号码与钉钉绑定号码一致）</span>';
      btnText = '保存 值班人员联系人';
    } else if (file.name === 'duty_schedule.txt') {
      title = '值班安排';
      btnText = '保存 值班安排';
    } else {
      title = file.name;
      btnText = `保存 ${file.name}`;
    }
    html += `
    <div class="file-block">
      <h2>${title}</h2>
      <form method="POST" action="${BASE_PATH}/save">
        <input type="hidden" name="filename" value="${file.name}">
        <textarea name="content">${content.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
        <br><br>
        <button type="submit" class="save-btn">${btnText}</button>
      </form>
    </div>
    `;
  });

  html += `
  </body>
  </html>
  `;
  res.send(html);
});

// 值班编辑器保存文件
app.post(`${BASE_PATH}/save`, (req, res) => {
  const { filename, content } = req.body;
  const file = files.find(f => f.name === filename);
  if (!file) {
    return res.status(400).send('无效的文件名');
  }
  fs.writeFileSync(file.path, content, 'utf8');
  res.redirect(`${BASE_PATH}/?success=1`);
});

// 值班编辑器重启服务接口
app.post(`${BASE_PATH}/restart`, (req, res) => {
  try {
    execSync('pm2 restart duty-reminder', { timeout: 10000, stdio: 'ignore' });
    res.redirect(`${BASE_PATH}/?restartSuccess=1`);
  } catch (error) {
    res.redirect(`${BASE_PATH}/?restartError=${encodeURIComponent(error.message)}`);
  }
});

// ==================== 值班日历编辑 ====================
require('./calendar-routes')(app, { BASE_PATH });

/* ============================================================
 * 【可选功能，本仓库默认关闭】原作者的 Hermes Dashboard 反代实现
 * 作用：把本机 9119 端口的 Hermes Web UI 反代到 /hermes，加密码保护，
 *       并重写 HTML 绝对路径、处理 WebSocket 升级。
 * 与值班系统核心功能无关，故开源版本整段注释，保留仅供参考。
 * 启用方法：取消本段注释 → npm i http-proxy http-proxy-middleware
 *           → 在 .env 设置 HERMES_PASSWORD / HERMES_TARGET / HERMES_PATH
 * ============================================================ */

// // ==================== Hermes Dashboard 代理 ====================

// // Hermes 代理配置（selfHandleResponse 手动重写路径）
// const httpProxy = require('http-proxy');
// const hermesProxy = httpProxy.createProxyServer({
//   target: HERMES_TARGET,
//   changeOrigin: true,
//   xfwd: true,
//   proxyTimeout: 86400000,
//   timeout: 86400000,
//   selfHandleResponse: true
// });

// hermesProxy.on('proxyRes', (proxyRes, req, res) => {
//   const ct = proxyRes.headers['content-type'] || '';
//   const isRewrite = ct.includes('text/html') || ct.includes('javascript');

//   if (isRewrite) {
//     delete proxyRes.headers['content-length'];
//     let body = '';
//     proxyRes.on('data', chunk => { body += chunk.toString(); });
//     proxyRes.on('end', () => {
//       // 复制响应头
//       Object.keys(proxyRes.headers).forEach(k => {
//         if (k !== 'content-length') res.setHeader(k, proxyRes.headers[k]);
//       });
//       // 路径重写
//       body = body
//         .replace(/__HERMES_BASE_PATH__=""/g, '__HERMES_BASE_PATH__="/hermes"')
//         .replace(/(src|href)="\/([^"]+)"/g, '$1="/hermes/$2"')
//         .replace(/location\.href\s*=\s*["']\/(?!\/)/g, 'location.href="/hermes/')
//         .replace(/from\s*["']\/(assets\/|api\/)/g, 'from "/hermes/$1')
//         .replace(/import\s*\(\s*["']\/(assets\/|api\/)/g, 'import("/hermes/$1');
//       res.end(body);
//     });
//   } else {
//     // 非 HTML/JS 直接透传
//     Object.keys(proxyRes.headers).forEach(k => {
//       res.setHeader(k, proxyRes.headers[k]);
//     });
//     proxyRes.pipe(res);
//   }
// });

// hermesProxy.on('error', (err, req, res) => {
//   res.writeHead(502, { 'Content-Type': 'text/plain' });
//   res.end('Proxy error');
// });

// // Hermes 认证中间件
// const hermesAuth = (req, res, next) => {
//   const authCookie = req.signedCookies[HERMES_AUTH_COOKIE];
//   if (authCookie === 'authenticated') {
//     return next();
//   }
//   let error = '';
//   if (req.query.error) {
//     error = '<div style="color: #f56c6c; margin-bottom: 20px;">密码错误，请重试</div>';
//   }
//   res.send(`
//   <!DOCTYPE html>
//   <html>
//   <head>
//     <meta charset="UTF-8">
//     <title>登录 - Hermes Web UI</title>
//     <style>
//       body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f7fa; }
//       .login-box { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 12px 0 rgba(0, 0, 0, 0.1); width: 300px; }
//       h1 { text-align: center; margin-bottom: 30px; font-size: 20px; }
//       .input-group { margin-bottom: 20px; }
//       label { display: block; margin-bottom: 8px; font-weight: 500; }
//       input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 16px; box-sizing: border-box; }
//       button { width: 100%; background: #667eea; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-size: 16px; }
//       button:hover { background: #764ba2; }
//     </style>
//   </head>
//   <body>
//     <div class="login-box">
//       <h1>🔮 Hermes Web UI</h1>
//       ${error}
//       <form method="POST" action="/hermes-login">
//         <div class="input-group">
//           <label>请输入访问密码</label>
//           <input type="password" name="password" placeholder="输入密码" required>
//         </div>
//         <button type="submit">登录</button>
//       </form>
//     </div>
//   </body>
//   </html>
//   `);
// };

// // Hermes 登录接口
// app.post('/hermes-login', (req, res) => {
//   const { password } = req.body;
//   if (password === HERMES_PASSWORD) {
//     res.cookie(HERMES_AUTH_COOKIE, 'authenticated', {
//       signed: true,
//       maxAge: 7 * 24 * 60 * 60 * 1000,
//       httpOnly: true
//     });
//     res.redirect('/hermes/');
//   } else {
//     res.redirect('/hermes/?error=1');
//   }
// });

// // Hermes 代理路由（手动转发，支持路径重写）
// app.use('/hermes', (req, res, next) => {
//   if (req.path === '/hermes-login') return next();
//   hermesAuth(req, res, () => {
//     // 重写路径去掉 /hermes 前缀
//     req.url = req.url.replace(/^\/hermes/, '') || '/';
//     hermesProxy.web(req, res);
//   });
// });

// // 处理 WebSocket 升级（Hermes 热更新需要）
// app.on('upgrade', (req, socket, head) => {
//   if (req.url.startsWith('/hermes')) {
//     const cookie = req.headers.cookie;
//     let authenticated = false;
//     if (cookie) {
//       const cookies = cookie.split(';').map(c => c.trim());
//       for (const c of cookies) {
//         if (c.startsWith(`${HERMES_AUTH_COOKIE}=`)) {
//           const value = c.split('=')[1];
//           try {
//             const decoded = cookieParser.signedCookie(decodeURIComponent(value), COOKIE_SECRET);
//             if (decoded === 'authenticated') authenticated = true;
//           } catch (e) {}
//           break;
//         }
//       }
//     }
//     if (!authenticated) {
//       socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
//       socket.destroy();
//       return;
//     }
//     req.url = req.url.replace(/^\/hermes/, '') || '/';
//     hermesProxy.ws(req, socket, head);
//   }
// });

// // ==================== 导航页 ====================

// // 根路径 - Hermes 导航页

app.get('/', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <title>值班管理系统</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; }
      .card { background: white; border-radius: 16px; padding: 60px 50px; box-shadow: 0 20px 60px rgba(0,0,0,0.2); text-align: center; max-width: 450px; width: 90%; }
      .icon { font-size: 64px; margin-bottom: 20px; }
      h1 { font-size: 28px; color: #303133; margin-bottom: 8px; }
      p { color: #909399; margin-bottom: 30px; font-size: 15px; line-height: 1.6; }
      .btn-group { display: flex; flex-direction: column; gap: 14px; }
      .btn { display: block; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; padding: 14px 36px; border-radius: 8px; font-size: 16px; font-weight: 500; transition: transform 0.2s, box-shadow 0.2s; }
      .btn:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4); }
      .btn-hermes { background: linear-gradient(135deg, #11998e, #38ef7d); }
      .btn-hermes:hover { box-shadow: 0 8px 25px rgba(17, 153, 142, 0.4); }
      .footer { margin-top: 30px; font-size: 12px; color: #c0c4cc; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">📋</div>
      <h1>值班管理系统</h1>
      <p>管理每日值日排班和人员通讯录</p>
      <div class="btn-group">
        <a href="/zb/" class="btn">📝 值班编辑器</a>
        <a href="/hermes/" class="btn btn-hermes">🔮 Hermes Web UI</a>
      </div>
      <div class="footer">由 Hermes Agent 提供支持 · 通过微信/QQ 发送指令操作</div>
    </div>
  </body>
  </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`值班管理系统已启动`);
  console.log(`值班编辑器：https://your-domain.com/zb  密码：${ZB_PASSWORD}`);
//   console.log(`Hermes Web UI：https://your-domain.com/hermes  密码：${HERMES_PASSWORD}`);   // 可选功能未启用时不打印
});
