# DonCaution 的 Steam 6×6 评论工具（中文版本）

这是一个干净的中文预设版本：没有账号、好友、作品、评论历史、缓存或日志。

## 安装

1. 安装 [Node.js LTS](https://nodejs.org/)。
2. 在这个文件夹中打开 PowerShell。
3. 运行：

   ```powershell
   npm install
   npm run dashboard
   ```

4. 浏览器打开：<http://127.0.0.1:3000>

## 使用前设置

- 在 `comments.txt` 填入评论；多个评论之间用空行分隔。
- 在 `friends.txt` 每行加入一个 Steam 个人资料链接。
- 在 `artworks.txt` 每行加入一个 Steam 作品链接（可选）。

## 中国／V2RayN 网络设置

`config.json` 已默认配置为：

```json
"proxyUrl": "http://127.0.0.1:10808"
```

这适用于 V2RayN 的本地 Mixed 端口为 `10808` 的情况。请确认 V2RayN 已启动并且代理节点已连接；如果本地端口不同，请修改为实际端口。若不使用代理，请把它改成：

```json
"proxyUrl": ""
```

请仅对你有权使用的账号和目标使用本工具，并遵守 Steam 的规则、隐私设置和速率限制。
