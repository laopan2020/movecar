/**
 * MoveCar 多用户智能挪车系统 - 并发隔离优化版
 * 隔离逻辑：每一个 KV 键值对都强制带上用户后缀，确保互不干扰
 * 新增：Webhook 通知 + 企业微信应用消息
 */

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

const CONFIG = {
  KV_TTL: 3600,         // 状态有效期：1 小时
  RATE_LIMIT_TTL: 60    // 单用户发送频率限制：60 秒
}

async function handleRequest(request) {
  const url = new URL(request.url)
  const path = url.pathname
  
  // 1. 提取用户 ID (小写处理)
  const userParam = url.searchParams.get('u') || 'default';
  const userKey = userParam.toLowerCase();

  // --- API 路由区 ---
  if (path === '/api/notify' && request.method === 'POST') {
    return handleNotify(request, url, userKey);
  }
  if (path === '/api/get-location') {
    return handleGetLocation(userKey);
  }
  if (path === '/api/owner-confirm' && request.method === 'POST') {
    return handleOwnerConfirmAction(request, userKey);
  }
  if (path === '/api/check-status') {
    return handleCheckStatus(userKey);
  }

  // --- 页面路由区 ---
  if (path === '/owner-confirm') {
    return renderOwnerPage(userKey);
  }

  // 默认进入扫码挪车首页
  return renderMainPage(url.origin, userKey);
}

/** * 配置读取：优先读取 用户专用变量 (如 PUSHPLUS_TOKEN_NIANBA)
 */
function getUserConfig(userKey, envPrefix) {
  const specificKey = envPrefix + "_" + userKey.toUpperCase();
  if (typeof globalThis[specificKey] !== 'undefined') return globalThis[specificKey];
  if (typeof globalThis[envPrefix] !== 'undefined') return globalThis[envPrefix];
  return null;
}

// 坐标转换 (WGS-84 转 GCJ-02)
function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0; const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lng };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}
function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: "https://uri.amap.com/marker?position=" + gcj.lng + "," + gcj.lat + "&name=扫码者位置",
    appleUrl: "https://maps.apple.com/?ll=" + gcj.lat + "," + gcj.lng + "&q=扫码者位置"
  };
}

/** 发送通用 Webhook */
async function sendWebhook(webhookUrl, title, content, confirmUrl) {
  const payload = {
    title: title,
    content: content,
    url: confirmUrl,
    timestamp: Date.now()
  };
  return fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

/** 发送企业微信应用消息（文本卡片） */
async function sendWecomApp(userKey, corpid, agentid, secret, touser, title, content, confirmUrl) {
  // 尝试从 KV 获取缓存的 access_token
  const tokenKey = `wecom_token_${userKey}`;
  let accessToken = await MOVE_CAR_STATUS.get(tokenKey);
  
  if (!accessToken) {
    // 获取新 token
    const tokenUrl = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpid}&corpsecret=${secret}`;
    const tokenResp = await fetch(tokenUrl);
    const tokenData = await tokenResp.json();
    if (tokenData.errcode !== 0) {
      throw new Error(`企业微信获取 token 失败: ${tokenData.errmsg}`);
    }
    accessToken = tokenData.access_token;
    // 缓存 token，设置 7000 秒过期（官方 7200 秒）
    await MOVE_CAR_STATUS.put(tokenKey, accessToken, { expirationTtl: 7000 });
  }

  // 构建文本卡片消息
  const message = {
    touser: touser || '@all',
    msgtype: 'textcard',
    agentid: parseInt(agentid),
    textcard: {
      title: title,
      description: content.replace(/\\n/g, '\n'), // 将文字换行符转换为真实换行
      url: confirmUrl,
      btntxt: '前往确认'
    }
  };

  const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${accessToken}`;
  const sendResp = await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message)
  });
  const sendData = await sendResp.json();
  if (sendData.errcode !== 0) {
    // 如果 token 过期，尝试刷新一次
    if (sendData.errcode === 42001 || sendData.errcode === 40014) {
      await MOVE_CAR_STATUS.delete(tokenKey);
      return sendWecomApp(userKey, corpid, agentid, secret, touser, title, content, confirmUrl); // 重试
    }
    throw new Error(`企业微信发送失败: ${sendData.errmsg}`);
  }
  return sendData;
}

/** 发送通知逻辑 **/
async function handleNotify(request, url, userKey) {
  try {
    if (typeof MOVE_CAR_STATUS === 'undefined') throw new Error('KV 未绑定，请检查 Worker 设置');

    // --- 关键修改：锁定键带上 userKey，实现每个用户独立计时 ---
    const lockKey = "lock_" + userKey;
    const isLocked = await MOVE_CAR_STATUS.get(lockKey);
    if (isLocked) throw new Error('发送太频繁，请一分钟后再试');

    const body = await request.json();
    const message = body.message || '车旁有人等待';
    const location = body.location || null;
    const delayed = body.delayed || false;

    // 获取配置
    const ppToken = getUserConfig(userKey, 'PUSHPLUS_TOKEN');
    const barkUrl = getUserConfig(userKey, 'BARK_URL');
    const webhookUrl = getUserConfig(userKey, 'WEBHOOK_URL');
    const wecomCorpid = getUserConfig(userKey, 'WECOM_CORPID');
    const wecomAgentid = getUserConfig(userKey, 'WECOM_AGENTID');
    const wecomSecret = getUserConfig(userKey, 'WECOM_SECRET');
    const wecomTouser = getUserConfig(userKey, 'WECOM_TOUSER') || '@all';
    const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';

    const baseDomain = (typeof EXTERNAL_URL !== 'undefined' && EXTERNAL_URL) ? EXTERNAL_URL.replace(/\/$/, "") : url.origin;
    const confirmUrl = baseDomain + "/owner-confirm?u=" + userKey;

    let notifyText = "🚗 挪车请求【" + carTitle + "】\n💬 留言: " + message;
    
    // 隔离存储位置
    if (location && location.lat) {
      const maps = generateMapUrls(location.lat, location.lng);
      notifyText += "\n📍 已附带对方位置";
      await MOVE_CAR_STATUS.put("loc_" + userKey, JSON.stringify({ ...location, ...maps }), { expirationTtl: CONFIG.KV_TTL });
    }

    // 隔离存储挪车状态
    await MOVE_CAR_STATUS.put("status_" + userKey, 'waiting', { expirationTtl: CONFIG.KV_TTL });
    await MOVE_CAR_STATUS.delete("owner_loc_" + userKey);
    
    // 设置针对该用户的 60秒 锁定
    await MOVE_CAR_STATUS.put(lockKey, '1', { expirationTtl: CONFIG.RATE_LIMIT_TTL });

    if (delayed) await new Promise(r => setTimeout(r, 30000));

    const tasks = [];

    // PushPlus 通知
    if (ppToken) {
      const htmlMsg = notifyText.replace(/\n/g, '<br>') + '<br><br><a href="' + confirmUrl + '" style="font-weight:bold;color:#0093E9;font-size:18px;">【点击确认前往】</a>';
      tasks.push(fetch('http://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: ppToken, title: "🚗 挪车请求：" + carTitle, content: htmlMsg, template: 'html' })
      }));
    }

    // Bark 通知
    if (barkUrl) {
      tasks.push(fetch(barkUrl + "/" + encodeURIComponent('挪车请求') + "/" + encodeURIComponent(notifyText) + "?url=" + encodeURIComponent(confirmUrl)));
    }

    // 通用 Webhook 通知
    if (webhookUrl) {
      tasks.push(sendWebhook(webhookUrl, "挪车请求：" + carTitle, notifyText, confirmUrl));
    }

    // 企业微信应用消息
    if (wecomCorpid && wecomAgentid && wecomSecret) {
      tasks.push(sendWecomApp(userKey, wecomCorpid, wecomAgentid, wecomSecret, wecomTouser, "挪车请求：" + carTitle, notifyText, confirmUrl));
    }

    await Promise.all(tasks);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500 });
  }
}

async function handleCheckStatus(userKey) {
  const status = await MOVE_CAR_STATUS.get("status_" + userKey);
  const ownerLoc = await MOVE_CAR_STATUS.get("owner_loc_" + userKey);
  return new Response(JSON.stringify({
    status: status || 'waiting',
    ownerLocation: ownerLoc ? JSON.parse(ownerLoc) : null
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleGetLocation(userKey) {
  const data = await MOVE_CAR_STATUS.get("loc_" + userKey);
  return new Response(data || '{}', { headers: { 'Content-Type': 'application/json' } });
}

async function handleOwnerConfirmAction(request, userKey) {
  const body = await request.json();
  if (body.location) {
    const urls = generateMapUrls(body.location.lat, body.location.lng);
    await MOVE_CAR_STATUS.put("owner_loc_" + userKey, JSON.stringify({ ...body.location, ...urls }), { expirationTtl: 600 });
  }
  await MOVE_CAR_STATUS.put("status_" + userKey, 'confirmed', { expirationTtl: 600 });
  return new Response(JSON.stringify({ success: true }));
}

/** 界面渲染：请求者页 **/
function renderMainPage(origin, userKey) {
  const phone = getUserConfig(userKey, 'PHONE_NUMBER') || '';
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  const phoneHtml = phone ? '<a href="tel:' + phone + '" class="btn-phone">📞 拨打车主电话</a>' : '';

  return new Response(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, viewport-fit=cover">
  <title>通知车主挪车</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%); min-height: 100vh; padding: 20px; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 500px; display: flex; flex-direction: column; gap: 15px; }
    .card { background: white; border-radius: 24px; padding: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
    .header { text-align: center; }
    .icon-wrap { width: 70px; height: 70px; background: #0093E9; border-radius: 20px; display: flex; align-items: center; justify-content: center; margin: 0 auto 10px; font-size: 36px; color: white; }
    textarea { width: 100%; min-height: 100px; border: none; font-size: 16px; outline: none; resize: none; margin-top: 10px; }
    .tag-box { display: flex; gap: 8px; overflow-x: auto; margin-top: 10px; padding-bottom: 5px; }
    .tag { background: #f0f4f8; padding: 8px 16px; border-radius: 20px; font-size: 14px; white-space: nowrap; cursor: pointer; border: 1px solid #e1e8ed; }
    .btn-main { background: #0093E9; color: white; border: none; padding: 18px; border-radius: 18px; font-size: 18px; font-weight: bold; cursor: pointer; width: 100%; }
    .btn-phone { background: #ef4444; color: white; border: none; padding: 15px; border-radius: 15px; text-decoration: none; text-align: center; font-weight: bold; display: block; margin-top: 10px; }
    .btn-retry { background: #f59e0b; color: white; padding: 15px; border-radius: 15px; text-align: center; font-weight: bold; display: block; margin-top: 10px; border: none; width: 100%; cursor: pointer; }
    .hidden { display: none !important; }
    .map-links { display: flex; gap: 10px; margin-top: 15px; }
    .map-btn { flex: 1; padding: 12px; border-radius: 12px; text-align: center; text-decoration: none; color: white; font-size: 14px; font-weight: bold; }
    .amap { background: #1890ff; } .apple { background: #000; }
  </style>
</head>
<body>
  <div class="container" id="mainView">
    <div class="card header">
      <div class="icon-wrap">🚗</div>
      <h1>呼叫车主挪车</h1>
      <p style="color:#666; margin-top:5px">联络对象：${carTitle}</p>
    </div>
    <div class="card">
      <textarea id="msgInput" placeholder="留言给车主..."></textarea>
      <div class="tag-box">
        <div class="tag" onclick="setTag('您的车挡住我了')">🚧 挡路</div>
        <div class="tag" onclick="setTag('临时停靠一下')">⏱️ 临停</div>
        <div class="tag" onclick="setTag('急事，麻烦尽快')">🙏 加急</div>
      </div>
    </div>
    <div class="card" id="locStatus" style="font-size:14px; color:#666; text-align:center;">正在获取您的位置...</div>
    <button id="notifyBtn" class="btn-main" onclick="sendNotify()">🔔 发送通知</button>
  </div>

  <div class="container hidden" id="successView">
    <div class="card" style="text-align:center">
      <div style="font-size:60px; margin-bottom:15px">✅</div>
      <h2 style="margin-bottom:8px">通知已发出</h2>
      <p id="waitingText" style="color:#666">车主微信已收到提醒，请稍候</p>
    </div>
    <div id="ownerFeedback" class="card hidden" style="text-align:center">
      <div style="font-size:40px">🏃‍♂️</div>
      <h3 style="color:#059669">车主正赶往现场</h3>
      <div class="map-links">
        <a id="ownerAmap" href="#" class="map-btn amap">高德地图</a>
        <a id="ownerApple" href="#" class="map-btn apple">苹果地图</a>
      </div>
    </div>
    <div>
      <button class="btn-retry" onclick="location.reload()">再次通知</button>
      ${phoneHtml}
    </div>
  </div>

  <script>
    let userLoc = null;
    const userKey = "${userKey}";
    
    window.onload = () => {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(p => {
          userLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
          document.getElementById('locStatus').innerText = '📍 位置已锁定';
          document.getElementById('locStatus').style.color = '#059669';
        }, () => {
          document.getElementById('locStatus').innerText = '⚠️ 未能获取位置 (将延迟发送)';
        });
      }
    };

    function setTag(t) { document.getElementById('msgInput').value = t; }

    async function sendNotify() {
      const btn = document.getElementById('notifyBtn');
      btn.disabled = true; btn.innerText = '发送中...';
      try {
        const res = await fetch('/api/notify?u=' + userKey, {
          method: 'POST',
          body: JSON.stringify({ message: document.getElementById('msgInput').value, location: userLoc, delayed: !userLoc })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('mainView').classList.add('hidden');
          document.getElementById('successView').classList.remove('hidden');
          pollStatus();
        } else { alert(data.error); btn.disabled = false; btn.innerText = '🔔 发送通知'; }
      } catch(e) { alert('系统忙'); btn.disabled = false; }
    }

    function pollStatus() {
      setInterval(async () => {
        const res = await fetch('/api/check-status?u=' + userKey);
        const data = await res.json();
        if (data.status === 'confirmed') {
          document.getElementById('ownerFeedback').classList.remove('hidden');
          if (data.ownerLocation) {
            document.getElementById('ownerAmap').href = data.ownerLocation.amapUrl;
            document.getElementById('ownerApple').href = data.ownerLocation.appleUrl;
          }
        }
      }, 4000);
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

/** 界面渲染：车主页 **/
function renderOwnerPage(userKey) {
  const carTitle = getUserConfig(userKey, 'CAR_TITLE') || '车主';
  return new Response(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>车主确认</title>
  <style>
    body { font-family: sans-serif; background: #667eea; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin:0; padding:20px; }
    .card { background: white; padding: 30px; border-radius: 28px; text-align: center; width: 100%; max-width: 400px; }
    .btn { background: #10b981; color: white; border: none; width: 100%; padding: 20px; border-radius: 16px; font-size: 18px; font-weight: bold; cursor: pointer; margin-top: 20px; }
    .map-box { display: none; background: #f0f4ff; padding: 15px; border-radius: 15px; margin-top: 15px; }
    .map-btn { display: inline-block; padding: 10px 15px; background: #1890ff; color: white; text-decoration: none; border-radius: 10px; margin: 5px; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:45px">📢</div>
    <h2 style="margin:10px 0">${carTitle}</h2>
    <div id="mapArea" class="map-box">
      <p style="font-size:14px; color:#1e40af; margin-bottom:10px">对方位置已送达 📍</p>
      <a id="amapLink" href="#" class="map-btn">高德地图</a>
      <a id="appleLink" href="#" class="map-btn" style="background:#000">苹果地图</a>
    </div>
    <button id="confirmBtn" class="btn" onclick="confirmMove()">🚀 我已知晓，马上过去</button>
  </div>
  <script>
    const userKey = "${userKey}";
    window.onload = async () => {
      const res = await fetch('/api/get-location?u=' + userKey);
      const data = await res.json();
      if(data.amapUrl) {
        document.getElementById('mapArea').style.display = 'block';
        document.getElementById('amapLink').href = data.amapUrl;
        document.getElementById('appleLink').href = data.appleUrl;
      }
    };
    async function confirmMove() {
      const btn = document.getElementById('confirmBtn');
      btn.innerText = '已同步给对方'; btn.disabled = true;
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(async p => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: {lat: p.coords.latitude, lng: p.coords.longitude} }) });
        }, async () => {
          await fetch('/api/owner-confirm?u=' + userKey, { method: 'POST', body: JSON.stringify({ location: null }) });
        });
      }
    }
  </script>
</body>
</html>
`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}