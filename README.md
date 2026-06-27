# node-red-contrib-mitsubishi

三菱 MC Protocol 3E/4E 以太网采集节点，零依赖纯 TCP 实现。

## 截图


## 特性

- **独立可用** — 脱离任何后端，拖拽配置即可采集 PLC 数据
- **表格编辑器** — 一个节点读 N 个点位，自动聚类合并批量读取
- **6 种数据类型** — INT16 / UINT16 / INT32 / UINT32 / FLOAT32 / BOOL
- **8 种软元件** — D / W / R / X / Y / M / L / B，位元件自动逐位拆包
- **斜率偏移变换** — `engValue = rawValue × slope + offset`，节点直接输出最终值
- **错误诊断** — 19 个 MC 错误码映射为中文可读信息
- **模拟模式** — 全局 `mcSimulationMode=true` 不连 PLC 直接返回仿真数据
- **零依赖** — 仅使用 Node.js 内置 `net` + `Buffer`
- **14 个运行时 BUG 已修复** — 含锁重入、异步异常、serialNo 自增、批量超限等

## 支持的 PLC

| 系列 | 帧格式 | 状态 |
|------|--------|------|
| Q 系列（QnU / QnUDV） | 3E / 4E | ✅ |
| L 系列 | 3E / 4E | ✅ |
| iQ-R | 4E | ✅ |
| iQ-F（FX5U） | 4E | ✅ |
| FX3U + 以太网模块 | 3E | ✅ |
| A 系列 | 1E / 2E | ❌ |

## 安装

```bash
cd ~/.node-red
npm install node-red-contrib-mitsubishi
```

重启 Node-RED，左侧节点栏出现 **"三菱 PLC"** 分类。

## 使用方法

**1. 添加 PLC 连接配置**

拖入 `PLC 连接配置` 节点，填写 IP、端口、帧格式（3E/4E）、超时等参数。

**2. 配置点位表格**

拖入 `MC 读取` 节点，关联 PLC 配置，在表格中添加点位：

| 寄存器 | 地址 | 数据类型 | 斜率 | 偏移 | 名称 |
|--------|------|----------|------|------|------|
| D | 100 | INT16 | 0.1 | 0 | 温度 |
| D | 200 | FLOAT32 | 1 | 0 | 压力 |
| X | 0 | BOOL | - | - | 开关 |

**3. 触发采集**

inject 节点连到 MC 读取节点，部署后自动采集。

**动态点位**：上游节点传入 `msg.tags` 会覆盖表格配置，兼容 EdgeLink 采集管线。

## 输出格式

```javascript
msg.payload = {
  success: true,
  data: {
    "温度": { rawValue: 2530, engValue: 253.0, quality: 0, ts: "2026-..." },
    "压力": { rawValue: 4123, engValue: 41.23, quality: 0, ts: "2026-..." },
    "开关": { rawValue: 1,    engValue: 1,      quality: 0, ts: "2026-..." }
  },
  error: null,
  driverType: "driver-mc-protocol",
  plcIp: "192.168.1.10",
  plcPort: 5007,
  roundTimeMs: 12
}
```

## 与 node-red-contrib-mcprotocol 对比

| 维度 | 本节点 | mcprotocol |
|------|--------|------------|
| 点位数量 | **N 个 / 节点** | 1 个 / 节点 |
| 批量优化 | **智能聚类合并** | 逐地址独立请求 |
| 数据类型 | **6 种** (INT16/UINT16/INT32/UINT32/FLOAT32/BOOL) | 仅 INT16 |
| 位元件 | **自动拆包** | 不支持 |
| 斜率偏移变换 | **内置** (raw → eng) | 无 |
| 错误诊断 | **[PLC 0xC052] Address out of range** | "timeout" |
| serialNo | **每帧自增 + 回显校验** | 固定不变 |
| 模拟模式 | ✅ `mcSimulationMode=true` | ❌ |
| 连接稳定性 | 短连接, 无状态泄漏 | pool bug, 长期运行必断 |
| 运行时 BUG | **14 个全部修复** | issue 长期未维护 |

## 许可证

MIT · 可自由商用、修改、再发布
