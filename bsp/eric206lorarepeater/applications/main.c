/*
 * Copyright (c) 2006-2021, RT-Thread Development Team
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Change Logs:
 * Date           Author       Notes
 * 2018-11-06     SummerGift   first version
 * 2023-12-03     Meco Man     support nano version
 */

#include <board.h>
#include <rtthread.h>
#include <drv_gpio.h>
#ifndef RT_USING_NANO
#include <rtdevice.h>
#endif /* RT_USING_NANO */

#include <string.h>

#include "settings.h"

#define	DISP_VER	"V1.0.1A"

#define MQTT_PUBTOPIC           "Server/ERIC0206"

#define LED0_PIN    GET_PIN(B, 1)
#define LED1_PIN    GET_PIN(B, 0)
#define TXEN_PIN    GET_PIN(C, 9)
#define RXEN_PIN    GET_PIN(A, 8)

extern struct rt_memheap ccm_heap;

uint8_t * long_pkt_str = RT_NULL;

sensor_t sensor[40];
uint8_t long_idx = 0;
uint8_t sensor_cnt = 1;

uint8_t sec_timer = 0;
extern uint8_t wave_buf[];

uint8_t beacon_idx = 0;

rt_timer_t protocol_timer;
extern volatile uint8_t ppp_network_status;
volatile uint8_t nodes_save_req = 0;
volatile uint8_t online_status_changed = 0;
int is_started = 0;
volatile uint8_t mqtt_sub_ava = 0;
volatile uint8_t mqtt_online = 0;
volatile uint8_t mqtt_logined = 0;
volatile uint8_t report_trigger = 0;
uint32_t udid[3];

volatile uint8_t save_settings_req = 0;

uint8_t * mqtt_send_buf = RT_NULL;
uint8_t * mqtt_sub_buf = RT_NULL;

static int mqtt_start(void);
void mqtt_login(void);
void short_report(uint8_t idx);
void long_report(uint8_t idx);
void status_report(void);

extern void settings_save(void);
extern void send_beacon_msg(uint8_t index);
extern void send_getshort_msg(uint8_t index);
extern void send_getlong_msg(uint8_t index);
extern int ppp_sample_start(void);
extern int lora_radio_tester_init(void);
void protocol_timer_callback(void *parameter)
{
	uint8_t is_beacon = 1;
	sec_timer++;
	if(sec_timer == 120)
	{
		sec_timer = 0;
		for(int i=0;i<sensor_cnt;i++)
		{
			sensor[i].next_short--;
			sensor[i].next_long--;
			sensor[i].short_req = 0;
			sensor[i].long_req = 0;
			if(sensor[i].pending == 1)
				sensor[i].online = 0;
			if(sensor[i].next_short == 0)
			{
				sensor[i].next_short = settings.short_set;
				sensor[i].short_req = 1;
				sensor[i].pending = 1;
			}
			if(sensor[i].next_long == 0)
			{
				sensor[i].next_long = settings.long_set;
				sensor[i].long_req = 1;
				sensor[i].pending = 1;
				long_idx = 0;
			}
		}
	}
	for(int i=0;i<sensor_cnt;i++)
	{
		if(sensor[i].short_req == 1)
		{
			is_beacon = 0;
			send_getshort_msg(i);
			break;
		}
		else if(sensor[i].long_req == 1)
		{
			is_beacon = 0;
			send_getlong_msg(i);
			break;
		}
	}
	if(is_beacon == 1)
	{
		send_beacon_msg(beacon_idx);
		beacon_idx++;
		if(beacon_idx == sensor_cnt)
			beacon_idx = 0;
	}
}

int main(void)
{
	/* set LED0 pin mode to output */
	rt_pin_mode(LED0_PIN, PIN_MODE_OUTPUT);
	rt_pin_mode(LED1_PIN, PIN_MODE_OUTPUT);
	
	rt_pin_write(TXEN_PIN, PIN_LOW);
	rt_pin_write(RXEN_PIN, PIN_LOW);
	rt_pin_mode(TXEN_PIN, PIN_MODE_OUTPUT);
	rt_pin_mode(RXEN_PIN, PIN_MODE_OUTPUT);
	
	long_pkt_str = rt_memheap_alloc(&ccm_heap, 2048);
	
	get_settings();
	
	lora_radio_tester_init();
	
	protocol_timer = rt_timer_create("prot_t", protocol_timer_callback, RT_NULL, 500, RT_TIMER_FLAG_PERIODIC | RT_TIMER_FLAG_SOFT_TIMER);
	//rt_timer_start(protocol_timer);

	while (1)
	{
		rt_thread_mdelay(1000);
		if(save_settings_req == 1)
		{
			save_settings_req = 0;
			settings_save();
			rt_thread_mdelay(1000);
			rt_hw_cpu_reset();
		}
	}
}

static int setch(int argc, char **argv)
{
	/* 参数无输入或者输入错误按照默认值处理 */
	if(argc == 2)
	{
		int ch = atoi(argv[1]);
		settings.ch = ch;
		settings_save();
	}
	
	rt_kprintf("current ch is %d\r\n", settings.ch);
	rt_thread_mdelay(1000);
	rt_hw_cpu_reset();
	return RT_EOK;
}

/* 导出到 msh 命令列表中 */
MSH_CMD_EXPORT(setch, set channel 0-31 );

