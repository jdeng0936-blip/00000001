# S206 产品固件

## 项目概览

| 属性 | 值 |
|------|-----|
| **产品名称** | S206 |
| **RTOS** | RT-Thread (统一共享源码) |
| **MCU 架构** | ARM Cortex-M4 (STM32) |
| **工具链** | Keil MDK / IAR / GCC |
| **代码结构** | 符号链接 → `~/Desktop/rt-thread` |

## 自定义 BSP 模块

| BSP 名称 | Gitee 仓库 | 功能说明 |
|----------|-----------|---------|
| **eric206lorasensor** | `JhonyGuo/eric206lorasensor` | LoRa 传感器, RS485 协议 |
| **eric206loragw** | `JhonyGuo/eric206loragw` | LoRa 网关 |
| **eric206lorarepeater** | `JhonyGuo/eric206lorarepeater` | LoRa 中继器 |

## 开发指南

代码修改主要集中在 BSP 目录中：
```
rt-thread/bsp/stm32/{BSP名}/
├── applications/    ← 应用层代码 (主要修改)
├── board/           ← 硬件引脚/外设配置
├── packages/        ← RT-Thread 扩展包
└── project.uvprojx  ← Keil MDK 工程
```

### 构建 & 烧录
1. Keil MDK 打开 `project.uvprojx` → 编译 → J-Link 烧录
2. 执行校准步骤
