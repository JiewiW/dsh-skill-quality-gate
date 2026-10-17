#!/usr/bin/env pwsh
<#
.SYNOPSIS
    dsh-skill-quality-gate：编辑器保存 SKILL.md 后触发 skill-lint 的一键入口。
.DESCRIPTION
    退出码与 skill-lint.mjs 对齐：0 通过；1 存在缺口（stdout 逐条 FAIL 行）；2 用法/读文件错误。
      1) 手动：编辑器保存后执行本脚本 -Path <SKILL.md>
      2) 全量：-All 扫技能目录下所有 */SKILL.md，任一失败即整体非 0。
    linter 与本脚本的相对位置固定为 scripts\skill-lint.mjs（包内路径，不依赖 cwd）。
.PARAMETER Path
    单个 SKILL.md 的绝对路径。
.PARAMETER All
    扫描技能目录下所有 */SKILL.md 并逐个 lint。
.PARAMETER SkillsDir
    技能目录，默认 C:\Users\Administrator\.dsh\skills。
.PARAMETER Quiet
    只输出失败项与汇总行。
#>
[CmdletBinding()]
param(
    [string]$Path,
    [switch]$All,
    [string]$SkillsDir = 'C:\Users\Administrator\.dsh\skills',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$linterPath = Join-Path $PSScriptRoot 'scripts\skill-lint.mjs'

if (-not (Test-Path -LiteralPath $linterPath)) {
    [Console]::Error.WriteLine("skill-lint.mjs 不存在：$linterPath")
    exit 2
}

if (-not $All -and [string]::IsNullOrWhiteSpace($Path)) {
    [Console]::Error.WriteLine('用法：skill-lint-on-save.ps1 -Path <SKILL.md 绝对路径> | -All [-SkillsDir <目录>]')
    exit 2
}

if ($All) {
    if (-not (Test-Path -LiteralPath $SkillsDir)) {
        [Console]::Error.WriteLine("技能目录不存在：$SkillsDir")
        exit 2
    }
    $targets = @(Get-ChildItem -LiteralPath $SkillsDir -Recurse -File -Filter 'SKILL.md' |
        Select-Object -ExpandProperty FullName)
} else {
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($null -eq $resolved) {
        [Console]::Error.WriteLine("目标文件不存在：$Path")
        exit 2
    }
    $targets = @($resolved.Path)
}

$failed = 0
foreach ($target in $targets) {
    $output = & node $linterPath $target 2>&1
    $code = $LASTEXITCODE
    if ($code -eq 0) {
        if (-not $Quiet) { $output | ForEach-Object { Write-Output $_ } }
    } else {
        $failed++
        Write-Output "FAIL 文件：$target（退出码 $code）"
        $output | ForEach-Object { Write-Output "  $_" }
    }
}

if ($All) {
    Write-Output "扫描 $($targets.Count) 个 SKILL.md，未过检 $failed 个。"
}

exit $(if ($failed -gt 0) { 1 } else { 0 })