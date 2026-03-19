#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>
#include <drv_gpio.h>
#include <string.h>

#include "lora-radio-rtos-config.h"
#include "lora-radio.h"
#include "lora-radio-timer.h"
#include "lora_work.h"


#define MISC_THREAD_STACK_SIZE 512
#define MISC_THREAD_PRIO 29
static rt_uint8_t misc_thread_stack[MISC_THREAD_STACK_SIZE];
static struct rt_thread misc_thread;

volatile uint8_t calc_req = 0;
volatile uint8_t ota_req = 0;
uint16_t ota_total = 0;
uint16_t ota_idx = 0;

//uint8_t param_buf[2048] = {0};

//uint8_t sector_buf[2048] = {0};

struct rt_semaphore rx_sem;
rt_device_t serial;

uint8_t uart_rx_buf[64] = {0};
volatile uint16_t uart_rx_buf_w_idx = 0;
volatile uint16_t uart_rx_buf_r_idx = 0;
extern volatile uint8_t settings_save_req;
uint8_t uart_tx_buf[32] = {0};

uint8_t rx_cmd;
uint16_t rx_len;
uint16_t tx_len;
uint16_t rx_crc;
uint16_t tx_crc;
uint8_t * rx_data;
uint8_t * wave;
uint16_t rx_data_idx;

short_packet_t short_pkt;
long_packet_t long_pkt;

volatile uint8_t calc_data_evt = 0;
volatile uint8_t calc_evt = 0;
volatile uint8_t result_evt = 0;
volatile uint8_t wave_evt = 0;

extern uint8_t wave_idx;
extern uint32_t self_id;
extern uint32_t rf_channel;

#define WAIT_SYNC			0x00
#define WAIT_FLAG			0x01
#define WAIT_CMD			0x02
#define WAIT_LEN_H		0x03
#define WAIT_LEN_L		0x04
#define WAIT_DATA			0x05
#define WAIT_CRC_H		0x06
#define WAIT_CRC_L		0x07

#define CMD_GET_CALC_DATA		0x01
#define CMD_CALC						0x02
#define CMD_GET_RESULT			0x03
#define CMD_GET_WAVE				0x04
#define CMD_SET_ID					0x05


static uint16_t calc_crc(uint8_t *data, uint16_t length)
{
  uint16_t crc = 0u;
  while (length)
  {
		length--;
		crc = crc ^ ((uint16_t)*data++ << 8u);
		for (uint8_t i = 0u; i < 8u; i++)
		{
			if (crc & 0x8000u)
			{
				crc = (crc << 1u) ^ 0x1021u;
			}
			else
			{
				crc = crc << 1u;
			}
		}
  }
  return crc;
}

void send_get_crc_data(void)
{
	tx_len = 1;
	uart_tx_buf[0] = 0xFF;
	uart_tx_buf[1] = 0x55;
	uart_tx_buf[2] = CMD_GET_CALC_DATA;
	uart_tx_buf[3] = tx_len>>8;
	uart_tx_buf[4] = tx_len;
	uart_tx_buf[5] = 0;
	tx_crc = calc_crc(uart_tx_buf, tx_len+5);
	uart_tx_buf[tx_len+5] = tx_crc>>8;
	uart_tx_buf[tx_len+6] = tx_crc;
	rt_device_write(serial, 0, uart_tx_buf, tx_len+7);
}

void send_calc(void)
{
	tx_len = 1;
	uart_tx_buf[0] = 0xFF;
	uart_tx_buf[1] = 0x55;
	uart_tx_buf[2] = CMD_CALC;
	uart_tx_buf[3] = tx_len>>8;
	uart_tx_buf[4] = tx_len;
	uart_tx_buf[5] = 0;
	tx_crc = calc_crc(uart_tx_buf, tx_len+5);
	uart_tx_buf[tx_len+5] = tx_crc>>8;
	uart_tx_buf[tx_len+6] = tx_crc;
	rt_device_write(serial, 0, uart_tx_buf, tx_len+7);
}

void send_get_result(void)
{
	tx_len = 1;
	uart_tx_buf[0] = 0xFF;
	uart_tx_buf[1] = 0x55;
	uart_tx_buf[2] = CMD_GET_RESULT;
	uart_tx_buf[3] = tx_len>>8;
	uart_tx_buf[4] = tx_len;
	uart_tx_buf[5] = 0;
	tx_crc = calc_crc(uart_tx_buf, tx_len+5);
	uart_tx_buf[tx_len+5] = tx_crc>>8;
	uart_tx_buf[tx_len+6] = tx_crc;
	rt_device_write(serial, 0, uart_tx_buf, tx_len+7);
}

void send_get_wave(void)
{
	tx_len = 1;
	uart_tx_buf[0] = 0xFF;
	uart_tx_buf[1] = 0x55;
	uart_tx_buf[2] = CMD_GET_WAVE;
	uart_tx_buf[3] = tx_len>>8;
	uart_tx_buf[4] = tx_len;
	uart_tx_buf[5] = wave_idx;
	tx_crc = calc_crc(uart_tx_buf, tx_len+5);
	uart_tx_buf[tx_len+5] = tx_crc>>8;
	uart_tx_buf[tx_len+6] = tx_crc;
	rt_device_write(serial, 0, uart_tx_buf, tx_len+7);
}

uint8_t wave_get_idx = 0;

float offset_x;
float offset_y;
float offset_z;
extern void save_settings(void);

void deal_packet(void)
{
	switch(rx_cmd&0x0f)
	{
		case CMD_GET_CALC_DATA:
		{
			memcpy(&offset_x, &rx_data[6], 4);
			memcpy(&offset_y, &rx_data[10], 4);
			memcpy(&offset_z, &rx_data[14], 4);
			calc_data_evt = 1;
		}
		break;
		case CMD_SET_ID:
		{
			memcpy(&self_id, &rx_data[6], 4);
			rf_channel = rx_data[10];
			settings_save_req = 1;
		}
		break;
		case CMD_CALC:
		{
			calc_evt = 1;
		}
		break;
		case CMD_GET_RESULT:
		{
			memcpy(&short_pkt.fx_g_rms, &rx_data[6], 4);
			memcpy(&short_pkt.fy_g_rms, &rx_data[10], 4);
			memcpy(&short_pkt.fz_g_rms, &rx_data[14], 4);
			
			memcpy(&short_pkt.fx_g_max, &rx_data[18], 4);
			memcpy(&short_pkt.fy_g_max, &rx_data[22], 4);
			memcpy(&short_pkt.fz_g_max, &rx_data[26], 4);
			
			memcpy(&short_pkt.fx_zs_rms, &rx_data[30], 4);
			memcpy(&short_pkt.fy_zs_rms, &rx_data[34], 4);
			memcpy(&short_pkt.fz_zs_rms, &rx_data[38], 4);
			
			memcpy(&short_pkt.fx_g_k, &rx_data[42], 4);
			memcpy(&short_pkt.fy_g_k, &rx_data[46], 4);
			memcpy(&short_pkt.fz_g_k, &rx_data[50], 4);
			
			memcpy(&short_pkt.fx_g_cf, &rx_data[54], 4);
			memcpy(&short_pkt.fy_g_cf, &rx_data[58], 4);
			memcpy(&short_pkt.fz_g_cf, &rx_data[62], 4);
			
			memcpy(&short_pkt.temp, &rx_data[66], 4);
			result_evt = 1;
		}
		break;
		case CMD_GET_WAVE:
		{
			wave_evt = 1;
		}
		break;
	}
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
uint8_t step = WAIT_SYNC;
static void misc_thread_entry(void *parameter)
{
	uint16_t crc;
	uint8_t deal_char;
	serial = rt_device_find("uart2");
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
	while(1)
	{
		rt_sem_take(&rx_sem, RT_WAITING_FOREVER);
		while(uart_rx_buf_r_idx != uart_rx_buf_w_idx)
		{
			deal_char = uart_rx_buf[uart_rx_buf_r_idx];
			switch(step)
			{
				case WAIT_SYNC:
				{
					if(deal_char == 0xFF)
					{
						rx_data[1] = 0xFF;
						step = WAIT_FLAG;
					}
				}
				break;
				case WAIT_FLAG:
				{
					if(deal_char == 0x55)
					{
						rx_data[2] = 0x55;
						step = WAIT_CMD;
					}
					else
						step = WAIT_SYNC;
				}
				break;
				case WAIT_CMD:
				{
					rx_data[3] = deal_char;
					rx_cmd = deal_char;
					step = WAIT_LEN_H;
				}
				break;
				case WAIT_LEN_H:
				{
					rx_data[4] = deal_char;
					rx_len = (deal_char<<8);
					step = WAIT_LEN_L;
				}
				break;
				case WAIT_LEN_L:
				{
					rx_data[5] = deal_char;
					rx_len |= deal_char;
					rx_data_idx = 0;
					step = WAIT_DATA;
				}
				break;
				case WAIT_DATA:
				{
					rx_data[rx_data_idx+6] = deal_char;
					rx_data_idx++;
					if(rx_data_idx == rx_len)
					  step = WAIT_CRC_H;	
				}
				break;
				case WAIT_CRC_H:
				{
					rx_crc = (deal_char<<8);
					step = WAIT_CRC_L;
				}
				break;
				case WAIT_CRC_L:
				{
					rx_crc |= deal_char;
					crc = calc_crc(&rx_data[1], rx_len + 5);
					if(crc == rx_crc)
						deal_packet();
					step = WAIT_SYNC;
				}
				break;
			}
			uart_rx_buf_r_idx++;
			if(uart_rx_buf_r_idx == 64)
				uart_rx_buf_r_idx = 0;
		}
	}
}
static int misc_thread_init(void)
{
    rt_err_t err;
	
		rx_data = rt_malloc(6144+8);
		wave = (uint8_t *)(rx_data+6);
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

