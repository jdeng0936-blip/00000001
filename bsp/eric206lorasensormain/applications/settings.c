#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>

#include "settings.h"

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
#define DATA_FLASH_ADDR		0x08080000
uint32_t set_sign = 0x5aa5aa55;
extern uint32_t self_id;
extern uint32_t rf_channel;
void save_settings(void)
{
	set_sign = 0x5aa5aa55;
	HAL_FLASHEx_DATAEEPROM_Unlock();
	HAL_FLASHEx_DATAEEPROM_Erase(FLASH_TYPEPROGRAM_WORD, DATA_FLASH_ADDR);
	HAL_FLASHEx_DATAEEPROM_Erase(FLASH_TYPEPROGRAM_WORD, DATA_FLASH_ADDR+4);
	HAL_FLASHEx_DATAEEPROM_Erase(FLASH_TYPEPROGRAM_WORD, DATA_FLASH_ADDR+8);
	HAL_FLASHEx_DATAEEPROM_Program(FLASH_TYPEPROGRAMDATA_WORD, DATA_FLASH_ADDR, self_id);
	HAL_FLASHEx_DATAEEPROM_Program(FLASH_TYPEPROGRAMDATA_WORD, DATA_FLASH_ADDR+4, rf_channel);
	HAL_FLASHEx_DATAEEPROM_Program(FLASH_TYPEPROGRAMDATA_WORD, DATA_FLASH_ADDR+8, set_sign);
	HAL_FLASHEx_DATAEEPROM_Lock();
}
void get_settings(void)
{
	uint32_t * pbuf = (uint32_t *)DATA_FLASH_ADDR;
	self_id = *pbuf++;
	rf_channel = *pbuf++;
	set_sign = *pbuf++;
	if(set_sign != 0x5aa5aa55)
	{
		self_id = 0x400;
		rf_channel = 12;
	}
}
