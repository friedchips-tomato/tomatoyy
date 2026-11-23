(() => {
  "use strict";

  // 值班运营台（演示）：工单分派、预约确认、车场标记和点位内容一览。
  // 游客端记录读自 cd-paper-3d-pixel-v1；运营台改动写入 cd-paper-3d-pixel-ops-v1，游客端「我的」随之显示新状态。
  const data = window.CD_DATA;
  const byId = id => document.getElementById(id);
  const view = byId("view");
  const guestKey = "cd-paper-3d-pixel-v1";
  const opsKey = "cd-paper-3d-pixel-ops-v1";
  const stages = ["已受理", "已分派", "处理中", "待评价"];
  const departments = ["街道市政", "环卫", "文旅内容组", "街区管理办"];
  const points = new Map(data.points.map(point => [point.id, point]));
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60000).toISOString();

  // 示范工单与预约：时间相对当前时刻生成，便于演示「超时」提示
  const seedTickets = [
    { id: "CD-DEMO-0001", type: "设施损坏", place: "堤东路骑楼", description: "骑楼下排水沟盖板翘起，行人容易绊脚。", at: minutesAgo(96), demo: true, stage: 1, dept: "街道市政" },
    { id: "CD-DEMO-0002", type: "环境卫生", place: "水埠头石阶", description: "石阶旁垃圾桶满溢，周末人多。", at: minutesAgo(38), demo: true, stage: 0 },
    { id: "CD-DEMO-0003", type: "导览内容有误", place: "启明里", description: "讲解里的年份和巷口展板对不上，请核对。", at: minutesAgo(60 * 20), demo: true, stage: 3, dept: "文旅内容组" }
  ];
  const seedBookings = [
    { id: "BK-DEMO-001", guide: "G3", name: "讲解员 C", slot: "15:30", people: 4, at: minutesAgo(42), demo: true },
    { id: "BK-DEMO-002", guide: "G2", name: "讲解员 B", slot: "09:30", people: 2, at: minutesAgo(180), demo: true, status: "已确认" }
  ];

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }

  const ops = readJSON(opsKey);
  ops.tickets ||= {};
  ops.bookings ||= {};
  ops.lots ||= {};
  ops.log ||= {};

  function save() {
    try {
      localStorage.setItem(opsKey, JSON.stringify(ops));
    } catch {
      say("浏览器限制本地存储，改动仅在当前页面保留。");
    }
  }

  const say = text => { byId("announcement").textContent = text; };
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const pad = value => String(value).padStart(2, "0");
  const clock = iso => {
    const time = new Date(iso);
    return `${time.getMonth() + 1}/${time.getDate()} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
  };
  const since = iso => {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return minutes < 60 ? `${minutes} 分钟前` : minutes < 60 * 24 ? `${Math.floor(minutes / 60)} 小时前` : `${Math.floor(minutes / 1440)} 天前`;
  };
  const action = (label, name, id = "", classes = "button", attributes = "") =>
    `<button type="button" class="${classes}" data-action="${name}" data-id="${escape(id)}" ${attributes}>${escape(label)}</button>`;

  function tickets() {
    const guest = readJSON(guestKey).requests || [];
    return [...guest.map(request => ({ ...request, place: "游客未注明", at: request.at || new Date().toISOString() })), ...seedTickets]
      .map(ticket => {
        const saved = ops.tickets[ticket.id] || {};
        return { ...ticket, stage: saved.stage ?? ticket.stage ?? 0, dept: saved.dept ?? ticket.dept ?? "" };
      });
  }

  function bookings() {
    const guest = readJSON(guestKey).bookings || [];
    return [...guest, ...seedBookings].filter(booking => booking.id)
      .map(booking => ({ ...booking, status: ops.bookings[booking.id] || booking.status || "待确认", at: booking.at || new Date().toISOString() }));
  }

  function lots() {
    return data.parking.map(lot => ({ ...lot, stale: Boolean(ops.lots[lot.id]?.stale) }));
  }

  function addLog(id, text) {
    (ops.log[id] ||= []).unshift({ at: new Date().toISOString(), text });
  }

  function timeline(stage) {
    return `<ol class="timeline">${stages.map((label, index) =>
      `<li class="${index <= stage ? "done" : ""}" ${index === stage ? 'aria-current="step"' : ""}><i></i>${label}</li>`).join("")}</ol>`;
  }

  function tag(status) {
    const kind = { 已确认: "ok", 已婉拒: "warn", 待评价: "ok", 待确认: "solid", 已受理: "solid" }[status] || "";
    return `<span class="tag ${kind}">${escape(status)}</span>`;
  }

  function ticketItem(ticket) {
    const late = ticket.stage === 0 && Date.now() - new Date(ticket.at) > 30 * 60000;
    return `<article class="card item">
      <div>
        <h3><a href="#ticket/${encodeURIComponent(ticket.id)}">${escape(ticket.type)} · ${escape(ticket.place)}</a></h3>
        <p>${escape(ticket.description)}</p>
        <p class="meta"><span>${escape(ticket.id)}</span><span class="${late ? "overdue" : ""}">${since(ticket.at)}提交${late ? " · 超过 30 分钟未分派" : ""}</span>${ticket.dept ? `<span>${escape(ticket.dept)}</span>` : ""}${ticket.demo ? '<span class="tag demo">示范</span>' : '<span class="tag">本机游客端</span>'}</p>
        ${timeline(ticket.stage)}
      </div>
      <div class="actions">${ticketNext(ticket)}</div>
    </article>`;
  }

  function ticketNext(ticket) {
    if (ticket.stage === 0) return `<a class="button primary" href="#ticket/${encodeURIComponent(ticket.id)}">分派</a>`;
    if (ticket.stage === 1) return action("开始处理", "stage", ticket.id, "button primary", 'data-to="2"');
    if (ticket.stage === 2) return action("办结，待评价", "stage", ticket.id, "button primary", 'data-to="3"');
    return action("重新处理", "stage", ticket.id, "button", 'data-to="2"');
  }

  function bookingItem(booking) {
    const late = booking.status === "待确认" && Date.now() - new Date(booking.at) > 30 * 60000;
    return `<article class="card item">
      <div>
        <h3>${escape(booking.name)} · ${escape(booking.slot)} · ${escape(booking.people)} 人</h3>
        <p class="meta"><span>${escape(booking.id)}</span><span class="${late ? "overdue" : ""}">${since(booking.at)}提交${late ? " · 已超确认时限" : ""}</span>${booking.demo ? '<span class="tag demo">示范</span>' : '<span class="tag">本机游客端</span>'}</p>
      </div>
      <div class="actions">${booking.status === "待确认"
        ? action("婉拒", "booking", booking.id, "button", 'data-to="已婉拒"') + action("确认", "booking", booking.id, "button primary", 'data-to="已确认"')
        : tag(booking.status) + action("撤回", "booking", booking.id, "button ghost", 'data-to="待确认"')}</div>
    </article>`;
  }

  function lotCard(lot, compact = false) {
    const percent = lot.free / lot.total * 100;
    const color = lot.stale ? "#6f6556" : percent > 30 ? "#3f6b62" : percent >= 10 ? "#9a6a12" : "#b23a2a";
    return `<article class="card lot ${lot.stale ? "stale" : ""}" style="--meter-color:${color}">
      <div class="row"><h3>${escape(lot.name)}</h3><span><strong class="big">${lot.free}</strong><span class="small"> / ${lot.total}</span></span></div>
      <div class="meter" style="--free:${percent}%"><span></span></div>
      <p class="small">更新于 ${escape(lot.updated)} · ${escape(lot.fee)}${lot.stale ? " · <b class='overdue'>已标记陈旧，游客端不显示为实时</b>" : ""}</p>
      ${compact ? "" : `<p>${escape(lot.reason)}</p><p class="small">未来 1 小时（模拟）：${lot.forecast.join(" → ")}</p>
        <div class="actions">${action(lot.stale ? "恢复为实时" : "标记数据陈旧", "lot", lot.id, lot.stale ? "button" : "button primary")}</div>`}
    </article>`;
  }

  const views = {
    overview() {
      const list = tickets();
      const open = list.filter(ticket => ticket.stage < 3);
      const waiting = bookings().filter(booking => booking.status === "待确认");
      const unassigned = open.filter(ticket => ticket.stage === 0);
      const guest = readJSON(guestKey);
      const free = lots().filter(lot => !lot.stale).reduce((sum, lot) => sum + lot.free, 0);
      return `
        <div class="stats">
          <div class="card stat"><span class="small">待分派诉求</span><strong>${unassigned.length}<small> 件</small></strong></div>
          <div class="card stat"><span class="small">处理中诉求</span><strong>${open.length - unassigned.length}<small> 件</small></strong></div>
          <div class="card stat"><span class="small">待确认预约</span><strong>${waiting.length}<small> 单</small></strong></div>
          <div class="card stat calm"><span class="small">实时车位（示范）</span><strong>${free}<small> 个</small></strong></div>
        </div>
        <div class="columns">
          <section class="stack"><h3 class="section-title">现在要处理</h3>
            <div class="list">${[...unassigned.map(ticketItem), ...waiting.map(bookingItem)].join("") || '<p class="empty">没有待办，喝口茶。</p>'}</div>
          </section>
          <section class="stack"><h3 class="section-title">车场</h3>
            <div class="list">${lots().map(lot => lotCard(lot, true)).join("")}</div>
            <h3 class="section-title">本机游客端</h3>
            <article class="card quiet"><p class="small">已点亮 ${(guest.lit || []).length} / ${data.points.filter(point => point.key).length} · 游记 ${(guest.journal || []).length} 条 · 诉求 ${(guest.requests || []).length} 件 · 预约 ${(guest.bookings || []).length} 单</p></article>
          </section>
        </div>`;
    },
    tickets(filter) {
      const list = tickets();
      const current = filter === "" || filter === undefined ? "open" : filter;
      const shown = list.filter(ticket => current === "all" || (current === "open" ? ticket.stage < 3 : ticket.stage === Number(current)));
      const filters = [["open", "未办结"], ["0", "待分派"], ["1", "已分派"], ["2", "处理中"], ["3", "待评价"], ["all", "全部"]];
      return `<div class="filters" role="group" aria-label="工单筛选">${filters.map(([id, label]) =>
        `<a class="chip" href="#tickets/${id}" ${id === current ? 'aria-current="true"' : ""}>${label} ${id === "all" ? list.length : list.filter(ticket => id === "open" ? ticket.stage < 3 : ticket.stage === Number(id)).length}</a>`).join("")}</div>
        <div class="list">${shown.map(ticketItem).join("") || '<p class="empty">这一栏没有工单</p>'}</div>`;
    },
    ticket(id) {
      const ticket = tickets().find(item => item.id === id);
      if (!ticket) return '<p class="empty">找不到这张工单</p><a class="button" href="#tickets">回到工单</a>';
      const log = [...(ops.log[id] || []), { at: ticket.at, text: "游客提交，系统受理" }];
      return `<div class="columns">
        <section class="card detail">
          <div class="row"><h3>${escape(ticket.type)} · ${escape(ticket.place)}</h3>${tag(stages[ticket.stage])}</div>
          ${timeline(ticket.stage)}
          <dl>
            <dt>工单编号</dt><dd>${escape(ticket.id)}</dd>
            <dt>提交时间</dt><dd>${clock(ticket.at)}（${since(ticket.at)}）</dd>
            <dt>描述</dt><dd>${escape(ticket.description)}</dd>
            <dt>联系方式</dt><dd class="masked">${ticket.contact || ticket.demo ? "已隐藏 · 仅授权处理人员可见" : "未留"}</dd>
            <dt>附图</dt><dd class="small">演示版不上传图片，附图只在游客本机预览</dd>
            <dt>处理部门</dt><dd>${escape(ticket.dept || "未分派")}</dd>
          </dl>
          ${ticket.stage === 0 ? `<form class="assign" data-form="assign" data-id="${escape(ticket.id)}">
            <label class="field">分派给<select name="dept" required><option value="">选择部门</option>${departments.map(dept => `<option>${escape(dept)}</option>`).join("")}</select></label>
            <button class="button primary" type="submit">分派</button>
          </form>` : `<div class="actions">${ticketNext(ticket)}</div>`}
        </section>
        <section class="stack"><h3 class="section-title">处理记录</h3>
          <ol class="log">${log.map(entry => `<li><time>${clock(entry.at)}</time>${escape(entry.text)}</li>`).join("")}</ol>
          <a class="link" href="#tickets">‹ 回到工单列表</a>
        </section>
      </div>`;
    },
    bookings() {
      const list = bookings();
      const waiting = list.filter(booking => booking.status === "待确认");
      const done = list.filter(booking => booking.status !== "待确认");
      return `<p class="small">目标：游客提交后 30 分钟内确认。讲解员与时段为示范数据。</p>
        <section class="stack"><h3 class="section-title">待确认 ${waiting.length}</h3><div class="list">${waiting.map(bookingItem).join("") || '<p class="empty">没有待确认的预约</p>'}</div></section>
        <section class="stack"><h3 class="section-title">已处理 ${done.length}</h3><div class="list">${done.map(bookingItem).join("") || '<p class="empty">暂无</p>'}</div></section>`;
    },
    parking() {
      return `<p class="small">余位与预测为示范数据。接口断连或数据过旧时标记陈旧，游客端不再当作实时显示。</p>
        <div class="columns" style="grid-template-columns:repeat(auto-fit,minmax(260px,1fr))">${lots().map(lot => lotCard(lot)).join("")}</div>`;
    },
    content() {
      return `<p class="small">点位、小卡与三语讲解的现状。标「待核实」的点位来自名称或简介里的「示意 / 待核实」字样，上线前需人工核对。</p>
        <div class="card table-wrap"><table class="content-table">
          <thead><tr><th>点位</th><th>状态</th><th>类别</th><th>小卡</th><th>讲解</th><th>来源</th></tr></thead>
          <tbody>${data.points.map(point => {
            const pending = /示意|待核实/.test(point.name + point.intro + point.oneLine);
            return `<tr>
              <td><strong>${escape(point.name)}</strong><br><span class="small">${escape(point.id)}</span></td>
              <td>${pending ? '<span class="tag warn">待核实</span>' : point.parking ? '<span class="tag demo">示范</span>' : '<span class="tag ok">有来源</span>'}</td>
              <td>${escape(point.category)}${point.key ? " · 可收集" : ""}</td>
              <td>${point.card ? escape(point.cardName) : "—"}</td>
              <td>${point.guide ? "普 / 粤 / EN 文稿" : "—"}</td>
              <td>${point.sources.length} 条</td>
            </tr>`;
          }).join("")}</tbody>
        </table></div>`;
    }
  };

  const titles = {
    overview: ["值班总览", "今天"], tickets: ["诉求工单", "接诉即办"], ticket: ["工单详情", "接诉即办"],
    bookings: ["讲解预约", "讲解员调度"], parking: ["车场", "停车"], content: ["点位内容", "史料与讲解"]
  };

  function render() {
    const [name, ...rest] = (location.hash.slice(1) || "overview").split("/");
    const key = Object.hasOwn(views, name) ? name : "overview";
    const arg = decodeURIComponent(rest.join("/"));
    byId("view-title").textContent = titles[key][0];
    byId("view-kicker").textContent = titles[key][1];
    document.querySelectorAll("#ops-nav a").forEach(link => {
      const active = link.dataset.view === (key === "ticket" ? "tickets" : key);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    const open = tickets().filter(ticket => ticket.stage < 3).length;
    const waiting = bookings().filter(booking => booking.status === "待确认").length;
    document.querySelector('[data-badge="tickets"]').textContent = open || "";
    document.querySelector('[data-badge="bookings"]').textContent = waiting || "";
    view.innerHTML = views[key](arg);
    view.style.animation = "none";
    void view.offsetWidth;
    view.style.animation = "";
  }

  document.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action: name, id, to } = button.dataset;
    if (name === "stage") {
      const stage = Number(to);
      ops.tickets[id] = { ...ops.tickets[id], stage, dept: ops.tickets[id]?.dept ?? tickets().find(item => item.id === id)?.dept };
      addLog(id, { 2: button.textContent === "重新处理" ? "游客反馈未解决，重新处理" : "开始现场处理", 3: "办结，等待游客评价" }[stage]);
      say(`${id} 已更新为「${stages[stage]}」`);
    } else if (name === "booking") {
      ops.bookings[id] = to;
      say(`${id} ${to}`);
    } else if (name === "lot") {
      ops.lots[id] = { stale: !ops.lots[id]?.stale };
    }
    save();
    render();
  });

  document.addEventListener("submit", event => {
    const form = event.target;
    if (form.dataset.form !== "assign") return;
    event.preventDefault();
    const dept = new FormData(form).get("dept");
    const id = form.dataset.id;
    ops.tickets[id] = { ...ops.tickets[id], stage: 1, dept };
    addLog(id, `分派给${dept}`);
    save();
    say(`${id} 已分派给${dept}`);
    render();
  });

  addEventListener("hashchange", render);
  addEventListener("storage", event => { if ([guestKey, opsKey].includes(event.key)) location.reload(); });

  function tick() {
    const now = new Date();
    byId("clock").textContent = `${now.getMonth() + 1} 月 ${now.getDate()} 日 ${pad(now.getHours())}:${pad(now.getMinutes())} · 值班中`;
  }
  byId("duty").textContent = "今日值班：值班员 A（示范）";
  tick();
  setInterval(tick, 30000);
  render();
})();
