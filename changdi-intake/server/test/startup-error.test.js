import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../src/main.js', import.meta.url));
const serverDirectory = fileURLToPath(new URL('..', import.meta.url));

// 合成的假凭据：只用于本测试，绝不是任何真实密钥。
const fakeReceiptKey = 'wmMLmQ6CJBEHEl-2CVWXVB7R9tBNkh-KXX05l1WZNno';
const fakeToken = 'ZmFrZS10b2tlbi1mb3Itc3RhcnR1cC1lcnJvci10ZXN0cw';

// 启动环境必须干净：清掉外部可能带进来的 CHANGDI_* 与 NODE_ENV。
function startupEnvironment(overrides) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('CHANGDI_') || name === 'NODE_ENV') delete environment[name];
  }
  return { ...environment, ...overrides };
}

function runMain(overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mainPath], {
      cwd: serverDirectory,
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

test('startup failure reports the missing receipt key', async () => {
  const result = await runMain({});
  assert.equal(result.code, 1);
  assert.match(result.stderr, /changdi-intake: startup failed\./);
  assert.match(result.stderr, /Configure CHANGDI_RECEIPT_KEY/);
  assert.ok(!result.stdout.includes('listening'), '非法配置时不能真的起服务');
});

test('startup failure names the real cause without echoing the receipt key', async () => {
  const result = await runMain({
    CHANGDI_RECEIPT_KEY: fakeReceiptKey,
    CHANGDI_INTEGRATIONS_JSON: '[]',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /changdi-intake: startup error:/);
  assert.match(result.stderr, /Invalid identity configuration/);
  assert.ok(!result.stderr.includes(fakeReceiptKey), '回执密钥字面量不能出现在输出里');
  assert.ok(!result.stdout.includes(fakeReceiptKey), '回执密钥字面量不能出现在输出里');
  assert.ok(!result.stdout.includes('listening'), '非法配置时不能真的起服务');
});

test('startup failure reports malformed JSON without echoing the token', async () => {
  const result = await runMain({
    CHANGDI_RECEIPT_KEY: fakeReceiptKey,
    CHANGDI_INTEGRATIONS_JSON: '[{"source":"synthetic","token":"' + fakeToken + '"} trailing',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid CHANGDI_INTEGRATIONS_JSON/);
  assert.ok(!result.stderr.includes(fakeToken), 'JSON 里的 token 字面量不能出现在输出里');
  assert.ok(!result.stdout.includes(fakeToken), 'JSON 里的 token 字面量不能出现在输出里');
});
