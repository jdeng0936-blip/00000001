#include <board.h>
#include <rtthread.h>
#include <rthw.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include <dfs.h>
#include <dfs_fs.h>
#include <cjson.h>
#include "main.h"

#include "settings.h"

//const uint8_t ch_tab[32][4] = {
//	
//	{33, 15, 50, 34},
//	{36, 95, 55, 93},
//	{7, 25, 52, 17},
//	{47, 48, 75, 56},
//	
//	{1, 27, 51, 82},
//	{44, 80, 71, 46},
//	
//	{40, 57, 36, 90},
//	{9, 26, 74, 16},
//	
//	{39, 41, 2, 73},
//	{15, 49, 8, 69},
//	{23, 28, 77, 67},
//	{5, 11, 12, 20},
//	
//	{34, 53, 19, 83},
//	{25, 29, 0, 60},
//	{28, 31, 54, 88},
//	{35, 59, 33, 1},
//	
//	{18, 38, 4, 58},
//	{2, 44, 72, 39},
//	
//	{26, 86, 65, 89},
//	{22, 79, 43, 7},
//	
//	{11, 18, 63, 85},
//	{4, 14, 62, 10},
//	{6, 91, 3, 92},
//	{30, 5, 87, 40},
//	
//	{24, 70, 94, 76},
//	{27, 6, 30, 78},
//	{16, 9, 42, 45},
//	{8, 68, 13, 22},
//	
//	{31, 81, 61, 35},
//	{10, 21, 64, 37},
//	
//	{32, 24, 23, 66},
//	{21, 32, 84, 47},
//};
const uint8_t ch_tab[24][4] = {
{28 ,3 ,92 ,7},
{82 ,4 ,8 ,25},
{91 ,52 ,67 ,58},
{34 ,38 ,66 ,13},
{49 ,88 ,44 ,94},
{37 ,42 ,47 ,29},
{30 ,93 ,26 ,22},
{21 ,48 ,75 ,54},
{15 ,0 ,20 ,35},
{56 ,95 ,80 ,11},
{32 ,50 ,19 ,31},
{83 ,53 ,1 ,39},
{24 ,17 ,74 ,81},
{63 ,62 ,72 ,36},
{5 ,76 ,78 ,84},
{9 ,64 ,40 ,70},
{59 ,51 ,89 ,12},
{79 ,43 ,27 ,14},
{85 ,57 ,23 ,60},
{61 ,33 ,18 ,45},
{68 ,71 ,69 ,10},
{55 ,16 ,73 ,86},
{77 ,87 ,41 ,90},
{6 ,46 ,65 ,2}
};

settings_t settings;
extern volatile uint8_t nodes_save_req;
extern uint8_t sensor_online[40];
void save_settings(void)
{
	cJSON * json = cJSON_CreateObject();
	cJSON_AddStringToObject(json, "server_ip", settings.server_addr);
	cJSON_AddNumberToObject(json, "server_port", settings.server_port);
	cJSON_AddStringToObject(json, "mac", settings.mac);
	cJSON_AddStringToObject(json, "self_ip", settings.self_addr);
	cJSON_AddStringToObject(json, "mask", settings.netmask);
	cJSON_AddStringToObject(json, "gw", settings.gw);
	
	cJSON_AddNumberToObject(json, "use4g", settings.use4g);
	cJSON_AddNumberToObject(json, "ch", settings.ch);
	cJSON_AddNumberToObject(json, "userepeater", settings.userepeater);
	cJSON_AddNumberToObject(json, "short_set", settings.short_set);
	cJSON_AddNumberToObject(json, "long_set", settings.long_set);
	cJSON_AddNumberToObject(json, "sensor_cnt", settings.sensor_cnt);
	
	cJSON * nodes = cJSON_CreateArray();
	for(int i=0;i<settings.sensor_cnt;i++)
	{
		cJSON * item = cJSON_CreateObject();
		cJSON_AddNumberToObject(item, "target_id", sensor[i].target_id);
		cJSON_AddItemToArray(nodes, item);
	}
	cJSON_AddItemToObject(json, "nodes", nodes);
	char * cjson_str = cJSON_PrintUnformatted(json);
	FILE * settings_file = fopen("settings.cfg", "wb+");
	fseek(settings_file, 0, SEEK_SET);
	fwrite(cjson_str, 1, strlen(cjson_str), settings_file);
	fflush(settings_file);
	fclose(settings_file);
	cJSON_Delete(json);
}

void get_settings(void)
{
	struct stat filestat;
	stat("settings.cfg", &filestat);
	FILE * settings_file = fopen("settings.cfg", "rb");
	if(settings_file>0)
	{
		char * settings_str = malloc(filestat.st_size);
		fread(settings_str, 1, filestat.st_size, settings_file);
		fclose(settings_file);
		cJSON* json = cJSON_Parse(settings_str);
		
		cJSON* server_ip = cJSON_GetObjectItem(json, "server_ip");
		sprintf(settings.server_addr, "%s", server_ip->valuestring);
		
		cJSON* server_port = cJSON_GetObjectItem(json, "server_port");
		settings.server_port = server_port->valueint;
		
		cJSON* mac = cJSON_GetObjectItem(json, "mac");
		sprintf(settings.mac, "%s", mac->valuestring);
		
		cJSON* self_ip = cJSON_GetObjectItem(json, "self_ip");
		sprintf(settings.self_addr, "%s", self_ip->valuestring);
		
		cJSON* mask = cJSON_GetObjectItem(json, "mask");
		sprintf(settings.netmask, "%s", mask->valuestring);
		
		cJSON* gw = cJSON_GetObjectItem(json, "gw");
		sprintf(settings.gw, "%s", gw->valuestring);
		
		cJSON* use4g = cJSON_GetObjectItem(json, "use4g");
		settings.use4g = use4g->valueint;
		
		cJSON* ch = cJSON_GetObjectItem(json, "ch");
		settings.ch = ch->valueint;
		
		cJSON* userepeater = cJSON_GetObjectItem(json, "userepeater");
		settings.userepeater = userepeater->valueint;
		
		cJSON* short_set = cJSON_GetObjectItem(json, "short_set");
		settings.short_set = short_set->valueint;
		
		cJSON* long_set = cJSON_GetObjectItem(json, "long_set");
		settings.long_set = long_set->valueint;
		
		cJSON* sensor_cnt = cJSON_GetObjectItem(json, "sensor_cnt");
		settings.sensor_cnt = sensor_cnt->valueint;
		
		cJSON* nodes = cJSON_GetObjectItem(json, "nodes");
		for(int i=0;i<sensor_cnt->valueint;i++)
		{
			cJSON * item = cJSON_GetArrayItem(nodes, i);
			cJSON * target_id = cJSON_GetObjectItem(item, "target_id");
			sensor[i].target_id = target_id->valueint;
			sensor[i].next_short = settings.short_set + i;
			sensor[i].next_long = settings.long_set + i;
			sensor[i].exist = 1;
		}
		cJSON_Delete(json);
		free(settings_str);
	}
	else
	{
		sprintf(settings.server_addr, "43.137.46.155");
		settings.server_port = 8206;
		sprintf(settings.mac, "001234567899");
		sprintf(settings.self_addr, "192.168.88.239");
		sprintf(settings.netmask, "255.255.255.0");
		sprintf(settings.gw, "192.168.88.1");
		settings.use4g = 0;
		settings.ch = 12;
		settings.userepeater = 0;
		settings.short_set = 5;
		settings.long_set = 15;
		settings.sign = 0xA55A;
		settings.sensor_cnt = 2;
		for(int i=0;i<settings.sensor_cnt;i++)
		{
			sensor[i].target_id = 0x401+i;
			sensor[i].next_short = settings.short_set + i;
			sensor[i].next_long = settings.long_set + i;
			sensor[i].exist = 1;
		}
		save_settings();
	}
	for(int i=0;i<40;i++)
	{
		sensor_online[i] = 0;
	}
}



