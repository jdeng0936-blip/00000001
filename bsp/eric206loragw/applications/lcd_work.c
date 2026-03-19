#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>
#include <drv_gpio.h>
#include <stdio.h>
#include <string.h>
#include <cjson.h>

#include "settings.h"

#define MISC_THREAD_STACK_SIZE 8192
#define MISC_THREAD_PRIO 29
static rt_uint8_t misc_thread_stack[MISC_THREAD_STACK_SIZE];
static struct rt_thread misc_thread;

#define PAGE_TYPE_LIST			0x00
#define PAGE_TYPE_NORMAL		0x01
#define PAGE_TYPE_PRE				0x02
#define PAGE_TYPE_WARN			0x03
#define PAGE_TYPE_OFFLINE		0x04


struct rt_semaphore rx_sem;
rt_device_t serial;

uint8_t settings_str_buf[128];
uint8_t settings_str_idx = 0;

uint8_t nromal_cnt = 0;
uint8_t pre_cnt = 0;
uint8_t warn_cnt = 0;
uint8_t offline_cnt = 0;

uint8_t cur_cnt = 0;

uint8_t uart_rx_buf[64] = {0};
volatile uint16_t uart_rx_buf_w_idx = 0;
volatile uint16_t uart_rx_buf_r_idx = 0;

uint8_t uart_tx_buf[32] = {0};
uint8_t page_idx = 0;
uint8_t page_cnt = 0;
uint8_t time_min_last = 99;
extern volatile uint8_t nodes_save_req;

uint8_t page_type = PAGE_TYPE_LIST;

int isVaildIp(const char *ip)
{
    int dots = 0;
    int setions = 0;

    if (NULL == ip || *ip == '.') {
        return 0;
    }

    while (*ip) {

        if (*ip == '.') {
            dots ++;
            if (setions >= 0 && setions <= 255) {
                setions = 0;
                ip++;
                continue;
            }
            return 0;
        }
        else if (*ip >= '0' && *ip <= '9') {
            setions = setions * 10 + (*ip - '0');
        } else
            return 0;
        ip++;
    }
    if (setions >= 0 && setions <= 255) {
        if (dots == 3) {
            return 1;
        }
    }

    return 0;
}

rt_err_t uart_input(rt_device_t dev, rt_size_t size)
{
	for(int i=0;i<size;i++)
	{
		rt_device_read(serial, 0, &uart_rx_buf[uart_rx_buf_w_idx], 1);
		uart_rx_buf_w_idx++;
		if(uart_rx_buf_w_idx == 64)
			uart_rx_buf_w_idx = 0;
	}
	rt_sem_release(&rx_sem);
	return RT_EOK;
}
void lcd_set_cmd(const char * obj)
{
	char str[64] = {0};
	sprintf(str, "%s\xFF\xFF\xFF", obj);
	rt_device_write(serial, 0, str, strlen(str));
}
void lcd_set_val_with_number(const char * obj, int val)
{
	char str[64] = {0};
	sprintf(str, "%s.val=%d\xFF\xFF\xFF", obj, val);
	rt_device_write(serial, 0, str, strlen(str));
}
void lcd_set_txt_with_number(const char * obj, int val)
{
	char str[64] = {0};
	sprintf(str, "%s.txt=\"%d\"\xFF\xFF\xFF", obj, val);
	rt_device_write(serial, 0, str, strlen(str));
}
void lcd_set_txt_with_float(const char * obj, float val)
{
	char str[64] = {0};
	sprintf(str, "%s.txt=\"%.3f\"\xFF\xFF\xFF", obj, val);
	rt_device_write(serial, 0, str, strlen(str));
}
void lcd_set_txt_with_str(const char *obj, const char *val_str)
{
	char str[64] = {0};
	sprintf(str, "%s.txt=\"%s\"\xFF\xFF\xFF", obj, val_str);
	rt_device_write(serial, 0, str, strlen(str));
}
void lcd_set_txt_with_str_color(const char *obj, const char *val_str, uint16_t color)
{
	char str[64] = {0};
	sprintf(str, "%s.txt=\"%s\"\xFF\xFF\xFF", obj, val_str);
	rt_device_write(serial, 0, str, strlen(str));
	sprintf(str, "%s.pco=%d\xFF\xFF\xFF", obj, color);
	rt_device_write(serial, 0, str, strlen(str));
}
void lcd_clr_txt(const char *obj)
{
	char str[64] = {0};
	sprintf(str, "%s.txt=\"\"\xFF\xFF\xFF", obj);
	rt_device_write(serial, 0, str, strlen(str));
}
void lcd_set_page(const char * page)
{
	char str[64] = {0};
	sprintf(str, "page %s\xFF\xFF\xFF", page);
	rt_device_write(serial, 0, str, strlen(str));
}

void lcd_set_vis(const char *obj, uint8_t vis)
{
	char str[64] = {0};
	sprintf(str, "vis %s,%d\xFF\xFF\xFF", obj, vis);
	rt_device_write(serial, 0, str, strlen(str));
}

void lcd_set_list_item(uint8_t idx, uint32_t id, uint8_t status)
{
	switch(idx)
	{
		case 0:
		{
			lcd_set_txt_with_number("list.t2",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t3","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t3","离线",63488);
		}
		break;
		case 1:
		{
			lcd_set_txt_with_number("list.t4",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t5","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t5","离线",63488);
		}
		break;
		case 2:
		{
			lcd_set_txt_with_number("list.t6",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t7","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t7","离线",63488);
		}
		break;
		case 3:
		{
			lcd_set_txt_with_number("list.t8",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t9","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t9","离线",63488);
		}
		break;
		case 4:
		{
			lcd_set_txt_with_number("list.t10",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t11","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t11","离线",63488);
		}
		break;
		case 5:
		{
			lcd_set_txt_with_number("list.t12",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t13","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t13","离线",63488);
		}
		break;
		case 6:
		{
			lcd_set_txt_with_number("list.t14",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t15","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t15","离线",63488);
		}
		break;
		case 7:
		{
			lcd_set_txt_with_number("list.t16",id);
			if(status == 1)
				lcd_set_txt_with_str_color("list.t17","正常",2016);
			else
				lcd_set_txt_with_str_color("list.t17","离线",63488);
		}
		break;
	}
}

void lcd_clr_list_item(uint8_t idx)
{
	switch(idx)
	{
		case 0:
		{
			lcd_clr_txt("list.t2");
			lcd_clr_txt("list.t3");
		}
		break;
		case 1:
		{
			lcd_clr_txt("list.t4");
			lcd_clr_txt("list.t5");
		}
		break;
		case 2:
		{
			lcd_clr_txt("list.t6");
			lcd_clr_txt("list.t7");
		}
		break;
		case 3:
		{
			lcd_clr_txt("list.t8");
			lcd_clr_txt("list.t9");
		}
		break;
		case 4:
		{
			lcd_clr_txt("list.t10");
			lcd_clr_txt("list.t11");
		}
		break;
		case 5:
		{
			lcd_clr_txt("list.t12");
			lcd_clr_txt("list.t13");
		}
		break;
		case 6:
		{
			lcd_clr_txt("list.t14");
			lcd_clr_txt("list.t15");
		}
		break;
		case 7:
		{
			lcd_clr_txt("list.t16");
			lcd_clr_txt("list.t17");
		}
		break;
	}
}

void lcd_set_list_vis(uint8_t idx, uint8_t vis)
{
	switch(idx)
	{
		case 0:
		{
			lcd_set_vis("b3", vis);
			lcd_set_vis("t2", vis);
			lcd_set_vis("t3", vis);
		}
		break;
		case 1:
		{
			lcd_set_vis("b4", vis);
			lcd_set_vis("t4", vis);
			lcd_set_vis("t5", vis);
		}
		break;
		case 2:
		{
			lcd_set_vis("b5", vis);
			lcd_set_vis("t6", vis);
			lcd_set_vis("t7", vis);
		}
		break;
		case 3:
		{
			lcd_set_vis("b6", vis);
			lcd_set_vis("t8", vis);
			lcd_set_vis("t9", vis);
		}
		break;
		case 4:
		{
			lcd_set_vis("b7", vis);
			lcd_set_vis("t10", vis);
			lcd_set_vis("t11", vis);
		}
		break;
		case 5:
		{
			lcd_set_vis("b8", vis);
			lcd_set_vis("t12", vis);
			lcd_set_vis("t13", vis);
		}
		break;
		case 6:
		{
			lcd_set_vis("b9", vis);
			lcd_set_vis("t14", vis);
			lcd_set_vis("t15", vis);
		}
		break;
	}
}

void lcd_disp_list(uint8_t type)
{
	if(type == PAGE_TYPE_LIST)
	{
		for(int i=(page_idx*7);i<((page_idx+1)*7);i++)
		{
			if(sensor[i].exist == 1)
			{
				lcd_set_list_item(i%7, sensor[i].target_id, sensor[i].online);
			}
			else
			{
				lcd_clr_list_item(i%7);
			}
		}
	}
	else if(type == PAGE_TYPE_NORMAL)
	{
		for(int i=(page_idx*7);i<((page_idx+1)*7);i++)
		{
			if(sensor_normal[i].ava == 1)
			{
				lcd_set_list_item(i%7, sensor[sensor_normal[i].idx].target_id, sensor[sensor_normal[i].idx].online);
			}
			else
			{
				lcd_clr_list_item(i%7);
			}
		}
	}
	else if(type == PAGE_TYPE_PRE)
	{
		for(int i=(page_idx*7);i<((page_idx+1)*7);i++)
		{
			if(sensor_pre[i].ava == 1)
			{
				lcd_set_list_item(i%7, sensor[sensor_pre[i].idx].target_id, sensor[sensor_pre[i].idx].online);
			}
			else
			{
				lcd_clr_list_item(i%7);
			}
		}
	}
	else if(type == PAGE_TYPE_WARN)
	{
		for(int i=(page_idx*7);i<((page_idx+1)*7);i++)
		{
			if(sensor_warn[i].ava == 1)
			{
				lcd_set_list_item(i%7, sensor[sensor_warn[i].idx].target_id, sensor[sensor_warn[i].idx].online);
			}
			else
			{
				lcd_clr_list_item(i%7);
			}
		}
	}
	else if(type == PAGE_TYPE_OFFLINE)
	{
		for(int i=(page_idx*7);i<((page_idx+1)*7);i++)
		{
			if(sensor_offline[i].ava == 1)
			{
				lcd_set_list_item(i%7, sensor[sensor_offline[i].idx].target_id, sensor[sensor_offline[i].idx].online);
			}
			else
			{
				lcd_clr_list_item(i%7);
			}
		}
	}
}
void lcd_disp_info(uint8_t idx)
{
	lcd_set_txt_with_number("info.t1", sensor[idx].target_id);
	lcd_set_txt_with_number("info.t3", idx);
	
	lcd_set_txt_with_float("info.t5", sensor[idx].fx_g_rms);
	lcd_set_txt_with_float("info.t7", sensor[idx].fy_g_rms);
	lcd_set_txt_with_float("info.t9", sensor[idx].fz_g_rms);
	
	lcd_set_txt_with_float("info.t11", sensor[idx].fx_g_max);
	lcd_set_txt_with_float("info.t13", sensor[idx].fy_g_max);
	lcd_set_txt_with_float("info.t15", sensor[idx].fz_g_max);
	
	lcd_set_txt_with_float("info.t17", sensor[idx].fx_g_k);
	lcd_set_txt_with_float("info.t19", sensor[idx].fy_g_k);
	lcd_set_txt_with_float("info.t21", sensor[idx].fz_g_k);
	
	lcd_set_txt_with_float("info.t23", sensor[idx].fx_g_cf);
	lcd_set_txt_with_float("info.t25", sensor[idx].fy_g_cf);
	lcd_set_txt_with_float("info.t27", sensor[idx].fz_g_cf);
	
	lcd_set_txt_with_float("info.t29", sensor[idx].temp);
	lcd_set_txt_with_float("info.t31", sensor[idx].bat);
	
	lcd_set_txt_with_number("info.t32", sensor[idx].rssi);
}
static void misc_thread_entry(void *parameter)
{
	uint8_t deal_char;
	uint8_t str_catch = 0;
	serial = rt_device_find("uart1");
	rt_sem_init(&rx_sem, "rx_sem", 0, RT_IPC_FLAG_FIFO);
	rt_device_open(serial, RT_DEVICE_FLAG_INT_RX);
	struct serial_configure uart1_set_parg={   \
			BAUD_RATE_9600, /* 115200 bits/s */  \
			DATA_BITS_8,      /* 8 databits */     \
			STOP_BITS_1,      /* 1 stopbit */      \
			PARITY_NONE,      /* No parity  */     \
			BIT_ORDER_LSB,    /* LSB first sent */ \
			NRZ_NORMAL,       /* Normal mode */    \
			RT_SERIAL_RB_BUFSZ, /* Buffer size */  \
			0                                      \
	};
	rt_device_control(serial, RT_DEVICE_CTRL_CONFIG, &uart1_set_parg);
	rt_device_set_rx_indicate(serial, uart_input);
	lcd_set_val_with_number("main.n0", settings.sensor_cnt);
	lcd_set_val_with_number("main.n1", 0);
	lcd_set_val_with_number("main.n2", 0);
	lcd_set_val_with_number("main.n8", 0);
	lcd_set_val_with_number("main.n9", 0);
	rt_thread_mdelay(1000);
	lcd_set_txt_with_str("setting.t3", settings.server_addr);
	lcd_set_txt_with_number("setting.t5", settings.server_port);
	if(settings.use4g == 1)
	{
		lcd_set_val_with_number("setting.r0",0);
		lcd_set_val_with_number("setting.r1",1);
	}
	else
	{
		lcd_set_val_with_number("setting.r0",1);
		lcd_set_val_with_number("setting.r1",0);
	}
	lcd_set_txt_with_str("setting.t10", settings.self_addr);
	lcd_set_txt_with_str("setting.t1", settings.gw);
	lcd_set_txt_with_str("setting.t12", settings.netmask);
	while(1)
	{
		if(RT_EOK == rt_sem_take(&rx_sem, 1000))
		{
			while(uart_rx_buf_r_idx != uart_rx_buf_w_idx)
			{
				deal_char = uart_rx_buf[uart_rx_buf_r_idx];
				if(deal_char == '{')
				{
					//settings str start
					str_catch = 1;
					settings_str_idx = 0;
				}
				if(str_catch == 1)
				{
					//catch str
					settings_str_buf[settings_str_idx] = deal_char;
					settings_str_idx++;
					if(settings_str_idx == 128)
						settings_str_idx = 0;
				}
				if(deal_char == '}')
				{
					//settings str end
					str_catch = 0;
					settings_str_buf[settings_str_idx] = 0;
					//deal_char
					cJSON * json = cJSON_ParseWithLength((char *)settings_str_buf, settings_str_idx);
					cJSON * server = cJSON_GetObjectItem(json, "server");
					cJSON * port = cJSON_GetObjectItem(json, "port");
					cJSON * ip = cJSON_GetObjectItem(json, "ip");
					cJSON * gw = cJSON_GetObjectItem(json, "gw");
					cJSON * mask = cJSON_GetObjectItem(json, "mask");
					cJSON * use_lte = cJSON_GetObjectItem(json, "use_lte");
					cJSON * btn = cJSON_GetObjectItem(json, "btn");
					cJSON * list_idx = cJSON_GetObjectItem(json, "list_idx");
					if(btn != RT_NULL)
					{
						rt_kprintf("btn %d\r\n", btn->valueint);
						switch(btn->valueint)
						{
							case 0:
							{
								page_type = PAGE_TYPE_LIST;
								page_idx = 0;
								page_cnt = (settings.sensor_cnt+6)/7;
								cur_cnt = settings.sensor_cnt;
								lcd_disp_list(page_type);
								lcd_set_page("list");
							}
							break;
							case 1:
							{
								page_type = PAGE_TYPE_NORMAL;
								page_idx = 0;
								page_cnt = (nromal_cnt+6)/7;
								cur_cnt = nromal_cnt;
								lcd_disp_list(page_type);
								lcd_set_page("list");
							}
							break;
							case 2:
							{
								page_type = PAGE_TYPE_PRE;
								page_idx = 0;
								page_cnt = (pre_cnt+6)/7;
								cur_cnt = pre_cnt;
								lcd_disp_list(page_type);
								lcd_set_page("list");
							}
							break;
							case 3:
							{
								page_type = PAGE_TYPE_WARN;
								page_idx = 0;
								page_cnt = (warn_cnt+6)/7;
								cur_cnt = warn_cnt;
								lcd_disp_list(page_type);
								lcd_set_page("list");
							}
							break;
							case 4:
							{
								page_type = PAGE_TYPE_OFFLINE;
								page_idx = 0;
								page_cnt = (offline_cnt+6)/7;
								cur_cnt = offline_cnt;
								lcd_disp_list(page_type);
								lcd_set_page("list");
							}
							break;
							case 5:
							{
								lcd_set_page("main");
							}
							break;
							case 6:
							{
								//pre
								if(page_idx>0)
								{
									page_idx--;
									lcd_disp_list(page_type);
								}
							}
							break;
							case 7:
							{
								//next
								if(page_idx<(page_cnt-1))
								{
									page_idx++;
									lcd_disp_list(page_type);
								}
							}
							break;
							case 8:
							{
								lcd_set_page("list");
							}
							break;
						}
						
					}
					else if(list_idx != RT_NULL)
					{
						rt_kprintf("list_idx %d\r\n", list_idx->valueint);
						uint8_t sensor_idx = page_idx*7 + list_idx->valueint;
						if(sensor_idx<cur_cnt)
						{
							lcd_disp_info(sensor_idx);
							lcd_set_page("info");
						}
					}
					else if(use_lte != RT_NULL)
					{
						settings.use4g = use_lte->valueint;
						rt_kprintf("use lte is %d\r\n", settings.use4g);
					}
					else if((isVaildIp(ip->valuestring))&&(isVaildIp(server->valuestring))&&(isVaildIp(gw->valuestring))&&(isVaildIp(mask->valuestring))&&(port->valueint>0))
					{
						sprintf(settings.server_addr, "%s", server->valuestring);
						settings.server_port = port->valueint;
						sprintf(settings.self_addr, "%s", ip->valuestring);
						sprintf(settings.netmask, "%s", mask->valuestring);
						sprintf(settings.gw, "%s", gw->valuestring);
						
						rt_kprintf("server %s\r\n", settings.server_addr);
						rt_kprintf("port %d\r\n", settings.server_port);
						rt_kprintf("ip %s\r\n", settings.self_addr);
						rt_kprintf("mask %s\r\n", settings.netmask);
						rt_kprintf("gw %s\r\n", settings.gw);
						lcd_set_cmd("rest");
						nodes_save_req = 1;
					}
					
					cJSON_Delete(json);
				}
				uart_rx_buf_r_idx++;
				if(uart_rx_buf_r_idx == 64)
					uart_rx_buf_r_idx = 0;
			}
		}
		else
		{
			time_t rawtime;
			time(&rawtime);
			struct tm *timeinfo;
			timeinfo = localtime(&rawtime);
			if(time_min_last != timeinfo->tm_min)
			{
				time_min_last = timeinfo->tm_min;
				lcd_set_val_with_number("main.n3", timeinfo->tm_year + 1900);
				lcd_set_val_with_number("main.n4", timeinfo->tm_mon + 1);
				lcd_set_val_with_number("main.n5", timeinfo->tm_mday);
				lcd_set_val_with_number("main.n6", timeinfo->tm_hour);
				lcd_set_val_with_number("main.n7", timeinfo->tm_min);
			}
			nromal_cnt = 0;
			pre_cnt = 0;
			warn_cnt = 0;
			offline_cnt = 0;
			memset(sensor_normal, 0x00, sizeof(sensor_normal));
			memset(sensor_pre, 0x00, sizeof(sensor_pre));
			memset(sensor_warn, 0x00, sizeof(sensor_warn));
			memset(sensor_offline, 0x00, sizeof(sensor_offline));
			for(int i=0;i<settings.sensor_cnt;i++)
			{
				if((sensor[i].online == 1)&&(sensor[i].status == STATUS_NORMAL))
				{
					sensor_normal[nromal_cnt].idx = i;
					sensor_normal[nromal_cnt].ava = 1;
					nromal_cnt++;
				}
				if(sensor[i].online == 0)
				{
					sensor_offline[offline_cnt].idx = i;
					sensor_offline[offline_cnt].ava = 1;
					offline_cnt++;
				}
				if(sensor[i].status == STATUS_PRE)
				{
					sensor_pre[pre_cnt].idx = i;
					sensor_pre[pre_cnt].ava = 1;
					pre_cnt++;
				}
				if(sensor[i].status == STATUS_WARN)
				{
					sensor_warn[warn_cnt].idx = i;
					sensor_warn[warn_cnt].ava = 1;
					warn_cnt++;
				}
			}
			lcd_set_val_with_number("main.n0", settings.sensor_cnt);
			lcd_set_val_with_number("main.n1", nromal_cnt);
			lcd_set_val_with_number("main.n2", pre_cnt);
			lcd_set_val_with_number("main.n8", warn_cnt);
			lcd_set_val_with_number("main.n9", offline_cnt);
		}
	}
}
static int misc_thread_init(void)
{
    rt_err_t err;
	
    err = rt_thread_init(&misc_thread, "misc", misc_thread_entry, RT_NULL,
           misc_thread_stack, MISC_THREAD_STACK_SIZE, MISC_THREAD_PRIO, 10);
    if(err != RT_EOK)
    {
        rt_kprintf("Failed to create misc thread");
        return -1;
    }
    rt_thread_startup(&misc_thread);

    return 0;
}
INIT_ENV_EXPORT(misc_thread_init);

