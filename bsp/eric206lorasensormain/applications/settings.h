#ifndef _SETTINGS_H_
#define _SETTINGS_H_

typedef struct{
	uint32_t id;
	uint32_t short_set;
	uint32_t long_set;
	uint8_t ch;
}SETTINGS;

extern const uint8_t ch_tab[24][4];

#endif

