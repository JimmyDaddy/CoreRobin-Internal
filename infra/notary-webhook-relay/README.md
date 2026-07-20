# Apple 公证 webhook relay

这个 Cloudflare Worker 接收 Apple `notarytool --webhook` 通知，并接收 Release workflow 在公开 Preview 创建成功后发送的 `preview_ready` 信号。它使用 Durable Object 按 stable tag 与源 GitHub Actions run 聚合这三个信号。只有两个架构都进入 Apple 终态且 Preview 已就绪后，relay 才向 `JimmyDaddy/CoreRobin-Internal` 发送一次 `apple-notarization-complete` repository dispatch。

Relay 不判断公证是否成功，也没有正式发布权限。`Finalize macOS release` 会重新验证源 workflow、Preview、原始资产状态文件和 Apple 实时结果。

## 首次部署

1. 登录 Cloudflare：

   ```bash
   pnpm relay:login
   ```

2. 部署 Worker 与 SQLite Durable Object：

   ```bash
   pnpm relay:deploy
   ```

3. 创建只选择 `CoreRobin-Internal`、仅授予 `Contents: write` 的 GitHub fine-grained token，并保存为 Worker secret：

   ```bash
   pnpm relay:secret:github
   ```

4. 生成至少 32 字符的随机 URL path secret，并保存为 Worker secret。不要把值写入文件或 shell history：

   ```bash
   openssl rand -hex 32 | pnpm relay:secret:path
   ```

5. 重新部署并验证公开健康检查：

   ```bash
   pnpm relay:deploy
   curl --fail https://corerobin-notary-webhook-relay.<workers-subdomain>.workers.dev/healthz
   ```

6. 将完整回调基础 URL 保存为 Internal repository Actions secret `APPLE_NOTARY_WEBHOOK_URL`：

   ```text
   https://corerobin-notary-webhook-relay.<workers-subdomain>.workers.dev/apple-notary/<WEBHOOK_PATH_SECRET>
   ```

Release workflow 会为 Apple 自动追加 `tag`、`run_id` 和 `arch` query 参数，并在 Preview 发布后使用同一地址发送带 `signal=preview_ready` 的内部通知。

当前生产 Worker 的公开基础地址是 `https://corerobin-notary-webhook-relay.heyjimmygo5163.workers.dev`。随机 secret path 不写入文档；以 GitHub 中的 `APPLE_NOTARY_WEBHOOK_URL` secret 为准。

## 安全约束

- `GITHUB_DISPATCH_TOKEN` 与 `WEBHOOK_PATH_SECRET` 只能存入 Cloudflare Secrets。
- 回调只接受 `POST`，最大请求体为 64 KiB，并严格验证 tag、run ID 与架构。
- Relay 以 tag/run ID 命名 Durable Object，串行聚合两个架构和 Preview 就绪信号，并用 `dispatching`/`dispatched` 状态抑制并发或重复回调。
- Durable Object 状态在 30 天后由 alarm 删除。
- `/healthz` 不读取或泄露任何 secret。
- 不要在该 URL 前启用 Cloudflare Access；Apple 无法完成交互登录。
