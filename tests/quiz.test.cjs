const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/quiz-core.js");

/** 构造独立的判题快照，区分服务器反馈和待填写答案。 */
function question(overrides = {}) {
  return { id: "q1", number: 1, type: "1", options: ["A", "B", "C", "D", "E"].map((value) => ({ value, text: value })), reportedAnswer: null, feedback: null, ...overrides };
}

test("五选多选覆盖全部 31 个非空组合，且无重复", () => {
  const values = core.candidates(question());
  assert.equal(values.length, 31);
  assert.equal(new Set(values).size, 31);
  assert.ok(values.includes("ABCDE"));
  assert.ok(!values.includes(""));
});

test("部分正确不会锁定，也不会错误排除包含或不包含 A 的组合", () => {
  const q = question({ reportedAnswer: "A", feedback: "partial" });
  const state = core.observe(null, [q]);
  const next = core.plan(state, [q])[0];
  assert.equal(next.locked, false);
  assert.equal(next.answer, "B");
  assert.equal(state.questions.q1.tried.A, "partial");
  assert.equal(state.questions.q1.tried.AB, undefined);
});

test("跨重定向保存已确认答案，其他题继续生成候选", () => {
  const correct = question({ id: "correct", type: "0", feedback: "correct", reportedAnswer: "A" });
  const partial = question({ id: "partial", feedback: "partial", reportedAnswer: "A" });
  let state = core.observe(null, [correct, partial]);
  state = core.observe(JSON.parse(JSON.stringify(state)), [correct, { ...partial, reportedAnswer: "B", feedback: "wrong" }]);
  const next = core.plan(state, [correct, partial]);
  assert.equal(next[0].answer, "A");
  assert.equal(next[0].locked, true);
  assert.equal(next[1].answer, "AB");
});

test("重复读取相同结果或生成候选不会消耗候选", () => {
  const q = question({ reportedAnswer: "A", feedback: "wrong" });
  const state = core.observe(null, [q]);
  const once = core.plan(state, [q]);
  assert.deepEqual(core.plan(core.observe(state, [q]), [q]), once);
  assert.deepEqual(core.plan(state, [q]), once);
});

test("逐轮模拟判题可找到多选组合，找到后始终保留", () => {
  const q = question();
  let state = core.observe(null, [q]);
  let rounds = 0;
  while (rounds++ < 31) {
    const next = core.plan(state, [q])[0];
    state = core.observe(state, [{ ...q, reportedAnswer: next.answer, feedback: next.answer === "BCDE" ? "correct" : "wrong" }]);
    if (state.questions.q1.locked) break;
  }
  assert.ok(rounds <= 31);
  assert.equal(core.plan(state, [q])[0].answer, "BCDE");
  assert.equal(core.plan(state, [q])[0].locked, true);
});

test("候选耗尽、反馈冲突和不支持的题型不能静默继续", () => {
  const q = question({ type: "3", options: [{ value: "true" }, { value: "false" }] });
  let state = core.observe(null, [{ ...q, reportedAnswer: "true", feedback: "wrong" }]);
  assert.equal(core.plan(state, [q])[0].answer, "false");
  state = core.observe(state, [{ ...q, reportedAnswer: "false", feedback: "wrong" }]);
  assert.equal(core.plan(state, [q])[0].answer, null);
  const locked = core.observe(null, [{ ...q, reportedAnswer: "true", feedback: "correct" }]);
  assert.throws(() => core.observe(locked, [{ ...q, reportedAnswer: "true", feedback: "wrong" }]), /冲突/);
  assert.throws(() => core.candidates(question({ type: "2" })), /不支持/);
});

test("选项变化使旧锁定失效；无法匹配的答案与未知标记不参与推断", () => {
  const q = question({ reportedAnswer: "A", feedback: "correct" });
  const state = core.observe(null, [q]);
  const changed = { ...q, options: q.options.map((option) => ({ ...option, text: `${option.text} changed` })), feedback: null };
  assert.equal(core.plan(core.observe(state, [changed]), [changed])[0].locked, false);
  assert.equal(core.observe(null, [{ ...q, feedback: "unknown" }]).questions.q1.locked, null);
  assert.deepEqual(core.observe(null, [{ ...q, reportedAnswer: "Z" }]).questions.q1.tried, {});
});
