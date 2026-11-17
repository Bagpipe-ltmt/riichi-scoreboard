'use strict';

/**
 * 把一个账号设成管理员（或者顺手新建一个管理员账号）。
 *
 *   node service/set-admin.js 昵称 密码
 *   node service/set-admin.js 昵称 密码 --new      # 账号不存在时新建
 *
 * 用法上的两个要点：
 *   1) 改数据前先停服务（service\stop.cmd），否则服务内存里的旧数据会在下次写入时覆盖回去。
 *   2) 跑完再启动（service\start.cmd）。
 *
 * 为什么不直接走 HTTP 接口：/api/admin 系列接口全部要求「已经是管理员」，
 * 第一个管理员只能从数据层给，这是鸡生蛋的问题。
 */

const path = require('path');
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));

function usage(msg) {
  if (msg) console.error('错误：' + msg + '\n');
  console.error('用法：node service\\set-admin.js <昵称> <密码> [--new]');
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== '--new');
const allowNew = process.argv.includes('--new');
const [name, password] = args;

if (!name) usage('缺少昵称');
if (!password) usage('缺少密码');
if (String(password).length < 4) usage('密码至少 4 位');

store.loadAll();

let user = store.findUserByName(name);
const created = !user;

if (!user) {
  if (!allowNew) {
    usage(`账号「${name}」不存在。加 --new 可以直接建一个管理员账号。`);
  }
  user = store.createUser(name, password, 'admin');
} else {
  store.setPassword(user, password);
  user.role = 'admin';
  store.save('users');
}

store.flushNow();

const others = store.listUsers().filter((u) => u.role === 'admin' && u.id !== user.id);

console.log('==============================================');
console.log((created ? '已新建管理员账号：' : '已设为管理员：') + user.name);
console.log('    密码：' + password);
console.log('    账号 ID：' + user.id);
if (others.length) {
  console.log('    另一并存在的管理员：' + others.map((u) => u.name).join('、') + '（保留作备用）');
}
console.log('');
console.log('登录地址：/admin      （局域网 http://<本机IP>:8080/admin）');
console.log('记得重启服务让界面生效：service\\start.cmd');
console.log('==============================================');
