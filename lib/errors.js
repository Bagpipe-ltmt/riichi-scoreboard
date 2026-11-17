'use strict';
/* 业务错误（用户输入不合法、状态不允许、权限不够…）。
 *
 * 约定：凡是「说给用户听」的错误都这样造，status 默认 400，message 直接显示在界面上。
 * 没有 status 的异常一律当程序 bug，返回 500 并把完整堆栈打到日志里。
 * 之前的毛病是这些提示都用 `new Error(...)` 抛，于是「昵称已被注册」这种
 * 用户输入问题也被当成 500，日志里还刷一堆没意义的堆栈。 */

function biz(message, code) {
  const e = new Error(message);
  e.status = 400;
  if (code) e.code = code;
  return e;
}

function isBiz(e) {
  return !!(e && Number.isInteger(e.status) && e.status >= 400 && e.status < 500);
}

module.exports = { biz, isBiz };
