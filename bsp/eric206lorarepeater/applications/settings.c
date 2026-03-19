#include <board.h>
#include <rtthread.h>
#include <rthw.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#include "main.h"

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

#include "drv_flash.h"

settings_t settings;
void settings_save(void)
{
	uint32_t rf_channel = settings.ch;
	uint32_t sign = 0x5aa5aa55;
	stm32_flash_erase(0x080E0000, 128*1024);
	stm32_flash_write(0x080E0000, (uint8_t *)&rf_channel, 4);
	stm32_flash_write(0x080E0004, (uint8_t *)&sign, 4);
}

void get_settings(void)
{
	uint32_t rf_channel = 0;
	uint32_t sign = 0;
	stm32_flash_read(0x080E0004, (uint8_t *)&sign, 4);
	if(sign == 0x5aa5aa55)
	{
		stm32_flash_read(0x080E0000, (uint8_t *)&rf_channel, 4);
		settings.ch = rf_channel;
	}
	else
	{
		settings.ch = 12;
		settings_save();
	}
}

