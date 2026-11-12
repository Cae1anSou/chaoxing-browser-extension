(() => {
  "use strict";
  const core = globalThis.CXQuizCore;
  const form = document.querySelector("#form1");
  if (!form || document.getElementById("cx-quiz-research")) return;

  /** 只读取本页作业身份，隔离不同账号、课程和答卷的本地记录。 */
  function storageKey() {
    const names = ["userId", "courseId", "classId", "workRelationId", "workAnswerId"];
    const values = names.map((name) => form.elements.namedItem(name)?.value);
    if (values.some((value) => !value)) throw new Error("作业身份字段不完整，未启用枚举");
    return `cx-quiz-v1:${location.hostname}:${values.join(":")}`;
  }

  /** 文字不含对错图标；必须单独读取判题类名，并匹配服务器展示的原答案。 */
  function readQuestions() {
    if (form.elements.namedItem("randomOptions")?.value === "true") {
      throw new Error("本作业启用了随机选项，暂不复用字母答案");
    }
    return [...form.querySelectorAll(".TiMu")].map((node, index) => {
      const typeInput = node.querySelector('input[id^="answertype"]');
      if (!typeInput) throw new Error(`第 ${index + 1} 题缺少题型字段`);
      const id = typeInput.id.slice("answertype".length);
      const rows = [...node.querySelectorAll("li[qid]")].filter((row) => row.getAttribute("qid") === id);
      const options = rows.map((row) => ({
        value: row.querySelector("span[data]")?.getAttribute("data"),
        text: row.querySelector("a.after")?.textContent.trim() || ""
      }));
      if (options.some((option) => !option.value)) throw new Error(`第 ${index + 1} 题选项不完整`);
      const mark = node.querySelector(".CorrectOrNot span");
      const feedback = mark?.classList.contains("marking_dui") ? "correct"
        : mark?.classList.contains("marking_cuo") ? "wrong"
        : mark?.classList.contains("marking_bandui") ? "partial" : null;
      let reportedAnswer = node.querySelector(".myAnswer .answerCon")?.textContent.replace(/\s/g, "") || null;
      if (typeInput.value === "3" && reportedAnswer) {
        reportedAnswer = /^(true|对|正确)$/i.test(reportedAnswer) ? "true"
          : /^(false|错|错误)$/i.test(reportedAnswer) ? "false" : null;
      } else if (reportedAnswer) {
        const letters = reportedAnswer.toUpperCase().replace(/[,，、]/g, "");
        reportedAnswer = /^[A-Z]+$/.test(letters)
          ? options.filter((option) => letters.includes(option.value)).map((option) => option.value).join("") : null;
      }
      return { id, number: index + 1, type: typeInput.value, options, feedback, reportedAnswer, node, rows };
    });
  }

  /** 用原页面事件更新选项和隐藏表单，避免只改输入值导致 UI 与提交内容不一致。 */
  function fill(question, answer) {
    const wanted = new Set(question.type === "1" ? answer.split("") : [answer]);
    for (const row of question.rows) {
      const option = row.querySelector("span[data]");
      const selected = option.classList.contains("check_answer") || option.classList.contains("check_answer_dx");
      const shouldSelect = wanted.has(option.getAttribute("data"));
      if (question.type === "1" ? selected !== shouldSelect : shouldSelect && !selected) globalThis.CXQuizPage.click(row);
    }
    const actual = form.elements.namedItem(`answer${question.id}`)?.value;
    if (actual !== answer) throw new Error(`第 ${question.number} 题填入校验失败，未提交任何答案`);
  }

  const host = document.createElement("section");
  host.id = "cx-quiz-research";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host{display:block;margin:18px 0;font:14px/1.6 system-ui;color:#17242d}
    section{border:1px solid #b9cbd4;border-radius:10px;background:#f3f8fa;padding:16px}
    h2{font-size:17px;margin:0 0 8px}p{margin:8px 0}button{padding:7px 12px;margin:5px 8px 5px 0;cursor:pointer}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #dce5e9;padding:4px}
    details{max-height:300px;overflow:auto}output{display:block;white-space:pre-wrap}
  </style><section><h2>答案枚举研究</h2>
    <p>保存逐题反馈，锁定已确认正确的答案；部分正确的多选题继续尝试其他组合。</p>
    <p><label>多选策略 <select id="strategy"><option value="subset">反馈剪枝＋信息量优先</option><option value="exhaustive">完整枚举</option></select></label></p>
    <p>快速策略假设：少选且无错项才是部分正确，混入错项就是错误。仅在适用作业启用；发现矛盾会回退完整枚举。</p>
    <output>正在读取反馈…</output>
    <button id="prepare" disabled>填入下一轮答案</button><button id="clear" disabled>清空本作业记录</button>
    <p>填入后检查页面，再使用原页面的 Submit 提交。重定向后会自动读取新反馈。</p>
    <p><label>本次自动提交最多 <input id="max-rounds" type="number" min="1" max="4095" value="31" style="width:70px"> 轮</label></p>
    <button id="auto-start" disabled>自动枚举并提交，直到全部正确</button><button id="auto-stop" disabled>停止自动模式</button>
    <output id="auto-status">自动模式未启动。每轮间隔 5 秒；已发出的请求无法撤销。</output>
    <details><summary>查看逐题进度</summary><table><thead><tr><th>题号</th><th>状态</th><th>已试</th><th>剩余可能答案</th><th>下一答案</th><th>规则推断</th></tr></thead><tbody></tbody></table></details>
  </section>`;
  form.before(host);
  const output = shadow.querySelector("output");
  const prepare = shadow.querySelector("#prepare");
  const clear = shadow.querySelector("#clear");
  const autoStart = shadow.querySelector("#auto-start");
  const autoStop = shadow.querySelector("#auto-stop");
  const autoStatus = shadow.querySelector("#auto-status");
  const strategySelect = shadow.querySelector("#strategy");
  let questions;
  let state;
  let key;
  let currentPlan;
  let controller;
  let unavailable = true;
  let prepared = false;

  /** 两种模式共享同一份反馈；自动运行期间锁住手动操作，防止覆盖待提交答案。 */
  function showAutoStatus(message, running) {
    autoStatus.textContent = message;
    autoStart.disabled = running || unavailable;
    autoStop.disabled = !running;
    prepare.disabled = running || unavailable || prepared;
    clear.disabled = running;
    shadow.querySelector("#max-rounds").disabled = running;
    strategySelect.disabled = running;
  }

  function fillPlan() {
    for (const item of currentPlan) {
      const question = questions.find((entry) => entry.id === item.id);
      fill(question, item.answer);
    }
    prepared = true;
  }

  /** 持久化成功后才启用按钮；保存失败时不假装已经记录了反馈。 */
  async function initialize(reset = false, requestedStrategy) {
    prepare.disabled = true;
    clear.disabled = true;
    strategySelect.disabled = true;
    try {
      key = storageKey();
      controller ??= new globalThis.CXQuizAuto.Controller({ key, onStatus: showAutoStatus });
      // 只在初始化读取一次判题快照，避免填入新答案后把旧图标误配到新答案。
      questions ??= readQuestions();
      if (!questions.length) throw new Error("本页没有可识别的题目");
      const previous = reset ? null : (await chrome.storage.local.get(key))[key];
      state = core.observe(previous, questions, { strategy: requestedStrategy ?? previous?.strategy ?? "subset" });
      strategySelect.value = state.strategy;
      await chrome.storage.local.set({ [key]: state });
      currentPlan = core.plan(state, questions);
      Object.assign(controller.options, { questions, plan: currentPlan, fill: fillPlan });
      const locked = currentPlan.filter((item) => item.locked).length;
      const exhausted = currentPlan.filter((item) => item.answer === null).length;
      output.textContent = `共 ${questions.length} 题，已确认正确 ${locked} 题，待研究 ${questions.length - locked} 题。` +
        (exhausted ? `\n${exhausted} 题候选已耗尽，请核实题型和反馈，不再自动填入。` : "");
      const fallback = currentPlan.filter((item) => item.strategy === "fallback").length;
      if (fallback) output.textContent += `\n${fallback} 道多选题的反馈不符合规则，已回退完整枚举。`;
      const body = shadow.querySelector("tbody");
      body.replaceChildren();
      for (const item of currentPlan) {
        const tr = document.createElement("tr");
        const inference = item.reason || [item.included ? `必选 ${item.included}` : "", item.excluded ? `排除 ${item.excluded}` : ""].filter(Boolean).join("；") || "—";
        for (const value of [item.number, item.locked ? "已锁定" : item.answer === null ? "候选耗尽" : "待尝试", item.tried, item.remaining, item.answer ?? "—", inference]) {
          const td = document.createElement("td");
          td.textContent = String(value);
          tr.append(td);
        }
        body.append(tr);
      }
      // 历史上知道全部正确答案，不代表当前提交全部正确；手动改错后仍可重新填入。
      const complete = currentPlan.every((item) => item.locked && questions.some((q) =>
        q.id === item.id && q.feedback === "correct" && q.reportedAnswer === item.answer));
      unavailable = exhausted > 0 || complete;
      prepared = false;
      prepare.disabled = unavailable;
      autoStart.disabled = unavailable;
      clear.disabled = false;
      strategySelect.disabled = false;
      await controller.resume();
    } catch (error) {
      output.textContent = `已停止：${error.message}`;
      // 反馈冲突时仍允许从当前页面重新建立记录，避免界面无法恢复。
      if (key) clear.disabled = false;
      strategySelect.disabled = false;
      unavailable = true;
      prepare.disabled = true;
      autoStart.disabled = true;
      if (controller) {
        try { await controller.stop(`自动模式已停止：${error.message}`); }
        catch { autoStatus.textContent = "本页已停止，但保存停止状态失败；恢复存储后请重新检查"; }
      }
      // TODO: 为非客观题、随机选项和新判题标记增加经过样本验证的适配。
    }
  }

  prepare.addEventListener("click", () => {
    try {
      fillPlan();
      output.textContent = "已填入下一轮答案，正确答案保持锁定。请检查后点击原页面 Submit。";
      prepare.disabled = true;
    } catch (error) {
      output.textContent = `填入已停止：${error.message}。部分题目可能已修改，请检查；没有自动提交。`;
    }
  });
  autoStart.addEventListener("click", async () => {
    autoStart.disabled = true;
    try {
      await controller.start(Number(shadow.querySelector("#max-rounds").value));
    } catch (error) { showAutoStatus(`未启动：${error.message}`, false); }
  });
  autoStop.addEventListener("click", async () => {
    autoStop.disabled = true;
    try { await controller.stop(); }
    catch { showAutoStatus("本页已停止，但保存停止状态失败；请勿刷新后继续运行", false); }
  });
  strategySelect.addEventListener("change", () => { void initialize(false, strategySelect.value); });
  clear.addEventListener("click", () => { void initialize(true, strategySelect.value); });
  void initialize();
})();
