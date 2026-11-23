import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const bridgeDirectory = fileURLToPath(new URL('..', import.meta.url));

// 合成的假凭据：只用于本测试，绝不是任何真实令牌。
const fakeIntakeToken = 'fake-intake-token-0123456789abcdefghijklmnop';
const fakeMetricsToken = 'fake-metrics-token-0123456789abcdefghijklmnop';

// 启动环境必须干净：清掉外部可能带进来的 GUIDE_* 与 NODE_ENV。
function startupEnvironment(overrides) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GUIDE_') || name === 'NODE_ENV') delete environment[name];
  }
  return { ...environment, ...overrides };
}

function runBridge(overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: bridgeDirectory,
      env: startupEnvironment(overrides),
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('startup failure reports the missing intake token', async () => {
  const result = await runBridge({ GUIDE_INTAKE_ORIGIN: 'http://127.0.0.1:3400' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Guide bridge startup failed: check local configuration/);
  assert.match(result.stderr, /Guide bridge startup error:/);
  assert.match(result.stderr, /Configure GUIDE_INTAKE_TOKEN/);
  assert.ok(!result.stdout.includes('Guide bridge: http'), '配置非法时不能真的起服务');
});

test('startup failure reports malformed upstream JSON without echoing the token', async () => {
  const result = await runBridge({
    GUIDE_INTAKE_ORIGIN: '{"origin":"http://127.0.0.1:3400","token":"' + fakeIntakeToken + '"} trailing',
    GUIDE_INTAKE_TOKEN: fakeIntakeToken,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Guide bridge startup error:/);
  assert.match(result.stderr, /Invalid GUIDE_INTAKE_ORIGIN/);
  assert.match(result.stderr, /position \d+/);
  assert.ok(!result.stderr.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stdout.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stderr.includes('"origin"'), 'JSON 原文不能出现在输出里');
  assert.ok(!result.stderr.includes('trailing'), 'JSON 原文不能出现在输出里');
  assert.ok(!result.stdout.includes('Guide bridge: http'), '配置非法时不能真的起服务');
});

test('startup failure reports equal intake and metrics tokens without echoing them', async () => {
  const result = await runBridge({
    GUIDE_INTAKE_ORIGIN: 'http://127.0.0.1:3400',
    GUIDE_INTAKE_TOKEN: fakeIntakeToken,
    GUIDE_METRICS_TOKEN: fakeIntakeToken,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Guide bridge startup error:/);
  assert.match(result.stderr, /separate tokens/);
  assert.ok(!result.stderr.includes('Configure GUIDE_INTAKE_TOKEN'), '根因必须与缺令牌区分开');
  assert.ok(!result.stderr.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stdout.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stdout.includes('Guide bridge: http'), '配置非法时不能真的起服务');
});

test('startup failure reports a non-loopback upstream without echoing the metrics token', async () => {
  const result = await runBridge({
    GUIDE_INTAKE_ORIGIN: 'http://example.test:3400',
    GUIDE_INTAKE_TOKEN: fakeIntakeToken,
    GUIDE_METRICS_TOKEN: fakeMetricsToken,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Guide bridge startup error:/);
  assert.match(result.stderr, /loopback/);
  assert.ok(!result.stderr.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stderr.includes(fakeMetricsToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stdout.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stdout.includes(fakeMetricsToken), '令牌字面量不能出现在输出里');
});

test('startup failure reports an invalid port without echoing the token', async () => {
  const result = await runBridge({
    GUIDE_INTAKE_ORIGIN: 'http://127.0.0.1:3400',
    GUIDE_INTAKE_TOKEN: fakeIntakeToken,
    GUIDE_BRIDGE_PORT: 'not-a-port',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Guide bridge startup error:/);
  assert.match(result.stderr, /Invalid port/);
  assert.ok(!result.stderr.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stdout.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
});

test('startup failure refuses production mode', async () => {
  const result = await runBridge({
    NODE_ENV: 'production',
    GUIDE_INTAKE_ORIGIN: 'http://127.0.0.1:3400',
    GUIDE_INTAKE_TOKEN: fakeIntakeToken,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Guide bridge startup error:/);
  assert.match(result.stderr, /Local development only/);
  assert.ok(!result.stderr.includes(fakeIntakeToken), '令牌字面量不能出现在输出里');
  assert.ok(!result.stdout.includes('Guide bridge: http'), '配置非法时不能真的起服务');
});
