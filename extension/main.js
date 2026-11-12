(() => {
  "use strict";

  if (Object.prototype.hasOwnProperty.call(window, "__CX_RESEARCH__")) return;

  const nativeSetInterval = window.setInterval;
  const nativeClearInterval = window.clearInterval;
  const functionToString = Function.prototype.toString;
  const nativeFunction = window.Function;
  const constructorDescriptor = Object.getOwnPropertyDescriptor(nativeFunction.prototype, "constructor");
  const counters = { mouseExits: 0, debugTimers: 0, debugFunctions: 0 };
  let active = true;

  /** 只替换函数体完全由 debugger 语句组成的动态函数，不改写正常业务函数。 */
  function sanitizeFunctionArgs(args) {
    const body = args.at(-1);
    if (!active || typeof body !== "string" || !/^\s*debugger\s*;?\s*$/.test(body)) {
      return args;
    }
    counters.debugFunctions += 1;
    return [...args.slice(0, -1), ""];
  }

  // 截图中的 VM 脚本由 Function 构造器动态生成。直接处理最终函数体，
  // 可同时覆盖重定向后变化的混淆名称、同步调用和定时调用。
  const patchedFunction = new Proxy(nativeFunction, {
    apply(target, receiver, args) {
      return Reflect.apply(target, receiver, sanitizeFunctionArgs(args));
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, sanitizeFunctionArgs(args), newTarget);
    }
  });

  /** 只识别下载样本中已确认的定时入口，避免误伤进度和其他业务计时器。 */
  function isKnownDebugTimer(callback, delay) {
    if (delay !== 4000 || typeof callback !== "function") return false;
    const source = Reflect.apply(functionToString, callback, []);
    // TODO: 新版本混淆名称变化后，先核实样本，再添加对应指纹。
    return /^function\s*\(\s*\)\s*\{\s*_0x4c33d4\s*\(\s*\)\s*;?\s*\}$/.test(source);
  }

  /** 保留原生调用的返回值、参数和异常语义，只清除已识别的反调试任务。 */
  function patchedSetInterval(callback, delay, ...args) {
    const timerId = Reflect.apply(nativeSetInterval, this, [callback, delay, ...args]);
    if (active && isKnownDebugTimer(callback, delay)) {
      // 定时回调不会打断当前同步任务，因此注册后立即清除不会执行一次反调试。
      Reflect.apply(nativeClearInterval, window, [timerId]);
      counters.debugTimers += 1;
    }
    return timerId;
  }

  /** 捕获阶段先于播放器的冒泡监听，只拦截原暂停逻辑使用的离开条件。 */
  function interceptMouseExit(event) {
    if (!active || event.relatedTarget || event.toElement) return;
    event.stopImmediatePropagation();
    counters.mouseExits += 1;
  }

  window.setInterval = patchedSetInterval;
  // 混淆器使用 (function () {}).constructor；只修改 window.Function 不够。
  Object.defineProperty(nativeFunction.prototype, "constructor", {
    ...constructorDescriptor,
    value: patchedFunction
  });
  window.Function = patchedFunction;
  window.addEventListener("mouseout", interceptMouseExit, true);

  Object.defineProperty(window, "__CX_RESEARCH__", {
    configurable: true,
    value: Object.freeze({
      /** 返回当前 iframe 的安装状态；计数用于核实补丁是否命中过目标。 */
      status() {
        return {
          version: "0.5.0",
          active,
          timerHookInstalled: window.setInterval === patchedSetInterval,
          functionHookInstalled: window.Function === patchedFunction &&
            nativeFunction.prototype.constructor === patchedFunction,
          ...counters
        };
      },
      /** 停用本 frame 的补丁；已清除的定时器需要刷新页面才能重新创建。 */
      disable() {
        active = false;
        window.removeEventListener("mouseout", interceptMouseExit, true);
        if (window.setInterval === patchedSetInterval) {
          window.setInterval = nativeSetInterval;
        }
        if (window.Function === patchedFunction) window.Function = nativeFunction;
        if (nativeFunction.prototype.constructor === patchedFunction) {
          Object.defineProperty(nativeFunction.prototype, "constructor", constructorDescriptor);
        }
      }
    })
  });
})();
