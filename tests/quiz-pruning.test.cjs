const { test } = require("node:test");
const assert = require("node:assert/strict");
const core = require("../extension/quiz-core.js");

/** 使用确定的判分器遍历完整真值空间，不依赖某一个答案的演示。 */
function question() {
  return { id: "multi", number: 1, type: "1", options: ["A", "B", "C", "D", "E"].map((value) => ({ value, text: value })), reportedAnswer: null, feedback: null };
}

function feedback(answer, truth) {
  return answer === truth ? "correct" : [...answer].every((value) => truth.includes(value)) ? "partial" : "wrong";
}

function solve(truth, strategy) {
  const q = question();
  let state = core.observe(null, [q], { strategy });
  const seen = new Set();
  const probes = [];
  for (let round = 1; round <= 31; round += 1) {
    const next = core.plan(state, [q])[0];
    assert.ok(next.answer, `无法找到答案 ${truth}`);
    assert.ok(!seen.has(next.answer), `重复提交 ${next.answer}`);
    seen.add(next.answer);
    probes.push(next.answer);
    state = core.observe(JSON.parse(JSON.stringify(state)), [{ ...q, reportedAnswer: next.answer, feedback: feedback(next.answer, truth) }]);
    if (state.questions.multi.locked) return { rounds: round, probes };
  }
  throw new Error(`未能找到 ${truth}`);
}

test("五选多选的全部 31 个真值在快速策略下最多五轮，完整枚举最多 31 轮", () => {
  let fastMax = 0;
  let oldMax = 0;
  for (const truth of core.candidates(question())) {
    const fast = solve(truth, "subset");
    const old = solve(truth, "exhaustive");
    fastMax = Math.max(fastMax, fast.rounds);
    oldMax = Math.max(oldMax, old.rounds);
  }
  assert.ok(fastMax <= 5);
  assert.equal(oldMax, 31);
});

test("部分正确确认必选，扩展组合错误可排除新增项", () => {
  const q = question();
  let state = core.observe(null, [{ ...q, reportedAnswer: "CE", feedback: "partial" }], { strategy: "subset" });
  state = core.observe(state, [{ ...q, reportedAnswer: "BCE", feedback: "wrong" }]);
  let next = core.plan(state, [q])[0];
  assert.equal(next.included, "CE");
  assert.equal(next.excluded, "B");
  assert.equal(next.remaining, 3);
  state = core.observe(state, [{ ...q, reportedAnswer: "ACE", feedback: "partial" }]);
  next = core.plan(state, [q])[0];
  assert.equal(next.answer, "ACDE");
  assert.equal(next.remaining, 1);
  assert.equal(next.locked, false, "推断唯一答案仍需提交验证，不能提前锁定");
});

test("快速策略选择有信息量的探测，可以探测并非完整答案的组合", () => {
  const q = question();
  const state = core.observe(null, [{ ...q, reportedAnswer: "A", feedback: "partial" }], { strategy: "subset" });
  const next = core.plan(state, [q])[0];
  assert.equal(next.answer, "AB");
  assert.equal(next.remaining, 15);
  assert.equal(next.strategy, "subset");
});

test("规则矛盾后永久回退该题，保留真实尝试记录并继续搜索", () => {
  const q = question();
  let state = core.observe(null, [{ ...q, reportedAnswer: "A", feedback: "partial" }], { strategy: "subset" });
  state = core.observe(state, [{ ...q, reportedAnswer: "AB", feedback: "partial" }]);
  // 全部选项不可能是任何非空答案的真子集，制造可检测矛盾。
  state = core.observe(state, [{ ...q, reportedAnswer: "ABCDE", feedback: "partial" }]);
  const next = core.plan(state, [q])[0];
  assert.equal(next.strategy, "fallback");
  assert.equal(next.answer, "B");
  assert.match(next.reason, /回退/);
  assert.deepEqual(Object.keys(state.questions.multi.tried), ["A", "AB", "ABCDE"]);
  assert.equal(core.plan(JSON.parse(JSON.stringify(state)), [q])[0].strategy, "fallback");
});

test("完整枚举不采用子集规则，切换策略保留既有反馈和正确答案", () => {
  const q = question();
  const original = core.observe(null, [{ ...q, reportedAnswer: "CE", feedback: "partial" }]);
  assert.equal(core.plan(original, [q])[0].strategy, "exhaustive");
  const fast = core.observe(original, [q], { strategy: "subset" });
  assert.equal(core.plan(fast, [q])[0].included, "CE");
  const locked = core.observe(fast, [{ ...q, reportedAnswer: "ACDE", feedback: "correct" }]);
  const legacy = core.observe(locked, [q], { strategy: "exhaustive" });
  assert.equal(core.plan(legacy, [q])[0].answer, "ACDE");
  assert.equal(core.plan(legacy, [q])[0].locked, true);
});

test("已确认正确的答案与先前剪枝假设矛盾时，仍以真实正确反馈为准", () => {
  const q = question();
  let state = core.observe(null, [{ ...q, reportedAnswer: "A", feedback: "partial" }], { strategy: "subset" });
  state = core.observe(state, [{ ...q, reportedAnswer: "BC", feedback: "correct" }]);
  const next = core.plan(state, [q])[0];
  assert.equal(next.locked, true);
  assert.equal(next.answer, "BC");
  assert.match(state.questions.multi.pruningDisabled, /不符合/);
});
