# NuroSSH

一个带 Web 终端、批量命令执行、代理管理的轻量控制台，现已支持 SQLite 单文件持久化，并提供 Docker / Docker Compose / install.sh 一键部署。

## 部署方式

### 1. 直接用 Docker Compose

1. 复制环境变量模板：
   - `cp .env.example .env`
2. 按需修改 `.env`：
   - `PORT`
   - `HOST`
   - `SQLITE_DB_PATH`
3. 启动服务：
   - `docker compose up -d --build`
4. 打开：
   - `http://<你的IP>:<PORT>/`

默认数据目录：
- `./data`

默认 SQLite 文件：
- `./data/app.db`

### 2. 用 install.sh 一键安装到服务器

适合想做成固定目录、后续通过管理脚本升级/备份/恢复的场景。

1. 直接执行：
   - `bash <(curl -fsSL https://raw.githubusercontent.com/inimemail/nurows/main/install.sh)`
2. 或者先上传项目后再执行：
   - `bash install.sh`
3. 按提示输入：
   - 安装路径
   - 对外端口
4. 脚本会自动：
   - 复制应用到 `/opt/nurossh` 或你指定的目录
   - 生成 `.env`
   - 启动 `docker compose`
   - 挂载数据目录

## 管理命令

安装完成后可使用：

- `bash install.sh install`
- `bash install.sh upgrade`
- `bash install.sh stop`
- `bash install.sh restart`
- `bash install.sh status`
- `bash install.sh logs`
- `bash install.sh backup`
- `bash install.sh restore`
- `bash install.sh uninstall`

如果已经安装到了目标目录，也可以用：

- `/opt/nurossh/manage.sh`

## 存储说明

当前后端默认使用 SQLite：

- 数据库文件：`data/app.db`
- 启动时会自动迁移旧数据：
  - `data/state.json`
  - `data/auth.json`
  - `data/secret.key`

迁移完成后，后续读写都走 SQLite。

## 安全策略

Docker 运行配置已经做了几项基础收敛：

- 容器内默认非 root 用户运行
- `cap_drop: ALL`
- `no-new-privileges:true`
- 数据单独挂载到 `./data`
- `/tmp` 使用 `tmpfs`

## 本地开发

1. 安装依赖：
   - `npm install`
2. 启动开发环境：
   - `npm run dev`

前端会走 Vite，后端入口是：
- `server/index.js`

## 构建

- `npm run build`
- `npm start`
