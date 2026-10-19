# 发布指南

本包已准备好发布，但**发布动作需要你的凭据**（npm 登录 / GitHub 账号）。
下面是两条路线，任选其一（也可以都做）。

当前状态：

| 项 | 状态 |
|---|---|
| 包名 `dsh-image-annotate`（npm） | ✅ **可用**（未占用） |
| `private` 字段 | ✅ 已移除 |
| LICENSE | ✅ MIT |
| `files` 白名单 | ✅ 9 个文件，28.9 kB |
| `npm pack --dry-run` | ✅ 通过 |
| GitHub 仓库 | ✅ **已创建并推送** → https://github.com/ImpartialLucas/dsh-image-annotate |
| npm 登录 | ❌ **未登录** |
| GitHub 建仓权限 | ❌ 无 token、无 `gh`（但 SSH 推代码已认证为 `ImpartialLucas`） |

---

## 路线 A：发布到 npm（推荐，用户一条命令就能装）

### 第 1 步：你登录一次

在**你自己的终端**里跑：

```powershell
npm login
```

它会打开浏览器让你授权。成功后 token 存进 `~/.npmrc`，之后我就能替你发布。

### 第 2 步：我发布（或你自己跑）

```powershell
cd C:\Users\lenovo\Desktop\学科\_plugins\dsh-image-annotate
npm publish --access public
```

> 用的是**未 scoped** 的包名 `dsh-image-annotate`，所以 `--access public` 不是必需的，但写上无害。

### 第 3 步：验证

```powershell
npm view dsh-image-annotate version
dsh plugin --profile web add dsh-image-annotate
```

---

## 路线 B：发布到 GitHub（开源 + 可被插件市场收录）

DSH 插件市场（`dsh-plugin.org`）是按 **GitHub 仓库**收录的（`owner/repo` 格式），
所以想让插件出现在插件市场里，**必须**有 GitHub 仓库。

### 第 1 步：你建一个空仓库

打开 <https://github.com/new>，填：

- Repository name: **`dsh-image-annotate`**
- 可见性：Public
- **不要**勾选 README / .gitignore / license（保持空仓库）

### 第 2 步：我推送（或你自己跑）

```powershell
cd C:\Users\lenovo\Desktop\学科\_plugins\dsh-image-annotate
git remote add origin git@github.com:ImpartialLucas/dsh-image-annotate.git
git push -u origin main
```

> 本机 GitHub **HTTPS 被墙、SSH 可用**（已验证：`ssh -T git@github.com` → `Hi ImpartialLucas!`）。
> 所以必须用 `git@github.com:` 而不是 `https://`。

### 第 3 步（可选）：让插件市场收录

仓库建好后，到 <https://dsh-plugin.org/zh/submit> 提交，填 `ImpartialLucas/dsh-image-annotate`。

---

## 发布后需要补的元数据

仓库地址确定后，在 `package.json` 里补上（我可以代做）：

```json
"repository": { "type": "git", "url": "git+ssh://git@github.com/ImpartialLucas/dsh-image-annotate.git" },
"homepage": "https://github.com/ImpartialLucas/dsh-image-annotate#readme",
"bugs": { "url": "https://github.com/ImpartialLucas/dsh-image-annotate/issues" }
```

补完需要重新提交一次并（如果已发 npm）发个 patch 版本。

---

## 注意事项

1. **版本号**：当前 `0.7.1`（pre-1.0）。如果你认为功能已经稳定，可以先改成 `1.0.0` 再发首版 —— 首版就是 1.0.0 更干净。
2. **不要发布 `_work/` 与测试台**：`files` 白名单已经限制了打包内容，`C:\Users\lenovo\Desktop\AI_test\dsh-plugins\harness\` 根本不在包目录里，安全。
3. **`desktop` profile 用户无法用 CLI 安装**（Electron 独占保护），README 里已注明走 Plugin Hub。
4. 发布前最后检查：`npm pack --dry-run` 确认文件列表没有意外内容。

---

*本文件不随包发布（不在 `files` 白名单内）。*
