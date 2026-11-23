#!/usr/bin/env node
// scripts/seed-demo-cases.mjs
//
// 只通过本检出 T16 隔离实例的 HTTP 接口生成合成工单。
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [portFlag, PORT, confirmFlag, ...unexpected] = process.argv.slice(2);
if (portFlag !== '--port' || !/^[1-9][0-9]{0,4}$/.test(PORT ?? '') ||
    Number(PORT) > 65535 || confirmFlag !== '--confirm-demo' || unexpected.length) {
  console.error('用法：node scripts/seed-demo-cases.mjs --port <本机答辩后端端口> --confirm-demo');
  process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}`;

class SeedError extends Error {}

const scripts = dirname(realpathSync(fileURLToPath(import.meta.url)));
const systemRoot = process.env.SystemRoot;
const system32 = systemRoot && join(systemRoot, 'System32');

function inspectWindows(executable, args, extraEnv = {}) {
  const env = { SystemRoot: systemRoot, PATHEXT: '.COM;.EXE;.BAT;.CMD', ...extraEnv };
  for (const name of ['TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'PSModulePath', 'windir']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return spawnSync(join(system32, executable), args, {
    env,
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
}

function requireLocalFile(path) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.nlink !== 1 || realpathSync(path) !== path) {
    throw new SeedError('演示运行文件必须位于本检出的独立运行目录。');
  }
}

function verifyDemoTarget() {
  let stage = '运行记录或端口不匹配';
  try {
    if (process.platform !== 'win32' || !system32) throw new Error();
    const runtime = join(scripts, '.demo-local');
    if (!lstatSync(runtime).isDirectory() || realpathSync(runtime) !== runtime) throw new Error();
    const statePath = join(runtime, 'processes.json');
    const hostPath = join(runtime, 'services.mjs');
    for (const path of [statePath, hostPath, join(runtime, 'demo.sqlite')]) requireLocalFile(path);

    const snapshot = readFileSync(statePath, 'utf8');
    const state = JSON.parse(snapshot);
    const backend = state.services?.find(record => record.name === 'backend');
    if (state.version !== 1 || state.checkout?.toLowerCase() !== dirname(scripts).toLowerCase() ||
        state.ports?.[0] !== Number(PORT) || !Number.isSafeInteger(backend?.pid) || backend.pid <= 0 ||
        !/^[0-9]{17,19}$/.test(backend.created) || typeof backend.image !== 'string') {
      throw new Error();
    }

    // 复用 T16 登记的 PID、Windows 创建时间和程序路径，另核实启动参数。
    const powershell = 'WindowsPowerShell/v1.0/powershell.exe';
    const psArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    const identityCheck = `
      $ErrorActionPreference = 'Stop'
      $process = Get-Process -Id ([int]$env:SEED_BACKEND_PID)
      if ($process.StartTime.ToFileTimeUtc().ToString() -cne $env:SEED_BACKEND_CREATED -or
          $process.Path -ne $env:SEED_BACKEND_IMAGE) { exit 1 }
      $record = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $env:SEED_BACKEND_PID)
      $expected = '"' + $env:SEED_BACKEND_IMAGE + '" --no-warnings "' + $env:SEED_HOST_SCRIPT +
        '" backend ' + $env:SEED_PORT + ' ' + $env:SEED_PORT
      if (!$record -or $record.CommandLine -ne $expected) { exit 1 }
    `;
    stage = '后端进程身份与登记不符或无法读取';
    const encoded = Buffer.from(identityCheck, 'utf16le').toString('base64');
    const identity = inspectWindows(powershell, [...psArgs, '-EncodedCommand', encoded], {
      SEED_BACKEND_PID: String(backend.pid),
      SEED_BACKEND_CREATED: backend.created,
      SEED_BACKEND_IMAGE: backend.image,
      SEED_HOST_SCRIPT: hostPath,
      SEED_PORT: PORT,
    });
    if (identity.status !== 0 || readFileSync(statePath, 'utf8') !== snapshot) throw new Error();
    return backend.pid;
  } catch {
    throw new SeedError(`无法确认目标是本检出的健康隔离实例（${stage}），请检查答辩启动.ps1 和指定端口。`);
  }
}

// ---------------------------------------------------------------------------
// 从环境变量读取凭据（值只保留在进程内存里，绝不打印、绝不写文件）。
// ---------------------------------------------------------------------------
function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) throw new SeedError(`缺少环境变量 ${name}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new SeedError(`${name} 不是合法 JSON`);
  }
}

let integrations;
let staff;
try {
  integrations = parseJsonEnv('CHANGDI_INTEGRATIONS_JSON');
  staff = parseJsonEnv('CHANGDI_STAFF_JSON');
} catch (error) {
  console.error('启动配置缺失：' + error.message);
  console.error('请在当前终端设置启动本检出答辩实例时使用的同一套合成凭据。');
  process.exit(1);
}

const integration = Array.isArray(integrations) ? integrations.find(entry => entry?.source === 'local-demo') : null;
const duty = Array.isArray(staff) ? staff.find(entry => entry && entry.role === 'duty') : null;
const handler = Array.isArray(staff) ? staff.find(entry => entry && entry.role === 'handler') : null;
const supervisor = Array.isArray(staff) ? staff.find(entry => entry && entry.role === 'supervisor') : null;
if (!integration?.token || !duty?.token || !handler?.token || !supervisor?.token) {
  console.error('需要 local-demo 接单方以及 duty / handler / supervisor 三个角色的合成凭据。');
  process.exit(1);
}

const integrationToken = integration.token;
const dutyToken = duty.token;
const handlerToken = handler.token;
const supervisorToken = supervisor.token;
const handlerId = handler.id;

let backendPid;
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
agent.createConnection = connectToDemo;

// 在已建立的 TCP 连接上验证服务端 PID，再交出 socket 发送 HTTP。
// 每次新连接都检查，服务退出或端口被其他进程接管时不会发送凭据。
function connectToDemo(_options, callback) {
  const socket = createConnection({ host: '127.0.0.1', port: Number(PORT), family: 4 });
  const failed = () => {
    socket.destroy();
    callback(new SeedError('无法建立已验证的演示后端连接。'));
  };
  socket.setTimeout(5000, failed);
  socket.once('error', failed);
  socket.once('connect', () => {
    socket.removeListener('error', failed);
    socket.removeListener('timeout', failed);
    socket.setTimeout(0);
    const client = `127.0.0.1:${socket.localPort}`;
    const server = `127.0.0.1:${PORT}`;
    const result = inspectWindows('netstat.exe', ['-ano', '-p', 'tcp']);
    const owned = result.status === 0 && result.stdout.split(/\r?\n/).some(row => {
      const [protocol, local, remote, , owner] = row.trim().split(/\s+/);
      return protocol === 'TCP' && local === server && remote === client && owner === String(backendPid);
    });
    if (!owned) return failed();
    callback(null, socket);
  });
}

// 响应正文供业务判断使用，日志只输出固定诊断和自定义的配方编号。
async function request(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    const encoded = new Request(BASE + path, { method, body: form });
    headers['Content-Type'] = encoded.headers.get('content-type');
    body = Buffer.from(await encoded.arrayBuffer());
  }
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(BASE + path, { method, headers, agent }, resolve);
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy());
    req.end(body);
  });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const status = response.statusCode;
  const data = status >= 200 && status < 300 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  return { status, data };
}

function assertOk(result, label) {
  if (result.status >= 200 && result.status < 300) return result;
  throw new SeedError(`${label} 失败（HTTP ${result.status}）。`);
}

// ---------------------------------------------------------------------------
// 业务动作封装。
// ---------------------------------------------------------------------------
function submitForm(payload) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  return form;
}

async function submitCase(recipe) {
  const payload = {
    externalCaseId: recipe.externalCaseId,
    occurredAt: recipe.occurredAt,
    location: recipe.location,
    category: recipe.category,
    description: recipe.description,
    contact: recipe.contact,
  };
  const result = await request('POST', '/api/v1/integrations/intake/cases', {
    token: integrationToken,
    form: submitForm(payload),
  });
  assertOk(result, `提交工单 ${recipe.externalCaseId}`);
  const receipt = result.data;
  if (!/^CD-[0-9A-F]{32}$/.test(receipt?.caseNumber ?? '')) {
    throw new SeedError('接单回执缺少有效工单编号。');
  }
  return { receipt, created: result.status === 201 };
}

async function staffAct(caseNumber, token, version, action, extra = {}) {
  const result = await request('POST', `/api/v1/staff/cases/${caseNumber}/actions`, {
    token,
    json: { action, expectedVersion: version, ...extra },
  });
  assertOk(result, `staff.${action} ${caseNumber}`);
  return result.data;
}

async function ownerVerify(receipt) {
  // 本人核验不带 Authorization，凭据只放 JSON 请求体。
  const result = await request('POST', '/api/v1/owner/verify', {
    json: { publicLookupCode: receipt.publicLookupCode, privateLookupToken: receipt.privateLookupToken },
  });
  assertOk(result, `owner.verify ${receipt.caseNumber}`);
  return result.data.ownerSessionToken;
}

async function ownerAct(caseNumber, sessionToken, version, action, extra = {}) {
  const result = await request('POST', `/api/v1/owner/cases/${caseNumber}/actions`, {
    token: sessionToken,
    json: { action, expectedVersion: version, ...extra },
  });
  assertOk(result, `owner.${action} ${caseNumber}`);
  return result.data;
}

function tokenFor(actor) {
  if (actor === 'duty') return dutyToken;
  if (actor === 'handler') return handlerToken;
  if (actor === 'supervisor') return supervisorToken;
  throw new SeedError('配方含未知角色。');
}

// 分派期限：普通单 3 天后，临期单 2 小时后（用于填 due_soon 队列）。
const farDue = () => new Date(Date.now() + 72 * 3600 * 1000).toISOString();
const soonDue = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString();

// ---------------------------------------------------------------------------
// 工单配方：覆盖 10 个状态、6 类诉求、6 个非零队列。
// ---------------------------------------------------------------------------
const OCCURRED_BASE = '2026-11-23T';
function at(hhmm) {
  return OCCURRED_BASE + hhmm + ':00+08:00';
}

const RECIPES = [
  {
    externalCaseId: 'demo-seed-01',
    category: '环境卫生',
    location: '长堤风貌街 骑楼街 1 段（演示点位）',
    occurredAt: at('08:05'),
    contact: 'demo-01@example.test',
    description: '【演示】环境卫生 · 已关闭并评价示例：骑楼街 1 段人行道有散落垃圾，游客拍照申报。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
      { actor: 'handler', action: 'start' },
      { actor: 'handler', action: 'submit_result', extra: { summary: '【演示】处理完毕，等待复核：垃圾已清扫，人行道恢复整洁。', photoOmissionReason: '【演示】无现场照片，无需送审附件。' } },
      { actor: 'supervisor', action: 'publish', extra: { summary: '【演示】已复核并发布反馈：垃圾已清扫，现场已拍照留档。' } },
      { actor: 'owner', action: 'evaluate', extra: { speed: 5, effectiveness: 5, attitude: 5, comment: '【演示】处理很及时，街面干净了。' } },
      { actor: 'owner', action: 'confirm_resolved' },
    ],
  },
  {
    externalCaseId: 'demo-seed-02',
    category: '设施损坏',
    location: '长堤风貌街 启明里 3 号门前（演示点位）',
    occurredAt: at('08:40'),
    contact: 'demo-02@example.test',
    description: '【演示】设施损坏 · 已关闭并评价示例：启明里 3 号门前路灯不亮，影响夜间通行。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
      { actor: 'handler', action: 'start' },
      { actor: 'handler', action: 'submit_result', extra: { summary: '【演示】处理完毕，等待复核：路灯已修复，夜间照明恢复正常。', photoOmissionReason: '【演示】无现场照片，无需送审附件。' } },
      { actor: 'supervisor', action: 'publish', extra: { summary: '【演示】已复核并发布反馈：路灯已修复并通电测试。' } },
      { actor: 'owner', action: 'evaluate', extra: { speed: 4, effectiveness: 5, attitude: 4, comment: '【演示】晚上亮起来了，满意。' } },
      { actor: 'owner', action: 'confirm_resolved' },
    ],
  },
  {
    externalCaseId: 'demo-seed-03',
    category: '停车问题',
    location: '长堤风貌街 沿江路 P1 停车场入口（演示点位）',
    occurredAt: at('09:10'),
    contact: 'demo-03@example.test',
    description: '【演示】停车问题 · 已关闭并评价示例：P1 停车场入口有车辆违停堵塞通道。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
      { actor: 'handler', action: 'start' },
      { actor: 'handler', action: 'submit_result', extra: { summary: '【演示】处理完毕，等待复核：违停车辆已劝离，通道恢复畅通。', photoOmissionReason: '【演示】无现场照片，无需送审附件。' } },
      { actor: 'supervisor', action: 'publish', extra: { summary: '【演示】已复核并发布反馈：违停车辆已劝离，通道畅通。' } },
      { actor: 'owner', action: 'evaluate', extra: { speed: 5, effectiveness: 4, attitude: 5, comment: '【演示】入口不堵了，很好。' } },
      { actor: 'owner', action: 'confirm_resolved' },
    ],
  },
  {
    externalCaseId: 'demo-seed-04',
    category: '环境卫生',
    location: '长堤风貌街 长堤广场喷泉旁（演示点位）',
    occurredAt: at('09:45'),
    contact: 'demo-04@example.test',
    description: '【演示】待受理示例：长堤广场喷泉旁有果皮纸屑，等待值班人员受理。',
    steps: [],
  },
  {
    externalCaseId: 'demo-seed-05',
    category: '街面维护',
    location: '长堤风貌街 堤中路（演示点位）',
    occurredAt: at('10:05'),
    contact: 'demo-05@example.test',
    description: '【演示】待分派示例：堤中路地砖松动，已受理、等待分派承办人。',
    steps: [
      { actor: 'duty', action: 'accept' },
    ],
  },
  {
    externalCaseId: 'demo-seed-06',
    category: '设施损坏',
    location: '长堤风貌街 常安路（演示点位）',
    occurredAt: at('10:20'),
    contact: 'demo-06@example.test',
    description: '【演示】已分派示例：常安路一处围挡破损，已分派给承办人、等待处理。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
    ],
  },
  {
    externalCaseId: 'demo-seed-07',
    category: '停车问题',
    location: '长堤风貌街 沿江路非机动车停放区（演示点位）',
    occurredAt: at('10:40'),
    contact: 'demo-07@example.test',
    description: '【演示】处理中示例：沿江路非机动车乱停放，承办人正在现场处理。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
      { actor: 'handler', action: 'start' },
    ],
  },
  {
    externalCaseId: 'demo-seed-08',
    category: '设施损坏',
    location: '长堤风貌街 骑楼街 2 段（演示点位）',
    occurredAt: at('11:00'),
    contact: 'demo-08@example.test',
    description: '【演示】待复核示例：骑楼街 2 段一处公共座椅损坏，承办人已提交处理结果、等待主管复核。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
      { actor: 'handler', action: 'start' },
      { actor: 'handler', action: 'submit_result', extra: { summary: '【演示】处理完毕，等待复核：损坏座椅已更换。', photoOmissionReason: '【演示】无现场照片，无需送审附件。' } },
    ],
  },
  {
    externalCaseId: 'demo-seed-09',
    category: '停车问题',
    location: '长堤风貌街 P2 停车场入口（演示点位）',
    occurredAt: at('11:20'),
    contact: 'demo-09@example.test',
    description: '【演示】临期示例：P2 停车场入口有违停，已分派且办理期限临近（用于演示「临期」队列）。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: soonDue() } },
    ],
  },
  {
    externalCaseId: 'demo-seed-10',
    category: '公共秩序',
    location: '长堤风貌街 常安路与堤中路交叉口（演示点位）',
    occurredAt: at('11:35'),
    contact: 'demo-10@example.test',
    description: '【演示】待补充材料示例：举报流动摊贩占道，值班人员要求补充具体发生时段。',
    steps: [
      { actor: 'duty', action: 'request_supplement', extra: { reason: '【演示】请补充问题发生的具体时段。' } },
    ],
  },
  {
    externalCaseId: 'demo-seed-11',
    category: '街面维护',
    location: '长堤风貌街 外围（演示点位，非本街区管辖）',
    occurredAt: at('11:50'),
    contact: 'demo-11@example.test',
    description: '【演示】不予受理示例：诉求内容不属于本街区管辖范围，已作出不予受理决定。',
    steps: [
      { actor: 'duty', action: 'reject', extra: { reason: '【演示】该点位不属于本街区管辖范围，不予受理。' } },
    ],
  },
  {
    externalCaseId: 'demo-seed-12',
    category: '公共秩序',
    location: '长堤风貌街 长堤广场（演示点位）',
    occurredAt: at('12:05'),
    contact: 'demo-12@example.test',
    description: '【演示】补办待审核示例：占道问题已办结后提交人申请补办，等待主管审核补办申请。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
      { actor: 'handler', action: 'start' },
      { actor: 'handler', action: 'submit_result', extra: { summary: '【演示】处理完毕，等待复核：占道问题已处理。', photoOmissionReason: '【演示】无现场照片，无需送审附件。' } },
      { actor: 'supervisor', action: 'publish', extra: { summary: '【演示】已复核并发布反馈：占道问题已处理。' } },
      { actor: 'owner', action: 'request_reopen', extra: { reason: '【演示】问题在夜间再次出现，申请补办。' } },
    ],
  },
  {
    externalCaseId: 'demo-seed-13',
    category: '噪声扰民',
    location: '长堤风貌街 启明里 2 段（演示点位）',
    occurredAt: at('12:25'),
    contact: 'demo-13@example.test',
    description: '【演示】待评价示例：噪声扰民问题已处理并发布反馈，等待提交人评价。',
    steps: [
      { actor: 'duty', action: 'accept' },
      { actor: 'duty', action: 'assign', extra: { assignee: handlerId, dueAt: farDue() } },
      { actor: 'handler', action: 'start' },
      { actor: 'handler', action: 'submit_result', extra: { summary: '【演示】处理完毕，等待复核：噪声源已劝阻。', photoOmissionReason: '【演示】无现场照片，无需送审附件。' } },
      { actor: 'supervisor', action: 'publish', extra: { summary: '【演示】已复核并发布反馈：噪声源已劝阻，问题解决。' } },
    ],
  },
];

// ---------------------------------------------------------------------------
// 主流程。
// ---------------------------------------------------------------------------
async function readProgress(caseNumber, recipe) {
  const result = await request('GET', `/api/v1/staff/cases/${caseNumber}`, { token: dutyToken });
  const detail = assertOk(result, '读取已有工单进度').data;
  const { history, version } = detail;
  if (version !== history.length || history[0]?.action !== 'submit' ||
      history[0].actorType !== 'integration' || version > recipe.steps.length + 1 ||
      detail.status !== history.at(-1).status || detail.description !== recipe.description) {
    throw new SeedError('已有工单与配方不一致，请检查这条工单。');
  }
  for (const [index, event] of history.slice(1).entries()) {
    const step = recipe.steps[index];
    if (event.action !== step.action || event.actorType !== (step.actor === 'owner' ? 'owner' : 'staff')) {
      throw new SeedError('已有工单含其他流转动作，请检查这条工单。');
    }
    if (step.action === 'evaluate' && Object.entries(step.extra).some(([key, value]) =>
      detail.rounds?.[0]?.evaluation?.[key] !== value)) {
      throw new SeedError('已有三维评价与配方不一致，请检查这条工单。');
    }
  }
  return { version, status: detail.status };
}

async function applyRecipe(recipe) {
  const { receipt, created } = await submitCase(recipe);
  const initial = created ? { version: 1, status: 'submitted' } : await readProgress(receipt.caseNumber, recipe);
  const remaining = recipe.steps.slice(initial.version - 1);
  let { version, status } = initial;
  let ownerSession;
  for (const step of remaining) {
    let detail;
    if (step.actor === 'owner') {
      ownerSession ??= await ownerVerify(receipt);
      detail = await ownerAct(receipt.caseNumber, ownerSession, version, step.action, step.extra);
    } else {
      detail = await staffAct(receipt.caseNumber, tokenFor(step.actor), version, step.action, step.extra);
    }
    version = detail.version;
    status = detail.status;
  }
  const outcome = created ? 'created' : remaining.length ? 'resumed' : 'skipped';
  return { outcome, status };
}

function errorMessage(error) {
  return error instanceof SeedError ? error.message : '连接中断或接口响应异常。';
}

async function main() {
  backendPid = verifyDemoTarget();
  const me = assertOk(await request('GET', '/api/v1/staff/me', { token: dutyToken }), '核实值班角色');
  if (me.data?.role !== 'duty') throw new SeedError('当前凭据无法用于值班角色。');

  const totals = { created: 0, resumed: 0, skipped: 0, failed: 0 };
  for (const recipe of RECIPES) {
    try {
      const { outcome, status } = await applyRecipe(recipe);
      totals[outcome]++;
      console.log(`${recipe.externalCaseId} ${status}`);
    } catch (error) {
      totals.failed++;
      console.error(`${recipe.externalCaseId} ${errorMessage(error)}`);
    }
  }

  console.log(`演示配方共 ${RECIPES.length} 条，新建并完成 ${totals.created}，补跑完成 ${totals.resumed}，已完成跳过 ${totals.skipped}，失败 ${totals.failed}。`);
  if (totals.failed) {
    console.error('失败项可能已提交或推进了部分动作。排除错误后使用相同的演示库及凭据重跑。');
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error('种子脚本失败：' + errorMessage(error));
  process.exitCode = 1;
} finally {
  agent.destroy();
}
