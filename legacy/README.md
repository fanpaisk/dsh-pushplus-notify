# Legacy（已弃用）

这里是最初的临时实现：

- `dsh-pushplus-notify.mjs`：直接复制到 profile 的单文件插件
- `install.ps1` / `uninstall.ps1`：手写 `cordis.patch.yml`
- `test-pushplus.mjs`：PushPlus 链路测试
- `config.json`：旧 token 配置
- `tests/`：旧单测

新实现是 `packages/plugin` 的标准 DSH Bundle，配置在
`%USERPROFILE%\.dsh\pushplus-notify.json`。不要同时启用旧版和新 bundle，
否则会重复推送。迁移时先运行旧版 `uninstall.ps1`，再安装 bundle。
