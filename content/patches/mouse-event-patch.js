// content/patches/mouse-event-patch.js
// Cloudflare Turnstile 反检测：修复 Chromium 在 CDP Input.dispatchMouseEvent 下
// MouseEvent.screenX/screenY 与 x/y 相同的 bug。
// 参考：grok-register/script/turnstilePatch/script.js
(function patchMouseEventScreenCoords() {
  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  const screenX = getRandomInt(800, 1200);
  const screenY = getRandomInt(400, 600);
  try {
    Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX, configurable: true });
    Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY, configurable: true });
  } catch (_) {
    // 已被定义过，忽略
  }
})();
