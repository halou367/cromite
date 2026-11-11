#!/usr/bin/env bash
# 手动模式运行本地核心（保持终端开启；Ctrl+C 退出）
cd "$(dirname "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { echo "未检测到 Node.js，请先安装：https://nodejs.org/zh-cn/download"; exit 1; }
exec node brana-core.js "$@"
