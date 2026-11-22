Page({
  data: {
    appName: '长堤风貌街',
    slogan: '',
    entries: [
      {
        key: 'submit',
        title: '提交诉求',
        desc: '匿名提交游客诉求并获取查询回执',
        path: '/pages/submit/index',
        placeholder: false
      },
      {
        key: 'mine',
        title: '游客与居民',
        desc: '我的诉求与进度查询',
        path: '/pages/mine/index',
        placeholder: false
      },
      {
        key: 'merchant',
        title: '商户',
        desc: '核验商户身份后提交诉求、查看本商户工单与协办任务',
        path: '/pages/merchant/index',
        placeholder: false
      },
      {
        key: 'staff',
        title: '管理方',
        desc: '核验工作人员身份后进入工作台',
        path: '/pages/staff/index',
        placeholder: false
      }
    ]
  },

  onLoad() {
    const app = getApp();
    const globalData = (app && app.globalData) || {};
    this.setData({
      appName: globalData.appName || '长堤风貌街',
      slogan: globalData.slogan || ''
    });
  },

  onShow() {},

  onEntryTap(event) {
    const key = event.currentTarget.dataset.key;
    const entry = this.data.entries.find(item => item.key === key);
    if (!entry) return;
    wx.navigateTo({ url: entry.path });
  }
});
