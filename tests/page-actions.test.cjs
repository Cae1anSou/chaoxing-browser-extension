const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

/** 模拟隔离环境不能直接点击，但可以向页面环境发送同步 DOM 事件。 */
function fixture(installBridge = true) {
  let receive;
  const window = { addEventListener(_name, handler) { receive = handler; } };
  class Element {
    constructor(allowed = true) {
      this.allowed = allowed;
      this.attributes = new Map();
      this.listeners = new Set();
      this.clicked = 0;
      this.defaultPrevented = false;
      this.ownerDocument = { createEvent() { return { initCustomEvent(type, _bubbles, _cancelable, detail) { this.type = type; this.detail = detail; } }; } };
    }
    matches() { return this.allowed; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener(_type, fn) { this.listeners.add(fn); }
    removeEventListener(_type, fn) { this.listeners.delete(fn); }
    dispatchEvent(event) { if (receive) receive({ ...event, target: this }); }
    click() {
      this.clicked += 1;
      for (const listener of this.listeners) listener({ preventDefault: () => { this.defaultPrevented = true; } });
    }
  }
  const context = vm.createContext({ window, HTMLElement: Element, crypto: { randomUUID: () => "test-token" } });
  if (installBridge) vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/page-actions.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/quiz-page.js"), "utf8"), context);
  return { api: context.CXQuizPage, Element, receive };
}

test("页面桥接点击保留事件处理并取消默认 javascript 导航", () => {
  const { api, Element } = fixture();
  const element = new Element();
  // 若调用方仍直接 element.click()，此测试必须失败。
  element.click = () => { throw new Error("ISOLATED CSP 禁止直接点击"); };
  api.click(element);
  assert.equal(element.clicked, 1);
  assert.equal(element.defaultPrevented, true);
  assert.equal(element.getAttribute("data-cx-click-result"), null);
});

test("桥接缺失或控件不在允许范围时停止，不回退到直接点击", () => {
  const missing = fixture(false);
  assert.throws(() => missing.api.click(new missing.Element()), /桥接未就绪/);
  const denied = fixture();
  const element = new denied.Element(false);
  assert.throws(() => denied.api.click(element), /桥接未就绪/);
  assert.equal(element.clicked, 0);
});

test("不接受任意代码作为消息，并恢复原有属性", () => {
  const { api, Element, receive } = fixture();
  const element = new Element();
  receive({ target: element, detail: "alert('not allowed')" });
  assert.equal(element.clicked, 0);
  element.setAttribute("data-cx-click-result", "original");
  api.click(element);
  assert.equal(element.getAttribute("data-cx-click-result"), "original");
});
