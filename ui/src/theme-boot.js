/**
 * 主题启动脚本 —— 必须是**普通脚本**，在 <head> 里同步执行
 *
 * ## 为什么不能放在 app.mjs 里
 *
 * app.mjs 是 `type="module"`，它是**延迟执行**的（等 HTML 解析完）。
 * 等它跑起来时，页面已经用默认主题画了一帧——选暗色的用户会看到闪白。
 *
 * 这个文件在 `<head>` 里同步执行，此时 <body> 还没解析完，
 * 设置 `data-theme` 就已经生效，不会闪。
 *
 * ## 为什么不用 inline script
 *
 * CSP 是 `script-src 'self'`，inline script 会被拦。
 * 所以必须是一个独立文件。
 *
 * 这里是唯一允许读写 localStorage 的地方；其余 UI 代码不碰存储。
 */
(function () {
  'use strict';

  var KEY = 'ling-bot:theme';

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'light' || v === 'dark' ? v : null;
    } catch (e) {
      // 存储不可用（隐私模式等）不是错误，回落到系统偏好
      return null;
    }
  }

  function systemPrefersDark() {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      return false;
    }
  }

  var saved = read();
  // 没选过就跟随系统；选过就用选过的，系统偏好不再覆盖用户的决定
  document.documentElement.setAttribute('data-theme', saved || (systemPrefersDark() ? 'dark' : 'light'));

  /**
   * 供 app.mjs 调用。
   *
   * @param {'light'|'dark'} theme
   */
  window.__setTheme = function (theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch (e) {
      /* 存不了就只在本次会话生效，不弹错 */
    }
  };

  /** @returns {'light'|'dark'} */
  window.__getTheme = function () {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  };
})();
