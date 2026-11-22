// T01 我的诉求：读取本机回执夹，逐条查询最新公开状态。
// 本机只保存工单编号、公开查询码与提交时间；私密查询凭证不进入本页，也不在本机保存。
const config = require('../../config.js');
const { apiEnvironment, requestConfigured } = require('../../api-environment');
const { extractPublicCode, queryPublicCase, formatBeijingTime } = require('../public/query.js');
const { readReceipts, clearAll } = require('./receipts.js');

// 取最近一个公开节点的时间。节点按时间先后给出，这里取时间最晚的一个。
function latestMilestoneText(milestones) {
  if (!Array.isArray(milestones) || !milestones.length) return '';
  let latest = null;
  for (const item of milestones) {
    if (!item || typeof item !== 'object') continue;
    const time = Date.parse(item.occurredAt);
    if (Number.isNaN(time)) continue;
    if (!latest || time > latest.time) latest = { time, text: item.timeText };
  }
  return latest ? latest.text : '';
}

// 公开进度页路径。只带公开查询码，不带任何私密凭证。
function publicCaseUrl(code) {
  return '/pages/public/index?code=' + encodeURIComponent(code);
}

Page({
  data: {
    loading: false,
    empty: false,
    entries: [],
    message: ''
  },

  onLoad() {
    this._seq = 0;
    // 每条记录各自的重试代次：同时重试多条时互不丢弃结果。
    this._retries = new Map();
    return this.load();
  },

  onUnload() {
    this._seq += 1;
    this._retries.clear();
  },

  // 下拉刷新与「刷新」按钮走同一条路径。
  onPullDownRefresh() {
    const stop = () => {
      if (typeof wx.stopPullDownRefresh === 'function') wx.stopPullDownRefresh();
    };
    return this.load().then(stop, stop);
  },

  onRefreshTap() {
    return this.load();
  },

  // 读取本机回执夹并逐条查询最新公开状态。单条失败保留该条，供用户重试。
  async load() {
    const seq = ++this._seq;
    this.setData({ loading: true, message: '' });
    const stored = readReceipts();
    if (!stored.ok) {
      if (seq !== this._seq) return;
      this.setData({ loading: false, empty: true, entries: [], message: '本机记录读取失败，请稍后重试。' });
      return;
    }
    if (!stored.entries.length) {
      if (seq !== this._seq) return;
      this.setData({ loading: false, empty: true, entries: [] });
      return;
    }
    const items = stored.entries.map(entry => ({
      caseNumber: entry.caseNumber,
      publicLookupCode: entry.publicLookupCode,
      submittedText: formatBeijingTime(entry.submittedAt),
      state: 'loading',
      statusText: '',
      latestText: '',
      message: ''
    }));
    this.setData({ loading: true, empty: false, entries: items });
    const { origin } = apiEnvironment();
    const results = await Promise.all(items.map(item => queryPublicCase({
      request: requestConfigured,
      baseUrl: origin,
      code: item.publicLookupCode,
      timeout: config.requestTimeout
    })));
    // 旧的一轮查询晚到时丢弃，不覆盖较新一轮的结果。
    if (seq !== this._seq) return;
    const merged = items.map((item, index) => {
      const result = results[index];
      if (result && result.kind === 'success') {
        return {
          ...item,
          state: 'success',
          statusText: result.statusText,
          latestText: latestMilestoneText(result.milestones),
          caseNumber: result.caseNumber || item.caseNumber,
          message: ''
        };
      }
      // 单条查询失败时保留该条记录，让用户可以重试。
      return { ...item, state: 'failed', message: '查询失败，可重试' };
    });
    this.setData({ loading: false, empty: false, entries: merged });
  },

  // 重试单条查询。失败时同样保留该条。
  async onRetryTap(event) {
    const code = event && event.currentTarget ? event.currentTarget.dataset.code : '';
    if (typeof code !== 'string' || !code) return;
    const index = this.data.entries.findIndex(item => item.publicLookupCode === code);
    if (index < 0) return;
    // 页面代次：整表刷新、清除成功或卸载之后才到的旧结果一律丢弃。
    const pageSeq = this._seq;
    // 每条记录各自一代次：同时重试多条时互不丢弃，同一条记录再重试则丢弃上一轮。
    const seq = (this._retries.get(code) || 0) + 1;
    this._retries.set(code, seq);
    this.setData({
      entries: this.data.entries.map((item, position) => (position === index
        ? { ...item, state: 'loading', message: '' }
        : item))
    });
    const { origin } = apiEnvironment();
    const result = await queryPublicCase({
      request: requestConfigured,
      baseUrl: origin,
      code,
      timeout: config.requestTimeout
    });
    if (pageSeq !== this._seq) return;
    if (this._retries.get(code) !== seq) return;
    const current = this.data.entries.findIndex(item => item.publicLookupCode === code);
    if (current < 0) return;
    this.setData({
      entries: this.data.entries.map((item, position) => {
        if (position !== current) return item;
        if (result && result.kind === 'success') {
          return {
            ...item,
            state: 'success',
            statusText: result.statusText,
            latestText: latestMilestoneText(result.milestones),
            caseNumber: result.caseNumber || item.caseNumber,
            message: ''
          };
        }
        return { ...item, state: 'failed', message: '查询失败，可重试' };
      })
    });
  },

  // 扫码查询。取消扫描留在本页，无法识别时提示重新扫。
  onScanTap() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode', 'barCode'],
      success: result => {
        const code = extractPublicCode(result && result.result) || extractPublicCode(result && result.path);
        if (!code) {
          this.setData({ message: '未识别到公开查询码，请重新扫描回执二维码。' });
          return;
        }
        wx.navigateTo({ url: publicCaseUrl(code) });
      },
      // 取消扫描时留在本页，不改动列表。
      fail: () => {}
    });
  },

  // 手动输码查询：进既有的公开查询页，由用户输入回执中的公开查询码。
  // 这是「游客与居民 → 我的诉求」的旧入口，保留它才能在没有本机记录时查到进度。
  onManualCodeTap() {
    wx.navigateTo({ url: '/pages/public/index' });
  },

  // 查看单条公开进度。网址只带公开查询码。
  onViewTap(event) {
    const code = event && event.currentTarget ? event.currentTarget.dataset.code : '';
    if (typeof code !== 'string' || !code) return;
    wx.navigateTo({ url: publicCaseUrl(code) });
  },

  // 清除本机记录。二次确认后才清除，取消不动。
  onClearTap() {
    wx.showModal({
      title: '清除本机记录',
      content: '清除后本机不再保留工单编号与公开查询码，无法恢复。请先确认已保存回执。',
      confirmText: '清除',
      cancelText: '保留',
      success: result => {
        if (!result || !result.confirm) return;
        const cleared = clearAll();
        if (!cleared.ok) {
          // 清除失败不取消原查询：在途查询照常回来，列表不会停在查询中。
          this.setData({ message: '清除失败，请稍后重试。' });
          return;
        }
        // 清除成功：作废在途刷新与重试，之后才到的旧响应不得把已清除的记录画回来。
        this._seq += 1;
        this._retries.clear();
        this.setData({ loading: false, entries: [], empty: true, message: '已清除本机记录。' });
      }
    });
  }
});

module.exports = { latestMilestoneText, publicCaseUrl };
