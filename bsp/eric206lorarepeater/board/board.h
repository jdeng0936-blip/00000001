/*
 * Copyright (c) 2006-2021, RT-Thread Development Team
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Change Logs:
 * Date           Author       Notes
 * 2018-11-5      SummerGift   first version
 */

#ifndef __BOARD_H__
#define __BOARD_H__

#include <stm32f4xx.h>

#ifdef __cplusplus
extern "C" {
#endif

#define STM32_FLASH_START_ADRESS     ((uint32_t)0x08000000)
#define STM32_FLASH_SIZE             (1024 * 1024)
#define STM32_FLASH_END_ADDRESS      ((uint32_t)(STM32_FLASH_START_ADRESS + STM32_FLASH_SIZE))

#define STM32_SRAM_SIZE           (128)
#define STM32_SRAM_END            (0x20000000 + STM32_SRAM_SIZE * 1024)

#if defined(__ARMCC_VERSION)
extern int Image$$RW_IRAM1$$ZI$$Limit;
#define HEAP_BEGIN      (&Image$$RW_IRAM1$$ZI$$Limit)
#elif __ICCARM__
#pragma section="CSTACK"
#define HEAP_BEGIN      (__segment_end("CSTACK"))
#else
extern int __bss_end;
#define HEAP_BEGIN      (&__bss_end)
#endif

#define HEAP_END        STM32_SRAM_END

void SystemClock_Config(void);

typedef struct{
	uint32_t target_id;
	float fx_g_rms;
	float fy_g_rms;
	float fz_g_rms;
	
	float fx_g_max;
	float fy_g_max;
	float fz_g_max;
	
	float fx_g_k;
	float fy_g_k;
	float fz_g_k;
	
	float fx_g_cf;
	float fy_g_cf;
	float fz_g_cf;
	
	float fx_zs_rms;
	float fy_zs_rms;
	float fz_zs_rms;
	
	float temp;
	int rssi;
	float bat;
	
	uint16_t next_short;
	uint16_t next_long;
	
	uint8_t online:1;
	uint8_t pending:1;
	uint8_t short_req:1;
	uint8_t long_req:1;
	uint8_t short_report:1;
	uint8_t long_report:1;
}sensor_t;

extern sensor_t sensor[40];
extern uint8_t sensor_cnt;

#ifdef __cplusplus
}
#endif

#endif

