(() => {
  "use strict";

  const data = window.CD_DATA;
  const byId = id => document.getElementById(id);
  const app = byId("app");
  const shell = byId("shell");
  const mapScroll = byId("map-scroll");
  const mapStage = byId("map-stage");
  const overlay = byId("overlay");
  const sheet = byId("sheet");
  const sheetBody = byId("sheet-body");
  const rewardLayer = byId("reward-layer");
  const navigation = byId("navigation");
  const mini = byId("mini-player");
  const points = new Map(data.points.map(point => [point.id, point]));
  const parking = new Map(data.parking.map(lot => [lot.id, lot]));
  const keyPoints = data.points.filter(point => point.key);
  const storageKey = "cd-demo-v1";
  const zoomLevels = [100, 150, 200];
  const langInfo = {
    zh: { locale: "zh-CN", label: "普通话" },
    yue: { locale: "zh-HK", label: "粤语" },
    en: { locale: "en-US", label: "English" }
  };
  const synth = window.speechSynthesis;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const svgNS = "http://www.w3.org/2000/svg";
  const mapPath = "assets/map.jpg";
  const spotElements = new Map();

  function readSaved() {
    try {
      return JSON.parse(localStorage.getItem(storageKey)) || {};
    } catch {
      return {};
    }
  }

  const saved = readSaved();
  const state = {
    lang: Object.hasOwn(langInfo, saved.lang) ? saved.lang : "zh",
    lit: new Set(Array.isArray(saved.lit) ? saved.lit.filter(id => points.has(id)) : []),
    bookings: Array.isArray(saved.bookings) ? saved.bookings : [],
    requests: Array.isArray(saved.requests) ? saved.requests : [],
    zoom: 0,
    mapRatio: 2 / 3,
    sheet: null,
    reward: null,
    returnFocus: null,
    drag: null,
    audio: null,
    story: null,
    route: null,
    routePreview: [],
    routeDraft: null,
    routeTimer: 0,
    visitTimer: 0,
    flashTimer: 0,
    serviceTab: "guides",
    guideLang: "",
    feedback: { type: "", description: "", contact: "", photo: null }
  };

  function say(text) {
    byId("announcement").textContent = text;
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        lang: state.lang, lit: [...state.lit], bookings: state.bookings, requests: state.requests
      }));
    } catch {
      say("浏览器限制本地存储，记录仅在当前页面保留。");
    }
  }

  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const center = ({ x, y, w, h }) => [x + w / 2, y + h / 2];
  const focus = element => element?.focus({ preventScroll: true });

  function action(label, name, id = "", classes = "button", attributes = "") {
    return `<button type="button" class="${classes}" data-action="${name}" data-id="${escape(id)}" ${attributes}>${escape(label)}</button>`;
  }

  function chip(label, name, id, selected) {
    return action(label, name, id, "chip", `aria-pressed="${selected}"`);
  }

  function loadImage(image, path, loaded, failed) {
    const candidates = [path];
    if (/\.jpg$/i.test(path)) candidates.push(path.replace(/\.jpg$/i, ".png"));
    function attempt(index) {
      image.onload = () => {
        image.onload = image.onerror = null;
        loaded?.(image);
      };
      image.onerror = () => {
        if (index + 1 < candidates.length) {
          attempt(index + 1);
        } else {
          image.onload = image.onerror = null;
          failed?.();
        }
      };
      image.src = candidates[index];
    }
    attempt(0);
  }

  function setRect(element, { x, y, w, h }) {
    element.style.setProperty("--x", `${x}%`);
    element.style.setProperty("--y", `${y}%`);
    element.style.setProperty("--w", `${w}%`);
    element.style.setProperty("--h", `${h}%`);
    element.style.setProperty("--point-y", y);
  }

  function setCrop(element, { x, y, w, h }) {
    element.style.setProperty("--bg-w", `${10000 / w}%`);
    element.style.setProperty("--bg-h", `${10000 / h}%`);
    element.style.setProperty("--bg-x", `${w === 100 ? 0 : x * 100 / (100 - w)}%`);
    element.style.setProperty("--bg-y", `${h === 100 ? 0 : y * 100 / (100 - h)}%`);
  }

  function cropArt(element) {
    const { x, y, w, h } = points.get(element.dataset.art).hotspot;
    const ratio = .75 / state.mapRatio;
    const width = Math.min(100, 100 * ratio, Math.max(w, h * ratio));
    const height = Math.min(100, width / ratio);
    setCrop(element, {
      x: clamp(x + (w - width) / 2, 0, 100 - width),
      y: clamp(y + (h - height) / 2, 0, 100 - height),
      w: width, h: height
    });
  }

  function art(point, classes = "") {
    return `<span class="art map-crop ${classes}" data-art="${escape(point.id)}" role="img" aria-label="${escape(point.name)}"></span>`;
  }

  function mountArt(container) {
    container.querySelectorAll("[data-art]").forEach(element => {
      cropArt(element);
      const point = points.get(element.dataset.art);
      if (!point.card) return;
      const image = new Image();
      image.alt = "";
      loadImage(image, point.card, () => element.replaceChildren(image));
    });
  }

  function initMap() {
    const colors = byId("map-colors");
    const markers = byId("map-points");
    data.points.forEach(point => {
      const color = document.createElement("div");
      color.className = "map-color";
      setRect(color, point.hotspot);
      setCrop(color, point.hotspot);
      colors.append(color);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-spot";
      button.dataset.action = "point";
      button.dataset.id = point.id;
      setRect(button, point.hotspot);
      const label = document.createElement("span");
      label.className = "map-label";
      label.textContent = point.name;
      button.append(label);
      markers.append(button);
      spotElements.set(point.id, { color, button });
    });
    loadImage(new Image(), mapPath, image => {
      state.mapRatio = image.naturalWidth / image.naturalHeight;
      mapStage.style.setProperty("--map-ratio", state.mapRatio);
      app.style.setProperty("--map-image", `url("${image.src}")`);
      app.querySelectorAll("[data-art]").forEach(cropArt);
    }, () => { byId("map-placeholder").hidden = false; });
  }

  function progressText() {
    return `已点亮 ${keyPoints.filter(point => state.lit.has(point.id)).length} / ${keyPoints.length}`;
  }

  function renderProgress() {
    const count = keyPoints.filter(point => state.lit.has(point.id)).length;
    byId("progress-label").textContent = progressText();
    byId("progress").max = Math.max(1, keyPoints.length);
    byId("progress").value = count;
    spotElements.forEach(({ color, button }, id) => {
      const lit = state.lit.has(id);
      color.classList.toggle("lit", lit);
      button.classList.toggle("lit", lit);
      button.setAttribute("aria-label", points.get(id).name + (lit ? "，已点亮" : ""));
    });
  }

  function renderLanguage() {
    byId("languages").querySelectorAll("button").forEach(button => {
      button.setAttribute("aria-pressed", button.dataset.id === state.lang);
    });
  }

  function moveMap(point, smooth = true) {
    const [x, y] = center(point.hotspot);
    mapScroll.scrollTo({
      left: mapStage.offsetWidth * x / 100 - mapScroll.clientWidth / 2,
      top: mapStage.offsetHeight * y / 100 - mapScroll.clientHeight / 2,
      behavior: smooth && !motion.matches ? "smooth" : "instant"
    });
  }

  function zoom(delta) {
    const next = clamp(state.zoom + delta, 0, zoomLevels.length - 1);
    if (next === state.zoom) return;
    const x = (mapScroll.scrollLeft + mapScroll.clientWidth / 2) / mapStage.offsetWidth;
    const y = (mapScroll.scrollTop + mapScroll.clientHeight / 2) / mapStage.offsetHeight;
    state.zoom = next;
    mapStage.style.setProperty("--map-zoom", `${zoomLevels[next]}%`);
    byId("zoom-level").textContent = `${zoomLevels[next]}%`;
    app.querySelector('[data-action="zoom"][data-id="-1"]').disabled = next === 0;
    app.querySelector('[data-action="zoom"][data-id="1"]').disabled = next === zoomLevels.length - 1;
    mapScroll.scrollTo({
      left: x * mapStage.offsetWidth - mapScroll.clientWidth / 2,
      top: y * mapStage.offsetHeight - mapScroll.clientHeight / 2,
      behavior: "instant"
    });
  }

  function renderNavigation() {
    const lines = byId("map-lines");
    lines.replaceChildren();
    byId("map-points").querySelectorAll(".map-note").forEach(note => note.remove());
    if (state.story) {
      const { story, index } = state.story;
      const ids = story.nodes.map(node => node.point);
      drawLine(ids, "#2c6460");
      ids.forEach((id, step) => {
        const note = document.createElement("div");
        note.className = "map-note";
        note.setAttribute("aria-hidden", "true");
        const number = document.createElement("span");
        number.textContent = step + 1;
        note.append(number);
        setRect(note, points.get(id).hotspot);
        byId("map-points").append(note);
      });
      const { point, text } = story.nodes[index];
      navigation.innerHTML = `
        <div class="nav-row"><strong>${escape(story.title)}</strong>${action("退出故事线", "exit-story")}</div>
        <div class="story-step">
          ${action("‹", "story-step", "-1", "icon-button", `aria-label="上一节" ${index === 0 ? "disabled" : ""}`)}
          <p><b>${index + 1} / ${ids.length} · ${escape(points.get(point).name)}</b>${escape(text)}</p>
          ${action("›", "story-step", "1", "icon-button", `aria-label="下一节" ${index === ids.length - 1 ? "disabled" : ""}`)}
        </div>`;
    } else if (state.route) {
      const { route, index } = state.route;
      drawLine(route.points, route.color);
      const point = points.get(route.points[index]);
      navigation.innerHTML = `<div class="nav-row">
        <strong>下一站：${escape(point.name)} · 第 ${index + 1}/${route.points.length} 站</strong>
        ${action("到了", "arrived", "", "button primary", state.visitTimer ? "disabled" : "")}
      </div>${route.start ? `<p class="small">路线起点：${escape(route.start.name)}</p>` : ""}`;
    } else {
      state.routePreview.forEach(route => drawLine(route.points, route.color));
      navigation.replaceChildren();
    }
    navigation.hidden = !state.story && !state.route;
  }

  function drawLine(ids, color) {
    const line = document.createElementNS(svgNS, "polyline");
    line.setAttribute("points", ids.map(id => center(points.get(id).hotspot).join(",")).join(" "));
    line.setAttribute("stroke", color);
    byId("map-lines").append(line);
  }

  const sheetTitles = {
    point: "点位卡", detail: "点位详情", route: "路线", "route-results": "推荐路线",
    scan: "模拟扫码", services: "服务", booking: "预约讲解员", "booking-success": "预约已提交",
    "feedback-success": "反馈已受理", mine: "我的", complete: "路线完成"
  };

  function syncModal() {
    shell.inert = Boolean(state.sheet || state.reward);
    overlay.inert = Boolean(state.reward);
  }

  function showSheet(kind, id = "", origin = document.activeElement) {
    if (!state.sheet && !state.reward) state.returnFocus = origin;
    if (state.sheet?.kind === "route" && kind !== "route-results") clearTimeout(state.routeTimer);
    state.sheet = { kind, id };
    const opening = overlay.hidden;
    overlay.hidden = false;
    syncModal();
    renderSheet();
    if (opening) sheet.scrollTop = 0;
    focus(sheet);
  }

  function closeSheet(restore = true) {
    if (!state.sheet) return;
    if (state.sheet.kind === "route") {
      clearTimeout(state.routeTimer);
      state.routeTimer = 0;
    }
    state.sheet = null;
    overlay.hidden = true;
    sheet.style.removeProperty("--sheet-drag");
    state.drag = null;
    byId("sheet-title").textContent = "";
    sheetBody.replaceChildren();
    syncModal();
    updateTabbar();
    if (restore) focus(state.returnFocus);
  }

  function updateTabbar() {
    const kind = state.sheet?.kind;
    const tab = {
      route: "route", "route-results": "route", scan: "scan", services: "services",
      booking: "services", "booking-success": "services", "feedback-success": "services", mine: "mine"
    }[kind];
    app.querySelectorAll('[data-action="menu"]').forEach(button => {
      button.setAttribute("aria-expanded", button.dataset.id === tab);
    });
  }

  function renderSheet(resetScroll = true) {
    const { kind, id } = state.sheet;
    const previousScroll = sheetBody.scrollTop;
    sheet.classList.toggle("full", kind === "detail");
    sheet.classList.toggle("preview", kind === "route-results");
    overlay.classList.toggle("preview", kind === "route-results");
    byId("sheet-title").textContent = kind === "detail" ? points.get(id).name : sheetTitles[kind];
    updateTabbar();
    sheetBody.innerHTML = `<div class="stack">${sheetContents(kind, id)}</div>`;
    mountArt(sheetBody);
    sheetBody.scrollTop = resetScroll ? 0 : previousScroll;
  }

  function sheetContents(kind, id) {
    switch (kind) {
      case "point": return renderPoint(points.get(id));
      case "detail": return renderDetail(points.get(id));
      case "route": return renderRouteForm();
      case "route-results": return renderRouteResults();
      case "scan": return renderScan();
      case "services": return renderServices();
      case "booking": return renderBooking(id);
      case "booking-success": return '<p>已提交，待讲解员确认（目标 30 分钟内）</p>' + action("查看我的预约", "my-records", "my-bookings");
      case "feedback-success": return `<div class="card"><h3>${escape(id)}</h3>${timeline()}</div>` + action("查看我的诉求", "my-records", "my-requests");
      case "mine": return renderMine();
      case "complete": return `<p>已走完「${escape(id)}」的全部站点。</p>${action("返回地图", "close", "", "button primary")}`;
    }
  }

  function renderPoint(point) {
    if (point.parking) {
      return `<div><span class="tag demo">示范数据</span></div>${parkingCard(parking.get(point.parking))}
        <div class="actions">${action("详情", "detail", point.id)}</div>`;
    }
    return `
      <div class="point-summary">
        ${art(point)}
        <div><span class="tag">${escape(point.category)}</span><h3>${escape(point.name)}</h3><p>${escape(point.oneLine)}</p></div>
      </div>
      <div class="actions">
        ${point.guide ? action("听讲解", "listen", point.id, "button secondary") : ""}
        ${action(state.lit.has(point.id) ? "已点亮" : "打卡", "check-in", point.id, "button primary", state.lit.has(point.id) ? "disabled" : "")}
        ${action("详情", "detail", point.id)}
      </div>
      <div data-transcript>${transcript(point.id)}</div>`;
  }

  function renderDetail(point) {
    const storySections = data.stories.flatMap(story => story.nodes.flatMap((node, index) => {
      if (node.point !== point.id) return [];
      return `<section class="card"><h3>${escape(story.title)}</h3>
        <p>${escape(node.text)}</p><div class="actions">
          ${action("看故事线", "start-story", story.id, "button secondary", `data-step="${index}"`)}
        </div></section>`;
    }));
    const sources = point.sources.length
      ? `<ul class="sources small">${point.sources.map(source => `<li>${escape(source)}</li>`).join("")}</ul>`
      : '<p class="small">暂无资料来源</p>';
    return `${art(point, "hero")}
      <p>${escape(point.intro)}</p>
      ${storySections.join("")}
      <section><h3 class="section-title">资料来源</h3>${sources}</section>
      <div class="actions">
        ${action("预约讲解员", "service", "guides", "button primary")}
        ${action("附近停车", "service", "parking")}
        ${action("返回点位卡", "point", point.id)}
      </div>`;
  }

  function openRoute(start = null) {
    state.routeDraft = { interests: new Set(), minutes: 60, mode: start ? "drive" : "walk", start, loading: false };
    showSheet("route");
  }

  function renderRouteForm() {
    const { interests, minutes, mode, start, loading } = state.routeDraft;
    if (loading) {
      return '<p role="status">正在生成路线</p>' + '<div class="card skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'.repeat(3);
    }
    return `
      <fieldset><legend>① 兴趣（可多选）</legend><div class="chips">
        ${data.interests.map(interest => chip(interest, "interest", interest, interests.has(interest))).join("")}
      </div></fieldset>
      <fieldset><legend>② 游览时长</legend><div class="chips">
        ${[30, 60, 120].map(value => chip(value + " 分钟", "duration", value, value === minutes)).join("")}
      </div></fieldset>
      <fieldset><legend>③ 出行方式</legend><div class="chips">
        ${chip("步行", "transport", "walk", mode === "walk")}${chip("自驾", "transport", "drive", mode === "drive")}
      </div></fieldset>
      ${start && mode === "drive" ? `<p class="small">路线起点：${escape(start.name)}</p>` : ""}
      ${action("生成路线", "generate", "", "button primary")}`;
  }

  function generateRoutes() {
    const draft = state.routeDraft;
    draft.loading = true;
    renderSheet();
    focus(sheet);
    state.routeTimer = setTimeout(() => {
      state.routeTimer = 0;
      const start = draft.mode === "drive" ? draft.start : null;
      const startPoint = start && data.points.find(point => point.parking === start.id);
      const score = route => route.tags.filter(tag => [...draft.interests].some(interest => interest.includes(tag))).length;
      state.routePreview = data.routes
        .slice()
        .sort((a, b) => (draft.mode === "drive" ? Number(Boolean(b.drive)) - Number(Boolean(a.drive)) : 0)
          || score(b) - score(a)
          || Math.abs(a.minutes - draft.minutes) - Math.abs(b.minutes - draft.minutes))
        .map(route => {
          if (!start) return route;
          const stops = route.points.filter(id => !points.get(id).parking);
          return { ...route, start, points: startPoint ? [startPoint.id, ...stops] : stops };
        });
      state.story = null;
      state.route = null;
      renderNavigation();
      showSheet("route-results");
    }, 800);
  }

  function renderRouteResults() {
    const start = state.routePreview.find(route => route.start)?.start;
    return `
      ${start ? `<p class="small">路线起点：${escape(start.name)}${data.points.some(point => point.parking === start.id) ? "" : "（地图暂无此停车点位）"}</p>` : ""}
      ${state.routePreview.map(route => `<article class="card route-card" style="--route-color:${escape(route.color)}">
        <div class="route-top"><h3>${escape(route.name)}</h3>${action("采纳", "adopt", route.id, "button secondary")}</div>
        <p class="small">${route.minutes} 分钟 · ${route.meters} 米 · ${route.points.length} 个点位</p>
        <p>${escape(route.reason)}</p>
      </article>`).join("")}`;
  }

  function adoptRoute(id) {
    const route = state.routePreview.find(item => item.id === id);
    state.route = { route, index: 0 };
    state.routePreview = [];
    closeSheet();
    renderNavigation();
    moveMap(points.get(route.points[0]));
  }

  function renderScan() {
    return '<p class="small">演示版：选择一个点位模拟扫码 / NFC</p>' +
      keyPoints.map(point => action(point.name, "scan-point", point.id, "list-button")).join("");
  }

  function renderServices() {
    const tabs = [["guides", "讲解员"], ["parking", "停车"], ["feedback", "反馈"]];
    const contents = {
      guides: renderGuides,
      parking: () => '<div><span class="tag demo">示范数据</span></div>' + data.parking.map(parkingCard).join(""),
      feedback: renderFeedback
    };
    return '<div class="service-tabbar" role="group" aria-label="服务分类">' +
      tabs.map(([id, label]) => chip(label, "service-tab", id, state.serviceTab === id)).join("") + "</div>" +
      contents[state.serviceTab]();
  }

  function renderGuides() {
    const langs = [...new Set(data.guides.flatMap(guide => guide.langs))];
    const guides = data.guides.filter(guide => !state.guideLang || guide.langs.includes(state.guideLang));
    return `
      <div><span class="tag demo">示范数据</span></div>
      <label class="field">讲解语种
        <select data-guide-filter>
          <option value="">全部语种</option>
          ${langs.map(lang => `<option ${lang === state.guideLang ? "selected" : ""}>${escape(lang)}</option>`).join("")}
        </select>
      </label>
      ${guides.map(guide => `<article class="card">
        <div class="route-top"><h3>${escape(guide.name)}</h3>${action("预约", "book", guide.id, "button secondary", `aria-label="预约${escape(guide.name)}"`)}</div>
        <p class="small">${escape(guide.level)} · ${guide.rating} 分 · ${escape(guide.langs.join(" / "))}</p>
        <p>${escape(guide.topics)}</p>
      </article>`).join("")}`;
  }

  function renderBooking(id) {
    const guide = data.guides.find(item => item.id === id);
    return `
      <div><span class="tag demo">示范数据</span></div>
      <form class="stack" data-form="booking" data-id="${escape(id)}">
        <h3>${escape(guide.name)}</h3>
        <label class="field">时段<select name="slot" required>
          <option value="">请选择</option>
          ${guide.slots.map(slot => `<option>${escape(slot)}</option>`).join("")}
        </select></label>
        <label class="field">人数<input name="people" type="number" inputmode="numeric" min="1" step="1" value="1" required></label>
        <button class="button primary" type="submit">提交预约</button>
      </form>`;
  }

  function parkingCard(lot) {
    const percent = lot.free / lot.total * 100;
    const color = percent > 30 ? "#497756" : percent >= 10 ? "#aa770e" : "#b34936";
    return `<article class="card">
      <div class="parking-header"><h3>${escape(lot.name)}</h3><strong>余位 ${lot.free} / ${lot.total}</strong></div>
      <div class="parking-meter" style="--free:${percent}%;--meter-color:${color}" aria-hidden="true"><span></span></div>
      <p class="small">步行 ${lot.walk} 米 · ${escape(lot.fee)} · 更新于 ${escape(lot.updated)}</p>
      <p>${escape(lot.reason)}</p>
      ${parkingChart(lot)}
      <p class="chart-legend small"><span>实线 · 历史余位</span><span>虚线 · 未来 1 小时</span></p>
      ${action("设为路线起点", "parking-start", lot.id, "button secondary")}
    </article>`;
  }

  function parkingChart(lot) {
    const values = [...lot.past, ...lot.forecast];
    const peak = Math.max(1, ...values);
    const coords = values.map((value, index) => `${6 + 288 * index / Math.max(1, values.length - 1)},${51 - 44 * value / peak}`);
    const now = lot.past.length - 1;
    const currentX = coords[now].split(",")[0];
    return `<svg class="parking-chart" viewBox="0 0 300 58" preserveAspectRatio="none" role="img"
      aria-label="历史余位：${lot.past.join("、")}。未来 1 小时预测：${lot.forecast.join("、")}。">
      <line x1="${currentX}" x2="${currentX}" y1="4" y2="54" stroke="#bab3a5"/>
      <polyline points="${coords.slice(0, now + 1).join(" ")}" stroke="#2c6460" stroke-width="2"/>
      <polyline points="${coords.slice(now).join(" ")}" stroke="#933a2a" stroke-width="2" stroke-dasharray="4 4"/>
    </svg>`;
  }

  function renderFeedback() {
    const { type, description, contact, photo } = state.feedback;
    return `<form class="stack" data-form="feedback">
      <label class="field">类型<select name="type" required>
        <option value="">请选择</option>
        ${data.feedbackTypes.map(value => `<option ${value === type ? "selected" : ""}>${escape(value)}</option>`).join("")}
      </select></label>
      <label class="field">描述<textarea name="description" required>${escape(description)}</textarea></label>
      <label class="field">图片（可选）<input name="photo" type="file" accept="image/*"></label>
      <img class="feedback-preview" alt="所选图片预览" ${photo ? `src="${escape(photo)}"` : "hidden"}>
      <label class="field">联系方式<input name="contact" value="${escape(contact)}" aria-describedby="contact-privacy"></label>
      <p id="contact-privacy" class="small">仅授权处理人员可见。演示数据仅在本机保存。</p>
      <button class="button primary" type="submit">提交反馈</button>
    </form>`;
  }

  function timeline() {
    return `<ol class="timeline">
      <li aria-current="step">已受理 ●</li><li>→ 分派 ○</li><li>→ 处理中 ○</li><li>→ 待评价 ○</li>
    </ol>`;
  }

  function submitFeedback(form, fields) {
    const description = fields.get("description").trim();
    if (!description) {
      form.elements.description.setCustomValidity("请填写描述。");
      form.elements.description.reportValidity();
      return;
    }
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, "0")).join("");
    const prefix = `CD-${date}-`;
    const sequence = 1 + state.requests.filter(request => request.id.startsWith(prefix)).length;
    const id = prefix + String(sequence).padStart(4, "0");
    state.requests.unshift({ id, type: fields.get("type"), description, contact: fields.get("contact").trim() });
    clearFeedback();
    save();
    showSheet("feedback-success", id);
  }

  function clearFeedback() {
    if (state.feedback.photo) URL.revokeObjectURL(state.feedback.photo);
    state.feedback = { type: "", description: "", contact: "", photo: null };
  }

  function renderMine() {
    const count = keyPoints.filter(point => state.lit.has(point.id)).length;
    return `
      <div class="mine-progress">
        <strong id="mine-progress-label">${progressText()}</strong>
        <progress value="${count}" max="${Math.max(1, keyPoints.length)}" aria-labelledby="mine-progress-label"></progress>
      </div>
      <section class="stack"><h3 class="section-title">电子卡册</h3>
        <div class="album">${keyPoints.map(point => `<article class="album-card">
          ${state.lit.has(point.id) ? art(point) : '<span class="art silhouette" aria-label="未获得" role="img"><b>?</b></span>'}
          <span>${escape(state.lit.has(point.id) ? point.cardName || point.name : point.name)}</span>
        </article>`).join("")}</div>
      </section>
      <section class="stack" id="my-bookings"><h3 class="section-title">我的预约</h3>
        ${state.bookings.map(booking => `<article class="card">
          <h3>${escape(booking.name)}</h3><p>${escape(booking.slot)} · ${escape(booking.people)} 人</p>
          <p class="small">待讲解员确认</p>
        </article>`).join("") || '<p class="small">暂无预约</p>'}
      </section>
      <section class="stack" id="my-requests"><h3 class="section-title">我的诉求</h3>
        ${state.requests.map(request => `<article class="card">
          <h3>${escape(request.type)} · ${escape(request.id)}</h3>
          <p>${escape(request.description)}</p>${timeline()}
        </article>`).join("") || '<p class="small">暂无诉求</p>'}
      </section>
      ${action("重置演示", "reset")}`;
  }

  function pickVoice(lang) {
    const locale = langInfo[lang].locale.toLowerCase();
    const voices = synth?.getVoices() || [];
    const candidates = voices.filter(voice => {
      const code = voice.lang.toLowerCase().replaceAll("_", "-");
      if (lang === "yue") return /^(yue|zh-(hk|mo))\b/.test(code);
      if (lang === "zh") return /^cmn\b/.test(code) || /^(zh|zh-(hans|cn|tw|sg)(-.+)?)$/.test(code);
      return /^en\b/.test(code);
    });
    return candidates.find(voice => voice.lang.toLowerCase().replaceAll("_", "-") === locale && voice.localService)
      || candidates.find(voice => voice.lang.toLowerCase().replaceAll("_", "-") === locale)
      || candidates.find(voice => voice.localService)
      || candidates[0];
  }

  function splitSentences(text, locale) {
    if (typeof Intl.Segmenter === "function") {
      return [...new Intl.Segmenter(locale, { granularity: "sentence" }).segment(text)].map(item => item.segment);
    }
    return text.match(/[^。！？.!?]+[。！？.!?]*|[。！？.!?]+/g) || [text];
  }

  function startGuide(point, paused = false) {
    stopGuide(false);
    if (!point.guide) return;
    const lang = state.lang;
    const text = point.guide[lang];
    const voice = pickVoice(lang);
    state.audio = {
      point, locale: langInfo[lang].locale, sentences: splitSentences(text, langInfo[lang].locale),
      index: 0, voice, utterance: null, timer: 0,
      status: paused ? "paused" : "preparing"
    };
    if (!voice || typeof window.SpeechSynthesisUtterance !== "function") state.audio.status = "unavailable";
    renderAudio();
    if (state.audio.status === "preparing") speakSentence(state.audio);
  }

  function speakSentence(audio) {
    const utterance = new SpeechSynthesisUtterance(audio.sentences[audio.index]);
    audio.utterance = utterance;
    utterance.lang = audio.locale;
    utterance.voice = audio.voice;
    const isCurrent = () => state.audio === audio && audio.utterance === utterance;
    const failed = () => {
      if (!isCurrent()) return;
      clearTimeout(audio.timer);
      audio.utterance = null;
      audio.status = "unavailable";
      synth.cancel();
      renderAudio();
    };
    utterance.onstart = () => {
      if (!isCurrent()) return;
      clearTimeout(audio.timer);
      audio.status = "playing";
      renderAudio();
    };
    utterance.onerror = failed;
    utterance.onend = () => {
      if (!isCurrent()) return;
      clearTimeout(audio.timer);
      audio.utterance = null;
      if (audio.index + 1 === audio.sentences.length) {
        audio.status = "ended";
      } else {
        audio.index += 1;
        speakSentence(audio);
      }
      renderAudio();
    };
    // Some browser engines expose voices but never start an utterance.
    audio.timer = setTimeout(failed, 4000);
    try {
      synth.speak(utterance);
    } catch {
      failed();
    }
  }

  function stopGuide(update = true) {
    if (!state.audio) return;
    clearTimeout(state.audio.timer);
    state.audio = null;
    synth?.cancel();
    if (update) renderAudio();
  }

  function toggleAudio() {
    const audio = state.audio;
    if (audio.status === "paused") {
      audio.status = "preparing";
      speakSentence(audio);
    } else {
      clearTimeout(audio.timer);
      audio.utterance = null;
      audio.status = "paused";
      synth.cancel();
    }
    renderAudio();
  }

  function transcript(id) {
    const audio = state.audio;
    if (audio?.point.id !== id) return "";
    const { status, sentences, index, locale } = audio;
    const active = status === "playing" || status === "paused";
    const passage = sentences.map((sentence, step) => `<span class="${active && step === index ? "current" : ""}">${escape(sentence)}</span>`).join("");
    const notice = status === "unavailable" ? '<p class="small" role="status">此浏览器的对应语音无法播放，请阅读文字讲解。</p>' : "";
    return `<section class="card transcript">
      <h3>讲解文字 · ${langInfo[state.lang].label}</h3>${notice}<p lang="${locale}">${passage}</p>
      ${["playing", "paused", "preparing"].includes(status) ? `<div class="actions">
        ${action(status === "paused" ? "继续" : "暂停", "toggle-audio")}
        ${action("关闭讲解", "stop-audio")}
      </div>` : ""}
    </section>`;
  }

  function renderAudio() {
    const audio = state.audio;
    mini.hidden = !audio || audio.status === "ended";
    mini.innerHTML = mini.hidden ? "" : `
      ${action((audio.status === "unavailable" ? "查看讲解：" : audio.status === "paused" ? "讲解已暂停：" : "正在讲解：") + audio.point.name,
        "point", audio.point.id, "mini-title")}
      ${audio.status === "unavailable" ? "" : action(audio.status === "paused" ? "继续" : "暂停", "toggle-audio", "", "icon-button")}
      ${action("×", "stop-audio", "", "icon-button", 'aria-label="关闭讲解"')}`;
    if (state.sheet?.kind === "point") {
      const section = sheetBody.querySelector("[data-transcript]");
      if (section) section.innerHTML = transcript(state.sheet.id);
    }
  }

  function unlock(point) {
    if (state.lit.has(point.id)) return false;
    state.lit.add(point.id);
    save();
    renderProgress();
    spotElements.get(point.id).color.classList.add("unlocking");
    return true;
  }

  function flashPoint(point) {
    clearTimeout(state.flashTimer);
    const button = spotElements.get(point.id).button;
    mapStage.querySelector(".flashing")?.classList.remove("flashing");
    void button.offsetWidth;
    button.classList.add("flashing");
    state.flashTimer = setTimeout(() => button.classList.remove("flashing"), 1800);
  }

  function showReward(point, complete, origin) {
    const box = app.getBoundingClientRect();
    const spot = spotElements.get(point.id).color.getBoundingClientRect();
    const x = clamp(spot.left + spot.width / 2 - box.left, 0, box.width);
    const y = clamp(spot.top + spot.height / 2 - box.top, 0, box.height);
    state.reward = { complete, origin };
    rewardLayer.innerHTML = `<button class="reward-hit" type="button" data-action="close-reward" aria-label="收起电子小卡">
      <span class="reward-content">
        <span class="reward-heading">获得电子小卡</span>
        <span class="reward-card" style="--fly-x:${x - box.width / 2}px;--fly-y:${y - box.height / 2}px">
          ${art(point)}<strong>${escape(point.cardName || point.name)}</strong>
        </span>
        <span class="small">点任意处收起</span>
      </span>
    </button>`;
    mountArt(rewardLayer);
    rewardLayer.hidden = false;
    syncModal();
    focus(rewardLayer.firstElementChild);
  }

  function closeReward() {
    if (!state.reward) return;
    const { complete, origin } = state.reward;
    state.reward = null;
    rewardLayer.hidden = true;
    rewardLayer.replaceChildren();
    syncModal();
    if (complete) showSheet("complete", complete, origin);
    else focus(state.sheet ? sheet : origin);
  }

  function visitPoint(point, { speak = false, complete = "", origin = state.returnFocus } = {}) {
    if (state.visitTimer) return;
    closeSheet(false);
    const fresh = unlock(point);
    if (speak) startGuide(point);
    moveMap(point);
    flashPoint(point);
    const finish = () => {
      state.visitTimer = 0;
      renderNavigation();
      if (fresh) showReward(point, complete, origin);
      else if (complete) showSheet("complete", complete, origin);
      else if (!state.sheet) focus(origin);
    };
    state.visitTimer = setTimeout(finish, motion.matches ? 0 : 640);
    renderNavigation();
  }

  function arrive() {
    if (state.visitTimer || !state.route) return;
    const { route, index } = state.route;
    const point = points.get(route.points[index]);
    const last = index + 1 === route.points.length;
    if (last) state.route = null;
    else state.route.index += 1;
    renderNavigation();
    visitPoint(point, {
      speak: !point.parking, complete: last ? route.name : "",
      origin: app.querySelector('[data-action="menu"][data-id="route"]')
    });
  }

  function refreshSheet(button) {
    renderSheet(false);
    if (!button) return;
    focus([...sheetBody.querySelectorAll("[data-action]")].find(candidate =>
      candidate.dataset.action === button.dataset.action && candidate.dataset.id === button.dataset.id));
  }

  function service(tab) {
    state.serviceTab = tab;
    showSheet("services");
  }

  function reset() {
    clearTimeout(state.visitTimer);
    clearTimeout(state.flashTimer);
    state.visitTimer = 0;
    state.lit.clear();
    state.bookings = [];
    state.requests = [];
    state.lang = "zh";
    state.serviceTab = "guides";
    state.guideLang = "";
    state.story = null;
    state.route = null;
    state.routePreview = [];
    state.routeDraft = null;
    clearFeedback();
    stopGuide();
    spotElements.forEach(({ button, color }) => {
      button.classList.remove("flashing");
      color.classList.remove("unlocking");
    });
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Storage may be disabled when the demo is opened as a local file.
    }
    zoom(-state.zoom);
    mapScroll.scrollTo(0, 0);
    renderProgress();
    renderLanguage();
    renderNavigation();
    renderSheet();
    focus(sheet);
    say("演示已重置。");
  }

  app.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    const { action: name, id } = button.dataset;
    switch (name) {
      case "language": {
        if (state.lang === id) break;
        state.lang = id;
        save();
        renderLanguage();
        if (state.audio) startGuide(state.audio.point, state.audio.status === "paused");
        break;
      }
      case "zoom": zoom(Number(id)); break;
      case "menu":
        if (id === "route") openRoute();
        else if (id === "services") service(state.serviceTab);
        else showSheet(id);
        break;
      case "my-records":
        showSheet("mine");
        byId(id).scrollIntoView({ block: "start" });
        break;
      case "close": closeSheet(); break;
      case "point": showSheet("point", id); break;
      case "detail": showSheet("detail", id); break;
      case "listen":
        startGuide(points.get(id));
        sheetBody.querySelector("[data-transcript]").scrollIntoView({ block: "nearest" });
        break;
      case "toggle-audio": {
        const control = button.closest("[data-transcript]") || mini;
        toggleAudio();
        focus(control.querySelector('[data-action="toggle-audio"]'));
        break;
      }
      case "stop-audio":
        stopGuide();
        focus(state.sheet ? sheetBody.querySelector('[data-action="listen"]') : app.querySelector('[data-action="menu"]'));
        break;
      case "check-in": {
        const point = points.get(id);
        if (unlock(point)) {
          const origin = state.returnFocus;
          closeSheet(false);
          showReward(point, "", origin);
        }
        break;
      }
      case "close-reward": closeReward(); break;
      case "start-story": {
        const story = data.stories.find(item => item.id === id);
        const index = Number(button.dataset.step);
        state.story = { story, index };
        state.route = null;
        state.routePreview = [];
        closeSheet();
        renderNavigation();
        moveMap(points.get(story.nodes[index].point));
        break;
      }
      case "story-step": {
        const { story, index } = state.story;
        state.story.index = clamp(index + Number(id), 0, story.nodes.length - 1);
        renderNavigation();
        moveMap(points.get(story.nodes[state.story.index].point));
        focus(navigation.querySelector(`[data-action="story-step"][data-id="${id}"]:not(:disabled)`)
          || navigation.querySelector('[data-action="exit-story"]'));
        break;
      }
      case "exit-story":
        state.story = null;
        renderNavigation();
        focus(mapScroll);
        break;
      case "interest":
        if (state.routeDraft.interests.has(id)) state.routeDraft.interests.delete(id);
        else state.routeDraft.interests.add(id);
        refreshSheet(button);
        break;
      case "duration": state.routeDraft.minutes = Number(id); refreshSheet(button); break;
      case "transport": state.routeDraft.mode = id; refreshSheet(button); break;
      case "generate": generateRoutes(); break;
      case "adopt": adoptRoute(id); break;
      case "arrived": arrive(); break;
      case "scan-point": visitPoint(points.get(id)); break;
      case "service": service(id); break;
      case "service-tab": state.serviceTab = id; refreshSheet(button); break;
      case "book": showSheet("booking", id); break;
      case "parking-start": openRoute(parking.get(id)); break;
      case "reset": reset(); break;
    }
  });

  sheetBody.addEventListener("input", event => {
    const field = event.target;
    if (field.form?.dataset.form !== "feedback" || field.name === "photo") return;
    state.feedback[field.name] = field.value;
    if (field.name === "description") field.setCustomValidity("");
  });

  sheetBody.addEventListener("change", event => {
    const field = event.target;
    if (field.hasAttribute("data-guide-filter")) {
      state.guideLang = field.value;
      refreshSheet();
      focus(sheetBody.querySelector("[data-guide-filter]"));
    } else if (field.name === "photo") {
      if (state.feedback.photo) URL.revokeObjectURL(state.feedback.photo);
      state.feedback.photo = field.files[0] ? URL.createObjectURL(field.files[0]) : null;
      const image = sheetBody.querySelector(".feedback-preview");
      image.hidden = !state.feedback.photo;
      if (state.feedback.photo) image.src = state.feedback.photo;
      else image.removeAttribute("src");
    }
  });

  sheetBody.addEventListener("submit", event => {
    const form = event.target;
    event.preventDefault();
    const fields = new FormData(form);
    if (form.dataset.form === "booking") {
      const guide = data.guides.find(item => item.id === form.dataset.id);
      state.bookings.unshift({ name: guide.name, slot: fields.get("slot"), people: Number(fields.get("people")) });
      save();
      showSheet("booking-success");
    } else {
      submitFeedback(form, fields);
    }
  });

  const dragArea = sheet.querySelector(".sheet-drag");
  const sheetHeader = sheet.querySelector(".sheet-header");
  for (const handle of [dragArea, sheetHeader]) {
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button")) return;
      state.drag = { y: event.clientY, pointerId: event.pointerId };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      if (state.drag?.pointerId !== event.pointerId) return;
      sheet.style.setProperty("--sheet-drag", `${Math.max(0, event.clientY - state.drag.y)}px`);
    });
    handle.addEventListener("pointerup", event => {
      if (state.drag?.pointerId !== event.pointerId) return;
      if (event.clientY - state.drag.y > 60) closeSheet();
      state.drag = null;
      sheet.style.removeProperty("--sheet-drag");
    });
    handle.addEventListener("pointercancel", () => {
      state.drag = null;
      sheet.style.removeProperty("--sheet-drag");
    });
  }
  sheetBody.addEventListener("touchstart", event => {
    if (sheetBody.scrollTop !== 0 || event.target.closest("input, textarea, select")) return;
    const touch = event.touches[0];
    state.drag = { y: touch.clientY, x: touch.clientX };
  }, { passive: true });
  sheetBody.addEventListener("touchend", event => {
    if (state.drag?.x === undefined) return;
    const touch = event.changedTouches[0];
    if (touch.clientY - state.drag.y > 80 && Math.abs(touch.clientX - state.drag.x) < 50 && sheetBody.scrollTop === 0) {
      closeSheet();
    }
    state.drag = null;
  }, { passive: true });
  sheetBody.addEventListener("touchcancel", () => { state.drag = null; });

  app.addEventListener("keydown", event => {
    const modal = state.reward ? rewardLayer : state.sheet && sheet;
    if (!modal) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (state.reward) closeReward();
      else closeSheet();
    } else if (event.key === "Tab") {
      const targets = [...modal.querySelectorAll("button:not(:disabled), input, select, textarea")];
      const active = document.activeElement;
      if (!targets.includes(active) || (event.shiftKey ? active === targets[0] : active === targets.at(-1))) {
        event.preventDefault();
        focus(event.shiftKey ? targets.at(-1) : targets[0]);
      }
    }
  });

  const icons = {
    route: '<path d="M5 5h14v7H5v7h14"/><rect x="3" y="3" width="4" height="4" fill="currentColor"/><rect x="17" y="17" width="4" height="4" fill="currentColor"/>',
    scan: '<path d="M3 9V3h6m6 0h6v6m0 6v6h-6m-6 0H3v-6m4-3h10"/>',
    services: '<path d="M3 5h18v12H9l-4 4v-4H3zM7 10h10m-10 3h7"/>',
    mine: '<path d="M5 21v-5h3v-2h8v2h3v5zM8 3h8v8H8z"/>'
  };
  app.querySelectorAll("[data-icon]").forEach(element => {
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${icons[element.dataset.icon]}</svg>`;
  });
  document.title = `${data.meta.title} · ${data.meta.subtitle}`;
  byId("title").textContent = data.meta.title;
  byId("subtitle").textContent = data.meta.subtitle;
  byId("map-disclaimer").textContent = data.meta.disclaimer;
  initMap();
  renderLanguage();
  renderProgress();
  updateTabbar();
  app.querySelector('[data-action="zoom"][data-id="-1"]').disabled = true;
  synth?.getVoices();
})();
