((root) => {
  "use strict";

  /** 用反馈快照区分重定向结果和旧页面，避免刷新导致重复提交同一轮。 */
  function resultToken(questions) {
    return JSON.stringify(questions.map((q) => [q.id, q.reportedAnswer, q.feedback]));
  }

  /** 自动模式开始前显式设定有限轮数；轮数用完后仍未全对则停止。 */
  function createRun(owner, maxRounds, runId) {
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 4095) {
      throw new Error("自动提交上限必须是 1～4095 的整数");
    }
    return { schema: 1, owner, runId, active: true, rounds: 0, maxRounds, pending: null, reason: "" };
  }

  /** 提交前保存预期答案和反馈基线；持久化失败时不能发出提交。 */
  function arm(run, questions, plan) {
    if (!run.active || run.pending) throw new Error("已有一轮等待结果，不能重复提交");
    if (run.rounds >= run.maxRounds) throw new Error(`已达到本次 ${run.maxRounds} 轮提交上限`);
    if (plan.length !== questions.length || plan.some((item) => !item.answer)) {
      throw new Error("候选已耗尽或题目不完整，停止自动提交");
    }
    const pending = questions.map((q) => {
      const item = plan.find((entry) => entry.id === q.id);
      if (!item?.answer) throw new Error("候选与题目不匹配");
      return { id: q.id, answer: item.answer, signature: JSON.stringify([q.type, q.options]) };
    });
    return { ...run, rounds: run.rounds + 1, pending, baseline: resultToken(questions) };
  }

  /** 不把 HTTP 成功或跳转本身当成判题；必须逐题收到本轮答案的有效反馈。 */
  function acceptResult(run, questions) {
    if (!run.pending) return run;
    if (resultToken(questions) === run.baseline) throw new Error("仍是上一轮结果，已停止以避免重复提交");
    if (run.pending.length !== questions.length) throw new Error("重定向后题目数量变化");
    for (const pending of run.pending) {
      const q = questions.find((item) => item.id === pending.id);
      if (!q || JSON.stringify([q.type, q.options]) !== pending.signature) {
        throw new Error("重定向后题目或选项变化，已停止");
      }
      if (q.reportedAnswer !== pending.answer || !["correct", "wrong", "partial"].includes(q.feedback)) {
        throw new Error("未收到本轮完整逐题反馈，已停止");
      }
    }
    return { ...run, pending: null };
  }

  const api = Object.freeze({ createRun, arm, acceptResult, resultToken });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CXQuizAutoCore = api;
})(globalThis);
