# Changelog

## 1.0.2 (2026-06-30)

### Fixed
- 输出添加 `regType` 字段，适配 `edgelink-pg-store` 直写 `register_type` 列
- `rawValue` 保留 PLC 原始 int16，`engValue` 使用解码值 × 斜率 + 偏移
- 4E 帧 `serialNo` 首帧不再跳号（先赋值再递增）
- 输出添加 `deviceId` 字段，适配 pg-store 动态分表

## 1.0.1 (2026-06-29)

### Added
- 14 个运行时 BUG 修复（锁重入、异步异常、serialNo 自增、批量超限、脏帧拦截等）
- `close` 处理器：节点关闭时释放全局锁
- `_destroyedByUs` 标志：区分主动关闭与异常断开

## 1.0.0 (2026-06-29)

### Initial Release
- 三菱 MC Protocol 3E/4E 以太网采集
- 表格编辑器：一个节点读写 N 个点位
- 6 种数据类型：INT16 / UINT16 / INT32 / UINT32 / FLOAT32 / BOOL
- 8 种软元件：D / W / R / X / Y / M / L / B
- 斜率偏移变换：`engValue = rawValue × slope + offset`
- 19 个 MC 错误码中文映射
- 全局模拟模式
- 零外部依赖（纯 Node.js `net` + `Buffer`）
