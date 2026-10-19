> **English quick start**
>
> A DeepSeek Harness plugin that adds a *marquee request-changes* flow to the right sidebar:
> drag a rectangle over the file you are reading, attach a note to each region (✓ save / × discard),
> then send them all as ONE message. The message carries the file path, every region's coordinates,
> its extracted text, the notes, and a **host-side freeze-frame** of the screen captured the instant
> you armed the tool (before the overlay paints), so the agent can crop the exact pixels you saw.
>
> ```bash
> dsh plugin --profile web add dsh-image-annotate
> ```
>
> Requires DSH `0.2.1-rc.2+`. The `desktop` profile is Electron-managed: install it through the
> Plugin Hub UI, or via `runCli({ manageDesktopProfile: true })`.
>
> MIT licensed. Issues and PRs welcome.
>
# dsh-image-annotate

DSH 的「请求修改」插件：在**右侧栏**里框选内容、逐块写注释，一次性发进对话。

> 当前版本 **v0.7.1**　|　目标环境 DSH 0.2.1-rc.2（desktop profile）

---

## 一、它做什么

1. 点侧栏头部的 **「⌗ 请求修改」** 或右下角悬浮球 → 进入框选模式
2. **遮罩只覆盖右侧栏**（聊天区照常可点）
3. 拖出一个矩形 → 该框**旁边立刻**弹出它自己的注释框（✓ 保存 / × 丢弃）
4. 可继续框第 2、3…块，每块都有独立注释
5. 点底部 **「确认修改并发送」** → 所有框一次性作为**一条消息**发出

发出的消息包含：

- 侧栏当前打开的文件路径
- 窗口几何（`innerW×innerH`、`dpr`、`screenX/Y`、`outerW×outerH`、`chromeH`）
- 侧栏矩形与滚动量
- **每个框**：视口坐标 + **换算好的桌面截图坐标** + 注释 + 框内文字
- 若框内有 `<img>`：原图尺寸 + 在原图内的精确裁剪矩形

这样 Agent 可以先对桌面整屏截图，再按坐标裁出**用户看到的真实像素**。

---

## 二、安装

`desktop` profile 被 Electron 独占，`dsh plugin --profile desktop` 会被拒绝，必须走官方
`runCli({ manageDesktopProfile: true })` 通道（Desktop 应用自身用的就是它）：

```powershell
cd C:\Users\lenovo\Desktop\学科
node "C:/Users/lenovo/Desktop/AI_test/dsh-plugins/tools/add-desktop-plugin.mjs" plugin --profile desktop add "file:C:/Users/lenovo/Desktop/AI_test/dsh-plugins/build/dsh-image-annotate-0.7.1.tgz"
```

卸载：

```powershell
node "C:/Users/lenovo/Desktop/AI_test/dsh-plugins/tools/add-desktop-plugin.mjs" plugin --profile desktop remove dsh-image-annotate
```

**必须打包成 tarball 再装**，不要用 `file:<目录>`：目录安装会留下指向
`Desktop\学科\_plugins\` 的链接，中文路径 + 符号链接曾导致 client bundle 加载 500。

改完源码后的标准流程：

```powershell
cd C:\Users\lenovo\Desktop\学科\_plugins\dsh-image-annotate
node -e "..."                                   # 升版本号
rm -rf /c/Users/lenovo/Desktop/AI_test/dsh-plugins/build/dsh-image-annotate
cp -r . /c/Users/lenovo/Desktop/AI_test/dsh-plugins/build/dsh-image-annotate
cd /c/Users/lenovo/Desktop/AI_test/dsh-plugins/build/dsh-image-annotate && npm pack
cd C:\Users\lenovo\Desktop\学科
node "C:/Users/lenovo/Desktop/AI_test/dsh-plugins/tools/add-desktop-plugin.mjs" plugin --profile desktop remove dsh-image-annotate
node "C:/Users/lenovo/Desktop/AI_test/dsh-plugins/tools/add-desktop-plugin.mjs" plugin --profile desktop add "file:C:/Users/lenovo/Desktop/AI_test/dsh-plugins/build/dsh-image-annotate-<ver>.tgz"
```

然后 **Ctrl+Shift+R** 硬刷新。

---

## 三、结构

```
dsh-image-annotate/
├── package.json        # dsh.bundle.patch + dsh.client（inject 列表是关键）
├── cordis.patch.yml    # 一行 insert
├── index.js            # Host 半边（No-op，仅为让 bundle 行可解析）
├── client.js           # 全部 UI（约 1800 行，手写 CJS + ModuleLoader 包装）
├── icon.svg
└── locale/{zh,en}.json
```

注册面：

| 类型 | 位置 | 说明 |
|---|---|---|
| slot | `shell.overlay` | 框选遮罩层（**注入 `ctx`**） |
| slot | `conversation.session.header.utilities` | 侧栏「请求修改」按钮（注入 `sessionId` + `ctx`） |
| viewer | `dsh-image-annotate:image` | 图片拖框标注（`priority: 50`） |
| viewer | `dsh-image-annotate:pdf` | PDF → 渲染请求（浏览器无 pdf.js） |

---

## 四、踩过的 7 个坑（都是实测）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | client bundle 加载 **500** | 包名用 `file:<目录>` 安装 → 指向中文路径的链接 | 打包 tarball 安装 |
| 2 | 同上 | `exports["./client"]` 写成字符串 | 改 `{ "default": "./client.js" }` |
| 3 | 框选覆盖全屏 | 用 `shell.overlay` 铺满视口 | 按侧栏 `getBoundingClientRect()` 定位 |
| 4 | 找不到侧栏 | `[data-dsh-better-sidebar]` **只出现在 CSS 里**，DOM 上没有该属性 | 三级探测：属性 → `.cm-editor`/`[data-path]` 祖先 → 贴右边缘几何 |
| 5 | `无 ctx` | `shell.overlay` **不给组件传 ctx** | `slots.register({ inject: () => ({ ctx }) })` |
| 6 | `cannot get property "sessions" without inject` | Cordis 访问服务属性必须先声明 | `inject: ['slots','sessions','conversation']` |
| 7 | 会话 id 错 → `scope` 抛错 | `uiSession.adapter.current.getSnapshot()` 的 id 字段是 **`.key`** | 读 `.key`，并按 `localStorage['dsh.sessions.current']` → `sessions.list` 三级降级 |

> **教训**：Cordis 的 `inject` 不是可选项。凡是 `ctx.xxx` 形式访问的服务都必须列出来；
> `ctx.get('xxx')` 才是免声明读法。这一点卡了 5 轮。

---

## 五、本地测试台（不需要 DSH 也能测）

`C:\Users\lenovo\Desktop\AI_test\dsh-plugins\harness\` 是一套独立验证环境：

```
C:\Users\lenovo\Desktop\AI_test\dsh-plugins\harness\
├── index.html     # 假 DSH 页面：假侧栏 + 假服务 + mock ModuleLoader
├── client.js      # 插件副本（每次改完 source 覆盖过来）
└── node_modules\  # react@18 UMD
```

启动：

```powershell
cd C:\Users\lenovo\Desktop\AI_test\dsh-plugins\harness
python -m http.server 8877 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8877/index.html
```

它能验证：框选范围、拖框、注释弹窗位置、✓/×、Esc、多框、删除框、消息编排、`setDraft`/`submit` 调用。
**不能**验证：真实侧栏 DOM、真实会话服务、截图坐标 —— 那些只能在 DSH 里试。

---

## 六、已知限制

- **无法在浏览器内把 DOM 转成图片**（宿主没有 html2canvas，附件包也不提供截图 API）。
  所以"截图"由 Agent 侧完成：插件给坐标，Agent 用系统 API 截屏后裁剪。
- PDF 无法在页面上直接框选（无 pdf.js），走"先渲染成 PNG 再框"的路径。
- 截图坐标存在几个像素的不确定度（Windows 最大化窗口的不可见边框），必要时应留 2–4px 余量。


---

## 七、Agent 侧截图裁剪（**必须 DPI-aware**）

插件发出的「截图坐标」已经乘过 `dpr`，是给**DPI-aware 截屏**用的。实测踩坑：

| 现象 | 原因 |
|---|---|
| 截到的图只有左半边、看不到侧栏 | 截屏进程 **DPI-unaware**，Windows 只给 1600×1000（而实际屏幕是 3200×2000，200% 缩放） |
| 裁剪位置偏到聊天区 | 同上，坐标被缩放了 |

**正确做法**（PowerShell）：先声明 DPI 感知，再截屏：

```powershell
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@
[Dpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen   # 现在返回 3200x2000
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save('full.png', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
```

然后直接用插件给的「截图坐标」`Rectangle(x, y, w, h)` 裁剪即可，**不要再乘 dpr**（插件已经乘过）。

**实测校准结果**（2026-10-19，用户框 `_verify8.py`）：

```
视口 1600x952 CSS px, dpr 2, screenX=0, screenY=0, chromeH=0
框 1 截图坐标 x=2110, y=268, w=532, h=378  -> 裁剪结果与用户框选完全一致 ✅
框 2 截图坐标 x=2142, y=884, w=1002, h=510 -> 同上 ✅
```

图像保留了**语法高亮**，比文字提取（会带行号、丢空格、截断行）更有用。

> 注意：截图必须**在用户点发送后尽快执行** —— 用户可能切换文件或关闭侧栏，布局一变坐标就失效。

---

*最后更新：2026-10-19　v0.6.2*

---

## 八、冻结帧架构（v0.7.0+）

### 问题

早期实现只在**发送时刻**采坐标：用户框选过程中滚动文件、移动窗口，或者我等到消息到达才截屏，裁剪就会错位。

### 方案：宿主侧截屏

`index.js` 用 `ctx.webServer.register()` 挂一个本地路由：

```
POST /dsh-image-annotate/capture  ->  { ok, path, w, h, at }
```

客户端在**点「请求修改」的瞬间**（遮罩还没画出来）POST 一次，宿主用 **DPI-aware PowerShell** 抓整屏存 PNG。好处：

| 好处 | 说明 |
|---|---|
| 图片干净 | 截的是遮罩绘制之前，没有框线、没有蒙层 |
| 不受后续影响 | 之后滚动 / 换窗口 / 切文件都不影响这张冻结帧 |
| 坐标永远对得上 | 框是相对这张帧里的内容画的 |

消息里优先给这张图（路径 + 尺寸 + 时间）；宿主路由不可用时自动降级为「请我在收到消息时立刻 DPI-aware 截屏」。

### 框存的是「内容坐标」

`{cx, cy, w, h}`：`cx` 相对侧栏左边缘，`cy` 相对滚动内容原点。

- 渲染时用**当前**侧栏矩形 + **当前**滚动量派生视口坐标 → 滚动 / 移动窗口时框跟着走
- 发送时**重新解析**一次 → 裁剪坐标永远是发送那一刻的真实位置
- 另有 500ms 轮询 + `resize` / `scroll` 监听做同步

### 实测

- 宿主截屏脚本单独跑：`ok=true, 3200x2000, PNG 703KB` ✅
- 客户端降级路径：消息含「宿主截屏不可用」并给兜底说明 ✅

---

*最后更新：2026-10-19　v0.7.0*

## 从源码 / GitHub 安装

仓库已开源：**<https://github.com/ImpartialLucas/dsh-image-annotate>**

```powershell
# 方式一：npm（待发布后可用）
dsh plugin --profile web add dsh-image-annotate

# 方式二：直接从 GitHub 仓库
git clone git@github.com:ImpartialLucas/dsh-image-annotate.git
cd dsh-image-annotate
npm pack
dsh plugin --profile web add "file:<绝对路径>/dsh-image-annotate-0.7.1.tgz"
```

> `desktop` profile 被 Electron 独占，CLI 会拒绝；请走插件市场 UI，
> 或用 `runCli({ manageDesktopProfile: true })` 通道（本仓库根目录的 `_work/add-desktop-plugin.mjs` 就是那个三行脚本）。

