const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "extension/main.js"), "utf8");

/** 用可观察的调度器验证清除目标，不执行页面业务和反调试逻辑。 */
function setup() {
  const window = new EventTarget();
  const pending = new Map();
  let nextId = 1;
  window.setInterval = function (callback, delay, ...args) {
    const id = nextId++;
    pending.set(id, { callback, delay, args, receiver: this });
    return id;
  };
  window.clearInterval = (id) => pending.delete(id);
  const original = window.setInterval;
  const context = vm.createContext({ window });
  // 使用各 frame 自己的 Function，避免测试污染 Node 宿主的函数原型。
  window.Function = vm.runInContext("Function", context);
  vm.runInContext(source, context);
  return { window, pending, original, context };
}

test("已识别指纹的反调试定时器被清除，返回值仍是有效的原生 ID", () => {
  const { window, pending, context } = setup();
  // 独立构造已确认的定时器入口，避免公开测试依赖含个人信息的完整页面样本。
  const callback = vm.runInContext("(function(){_0x4c33d4();})", context);
  const id = window.setInterval(callback, 4000);
  assert.equal(typeof id, "number");
  assert.equal(pending.has(id), false);
  assert.equal(window.__CX_RESEARCH__.status().debugTimers, 1);
});

test("普通任务和不同周期保留回调、参数与调用接收者", () => {
  const { window, pending, context } = setup();
  const callback = () => {};
  const id = window.setInterval(callback, 4000, "payload");
  assert.equal(pending.get(id).callback, callback);
  assert.deepEqual(pending.get(id).args, ["payload"]);
  assert.equal(pending.get(id).receiver, window);
  const known = vm.runInContext("(function(){_0x4c33d4();})", context);
  assert.ok(pending.has(window.setInterval(known, 1000)));
  assert.ok(pending.has(window.setInterval("otherTask()", 4000)));
});

test("仅阻断无相关目标的 mouseout，保留页面内部移动及 mouseover", () => {
  const { window } = setup();
  let received = 0;
  window.addEventListener("mouseout", () => received++);
  window.addEventListener("mouseover", () => received++);
  window.dispatchEvent(new Event("mouseout"));
  assert.equal(received, 0);
  for (const property of ["relatedTarget", "toElement"]) {
    const event = new Event("mouseout");
    Object.defineProperty(event, property, { value: {} });
    window.dispatchEvent(event);
  }
  window.dispatchEvent(new Event("mouseover"));
  assert.equal(received, 3);
  assert.equal(window.__CX_RESEARCH__.status().mouseExits, 1);
});

test("重复注入不叠加补丁；停用后恢复事件与定时器", () => {
  const { window, context, pending, original } = setup();
  const patched = window.setInterval;
  vm.runInContext(source, context);
  assert.equal(window.setInterval, patched);
  window.__CX_RESEARCH__.disable();
  assert.equal(window.setInterval, original);
  let received = false;
  window.addEventListener("mouseout", () => { received = true; });
  window.dispatchEvent(new Event("mouseout"));
  assert.equal(received, true);
  assert.equal(window.__CX_RESEARCH__.status().active, false);
  const callback = vm.runInContext("(function(){_0x4c33d4();})", context);
  assert.ok(pending.has(window.setInterval(callback, 4000)));
});

test("停用不会覆盖其他代码后来安装的定时器补丁", () => {
  const { window } = setup();
  const laterPatch = () => 123;
  window.setInterval = laterPatch;
  window.__CX_RESEARCH__.disable();
  assert.equal(window.setInterval, laterPatch);
});

test("manifest 在所有匹配 frame 的 MAIN 环境尽早注入，仅申请本地存储权限", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
  const script = manifest.content_scripts[0];
  assert.equal(script.world, "MAIN");
  assert.equal(script.run_at, "document_start");
  assert.equal(script.all_frames, true);
  assert.deepEqual(manifest.permissions, ["storage"]);
  for (const file of script.js) assert.ok(fs.existsSync(path.join(root, "extension", file)));
});

test("重定向更名后的同步动态 debugger 经两种构造入口均被替换", () => {
  const { window, context } = setup();
  vm.runInContext(`
    function _0x14643e() {
      return (function () {}).constructor('debu' + 'gger').call('action');
    }
    _0x14643e();
    window.Function('debugger;')();
    new window.Function('input', ' debugger ; ')(123);
  `, context);
  assert.equal(window.__CX_RESEARCH__.status().debugFunctions, 3);
  assert.equal(window.__CX_RESEARCH__.status().functionHookInstalled, true);
});

test("保留普通动态函数、参数、语法错误和包含 debugger 字符串的业务代码", () => {
  const { window } = setup();
  assert.equal(window.Function("a", "b", "return a + b")(2, 3), 5);
  assert.equal(new window.Function("return 'debugger'")(), "debugger");
  assert.equal(window.Function("debugger; return 7")(), 7);
  assert.throws(() => window.Function("return {"), { name: "SyntaxError" });
  assert.equal(window.__CX_RESEARCH__.status().debugFunctions, 0);
});

test("新 frame 自动安装独立补丁，停用恢复两种 Function 入口", () => {
  const first = setup();
  const second = setup();
  const native = vm.runInContext("Object.getPrototypeOf(function() {})", first.context);
  first.window.Function("debugger")();
  assert.equal(second.window.__CX_RESEARCH__.status().debugFunctions, 0);
  first.window.__CX_RESEARCH__.disable();
  assert.equal(first.window.Function, native.constructor);
  const body = first.window.Function("debugger");
  assert.match(body.toString(), /debugger/);
  second.window.Function("debugger")();
  assert.equal(second.window.__CX_RESEARCH__.status().debugFunctions, 1);
});
