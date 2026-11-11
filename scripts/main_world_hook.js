/**
 * Shield Minimal - Main World Hook
 * 运行在宿主页面的原生 JS 上下文中
 */
(function () {
  'use strict';

  // 1. 深度存根 (Scriptlet Stubs) - 欺骗常见反拦截探针
  const noop = () => {};
  const noopArray = [];

  const adStubs = {
    adsbygoogle: {
      loaded: true,
      push: function (args) { return 0; },
      op: noop
    },
    googletag: {
      cmd: [],
      display: noop,
      enableServices: noop,
      pubads: () => ({
        enableSingleRequest: noop,
        collapseEmptyDivs: noop,
        addEventListener: noop,
        setTargeting: noop
      })
    },
    canRunAds: true,
    isAdBlockActive: false
  };

  // 注入全局伪装变量，且不可被不可逆配置覆盖
  for (const [key, value] of Object.entries(adStubs)) {
    try {
      if (!(key in window)) {
        Object.defineProperty(window, key, {
          get: () => value,
          set: noop,
          configurable: false
        });
      }
    } catch (e) {
      // 容错防止严格模式错误
    }
  }

  // 2. 阻断恶意跳转与弹窗 (window.open & target=_blank 劫持)
  const nativeOpen = window.open;
  window.open = function (url, target, features) {
    if (url) {
      try {
        const parsed = new URL(url, location.href);
        const host = parsed.hostname;

        // 识别常见的广告/追踪域名关键词特征
        const blockedKeywords = ['click', 'tracker', 'adservice', 'popads', 'affiliate', 'syndication'];
        if (blockedKeywords.some(kw => host.includes(kw))) {
          console.debug(`[Shield] Blocked pop window: ${url}`);
          return null; // 吞掉弹窗，不给其创建标签页的机会
        }
      } catch (err) {
        // 非合法 URL
      }
    }
    return nativeOpen.apply(this, arguments);
  };

  // 3. 拦截恶意动态注册的强制点击事件 (如点击任意区域触发背景打开新页面)
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === 'click' && (this === window || this === document || this === document.body)) {
      const wrappedListener = function (event) {
        // 如果 target 是被伪装的覆盖层透明全屏 div
        const target = event.target;
        if (target && target.tagName === 'DIV') {
          const style = window.getComputedStyle(target);
          if (style.position === 'fixed' && style.zIndex > 99999 && style.opacity == 0) {
            event.stopImmediatePropagation();
            event.preventDefault();
            target.remove();
            console.debug('[Shield] Neutralized full-page click wrapper');
            return;
          }
        }
        return listener.apply(this, arguments);
      };
      return nativeAddEventListener.call(this, type, wrappedListener, options);
    }
    return nativeAddEventListener.call(this, type, listener, options);
  };
})();