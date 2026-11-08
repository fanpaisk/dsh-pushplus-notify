# DSH PushPlus 微信提醒插件
# 安装：在 PowerShell 中运行
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# 可选参数：
#   -Profile web                 安装到哪个 DSH profile（默认 web）
#   -Token <pushplus-token>      不传则读取同目录 config.json
#   -DshHome C:\Users\sk\.dsh    自定义 DSH_HOME
#   -NotifyPermission $false     关闭「权限请求」提醒
#   -PermissionCooldownSeconds 60
#   -CompleteCooldownSeconds 0
#
# 脚本会：
#   1. 把 dsh-pushplus-notify.mjs 复制到 profile 目录
#   2. 在 cordis.patch.yml 末尾追加（或替换）一个 pushplus-notify 条目
#   3. 备份原 cordis.patch.yml 为 cordis.patch.yml.bak-<时间>
# DSH 的 HMR 会热加载新插件，无需重启；若没生效再重启 DSH 一次。

param(
  [string]$Profile = 'web',
  [string]$Token = '',
  [string]$DshHome = '',
  [string]$Endpoint = 'https://www.pushplus.plus/send',
  [bool]$NotifyPermission = $true,
  [int]$PermissionCooldownSeconds = 60,
  [int]$CompleteCooldownSeconds = 0,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$sourcePlugin = Join-Path $here 'dsh-pushplus-notify.mjs'
$configPath = Join-Path $here 'config.json'

if (-not (Test-Path -LiteralPath $sourcePlugin)) {
  throw "找不到插件源文件: $sourcePlugin"
}

if (-not $DshHome) {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
if (-not (Test-Path -LiteralPath (Join-Path $profileDir 'package.json'))) {
  throw "找不到 DSH profile: $profileDir（先运行一次 dsh $Profile 初始化）"
}

# 从 config.json 读 token（保持与 Codex 通知工具相同的配置格式）
if (-not $Token -and (Test-Path -LiteralPath $configPath)) {
  try {
    $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($raw.wechat_notify -and $raw.wechat_notify.token) {
      $Token = [string]$raw.wechat_notify.token
    }
  } catch {
    Write-Warning "读取 config.json 失败，将继续使用 -Token 参数: $($_.Exception.Message)"
  }
}
if (-not $Token) {
  throw '未提供 PushPlus token：请用 -Token 参数传入，或在 config.json 的 wechat_notify.token 中填写'
}

$logFile = (Join-Path $here 'notify.log').Replace('\', '/')
if ($Token -match '"') {
  throw 'token 中不能包含双引号'
}
$escapeYaml = { param($value) ([string]$value).Replace('\', '/').Replace('"', '\"') }

$startMarker = '# >>> dsh-pushplus-notify (managed by install.ps1) >>>'
$endMarker = '# <<< dsh-pushplus-notify (managed by install.ps1) <<<'

$block = @"
$startMarker
- insert:
    - id: pushplus-notify
      name: "./pushplus-notify.mjs"
      config:
        enabled: true
        token: "$Token"
        endpoint: "$(& $escapeYaml $Endpoint)"
        template: "txt"
        timeoutMs: 10000
        maxAttempts: 2
        retryDelayMs: 1500
        fallbackEndpoint: "http://www.pushplus.plus/send"
        notifyOnStartup: true
        notifyOnComplete: true
        notifyOnError: true
        notifyOnAbort: true
        notifyOnBlocked: true
        notifyOnMaxTokens: true
        notifyOnPermission: $($NotifyPermission.ToString().ToLowerInvariant())
        notifyOnQuestion: true
        notifyOnSubagent: false
        includeSummary: true
        maxSummaryChars: 160
        completeCooldownSeconds: $CompleteCooldownSeconds
        permissionCooldownSeconds: $PermissionCooldownSeconds
        logFile: "$(& $escapeYaml $logFile)"
$endMarker
"@

$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$current = if (Test-Path -LiteralPath $patchPath) {
  Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
} else {
  ''
}

# 删除旧托管块（支持重复安装/修改配置）
$pattern = '(?ms)^' + [regex]::Escape($startMarker) + '.*?^' + [regex]::Escape($endMarker) + '\s*'
$updated = [regex]::Replace($current, $pattern, '')
# 刚初始化的 profile 用空数组 `[]` 作为根；直接追加会变成两个 YAML 文档。
$updated = [regex]::Replace($updated, '(?m)^\s*\[\s*\]\s*$', '')
$updated = $updated.TrimEnd()
if ($updated) {
  $updated += "`r`n`r`n"
}
$updated += $block.TrimEnd() + "`r`n"

Write-Host "DSH_HOME : $DshHome"
Write-Host "Profile  : $Profile ($profileDir)"
Write-Host "Token    : $($Token.Substring(0, [Math]::Min(4, $Token.Length)))****$($Token.Substring([Math]::Max(0, $Token.Length - 4)))"
Write-Host "日志     : $logFile"
Write-Host "权限提醒 : $NotifyPermission"

if ($DryRun) {
  Write-Host "`n--- cordis.patch.yml (DryRun) ---"
  Write-Host $updated
  exit 0
}

# 备份
if (Test-Path -LiteralPath $patchPath) {
  $backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $patchPath -Destination $backup -Force
  Write-Host "已备份   : $backup"
}

$targetPlugin = Join-Path $profileDir 'pushplus-notify.mjs'
Copy-Item -LiteralPath $sourcePlugin -Destination $targetPlugin -Force
Write-Host "已安装   : $targetPlugin"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($patchPath, $updated, $utf8NoBom)
Write-Host "已更新   : $patchPath"

Write-Host ''
Write-Host '完成。DSH 的 HMR 通常会自动加载；如果微信没收到提醒，重启 DSH 后再试。'
Write-Host '验证方式：'
Write-Host "  node `"$here\test-pushplus.mjs`""
Write-Host '然后随便让 DSH 完成一个任务，即可收到微信消息。'
