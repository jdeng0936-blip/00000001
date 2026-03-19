# 嵌入式产品项目总览

> 最后更新: 2026-03-19

## 统一架构

所有项目共享一份 RT-Thread 源码 (`~/Desktop/rt-thread/`)，各产品通过**符号链接**引用：

```
Desktop/
├── rt-thread/                    ← 唯一的 RT-Thread 源码 (包含所有 9 个自定义 BSP)
├── S206/                         ← 产品视图 (IDE 中打开此文件夹)
│   └── rt-thread → ../rt-thread  ← 符号链接
└── eric500/                      ← 产品视图 (IDE 中打开此文件夹)
    └── rt-thread → ../rt-thread  ← 符号链接
```

## 全部自定义 BSP 模块 (9个)

| BSP | 所属产品 | Gitee 仓库 | 功能 |
|-----|---------|-----------|------|
| `eric206lorasensor` | S206 | `JhonyGuo/eric206lorasensor` | LoRa 传感器, RS485 |
| `eric206loragw` | S206 | `JhonyGuo/eric206loragw` | LoRa 网关 |
| `eric206lorarepeater` | S206 | `JhonyGuo/eric206lorarepeater` | LoRa 中继器 |
| `eric206lorasensormain` | Eric500 | `JhonyGuo/eric206lorasensormain` | LoRa 传感器主机 |
| `eric820calcnewcan` | Eric500 | `JhonyGuo/eric820calcnewcan` | CAN 计算板 |
| `eric820dispnewcan` | Eric500 | `JhonyGuo/eric820dispnewcan` | CAN 显示板 |
| `eric888calc` | Eric500 | `JhonyGuo/eric888calc` | 计算板 |
| `eric888display` | Eric500 | `JhonyGuo/eric888display` | 显示板 |
| `znotusteric820dispnewcan` | Eric500 | `JhonyGuo/eric820dispnewcan` | 显示板 (旧版) |

## IDE 使用

- 打开 `~/Desktop/S206/` → IDE 自动过滤，只显示 S206 相关的 3 个 BSP
- 打开 `~/Desktop/eric500/` → IDE 自动过滤，只显示 Eric500 相关的 6 个 BSP

每个 BSP 内部有独立的 `.git` 仓库，可以单独 push/pull 到 Gitee。
