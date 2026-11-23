<#
.SYNOPSIS
  本机答辩演示服务，默认端口为 3400 / 8931 / 8932。
.DESCRIPTION
  Windows PowerShell 5.1，Node.js 22.17 或更新版本（需要 node:sqlite）。
  启动前在当前进程环境或 scripts/.demo-local/credentials.json 中配置合成凭据。
  可用 -CredentialsFile 指定本机 JSON 文件。文件为平面对象，键和值均为字符串，
  *_JSON 项的值为 JSON 字符串。当前进程的非空值优先。
  必填 CHANGDI_RECEIPT_KEY、CHANGDI_INTEGRATIONS_JSON、GUIDE_INTAKE_TOKEN。
  可选 CHANGDI_STAFF_JSON、CHANGDI_MERCHANTS_JSON、CHANGDI_TOURISM_JSON、GUIDE_METRICS_TOKEN。
  保持同一检出的 CHANGDI_RECEIPT_KEY 稳定，以便继续访问已保存的工单。
  -Status 和 -Stop 无需凭据。-Status 退出码 0 为全部就绪，2 为全部停止，1 为异常。
  -KeepDb 为兼容参数，演示库始终保留。可用三个 Port 参数选用备用端口。
#>
#Requires -Version 5.1
[CmdletBinding(DefaultParameterSetName = 'Start')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Stop')][switch]$Stop,
    [Parameter(Mandatory, ParameterSetName = 'Status')][switch]$Status,
    [Parameter(ParameterSetName = 'Start')][switch]$KeepDb,
    [Parameter(ParameterSetName = 'Start')][string]$CredentialsFile,
    [Parameter(ParameterSetName = 'Start')][ValidateRange(1,65535)][int]$BackendPort = 3400,
    [Parameter(ParameterSetName = 'Start')][ValidateRange(1,65535)][int]$StaticPort = 8931,
    [Parameter(ParameterSetName = 'Start')][ValidateRange(1,65535)][int]$BridgePort = 8932
)

class DemoFailure : System.Exception {
    DemoFailure([string]$message) : base($message) { }
}

$ErrorActionPreference = 'Stop'
try { if ([Console]::IsOutputRedirected) { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } } catch { }

$RequestedPorts = @($BackendPort, $StaticPort, $BridgePort)
$Specs = @(
    @{ Name = 'backend'; Title = '接诉即办后端'; Path = '/api/v1/public/parking/lots' },
    @{ Name = 'static'; Title = '原型静态站'; Path = '/prototype-paper/' },
    @{ Name = 'bridge'; Title = '导览接入层'; Path = '/' }
)
$BackendKeys = @('CHANGDI_RECEIPT_KEY', 'CHANGDI_INTEGRATIONS_JSON', 'CHANGDI_STAFF_JSON',
    'CHANGDI_MERCHANTS_JSON', 'CHANGDI_TOURISM_JSON')
$BridgeKeys = @('GUIDE_INTAKE_TOKEN', 'GUIDE_METRICS_TOKEN')

# 按同一个 Windows 进程句柄核对身份和停止，避免检查后 PID 被复用。
if (-not ('DemoProcess' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class DemoProcess {

    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public int X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public short Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo {
        public IntPtr Process, Thread;
        public int Pid, ThreadId;
    }

    public sealed class Started {
        public int Pid;
        public SafeProcessHandle Handle;
    }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string image, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, byte[] environment, string directory,
        ref StartupInfo startup, out ProcessInfo process);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetExitCodeProcess(IntPtr handle, out int code);

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern int GetLongPathName(string shortPath, StringBuilder longPath, int size);

    public static string LongPath(string path) {
        var buffer = new StringBuilder(32768);
        int size = GetLongPathName(path, buffer, buffer.Capacity);
        if (size == 0 || size >= buffer.Capacity)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return buffer.ToString();
    }

    public static Started Start(string image, string arguments, string directory, string[] variables) {
        var command = new StringBuilder("\"" + image + "\" " + arguments);
        Array.Sort(variables, StringComparer.OrdinalIgnoreCase);
        var environment = Encoding.Unicode.GetBytes(String.Join("\0", variables) + "\0\0");
        try {
            var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)) };
            ProcessInfo result;
            // CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, no inherited handles.
            if (!CreateProcess(image, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000400,
                environment, directory, ref startup, out result))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            CloseHandle(result.Thread);
            return new Started { Pid = result.Pid, Handle = new SafeProcessHandle(result.Process, true) };
        } finally {
            Array.Clear(environment, 0, environment.Length);
        }
    }

    public static int ExitCode(IntPtr handle) {
        int code;
        if (!GetExitCodeProcess(handle, out code))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return code;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit,
                                       out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    public static SafeProcessHandle Open(int pid, bool stop) {
        var handle = OpenProcess(stop ? 0x101001u : 0x101000u, false, pid);
        if (!handle.IsInvalid) return handle;
        int error = Marshal.GetLastWin32Error();
        handle.Dispose();
        if (error == 87) return null; // PID no longer exists.
        throw new Win32Exception(error);
    }

    public static bool Exited(IntPtr handle) {
        uint result = WaitForSingleObject(handle, 0);
        if (result == 258) return false;
        if (result == 0) return true;
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static string Created(IntPtr handle) {
        long creation, exit, kernel, user;
        if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return creation.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    public static string Image(IntPtr handle) {
        var image = new StringBuilder(32768);
        int size = image.Capacity;
        if (!QueryFullProcessImageName(handle, 0, image, ref size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return image.ToString();
    }

    public static void Stop(IntPtr handle) {
        if (Exited(handle)) return;
        if (!TerminateProcess(handle, 1)) {
            int error = Marshal.GetLastWin32Error();
            if (Exited(handle)) return;
            throw new Win32Exception(error);
        }
        if (WaitForSingleObject(handle, 5000) != 0)
            throw new InvalidOperationException("Process exit not confirmed");
    }
}
'@
}

$ScriptsPath = [DemoProcess]::LongPath($PSScriptRoot)
$RepoRoot = Split-Path -Parent $ScriptsPath
$Runtime = Join-Path $ScriptsPath '.demo-local'
$StatePath = Join-Path $Runtime 'processes.json'
$HostScript = Join-Path $Runtime 'services.mjs'
$Database = Join-Path $Runtime 'demo.sqlite'

function Assert-LocalItem {
    param([string]$Path)
    try { $item = Get-Item -LiteralPath $Path -Force }
    catch [System.Management.Automation.ItemNotFoundException] { return }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType) {
        throw [DemoFailure]::new('运行目录或状态文件含链接，已停止操作。')
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $StatePath)) { return }
    try {
        $stored = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($stored.version -ne 1 -or $stored.checkout -ne $RepoRoot -or
            @($stored.ports).Count -ne 3 -or @($stored.ports | Select-Object -Unique).Count -ne 3) {
            throw 'metadata'
        }
        foreach ($port in $stored.ports) {
            if ($port -isnot [int] -or $port -lt 1 -or $port -gt 65535) { throw 'port' }
        }
        $seen = @{}
        $seenPids = @{}
        foreach ($record in $stored.services) {
            if ($record.name -notin $Specs.Name -or $seen.ContainsKey($record.name) -or
                $record.pid -isnot [int] -or $record.pid -le 0 -or $seenPids.ContainsKey($record.pid) -or
                $record.created -isnot [string] -or $record.created -notmatch '^[0-9]{17,19}$' -or
                $record.image -isnot [string] -or $record.image -notmatch '^(?:[A-Za-z]:\\|\\\\).+\\node\.exe$') {
                throw 'process'
            }
            $seen[$record.name] = $true
            $seenPids[$record.pid] = $true
        }
        return $stored
    } catch { throw [DemoFailure]::new('进程记录无法验证，已保留状态文件。') }
}

function Save-State {
    param([int[]]$Ports, [object[]]$Records)
    $temporary = Join-Path $Runtime ([Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = @{ version = 1; checkout = $RepoRoot; ports = $Ports; services = $Records } | ConvertTo-Json -Depth 4
        [IO.File]::WriteAllText($temporary, $json)
        if ([IO.File]::Exists($StatePath)) { [IO.File]::Replace($temporary, $StatePath, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $StatePath) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-RecordedProcess {
    param($Record, [switch]$Terminate)
    $handle = $null
    try {
        $handle = [DemoProcess]::Open($Record.pid, $Terminate.IsPresent)
        if ($null -eq $handle) { return 'stopped' }
        $native = $handle.DangerousGetHandle()
        if ([DemoProcess]::Exited($native)) { return 'stopped' }
        if ([DemoProcess]::Created($native) -cne $Record.created -or
            [DemoProcess]::Image($native) -ne $Record.image) { return 'unverified' }
        if (-not $Terminate) { return 'owned' }
        [DemoProcess]::Stop($native)
        return 'stopped'
    } catch {
        return 'unverified'
    } finally {
        if ($null -ne $handle) { $handle.Dispose() }
    }
}

function Get-Listeners {
    $rows = & (Join-Path ([Environment]::SystemDirectory) 'netstat.exe') -ano
    if ($LASTEXITCODE -ne 0 -or -not $rows) { throw [DemoFailure]::new('无法枚举 TCP 监听端口。') }
    foreach ($row in $rows) {
        # TCP 监听行的远端地址为通配地址且端口为 0，与系统语言无关。
        if ($row -match '^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$') {
            [pscustomobject]@{ Address = $Matches[1]; Port = [int]$Matches[2]; ProcessId = [int]$Matches[3] }
        }
    }
}

function Get-ServiceStatus {
    param($Spec, [int]$Port, $Record, [object[]]$Listeners)
    $owners = @($Listeners | Where-Object Port -eq $Port)
    if ($Record) {
        $ownership = Get-RecordedProcess $Record
        if ($ownership -eq 'unverified') { return "进程身份无法核实（PID $($Record.pid)）" }
        if ($ownership -eq 'owned' -and $owners.Count -eq 1 -and
            $owners[0].ProcessId -eq $Record.pid -and $owners[0].Address -eq '127.0.0.1') {
            $request = [Net.WebRequest]::Create("http://127.0.0.1:$Port$($Spec.Path)")
            $request.Proxy = $null
            $request.Timeout = 1500
            $request.ReadWriteTimeout = 1500
            $request.AllowAutoRedirect = $false
            try {
                $response = $request.GetResponse()
                try { return "HTTP $([int]$response.StatusCode)（PID $($Record.pid)）" }
                finally { $response.Close() }
            } catch [Net.WebException] {
                if ($_.Exception.Response) { $_.Exception.Response.Close() }
                return "健康检查失败（PID $($Record.pid)）"
            }
        }
        if ($ownership -eq 'owned' -and $owners.Count -eq 0) { return "进程未就绪（PID $($Record.pid)）" }
    }
    if ($owners.Count) { return "监听冲突（PID $($owners.ProcessId -join ', ')）" }
    return '已停止'
}

function Show-Status {
    param([int[]]$Ports, [object[]]$Records)
    $ready = 0
    $stopped = 0
    $listeners = @(Get-Listeners)
    for ($index = 0; $index -lt $Specs.Count; $index++) {
        $spec = $Specs[$index]
        $record = $Records | Where-Object name -eq $spec.Name
        $result = Get-ServiceStatus $spec $Ports[$index] $record $listeners
        Write-Host "$($spec.Title) $($Ports[$index])  $result"
        if ($result -like 'HTTP 200（*') { $ready++ }
        if ($result -eq '已停止') { $stopped++ }
    }
    if ($ready -eq 3) { return 0 }
    if ($stopped -eq 3) { return 2 }
    return 1
}

function Read-Credentials {
    param([string]$Path)
    $allowed = $BackendKeys + $BridgeKeys
    $values = @{}
    if ($Path -or (Test-Path -LiteralPath (Join-Path $Runtime 'credentials.json'))) {
        if (-not $Path) { $Path = Join-Path $Runtime 'credentials.json' }
        try {
            $config = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($config -isnot [pscustomobject]) { throw 'shape' }
            foreach ($field in $config.PSObject.Properties) {
                if ($field.Name -cnotin $allowed -or $field.Value -isnot [string]) { throw 'field' }
                $values[$field.Name] = $field.Value
            }
        } catch { throw [DemoFailure]::new('凭据文件不可读取，或不是由支持的环境变量名和字符串值组成的 JSON 对象。') }
    }
    foreach ($key in $allowed) {
        $value = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($value) { $values[$key] = $value }
    }
    foreach ($key in 'CHANGDI_RECEIPT_KEY', 'CHANGDI_INTEGRATIONS_JSON', 'GUIDE_INTAKE_TOKEN') {
        if (-not $values[$key]) { throw [DemoFailure]::new("缺少合成凭据配置 $key。") }
    }
    foreach ($key in $values.Keys) {
        if ($values[$key].Contains([char]0)) { throw [DemoFailure]::new("凭据配置 $key 包含无效字符。") }
    }
    return $values
}

# main.js 固定使用业务目录的 .local 库，演示入口直接复用其服务工厂。
function Write-ServiceHost {
    $source = @'
import { createHmac } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = dirname(fileURLToPath(import.meta.url));
const checkout = join(runtime, '..', '..');
const [service, port, upstreamPort] = process.argv.slice(2);
const upstream = 'http://127.0.0.1:' + upstreamPort;

function stopWith(code) { process.exit(code); }
process.on('uncaughtException', () => stopWith(29));
process.on('unhandledRejection', () => stopWith(29));

function readConfig(name, fallback, validate) {
  try {
    const value = JSON.parse(process.env[name] ?? fallback);
    if (validate(value)) return value;
  } catch { /* Never report the raw value. */ }
  stopWith({ CHANGDI_INTEGRATIONS_JSON: 31, CHANGDI_STAFF_JSON: 32,
    CHANGDI_MERCHANTS_JSON: 33, CHANGDI_TOURISM_JSON: 34 }[name]);
}

async function intake() {
  const { createIntakeServer } = await import(pathToFileURL(join(checkout, 'changdi-intake/server/src/server.js')));
  const { SCHEMA_VERSION } = await import(pathToFileURL(join(checkout, 'changdi-intake/server/src/store.js')));
  const { DatabaseSync } = await import('node:sqlite');
  const key = process.env.CHANGDI_RECEIPT_KEY;
  const receiptKey = Buffer.from(key, 'base64url');
  if (receiptKey.length !== 32 || receiptKey.toString('base64url') !== key) stopWith(21);

  const integrations = readConfig('CHANGDI_INTEGRATIONS_JSON', '[]', Array.isArray);
  const staff = readConfig('CHANGDI_STAFF_JSON', '[]', Array.isArray);
  const merchants = readConfig('CHANGDI_MERCHANTS_JSON', '[]', Array.isArray);
  const tourism = readConfig('CHANGDI_TOURISM_JSON', '{}',
    value => value && typeof value === 'object' && !Array.isArray(value));
  const dbPath = join(runtime, 'demo.sqlite');
  const files = [dbPath, ...['-wal', '-shm', '-journal'].map(suffix => dbPath + suffix)];
  for (const file of files) {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.nlink !== 1 || realpathSync(file) !== file)) stopWith(22);
  }
  if (files.slice(1).some(existsSync)) stopWith(22);
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) stopWith(23);
        const expected = createHmac('sha256', receiptKey)
          .update('changdi-intake:verify-receipt-key:v1').digest('base64url');
        if (db.prepare('SELECT value FROM settings WHERE key = ?').get('receipt_key_check')?.value !== expected)
          stopWith(24);
      } finally { db.close(); }
    } catch { stopWith(22); }
  }
  return createIntakeServer({ dbPath, receiptKey, integrations, staff, merchants, tourism });
}

function staticSite() {
  const root = join(checkout, 'prototype-paper');
  const files = [
    'index.html', 'ops.html', 'pic-compare.html',
    'app.js', 'ops.js', 'ops.css', 'paper.css', 'styles.css',
    'data/points.js', 'data/parking-artifact.js', 'data/parking-runtime.js',
    'assets/map.jpg', 'assets/edge-paper.png', 'assets/edge-paper2.png',
    ...['qimingli', 'haiguan', 'museum', 'shuibutou', 'qilou', 'xinshi', 'xuding'].map(name => 'assets/card-' + name + '.jpg'),
    ...['crop', 'mount', 'stamp'].map(name => 'screenshots/h5/pic-' + name + '.png')
  ];
  const paths = new Map(files.map(file => ['/prototype-paper/' + file, file]));
  paths.set('/prototype-paper/', 'index.html');
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };

  return createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const file = paths.get(request.url.split('?')[0]);
    if (file) {
      try {
        const target = join(root, file);
        if (realpathSync(target) === target && lstatSync(target).nlink === 1) {
          const body = readFileSync(target);
          response.writeHead(200, {
            'Content-Type': contentTypes[extname(file)], 'Content-Length': body.length
          }).end(request.method === 'HEAD' ? undefined : body);
          return;
        }
      } catch { /* Missing or unreadable public asset. */ }
    }
    response.writeHead(404).end();
  });
}

async function bridge() {
  const { createBridge } = await import(pathToFileURL(join(checkout, 'changdi-intake/guide-bridge/server.js')));
  const token = process.env.GUIDE_INTAKE_TOKEN;
  const metricsToken = process.env.GUIDE_METRICS_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) stopWith(25);
  if (metricsToken && (!/^[A-Za-z0-9_-]{32,256}$/.test(metricsToken) || token === metricsToken)) stopWith(26);
  return createBridge({ upstream, token, metricsToken });
}

try {
  const server = await { backend: intake, static: staticSite, bridge }[service]();
  server.once('error', error => stopWith(error.code === 'EADDRINUSE' ? 27 : 28));
  server.listen(Number(port), '127.0.0.1');
} catch { stopWith(29); }
'@
    # 使用新文件原子替换，避免覆盖预先存在的硬链接目标。
    $temporary = Join-Path $Runtime ([Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $source)
        if ([IO.File]::Exists($HostScript)) { [IO.File]::Replace($temporary, $HostScript, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $HostScript) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Get-StartupFailure {
    param([int]$Code)
    $messages = @{
        21 = 'CHANGDI_RECEIPT_KEY 格式无效'
        22 = '演示库不可安全打开，已保留数据库及所有侧车'
        23 = '演示库版本不兼容，已保留数据库'
        24 = '演示库与 CHANGDI_RECEIPT_KEY 不匹配，已保留数据库'
        25 = 'GUIDE_INTAKE_TOKEN 格式无效'
        26 = 'GUIDE_METRICS_TOKEN 格式无效或与接单凭据相同'
        27 = '监听时发现端口被占用'
        28 = '回环监听失败'
        29 = '服务初始化失败，请检查 Node.js 版本及本地演示配置'
        31 = 'CHANGDI_INTEGRATIONS_JSON 必须为 JSON 数组'
        32 = 'CHANGDI_STAFF_JSON 必须为 JSON 数组'
        33 = 'CHANGDI_MERCHANTS_JSON 必须为 JSON 数组'
        34 = 'CHANGDI_TOURISM_JSON 必须为 JSON 对象'
    }
    if ($messages.ContainsKey($Code)) { return $messages[$Code] }
    return "服务退出（代码 $Code）"
}

function Show-Entries {
    param([int[]]$Ports)
    Write-Host '四个浏览器入口'
    Write-Host "  导览 H5       http://127.0.0.1:$($Ports[1])/prototype-paper/"
    Write-Host "  值班运营台    http://127.0.0.1:$($Ports[1])/prototype-paper/ops.html"
    Write-Host "  点位配图对比  http://127.0.0.1:$($Ports[1])/prototype-paper/pic-compare.html"
    Write-Host "  接诉闭环 H5   http://127.0.0.1:$($Ports[2])/"
    Write-Host "独立演示库 $Database"
}

function Start-Demo {
    param([int[]]$Ports)
    $status = Show-Status $Ports @()
    if ($status -ne 2) { throw [DemoFailure]::new('有端口被占用，请释放相应端口或指定三个可用端口。') }
    $credentials = Read-Credentials $CredentialsFile
    $node = Get-Command node.exe -CommandType Application | Select-Object -First 1
    [void][IO.Directory]::CreateDirectory($Runtime)
    Assert-LocalItem $Runtime
    Assert-LocalItem $HostScript
    Write-ServiceHost

    $started = New-Object 'System.Collections.Generic.List[object]'
    $records = @()
    $complete = $false
    try {
        for ($index = 0; $index -lt $Specs.Count; $index++) {
            $spec = $Specs[$index]
            $port = $Ports[$index]
            $arguments = ('--no-warnings "{0}" {1} {2} {3}' -f $HostScript, $spec.Name, $port, $Ports[0])
            $environment = @('SystemRoot=' + [Environment]::GetEnvironmentVariable('SystemRoot'))
            $keys = switch ($spec.Name) {
                'backend' { $BackendKeys }
                'bridge' { $BridgeKeys }
            }
            foreach ($key in $keys) {
                if ($credentials.ContainsKey($key)) { $environment += "$key=$($credentials[$key])" }
            }

            try {
                $process = [DemoProcess]::Start($node.Source, $arguments, $Runtime, $environment)
            } catch {
                throw [DemoFailure]::new("$($spec.Title) 无法启动 Node.js。")
            } finally {
                $environment = $null
            }
            $resource = @{ Process = $process; Record = $null }
            $started.Add($resource)
            $native = $process.Handle.DangerousGetHandle()
            $record = [pscustomobject]@{
                name = $spec.Name; pid = $process.Pid
                created = [DemoProcess]::Created($native); image = [DemoProcess]::Image($native)
            }
            $resource.Record = $record
            $records += $record
            Save-State $Ports $records

            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            do {
                if ([DemoProcess]::Exited($native)) { throw [DemoFailure]::new("$($spec.Title) 启动失败。$(Get-StartupFailure ([DemoProcess]::ExitCode($native)))。") }
                $result = Get-ServiceStatus $spec $port $record @(Get-Listeners)
                if ($result -like 'HTTP 200（*') { break }
                if ($result -like '监听冲突*') { throw [DemoFailure]::new("$($spec.Title) $port  $result") }
                Start-Sleep -Milliseconds 150
            } while ([DateTime]::UtcNow -lt $deadline)
            if ($result -notlike 'HTTP 200（*') { throw [DemoFailure]::new("$($spec.Title) $port 健康检查超时。$result") }
        }
        if ((Show-Status $Ports $records) -ne 0) { throw [DemoFailure]::new('启动完成前复查发现服务异常。') }
        Show-Entries $Ports
        $complete = $true
    } finally {
        if (-not $complete -and $started.Count) {
            $pending = @()
            $unknown = $false
            for ($index = $started.Count - 1; $index -ge 0; $index--) {
                $resource = $started[$index]
                try {
                    [DemoProcess]::Stop($resource.Process.Handle.DangerousGetHandle())
                } catch {
                    if ($resource.Record) { $pending += $resource.Record }
                    else { $unknown = $true }
                }
            }
            if ($pending.Count -or $unknown) {
                if ($pending.Count) { Save-State $Ports $pending }
                Write-Host '启动回滚未能确认全部子进程退出。' -ForegroundColor Red
            } else {
                [IO.File]::Delete($StatePath)
                Write-Host '已回滚本次启动的子进程。'
            }
        }
        foreach ($resource in $started) { $resource.Process.Handle.Dispose() }
    }
}

function Invoke-Demo {
    $directory = Get-Item -LiteralPath $ScriptsPath
    while ($directory) {
        Assert-LocalItem $directory.FullName
        $directory = $directory.Parent
    }
    Assert-LocalItem $Runtime
    Assert-LocalItem $StatePath
    $state = Read-State
    $ports = $RequestedPorts
    $records = @()
    if ($state) {
        $ports = @($state.ports)
        $records = @($state.services)
    }

    if ($Status) { return (Show-Status $ports $records) }
    if ($Stop) {
        $pending = @()
        for ($index = $records.Count - 1; $index -ge 0; $index--) {
            $record = $records[$index]
            if ((Get-RecordedProcess $record -Terminate) -eq 'stopped') {
                Write-Host "$($record.name) 已停止（PID $($record.pid)）"
            } else {
                $pending += $record
                Write-Host "$($record.name) 无法确认身份或退出（PID $($record.pid)）" -ForegroundColor Yellow
            }
        }
        if ($pending.Count) { Save-State $ports $pending; return 1 }
        if ($state) { [IO.File]::Delete($StatePath) }
        $listeners = @(Get-Listeners | Where-Object { $_.Port -in $ports })
        foreach ($listener in $listeners) {
            Write-Host "端口 $($listener.Port) 仍有监听（PID $($listener.ProcessId)）" -ForegroundColor Yellow
        }
        Write-Host '本检出登记的服务已停止。'
        return 0
    }
    if ($RequestedPorts.Count -ne @($RequestedPorts | Select-Object -Unique).Count) {
        throw [DemoFailure]::new('三个服务必须使用不同端口。')
    }
    $active = @($records | Where-Object { (Get-RecordedProcess $_) -ne 'stopped' })
    if ($active.Count) {
        $result = Show-Status $ports $records
        if ($result -ne 0) { throw [DemoFailure]::new('已有演示实例异常，请先运行答辩停止.ps1。') }
        if (($ports -join ',') -ne ($RequestedPorts -join ',') -and
            $explicitPorts) {
            throw [DemoFailure]::new('现有实例使用不同端口，请先运行答辩停止.ps1。')
        }
        Write-Host '沿用现有的健康实例。'
        Show-Entries $ports
        return 0
    }
    Start-Demo $RequestedPorts
    return 0
}

$explicitPorts = $PSBoundParameters.ContainsKey('BackendPort') -or $PSBoundParameters.ContainsKey('StaticPort') -or
    $PSBoundParameters.ContainsKey('BridgePort')
$sha = [Security.Cryptography.SHA256]::Create()
try { $scope = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($RepoRoot.ToUpperInvariant()))).Replace('-', '') }
finally { $sha.Dispose() }
$mutex = New-Object Threading.Mutex($false, "Global\ChangdiDemo-$scope")
$locked = $false
$exitCode = 1
try {
    try { $locked = $mutex.WaitOne([TimeSpan]::FromSeconds(60)) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw [DemoFailure]::new('等待本检出正在进行的启停操作超时。') }
    $exitCode = Invoke-Demo
} catch {
    # 仅输出本脚本定义的固定诊断。外部异常可能包含本机路径或配置原文。
    if ($_.Exception -is [DemoFailure]) {
        Write-Host $_.Exception.Message -ForegroundColor Red
    } else {
        Write-Host "启动器无法完成操作（$($_.Exception.GetType().Name)，行 $($_.InvocationInfo.ScriptLineNumber)）。请检查本机目录权限、Node.js 和端口状态。" -ForegroundColor Red
    }
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
exit $exitCode
