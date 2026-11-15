# 声场 · Sound Atlas

将二层工作室的声环境放回真实空间：CAD 平面、可旋转三维模型、五张公桌与个人工位 D1 的声级、噪声热力图与采集管理。

**[打开网站](https://www.alecyin.icu/sound-atlas/)** · **[采集管理](https://www.alecyin.icu/sound-atlas/collect/)**

展示页面可公开访问。采集管理需要所有者的私有管理口令，口令不在此仓库中。

## 功能

- CAD 平面与等角三维空间；真实位置的墙体、门窗和家具。
- 六个声级测点、半小时等效声级、历史回放和变化曲线。
- 平面及三维热力图、右侧竖向图例，默认强度 75%。
- 明暗主题、随三维镜头旋转的指北针、移动端布局。
- 自动同步实测摘要；无数据及离线状态明确提示，演示数据需主动选择。
- 实时采集面板：六个测点的大字号最新 1 秒声级、近 5 分钟曲线、数据年龄和故障状态；页面与管理同步每 5 秒检查，设备约 30 秒批量上传。
- 数据管理按“筛选 → 曲线 → 处理”组织：精确选区、范围内记录统计、可用/原始 CSV 导出、异常定位与可撤销排除；未应用的新筛选不能用于修改或导出。
- 站内采集计划和备份后删除保留，永久删除单独收纳并二次核对。

## 设备对应

| 设备 | 公桌 | 图中位置 | 内部测点 ID |
| --- | --- | --- | --- |
| N1 | 公桌3 | 下方右侧 | C |
| N2 | 公桌2 | 下方中间 | B |
| N3 | 公桌1 | 下方左侧 | A |
| N4 | 公桌B | 上方右侧 | E |
| N5 | 公桌A | 上方左侧 | D |
| D1 | 个人工位 D1 | 公桌3右侧，东墙最南端，邻近右下休息区 | D1 |

原始平面上方为北。采集计划和数据时间使用北京时间（UTC+8）。

## 文件结构

```text
dist/                 展示站和 collect/ 管理页面
dist/assets/          CAD 平面、三维模型、材质、字体和 Three.js
api/                  Vercel 接口：实时摘要、管理登录和远程指令
lib/                  数据校验、Redis 存储、会话和指令队列
collector/            本机 Python 采集服务及出站同步
tests/                网站接口与交互逻辑测试
vercel.json           站点部署和安全响应头配置
```

## 本地预览

需要 Node.js 22+ 与 Python 3.10+。静态页面无打包步骤：

```sh
python -m http.server 8080 --directory dist
```

访问 `http://localhost:8080/`。静态预览可查看模型和主动切换演示数据；实时数据与采集管理依赖下面的服务端配置。

## 部署网站与接口

1. 将仓库导入自己的 Vercel 项目，根目录保持仓库根目录。`vercel.json` 已配置 `dist` 和 `api`。
2. 配置支持 REST API 的 Upstash Redis，添加以下私有环境变量（参见 `.env.example`）：

   | 名称 | 用途 |
   | --- | --- |
   | `KV_REST_API_URL` | Redis REST 地址 |
   | `KV_REST_API_TOKEN` | Redis REST 写入凭据 |
   | `SOUND_ATLAS_INGEST_TOKEN` | 采集端与云端共享的随机同步密钥 |
   | `SOUND_ATLAS_ADMIN_KEY_HASH` | 管理口令的 SHA-256 十六进制摘要 |

3. 为自己的实例创建随机同步密钥和独立管理口令。管理页面输入原始管理口令，服务端仅保存其摘要。不要复用本项目线上实例的密钥。
4. 新域名或反向代理部署时，核对 `lib/admin-auth.mjs` 的可信来源设置，并更新页面中指向原站点的链接。
5. 发布后访问 `/` 与 `/collect/`。现有线上实例挂载在 `/sound-atlas/` 下，资源和接口使用相对路径。

GitHub 仓库提供源代码；GitHub Pages 只能承载静态部分，不能单独运行采集管理和这些服务端接口。

## 启动本机采集端

```sh
cd collector
python receiver.py
```

本机界面为 `http://localhost:8000/`，采集计划在 `/control`，数据管理在 `/manage`。Windows 也可使用本目录内的启动、停止 PowerShell 脚本。

设备继续通过本机服务的 `/upload` 上传，使用 `/config` 与 `/time` 同步计划和时间。此仓库包含接收端，不包含硬件固件。

启用云端同步：复制 `live_bridge_config.example.json` 为 `live_bridge_config.json`，将 `enabled` 设为 `true`，填写自己的 `/api/ingest` 地址和与云端一致的同步密钥。此文件已被 Git 忽略。

原始数据保存在本机 SQLite；采集端主动向云端同步摘要并拉取经过认证的管理指令，不需要将本机端口公开到互联网。采集电脑需要持续运行并联网。

## 测试

```sh
npm test
cd collector
python -m unittest test_live_bridge test_receiver_integration test_remote_control
```

采集端测试使用临时数据库，不需要真实设备或线上凭据。

## 数据与模型说明

- 半小时等效声级按声能平均计算；热力图是测点插值估计，并非考虑墙体传播的声学仿真。
- 平面位置依据 CAD；模型墙高 3.2 米及门窗、家具的竖向尺寸为展示设定，未作为实测建筑尺寸。
- 不包含原始采集记录、数据库、备份、部署凭据或管理口令。实际运行数据不随源码发布。
- 字体、Three.js 和材质的来源及许可见各资源目录中的许可文件。本仓库公开可读，不额外授予未声明的资源许可。
