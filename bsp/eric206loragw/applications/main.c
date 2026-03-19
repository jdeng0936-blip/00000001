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

#include <dfs.h>
#include <dfs_fs.h>

#include "settings.h"

#include "mqtt_client.h"
#define DBG_ENABLE
#define DBG_SECTION_NAME    "mqtt.sample"
#define DBG_LEVEL           DBG_LOG
#define DBG_COLOR
#include <rtdbg.h>
#include <cjson.h>

#define	DISP_VER	"V1.0.1A"

#define MQTT_PUBTOPIC           "Server/ERIC0206"

#define LED0_PIN    GET_PIN(B, 1)
#define LED1_PIN    GET_PIN(B, 0)

#define TXEN_PIN    GET_PIN(C, 9)
#define RXEN_PIN    GET_PIN(A, 8)

#define LTE_PWR_PIN	GET_PIN(C, 8)

extern struct rt_memheap ccm_heap;

uint8_t * long_pkt_str = RT_NULL;

sensor_t sensor[40];
uint8_t sensor_online[40];
sensor_list_t sensor_normal[40];
sensor_list_t sensor_pre[40];
sensor_list_t sensor_warn[40];
sensor_list_t sensor_offline[40];

uint8_t long_idx = 0;

uint8_t sec_timer = 0;
extern uint8_t wave_buf[];

uint8_t beacon_idx = 0;

rt_timer_t protocol_timer;
extern volatile uint8_t ppp_network_status;
volatile uint8_t nodes_save_req = 0;
volatile uint8_t online_status_changed = 0;
static mqtt_client client;
int is_started = 0;
volatile uint8_t mqtt_sub_ava = 0;
volatile uint8_t mqtt_online = 0;
volatile uint8_t mqtt_logined = 0;
volatile uint8_t report_trigger = 0;
volatile uint8_t check_online_req = 0;
uint32_t udid[3];

uint8_t * mqtt_send_buf = RT_NULL;
uint8_t * mqtt_sub_buf = RT_NULL;

static int mqtt_start(void);
void mqtt_login(void);
void short_report(uint8_t idx);
void long_report(uint8_t idx);
void status_report(void);
extern void save_settings(void);

extern void send_beacon_msg(uint8_t index);
extern void send_getshort_msg(uint8_t index);
extern void send_getlong_msg(uint8_t index);
extern int ppp_sample_start(void);
extern int wiz_init(void);

void protocol_timer_callback(void *parameter)
{
	uint8_t is_beacon = 1;
	sec_timer++;
	if(sec_timer == 60)
	{
		sec_timer = 0;
		for(int i=0;i<settings.sensor_cnt;i++)
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
		check_online_req = 1;
	}
	for(int i=0;i<settings.sensor_cnt;i++)
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
			if((60 - sec_timer)>(48-long_idx))
				send_getlong_msg(i);
			else
			{
				rt_kprintf("no time for %d long pkt\r\n", sensor[i].target_id);
				is_beacon = 1;
				sensor[i].next_long = i + 1;
				sensor[i].long_req = 0;
				sensor[i].pending = 0;
			}
			break;
		}
	}
	if(is_beacon == 1)
	{
		send_beacon_msg(beacon_idx);
		beacon_idx++;
		if(beacon_idx == settings.sensor_cnt)
			beacon_idx = 0;
	}
}

int main(void)
{
	/* set LED0 pin mode to output */
	rt_pin_mode(LED0_PIN, PIN_MODE_OUTPUT);
	rt_pin_write(LED1_PIN, PIN_HIGH);
	rt_pin_mode(LED1_PIN, PIN_MODE_OUTPUT);
	
	rt_pin_write(LTE_PWR_PIN, PIN_LOW);
	rt_pin_mode(LTE_PWR_PIN, PIN_MODE_OUTPUT);
	
	rt_pin_write(TXEN_PIN, PIN_LOW);
	rt_pin_write(RXEN_PIN, PIN_LOW);
	rt_pin_mode(TXEN_PIN, PIN_MODE_OUTPUT);
	rt_pin_mode(RXEN_PIN, PIN_MODE_OUTPUT);
	
	struct timeval tv = { 0 };
	gettimeofday(&tv, RT_NULL);
	
	long_pkt_str = rt_memheap_alloc(&ccm_heap, 2048);
	
	if(dfs_mount("W25Q64", "/", "elm", 0, 0) != 0)
	{
		rt_kprintf("spi flash mount failed\n");
		if(dfs_mkfs("elm", "W25Q64") == 0)
		{
			rt_kprintf("spi flash formated\n");
			dfs_mount("W25Q64", "/", "elm", 0, 0);
		}
	}
	
	get_settings();
	
	protocol_timer = rt_timer_create("prot_t", protocol_timer_callback, RT_NULL, 1000, RT_TIMER_FLAG_PERIODIC | RT_TIMER_FLAG_SOFT_TIMER);
	rt_timer_start(protocol_timer);
	
	if(settings.use4g == 1)
	{
		rt_pin_write(LTE_PWR_PIN, PIN_HIGH);
		ppp_sample_start();
	}
	else
	{
		wiz_init();
	}

	while (1)
	{
		rt_thread_mdelay(100);
		if(ppp_network_status == 1)
		{
			rt_pin_write(LED1_PIN, PIN_HIGH);
			if(is_started == 0)
			{
				mqtt_start();
			}
			else
			{
				if(mqtt_online == 1)
				{
					if(mqtt_logined == 0)
					{
						mqtt_login();
						uint8_t login_try = 15;
						while(mqtt_logined == 0)
						{
							rt_thread_mdelay(1000);
							login_try--;
							if(login_try == 0)
								break;
						}
					}
					for(int i=0;i<settings.sensor_cnt;i++)
					{
						if(sensor[i].short_report == 1)
						{
							short_report(i);
							sensor[i].short_report = 0;
						}
						if(sensor[i].long_report == 1)
						{
							long_report(i);
							sensor[i].long_report = 0;
						}
					}
					if(check_online_req == 1)
					{
						check_online_req = 0;
						for(int i=0;i<settings.sensor_cnt;i++)
						{
							if(sensor_online[i] != sensor[i].online)
							{
								sensor_online[i] = sensor[i].online;
								online_status_changed = 1;
							}
						}
					}
					if(online_status_changed == 1)
					{
						online_status_changed = 0;
						status_report();
					}
				}
			}
		}
		else
		{
			rt_pin_write(LED1_PIN, PIN_LOW);
		}
		if(nodes_save_req == 1)
		{
			nodes_save_req = 0;
			save_settings();
			rt_thread_mdelay(1000);
			rt_hw_cpu_reset();
		}
	}
}

static void mqtt_sub_callback(mqtt_client *c, message_data *msg_data)
{
	*((char *)msg_data->message->payload + msg_data->message->payloadlen) = '\0';
	LOG_D("mqtt sub callback: %.*s %.*s",
						 msg_data->topic_name->lenstring.len,
						 msg_data->topic_name->lenstring.data,
						 msg_data->message->payloadlen,
						 (char *)msg_data->message->payload);
	cJSON * json = cJSON_ParseWithLength((char *)msg_data->message->payload, msg_data->message->payloadlen);
	cJSON * type = cJSON_GetObjectItem(json, "type");
	cJSON * resp_ts = cJSON_GetObjectItem(json, "ts");
	//cJSON * url = cJSON_GetObjectItem(json, "url");
	cJSON * payload = cJSON_GetObjectItem(json, "payload");
	if((type != NULL)&&(strstr(type->valuestring,"ack")))
	{
		cJSON * rep_type = cJSON_GetObjectItem(payload, "type");
		cJSON * rep_result = cJSON_GetObjectItem(payload, "result");
		if((rep_type != NULL)&&(strstr(rep_type->valuestring,"login")))
		{
			if((rep_result != NULL)&&(strstr(rep_result->valuestring,"success")))
			{
				mqtt_logined = 1;
			}
		}
	}
	else if((type != NULL)&&(strstr(type->valuestring,"nodelist")))
	{
		cJSON * short_set_obj = cJSON_GetObjectItem(payload, "short_set");
		cJSON * long_set_obj = cJSON_GetObjectItem(payload, "long_set");
		cJSON * has_router_obj = cJSON_GetObjectItem(payload, "has_router");
		cJSON * ch_obj = cJSON_GetObjectItem(payload, "ch");
		cJSON * nodes_obj = cJSON_GetObjectItem(payload, "nodes");
		cJSON * nodes_cnt = cJSON_GetObjectItem(payload, "cnt");
		settings.sensor_cnt = nodes_cnt->valueint;
		settings.short_set = short_set_obj->valueint;
		settings.long_set = long_set_obj->valueint;
		settings.userepeater = has_router_obj->valueint;
		settings.ch = ch_obj->valueint;
		for(int i=0;i<nodes_cnt->valueint;i++)
		{
			cJSON * node_obj = cJSON_GetArrayItem(nodes_obj, i);
			cJSON * index_obj = cJSON_GetObjectItem(node_obj, "index");
			cJSON * id_obj = cJSON_GetObjectItem(node_obj, "id");
			sensor[index_obj->valueint-1].target_id = id_obj->valueint;
		}
		nodes_save_req = 1;
	}
	if(resp_ts != NULL)
	{
		set_timestamp(resp_ts->valueint);
	}
	cJSON_Delete(json);
}

static void mqtt_sub_default_callback(mqtt_client *c, message_data *msg_data)
{
    *((char *)msg_data->message->payload + msg_data->message->payloadlen) = '\0';
		memcpy(mqtt_sub_buf, msg_data->message->payload, msg_data->message->payloadlen);
    LOG_D("mqtt sub default callback: %.*s %.*s",
               msg_data->topic_name->lenstring.len,
               msg_data->topic_name->lenstring.data,
               msg_data->message->payloadlen,
               (char *)msg_data->message->payload);
}


static void mqtt_connect_callback(mqtt_client *c)
{
    LOG_D("inter mqtt_connect_callback!");
}

static void mqtt_online_callback(mqtt_client *c)
{
    LOG_D("inter mqtt_online_callback!");
	mqtt_online = 1;
}

static void mqtt_offline_callback(mqtt_client *c)
{
    LOG_D("inter mqtt_offline_callback!");
	mqtt_online = 0;
}


static int mqtt_start(void)
{
    /* init condata param by using MQTTPacket_connectData_initializer */
    MQTTPacket_connectData condata = MQTTPacket_connectData_initializer;
    static char cid[32] = { 0 };
		static char uri[32] = { 0 };
		static char sub[64] = { 0 };

    if (is_started)
    {
        LOG_E("mqtt client is already connected.");
        return -1;
    }
    /* config MQTT context param */
    {
        client.isconnected = 0;
				sprintf(uri, "tcp://%s:%d",settings.server_addr, settings.server_port);
        client.uri = uri;

        /* generate the random client ID */
        //rt_snprintf(cid, sizeof(cid), "rtthread%d", rt_tick_get());
        /* config connect param */
        memcpy(&client.condata, &condata, sizeof(condata));
				udid[1] = HAL_GetUIDw1();
				udid[2] = HAL_GetUIDw2();
				sprintf(cid, "E206%08X%08X", udid[1], udid[2]);
			
        client.condata.clientID.cstring = cid;
//				client.condata.username.cstring = "admin";
//        client.condata.password.cstring = "123456";
				client.condata.username.cstring = "admin";
        client.condata.password.cstring = "hyc123456";
        client.condata.keepAliveInterval = 30;
        client.condata.cleansession = 1;

        /* config MQTT will param. */
        client.condata.willFlag = 0;
//        client.condata.will.qos = 1;
//        client.condata.will.retained = 0;
//        client.condata.will.topicName.cstring = MQTT_PUBTOPIC;
//        client.condata.will.message.cstring = MQTT_WILLMSG;

        /* malloc buffer. */
        client.buf_size = 8196;
				client.readbuf_size = 8196;
        client.buf = rt_memheap_alloc(&ccm_heap, client.buf_size);//rt_calloc(1, client.buf_size);
				//client.buf = rt_calloc(1, client.buf_size);
        client.readbuf = rt_calloc(1, client.readbuf_size);
        if (!(client.buf && client.readbuf))
        {
            LOG_E("no memory for MQTT client buffer!");
            return -1;
        }

        /* set event callback function */
        client.connect_callback = mqtt_connect_callback;
        client.online_callback = mqtt_online_callback;
        client.offline_callback = mqtt_offline_callback;

        /* set subscribe table and event callback */
				sprintf(sub, "/%s/sub", cid);
        client.message_handlers[0].topicFilter = rt_strdup(sub);
        client.message_handlers[0].callback = mqtt_sub_callback;
        client.message_handlers[0].qos = QOS1;

        /* set default subscribe event callback */
        client.default_message_handlers = mqtt_sub_default_callback;
    }
    
    {
      int value;
      uint16_t u16Value;
      value = 5;
      paho_mqtt_control(&client, MQTT_CTRL_SET_CONN_TIMEO, &value);
      value = 5;
      paho_mqtt_control(&client, MQTT_CTRL_SET_MSG_TIMEO, &value);
      value = 5;
      paho_mqtt_control(&client, MQTT_CTRL_SET_RECONN_INTERVAL, &value);
      value = 30;
      paho_mqtt_control(&client, MQTT_CTRL_SET_KEEPALIVE_INTERVAL, &value);
      u16Value = 3;
      paho_mqtt_control(&client, MQTT_CTRL_SET_KEEPALIVE_COUNT, &u16Value);
    }

    /* run mqtt client */
    paho_mqtt_start(&client, 8196, 20);
    is_started = 1;

    return 0;
}

void mqtt_login(void)
{
	char * cjson_str;
	char str[32];
	char ver_str[32];
	cJSON * packet = cJSON_CreateObject();
	udid[1] = HAL_GetUIDw1();
	udid[2] = HAL_GetUIDw2();
	sprintf(ver_str, "%s", DISP_VER);
	sprintf(str, "E206%08X%08X", udid[1], udid[2]);
	cJSON_AddStringToObject(packet, "cid", str);
	cJSON_AddStringToObject(packet, "type", "login");
	time_t ts = (time_t)0;
	get_timestamp(&ts);
	cJSON_AddNumberToObject(packet, "ts", ts);
	cJSON * payload = cJSON_CreateObject();
	cJSON_AddStringToObject(payload, "ver", ver_str);
	cJSON_AddItemToObject(packet, "payload", payload);
	cjson_str = cJSON_PrintUnformatted(packet);
	
	//rt_kprintf(cjson_str);
	
	//memcpy(mqtt_send_buf, cjson_str, strlen(cjson_str));
	//mqtt_send_buf[strlen(cjson_str)] = 0;
	paho_mqtt_publish(&client, QOS1, MQTT_PUBTOPIC, (char *)cjson_str, strlen((char *)cjson_str));
	cJSON_Delete(packet);
}

void short_report(uint8_t idx)
{
	char * cjson_str;
	char str[32];
	char ver_str[32];
	cJSON * packet = cJSON_CreateObject();
	udid[1] = HAL_GetUIDw1();
	udid[2] = HAL_GetUIDw2();
	sprintf(ver_str, "%s", DISP_VER);
	sprintf(str, "E206%08X%08X", udid[1], udid[2]);
	cJSON_AddStringToObject(packet, "cid", str);
	cJSON_AddStringToObject(packet, "type", "short_report");
	time_t ts = (time_t)0;
	get_timestamp(&ts);
	cJSON_AddNumberToObject(packet, "ts", ts);
	cJSON * payload = cJSON_CreateObject();
	cJSON_AddNumberToObject(payload, "id", sensor[idx].target_id);
	cJSON_AddNumberToObject(payload, "x_g_rms", sensor[idx].fx_g_rms);
	cJSON_AddNumberToObject(payload, "y_g_rms", sensor[idx].fy_g_rms);
	cJSON_AddNumberToObject(payload, "z_g_rms", sensor[idx].fz_g_rms);
	
	cJSON_AddNumberToObject(payload, "x_g_max", sensor[idx].fx_g_max);
	cJSON_AddNumberToObject(payload, "y_g_max", sensor[idx].fy_g_max);
	cJSON_AddNumberToObject(payload, "z_g_max", sensor[idx].fz_g_max);
	
	cJSON_AddNumberToObject(payload, "x_g_k", sensor[idx].fx_g_k);
	cJSON_AddNumberToObject(payload, "y_g_k", sensor[idx].fy_g_k);
	cJSON_AddNumberToObject(payload, "z_g_k", sensor[idx].fz_g_k);
	
	cJSON_AddNumberToObject(payload, "x_g_cf", sensor[idx].fx_g_cf);
	cJSON_AddNumberToObject(payload, "y_g_cf", sensor[idx].fy_g_cf);
	cJSON_AddNumberToObject(payload, "z_g_cf", sensor[idx].fz_g_cf);
	
	cJSON_AddNumberToObject(payload, "x_zs_rms", sensor[idx].fx_zs_rms);
	cJSON_AddNumberToObject(payload, "y_zs_rms", sensor[idx].fy_zs_rms);
	cJSON_AddNumberToObject(payload, "z_zs_rms", sensor[idx].fz_zs_rms);
	
	cJSON_AddNumberToObject(payload, "temp", sensor[idx].temp);
	cJSON_AddNumberToObject(payload, "bat", sensor[idx].bat);
	cJSON_AddNumberToObject(payload, "rssi", sensor[idx].rssi);
	cJSON_AddNumberToObject(payload, "error", sensor[idx].err);
	
	cJSON_AddItemToObject(packet, "payload", payload);
	cjson_str = cJSON_PrintUnformatted(packet);
	
	paho_mqtt_publish(&client, QOS1, MQTT_PUBTOPIC, (char *)cjson_str, strlen((char *)cjson_str));
	cJSON_Delete(packet);
}

void get_wave_buf(uint8_t * buf_out, uint8_t * buf_in, uint16_t size)
{
	uint8_t b;
	for(int j=0;j<size;j++)
	{
		b = buf_in[j]>>4;
		if(b<=9)
			buf_out[j*2] = '0'+ b;
		else
			buf_out[j*2] = 'a'+ b-10;
		b = buf_in[j]&0x0F;
		if(b<=9)
			buf_out[j*2+1] = '0'+ b;
		else
			buf_out[j*2+1] = 'a'+ b-10;
	}
	buf_out[size*2] = 0;
}

void long_report(uint8_t idx)
{
	char * cjson_str;
	char str[32];
	char ver_str[32];
	udid[1] = HAL_GetUIDw1();
	udid[2] = HAL_GetUIDw2();
	sprintf(ver_str, "%s", DISP_VER);
	sprintf(str, "E206%08X%08X", udid[1], udid[2]);
	time_t ts = (time_t)0;
	get_timestamp(&ts);
	for(int i=0;i<8;i++)
	{
		cJSON * packet = cJSON_CreateObject();
		cJSON_AddStringToObject(packet, "cid", str);
		cJSON_AddStringToObject(packet, "type", "long_report");
		cJSON_AddNumberToObject(packet, "ts", ts);
		cJSON * payload = cJSON_CreateObject();
		cJSON_AddNumberToObject(payload, "id", sensor[idx].target_id);
		cJSON_AddNumberToObject(payload, "pkt_idx", i);
		cJSON_AddNumberToObject(payload, "pkt_cnt", 8);
		cJSON_AddNumberToObject(payload, "pkt_len", 1536);
		
		get_wave_buf(long_pkt_str, &wave_buf[i*768], 768);
		
		cJSON_AddStringToObject(payload, "pkt_data", (const char *)long_pkt_str);
		cJSON_AddItemToObject(packet, "payload", payload);
		cjson_str = cJSON_PrintUnformatted(packet);
		paho_mqtt_publish(&client, QOS1, MQTT_PUBTOPIC, (char *)cjson_str, strlen((char *)cjson_str));
		cJSON_Delete(packet);
	}
}

void status_report(void)
{
	char * cjson_str;
	char str[32];
	char ver_str[32];
	cJSON * packet = cJSON_CreateObject();
	udid[1] = HAL_GetUIDw1();
	udid[2] = HAL_GetUIDw2();
	sprintf(ver_str, "%s", DISP_VER);
	sprintf(str, "E206%08X%08X", udid[1], udid[2]);
	cJSON_AddStringToObject(packet, "cid", str);
	cJSON_AddStringToObject(packet, "type", "nodelist");
	time_t ts = (time_t)0;
	get_timestamp(&ts);
	cJSON_AddNumberToObject(packet, "ts", ts);
	cJSON * payload = cJSON_CreateObject();
	
	cJSON_AddNumberToObject(payload, "short_set", settings.short_set);
	cJSON_AddNumberToObject(payload, "long_set", settings.long_set);
	cJSON_AddNumberToObject(payload, "has_router", settings.userepeater);
	cJSON_AddNumberToObject(payload, "ch", settings.ch);
	cJSON * nodes = cJSON_CreateArray();
	for(int i=0;i<settings.sensor_cnt;i++)
	{
		cJSON * node = cJSON_CreateObject();
		cJSON_AddNumberToObject(node, "index", i+1);
		cJSON_AddNumberToObject(node, "id", sensor[i].target_id);
		if(sensor[i].online == 1)
			cJSON_AddBoolToObject(node, "is_online",1);
		else
			cJSON_AddBoolToObject(node, "is_online",0);
		cJSON_AddItemToArray(nodes, node);
	}
	cJSON_AddItemToObject(payload, "nodes", nodes);
	cJSON_AddNumberToObject(payload, "cnt", settings.sensor_cnt);
	cJSON_AddItemToObject(packet, "payload", payload);
	cjson_str = cJSON_PrintUnformatted(packet);
	
	paho_mqtt_publish(&client, QOS1, MQTT_PUBTOPIC, (char *)cjson_str, strlen((char *)cjson_str));
	cJSON_Delete(packet);
}

#if defined(BSP_USING_SPI_FLASH)
#include "spi_flash.h"
#include "spi_flash_sfud.h"
#include "drv_spi.h"
static int rt_hw_spi_flash_init(void)
{
    __HAL_RCC_GPIOF_CLK_ENABLE();
    rt_hw_spi_device_attach("spi2", "spi20", GET_PIN(B, 12));

    if (RT_NULL == rt_sfud_flash_probe("W25Q64", "spi20"))
    {
        return -RT_ERROR;
    }

    return RT_EOK;
}
INIT_COMPONENT_EXPORT(rt_hw_spi_flash_init);
#endif
