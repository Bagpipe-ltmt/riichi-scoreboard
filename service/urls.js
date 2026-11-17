const os = require('os');
const { execFileSync } = require('child_process');
const path = require('path');
const port = process.env.PORT || 8080;

const lan = [];
let ts = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const i of list || []) {
    if (i.family !== 'IPv4' || i.internal) continue;
    // 100.64.0.0/10 = Tailscale 的 CGNAT 段
    const o = i.address.split('.').map(Number);
    const isTailscale = o[0] === 100 && o[1] >= 64 && o[1] <= 127;
    (isTailscale ? ts : lan).push(i.address);
  }
}
if (!lan.length && !ts.length) lan.push('127.0.0.1');

const show = (ip) => {
  console.log('   场风盘  http://' + ip + ':' + port + '/table');
  console.log('   玩家端  http://' + ip + ':' + port + '/player');
};

const pub = (() => {
  try {
    const ini = require('fs').readFileSync(path.join(__dirname, 'frpc.ini'), 'utf8');
    const m = ini.match(/^\s*#\s*public:\s*(\S+)/m);
    return m ? m[1] : '';
  } catch (e) { return ''; }
})();

console.log('【在外面 · 走公网（不用装任何东西，手机流量也能打开）】');
if (pub) {
  console.log('   场风盘  https://' + pub + '/table');
  console.log('   玩家端  https://' + pub + '/player');
  console.log('   管理员端 https://' + pub + '/admin');
  console.log('   （樱花frp 隧道，首次打开可能要等 3~5 秒）');
} else {
  console.log('   未配置（不存在 service\\frpc.ini，或里面没有 "# public:" 那一行）');
}
console.log('');

if (lan.length) {
  console.log('【在家 · 同一个 Wi-Fi】');
  lan.forEach(show);
} else {
  console.log('【在家 · 同一个 Wi-Fi】');
  console.log('   未检测到局域网 IP（网线没插或 Wi-Fi 没连上）');
}

console.log('');
console.log('【出门 · Tailscale】');
if (ts.length) {
  ts.forEach(show);
  console.log('   手机装 Tailscale 并登录同一个账号，就能用上面这个地址。');
} else {
  // 退一步：直接问 tailscale 要地址（网卡刚起来时可能还没进上面那张表）
  let ip = '';
  const exe = [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    path.join(__dirname, '..', 'runtime', 'tailscale.exe'),
  ].find((p) => { try { return require('fs').existsSync(p); } catch (e) { return false; } });
  if (exe) {
    try { ip = execFileSync(exe, ['ip', '-4'], { encoding: 'utf8', timeout: 4000 }).trim().split('\n')[0].trim(); } catch (e) { ip = ''; }
  }
  if (ip) {
    show(ip);
    console.log('   手机装 Tailscale 并登录同一个账号，就能用上面这个地址。');
  } else {
    console.log('   未连接（Tailscale 没登录或没开）。在 Tailscale 托盘图标里点 Log in 即可。');
  }
}

console.log('');
console.log('   本机名  http://' + os.hostname() + ':' + port + '/table  （局域网内部分设备可解析）');
