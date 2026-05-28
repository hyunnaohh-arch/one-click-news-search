# 一键全站搜索网页

## 功能
- 输入多个站点（新闻、公开招聘、政府公开信息等均可）
- 支持导入 `xlsx/xls`（首列为站点 URL）
- 输入关键词
- 选择时间范围（支持“最近 N 天”快捷填充）
- 支持设置“单站最大扫描页数”
- 点击搜索后，按站点进行域内全站扫描
- 搜索过程有 loading，且结果会边搜索边显示（流式返回）

## 运行方式
```bash
npm install
npm start
```

浏览器打开 `http://localhost:3000`

## 打包成 Windows exe（本地单机使用）

### 方式 A：在 Windows 电脑上打包（推荐）

1. 安装 [Node.js 18+](https://nodejs.org/)
2. 在项目目录打开命令行，执行：

```bash
npm install
npm run build:exe
```

或双击 `scripts/build-exe.bat`。

产物：`dist/one-click-news-search.exe`

### 方式 B：Mac 上通过 GitHub Actions 自动打包

Mac 无法直接交叉编译 Windows exe。把代码推到 **GitHub** 后，可在仓库 **Actions → Build Windows exe → Run workflow** 运行，完成后在 Artifacts 下载 exe。

**注意：** 美图 GitLab（`git.meitu.com`）和 GitHub（`github.com`）是两套 SSH，互不相通。

首次配置 GitHub SSH（账号 `wxy9`，邮箱 `wxy9@meitu.com`）：

```bash
# 1. 复制本机公钥（与美图 Git 同一把 key 即可）
cat ~/.ssh/id_ed25519.pub

# 2. 打开 https://github.com/settings/keys → New SSH key → 粘贴公钥

# 3. 验证（出现 Hi wxy9! 即成功）
ssh -T git@github.com

# 4. 推送到 GitHub（远程已配置为 wxy9/one-click-news-search）
git push -u github main
```

Push 成功后打开：https://github.com/wxy9/one-click-news-search/actions

### 使用 exe

**请解压整个发布包，保持目录结构：**

```
one-click-news-search.exe
public/
启动.bat
```

推荐双击 **`启动.bat`** 运行（若 exe 闪退，窗口会停留并提示查看日志）。

双击后会：

1. 在本机 `127.0.0.1:3000` 启动服务
2. 自动打开默认浏览器进入页面

若仍闪退，查看同目录下的 `one-click-news-search.log`。

说明：

- exe 体积约 50–80MB（内置 Node 运行时）
- 关闭命令行窗口即停止服务
- 首次运行若 Windows 防火墙提示，选择允许本地访问即可

## 使用说明
1. 在站点列表输入网站，或导入 Excel。
2. 输入关键词（如“福建”）。
3. 设定时间范围（如最近 7 天）与单站扫描页数。
4. 点击“搜索”，等待实时结果逐步出现。

## 注意事项
- 由于不同网站结构差异较大，部分站点可能抓取失败或无法提取发布时间。
- “全站搜索”为域内爬取方式，受站点反爬策略、链接结构、动态渲染页面影响。
- 当前版本会优先返回“包含关键词且日期在范围内”的页面；无法识别日期的页面将被过滤。
