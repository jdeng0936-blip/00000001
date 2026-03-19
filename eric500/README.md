# Eric500 产品固件

## 项目概览

| 属性 | 值 |
|------|-----|
| **产品名称** | Eric500 |
| **RTOS** | RT-Thread (统一共享源码) |
| **MCU 架构** | ARM Cortex-M4 (STM32) |
| **工具链** | Keil MDK / IAR / GCC |
| **代码结构** | 符号链接 → `~/Desktop/rt-thread` |

## 自定义 BSP 模块

| BSP 名称 | Gitee 仓库 | 功能说明 |
|----------|-----------|---------|
| **eric206lorasensormain** | `JhonyGuo/eric206lorasensormain` | LoRa 传感器主机, 智能睡眠省电 |
| **eric820calcnewcan** | `JhonyGuo/eric820calcnewcan` | CAN 计算板, 拓扑判断/电流检测 |
| **eric820dispnewcan** | `JhonyGuo/eric820dispnewcan` | CAN 显示板 (新协议) |
| **eric888calc** | `JhonyGuo/eric888calc` | Eric888 计算板 |
| **eric888display** | `JhonyGuo/eric888display` | Eric888 显示板 |
| **znotusteric820dispnewcan** | `JhonyGuo/eric820dispnewcan` | Eric820 显示板 (旧版本) |

## 各模块说明

### eric206lorasensormain — LoRa 传感器主机
- 无主机时接收后睡眠 15 分钟省电
- 有主机时根据广播时间信息智能睡眠
- 支持长短包模式，不同唤醒时长

### eric820calcnewcan — CAN 计算板
- CAN ID 判断拓扑结构末端节点
- 辅助电流判断, 新版 CAN 协议加速故障弹窗

## 开发指南

代码修改集中在各 BSP 目录下：
```
rt-thread/bsp/stm32/{BSP名}/
├── applications/    ← 应用层代码
├── board/           ← 硬件引脚配置
├── packages/        ← 软件包配置
└── project.uvprojx  ← Keil MDK 工程
```

### 构建 & 烧录
1. Keil MDK 打开对应 BSP 的 `project.uvprojx` → 编译 → J-Link 烧录
