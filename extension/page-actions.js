(() => {
  "use strict";
  if (window.__CX_PAGE_ACTIONS__) return;
  const nativeClick = HTMLElement.prototype.click;
  const eventName = "cx-research-page-click-v1";
  const resultAttribute = "data-cx-click-result";
  const allowed = 'li[qid][qtype="0"], li[qid][qtype="1"], li[qid][qtype="3"], .btnSubmit[onclick*="btnBlueSubmit"], #workpop #popok';

  /** 只接收固定页面控件的点击，不接收脚本、URL 或任意函数名。 */
  window.addEventListener(eventName, (event) => {
    const element = event.target;
    const token = event.detail;
    if (typeof token !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(token) ||
      !(element instanceof HTMLElement) || !element.matches(allowed)) return;
    try {
      // javascript:void(0) 只是链接占位符；取消默认导航，保留原页面的点击处理。
      // 点击必须在 MAIN 环境发起，否则隔离世界的扩展 CSP 会拦截 javascript: URL。
      const preventNavigation = (clickEvent) => { clickEvent.preventDefault(); };
      element.addEventListener("click", preventNavigation, { capture: true, once: true });
      try { Reflect.apply(nativeClick, element, []); }
      finally { element.removeEventListener("click", preventNavigation, true); }
      element.setAttribute(resultAttribute, JSON.stringify({ token, ok: true }));
    } catch (error) {
      element.setAttribute(resultAttribute, JSON.stringify({ token, ok: false, error: error.message }));
    }
  }, true);
  Object.defineProperty(window, "__CX_PAGE_ACTIONS__", { value: true });
})();
