const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const quiz = require("../extension/quiz-core.js");
const auto = require("../extension/quiz-auto-core.js");

/** 两题共享一次整卷提交，模拟部分正确与判断题的逐题反馈。 */
function questions() {
  return [
    { id: "multi", number: 1, type: "1", options: ["A", "B", "C"].map((value) => ({ value, text: value })), reportedAnswer: "A", feedback: "partial" },
    { id: "judge", number: 2, type: "3", options: ["true", "false"].map((value) => ({ value, text: value })), reportedAnswer: "true", feedback: "wrong" }
  ];
}

test("自动会话跨文档接续，锁定判断题后继续枚举多选，直到全对", () => {
  let qs = questions();
  let state = quiz.observe(null, qs);
  let run = auto.createRun("tab", 7, "run");
  while (true) {
    const plan = quiz.plan(state, qs);
    if (plan.every((entry) => entry.locked)) break;
    run = auto.arm(run, qs, plan);
    assert.ok(run.pending);
    qs = qs.map((q) => {
      const answer = plan.find((entry) => entry.id === q.id).answer;
      return { ...q, reportedAnswer: answer, feedback: answer === (q.id === "multi" ? "BC" : "false") ? "correct" : "wrong" };
    });
    run = auto.acceptResult(JSON.parse(JSON.stringify(run)), qs);
    assert.equal(run.pending, null);
    state = quiz.observe(state, qs);
  }
  assert.equal(run.rounds, 5);
  assert.equal(state.questions.judge.locked, "false");
  assert.equal(state.questions.multi.locked, "BC");
});

test("旧结果、缺失反馈、错配答案和选项变化不触发下一轮", () => {
  const qs = questions();
  const state = quiz.observe(null, qs);
  const run = auto.arm(auto.createRun("tab", 7, "run"), qs, quiz.plan(state, qs));
  assert.throws(() => auto.acceptResult(run, qs), /上一轮/);
  assert.throws(() => auto.arm(run, qs, quiz.plan(state, qs)), /等待结果/);
  const result = qs.map((q, i) => ({ ...q, reportedAnswer: run.pending[i].answer, feedback: "correct" }));
  assert.throws(() => auto.acceptResult(run, [{ ...result[0], feedback: null }, result[1]]), /完整逐题反馈/);
  assert.throws(() => auto.acceptResult(run, [{ ...result[0], reportedAnswer: "ABC" }, result[1]]), /完整逐题反馈/);
  assert.throws(() => auto.acceptResult(run, [{ ...result[0], options: [] }, result[1]]), /选项变化/);
  assert.throws(() => auto.acceptResult(run, result.slice(1)), /数量变化/);
});

test("轮数上限、候选耗尽和已停止会话不可继续提交", () => {
  const qs = questions();
  const state = quiz.observe(null, qs);
  const plan = quiz.plan(state, qs);
  assert.throws(() => auto.createRun("tab", 0, "run"), /整数/);
  assert.throws(() => auto.createRun("tab", 1.5, "run"), /整数/);
  assert.throws(() => auto.arm({ ...auto.createRun("tab", 1, "run"), rounds: 1 }, qs, plan), /上限/);
  assert.throws(() => auto.arm(auto.createRun("tab", 7, "run"), qs, [{ ...plan[0], answer: null }, plan[1]]), /耗尽/);
  assert.throws(() => auto.arm({ ...auto.createRun("tab", 7, "run"), active: false }, qs, plan), /重复提交/);
});

/** 只加载控制器，不接触真实页面、存储或提交接口。 */
function loadController() {
  const data = {};
  let releases = 0;
  const context = vm.createContext({
    CXQuizAutoCore: auto,
    sessionStorage: { getItem: () => "tab", setItem() {} },
    crypto: { randomUUID: () => "run" },
    chrome: { storage: {
      onChanged: { addListener() {} },
      local: { async get(key) { return { [key]: data[key] }; }, async set(update) { Object.assign(data, update); } }
    } },
    navigator: { locks: { async request(_key, _options, callback) { await callback({}); releases += 1; } } },
    AbortController, setTimeout, clearTimeout
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../extension/quiz-auto.js"), "utf8"), context);
  return { api: context.CXQuizAuto, data, releases: () => releases };
}

test("只接受已核实的两种弹窗，不确认未知错误或验证码", () => {
  const { api } = loadController();
  assert.equal(api.classifyDialog("确认提交？", "提交"), "confirm");
  assert.equal(api.classifyDialog("Submit？", "Submit"), "confirm");
  assert.equal(api.classifyDialog("Submit?", "Submit"), "confirm");
  assert.equal(api.classifyDialog("  Submit ？ ", " Submit "), "confirm");
  assert.equal(api.classifyDialog("Submit failed?", "Submit"), "unknown");
  assert.equal(api.classifyDialog("Please do it again without reaching the line", "OK"), "result");
  assert.equal(api.classifyDialog("验证码错误", "确定"), "unknown");
  assert.equal(api.classifyDialog("永久删除？", "提交"), "unknown");
});

test("手动停止会取消等待、持久化状态并释放互斥锁", async () => {
  const { api, data, releases } = loadController();
  const messages = [];
  const controller = new api.Controller({ key: "quiz", onStatus: (...args) => messages.push(args) });
  assert.equal(await controller.acquire(), true);
  controller.abort = new AbortController();
  controller.run = auto.createRun("tab", 7, "run");
  controller.busy = true;
  data[controller.autoKey] = controller.run;
  const sleep = controller.sleep(100000);
  const stopped = assert.rejects(sleep, /已停止/);
  await controller.stop();
  await stopped;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(data[controller.autoKey].active, false);
  assert.equal(controller.busy, false);
  assert.equal(releases(), 1);
  assert.equal(messages.at(-1)[1], false);
});

test("最后一轮刚好全对时先完成，不因轮数已满误报失败", async () => {
  const { api, data } = loadController();
  const messages = [];
  const controller = new api.Controller({ key: "quiz", questions: [{ id: "q", feedback: "correct", reportedAnswer: "A" }], plan: [{ id: "q", locked: true, answer: "A" }], onStatus: (...args) => messages.push(args) });
  controller.abort = new AbortController();
  controller.run = { ...auto.createRun("tab", 1, "run"), rounds: 1 };
  data[controller.autoKey] = controller.run;
  await controller.round();
  assert.match(messages.at(-1)[0], /全部题目已确认正确/);
  assert.equal(data[controller.autoKey].active, false);
});
