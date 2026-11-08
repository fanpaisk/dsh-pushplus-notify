# 卸载 DSH PushPlus 微信提醒插件
# 用法：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 [-Profile web] [-DshHome C:\Users\sk\.dsh]

param(
  [string]$Profile = 'web',
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'
if (-not $DshHome) {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$profileDir = Join-Path $DshHome (Join-Path 'profiles' $Profile)
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (-not (Test-Path -LiteralPath $patchPath)) {
  throw "找不到 profile 配置: $patchPath"
}

$startMarker = '# >>> dsh-pushplus-notify (managed by install.ps1) >>>'
$endMarker = '# <<< dsh-pushplus-notify (managed by install.ps1) <<<'
$current = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
$pattern = '(?ms)^' + [regex]::Escape($startMarker) + '.*?^' + [regex]::Escape($endMarker) + '\s*'
$updated = [regex]::Replace($current, $pattern, '')
# 删掉托管块后如果没有任何数组项，恢复成合法的空根 `[]`。
if (-not [regex]::IsMatch($updated, '(?m)^\s*-\s')) {
  $comments = ($updated -split "`r?`n" | Where-Object { $_ -match '^\s*#' }) -join "`r`n"
  $updated = if ($comments.Trim()) { $comments.TrimEnd() + "`r`n[]" } else { '[]' }
}
$updated = $updated.TrimEnd() + "`r`n"

if ($updated -ne $current) {
  $backup = "$patchPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item -LiteralPath $patchPath -Destination $backup -Force
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($patchPath, $updated, $utf8NoBom)
  Write-Host "已移除配置块，备份: $backup"
} else {
  Write-Host '配置里没有找到托管块，跳过。'
}

$pluginPath = Join-Path $profileDir 'pushplus-notify.mjs'
if (Test-Path -LiteralPath $pluginPath) {
  Remove-Item -LiteralPath $pluginPath -Force
  Write-Host "已删除: $pluginPath"
}

Write-Host '卸载完成。DSH 的 HMR 会自动卸载插件；若仍在提醒，重启 DSH。'
