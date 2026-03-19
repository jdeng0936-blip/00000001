#ifndef _SETTINGS_H_
#define _SETTINGS_H_

typedef struct {
	uint16_t sign;			//	128
	char server_addr[16];		//?????		16
	uint16_t server_port;		//??????	18
	uint16_t rs485_baud;		//485???			20
	uint16_t rs485_id;			//485????		22
	
	char pass[8];		//??									43
	uint16_t idle;			//??????			45
	uint8_t bl_percent;	//????	46			46
	char mac[16];				//??MAC??	62
	char self_addr[16];	//??IP			78
	char netmask[16];		//????		94
	char gw[16];				//????		110
	uint8_t use4g;			//????4G	111
	uint8_t userepeater;			//????4G	111
	uint32_t short_set;
	uint32_t long_set;
	uint8_t ch;
	uint8_t sensor_cnt;
}settings_t;

extern const uint8_t ch_tab[24][4];

extern settings_t settings;

void get_settings(void);
#endif
