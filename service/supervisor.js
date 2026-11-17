'use strict';
// 立直麻将场风盘 - 守护进程
// 1) 拉起 server.js，进程意外退出时自动重启；日志统一写 server.log（超过 5MB 轮转）
// 2) 若存在 service/frpc.conf 且 runtime/frpc.exe 就位，同时拉起樱花frp 客户端（内网穿透）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOG = path.join(ROOT, 'server.log');
const MAX_LOG = 5 * 1024 * 1024;
const RESTART_DELAY = 4000;
const RAPID_MS = 5000;
const MAX_RAPID = 10;

const FRPC_EXE = path.join(ROOT, 'runtime', 'frpc.exe');
const FRPC_INI = path.join(ROOT, 'service', 'frpc.ini');
const FRPC_CONF = path.join(ROOT, 'service', 'frpc.conf');

let rapid = 0;
let stopping = false;
let out = 'ignore';

function stamp(msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '[' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '] ' + msg + '\n';
}
function note(msg) { try { fs.appendFileSync(LOG, stamp(msg)); } catch (e) {} }

function openLog() {
  try { if (fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, LOG + '.1'); } catch (e) {}
  try { out = fs.openSync(LOG, 'a'); } catch (e) { out = 'ignore'; }
}

/* ---------------------------- server.js ---------------------------- */
function launch() {
  openLog();
  note('启动服务器（node ' + process.version + '）');
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { HOST: process.env.HOST || '0.0.0.0', PORT: process.env.PORT || '8080' })
  });
  try { fs.writeFileSync(path.join(ROOT, 'server.pid'), String(child.pid)); } catch (e) {}
  child.on('exit', (code, signal) => {
    try { fs.rmSync(path.join(ROOT, 'server.pid'), { force: true }); } catch (e) {}
    if (stopping) { note('服务器已停止'); return; }
    const alive = Date.now() - started;
    rapid = alive < RAPID_MS ? rapid + 1 : 0;
    note('服务器退出（code=' + code + ' signal=' + signal + '，运行 ' + Math.round(alive / 1000) + ' 秒）');
    if (rapid >= MAX_RAPID) {
      note('连续 ' + rapid + ' 次秒退，暂停 60 秒后重试');
      setTimeout(() => { rapid = 0; launch(); }, 60000);
    } else {
      note(Math.round(RESTART_DELAY / 1000) + ' 秒后重启');
      setTimeout(launch, RESTART_DELAY);
    }
  });
}

/* ------------------------ 樱花frp 客户端（可选） ------------------------ */
// frpc.conf 是一行纯文本：  -f <访问密钥>:<隧道ID>
// 没有这个文件、或者没放 runtime/frpc.exe 时，这一段完全不生效。
let frpcRapid = 0;
let frpcStartedAt = 0;

function readFrpcArgs() {
  try {
    if (!fs.existsSync(FRPC_EXE)) return null;
    // 优先用 frpc.ini：里面可以写 auto_https（国内节点访问网页必须开，否则被拦 501）
    if (fs.existsSync(FRPC_INI)) {
      const raw = fs.readFileSync(FRPC_INI, 'utf8');
      if (!raw.trim() || raw.trim().startsWith('#')) return null;
      return ['-c', FRPC_INI];
    }
    if (!fs.existsSync(FRPC_CONF)) return null;
    const raw = fs.readFileSync(FRPC_CONF, 'utf8').trim();
    if (!raw || raw.startsWith('#')) return null;
    return raw.split(/\s+/).filter(Boolean);
  } catch (e) { return null; }
}

// 樱花frp 会拒绝「非内地 IP」启动内地节点隧道。
// 这台机器装了代理软件（HTTP_PROXY 等环境变量），frpc 若走了代理就会从境外出口连接，
// 所以这里把代理变量全部剥掉，并强制 --proxy none。
function cleanEnv() {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
  }
  return env;
}

function launchTunnel() {
  const args = readFrpcArgs();
  if (!args) return;
  if (!args.includes('--proxy')) args.push('--proxy', 'none');
  if (!args.includes('--disable_log_color')) args.push('--disable_log_color');
  openLog();
  note('启动内网穿透客户端：frpc ' + args.join(' ').replace(/(-f\s+\S{6})\S*/i, '$1…'));
  frpcStartedAt = Date.now();
  let child;
  try {
    child = spawn(FRPC_EXE, args, { cwd: ROOT, stdio: ['ignore', out, out], env: cleanEnv() });
  } catch (e) {
    note('内网穿透客户端启动失败：' + e.message);
    return;
  }
  child.on('error', (e) => note('内网穿透客户端出错：' + e.message));
  child.on('exit', (code, signal) => {
    if (stopping) return;
    const alive = Date.now() - frpcStartedAt;
    frpcRapid = alive < RAPID_MS ? frpcRapid + 1 : 0;
    note('内网穿透客户端退出（code=' + code + ' signal=' + signal + '，运行 ' + Math.round(alive / 1000) + ' 秒）');
    const delay = frpcRapid >= MAX_RAPID ? 60000 : 5000;
    if (frpcRapid >= MAX_RAPID) frpcRapid = 0;
    setTimeout(launchTunnel, delay);
  });
}

/* -------------------------------- 生命周期 -------------------------------- */
function shutdown() {
  stopping = true;
  // 让子进程跟着退出（Windows 上以 taskkill 整棵树收起）
  try {
    const pid = parseInt(fs.readFileSync(path.join(ROOT, 'server.pid'), 'utf8'), 10);
    if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch (e) {}
  note('守护进程收到退出信号');
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

launch();
launchTunnel();
