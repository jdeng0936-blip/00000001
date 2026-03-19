#!/bin/bash
# ============================================================
# Eric 嵌入式项目 — 一键环境搭建脚本
# 用法: git clone https://github.com/jdeng0936-blip/0000000.git && cd 0000000 && ./setup.sh
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RT_THREAD_DIR="$SCRIPT_DIR/rt-thread"

echo "=========================================="
echo "  Eric 嵌入式项目环境搭建"
echo "=========================================="

# 1. Clone RT-Thread (如果不存在)
if [ ! -d "$RT_THREAD_DIR" ]; then
    echo ""
    echo "[1/3] 正在 clone RT-Thread 源码 (首次较慢)..."
    git clone --depth 1 https://github.com/RT-Thread/rt-thread.git "$RT_THREAD_DIR"
else
    echo "[1/3] RT-Thread 源码已存在,跳过 clone"
fi

# 2. 部署 BSP 模块
echo ""
echo "[2/3] 部署自定义 BSP 模块到 RT-Thread..."
BSP_SRC="$SCRIPT_DIR/bsp"
BSP_DST="$RT_THREAD_DIR/bsp/stm32"

for bsp_dir in "$BSP_SRC"/*/; do
    bsp_name=$(basename "$bsp_dir")
    dst="$BSP_DST/$bsp_name"
    if [ ! -d "$dst" ]; then
        echo "  部署 $bsp_name..."
        cp -r "$bsp_dir" "$dst"
    else
        echo "  $bsp_name 已存在,跳过"
    fi
done

# 3. 创建产品视图 (符号链接)
echo ""
echo "[3/3] 创建产品视图..."

for product in S206 eric500; do
    product_dir="$SCRIPT_DIR/$product"
    if [ -d "$product_dir" ] && [ ! -L "$product_dir/rt-thread" ]; then
        ln -sf "$RT_THREAD_DIR" "$product_dir/rt-thread"
        echo "  $product/rt-thread → rt-thread (符号链接)"
    elif [ -L "$product_dir/rt-thread" ]; then
        echo "  $product/rt-thread 符号链接已存在"
    fi
done

echo ""
echo "=========================================="
echo "  ✅ 环境搭建完成!"
echo ""
echo "  使用方式:"
echo "    打开 S206/    → 管理 S206 产品 (LoRa 传感器/网关/中继器)"
echo "    打开 eric500/ → 管理 Eric500 产品 (CAN/计算/显示板)"
echo "=========================================="
