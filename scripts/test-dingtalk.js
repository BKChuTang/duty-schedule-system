// 钉钉消息测试脚本（带全量错误捕获）
const axios = require('axios');

// ========== 替换成你的真实 Webhook ==========
// 获取方式：钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → 复制 Webhook
// 示例：https://oapi.dingtalk.com/robot/send?access_token=abcdef1234567890
// 推荐用环境变量注入，避免真实 token 进入代码仓库：
//   DINGTALK_WEBHOOK_URL='https://oapi.dingtalk.com/...' node scripts/test-dingtalk.js
const DINGTALK_WEBHOOK_URL = process.env.DINGTALK_WEBHOOK_URL
  || 'https://oapi.dingtalk.com/robot/send?access_token=YOUR_DINGTALK_ACCESS_TOKEN';

/**
 * 测试钉钉消息发送（带详细错误排查）
 * @param {string} testMsg 测试消息内容
 * @param {string[]} atMobiles 要@的手机号（可选）
 */
async function testDingTalkMessage(testMsg = '📅 测试：这是一条手动测试消息', atMobiles = []) {
  console.log('========== 开始测试钉钉消息发送 ==========');
  console.log(`测试时间：${new Date().toLocaleString()}`);
  console.log(`Webhook地址：${DINGTALK_WEBHOOK_URL.substring(0, 50)}...`);
  console.log(`要@的手机号：${atMobiles.join(', ') || '无'}`);
  console.log('------------------------------------------');

  try {
    // 1. 测试网络连通性（先ping钉钉接口）
    console.log('1. 测试钉钉接口网络连通性...');
    const pingRes = await axios.get('https://oapi.dingtalk.com/robot/send', {
      timeout: 5000,
      validateStatus: () => true // 忽略404等状态码，只看是否能连通
    });
    console.log(`   ✅ 网络连通成功，状态码：${pingRes.status}`);

    // 2. 发送测试消息
    console.log('2. 发送测试消息到钉钉...');
    const sendRes = await axios.post(
      DINGTALK_WEBHOOK_URL,
      {
        msgtype: 'text',
        text: { content: testMsg },
        at: {
          isAtAll: false,
          atMobiles: atMobiles.filter(m => /^\d{11}$/.test(m)) // 过滤无效手机号
        }
      },
      {
        timeout: 10000, // 10秒超时
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        }
      }
    );

    // 3. 解析钉钉返回结果
    console.log('3. 解析钉钉接口返回结果...');
    console.log(`   接口返回原始数据：${JSON.stringify(sendRes.data)}`);
    
    if (sendRes.data.errcode === 0) {
      console.log('✅ 测试消息发送成功！请查看钉钉群确认。');
    } else {
      console.error(`❌ 钉钉接口返回错误：`);
      console.error(`   错误码：${sendRes.data.errcode}`);
      console.error(`   错误信息：${sendRes.data.errmsg}`);
      // 常见错误码解释
      const errorMap = {
        300001: '无效的access_token（Webhook里的token错了）',
        40035: '缺少必填参数（消息格式错误）',
        40093: 'atMobiles格式错误（手机号不是11位）',
        50000: '钉钉服务器内部错误（稍后重试）'
      };
      if (errorMap[sendRes.data.errcode]) {
        console.error(`   错误原因：${errorMap[sendRes.data.errcode]}`);
      }
    }

  } catch (error) {
    console.error('❌ 消息发送失败，错误详情：');
    // 分类展示错误类型
    if (error.code === 'ECONNREFUSED' || error.code === 'ENETUNREACH') {
      console.error(`   网络错误：服务器无法连接到钉钉接口（防火墙/网络配置问题）`);
    } else if (error.code === 'ETIMEDOUT') {
      console.error(`   超时错误：请求钉钉接口超时（网络延迟/钉钉服务器忙）`);
    } else if (error.response) {
      console.error(`   HTTP错误：状态码 ${error.response.status}`);
      console.error(`   错误内容：${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error(`   请求错误：发送了请求，但未收到响应（网络/钉钉接口故障）`);
    } else {
      console.error(`   其他错误：${error.message}`);
    }
    console.error(`   完整错误栈：${error.stack.substring(0, 200)}...`);
  }

  console.log('========== 测试结束 ==========');
}

// ========== 执行测试 ==========
// 可选：添加要@的手机号（比如测试@褚二）
const testAtMobiles = ['13800000001']; 
// 执行测试
testDingTalkMessage('📅 值日提醒测试：这是一条带错误捕获的测试消息', testAtMobiles);
