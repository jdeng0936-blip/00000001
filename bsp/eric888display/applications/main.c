/*
 * Copyright (c) 2006-2021, RT-Thread Development Team
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Change Logs:
 * Date           Author       Notes
 * 2018-12-18     zylx         first version
 */
#include "main.h"
#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>
#include <drv_ext_io.h>
#include <dfs.h>
#include <dfs_fs.h>
#include <lvgl.h>
#include <lcd_port.h>
#include <cjson.h>
#include <dfs_posix.h>
#include <sys/time.h>

#include <netdb.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <webclient.h>
#include <ctype.h>
#include <string.h>
#include "mqtt_client.h"
#include "at24cxx.h"
#define DBG_ENABLE
#define DBG_SECTION_NAME    "main.mqtt"
#define DBG_LEVEL           DBG_LOG
#define DBG_COLOR
#include <rtdbg.h>

#define MQTT_URI                "tcp://36.33.241.51:8820"	//24 21 F1 33
//#define MQTT_URI                "tcp://47.106.152.155:1883"
#define MQTT_SUBTOPIC           "/ERIC18202522144329/sub"
#define MQTT_PUBTOPIC           "Server/ERIC0820"
#define MQTT_WILLMSG            "Goodbye!"

static mqtt_client client;
static int is_started = 0;
extern SETTINGS settings;
volatile uint8_t disp_settings_update = 0;
volatile uint8_t save_settings_req = 0;
volatile uint8_t save_request_reset = 0;
volatile uint8_t settings_upload_req = 0;
volatile uint8_t gnd_error_wave_upload = 0;
volatile uint8_t voltage_error_wave_upload = 0;
volatile uint8_t gnd_error_wave_save = 0;
volatile uint8_t over_error_wave_save = 0;
volatile uint8_t drop_error_wave_save = 0;
volatile uint8_t pt_error_wave_save = 0;
volatile uint8_t short_error_wave_save = 0;
volatile uint8_t gnd_error_wave_load = 0;
volatile uint8_t over_error_wave_load = 0;
volatile uint8_t drop_error_wave_load = 0;
volatile uint8_t pt_error_wave_load = 0;
volatile uint8_t short_error_wave_load = 0;
extern volatile uint8_t ui_loaded;
volatile uint8_t login = 0;
volatile uint8_t mqtt_online = 0;
volatile uint8_t mqtt_sub_ava = 0;
volatile uint8_t mqtt_start_req = 0;
volatile uint8_t update_start = 0;
volatile uint8_t download_file = 0;
volatile uint8_t download_cancfg = 0;
extern CALC_STATUS calc_status;
extern int8_t error_wavebuf[];
extern volatile uint8_t error_wave_load;
volatile uint8_t client_node_load = 0;
extern uint16_t client_nodes_cnt;
extern volatile uint8_t time_sync_req;
volatile uint8_t ui_loaded = 0;
volatile uint8_t mqtt_stop_req = 0;
volatile uint8_t disp_node_page_cnt = 0;
volatile uint8_t disp_node_page_idx = 0;
extern volatile uint8_t disp_node_page_update;
extern volatile uint8_t disp_node_page_idx;
extern volatile uint8_t disp_node_page_cnt;
extern void set_settings(void);
extern volatile uint8_t client_online_changed;
extern volatile uint8_t save_ptct_req;
extern volatile uint8_t save_vset_req;
char update_url[256] = "http://47.106.152.155/rtthread";
at24cxx_device_t i2c_dev = RT_NULL;
extern int cmux_sample(void);
extern int wiz_init(void);
extern volatile uint8_t over_error_wave_load;
extern volatile uint8_t save_nodelist_req;
volatile uint8_t i2c_check_ok = 0;
//const struct dfs_mount_tbl mount_table[] = {
//	{"W25Q256","/","elm",0,0},
//	{0}
//};
uint32_t udid[3];
int main(void)
{
	udid[0] = HAL_GetUIDw0();
	udid[1] = HAL_GetUIDw1();
	udid[2] = HAL_GetUIDw2();
	
	i2c_dev = at24cxx_init("i2c1", 0);
	
	while(RT_EOK != at24cxx_check(i2c_dev))
		rt_thread_mdelay(100);
	
	i2c_check_ok = 1;
	
	if(dfs_mount("W25Q256", "/", "elm", 0, 0) != 0)
	{
		rt_kprintf("spi flash mount failed\n");
		if(dfs_mkfs("elm", "W25Q256") == 0)
		{
			rt_kprintf("spi flash formated\n");
			dfs_mount("W25Q256", "/", "elm", 0, 0);
		}
	}
		
	get_settings();
	if(settings.use4g == 0)
	{
		wiz_init();
	}
	
	disp_settings_update = 1;
	
	//make_settings_packet();
	
	//make_voltage_packet();
	
//	make_gnd_packet();
//	
//	
//	while(mqtt_online == 0)
//	{
//		rt_thread_mdelay(1000);
//	}
//	rt_thread_mdelay(2000);
//	make_settings_packet();
//	paho_mqtt_publish(&client, QOS1, MQTT_PUBTOPIC, (char *)mqtt_send_buf, strlen((char *)mqtt_send_buf));
//	
////	rt_thread_mdelay(2000);
////	make_voltage_packet();
////	paho_mqtt_publish(&client, QOS1, MQTT_PUBTOPIC, (char *)mqtt_send_buf, strlen((char *)mqtt_send_buf));
////	
////	rt_thread_mdelay(2000);
////	make_gnd_packet();
////	paho_mqtt_publish(&client, QOS1, MQTT_PUBTOPIC, (char *)mqtt_send_buf, strlen((char *)mqtt_send_buf));
	
	rt_thread_mdelay(4000);
	//cmux_sample();
	//error_wave_load = 1;
	over_error_wave_load = 1;
	client_node_load = 1;
	rt_thread_mdelay(1000);
	if(settings.use4g == 1)
	{
		ppp_sample_start();
	}
	
//	rt_list_t can_list = RT_LIST_OBJECT_INIT(can_list);
//	rt_list_init(&can_list);
//	cJSON* can_list_json_obj = cJSON_Parse(can_list_json);
//	cJSON * nodelist = cJSON_GetObjectItem(can_list_json_obj, "can_list");
//	int index = parse_child(nodelist, &can_list, index);
//	char * cjson_str = cJSON_Print(nodelist);
//	//write cancfg msg to flash file
//	print_tree(&can_list);
//	client_nodes_cnt = index;
//	disp_node_page_idx = 1;
//	disp_node_page_cnt = (client_nodes_cnt+7)/8;
//	disp_node_page_update = 1;
//	disp_settings_update = 1;
//	save_nodelist_req = 1;
	
	//mb_slave_sample();
	//mqtt_start();
	while (1)
	{
		rt_thread_mdelay(500);
	}
}

void ADC_GPIO_EXTI_Callback(void)
{
}
void SPI_GPIO_EXTI_Callback(void)
{
}
void RST_GPIO_EXTI_Callback(void)
{
}
