const APP_INFO = {
  name: '长堤风貌街',
  slogan: '诉求一单受理，处置全程可查'
};

App({
  globalData: {
    appName: APP_INFO.name,
    slogan: APP_INFO.slogan
  },

  onLaunch() {
    // 仅骨架阶段，不请求任何服务、不写入任何真实凭据
  },

  onShow() {},

  onHide() {},

  onError() {}
});
