# Eric 嵌入式产品管理仓库

## 快速开始

```bash
git clone https://github.com/jdeng0936-blip/0000000.git
cd 0000000
chmod +x setup.sh
./setup.sh
```

setup.sh 会自动: clone RT-Thread → 部署 BSP → 创建产品视图

## 项目结构

| 目录 | 说明 |
|------|------|
| `bsp/` | 9 个自定义 BSP 模块 (核心代码) |
| `S206/` | S206 产品视图 (IDE 配置) |
| `eric500/` | Eric500 产品视图 (IDE 配置) |
| `setup.sh` | 一键环境搭建脚本 |

## BSP 模块清单

| BSP | 产品 | 功能 |
|-----|------|------|
| eric206lorasensor | S206 | LoRa 传感器, RS485 |
| eric206loragw | S206 | LoRa 网关 |
| eric206lorarepeater | S206 | LoRa 中继器 |
| eric206lorasensormain | Eric500 | LoRa 传感器主机 |
| eric820calcnewcan | Eric500 | CAN 计算板 |
| eric820dispnewcan | Eric500 | CAN 显示板 |
| eric888calc | Eric500 | 计算板 |
| eric888display | Eric500 | 显示板 |
| znotusteric820dispnewcan | Eric500 | 显示板(旧版) |
