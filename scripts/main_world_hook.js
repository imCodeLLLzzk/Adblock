/**
 * scripts/main_world_hook.js
 * 运行在宿主页面的原生 JS 上下文中。
 *
 * 反检测原则：
 *  - 站点常用 Function.prototype.toString() 判断某个 API 是否被改写。
 *    所有被包装的函数都用 Proxy 承载，并复用原生函数的源码字符串作为伪装，
 *    使 window.open.toString() 与 Function.prototype.toString.call(window.open)
 *    都呈现「[native code]」外观。
 *  - 不再劫持 EventTarget.prototype.addEventListener：这是最容易被检测、
 *    也最容易误伤页面的改写点。点击劫持层的清除已下沉到隔离世界。
 */
(function () {
  'use strict';

  const nativeToString = Function.prototype.toString;

  // 用原生函数做 Proxy 载体，让 toString 呈现原生外观
  function nativeWrapper(nativeTarget, impl) {
    const src = nativeToString.call(nativeTarget);
    const fakeToString = function toString() { return src; };
    try {
      Object.defineProperty(fakeToString, 'toString', {
        value: function toString() { return src; },
        writable: true, configurable: true
      });
    } catch (e) { /* 忽略 */ }

    return new Proxy(nativeTarget, {
      apply(target, thisArg, args) {
        return impl ? impl(args) : Reflect.apply(target, thisArg, args);
      },
      get(target, prop, receiver) {
        if (prop === 'toString') return fakeToString;
        return Reflect.get(target, prop, receiver);
      }
    });
  }

  // 1. 深度存根 (Scriptlet Stubs) - 欺骗常见反拦截探针
  const noop = nativeWrapper(nativeToString);
  const push = nativeWrapper(nativeToString, () => 0);

  const adsbygoogleStub = {
    loaded: true,
    push: push,
    op: noop
  };

  const googletagStub = {
    cmd: [],
    display: noop,
    enableServices: noop,
    pubads: nativeWrapper(nativeToString, () => ({
      enableSingleRequest: noop,
      collapseEmptyDivs: noop,
      addEventListener: noop,
      setTargeting: noop
    }))
  };

  // 以「取值器 + 静默写入器」形式注入：页面若自行赋值会被忽略，
  // 避免严格模式下赋值异常，也避免站点拿到可识别的普通数组。
  function defineStub(name, value) {
    try {
      if (name in window) return;
      const getter = function () { return value; };
      const setter = function () {};
      const src = nativeToString.call(nativeToString);
      for (const fn of [getter, setter]) {
        Object.defineProperty(fn, 'toString', {
          value: function toString() { return src; },
          writable: true, configurable: true
        });
      }
      Object.defineProperty(window, name, {
        get: getter,
        set: setter,
        configurable: false,
        enumerable: false
      });
    } catch (e) {
      // 容错防止严格模式错误
    }
  }

  defineStub('adsbygoogle', adsbygoogleStub);
  defineStub('googletag', googletagStub);
  defineStub('canRunAds', true);
  defineStub('isAdBlockActive', false);

  // 2. 阻断恶意跳转与弹窗 (window.open 劫持)
  try {
    const nativeOpen = window.open;
    const BLOCKED_KEYWORDS = [
      'doubleclick', 'googlesyndication', 'adservice', 'popads',
      'popcash', 'propellerads', 'adsterra', 'clickadu', 'onclick',
      'tracker', 'affiliate', 'syndication', 'wwads'
    ];

    window.open = nativeWrapper(nativeOpen, args => {
      const url = args[0];
      if (url) {
        try {
          const host = new URL(String(url), location.href).hostname;
          if (BLOCKED_KEYWORDS.some(kw => host.includes(kw))) {
            console.debug('[Shield] Blocked pop window:', url);
            return null;   // 吞掉弹窗，不给它创建标签页的机会
          }
        } catch (e) {
          // 非合法 URL，交回原生处理
        }
      }
      return nativeOpen.apply(window, args);
    });
  } catch (e) {
    // 忽略：无法包装时保持原生行为
  }

  // 3. 拦截「检测到插件」的原生弹窗 (alert)
  //    只吞掉检测类提示，其余 alert 交回原生，避免误伤正常业务
  try {
    const nativeAlert = window.alert;
    const ALERT_SIGNATURES = [
      '检测到您的浏览器插件', '浏览器插件正在注入异常脚本', '正在注入异常脚本',
      '请使用隐身模式打开页面', '请使用无痕模式打开页面', '请关闭广告拦截',
      '检测到广告拦截', '广告拦截插件', 'adblock', 'incognito'
    ];
    const normalize = t => (t || '').replace(/\s+/g, '').toLowerCase();
    const normalized = ALERT_SIGNATURES.map(normalize);

    window.alert = nativeWrapper(nativeAlert, args => {
      const text = normalize(String(args[0] == null ? '' : args[0]));
      if (text && normalized.some(sig => text.includes(sig))) {
        console.debug('[Shield] 已拦截检测弹窗:', args[0]);
        return undefined;   // 吞掉提示
      }
      return nativeAlert.apply(window, args);
    });
  } catch (e) {
    // 忽略：无法包装时保持原生行为
  }
})();
