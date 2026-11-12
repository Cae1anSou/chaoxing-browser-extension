((root) => {
  "use strict";
  const logic = root.CXQuizAutoCore;

  /** 只处理已核实的超星提交确认和未及格跳转提示，不点击未知弹窗。 */
  function classifyDialog(content, okText) {
    // 英文页面实际使用 Submit＋全角问号；NFKC 同时兼容两种问号。
    const normalizedContent = content.normalize("NFKC").trim();
    const normalizedButton = okText.normalize("NFKC").trim();
    if (/^(提交|submit)$/i.test(normalizedButton) &&
      (/确认提交|确认交卷|confirm.*submit|submit.*confirm/i.test(normalizedContent) ||
        /^(submit|提交)\s*\?$/i.test(normalizedContent))) return "confirm";
    if (/^(确定|ok)$/i.test(okText) && /未达到及格|未达及格|未达到通过|Please do it again without reaching the line|Did not meet the passing criteria/i.test(content)) return "result";
    return "unknown";
  }

  /** 自动运行每页只提交一轮，下一轮由新的作业文档读取持久化记录后接续。 */
  class Controller {
    constructor(options) {
      this.options = options;
      this.autoKey = `${options.key}:auto`;
      const sessionKey = "cx-quiz-auto-tab";
      this.owner = sessionStorage.getItem(sessionKey) || crypto.randomUUID();
      sessionStorage.setItem(sessionKey, this.owner);
      this.run = null;
      this.abort = null;
      this.release = null;
      this.busy = false;
      this.roundTask = null;
      this.storageListener = (changes, area) => {
        if (area !== "local" || !changes[this.autoKey]) return;
        const next = changes[this.autoKey].newValue;
        if (this.busy && (!next?.active || next.owner !== this.owner || next.runId !== this.run?.runId)) {
          this.abort?.abort();
          this.release?.();
          this.busy = false;
          this.options.onStatus(next?.reason || "自动运行已在其他页面停止", false);
        }
      };
      chrome.storage.onChanged.addListener(this.storageListener);
    }

    /** 保持锁直到导航或停止，防止复制标签页和同作业多 frame 并发提交。 */
    async acquire() {
      if (!navigator.locks) throw new Error("浏览器不支持作业互斥锁，不能启用自动提交");
      return new Promise((resolve, reject) => {
        navigator.locks.request(this.autoKey, { ifAvailable: true }, async (lock) => {
          if (!lock) { resolve(false); return; }
          await new Promise((release) => { this.release = release; resolve(true); });
          this.release = null;
        }).catch(reject);
      });
    }

    /** 取消信号同时终止倒计时和轮询；停止后不再点击任何提交按钮。 */
    sleep(milliseconds) {
      return new Promise((resolve, reject) => {
        const signal = this.abort.signal;
        if (signal.aborted) { reject(new Error("已停止")); return; }
        const cancel = () => { clearTimeout(timer); reject(new Error("已停止")); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, milliseconds);
        signal.addEventListener("abort", cancel, { once: true });
      });
    }

    async read() {
      return (await chrome.storage.local.get(this.autoKey))[this.autoKey];
    }

    /** 每次点击前重读共享状态，接受其他标签页发来的停止指令。 */
    async assertActive() {
      const signal = this.abort?.signal;
      const runId = this.run?.runId;
      const saved = await this.read();
      if (signal?.aborted || !saved?.active || saved.owner !== this.owner || saved.runId !== runId) {
        throw new Error("自动运行已停止或由其他页面接管");
      }
    }

    async start(maxRounds) {
      if (this.busy) return;
      // 停止后的旧异步回调完全退出后才允许新会话写状态。
      await this.roundTask;
      const created = logic.createRun(this.owner, maxRounds, crypto.randomUUID());
      const existing = await this.read();
      if (existing?.active) throw new Error("本作业已有自动任务，请先停止再开始");
      if (!await this.acquire()) throw new Error("另一个标签页正在处理此作业");
      this.abort = new AbortController();
      this.run = created;
      try {
        await chrome.storage.local.set({ [this.autoKey]: this.run });
        this.busy = true;
        this.options.onStatus("自动模式已启动", true);
        this.roundTask = this.round();
      } catch (error) {
        this.release?.();
        throw error;
      }
    }

    async resume() {
      const saved = await this.read();
      if (!saved?.active) {
        if (saved?.reason) this.options.onStatus(saved.reason, false);
        return;
      }
      if (saved.owner !== this.owner) {
        this.options.onStatus("此作业的自动任务在另一个标签页运行；可点击停止", true);
        return;
      }
      if (!await this.acquire()) {
        this.options.onStatus("另一个页面正持有此作业的运行锁；可点击停止", true);
        return;
      }
      this.run = saved;
      this.abort = new AbortController();
      this.busy = true;
      try {
        this.run = logic.acceptResult(saved, this.options.questions);
        await chrome.storage.local.set({ [this.autoKey]: this.run });
        this.options.onStatus(`已读取第 ${saved.rounds} 轮结果`, true);
        this.roundTask = this.round();
      } catch (error) { await this.stop(error.message); }
    }

    /** 停止只取消后续动作；已经送到服务器的请求不能撤销。 */
    async stop(reason = "已手动停止自动模式") {
      this.abort?.abort();
      try {
        const saved = await this.read();
        if (saved) {
          await chrome.storage.local.set({ [this.autoKey]: { ...saved, active: false, reason } });
        }
      } finally {
        this.busy = false;
        this.release?.();
        this.options.onStatus(reason, false);
      }
    }

    isVisible(element) {
      if (!element?.getClientRects().length) return false;
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    }

    /** 顶层页和本 iframe 都可能承载 workPop；只查同源祖先中的已知容器。 */
    documents() {
      const documents = [];
      let frame = window;
      while (true) {
        try { documents.push(frame.document); } catch { break; }
        if (frame === frame.parent) break;
        frame = frame.parent;
      }
      return documents;
    }

    async round() {
      const signal = this.abort.signal;
      const runId = this.run.runId;
      try {
        const { questions, plan, fill, onStatus } = this.options;
        if (questions.length && plan.every((item) => item.locked && questions.some((q) =>
          q.id === item.id && q.feedback === "correct" && q.reportedAnswer === item.answer))) {
          await this.stop("全部题目已确认正确，自动模式已完成"); return;
        }
        // 先验证候选与轮数，避免候选耗尽时仍然倒计时或修改表单。
        const armed = logic.arm(this.run, questions, plan);
        const submit = document.querySelector('.btnSubmit[onclick*="btnBlueSubmit"]');
        if (!this.isVisible(submit)) throw new Error("本页没有可用的提交按钮，已停止；平台可能已结束作答");
        for (let seconds = 5; seconds > 0; seconds -= 1) {
          onStatus(`第 ${armed.rounds}/${armed.maxRounds} 轮：${seconds} 秒后自动填入并提交`, true);
          await this.sleep(1000);
        }
        await this.assertActive();
        const limit = Number(document.querySelector("#limitWorkSubmitTimes")?.value);
        const times = Number(document.querySelector("#addTimes")?.value);
        if (Number.isFinite(limit) && limit > 0 && times > limit) throw new Error("页面要求额外提交验证，已停止，请手动处理");
        fill();
        await this.assertActive();
        // 必须先写 pending 再点击，以便重定向后精确核对本轮结果。
        this.run = armed;
        await chrome.storage.local.set({ [this.autoKey]: armed });
        await this.assertActive();
        if (this.documents().some((d) => this.isVisible(d.querySelector("#workpop")))) {
          throw new Error("已有页面提示框未处理，未发起新的提交");
        }
        root.CXQuizPage.click(submit);
        onStatus(`第 ${armed.rounds} 轮：等待页面校验和提交确认`, true);
        const deadline = Date.now() + 120000;
        let confirmed = false;
        let resultClicked = false;
        const clickedDialogs = new WeakSet();
        while (Date.now() < deadline) {
          await this.sleep(250);
          await this.assertActive();
          for (const d of this.documents()) {
            if (["#inputCode", "#validate input", "#workVerify input"].some((selector) => this.isVisible(d.querySelector(selector)))) {
              throw new Error("出现验证码或额外验证，自动模式已停止，请手动处理");
            }
            const popup = d.querySelector("#workpop");
            if (!this.isVisible(popup)) continue;
            const ok = popup.querySelector("#popok");
            const kind = classifyDialog(popup.querySelector("#popcontent")?.textContent.trim() || "", ok?.textContent.trim() || "");
            if (kind === "confirm" && !confirmed && !clickedDialogs.has(popup)) {
              await this.assertActive();
              // 原站点按钮保留 validate、签名、submitLock 等原有提交逻辑。
              confirmed = true;
              clickedDialogs.add(popup);
              root.CXQuizPage.click(ok);
              onStatus(`第 ${armed.rounds} 轮：已确认提交，等待判题和重定向`, true);
            } else if (kind === "result" && confirmed && !resultClicked) {
              await this.assertActive();
              resultClicked = true;
              root.CXQuizPage.click(ok);
              onStatus(`第 ${armed.rounds} 轮：正在跳转读取判题结果`, true);
            } else if (kind === "unknown") {
              throw new Error("出现未识别的页面提示，自动模式已停止，请查看原页面");
            }
          }
        }
        throw new Error("两分钟内未完成提交或重定向，已停止，不自动重试本轮");
      } catch (error) {
        // 外部停止已经持久化，旧回调不再覆盖它的原因或新的运行会话。
        try {
          if (!signal.aborted && this.run?.runId === runId) await this.stop(error.message);
          else {
            const saved = await this.read();
            // 取消可能发生在 storage.set 等待期间，确保迟到的写入不能复活旧任务。
            if (saved?.active && saved.runId === runId) {
              await chrome.storage.local.set({ [this.autoKey]: { ...saved, active: false, reason: "自动运行已取消" } });
            }
          }
        } catch {
          this.options.onStatus("本页已停止，但持久化状态失败；请勿刷新后继续运行", false);
        }
      }
    }
  }

  root.CXQuizAuto = Object.freeze({ Controller, classifyDialog });
})(globalThis);
