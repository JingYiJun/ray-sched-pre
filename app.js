/* eslint-disable no-console */

(() => {
  /** @typedef {"creating"|"idle"|"receiving"|"busy"|"sending"} WorkerStatus */

  /**
   * @typedef {object} Job
   * @property {number} id
   * @property {"new"|"retry"} kind
   * @property {number} durationSec
   * @property {number} createdAtMs
   * @property {number} tries
   */

  /**
   * @typedef {object} Worker
   * @property {number} id
   * @property {string} name
   * @property {WorkerStatus} status
   * @property {number | null} readyAtMs
   * @property {Job | null} job
   * @property {number | null} startedAtMs
   * @property {number | null} endsAtMs
   */

  const elInputQueue = mustGetEl("inputQueue");
  const elRetryQueue = mustGetEl("retryQueue");
  const elWorkers = mustGetEl("workers");
  const elSavedStrip = mustGetEl("savedStrip");
  const elAnimLayer = mustGetEl("animLayer");

  const elKpiProduced = mustGetEl("kpiProduced");
  const elKpiInputLen = mustGetEl("kpiInputLen");
  const elKpiRetryLen = mustGetEl("kpiRetryLen");
  const elKpiSaved = mustGetEl("kpiSaved");
  const elKpiFaults = mustGetEl("kpiFaults");

  const btnStart = mustGetEl("btnStart");
  const btnStop = mustGetEl("btnStop");
  const btnAddWorker = mustGetEl("btnAddWorker");
  const btnDeleteWorker = mustGetEl("btnDeleteWorker");

  const CONFIG = Object.freeze({
    initialWorkers: 3,
    workerCreateMs: 5000,
    produceIntervalMs: 850,
    flyMs: 520,
    maxQueueRender: 18,
    maxSavedRender: 22,
  });

  /** @type {boolean} */
  let running = false;
  /** @type {number | null} */
  let produceTimer = null;
  /** @type {number | null} */
  let rafId = null;

  /** @type {Animation[]} */
  let activeAnims = [];
  /** @type {Map<number, {inbound: Animation | null, outbound: Animation | null}>} */
  let workerAnims = new Map();

  /** @type {number} */
  let nextWorkerId = 1;
  /** @type {number} */
  let nextJobId = 1;

  /** @type {Job[]} */
  let inputQueue = [];
  /** @type {Job[]} */
  let retryQueue = [];
  /** @type {Worker[]} */
  let workers = [];
  /** @type {Job[]} */
  let saved = [];

  /** @type {number} */
  let producedCount = 0;
  /** @type {number} */
  let faultCount = 0;
  /** @type {number | null} */
  let selectedWorkerId = null;

  wireEvents();
  resetAll();
  renderAll(performance.now());

  function wireEvents() {
    btnStart.addEventListener("click", () => {
      if (running) return;
      start();
    });
    btnStop.addEventListener("click", () => {
      stopAndReset();
    });
    btnAddWorker.addEventListener("click", () => {
      if (!running) return;
      addWorker();
    });
    btnDeleteWorker.addEventListener("click", () => {
      if (!running) return;
      deleteSelectedOrLastWorker();
    });
  }

  function start() {
    running = true;
    updateButtons();

    produceTimer = window.setInterval(() => {
      enqueueNewJob();
      schedule();
      renderQueues();
      renderKpis();
    }, CONFIG.produceIntervalMs);

    tick(performance.now());
  }

  function stopAndReset() {
    running = false;
    if (produceTimer !== null) {
      window.clearInterval(produceTimer);
      produceTimer = null;
    }
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    cancelAllAnimations();
    resetAll();
    renderAll(performance.now());
    updateButtons();
  }

  function resetAll() {
    nextWorkerId = 1;
    nextJobId = 1;
    inputQueue = [];
    retryQueue = [];
    workers = [];
    saved = [];
    producedCount = 0;
    faultCount = 0;
    selectedWorkerId = null;
    elAnimLayer.innerHTML = "";
    activeAnims = [];
    workerAnims = new Map();

    const now = performance.now();
    for (let i = 0; i < CONFIG.initialWorkers; i += 1) {
      workers.push(makeWorker(now, false));
    }
  }

  function updateButtons() {
    btnStart.disabled = running;
    btnStop.disabled = !running;
    btnAddWorker.disabled = !running;
    btnDeleteWorker.disabled = !running || workers.length === 0;
  }

  /** @param {number} nowMs */
  function makeWorker(nowMs, creating) {
    /** @type {Worker} */
    const w = {
      id: nextWorkerId++,
      name: `worker ${nextWorkerId - 1}`,
      status: creating ? "creating" : "idle",
      readyAtMs: creating ? nowMs + CONFIG.workerCreateMs : null,
      job: null,
      startedAtMs: null,
      endsAtMs: null,
      receivingStartAtMs: null,
      receivingEndAtMs: null,
    };
    return w;
  }

  function addWorker() {
    const now = performance.now();
    workers.push(makeWorker(now, true));
    renderWorkers(now);
    renderKpis();
  }

  function deleteSelectedOrLastWorker() {
    if (workers.length === 0) return;

    const targetId =
      selectedWorkerId !== null && workers.some((w) => w.id === selectedWorkerId)
        ? selectedWorkerId
        : workers[workers.length - 1].id;

    const idx = workers.findIndex((w) => w.id === targetId);
    if (idx < 0) return;

    const w = workers[idx];
    if (w.job) {
      // 终止该 worker 自己的飞行/出站动画（如果有）
      cancelWorkerAnimations(w.id);
      // 故障：中断处理，取出数据，放入重试队列
      const job = w.job;
      w.job = null;
      w.startedAtMs = null;
      w.endsAtMs = null;
      w.receivingStartAtMs = null;
      w.receivingEndAtMs = null;
      retryQueue.unshift({
        ...job,
        kind: "retry",
        tries: job.tries + 1,
      });
      faultCount += 1;
    }

    workers.splice(idx, 1);
    if (selectedWorkerId === targetId) selectedWorkerId = null;

    schedule();
    renderAll(performance.now());
  }

  function enqueueNewJob() {
    const now = performance.now();
    /** @type {Job} */
    const job = {
      id: nextJobId++,
      kind: "new",
      durationSec: randInt(1, 10),
      createdAtMs: now,
      tries: 0,
    };
    inputQueue.push(job);
    producedCount += 1;
  }

  function schedule() {
    // 重试优先，其次新数据；每个 worker 只允许处理一条
    const now = performance.now();
    for (const w of workers) {
      if (w.status === "creating") continue;
      if (w.status !== "idle") continue;

      const fromKind = retryQueue.length > 0 ? "retry" : "new";
      const fromRoot = fromKind === "retry" ? elRetryQueue : elInputQueue;
      const fromBall = firstBallOrRoot(fromRoot);
      const fromPoint = pointFromEl(fromBall);

      const job = retryQueue.length > 0 ? retryQueue.shift() : inputQueue.shift();
      if (!job) continue;

      // 先播放飞行动画：队列 -> worker
      w.status = "receiving";
      w.job = job;
      w.startedAtMs = null;
      w.endsAtMs = null;
      w.receivingStartAtMs = now;
      w.receivingEndAtMs = now + CONFIG.flyMs;

      renderQueues(); // 立刻从队列视觉上“取走”
      renderWorkers(now);

      const midEl = getWorkerMidEl(w.id);
      const toPoint = midEl ? centerPointOf(midEl) : centerPointOf(fromRoot);
      const anim = flyBall(job.kind, fromPoint, toPoint);
      workerAnims.set(w.id, { inbound: anim, outbound: workerAnims.get(w.id)?.outbound ?? null });

      anim.finished
        .then(() => {
          if (!running) return;
          // worker 可能已被删除
          const ww = workers.find((x) => x.id === w.id);
          if (!ww) return;
          if (ww.status !== "receiving") return;
          if (!ww.job || ww.job.id !== job.id) return;
          startJobOnWorker(ww, job, performance.now());
          const cur = workerAnims.get(w.id);
          if (cur?.inbound === anim) workerAnims.set(w.id, { inbound: null, outbound: cur.outbound });
          renderWorkers(performance.now());
          renderKpis();
        })
        .catch(() => { });
    }
  }

  /** @param {Worker} w @param {Job} job @param {number} nowMs */
  function startJobOnWorker(w, job, nowMs) {
    w.status = "busy";
    w.job = job;
    w.startedAtMs = nowMs;
    w.endsAtMs = nowMs + job.durationSec * 1000;
    w.receivingStartAtMs = null;
    w.receivingEndAtMs = null;
  }

  /** @param {number} nowMs */
  function tick(nowMs) {
    rafId = window.requestAnimationFrame(tick);

    // 1) worker 创建态推进
    for (const w of workers) {
      if (w.status !== "creating") continue;
      if (w.readyAtMs !== null && nowMs >= w.readyAtMs) {
        w.status = "idle";
        w.readyAtMs = null;
      }
    }

    // 2) worker 运行态完成检测
    let anyCompleted = false;
    for (const w of workers) {
      if (w.status !== "busy") continue;
      if (w.endsAtMs !== null && nowMs >= w.endsAtMs && w.job) {
        // 先飞行动画：worker -> saver；动画结束后才算 saved，并释放 worker
        beginSendToSaver(w);
        anyCompleted = true;
      }
    }
    if (anyCompleted) {
      // 完成后立刻尝试调度下一条
      schedule();
    }

    renderWorkers(nowMs);
    if (anyCompleted) {
      renderSaved();
      renderQueues();
      renderKpis();
    } else {
      // 队列/指标变化不频繁：仅进度动画时不用重绘队列
      renderKpisMinimal();
    }
  }

  /** @param {number} nowMs */
  function renderAll(nowMs) {
    renderQueues();
    renderWorkers(nowMs);
    renderSaved();
    renderKpis();
    updateButtons();
  }

  function renderQueues() {
    renderQueue(elInputQueue, inputQueue, "new");
    renderQueue(elRetryQueue, retryQueue, "retry");
  }

  /** @param {HTMLElement} root @param {Job[]} queue @param {"new"|"retry"} kind */
  function renderQueue(root, queue, kind) {
    root.innerHTML = "";
    const limit = CONFIG.maxQueueRender;
    const items = queue.slice(0, limit);
    for (const job of items) {
      const b = document.createElement("div");
      b.className = `ball ball--${kind === "retry" ? "retry" : "new"}`;
      b.title = `#${job.id} 处理时长=${job.durationSec}s tries=${job.tries}`;
      root.appendChild(b);
    }
    if (queue.length > limit) {
      const more = document.createElement("div");
      more.className = "badge";
      more.textContent = `+${queue.length - limit}`;
      root.appendChild(more);
    }
  }

  /** @param {number} nowMs */
  function renderWorkers(nowMs) {
    elWorkers.innerHTML = "";

    for (const w of workers) {
      const card = document.createElement("div");
      card.className = "worker";
      card.dataset.workerId = String(w.id);
      if (selectedWorkerId === w.id) card.classList.add("worker--selected");
      card.addEventListener("click", () => {
        selectedWorkerId = selectedWorkerId === w.id ? null : w.id;
        renderWorkers(performance.now());
      });

      const top = document.createElement("div");
      top.className = "worker__top";

      const name = document.createElement("div");
      name.className = "worker__name";
      name.textContent = w.name;

      const badge = document.createElement("div");
      badge.className = "badge";
      if (w.status === "idle") {
        badge.classList.add("badge--idle");
        badge.textContent = "IDLE";
      } else if (w.status === "receiving") {
        badge.classList.add("badge--receiving");
        badge.textContent = "RECEIVING";
      } else if (w.status === "busy") {
        badge.classList.add("badge--busy");
        badge.textContent = "BUSY";
      } else if (w.status === "sending") {
        badge.classList.add("badge--sending");
        badge.textContent = "SENDING";
      } else {
        badge.classList.add("badge--creating");
        badge.textContent = "CREATING";
      }

      top.appendChild(name);
      top.appendChild(badge);

      const mid = document.createElement("div");
      mid.className = "worker__mid";

      if (w.status === "idle") {
        const ball = document.createElement("div");
        ball.className = "ball";
        ball.title = "空闲";
        mid.appendChild(ball);
      } else if (w.status === "creating") {
        const remainMs = Math.max(0, (w.readyAtMs ?? nowMs) - nowMs);
        const remainSec = Math.ceil(remainMs / 1000);
        mid.appendChild(makeRing(1 - remainMs / CONFIG.workerCreateMs, `${remainSec}s`, "创建中"));
      } else if (w.status === "receiving" && w.receivingStartAtMs !== null && w.receivingEndAtMs !== null) {
        const total = w.receivingEndAtMs - w.receivingStartAtMs;
        const done = clamp(nowMs - w.receivingStartAtMs, 0, total);
        const pct = total <= 0 ? 1 : done / total;
        const leftMs = Math.max(0, w.receivingEndAtMs - nowMs);
        const leftSec = Math.ceil(leftMs / 1000);
        mid.appendChild(makeRing(pct, `${leftSec}s`, "接收"));
      } else if (w.status === "busy" && w.job && w.startedAtMs !== null && w.endsAtMs !== null) {
        const total = w.endsAtMs - w.startedAtMs;
        const done = clamp(nowMs - w.startedAtMs, 0, total);
        const pct = total <= 0 ? 1 : done / total;
        const leftMs = Math.max(0, w.endsAtMs - nowMs);
        const leftSec = Math.ceil(leftMs / 1000);
        mid.appendChild(makeRing(pct, `${leftSec}s`, `#${w.job.id}`));
      } else if (w.status === "sending") {
        const ball = document.createElement("div");
        ball.className = "ball ball--saving";
        ball.title = "发送到 Saver";
        mid.appendChild(ball);
      }

      const meta = document.createElement("div");
      meta.className = "worker__meta";
      const m1 = document.createElement("div");
      const m2 = document.createElement("div");

      if (w.status === "busy" && w.job) {
        m1.textContent = `job #${w.job.id}`;
        m2.textContent = `耗时 ${w.job.durationSec}s`;
      } else if (w.status === "receiving" && w.job) {
        m1.textContent = `接收 job #${w.job.id}`;
        m2.textContent = w.job.kind === "retry" ? "来自重试队列" : "来自输入队列";
      } else if (w.status === "sending" && w.job) {
        m1.textContent = `保存中 #${w.job.id}`;
        m2.textContent = "写入 Saver";
      } else if (w.status === "creating") {
        m1.textContent = "资源准备中";
        m2.textContent = "不可调度";
      } else {
        m1.textContent = "空闲";
        m2.textContent = "可调度";
      }
      meta.appendChild(m1);
      meta.appendChild(m2);

      card.appendChild(top);
      card.appendChild(mid);
      card.appendChild(meta);

      elWorkers.appendChild(card);
    }
  }

  function renderSaved() {
    elSavedStrip.innerHTML = "";
    const items = saved.slice(-CONFIG.maxSavedRender);
    for (const job of items) {
      const b = document.createElement("div");
      b.className = "ball ball--saving";
      b.title = `已保存 #${job.id}（tries=${job.tries}，耗时=${job.durationSec}s）`;
      elSavedStrip.appendChild(b);
    }
  }

  function renderKpis() {
    elKpiProduced.textContent = String(producedCount);
    elKpiInputLen.textContent = String(inputQueue.length);
    elKpiRetryLen.textContent = String(retryQueue.length);
    elKpiSaved.textContent = String(saved.length);
    elKpiFaults.textContent = String(faultCount);
  }

  function renderKpisMinimal() {
    // 进度动画期间，只更新可能变化的：保存数不变时不用写；队列长度大多也不变
    elKpiInputLen.textContent = String(inputQueue.length);
    elKpiRetryLen.textContent = String(retryQueue.length);
    elKpiSaved.textContent = String(saved.length);
  }

  /**
   * @param {number} progress 0..1
   * @param {string} main
   * @param {string} sub
   */
  function makeRing(progress, main, sub) {
    const p = clamp(progress, 0, 1);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ring");
    svg.setAttribute("viewBox", "0 0 100 100");

    const bg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    bg.setAttribute("class", "ring__bg");
    bg.setAttribute("cx", "50");
    bg.setAttribute("cy", "50");
    bg.setAttribute("r", "38");

    const fg = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    fg.setAttribute("class", "ring__fg");
    fg.setAttribute("cx", "50");
    fg.setAttribute("cy", "50");
    fg.setAttribute("r", "38");
    // 圆周长 ~ 2πr = 238.76，CSS 中 dasharray 设为 238
    const dash = 238;
    const offset = Math.round(dash * (1 - p));
    fg.style.strokeDashoffset = String(offset);
    // 进度满后换色更“完成感”
    if (p >= 0.999) fg.style.stroke = "rgba(87,211,140,0.95)";

    const t1 = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t1.setAttribute("class", "ring__text");
    t1.setAttribute("x", "50");
    t1.setAttribute("y", "54");
    t1.setAttribute("text-anchor", "middle");
    t1.textContent = main;

    const t2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t2.setAttribute("class", "ring__sub");
    t2.setAttribute("x", "50");
    t2.setAttribute("y", "70");
    t2.setAttribute("text-anchor", "middle");
    t2.textContent = sub;

    svg.appendChild(bg);
    svg.appendChild(fg);
    svg.appendChild(t1);
    svg.appendChild(t2);
    return svg;
  }

  /** @param {number} a @param {number} b */
  function randInt(a, b) {
    const min = Math.ceil(a);
    const max = Math.floor(b);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /** @param {number} x @param {number} lo @param {number} hi */
  function clamp(x, lo, hi) {
    return Math.max(lo, Math.min(hi, x));
  }

  /** @param {HTMLElement} root */
  function firstBallOrRoot(root) {
    const ball = root.querySelector(".ball");
    return ball || root;
  }

  /** @param {number} workerId */
  function getWorkerMidEl(workerId) {
    const card = elWorkers.querySelector(`[data-worker-id="${workerId}"]`);
    if (!card) return null;
    const mid = card.querySelector(".worker__mid");
    return mid instanceof HTMLElement ? mid : null;
  }

  /** @param {Worker} w */
  function beginSendToSaver(w) {
    if (!w.job) return;
    if (w.status !== "busy") return;

    const job = w.job;
    w.status = "sending";
    w.startedAtMs = null;
    w.endsAtMs = null;

    const midEl = getWorkerMidEl(w.id);
    const fromPoint = midEl ? randomPointIn(midEl, 18) : centerPointOf(elWorkers);
    const toPoint = randomPointIn(elSavedStrip, 14);

    renderWorkers(performance.now());
    const anim = flyBall("saving", fromPoint, toPoint);
    workerAnims.set(w.id, { inbound: workerAnims.get(w.id)?.inbound ?? null, outbound: anim });
    anim.finished
      .then(() => {
        if (!running) return;
        const ww = workers.find((x) => x.id === w.id);
        if (!ww) return;
        // 如果中途被删除，任务会在 delete 中被回收，不在这里重复处理
        if (ww.status !== "sending") return;
        if (!ww.job || ww.job.id !== job.id) return;
        saved.push(job);
        ww.job = null;
        ww.status = "idle";
        const cur = workerAnims.get(w.id);
        if (cur?.outbound === anim) workerAnims.set(w.id, { inbound: cur.inbound, outbound: null });
        renderSaved();
        renderWorkers(performance.now());
        renderKpis();
        schedule();
      })
      .catch(() => { });
  }

  /**
   * @param {"new"|"retry"|"saving"} kind
   * @param {{x:number,y:number}} from
   * @param {{x:number,y:number}} to
   */
  function flyBall(kind, from, to) {
    const node = document.createElement("div");
    node.className = `ball fly ${kind === "retry" ? "ball--retry" : kind === "saving" ? "ball--saving" : "ball--new"}`;
    elAnimLayer.appendChild(node);

    const size = node.getBoundingClientRect();
    const x0 = from.x - size.width / 2;
    const y0 = from.y - size.height / 2;
    const x1 = to.x - size.width / 2;
    const y1 = to.y - size.height / 2;

    node.style.left = `${x0}px`;
    node.style.top = `${y0}px`;

    const dx = x1 - x0;
    const dy = y1 - y0;
    const lift = Math.min(70, Math.max(24, Math.abs(dy) * 0.18));

    const anim = node.animate(
      [
        { transform: "translate(0px, 0px) scale(1)" },
        { transform: `translate(${dx * 0.6}px, ${dy * 0.6 - lift}px) scale(1.05)` },
        { transform: `translate(${dx}px, ${dy}px) scale(0.92)` },
      ],
      { duration: CONFIG.flyMs, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" },
    );

    activeAnims.push(anim);
    anim.finished
      .then(() => {
        node.remove();
        activeAnims = activeAnims.filter((a) => a !== anim);
      })
      .catch(() => {
        node.remove();
        activeAnims = activeAnims.filter((a) => a !== anim);
      });
    return anim;
  }

  /** @param {HTMLElement} el */
  function pointFromEl(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** @param {HTMLElement} el */
  function centerPointOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** @param {HTMLElement} el @param {number} pad */
  function randomPointIn(el, pad) {
    const r = el.getBoundingClientRect();
    const safePadX = Math.max(0, Math.min(pad, Math.floor(r.width / 2) - 2));
    const safePadY = Math.max(0, Math.min(pad, Math.floor(r.height / 2) - 2));
    const x = randInt(Math.ceil(r.left + safePadX), Math.floor(r.right - safePadX));
    const y = randInt(Math.ceil(r.top + safePadY), Math.floor(r.bottom - safePadY));
    return { x, y };
  }

  function cancelAllAnimations() {
    for (const a of activeAnims) {
      try {
        a.cancel();
      } catch (_) { }
    }
    activeAnims = [];
    elAnimLayer.innerHTML = "";
    workerAnims = new Map();
  }

  /** @param {number} workerId */
  function cancelWorkerAnimations(workerId) {
    const cur = workerAnims.get(workerId);
    if (!cur) return;
    if (cur.inbound) {
      try {
        cur.inbound.cancel();
      } catch (_) { }
    }
    if (cur.outbound) {
      try {
        cur.outbound.cancel();
      } catch (_) { }
    }
    workerAnims.delete(workerId);
  }

  /** @param {string} id */
  function mustGetEl(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el;
  }
})();

