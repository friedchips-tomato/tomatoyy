// 正式交接时明确切换 apiMode，并填写经批准的 HTTPS origin。
module.exports = {
  apiMode: 'development',
  apiBaseUrl: 'http://127.0.0.1:3400',
  productionApiBaseUrl: '',
  requestTimeout: 8000
};
