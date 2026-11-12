((root) => {
  "use strict";
  /** 经 DOM 消息让页面环境执行点击；无桥接时明确停止，不回退到隔离世界点击。 */
  function click(element) {
    const token = crypto.randomUUID();
    const attribute = "data-cx-click-result";
    const previous = element.getAttribute(attribute);
    try {
      element.removeAttribute(attribute);
      // 使用目标文档创建事件，兼容顶层页面承载确认弹窗的情况。
      const event = element.ownerDocument.createEvent("CustomEvent");
      event.initCustomEvent("cx-research-page-click-v1", true, false, token);
      element.dispatchEvent(event);
      const result = JSON.parse(element.getAttribute(attribute) || "null");
      if (result?.token !== token) throw new Error("页面操作桥接未就绪，请重新加载扩展后刷新学习页面");
      if (!result.ok) throw new Error(result.error || "页面点击执行失败");
    } finally {
      if (previous === null) element.removeAttribute(attribute);
      else element.setAttribute(attribute, previous);
    }
  }
  root.CXQuizPage = Object.freeze({ click });
})(globalThis);
