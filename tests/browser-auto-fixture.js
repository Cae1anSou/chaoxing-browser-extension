/** 在独立的 HTTPS 测试标签页执行；仅操作模拟表单，不访问真实提交接口。 */
async function runBrowserAutoFixture(sources, scenario = "complete") {
  const data = {};
  let listeners = [];
  let frame;
  let failure;
  let reported = ["A", "true"];
  const submissions = [];
  const originalSession = sessionStorage.getItem("cx-quiz-auto-tab");
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const checks = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); checks.push(message); };

  function mark(index) {
    if (reported[index] === (index === 0 ? "AB" : "false")) return "marking_dui";
    return index === 0 && reported[index] === "A" ? "marking_bandui" : "marking_cuo";
  }

  function question(index, values) {
    const id = String(index + 1);
    const multiple = index === 0;
    return `<div class="TiMu"><input id="answertype${id}" name="answertype${id}" value="${multiple ? "1" : "3"}" type="hidden">
      <input id="answer${id}" name="answer${id}" value="${reported[index]}" type="hidden">
      <ul>${values.map((value) => {
        const selected = multiple ? reported[index].includes(value) : reported[index] === value;
        return `<li qid="${id}" qtype="${multiple ? "1" : "3"}" onclick="choose(this)">
          <span data="${value}" class="${multiple ? "num_option_dx" : "num_option"} ${selected ? multiple ? "check_answer_dx" : "check_answer" : ""}">${value}</span>
          <a class="after">${value}</a></li>`;
      }).join("")}</ul>
      <div class="myAnswer"><div class="answerCon">${reported[index]}</div></div>
      <div class="CorrectOrNot"><span class="${mark(index)}"></span></div></div>`;
  }

  async function render() {
    listeners = [];
    frame?.remove();
    // 模拟导航先销毁旧文档，等待其 Web Lock 释放后再安装新文档脚本。
    await pause(30);
    frame = document.createElement("iframe");
    frame.style.cssText = "width:950px;height:850px";
    document.body.replaceChildren(frame);
    const w = frame.contentWindow;
    const d = w.document;
    d.body.innerHTML = `<form id="form1">
      ${["userId", "courseId", "classId", "workRelationId", "workAnswerId"].map((name) => `<input name="${name}" value="fixture" type="hidden">`).join("")}
      <input name="randomOptions" value="false" type="hidden"><input id="addTimes" value="${submissions.length}" type="hidden">
      <input id="limitWorkSubmitTimes" value="100" type="hidden">
      ${question(0, ["A", "B"])}${question(1, ["true", "false"])}
      <a class="btnSubmit" href="javascript:void(0)" onclick="btnBlueSubmit()">Submit</a></form>
      <div id="workpop" style="display:none"><p id="popcontent"></p><a id="popok" href="javascript:void(0)"></a></div>`;
    w.choose = (row) => {
      const q = row.closest(".TiMu");
      const multiple = row.getAttribute("qtype") === "1";
      const cls = multiple ? "check_answer_dx" : "check_answer";
      const span = row.querySelector("span[data]");
      if (!multiple) for (const other of q.querySelectorAll("span[data]")) if (other !== span) other.classList.remove(cls);
      span.classList.toggle(cls);
      q.querySelector('input[id^="answer"]:not([id^="answertype"])').value = [...q.querySelectorAll(`span.${cls}`)].map((el) => el.getAttribute("data")).join("");
    };
    const popup = d.querySelector("#workpop");
    const content = d.querySelector("#popcontent");
    const ok = d.querySelector("#popok");
    w.btnBlueSubmit = () => {
      if (scenario === "captcha") {
        const input = d.createElement("input");
        input.id = "inputCode";
        d.body.append(input);
        return;
      }
      popup.style.display = "block";
      content.textContent = scenario === "english" ? "Submit？" : "确认提交？";
      ok.textContent = scenario === "english" ? "Submit" : "提交";
      ok.onclick = () => {
        const answers = ["answer1", "answer2"].map((name) => d.querySelector(`#${name}`).value);
        submissions.push(answers);
        if (scenario !== "stale") reported = answers;
        popup.style.display = "none";
        // 判题响应异步显示原站点的已知跳转提示。
        w.setTimeout(() => {
          content.textContent = scenario === "unknown" ? "未知错误，请稍后重试" : "Please do it again without reaching the line";
          ok.textContent = "OK";
          popup.style.display = "block";
          ok.onclick = () => { popup.style.display = "none"; void render().catch((error) => { failure = error; }); };
        }, 1);
      };
    };
    const nativeTimeout = w.setTimeout.bind(w);
    w.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, Math.min(delay, 10), ...args);
    const chrome = { storage: {
      onChanged: { addListener(callback) { listeners.push(callback); } },
      local: {
        async get(key) { return { [key]: structuredClone(data[key]) }; },
        async set(update) {
          const changes = {};
          for (const [key, value] of Object.entries(update)) {
            changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
            data[key] = structuredClone(value);
          }
          for (const listener of [...listeners]) listener(changes, "local");
        }
      }
    } };
    w.Function("chrome", sources.join("\n"))(chrome);
    // MAIN 桥接已捕获原生 click；模拟隔离环境直接点击业务节点会被 CSP 拦截。
    for (const element of d.querySelectorAll("li[qid], .btnSubmit, #popok")) {
      element.click = () => { throw new Error("模拟 ISOLATED CSP：请通过 MAIN 桥接操作"); };
    }
    await pause(20);
  }

  try {
    await render();
    let shadow = frame.contentDocument.querySelector("#cx-quiz-research").shadowRoot;
    if (scenario !== "fast") {
      shadow.querySelector("#strategy").value = "exhaustive";
      shadow.querySelector("#strategy").dispatchEvent(new frame.contentWindow.Event("change"));
      await pause(20);
    }
    check(!shadow.querySelector("#prepare").disabled, "手动模式可用");
    check(!shadow.querySelector("#auto-start").disabled, "自动模式可用");
    if (scenario === "budget") shadow.querySelector("#max-rounds").value = "1";
    shadow.querySelector("#auto-start").click();
    if (scenario === "stop") {
      for (let i = 0; i < 20 && shadow.querySelector("#auto-stop").disabled; i++) await pause(1);
      shadow.querySelector("#auto-stop").click();
      await pause(150);
      check(submissions.length === 0, "倒计时中停止后未提交");
      check(shadow.querySelector("#auto-status").textContent.includes("停止"), "停止状态已展示");
      return { scenario, checks, submissions };
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      shadow = frame?.contentDocument?.querySelector("#cx-quiz-research")?.shadowRoot;
      const text = shadow?.querySelector("#auto-status")?.textContent || "";
      if (!["complete", "english", "fast"].includes(scenario) && Object.values(data).some((value) => value?.active === false)) break;
      if (text.includes("全部题目已确认正确")) break;
      if (text.includes("已停止") || text.startsWith("未启动：")) throw new Error(text);
      await pause(20);
    }
    if (!["complete", "english", "fast"].includes(scenario)) {
      const reason = Object.values(data).find((value) => value?.active === false)?.reason || "";
      const expected = { budget: /上限/, captcha: /验证码/, unknown: /未识别/, stale: /上一轮/ }[scenario];
      check(expected.test(reason), `按预期停止：${reason}`);
      check(submissions.length === (scenario === "captcha" ? 0 : 1), "停止后没有额外提交");
      return { scenario, checks, submissions };
    }
    check(shadow.querySelector("#auto-status").textContent.includes("全部题目已确认正确"), `连续自动运行完成：${shadow.querySelector("#auto-status").textContent}`);
    const expectedSubmissions = scenario === "fast" ? [["AB", "false"]] : [["B", "false"], ["AB", "false"]];
    check(submissions.length === expectedSubmissions.length, "每轮只提交一次，没有重复提交");
    check(JSON.stringify(submissions) === JSON.stringify(expectedSubmissions), scenario === "fast"
      ? "快速策略利用 A 部分正确直接推断 AB，只提交一轮"
      : "重定向后继续多选枚举，保留判断题的正确答案");
    check(shadow.querySelector("#auto-stop").disabled, "全部正确后自动停止");
    check(Object.values(data).some((value) => value?.schema === 1 && value?.active === false), "完成状态已持久化");
    return { checks, submissions, networkRequests: 0 };
  } finally {
    listeners = [];
    frame?.remove();
    if (originalSession === null) sessionStorage.removeItem("cx-quiz-auto-tab");
    else sessionStorage.setItem("cx-quiz-auto-tab", originalSession);
  }
}
