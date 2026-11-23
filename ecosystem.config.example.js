/**
 * PM2 启动配置
 *
 * 使用方式：
 *   pm2 start ecosystem.config.js
 *   pm2 save              # 保存进程列表，开机/重启后自动恢复
 *
 * ⚠️ 重要提示：
 *   1. cwd 请改成你服务器上的实际项目路径
 *   2. 钉钉 Webhook 等敏感信息请放到环境变量或本文件的 env 里，不要把真实 token 提交到仓库
 *   3. 真实项目建议把本文件名加入 .gitignore，改用 ecosystem.config.example.js 版本
 */
module.exports = {
  apps: [
    {
      // ---------- 值班提醒服务（定时推送钉钉消息） ----------
      name: 'duty-reminder',
      script: './workday.js',
      cwd: '/opt/duty-reminder',      // ← 改成你服务器上的实际路径
      instances: 1,
      exec_mode: 'fork',
      // 监听排班表与通讯录文件，改动后自动重启并重新加载数据
      watch: ['./*.txt'],
      watch_options: {
        followSymlinks: false,
        ignored: ['node_modules', '*.log', 'ecosystem.config.js']
      },
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
        // 钉钉机器人 Webhook（示例占位，请替换为真实地址，或用系统环境变量注入）
        // 形如：https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890
        DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=YOUR_DINGTALK_ACCESS_TOKEN',
        // 每日提醒时间（cron 表达式），默认每天 9:00
        DAILY_CRON: '0 9 * * *'
      },
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/var/log/duty-reminder/err.log',   // ← 目录需提前创建并有写权限
      out_file: '/var/log/duty-reminder/out.log',
      combine_logs: true
    },
    {
      // ---------- 值班编辑器 Web 服务（日历 / 人员管理 / 记录查询） ----------
      name: 'duty-file-editor',
      script: './file-editor.js',
      cwd: '/opt/duty-reminder',      // ← 改成你服务器上的实际路径
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Shanghai',
        PORT: 8080,
        // ⚠️ 下面三项是登录凭据，示例值仅供演示，务必改成你自己的
        ZB_PASSWORD: 'change-me',              // 编辑器登录密码
        HERMES_PASSWORD: 'change-me-too',      // Hermes 反代页面密码（不用可忽略）
        COOKIE_SECRET: 'change-this-cookie-secret' // Cookie 签名密钥，改成随机长串
      },
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/var/log/duty-reminder/editor-err.log',
      out_file: '/var/log/duty-reminder/editor-out.log',
      combine_logs: true
    }
  ]
};
