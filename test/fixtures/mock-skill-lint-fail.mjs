#!/usr/bin/env node
/**
 * mock-skill-lint-fail.mjs —— 恒定失败的 linter 替身，用于验证「linter 未通过即回滚」这条路径。
 *
 * 接口契约与真 linter 一致：`node mock-skill-lint-fail.mjs <SKILL.md 路径>`，退出码恒为 1。
 */

process.stdout.write('FAIL R99 这是一个恒定失败的替身 linter，用于验证事务回滚\n');
process.exit(1);