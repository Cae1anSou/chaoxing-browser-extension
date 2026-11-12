((root) => {
  "use strict";

  /** 为支持的客观题生成有限候选集；多选不依赖尚未核实的部分得分规则。 */
  function candidates(question) {
    const values = question.options.map((option) => option.value);
    if (!values.length || new Set(values).size !== values.length) throw new Error("选项缺失或重复");
    if (question.type === "0" || question.type === "3") return values;
    if (question.type !== "1" || values.length > 12) throw new Error("题型不支持，或多选超过 12 个选项");
    const answers = [];
    for (let mask = 1; mask < 2 ** values.length; mask += 1) {
      answers.push(values.filter((_, index) => mask & (2 ** index)).join(""));
    }
    return answers;
  }

  /** 选项内容变化时清空该题旧结论，防止随机选项导致字母与答案错配。 */
  function signature(question) {
    return JSON.stringify([question.type, question.options]);
  }

  /** 在已验证的判分假设下，partial 是真子集，wrong 意味着至少混入一个错项。 */
  function compatibleMasks(all, tried) {
    const evidence = Object.entries(tried).map(([answer, feedback]) => ({
      mask: all.indexOf(answer) + 1, feedback
    })).filter((entry) => entry.mask > 0);
    const masks = [];
    for (let truth = 1; truth <= all.length; truth += 1) {
      if (evidence.every(({ mask, feedback }) => feedback === "correct" ? mask === truth
        : feedback === "partial" ? mask !== truth && (mask & truth) === mask
        : feedback === "wrong" ? (mask & truth) !== mask : true)) masks.push(truth);
    }
    return masks;
  }

  /** 选择最坏情况下剩余答案最少的探测；并列时优先有机会直接答对的组合。 */
  function chooseProbe(all, remaining, tried) {
    const remainingSet = new Set(remaining);
    let best = null;
    for (let probe = 1; probe <= all.length; probe += 1) {
      if (tried[all[probe - 1]]) continue;
      let partial = 0;
      let wrong = 0;
      let correct = 0;
      for (const truth of remaining) {
        if (probe === truth) correct += 1;
        else if ((probe & truth) === probe) partial += 1;
        else wrong += 1;
        // 最坏分支只会继续增长，超过当前最优即可停止评估该探测。
        if (best && Math.max(partial, wrong, correct) > best.worst) break;
      }
      const score = {
        mask: probe,
        worst: Math.max(partial, wrong, correct),
        squares: partial ** 2 + wrong ** 2 + correct ** 2,
        solution: remainingSet.has(probe)
      };
      if (!best || score.worst < best.worst ||
        (score.worst === best.worst && (score.squares < best.squares ||
          (score.squares === best.squares && score.solution && !best.solution)))) best = score;
    }
    return best;
  }

  /** 仅吸收服务器返回的答案展示与判题标记，不用可能已被编辑的输入框判题。 */
  function observe(previous, questions, options = {}) {
    const strategy = options.strategy ?? previous?.strategy ?? "exhaustive";
    if (!["exhaustive", "subset"].includes(strategy)) throw new Error("未知的多选搜索策略");
    const state = { schema: 1, strategy, questions: {} };
    for (const question of questions) {
      const all = candidates(question);
      const fingerprint = signature(question);
      const old = previous?.schema === 1 ? previous.questions?.[question.id] : null;
      const record = old?.signature === fingerprint
        ? { ...old, tried: { ...old.tried } }
        : { signature: fingerprint, tried: {}, locked: null };
      if (all.includes(question.reportedAnswer) && ["correct", "wrong", "partial"].includes(question.feedback)) {
        if (record.locked && (question.reportedAnswer !== record.locked || question.feedback !== "correct")) {
          // 其他候选被判错并不推翻已确认答案；同一答案的冲突则停止猜测。
          if (question.reportedAnswer === record.locked || question.feedback === "correct") {
            throw new Error(`第 ${question.number} 题判题反馈冲突，请核实后清空记录`);
          }
        }
        if (record.tried[question.reportedAnswer] && record.tried[question.reportedAnswer] !== question.feedback) {
          record.pruningDisabled = "同一答案出现不同反馈，已回退完整枚举";
        }
        record.tried[question.reportedAnswer] = question.feedback;
        if (question.feedback === "correct") record.locked = question.reportedAnswer;
      }
      if (strategy === "subset" && question.type === "1" && !record.pruningDisabled &&
        compatibleMasks(all, record.tried).length === 0) {
        // 判分规则可能不适用；只撤销推断，不丢弃已经真实提交过的记录。
        record.pruningDisabled = "反馈不符合少选规则，已回退完整枚举";
      }
      state.questions[question.id] = record;
    }
    return state;
  }

  /** 尚未提交的候选不记作失败，重复生成或刷新不会无故跳过候选。 */
  function plan(state, questions) {
    return questions.map((question) => {
      const record = state.questions[question.id];
      const all = candidates(question);
      let answer = record.locked || all.find((value) => !record.tried[value]);
      let strategy = record.locked ? "locked" : "exhaustive";
      let remaining = record.locked ? 1 : all.filter((value) => !record.tried[value]).length;
      let included = "";
      let excluded = "";
      let reason = record.pruningDisabled || "";
      if (!record.locked && question.type === "1" && state.strategy === "subset") {
        const masks = record.pruningDisabled ? [] : compatibleMasks(all, record.tried);
        if (masks.length) {
          const probe = chooseProbe(all, masks, record.tried);
          answer = probe ? all[probe.mask - 1] : null;
          strategy = "subset";
          remaining = masks.length;
          const common = masks.reduce((value, mask) => value & mask, all.length);
          const possible = masks.reduce((value, mask) => value | mask, 0);
          included = question.options.filter((_, index) => common & (2 ** index)).map((option) => option.value).join("");
          excluded = question.options.filter((_, index) => !(possible & (2 ** index))).map((option) => option.value).join("");
        } else {
          strategy = "fallback";
          reason ||= "反馈不符合少选规则，使用完整枚举";
        }
      }
      return { id: question.id, number: question.number, answer: answer ?? null, locked: Boolean(record.locked),
        tried: Object.keys(record.tried).length, strategy, remaining, included, excluded, reason };
    });
  }

  const api = Object.freeze({ candidates, observe, plan });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CXQuizCore = api;
})(globalThis);
