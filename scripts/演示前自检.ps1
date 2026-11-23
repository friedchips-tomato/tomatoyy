#Requires -Version 5.1
<#
.SYNOPSIS
  演示前自检（只读体检）。
.DESCRIPTION
  一条命令跑完 7 类体检：运行环境、三套自动化测试、两套静态自检、关键材料齐全性、
  截图计数、三服务健康检查（区分归属）、凭据齐备性（只报存在与否）。

  端口来源优先级（旧的 3400 / 8931 / 8932 只是兜底默认值，不是要求）：
    1. -BackendPort / -StaticPort / -BridgePort 显式参数；
    2. scripts/.demo-local/processes.json 里 T16 启动器（scripts/答辩启动.ps1）登记的端口；
    3. 都没有时，兜底使用 3400 / 8931 / 8932，并在结论里说明。

  服务归属与身份核验（与 T16 启停脚本 答辩启动.ps1 -Status 同一套标准）：
    - 只有「登记 PID + 进程创建时间(FILETIME) + 完整映像路径」三项全部与登记记录一致，
      且该 PID 正在 127.0.0.1 上监听登记端口时，才认定为本检出的服务；
    - PID 被复用（创建时间对不上）、映像路径对不上、进程打不开、登记缺字段，
      一律判「异常」，并且不向该端口发任何请求；
    - netstat 枚举失败判「异常」（不再当成「服务都没跑」）；
    - 健康检查禁止跟随重定向：3xx 直接判异常，不跟随。
  启动器复核：另以子进程调用 答辩启动.ps1 -Status 复核，要求三个服务的结果都能解析、
  且子进程退出码与其三项结果一致；解析不全或结果异常时，不得把服务记为「可演示」。

  演示库：只报告 scripts/.demo-local/demo.sqlite（独立演示库）存在与否；
  库里有没有灌入种子工单不由此判断，需要演示工单请执行 scripts/seed-demo-cases.mjs。

  可选 -SelfTest：跑一遍身份核验逻辑自检（含伪造过期创建时间的状态记录）。

  凭据：只报告「已配置 / 缺失」和来源，不输出、不分析、不打印任何凭据内容；
  来源为当前进程环境变量，或本机凭据文件（-CredentialsFile，
  默认 scripts/.demo-local/credentials.json）。

  退出码：
    0 = 材料与测试全部通过（服务未运行时结论会明确写「现场未就绪」，不因此返回非零）；
    1 = 有材料缺失 / 测试失败 / 静态自检失败 / 服务异常（HTTP 非 200、3xx 重定向、
        未知监听、身份无法核实、已登记进程未监听、端口枚举失败、启动器复核不完整或不一致）。
  只报告、不修改任何业务文件 / 测试 / artifacts / 文档正文；仅写自己的结果文件。
#>

[CmdletBinding()]
param(
    [int]$BackendPort = 0,
    [int]$StaticPort = 0,
    [int]$BridgePort = 0,
    [string]$CredentialsFile = '',
    [string]$ReportPath = '',
    [switch]$SelfTest
)

$ErrorActionPreference = 'Continue'

# 统一按 UTF-8 处理，避免中文在子进程输出捕获与写文件时乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 用 $PSScriptRoot 推出仓库根（脚本位于 <仓库根>/scripts/）
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $RepoRoot 'scripts/.demo-local'
$StatePath = Join-Path $RuntimeDir 'processes.json'

$script:Report = New-Object System.Collections.Generic.List[string]
$script:FailCount = 0
$script:NotReadyCount = 0

function Emit([string]$text) {
    [void]$script:Report.Add($text)
    Write-Output $text
}
function Mark-Pass([string]$text) { Emit ("✓ " + $text) }
function Mark-Fail([string]$text) { $script:FailCount += 1; Emit ("✗ " + $text) }
function Mark-NotReady([string]$text) { $script:NotReadyCount += 1; Emit ("○ " + $text) }
function Mark-Skip([string]$text) { Emit ("○ " + $text) }

# =====================================================================
# 身份核验用的原生接口（与 T16 启停脚本同一套字段：PID + 创建时间 + 完整映像路径）
# =====================================================================
if (-not ('PrecheckProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class PrecheckProcess {

    [DllImport("kernel32.dll", SetLastError=true)]
    static extern SafeProcessHandle OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit,
                                       out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool QueryFullProcessImageName(IntPtr handle, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    // 返回 null 表示 PID 不存在；其它失败抛异常（调用方按「无法核实」处理）。
    public static SafeProcessHandle Open(int pid) {
        SafeProcessHandle handle = OpenProcess(0x101000u, false, pid);
        if (!handle.IsInvalid) return handle;
        int error = Marshal.GetLastWin32Error();
        handle.Dispose();
        if (error == 87) return null;
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
        return creation.ToString(CultureInfo.InvariantCulture);
    }

    public static string Image(IntPtr handle) {
        StringBuilder image = new StringBuilder(32768);
        int size = image.Capacity;
        if (!QueryFullProcessImageName(handle, 0, image, ref size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return image.ToString();
    }
}
'@
}

# 读取进程身份：状态为 running / gone / unverified（unverified = 打不开或读不到身份）。
function Get-ProcessIdentity {
    param([int]$ProcessId)
    $handle = $null
    try {
        $handle = [PrecheckProcess]::Open($ProcessId)
    } catch {
        return @{ Status = 'unverified'; Created = ''; Image = ''; Reason = '无法打开进程（权限或系统错误）' }
    }
    if ($null -eq $handle) {
        return @{ Status = 'gone'; Created = ''; Image = ''; Reason = '进程不存在' }
    }
    try {
        $native = $handle.DangerousGetHandle()
        if ([PrecheckProcess]::Exited($native)) {
            return @{ Status = 'gone'; Created = ''; Image = ''; Reason = '进程已退出' }
        }
        $created = [PrecheckProcess]::Created($native)
        $image = [PrecheckProcess]::Image($native)
        return @{ Status = 'running'; Created = $created; Image = $image; Reason = '' }
    } catch {
        return @{ Status = 'unverified'; Created = ''; Image = ''; Reason = '读取进程身份失败' }
    } finally {
        if ($null -ne $handle) { $handle.Dispose() }
    }
}

# 与登记记录逐项比对：创建时间（防 PID 复用）+ 完整映像路径（防冒名）。
function Test-RecordedIdentity {
    param([hashtable]$Record)
    $identity = Get-ProcessIdentity ([int]$Record.Pid)
    if ($identity.Status -ne 'running') {
        return @{ Verified = $false; Identity = $identity; Reason = $identity.Reason }
    }
    if (-not $Record.Created) {
        return @{ Verified = $false; Identity = $identity; Reason = '登记记录缺少创建时间，无法核实身份' }
    }
    if (-not $Record.Image) {
        return @{ Verified = $false; Identity = $identity; Reason = '登记记录缺少映像路径，无法核实身份' }
    }
    if ($identity.Created -cne $Record.Created) {
        return @{ Verified = $false; Identity = $identity; Reason = '创建时间与登记不一致（PID 可能已被复用）' }
    }
    if ($identity.Image -ne $Record.Image) {
        return @{ Verified = $false; Identity = $identity; Reason = '映像路径与登记不一致' }
    }
    return @{ Verified = $true; Identity = $identity; Reason = '' }
}

Emit ("演示前自检 · " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Emit ("仓库根：" + $RepoRoot)

# =====================================================================
# 0. T16 启动器登记的端口与进程归属
# =====================================================================
Emit ""
Emit "【0】启动器登记状态（端口与归属来源）"

$Specs = @(
    @{ Name = 'backend'; Title = '接诉即办后端'; Path = '/api/v1/public/parking/lots'; Port = $BackendPort; Default = 3400 },
    @{ Name = 'static';  Title = '原型静态站';   Path = '/prototype-paper/';           Port = $StaticPort;  Default = 8931 },
    @{ Name = 'bridge';  Title = '导览接入层';     Path = '/';                          Port = $BridgePort;  Default = 8932 }
)

# 读取 T16 启动器的进程登记文件（只读；读不到就当没有登记）
$StatePorts = @()
$StateRecords = @{}   # name -> @{ Pid; Created; Image }
$StateFound = $false
$StateNote = ''

function Normalize-Checkout([string]$path) {
    if (-not $path) { return '' }
    $text = $path
    if ($text.StartsWith('\\?\')) { $text = $text.Substring(4) }
    return $text.TrimEnd('\')
}

if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
    try {
        $stored = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($stored -isnot [pscustomobject]) { throw 'shape' }
        if ((Normalize-Checkout ([string]$stored.checkout)) -ine (Normalize-Checkout $RepoRoot)) {
            $StateNote = '登记文件不属于本检出'
        } else {
            $StateFound = $true
            foreach ($p in @($stored.ports)) {
                $value = 0
                if ([int]::TryParse([string]$p, [ref]$value) -and $value -gt 0) { $StatePorts += $value }
            }
            foreach ($record in @($stored.services)) {
                if ($record -isnot [pscustomobject]) { continue }
                $name = [string]$record.name
                if (-not $name) { continue }
                $pidValue = 0
                if (-not [int]::TryParse([string]$record.pid, [ref]$pidValue) -or $pidValue -le 0) { continue }
                $StateRecords[$name] = @{
                    Pid     = $pidValue
                    Created = [string]$record.created
                    Image   = [string]$record.image
                }
            }
        }
    } catch {
        $StateFound = $false
        $StateNote = '登记文件无法解析'
    }
}

if ($StateFound) {
    $recordText = if ($StateRecords.Count -gt 0) {
        (($StateRecords.Keys | Sort-Object | ForEach-Object {
            $r = $StateRecords[$_]
            $_ + '(PID ' + $r.Pid + '，创建时间已登记 ' + [bool]$r.Created + '，映像已登记 ' + [bool]$r.Image + ')'
        }) -join '；')
    } else { '（无进程记录）' }
    Emit ("启动器登记：" + $StatePath + "（本检出，登记端口 " + ($StatePorts -join ' / ') + "；" + $recordText + "）")
} elseif (Test-Path -LiteralPath $StatePath -PathType Leaf) {
    Emit ("启动器登记文件存在但" + $StateNote + "：" + $StatePath + "（不据此认定任何服务归属）")
} else {
    Emit ("未找到本检出的启动器登记文件：" + $StatePath + "（服务将按未知监听处理）")
}

# 逐个服务确定端口与来源
foreach ($spec in $Specs) {
    if ($spec.Port -gt 0) {
        $spec.Source = '命令行参数'
    } elseif ($StateFound -and $StatePorts.Count -eq 3) {
        $spec.Port = [int]$StatePorts[$Specs.IndexOf($spec)]
        $spec.Source = '启动器登记'
    } else {
        $spec.Port = $spec.Default
        $spec.Source = '兜底默认值'
    }
}

# =====================================================================
# 0.1 身份核验逻辑自检（-SelfTest）
#     重点覆盖：伪造过期创建时间的状态记录必须判为「无法核实」
# =====================================================================
if ($SelfTest) {
    Emit ""
    Emit "【0.1】身份核验自检"

    $self = Get-ProcessIdentity $PID
    if ($self.Status -ne 'running') {
        Mark-Fail "自检：无法读取本进程身份（" + $self.Reason + "）"
    } else {
        Mark-Pass ("自检：读取本进程身份正常（PID " + $PID + "，创建时间 " + $self.Created + "，映像 " + $self.Image + "）")

        $good = @{ Pid = $PID; Created = $self.Created; Image = $self.Image }
        $ok = Test-RecordedIdentity $good
        if ($ok.Verified) {
            Mark-Pass "自检：登记记录与实时进程完全一致时判定为已核实"
        } else {
            Mark-Fail ("自检：一致的登记记录未被认定为已核实（原因：" + $ok.Reason + "）")
        }

        # 伪造过期创建时间：PID 相同但创建时间对不上（等价于 PID 被复用）
        $forgedCreated = ([long]$self.Created - 100000000).ToString([Globalization.CultureInfo]::InvariantCulture)
        $forged = Test-RecordedIdentity @{ Pid = $PID; Created = $forgedCreated; Image = $self.Image }
        if (-not $forged.Verified -and $forged.Reason -like '*创建时间*') {
            Mark-Pass "自检：伪造过期创建时间的状态记录被拒绝（" + $forged.Reason + "）"
        } else {
            Mark-Fail ("自检：伪造过期创建时间的状态记录未被正确拒绝（Verified=" + $forged.Verified + "，原因：" + $forged.Reason + "）")
        }

        # 伪造映像路径
        $forgedImage = Test-RecordedIdentity @{ Pid = $PID; Created = $self.Created; Image = ($self.Image + '.bak') }
        if (-not $forgedImage.Verified -and $forgedImage.Reason -like '*映像路径*') {
            Mark-Pass "自检：伪造映像路径的状态记录被拒绝（" + $forgedImage.Reason + "）"
        } else {
            Mark-Fail ("自检：伪造映像路径的状态记录未被正确拒绝（原因：" + $forgedImage.Reason + "）")
        }

        # 缺字段
        $missing = Test-RecordedIdentity @{ Pid = $PID; Created = ''; Image = $self.Image }
        if (-not $missing.Verified) {
            Mark-Pass "自检：缺创建时间的登记记录被判为无法核实"
        } else {
            Mark-Fail "自检：缺创建时间的登记记录仍被认定为已核实"
        }

        # 不存在的 PID
        $absent = Get-ProcessIdentity 999999
        if ($absent.Status -eq 'gone') {
            Mark-Pass "自检：不存在的 PID 被正确识别为进程不存在"
        } else {
            Mark-Fail ("自检：不存在的 PID 状态异常（" + $absent.Status + " / " + $absent.Reason + "）")
        }
    }
}

# =====================================================================
# 1. 运行环境
# =====================================================================
Emit ""
Emit "【1】运行环境"

# node >= v22.17
$nodeVer = (& node --version 2>&1 | Out-String).Trim()
if ($nodeVer -match '^v?(\d+)\.(\d+)') {
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]
    if ($maj -gt 22 -or ($maj -eq 22 -and $min -ge 17)) {
        Mark-Pass ("node " + $nodeVer + "（≥ v22.17）")
    } else {
        Mark-Fail ("node " + $nodeVer + "（需要 ≥ v22.17）")
    }
} else {
    Mark-Fail ("node 不可用或版本无法识别：" + $nodeVer)
}

# python 可用（静态预览服务与截图索引核对都依赖它）
$pyOut = (& python --version 2>&1 | Out-String).Trim()
$pyCode = $LASTEXITCODE
if ($pyCode -eq 0 -and $pyOut) {
    Mark-Pass ("python 可用：" + $pyOut)
} else {
    Mark-Fail ("python 不可用（退出码 " + $pyCode + "）")
}

# python3 只作提示：可用与否都不算故障（现场一律用 python）
$py3Out = (& python3 --version 2>&1 | Out-String).Trim()
$py3Code = $LASTEXITCODE
if ($py3Code -eq 0) {
    Mark-Skip ("python3 可用（退出码 0）——不影响判定，现场脚本仍请写 python")
} else {
    Mark-Skip ("python3 不可用（退出码 " + $py3Code + "）——不影响判定，现场脚本请写 python")
}

# =====================================================================
# 2. 三套自动化测试
# =====================================================================
Emit ""
Emit "【2】三套自动化测试"

$testSuites = @(
    @{ Name = 'miniprogram';  Dir = (Join-Path $RepoRoot 'changdi-intake/miniprogram') },
    @{ Name = 'server';       Dir = (Join-Path $RepoRoot 'changdi-intake/server') },
    @{ Name = 'guide-bridge'; Dir = (Join-Path $RepoRoot 'changdi-intake/guide-bridge') }
)

foreach ($t in $testSuites) {
    if (-not (Test-Path -LiteralPath $t.Dir -PathType Container)) {
        Mark-Fail ($t.Name + "：目录不存在 " + $t.Dir)
        continue
    }
    Push-Location $t.Dir
    try {
        $out = & node --test 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }

    $testsN = 0; $passN = 0; $failN = 0; $haveSummary = $false
    if ($out -match '(?m)^# tests (\d+)')   { $testsN = [int]$Matches[1] }
    if ($out -match '(?m)^# pass (\d+)')    { $passN  = [int]$Matches[1] }
    if ($out -match '(?m)^# fail (\d+)')    { $failN  = [int]$Matches[1]; $haveSummary = $true }

    if (-not $haveSummary) {
        Mark-Fail ($t.Name + "：node --test 未产出汇总（退出码 " + $code + "）")
        continue
    }
    if ($failN -gt 0) {
        $failNames = @()
        $m = [regex]::Matches($out, '(?m)^not ok \d+ - (.+)$')
        foreach ($x in $m) {
            if ($failNames.Count -ge 10) { break }
            $failNames += (($x.Groups[1].Value) -replace '\s+#.*$', '').Trim()
        }
        $namesText = if ($failNames.Count -gt 0) { ($failNames -join '；') } else { '（未能从输出解析用例名）' }
        Mark-Fail ($t.Name + "：tests " + $testsN + " / pass " + $passN + " / fail " + $failN + "；失败用例（前 10 条）：" + $namesText)
    } else {
        Mark-Pass ($t.Name + "：tests " + $testsN + " / pass " + $passN + " / fail " + $failN)
    }
}

# =====================================================================
# 3. 两套静态自检
# =====================================================================
Emit ""
Emit "【3】两套静态自检"

$staticChecks = @(
    @{ Name = 'prototype-paper'; Script = (Join-Path $RepoRoot 'prototype-paper/check.mjs') },
    @{ Name = 'prototype';       Script = (Join-Path $RepoRoot 'prototype/check.mjs') }
)
foreach ($c in $staticChecks) {
    if (-not (Test-Path -LiteralPath $c.Script -PathType Leaf)) {
        Mark-Fail ($c.Name + "：自检脚本不存在 " + $c.Script)
        continue
    }
    Push-Location $RepoRoot
    try {
        $out = & node $c.Script 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    $has0err = ($out -match '0 个错误')
    $has0warn = ($out -match '0 个警告')
    if ($has0err -and $has0warn) {
        Mark-Pass ($c.Name + "：静态自检通过（0 个错误 / 0 个警告）")
    } else {
        $detail = ($out -replace '\s+', ' ').Trim()
        if ($detail.Length -gt 160) { $detail = $detail.Substring(0, 160) + '…' }
        Mark-Fail ($c.Name + "：输出未同时含「0 个错误」和「0 个警告」；实际输出：" + $detail)
    }
}

# =====================================================================
# 4. 关键材料是否齐全（存在性 + 非空）
# =====================================================================
Emit ""
Emit "【4】关键材料是否齐全"

function Check-File([string]$rel, [string]$desc) {
    $p = Join-Path $RepoRoot $rel
    if (Test-Path -LiteralPath $p -PathType Leaf) {
        $len = (Get-Item -LiteralPath $p).Length
        if ($len -gt 0) {
            Mark-Pass ($desc + "：" + $rel + "（" + $len + " 字节）")
        } else {
            Mark-Fail ($desc + "：" + $rel + " 存在但为空")
        }
    } else {
        Mark-Fail ($desc + "：" + $rel + " 缺失")
    }
}

$materials = @(
    @('docs/答辩环境清单.md', '环境清单'),
    @('docs/项目技术方案.md', '技术方案'),
    @('docs/数据字典-v0.1.md', '数据字典'),
    @('docs/停车产物核对-20261123.md', '停车产物核对'),
    @('docs/答辩素材-停车预测.md', '答辩素材·停车预测'),
    @('docs/测试基线-最新.md', '测试基线'),
    @('docs/答辩问答手册.md', '问答手册'),
    @('scripts/答辩启动.ps1', '启动脚本'),
    @('scripts/答辩停止.ps1', '停止脚本'),
    # T18 演示种子交付物已并入主线，与其它必备交付物同样判定：缺失或为空即算材料缺失
    @('scripts/seed-demo-cases.mjs', 'T18 演示种子脚本'),
    @('docs/演示数据说明.md', 'T18 演示种子说明'),
    @('prototype-paper/screenshots/index.json', '截图总索引（6 组）'),
    @('prototype-paper/screenshots/miniprogram/index.json', '小程序截图索引（6 页）'),
    @('prototype-paper/screenshots/ops/index.json', 'ops 截图索引'),
    @('prototype-paper/screenshots/parking/index.json', 'parking 截图索引'),
    @('prototype-paper/screenshots/h5/index.json', 'h5 截图索引')
)
foreach ($m in $materials) { Check-File $m[0] $m[1] }

# 演示库只报告存在与否：demo.sqlite 在，说明独立演示库在，不说明已灌入种子工单；
# 需要演示工单请执行 scripts/seed-demo-cases.mjs（种子脚本与说明已列入必备交付物）。
$seedRuntime = Join-Path $RepoRoot 'scripts/.demo-local/demo.sqlite'
if (Test-Path -LiteralPath $seedRuntime -PathType Leaf) {
    Mark-Skip ("演示库：scripts/.demo-local/demo.sqlite 存在（只说明独立演示库在，不代表已灌入种子工单；需要演示工单请执行 scripts/seed-demo-cases.mjs）")
} else {
    Mark-Skip "演示库：scripts/.demo-local/demo.sqlite 不存在（需要演示工单请执行 scripts/seed-demo-cases.mjs 现造）"
}

# 联动对照图目录（3 张，可能还不存在，如实报缺失）
$linkDir = Join-Path $RepoRoot 'prototype-paper/screenshots/link'
if (Test-Path -LiteralPath $linkDir -PathType Container) {
    $linkPngs = @(Get-ChildItem -LiteralPath $linkDir -Filter *.png -File)
    if ($linkPngs.Count -ge 3) {
        Mark-Pass ("联动对照图：prototype-paper/screenshots/link/ 有 " + $linkPngs.Count + " 张")
    } else {
        Mark-Fail ("联动对照图：prototype-paper/screenshots/link/ 只有 " + $linkPngs.Count + " 张（期望 3 张）")
    }
} else {
    Mark-Fail ("联动对照图：prototype-paper/screenshots/link/ 缺失（期望 3 张）")
}

# =====================================================================
# 5. 截图计数
# =====================================================================
Emit ""
Emit "【5】截图计数"

$protoDir = Join-Path $RepoRoot 'prototype/screenshots'
$paperDir = Join-Path $RepoRoot 'prototype-paper/screenshots'
$protoPngs = @(); $paperPngs = @()
if (Test-Path -LiteralPath $protoDir) { $protoPngs = @(Get-ChildItem -LiteralPath $protoDir -Recurse -Filter *.png -File) }
if (Test-Path -LiteralPath $paperDir) { $paperPngs = @(Get-ChildItem -LiteralPath $paperDir -Recurse -Filter *.png -File) }
$total = $protoPngs.Count + $paperPngs.Count
$all = @($protoPngs) + @($paperPngs)
$groupCount = @($all | Select-Object -ExpandProperty DirectoryName -Unique).Count

$rootPngs = @(Get-ChildItem -LiteralPath $paperDir -Filter *.png -File -ErrorAction SilentlyContinue)
$paperDetail = "根目录 " + $rootPngs.Count + " 张"
foreach ($sub in @('h5', 'intake', 'miniprogram', 'ops', 'parking')) {
    $sd = Join-Path $paperDir $sub
    $n = 0
    if (Test-Path -LiteralPath $sd) { $n = @(Get-ChildItem -LiteralPath $sd -Filter *.png -File).Count }
    $paperDetail += ("，" + $sub + " " + $n + " 张")
}

if ($total -gt 0) {
    Mark-Pass ("截图计数：合计 " + $total + " 张、" + $groupCount + " 组 —— prototype/screenshots " + $protoPngs.Count + " 张；prototype-paper/screenshots " + $paperPngs.Count + " 张（" + $paperDetail + "）")
} else {
    Mark-Fail ("截图计数：两个 screenshots 目录下未找到任何 PNG")
}

# =====================================================================
# 6. 三个服务健康检查（身份核验 + 归属；未运行算「现场未就绪」，异常算故障）
# =====================================================================
Emit ""
Emit "【6】服务健康检查"

$listenerError = ''

function Get-ListenerRows {
    $rows = & (Join-Path ([Environment]::SystemDirectory) 'netstat.exe') -ano
    if ($LASTEXITCODE -ne 0 -or -not $rows) { throw 'netstat 枚举失败' }
    $result = @()
    foreach ($row in $rows) {
        # TCP 监听行的远端地址为通配地址且端口为 0，与系统语言无关。
        if ($row -match '^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+\S+\s+(\d+)\s*$') {
            $result += [pscustomobject]@{ Address = $Matches[1]; Port = [int]$Matches[2]; ProcessId = [int]$Matches[3] }
        }
    }
    return $result
}

$listeners = @()
try {
    $listeners = @(Get-ListenerRows)
} catch {
    # netstat 枚举失败 ≠ 服务未运行：判异常，不进入「现场未就绪」这一档。
    $listenerError = '无法枚举 TCP 监听端口（netstat 执行失败），服务状态无法判定'
    Emit ("注意：" + $listenerError + "；三个服务一律判为异常，且不会向任何端口发请求。")
}

$specStatus = @{}   # name -> ready / stopped / anomaly

foreach ($spec in $Specs) {
    $label = $spec.Title + "（" + $spec.Port + "，" + $spec.Source + "）"
    $owners = @($listeners | Where-Object { $_.Port -eq $spec.Port })

    if ($listenerError) {
        $specStatus[$spec.Name] = 'anomaly'
        Mark-Fail ($label + " → 无法判定服务状态（端口枚举失败，未发起任何请求）")
        continue
    }

    $record = $null
    if ($StateRecords.ContainsKey($spec.Name)) { $record = $StateRecords[$spec.Name] }

    if ($null -eq $record) {
        if ($owners.Count -eq 0) {
            $specStatus[$spec.Name] = 'stopped'
            Mark-NotReady ($label + " → 未运行（现场未就绪，可先执行 scripts/答辩启动.ps1）")
        } else {
            $specStatus[$spec.Name] = 'anomaly'
            $pidText = ($owners | ForEach-Object { $_.ProcessId }) -join ', '
            Mark-Fail ($label + " → 端口被未登记进程监听（PID " + $pidText + "）：本检出没有该服务的启动器登记，不计入就绪")
        }
        continue
    }

    # 身份核验：PID + 创建时间 + 完整映像路径三项都要与登记记录一致
    $identity = Test-RecordedIdentity $record
    if ($identity.Identity.Status -eq 'gone') {
        if ($owners.Count -eq 0) {
            $specStatus[$spec.Name] = 'stopped'
            Mark-NotReady ($label + " → 未运行（登记的 PID " + $record.Pid + " 已不存在，现场未就绪）")
        } else {
            $specStatus[$spec.Name] = 'anomaly'
            $pidText = ($owners | ForEach-Object { $_.ProcessId }) -join ', '
            Mark-Fail ($label + " → 登记的 PID " + $record.Pid + " 已不存在，但端口仍被 PID " + $pidText + " 监听（端口冲突），不发起请求")
        }
        continue
    }
    if (-not $identity.Verified) {
        $specStatus[$spec.Name] = 'anomaly'
        Mark-Fail ($label + " → 身份无法核实（PID " + $record.Pid + "：" + $identity.Reason + "），判为异常，不发起请求")
        continue
    }

    # 身份已核实：现在才谈端口归属
    if ($owners.Count -eq 0) {
        $specStatus[$spec.Name] = 'anomaly'
        Mark-Fail ($label + " → 登记的进程 PID " + $record.Pid + " 仍在，但端口没有监听（服务异常）")
        continue
    }
    if ($owners.Count -gt 1) {
        $specStatus[$spec.Name] = 'anomaly'
        $pidText = ($owners | ForEach-Object { $_.ProcessId }) -join ', '
        Mark-Fail ($label + " → 端口上有多个监听（PID " + $pidText + "），判为异常，不发起请求")
        continue
    }
    if ($owners[0].ProcessId -ne $record.Pid) {
        $specStatus[$spec.Name] = 'anomaly'
        Mark-Fail ($label + " → 监听进程 PID " + $owners[0].ProcessId + " 与登记 PID " + $record.Pid + " 不一致（端口被其它进程占用），不发起请求")
        continue
    }
    if ($owners[0].Address -ne '127.0.0.1') {
        $specStatus[$spec.Name] = 'anomaly'
        Mark-Fail ($label + " → 监听地址不是 127.0.0.1（" + $owners[0].Address + "），判为异常，不发起请求")
        continue
    }

    # 归属与身份都核实通过才发请求；禁止跟随重定向（3xx 直接判异常）
    $url = "http://127.0.0.1:" + $spec.Port + $spec.Path
    try {
        $request = [System.Net.WebRequest]::Create($url)
        $request.Proxy = $null
        $request.Method = 'GET'
        $request.Timeout = 5000
        $request.ReadWriteTimeout = 5000
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        try {
            $httpCode = [int]$response.StatusCode
        } finally {
            $response.Close()
        }
        if ($httpCode -eq 200) {
            $specStatus[$spec.Name] = 'ready'
            Mark-Pass ($label + " → HTTP 200（PID " + $record.Pid + "，身份已核实）")
        } elseif ($httpCode -ge 300 -and $httpCode -lt 400) {
            $specStatus[$spec.Name] = 'anomaly'
            Mark-Fail ($label + " → HTTP " + $httpCode + "（重定向未跟随，期望 200，服务异常）")
        } else {
            $specStatus[$spec.Name] = 'anomaly'
            Mark-Fail ($label + " → HTTP " + $httpCode + "（期望 200，服务异常）")
        }
    } catch [System.Net.WebException] {
        $specStatus[$spec.Name] = 'anomaly'
        $errResp = $_.Exception.Response
        if ($errResp) {
            $code = [int]$errResp.StatusCode
            $errResp.Close()
            Mark-Fail ($label + " → HTTP " + $code + "（期望 200，服务异常）")
        } else {
            Mark-Fail ($label + " → 健康检查失败（服务异常）")
        }
    } catch {
        $specStatus[$spec.Name] = 'anomaly'
        Mark-Fail ($label + " → 健康检查失败（服务异常）")
    }
}

# =====================================================================
# 6b. 与 T16 启停脚本 答辩启动.ps1 -Status 复核（同一套身份核验，只读）
#     复核必须同时满足：三个服务的结果都能解析 + 子进程退出码与结果一致。
#     解析不全或结果异常时，不得把任何服务记为「可演示」。
# =====================================================================
$launcherPath = Join-Path $RepoRoot 'scripts/答辩启动.ps1'
$launcherComplete = $false
$launcherNote = ''

if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    $launcherNote = '未找到 scripts/答辩启动.ps1，无法复核'
} else {
    $launcherPorts = @()
    if ($StateFound -and $StatePorts.Count -eq 3) { $launcherPorts = @($StatePorts) }
    else { $launcherPorts = @($Specs | ForEach-Object { [int]$_.Default }) }
    $portsMatch = $true
    for ($i = 0; $i -lt $Specs.Count; $i++) {
        if ([int]$Specs[$i].Port -ne [int]$launcherPorts[$i]) { $portsMatch = $false }
    }
    if (-not $portsMatch) {
        $launcherNote = '本自检使用的端口与启动器登记端口不一致，无法复核'
    } else {
        $raw = ''
        $launcherCode = -1
        try {
            $hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
            $raw = & $hostExe -NoProfile -ExecutionPolicy Bypass -File $launcherPath -Status 2>&1 | Out-String
            $launcherCode = $LASTEXITCODE
        } catch {
            $raw = ''
            $launcherCode = -1
        }

        $launcherStatus = @{}
        foreach ($line in ($raw -split "`r?`n")) {
            foreach ($spec in $Specs) {
                if ($line -match ('^' + [regex]::Escape([string]$spec.Title) + '\s+\d+\s+(.+?)\s*$')) {
                    $launcherStatus[$spec.Name] = $Matches[1].Trim()
                }
            }
        }

        if ($launcherStatus.Count -ne $Specs.Count) {
            $launcherNote = "只解析到 " + $launcherStatus.Count + "/" + $Specs.Count + " 项服务结果（子进程退出码 " + $launcherCode + "）"
        } else {
            $launcherComplete = $true
            $launcherReady = 0
            $launcherStopped = 0
            foreach ($spec in $Specs) {
                $text = $launcherStatus[$spec.Name]
                $verdict = if ($text -like 'HTTP 200*') { 'ready' }
                           elseif ($text -eq '已停止') { 'stopped' }
                           else { 'anomaly' }
                if ($verdict -eq 'ready') { $launcherReady += 1 }
                if ($verdict -eq 'stopped') { $launcherStopped += 1 }
                $mine = $specStatus[$spec.Name]
                $suffix = "启动器 -Status 复核：" + $text
                if ($mine -eq $verdict) {
                    Emit ("　" + $suffix)
                } else {
                    Mark-Fail ($spec.Title + "（" + $spec.Port + "）→ " + $suffix + "；与本自检结论不一致（本自检：" + $mine + "），判为异常")
                    $specStatus[$spec.Name] = 'anomaly'
                }
            }
            # 子进程退出码：0 = 三个服务全就绪，2 = 三个服务全停止，1 = 其余情况
            $expectedCode = if ($launcherReady -eq $Specs.Count) { 0 }
                            elseif ($launcherStopped -eq $Specs.Count) { 2 }
                            else { 1 }
            if ($launcherCode -ne $expectedCode) {
                Mark-Fail ("启动器 -Status 子进程退出码 " + $launcherCode + " 与其三项结果不符（期望 " + $expectedCode + "），判为异常，不能记为可演示")
                foreach ($spec in $Specs) { $specStatus[$spec.Name] = 'anomaly' }
                $launcherNote = "子进程退出码 " + $launcherCode + " 与其三项结果不符（期望 " + $expectedCode + "）"
            }
        }
    }
}

if (-not $launcherComplete) {
    $readyOnes = @($Specs | Where-Object { $specStatus[$_.Name] -eq 'ready' })
    if ($readyOnes.Count -gt 0) {
        Mark-Fail ("启动器 -Status 复核不完整或异常（" + $launcherNote + "）：不能记为可演示")
        foreach ($spec in $readyOnes) { $specStatus[$spec.Name] = 'anomaly' }
    } else {
        Emit ("　启动器 -Status 复核：" + $launcherNote + "（当前没有服务被判为就绪，不影响「现场未就绪」结论）")
    }
}

# =====================================================================
# 7. 凭据齐备性（只报「已配置 / 缺失」和来源，绝不输出内容）
# =====================================================================
Emit ""
Emit "【7】凭据齐备性（只报配置存在与否，不输出内容）"

$requiredCreds = @(
    @('CHANGDI_RECEIPT_KEY', '接单回执签名密钥'),
    @('CHANGDI_INTEGRATIONS_JSON', '接单方目录'),
    @('GUIDE_INTAKE_TOKEN', '接入层接单令牌')
)
$optionalCreds = @(
    @('CHANGDI_STAFF_JSON', '工作人员目录'),
    @('CHANGDI_MERCHANTS_JSON', '商户目录'),
    @('CHANGDI_TOURISM_JSON', '旅游目录'),
    @('GUIDE_METRICS_TOKEN', '接入层导览行为令牌')
)

# 凭据来源：当前进程环境变量，或本机凭据文件
$credFile = ''
if ($CredentialsFile) {
    $credFile = $CredentialsFile
} elseif (Test-Path -LiteralPath (Join-Path $RuntimeDir 'credentials.json') -PathType Leaf) {
    $credFile = Join-Path $RuntimeDir 'credentials.json'
}

$fileCreds = @{}
$credFileUsable = $false
if ($credFile) {
    try {
        $config = Get-Content -LiteralPath $credFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($config -is [pscustomobject]) {
            foreach ($field in $config.PSObject.Properties) {
                if ($field.Value -is [string]) { $fileCreds[$field.Name] = $field.Value }
            }
            $credFileUsable = $true
        }
    } catch {
        $credFileUsable = $false
    }
    if ($credFileUsable) {
        Emit ("凭据文件：" + $credFile + "（可读，仅判断键是否存在）")
    } else {
        Emit ("凭据文件：" + $credFile + "（不可读或格式不对，按缺失处理）")
    }
} else {
    Emit "凭据文件：未提供（只看当前进程环境变量）"
}

function Report-Credential([string]$name, [string]$label, [bool]$required) {
    $envValue = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($envValue) {
        Mark-Pass ($label + "（" + $name + "）：已配置（来源：环境变量）")
        return
    }
    if ($fileCreds.ContainsKey($name)) {
        if ($fileCreds[$name]) {
            Mark-Pass ($label + "（" + $name + "）：已配置（来源：凭据文件）")
        } else {
            if ($required) { Mark-Fail ($label + "（" + $name + "）：已配置但为空（凭据文件）") }
            else { Mark-Skip ($label + "（" + $name + "）：未配置（凭据文件里为空，可选）") }
        }
        return
    }
    if ($required) { Mark-Fail ($label + "（" + $name + "）：未配置（环境变量与凭据文件都没有）") }
    else { Mark-Skip ($label + "（" + $name + "）：未配置（可选）") }
}

foreach ($c in $requiredCreds) { Report-Credential $c[0] $c[1] $true }
foreach ($c in $optionalCreds) { Report-Credential $c[0] $c[1] $false }

# =====================================================================
# 汇总结论 + 写结果文件
# =====================================================================
$dateStr = Get-Date -Format 'yyyy-MM-dd'
if ($ReportPath) {
    $outPath = $ReportPath
} else {
    $outPath = Join-Path $RepoRoot ("docs/演示前自检-" + $dateStr + ".txt")
}

Emit ""
if ($script:FailCount -gt 0) {
    Emit ("【结论】有 " + $script:FailCount + " 项待处理 —— 上面每条 ✗ 都写清楚了怎么处理。")
    $exitCode = 1
} elseif ($script:NotReadyCount -gt 0) {
    Emit ("【结论】材料与测试全部通过；现场未就绪 —— " + $script:NotReadyCount + " 个服务未运行，请先执行 scripts/答辩启动.ps1。")
    $exitCode = 0
} else {
    Emit "【结论】材料与测试全部通过，三服务均已就绪，可以演示。"
    $exitCode = 0
}

Emit ("结果文件：" + $outPath)

$content = ($script:Report -join [Environment]::NewLine) + [Environment]::NewLine
[System.IO.File]::WriteAllText($outPath, $content, (New-Object System.Text.UTF8Encoding($false)))

exit $exitCode
