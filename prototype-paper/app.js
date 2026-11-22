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
  // 新版与旧版分开保存，互不覆盖；值班运营台读写同一份记录。
  const storageKey = "cd-paper-v1";
  const opsKey = "cd-paper-ops-v1";
  const zoomLevels = [100, 150, 200];
  const langInfo = {
    zh: { locale: "zh-CN", label: "普通话" },
    yue: { locale: "zh-HK", label: "粤语" },
    en: { locale: "en-US", label: "English" }
  };
  // 每个可收集点位在顶栏印格里的一个字
  const sealChars = { "CD-V01": "启", "CD-A02": "关", "CD-A01": "博", "CD-A03": "埠", "CD-S01": "楼", "CD-S02": "市", "CD-S03": "墟" };
  const ticketStages = ["已受理", "已分派", "处理中", "待评价"];
  const numerals = ["一", "二", "三", "四", "五", "六"];
  const synth = window.speechSynthesis;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const svgNS = "http://www.w3.org/2000/svg";
  const mapPath = "assets/map.jpg";
  const spotElements = new Map();
  const picStyles = ["mount", "crop", "stamp"];
  let routeObserver;
  let recommendation;
  const picParam = new URLSearchParams(location.search).get("pic");
  app.dataset.pic = picStyles.includes(picParam) ? picParam : "mount";

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }

  const saved = readJSON(storageKey);
  const state = {
    lang: Object.hasOwn(langInfo, saved.lang) ? saved.lang : "zh",
    lit: new Set(Array.isArray(saved.lit) ? saved.lit.filter(id => points.has(id)) : []),
    bookings: Array.isArray(saved.bookings) ? saved.bookings : [],
    requests: Array.isArray(saved.requests) ? saved.requests : [],
    journal: Array.isArray(saved.journal) ? saved.journal.filter(entry => points.has(entry.id)) : [],
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
    feedback: { type: "", description: "", contact: "", photo: null },
    pendingListen: null
  };

  function say(text) {
    byId("announcement").textContent = text;
  }

  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        lang: state.lang, lit: [...state.lit], bookings: state.bookings, requests: state.requests, journal: state.journal
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
  const pad = value => String(value).padStart(2, "0");
  const sealOf = point => sealChars[point.id] || point.name[0];
  const shortName = point => point.name.replace(/（.*?）/g, "");

  function action(label, name, id = "", classes = "button", attributes = "") {
    return `<button type="button" class="${classes}" data-action="${name}" data-id="${escape(id)}" ${attributes}>${escape(label)}</button>`;
  }

  // 与 action 相同，但标签是已转义的 HTML（用于带图标的按钮）
  function actionHtml(html, name, id = "", classes = "button", attributes = "") {
    return `<button type="button" class="${classes}" data-action="${name}" data-id="${escape(id)}" ${attributes}>${html}</button>`;
  }

  function chip(label, name, id, selected) {
    return action(label, name, id, "chip", `aria-pressed="${selected}"`);
  }

  const playIcon = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor"/></svg>';
  const pauseIcon = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M3 2h3v10H3zM8 2h3v10H8z" fill="currentColor"/></svg>';

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

  // 小卡配图：完整小卡贴在衬纸上；未点亮时同一张卡去色，告诉游客到站后能收到什么
  // full：整张小卡（收卡、详情大图）；默认裁到楼体（点位卡、卡册、游记等缩略图）
  function art(point, { lit = state.lit.has(point.id) || !point.key, full = false } = {}) {
    return `<span class="mount${lit ? "" : " unlit"}${full ? " full" : ""}"><span class="art map-crop" data-art="${escape(point.id)}" role="img" aria-label="${escape(point.cardName || point.name)}"></span><span class="corner" aria-hidden="true"></span></span>`;
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
      button.className = "map-spot" + (point.parking ? " parking" : "");
      button.dataset.action = "point";
      button.dataset.id = point.id;
      setRect(button, point.hotspot);
      const label = document.createElement("span");
      label.className = "map-label";
      label.textContent = shortName(point);
      button.append(label);
      markers.append(button);
      spotElements.set(point.id, { color, button });
    });
    loadImage(new Image(), mapPath, image => {
      state.mapRatio = image.naturalWidth / image.naturalHeight;
      mapStage.style.setProperty("--map-ratio", state.mapRatio);
      app.style.setProperty("--map-image", `url("${image.src}")`);
      sizeMap();
      if (!mapScroll.scrollLeft) mapScroll.scrollLeft = (mapStage.offsetWidth - mapScroll.clientWidth) * .4;
      app.querySelectorAll("[data-art]").forEach(cropArt);
    }, () => { byId("map-placeholder").hidden = false; });
  }

  const litCount = () => keyPoints.filter(point => state.lit.has(point.id)).length;
  const progressText = () => `已点亮 ${litCount()} / ${keyPoints.length}`;

  function sealsHtml(fresh = "") {
    return keyPoints.map(point => {
      const lit = state.lit.has(point.id);
      return `<span class="seal${lit ? " lit" : ""}${point.id === fresh ? " pop" : ""}" title="${escape(point.name)}">${lit ? escape(sealOf(point)) : ""}</span>`;
    }).join("");
  }

  function renderProgress(fresh = "") {
    byId("seals").innerHTML = sealsHtml(fresh);
    byId("progress-label").textContent = progressText();
    spotElements.forEach(({ color, button }, id) => {
      const lit = state.lit.has(id);
      color.classList.toggle("lit", lit);
      button.classList.toggle("lit", lit);
      button.setAttribute("aria-label", points.get(id).name + (lit ? "，已点亮" : ""));
    });
  }

  function renderSelected() {
    const selected = state.sheet && ["point", "listen", "detail"].includes(state.sheet.kind) ? state.sheet.id : "";
    spotElements.forEach(({ button }, id) => button.classList.toggle("selected", id === selected));
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

  // 地图铺满纸下的整块区域（按高度裁宽），缩放在此基础上放大
  function sizeMap() {
    const base = Math.max(mapScroll.clientWidth, mapScroll.clientHeight * state.mapRatio);
    mapStage.style.setProperty("--map-zoom", `${Math.round(base * zoomLevels[state.zoom] / 100)}px`);
  }

  function zoom(delta) {
    const next = clamp(state.zoom + delta, 0, zoomLevels.length - 1);
    if (next === state.zoom) return;
    const x = (mapScroll.scrollLeft + mapScroll.clientWidth / 2) / mapStage.offsetWidth;
    const y = (mapScroll.scrollTop + mapScroll.clientHeight / 2) / mapStage.offsetHeight;
    state.zoom = next;
    sizeMap();
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
      drawLine(ids, "#b23a2a", true);
      ids.forEach((id, step) => addNote(id, step + 1));
      const { point, text } = story.nodes[index];
      navigation.innerHTML = `
        <div class="nav-row"><div><span class="kicker">故事线</span><strong>${escape(story.title)}</strong></div>${action("退出", "exit-story", "", "button")}</div>
        <div class="story-step">
          ${action("‹", "story-step", "-1", "icon-button", `aria-label="上一节" ${index === 0 ? "disabled" : ""}`)}
          <p><b>${index + 1} / ${ids.length} · ${escape(shortName(points.get(point)))}</b>${escape(text)}</p>
          ${action("›", "story-step", "1", "icon-button", `aria-label="下一节" ${index === ids.length - 1 ? "disabled" : ""}`)}
        </div>`;
    } else if (state.route) {
      const { route, index } = state.route;
      drawLine(route.points, route.color, true);
      route.points.forEach((id, step) => addNote(id, step + 1));
      const point = points.get(route.points[index]);
      navigation.innerHTML = `<div class="nav-row">
        <div><span class="kicker">沿街行程 · 第 ${index + 1}/${route.points.length} 站</span><strong>下一站：${escape(shortName(point))}</strong></div>
        <div class="actions">${action("行程单", "itinerary", "", "button")}${action("到了", "arrived", "", "button primary", state.visitTimer ? "disabled" : "")}</div>
      </div>${route.start ? `<p class="small">路线起点：${escape(route.start.name)}</p>` : ""}`;
    } else {
      state.routePreview.forEach(route => drawLine(route.points, route.color));
      navigation.replaceChildren();
    }
    navigation.hidden = !state.story && !state.route;
  }

  function addNote(id, number) {
    const note = document.createElement("div");
    note.className = "map-note";
    note.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = number;
    note.append(label);
    setRect(note, points.get(id).hotspot);
    byId("map-points").append(note);
  }

  function drawLine(ids, color, active = false) {
    const line = document.createElementNS(svgNS, "polyline");
    line.setAttribute("points", ids.map(id => center(points.get(id).hotspot).join(",")).join(" "));
    line.setAttribute("stroke", color);
    if (active) line.classList.add("active");
    byId("map-lines").append(line);
  }

  const sheetTitles = {
    route: ["沿街行程单", "按兴趣排一条路"], "route-results": ["三条候选路线", "推荐"], itinerary: ["行程单", "沿街行程"],
    scan: ["扫码到站", "演示"], services: ["服务", "游客服务"], booking: ["预约讲解员", "服务 · 讲解"],
    "booking-success": ["预约已提交", "服务 · 讲解"], "feedback-success": ["反馈已受理", "服务 · 反馈"],
    mine: ["我的", "本机记录"], journal: ["游记回听", "我的"], complete: ["路线完成", "沿街行程"]
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
    routeObserver?.disconnect();
    if (state.sheet.kind === "route") {
      clearTimeout(state.routeTimer);
      state.routeTimer = 0;
    }
    state.sheet = null;
    overlay.hidden = true;
    sheet.style.removeProperty("--sheet-drag");
    state.drag = null;
    byId("sheet-title").textContent = "";
    byId("sheet-kicker").textContent = "";
    sheetBody.replaceChildren();
    syncModal();
    updateTabbar();
    renderSelected();
    if (restore) focus(state.returnFocus);
  }

  function updateTabbar() {
    const kind = state.sheet?.kind;
    const tab = {
      route: "route", "route-results": "route", itinerary: "route", complete: "route", scan: "scan", services: "services",
      booking: "services", "booking-success": "services", "feedback-success": "services", mine: "mine", journal: "mine"
    }[kind];
    app.querySelectorAll('[data-action="menu"]').forEach(button => {
      button.setAttribute("aria-expanded", button.dataset.id === tab);
    });
  }

  function sheetHeading(kind, id) {
    if (["point", "detail", "listen"].includes(kind)) {
      const point = points.get(id);
      const kicker = kind === "listen"
        ? (state.sheet.arrival ? "到站讲解" : "讲解") + " · " + langInfo[state.lang].label
        : kind === "detail" ? `${point.category} · ${point.name_en}` : point.category + (point.parking ? " · 示范数据" : "");
      return [shortName(point), kicker];
    }
    const [title, kicker] = sheetTitles[kind];
    return [title, kicker];
  }

  function renderSheet(resetScroll = true) {
    const { kind, id } = state.sheet;
    const previousScroll = sheetBody.scrollTop;
    sheet.classList.toggle("full", ["detail", "listen", "journal"].includes(kind));
    sheet.classList.toggle("preview", kind === "route-results");
    overlay.classList.toggle("preview", kind === "route-results");
    const [title, kicker] = sheetHeading(kind, id);
    byId("sheet-title").textContent = title;
    byId("sheet-kicker").textContent = kicker;
    sheet.dataset.kind = kind;
    updateTabbar();
    renderSelected();
    sheetBody.innerHTML = `<div class="stack">${sheetContents(kind, id)}</div>`;
    mountArt(sheetBody);
    sheetBody.scrollTop = resetScroll ? 0 : previousScroll;
    observeRouteCards(kind);
  }

  function exposeRoute(batch, id) {
    if (batch.exposed.has(id)) return;
    batch.exposed.add(id);
    window.CD_TOURISM.record("route_exposed", id, batch.flowId);
  }

  function observeRouteCards(kind) {
    routeObserver?.disconnect();
    routeObserver = null;
    if (kind !== "route-results" || !recommendation || !window.IntersectionObserver) return;
    const batch = recommendation;
    const observer = new IntersectionObserver(entries => {
      if (routeObserver !== observer || state.sheet?.kind !== "route-results" || recommendation !== batch
          || document.visibilityState !== "visible") return;
      for (const entry of entries) {
        if (entry.intersectionRatio <= 0 || !entry.target.isConnected) continue;
        exposeRoute(batch, entry.target.dataset.routeId);
        observer.unobserve(entry.target);
      }
    });
    routeObserver = observer;
    for (const card of sheetBody.querySelectorAll("[data-route-id]")) {
      if (!batch.exposed.has(card.dataset.routeId)) observer.observe(card);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.sheet?.kind === "route-results") observeRouteCards("route-results");
  });

  function sheetContents(kind, id) {
    switch (kind) {
      case "point": return renderPoint(points.get(id));
      case "detail": return renderDetail(points.get(id));
      case "listen": return renderListen(points.get(id));
      case "route": return renderRouteForm();
      case "route-results": return renderRouteResults();
      case "itinerary": return renderItinerary();
      case "scan": return renderScan();
      case "services": return renderServices();
      case "booking": return renderBooking(id);
      case "booking-success": return renderBookingSuccess();
      case "feedback-success": return renderFeedbackSuccess(id);
      case "mine": return renderMine();
      case "journal": return renderJournal();
      case "complete": return `<div class="complete-seal" aria-hidden="true">走完<br>长堤</div>
        <p class="lede" style="text-align:center">已走完「${escape(id)}」的全部站点。</p>
        <p class="small" style="text-align:center">${progressText()} · 收到的小卡都在「我的」里</p>
        ${action("返回地图", "close", "", "button primary wide")}
        ${action("看游记回听", "journal", "", "button wide")}`;
    }
  }

  function renderPoint(point) {
    if (point.parking) {
      return `${parkingCard(parking.get(point.parking))}
        <div class="actions">${action("看详情 ›", "detail", point.id, "link")}</div>`;
    }
    const lit = state.lit.has(point.id);
    return `
      <div class="point-summary">
        ${art(point)}
        <div>
          <p>${escape(point.oneLine)}</p>
          ${/待核实|示意/.test(point.name + point.intro) && !/待核实/.test(point.oneLine) ? '<p class="small">位置与外观待核实</p>' : ""}
          ${action("看详情 ›", "detail", point.id, "link")}
        </div>
      </div>
      ${point.guide ? actionHtml(`<span class="with-icon">${playIcon}听讲解</span>`, "listen", point.id, "button primary wide") : ""}
      ${point.key ? action(lit ? "已盖印 · 小卡已收" : "我到这里了，盖印", "check-in", point.id, "button wide slim", lit ? "disabled" : "") : ""}
      <p class="small point-hint">${point.key ? (lit ? "这一站的小卡在「我的 · 卡册」里" : "走到这里后，可以盖下这一站的印") : "沿途地标，不计入七枚印"}</p>`;
  }

  function renderDetail(point) {
    const storySections = data.stories.flatMap(story => story.nodes.flatMap((node, index) => {
      if (node.point !== point.id) return [];
      return `<section class="card"><p class="kicker">故事线 · 第 ${index + 1} 节</p><h3>${escape(story.title)}</h3>
        <p class="story-quote">${escape(node.text)}</p><div class="actions">
          ${action("在地图上看故事线", "start-story", story.id, "button", `data-step="${index}"`)}
        </div></section>`;
    }));
    const sources = point.sources.length
      ? `<ul class="sources small">${point.sources.map(source => `<li>${escape(source)}</li>`).join("")}</ul>`
      : '<p class="small">暂无资料来源</p>';
    return `${point.parking ? "" : `<div class="hero">${art(point, { full: true })}</div>`}
      <p class="lede">${escape(point.intro)}</p>
      ${point.guide ? actionHtml(`<span class="with-icon">${playIcon}听讲解</span>`, "listen", point.id, "button primary wide") : ""}
      ${storySections.join("")}
      <section><h3 class="section-title">资料来源</h3>${sources}</section>
      <div class="actions">
        ${action("预约讲解员", "service", "guides")}
        ${action("附近停车", "service", "parking")}
        ${action("回到点位卡", "point", point.id, "button ghost")}
      </div>`;
  }

  function renderListen(point) {
    const lit = state.lit.has(point.id);
    const next = state.route && points.get(state.route.route.points[state.route.index]);
    return `
      <div class="listen-head">
        ${art(point)}
        <div>
          <p class="lede">${escape(point.oneLine)}</p>
          <p class="small">${point.key ? (lit ? `已盖印 · 小卡「${escape(point.cardName || point.name)}」` : "未盖印") : "沿途地标"}</p>
        </div>
      </div>
      <div class="player" data-player>${playerHtml(point)}</div>
      <div data-transcript>${transcript(point.id)}</div>
      <div class="actions">
        ${point.key && !lit ? action("我到这里了，盖印", "check-in", point.id) : ""}
        ${action("看详情 ›", "detail", point.id, "link")}
      </div>
      ${next ? action(`去下一站：${shortName(next)}`, "close", "", "button primary wide") : ""}`;
  }

  function playerHtml(point) {
    const audio = state.audio?.point.id === point.id ? state.audio : null;
    const status = audio?.status || "idle";
    const playing = status === "playing" || status === "preparing";
    const label = playing ? "暂停讲解" : status === "paused" ? "继续讲解" : "播放讲解";
    const dots = audio ? audio.sentences.map((_, step) => `<i class="${step < audio.index || (step === audio.index && status === "ended") ? "done" : ""}"></i>`).join("") : "";
    const text = {
      idle: "点一下开始讲解", preparing: "正在准备语音", playing: `正在讲 · 第 ${(audio?.index || 0) + 1} 句`,
      paused: "已暂停", ended: "讲完了，可以再听一遍", unavailable: "这台设备没有对应语音，请读下面的文字"
    }[status];
    return `${actionHtml(playing ? pauseIcon : playIcon, "play", point.id, "play-big", `aria-label="${label}"`)}
      ${dots ? `<div class="dots" aria-hidden="true">${dots}</div>` : ""}
      <p class="small" role="status">${text}</p>`;
  }

  function openRoute(start = null) {
    state.routeDraft = { interests: new Set(), minutes: 60, mode: start ? "drive" : "walk", start, loading: false };
    showSheet("route");
  }

  function renderRouteForm() {
    const { interests, minutes, mode, start, loading } = state.routeDraft;
    if (loading) {
      return '<p role="status" class="small">正在排行程</p>' + '<div class="card skeleton" aria-hidden="true"><span></span><span></span><span></span></div>'.repeat(3);
    }
    return `
      <fieldset><legend>① 想看什么（可多选）</legend><div class="chips">
        ${data.interests.map(interest => chip(interest, "interest", interest, interests.has(interest))).join("")}
      </div></fieldset>
      <fieldset><legend>② 打算走多久</legend><div class="chips">
        ${[30, 60, 120].map(value => chip(value + " 分钟", "duration", value, value === minutes)).join("")}
      </div></fieldset>
      <fieldset><legend>③ 怎么来</legend><div class="chips">
        ${chip("步行", "transport", "walk", mode === "walk")}${chip("自驾", "transport", "drive", mode === "drive")}
      </div></fieldset>
      ${start && mode === "drive" ? `<p class="small">路线起点：${escape(start.name)}</p>` : ""}
      ${action("排出三条路线", "generate", "", "button primary wide")}
      <p class="small">演示版：三条路线来自预设数据，时长与距离为示意。</p>`;
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
      recommendation = window.CD_TOURISM
        ? { flowId: window.CD_TOURISM.newId(), exposed: new Set() }
        : null;
      renderNavigation();
      showSheet("route-results");
    }, 800);
  }

  function stopList(ids, color) {
    return `<ol class="route-stops" style="--route-color:${escape(color)}">${ids.map(id => `<li>${escape(shortName(points.get(id)))}</li>`).join("")}</ol>`;
  }

  function renderRouteResults() {
    const start = state.routePreview.find(route => route.start)?.start;
    return `
      ${start ? `<p class="small">路线起点：${escape(start.name)}${data.points.some(point => point.parking === start.id) ? "" : "（地图暂无此停车点位）"}</p>` : ""}
      ${state.routePreview.map((route, index) => `<article class="card route-card" data-route-id="${escape(route.id)}" style="--route-color:${escape(route.color)}">
        <div class="row"><span class="route-no">第${numerals[index]}条</span><span class="small"><i class="route-swatch"></i>地图上的${index ? "另一条" : "这条"}虚线</span></div>
        <div class="row"><h3>${escape(route.name)}</h3>${action("按这条走", "adopt", route.id, "button primary")}</div>
        <p class="small">${route.minutes} 分钟 · ${route.meters} 米 · ${route.points.length} 站</p>
        ${stopList(route.points, route.color)}
        <p>${escape(route.reason)}</p>
      </article>`).join("")}`;
  }

  function renderItinerary() {
    const { route, index } = state.route;
    return `<p class="small">${escape(route.name)} · ${route.minutes} 分钟 · ${route.meters} 米</p>
      <ol class="itinerary">${route.points.map((id, step) => {
        const point = points.get(id);
        const status = step < index ? "done" : step === index ? "now" : "";
        return `<li class="${status}"><span class="no">${step + 1}</span>
          <span><strong>${escape(shortName(point))}</strong><span class="small"> · ${status === "done" ? "已到" : status === "now" ? "下一站" : "待去"}</span></span>
          ${action("›", "point", id, "icon-button", `aria-label="查看${escape(point.name)}"`)}</li>`;
      }).join("")}</ol>
      ${action("继续走", "close", "", "button primary wide")}
      ${action("结束行程", "end-route", "", "button wide")}`;
  }

  function adoptRoute(id) {
    const route = state.routePreview.find(item => item.id === id);
    const flowId = recommendation?.flowId;
    if (recommendation) {
      exposeRoute(recommendation, id);
      window.CD_TOURISM.record("route_adopted", id, flowId);
    }
    state.route = { route, index: 0, flowId };
    recommendation = null;
    state.routePreview = [];
    closeSheet();
    renderNavigation();
    moveMap(points.get(route.points[0]));
  }

  function renderScan() {
    return '<p class="small">演示版：选择一个点位，模拟扫现场码或碰 NFC。</p><div class="stack" style="gap:8px">' +
      keyPoints.map(point => actionHtml(`<span class="with-icon"><span class="seal${state.lit.has(point.id) ? " lit" : ""}">${escape(sealOf(point))}</span>${escape(shortName(point))}</span><span class="arrow">›</span>`,
        "scan-point", point.id, "list-button", `aria-label="${escape(point.name)}"`)).join("") + "</div>";
  }

  function renderServices() {
    const tabs = [["guides", "讲解员"], ["parking", "停车"], ["feedback", "反馈"]];
    const contents = {
      guides: renderGuides,
      parking: () => '<div><span class="tag demo">示范数据</span></div>' + data.parking.map(parkingCard).join(""),
      feedback: renderFeedback
    };
    return '<div class="segmented" role="group" aria-label="服务分类">' +
      tabs.map(([id, label]) => action(label, "service-tab", id, "", `aria-pressed="${state.serviceTab === id}"`)).join("") + "</div>" +
      contents[state.serviceTab]();
  }

  function renderGuides() {
    const langs = [...new Set(data.guides.flatMap(guide => guide.langs))];
    const guides = data.guides.filter(guide => !state.guideLang || guide.langs.includes(state.guideLang));
    return `
      <div class="row"><span class="tag demo">示范数据</span>
        <label class="field" style="width:9.5em"><span class="sr-only">讲解语种</span>
          <select data-guide-filter aria-label="讲解语种">
            <option value="">全部语种</option>
            ${langs.map(lang => `<option ${lang === state.guideLang ? "selected" : ""}>${escape(lang)}</option>`).join("")}
          </select>
        </label>
      </div>
      ${guides.map(guide => `<article class="card guide-card">
        <span class="avatar" aria-hidden="true">${escape(guide.name.slice(-1))}</span>
        <div><h3>${escape(guide.name)}</h3>
          <p class="small">${escape(guide.level)} · ${guide.rating} 分 · ${escape(guide.langs.join(" / "))}</p>
          <p class="small">${escape(guide.topics)}</p></div>
        ${action("预约", "book", guide.id, "button primary", `aria-label="预约${escape(guide.name)}"`)}
      </article>`).join("")}`;
  }

  function renderBooking(id) {
    const guide = data.guides.find(item => item.id === id);
    return `
      <article class="card guide-card">
        <span class="avatar" aria-hidden="true">${escape(guide.name.slice(-1))}</span>
        <div><h3>${escape(guide.name)}</h3><p class="small">${escape(guide.langs.join(" / "))} · ${escape(guide.topics)}</p></div>
        <span class="tag demo">示范</span>
      </article>
      <form class="stack" data-form="booking" data-id="${escape(id)}">
        <fieldset><legend>选时段</legend><div class="slots">
          ${guide.slots.map((slot, index) => `<label class="chip slot"><input class="sr-only" type="radio" name="slot" value="${escape(slot)}" ${index ? "" : "required"}>${escape(slot)}</label>`).join("")}
        </div></fieldset>
        <label class="field">人数<input name="people" type="number" inputmode="numeric" min="1" max="30" step="1" value="1" required></label>
        <button class="button primary wide" type="submit">提交预约</button>
        <p class="small">提交后由讲解员确认，目标 30 分钟内回复；确认结果在「我的」查看。</p>
      </form>`;
  }

  function bookingStatus(booking) {
    return readJSON(opsKey).bookings?.[booking.id] || "待确认";
  }

  function renderBookingSuccess() {
    const booking = state.bookings[0];
    return `<div class="complete-seal" aria-hidden="true">已<br>提交</div>
      <article class="card">
        <h3>${escape(booking.name)} · ${escape(booking.slot)}</h3>
        <p class="small">${escape(booking.people)} 人 · 编号 ${escape(booking.id)}</p>
        <p>已提交，待讲解员确认（目标 30 分钟内）</p>
      </article>
      ${action("查看我的预约", "my-records", "my-bookings", "button wide")}`;
  }

  function parkingCard(lot) {
    const percent = lot.free / lot.total * 100;
    // 值班台把数据标记为陈旧时，余位改为灰色并注明不是实时
    const stale = Boolean(readJSON(opsKey).lots?.[lot.id]?.stale);
    const color = stale ? "#6f6556" : percent > 30 ? "#3f6b62" : percent >= 10 ? "#9a6a12" : "#b23a2a";
    return `<article class="card${stale ? " stale" : ""}" style="--meter-color:${color}">
      <div class="parking-header"><h3>${escape(lot.name)}</h3><strong>${lot.free}<small> / ${lot.total} 余位</small></strong></div>
      <div class="parking-meter" style="--free:${percent}%" aria-hidden="true"><span></span></div>
      ${stale ? '<p class="notice">数据已过时，余位不代表现在，请以现场为准。</p>' : ""}
      <p class="small">步行 ${lot.walk} 米 · ${escape(lot.fee)} · 更新于 ${escape(lot.updated)}</p>
      <p>${escape(lot.reason)}</p>
      ${parkingChart(lot)}
      <p class="chart-legend small"><span>实线 · 历史余位</span><span>虚线 · 未来 1 小时（模拟）</span></p>
      ${action("从这里出发排路线", "parking-start", lot.id, "button")}
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
      <line x1="${currentX}" x2="${currentX}" y1="4" y2="54" stroke="#c7bba7" stroke-dasharray="2 3"/>
      <polyline points="${coords.slice(0, now + 1).join(" ")}" stroke="#2b2723" stroke-width="1.6"/>
      <polyline points="${coords.slice(now).join(" ")}" stroke="#b23a2a" stroke-width="1.6" stroke-dasharray="4 4"/>
    </svg>`;
  }

  function renderFeedback() {
    const { type, description, contact, photo } = state.feedback;
    return `<form class="stack" data-form="feedback">
      <label class="field">类型<select name="type" required>
        <option value="">请选择</option>
        ${data.feedbackTypes.map(value => `<option ${value === type ? "selected" : ""}>${escape(value)}</option>`).join("")}
      </select></label>
      <label class="field">描述<textarea name="description" required placeholder="在哪里、看到了什么">${escape(description)}</textarea></label>
      <label class="field">图片（可选）<span class="file-pick"><input class="sr-only" name="photo" type="file" accept="image/*"><span class="button" aria-hidden="true">选择图片</span><span class="small" data-file-name>${photo ? "已选 1 张" : "未选择"}</span></span></label>
      <img class="feedback-preview" alt="所选图片预览" ${photo ? `src="${escape(photo)}"` : "hidden"}>
      <label class="field">联系方式（可选）<input name="contact" value="${escape(contact)}" aria-describedby="contact-privacy"></label>
      <p id="contact-privacy" class="small">对外匿名，联系方式仅授权处理人员可见。演示数据只在本机保存。</p>
      <button class="button primary wide" type="submit">提交反馈</button>
    </form>`;
  }

  function ticketStage(request) {
    return clamp(readJSON(opsKey).tickets?.[request.id]?.stage ?? 0, 0, ticketStages.length - 1);
  }

  function timeline(stage = 0) {
    return `<ol class="timeline">${ticketStages.map((label, index) =>
      `<li class="${index <= stage ? "done" : ""}" ${index === stage ? 'aria-current="step"' : ""}><i></i>${label}</li>`).join("")}</ol>`;
  }

  function renderFeedbackSuccess(id) {
    const request = state.requests.find(item => item.id === id);
    return `<div class="complete-seal" aria-hidden="true">已<br>受理</div>
      <article class="card"><p class="kicker">工单编号</p><h3 class="ticket-no">${escape(id)}</h3>
        <p class="small">${escape(request?.type || "")}</p>${timeline(request ? ticketStage(request) : 0)}</article>
      ${action("查看我的诉求", "my-records", "my-requests", "button wide")}`;
  }

  function submitFeedback(form, fields) {
    const description = fields.get("description").trim();
    if (!description) {
      form.elements.description.setCustomValidity("请填写描述。");
      form.elements.description.reportValidity();
      return;
    }
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(pad).join("");
    const prefix = `CD-${date}-`;
    const sequence = 1 + state.requests.filter(request => request.id.startsWith(prefix)).length;
    const id = prefix + String(sequence).padStart(4, "0");
    state.requests.unshift({ id, type: fields.get("type"), description, contact: fields.get("contact").trim(), at: now.toISOString() });
    clearFeedback();
    save();
    showSheet("feedback-success", id);
  }

  function clearFeedback() {
    if (state.feedback.photo) URL.revokeObjectURL(state.feedback.photo);
    state.feedback = { type: "", description: "", contact: "", photo: null };
  }

  function renderMine() {
    const obtained = keyPoints.filter(point => state.lit.has(point.id));
    return `
      <div class="profile">
        <span class="avatar" aria-hidden="true">游</span>
        <div><h3 class="serif" id="mine-progress-label">${progressText()}</h3><p class="small">本机演示记录 · 未登录</p></div>
      </div>
      <div class="seal-board" aria-hidden="true">${sealsHtml()}</div>
      <section class="stack"><h3 class="section-title">电子卡册</h3>
        <div class="album">${keyPoints.map(point => `<article class="album-card">
          ${state.lit.has(point.id) ? art(point) : `<span class="silhouette" aria-label="未获得" role="img"><b>${escape(sealOf(point))}</b></span>`}
          <span>${escape(state.lit.has(point.id) ? point.cardName || point.name : shortName(point))}</span>
        </article>`).join("")}</div>
        <p class="small">已收 ${obtained.length} 张，走到下一站再盖一枚印。</p>
      </section>
      <div class="menu-list">
        ${actionHtml(`<span>游记回听</span><small>${state.journal.length} 条 ›</small>`, "journal", "", "list-button")}
      </div>
      <section class="stack" id="my-bookings"><h3 class="section-title">我的预约</h3>
        ${state.bookings.map(booking => {
          const status = bookingStatus(booking);
          return `<article class="card">
          <div class="row"><h3>${escape(booking.name)}</h3><span class="tag ${status === "已确认" ? "ok" : status === "已婉拒" ? "warn" : ""}">${escape(status)}</span></div>
          <p>${escape(booking.slot)} · ${escape(booking.people)} 人</p>
          <p class="small">编号 ${escape(booking.id || "—")}${status === "待确认" ? " · 待讲解员确认" : ""}</p>
        </article>`;
        }).join("") || '<p class="empty">暂无预约</p>'}
      </section>
      <section class="stack" id="my-requests"><h3 class="section-title">我的诉求</h3>
        ${state.requests.map(request => `<article class="card">
          <h3>${escape(request.type)} · ${escape(request.id)}</h3>
          <p>${escape(request.description)}</p>${timeline(ticketStage(request))}
        </article>`).join("") || '<p class="empty">暂无诉求</p>'}
      </section>
      <section class="stack"><h3 class="section-title">关于本演示</h3>
        <p class="small">${escape(data.meta.disclaimer)}</p>
      </section>
      ${action("重置演示", "reset", "", "button wide")}`;
  }

  // 游记：每个点位一条，记最近一次时间、盖印与否、听过的语言
  function journalAdd(point, kind) {
    const previous = state.journal.find(entry => entry.id === point.id);
    const entry = { id: point.id, at: new Date().toISOString(), lit: previous?.lit || kind === "lit", langs: previous?.langs || [] };
    if (kind === "listen" && !entry.langs.includes(state.lang)) entry.langs = [...entry.langs, state.lang];
    state.journal = [entry, ...state.journal.filter(item => item.id !== point.id)].slice(0, 60);
    save();
  }

  function renderJournal() {
    if (!state.journal.length) {
      return `<p class="empty">还没有游记。听过的讲解、盖过的印，都会按时间记在这里，回去以后还能再听。</p>
        ${action("回到地图", "close", "", "button primary wide")}`;
    }
    const days = new Map();
    state.journal.forEach(entry => {
      const time = new Date(entry.at);
      const day = `${time.getMonth() + 1} 月 ${time.getDate()} 日`;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(entry);
    });
    return `<p class="small">按时间倒序 · 共 ${state.journal.length} 条 · 只保存在本机</p>` +
      [...days].map(([day, entries]) => `<section><h3 class="journal-day">${day}</h3>
        ${entries.map(entry => {
          const point = points.get(entry.id);
          const time = new Date(entry.at);
          return `<article class="journal-item">
            ${point.key ? art(point) : `<span class="silhouette" style="aspect-ratio:3/4"><b>${escape(point.name[0])}</b></span>`}
            <div><strong>${escape(shortName(point))}</strong>
              <time datetime="${escape(entry.at)}">${pad(time.getHours())}:${pad(time.getMinutes())}${entry.lit ? " · 盖印收卡" : ""}${entry.langs?.length ? ` · 听过 ${entry.langs.map(lang => escape(langInfo[lang]?.label || "")).join("、")}` : ""}</time></div>
            ${point.guide ? action("回听", "listen", point.id, "button", `aria-label="回听${escape(point.name)}"`) : ""}
          </article>`;
        }).join("")}</section>`).join("");
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
      telemetry: window.CD_TOURISM ? { startedAt: null, playedMs: 0 } : null,
      status: paused ? "paused" : "preparing"
    };
    if (!voice || typeof window.SpeechSynthesisUtterance !== "function") state.audio.status = "unavailable";
    if (!paused) journalAdd(point, "listen");
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
      finishPlayback(audio);
      synth.cancel();
      renderAudio();
    };
    utterance.onstart = () => {
      if (!isCurrent()) return;
      clearTimeout(audio.timer);
      if (audio.telemetry && audio.telemetry.startedAt === null) audio.telemetry.startedAt = performance.now();
      audio.status = "playing";
      renderAudio();
    };
    utterance.onerror = failed;
    utterance.onend = () => {
      if (!isCurrent()) return;
      clearTimeout(audio.timer);
      endPlaybackSegment(audio);
      audio.utterance = null;
      if (audio.index + 1 === audio.sentences.length) {
        audio.status = "ended";
        finishPlayback(audio);
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

  function endPlaybackSegment(audio) {
    const telemetry = audio.telemetry;
    if (!telemetry || telemetry.startedAt === null) return;
    telemetry.playedMs += performance.now() - telemetry.startedAt;
    telemetry.startedAt = null;
  }

  function finishPlayback(audio) {
    if (!audio.telemetry) return;
    endPlaybackSegment(audio);
    const durationSeconds = Math.floor(audio.telemetry.playedMs / 1000);
    audio.telemetry = null;
    if (durationSeconds > 0) window.CD_TOURISM.record("guide_played", audio.point.id, undefined, durationSeconds);
  }

  function stopGuide(update = true) {
    if (!state.audio) return;
    clearTimeout(state.audio.timer);
    finishPlayback(state.audio);
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
      endPlaybackSegment(audio);
      audio.utterance = null;
      audio.status = "paused";
      synth.cancel();
    }
    renderAudio();
  }

  function play(point) {
    const audio = state.audio?.point.id === point.id ? state.audio : null;
    if (audio && ["playing", "preparing", "paused"].includes(audio.status)) toggleAudio();
    else startGuide(point);
  }

  function transcript(id) {
    const point = points.get(id);
    if (!point.guide) return "";
    const audio = state.audio?.point.id === id ? state.audio : null;
    const locale = langInfo[state.lang].locale;
    const sentences = audio ? audio.sentences : splitSentences(point.guide[state.lang], locale);
    const active = audio && (audio.status === "playing" || audio.status === "paused");
    const passage = sentences.map((sentence, step) => `<span class="${active && step === audio.index ? "current" : ""}">${escape(sentence)}</span>`).join("");
    const notice = audio?.status === "unavailable" ? '<p class="notice" role="status">此浏览器的对应语音无法播放，请阅读文字讲解。</p>' : "";
    return `<section class="transcript stack" style="gap:8px">${notice}<p lang="${locale}">${passage}</p>
      ${audio && ["playing", "paused", "preparing"].includes(audio.status) ? `<div class="actions">${action("关闭讲解", "stop-audio", "", "button ghost")}</div>` : ""}
    </section>`;
  }

  function renderAudio() {
    const audio = state.audio;
    mini.hidden = !audio || audio.status === "ended";
    mini.classList.toggle("paused", audio?.status !== "playing");
    mini.innerHTML = mini.hidden ? "" : `
      <span class="wave" aria-hidden="true"><i></i><i></i><i></i></span>
      ${action((audio.status === "unavailable" ? "查看讲解：" : audio.status === "paused" ? "讲解已暂停：" : "正在讲解：") + shortName(audio.point),
        "listen-open", audio.point.id, "mini-title")}
      ${audio.status === "unavailable" ? "" : actionHtml(audio.status === "paused" ? playIcon : pauseIcon, "toggle-audio", "", "icon-button", `aria-label="${audio.status === "paused" ? "继续" : "暂停"}"`)}
      ${action("×", "stop-audio", "", "icon-button", 'aria-label="关闭讲解"')}`;
    if (state.sheet?.kind === "listen") {
      const point = points.get(state.sheet.id);
      const player = sheetBody.querySelector("[data-player]");
      const section = sheetBody.querySelector("[data-transcript]");
      const hadFocus = player?.contains(document.activeElement);
      if (player) player.innerHTML = playerHtml(point);
      if (section) section.innerHTML = transcript(point.id);
      if (hadFocus) focus(player.querySelector("[data-action='play']"));
    }
  }

  function unlock(point) {
    if (state.lit.has(point.id)) return false;
    state.lit.add(point.id);
    journalAdd(point, "lit");
    save();
    renderProgress(point.id);
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
    state.reward = { complete, origin, point };
    rewardLayer.innerHTML = `<button class="reward-hit" type="button" data-action="close-reward" aria-label="收起电子小卡">
      <span class="reward-content">
        <span class="reward-heading">收下一张小卡</span>
        <span class="reward-card" style="--fly-x:${x - box.width / 2}px;--fly-y:${y - box.height / 2}px">
          ${art(point, { lit: true, full: true })}<strong>${escape(point.cardName || point.name)}</strong>
          <span class="stamp" aria-hidden="true">长堤<br>${escape(sealOf(point))}站</span>
        </span>
        <span class="small">${progressText()} · 点任意处收起</span>
      </span>
    </button>`;
    mountArt(rewardLayer);
    rewardLayer.hidden = false;
    syncModal();
    focus(rewardLayer.firstElementChild);
  }

  function closeReward() {
    if (!state.reward) return;
    const { complete, origin, point } = state.reward;
    state.reward = null;
    rewardLayer.hidden = true;
    rewardLayer.replaceChildren();
    syncModal();
    if (complete) {
      state.pendingListen = null;
      showSheet("complete", complete, origin);
    } else if (state.pendingListen === point.id) openArrivalListen(point, origin);
    else if (state.sheet?.kind === "listen") renderSheet(false);
    else focus(state.sheet ? sheet : origin);
  }

  function openArrivalListen(point, origin) {
    state.pendingListen = null;
    showSheet("listen", point.id, origin);
    state.sheet.arrival = true;
    byId("sheet-kicker").textContent = sheetHeading("listen", point.id)[1];
  }

  // 到站：地图原地还彩、盖印收卡，然后打开到站讲解
  function visitPoint(point, { speak = false, complete = "", origin = state.returnFocus } = {}) {
    if (state.visitTimer) return;
    closeSheet(false);
    const fresh = unlock(point);
    if (speak) {
      startGuide(point);
      state.pendingListen = point.id;
    }
    moveMap(point);
    flashPoint(point);
    const finish = () => {
      state.visitTimer = 0;
      renderNavigation();
      if (fresh) showReward(point, complete, origin);
      else if (complete) {
        state.pendingListen = null;
        showSheet("complete", complete, origin);
      } else if (speak) openArrivalListen(point, origin);
      else if (!state.sheet) focus(origin);
    };
    state.visitTimer = setTimeout(finish, motion.matches ? 0 : 640);
    renderNavigation();
  }

  function arrive() {
    if (state.visitTimer || !state.route) return;
    const { route, index, flowId } = state.route;
    const point = points.get(route.points[index]);
    const last = index + 1 === route.points.length;
    if (last) {
      state.route = null;
      if (flowId) window.CD_TOURISM.record("route_completed_self_reported", route.id, flowId);
    } else state.route.index += 1;
    renderNavigation();
    visitPoint(point, {
      speak: Boolean(point.guide), complete: last ? route.name : "",
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
    state.journal = [];
    state.lang = "zh";
    state.serviceTab = "guides";
    state.guideLang = "";
    state.story = null;
    state.route = null;
    state.routePreview = [];
    state.routeDraft = null;
    state.pendingListen = null;
    clearFeedback();
    stopGuide();
    spotElements.forEach(({ button, color }) => {
      button.classList.remove("flashing");
      color.classList.remove("unlocking");
    });
    try {
      localStorage.removeItem(storageKey);
      localStorage.removeItem(opsKey);
    } catch {
      // Storage may be disabled when the demo is opened as a local file.
    }
    zoom(-state.zoom);
    mapScroll.scrollTo((mapStage.offsetWidth - mapScroll.clientWidth) * .4, 0);
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
        if (state.sheet?.kind === "listen") renderSheet(false);
        break;
      }
      case "zoom": zoom(Number(id)); break;
      case "menu":
        if (id === "route") state.route ? showSheet("itinerary") : openRoute();
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
      case "journal": showSheet("journal"); break;
      case "listen":
        showSheet("listen", id);
        startGuide(points.get(id));
        break;
      case "listen-open": showSheet("listen", id, button); break;
      case "play": play(points.get(id)); break;
      case "toggle-audio":
        toggleAudio();
        focus(mini.querySelector('[data-action="toggle-audio"]'));
        break;
      case "stop-audio":
        stopGuide();
        focus(state.sheet ? sheetBody.querySelector('[data-action="play"]') || sheet : app.querySelector('[data-action="menu"]'));
        break;
      case "check-in": {
        const point = points.get(id);
        if (unlock(point)) {
          const origin = state.returnFocus;
          const keepListen = state.sheet?.kind === "listen";
          if (!keepListen) closeSheet(false);
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
      case "itinerary": showSheet("itinerary", "", button); break;
      case "end-route":
        state.route = null;
        closeSheet();
        renderNavigation();
        say("已结束行程。");
        break;
      case "arrived": arrive(); break;
      case "scan-point": visitPoint(points.get(id), { speak: Boolean(points.get(id).guide) }); break;
      case "service": service(id); break;
      case "service-tab": state.serviceTab = id; refreshSheet(button); break;
      case "book": showSheet("booking", id); break;
      case "parking-start":
        openRoute(parking.get(id));
        window.CD_TOURISM?.record("parking_advice_adopted", id);
        break;
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
      sheetBody.querySelector("[data-file-name]").textContent = field.files[0]?.name || "未选择";
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
      const now = new Date();
      const id = `BK-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${String(state.bookings.length + 1).padStart(3, "0")}`;
      state.bookings.unshift({ id, guide: guide.id, name: guide.name, slot: fields.get("slot"), people: Number(fields.get("people")), at: now.toISOString() });
      save();
      showSheet("booking-success");
      window.CD_TOURISM?.record("booking_demo_submitted", guide.id);
    } else {
      submitFeedback(form, fields);
    }
  });

  const dragArea = sheet.querySelector(".sheet-drag");
  const sheetHeader = sheet.querySelector(".sheet-header");
  for (const handle of [dragArea, sheetHeader]) {
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest("button") || sheet.classList.contains("full")) return;
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
    if (sheetBody.scrollTop !== 0 || sheet.classList.contains("full") || event.target.closest("input, textarea, select")) return;
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

  // 值班运营台在另一个标签页改了工单或预约状态时，刷新「我的」
  addEventListener("storage", event => {
    if (event.key === opsKey && state.sheet && ["mine", "feedback-success", "services", "point"].includes(state.sheet.kind)) renderSheet(false);
  });

  const icons = {
    route: '<path d="M5 5h14v7H5v7h14"/><circle cx="5" cy="5" r="2" fill="currentColor"/><circle cx="19" cy="19" r="2" fill="currentColor"/>',
    scan: '<path d="M3 8V3h5m8 0h5v5m0 8v5h-5m-8 0H3v-5m4-4h10"/>',
    services: '<path d="M4 5h16v11H10l-4 4v-4H4zM8 9.5h8M8 12.5h5"/>',
    mine: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M8 7h8M8 11h8M8 15h4"/>'
  };
  app.querySelectorAll("[data-icon]").forEach(element => {
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${icons[element.dataset.icon]}</svg>`;
  });
  document.title = data.meta.title;
  byId("title").textContent = data.meta.title;
  byId("map-disclaimer").textContent = "示意图 · 位置待核实 · 停车与讲解员为示范数据";
  initMap();
  sizeMap();
  new ResizeObserver(sizeMap).observe(mapScroll);
  renderLanguage();
  renderProgress();
  updateTabbar();
  app.querySelector('[data-action="zoom"][data-id="-1"]').disabled = true;
  synth?.getVoices();
})();
