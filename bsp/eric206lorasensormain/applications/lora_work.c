/*!
 * \file      lora-radio-tester.c
 *
 * \brief     lora radio shell for test implementation
 *
 * \copyright SPDX-License-Identifier: Apache-2.0
 *
 * \author    Forest-Rain
 */
#include "lora-radio-rtos-config.h"
#include "lora-radio.h"
#include "lora-radio-timer.h"
#include "lora_work.h"

#include <string.h>

#include "settings.h"

#define LOG_TAG "APP.LoRa.Radio.Shell"
#include "lora-radio-debug.h"

#define PKT_TYPE_SHORT	0x01
#define PKT_TYPE_LONG		0x02
#define PKT_FLAG_ERROR	0x40

#define CMD_TIME_BEACON			0x00
#define CMD_SET_PARAM				0x01
#define CMD_PKT_GETSHORT		0x02
#define CMD_PKT_GETLONG			0x03

#define TX_LED_TOGGLE
#define TX_LED_ON
#define TX_LED_OFF

#define RX_LED_TOGGLE
#define RX_LED_ON
#define RX_LED_OFF

#define LED0_PIN    GET_PIN(B, 7)
#define RF_TXEN_PIN    GET_PIN(B, 3)
#define RF_RXEN_PIN    GET_PIN(B, 4)

#define LORA_RADIO_TIMESTAMP_TO_MS(x) ((x) * 1000 / RT_TICK_PER_SECOND)

static struct rt_event radio_event;
extern uint16_t ack_send;
uint8_t long_idx = 0;

uint16_t BufferSize = BUFFER_SIZE;
uint8_t Buffer[BUFFER_SIZE];

cmd_packet_t * cmd_pkt = (cmd_packet_t *)&Buffer[0];
extern short_packet_t short_pkt;
extern long_packet_t long_pkt;
extern volatile uint8_t sensor_err;

static int16_t rssi_value = -255;
static int16_t rssi_value_min = -255;
static int16_t rssi_value_max = -255;
static int32_t rssi_value_total = 0;

static int8_t snr_value = -128;
static int8_t snr_value_min = -128;
static int8_t snr_value_max = -128;
static int32_t snr_value_total = 0;

static uint32_t master_address = LORA_MASTER_DEVADDR;
static uint32_t slaver_address = LORA_SLAVER_DEVADDR;
static uint8_t payload_len = 32;//1~255

static uint32_t tx_seq_cnt = 0;
static uint32_t max_tx_nbtrials = 10;
static uint32_t rx_correct_cnt = 0;
static uint32_t rx_error_cnt = 0;
static uint32_t rx_timeout_cnt = 0;

static uint32_t rx_retry = 0;

static uint32_t tx_timestamp;
static uint32_t rx_timestamp;

static uint32_t rx_timeout = RX_TIMEOUT_VALUE;
static uint32_t tx_timeout = TX_TIMEOUT_VALUE;
static uint8_t lora_chip_initialized;
static bool rx_only_flag = false;

extern uint32_t short_set;
extern uint32_t long_set;
extern uint8_t wakeup_slot;
extern uint8_t * wave;
extern volatile uint8_t result_evt;
extern volatile uint8_t wave_evt;
uint32_t ts = 0;

uint16_t sleep_time = 0;
uint16_t wakeup_sign = 0;
uint8_t timeout_cnt = 0;

extern volatile uint8_t sleep_req;
uint32_t self_id = 0x400+2;
uint32_t rf_channel = 12;

static lora_radio_test_t lora_radio_test_paras = 
{
    .tx_frequency = RF_FREQUENCY + TX_RX_FREQUENCE_OFFSET,
    .trx_frequency_offset = TX_RX_FREQUENCE_OFFSET,
    .rx_frequency = RF_FREQUENCY,
    
    .txpower      = TX_OUTPUT_POWER,
    
    // lora
    .modem     = MODEM_LORA,
    .sf        = LORA_SPREADING_FACTOR,
    .bw        = LORA_BANDWIDTH,
    .cr        = LORA_CODINGRATE,
    .iq_inversion = LORA_IQ_INVERSION_ON_DISABLE,
    .public_network = false,
     // FSK
    .fsk_bandwidth = FSK_BANDWIDTH,
};

char *bandwidth_string[3] = {"125","250","500"};

/*!
 * Radio events function pointer
 */
static RadioEvents_t RadioEvents;

/*!
 * lora radio test thread
 */
static rt_thread_t lora_radio_test_thread = RT_NULL; 

/*!
 * \brief Function to be executed on Radio Tx Done event
 */
static void OnTxDone( void );

/*!
 * \brief Function to be executed on Radio Rx Done event
 */
static void OnRxDone( uint8_t *payload, uint16_t size, int16_t rssi, int8_t snr );

/*!
 * \brief Function executed on Radio Tx Timeout event
 */
static void OnTxTimeout( void );

/*!
 * \brief Function executed on Radio Rx Timeout event
 */
static void OnRxTimeout( void );

/*!
 * \brief Function executed on Radio Rx Error event
 */
static void OnRxError( void );

/*!
 * \brief thread for ping ping
 */
static void lora_radio_test_thread_entry(void* parameter);

static void radio_rx(void);

static void OnTxDone( void )
{
    Radio.Sleep( );
    rt_event_send(&radio_event, EV_RADIO_TX_DONE);
}

static void OnRxDone( uint8_t *payload, uint16_t size, int16_t rssi, int8_t snr )
{
    Radio.Sleep( );
    BufferSize = size;
    rt_memcpy( Buffer, payload, BufferSize );
    rssi_value = rssi;
    snr_value = snr;
 
    // first rxdone
    if( rssi_value_max == -255 )
    {
        rssi_value_min = rssi_value_max = rssi;
    }
    if( snr_value_max == -128 )
    {
        snr_value_min = snr_value_max = snr;
    }
    
    // update link info
    if( rssi_value < rssi_value_min )
    {
        rssi_value_min = rssi_value;
    }        
    else if( rssi_value > rssi_value_max )
    {
        rssi_value_max = rssi_value;
    }        
    
    if( snr_value < snr_value_min )
    {
        snr_value_min = snr_value;
    }        
    else if( snr_value > rssi_value_max )
    {
        snr_value_max = snr_value;
    }   
    
    rssi_value_total += rssi_value;
    snr_value_total += snr_value;
    rx_timestamp = TimerGetCurrentTime();
    
    rt_event_send(&radio_event, EV_RADIO_RX_DONE);
}

static void OnTxTimeout( void )
{
    Radio.Sleep( );
    rt_event_send(&radio_event, EV_RADIO_TX_TIMEOUT);
}

static void OnRxTimeout( void )
{
    Radio.Sleep( );
    rx_timestamp = TimerGetCurrentTime();
    rt_event_send(&radio_event, EV_RADIO_RX_TIMEOUT);
}

static void OnRxError( void )
{
    rx_error_cnt++; 
    Radio.Sleep( );
    rt_event_send(&radio_event, EV_RADIO_RX_ERROR);
}

static void send_ping_packet(uint32_t src_addr,uint32_t dst_addr,uint8_t len)
{
    tx_seq_cnt++;
                            
    tx_timestamp = TimerGetCurrentTime();
    
    // Send the next PING frame
    uint8_t index = 0;
    
    // header 
    Buffer[index++] = 0x00; // echo cmd
    
    Buffer[index++] = src_addr & 0xFF;
    Buffer[index++] = src_addr >> 8;
    Buffer[index++] = src_addr >> 16;
    Buffer[index++] = src_addr >> 24;

    Buffer[index++] = dst_addr & 0xFF;
    Buffer[index++] = dst_addr >> 8;
    Buffer[index++] = dst_addr >> 16;
    Buffer[index++] = dst_addr >> 24;
 
    Buffer[index++] = tx_seq_cnt & 0xFF;
    Buffer[index++] = tx_seq_cnt >> 8;
    Buffer[index++] = tx_seq_cnt >> 16;
    Buffer[index++] = tx_seq_cnt >> 24;    
    
    // data
    Buffer[index++] = 'P';
    Buffer[index++] = 'I';
    Buffer[index++] = 'N';
    Buffer[index++] = 'G';
    
    // 00,01,02...
    for( uint8_t i = 0; i < len - index ; i++)
    {
        Buffer[index + i] = i;
    }
    
    Radio.SetChannel( lora_radio_test_paras.tx_frequency );
    rt_thread_mdelay(1);
    Radio.Send( Buffer, len );
}

void init_tx_rx_timeout(void)
{
    /* unit£º ms */
    uint32_t packet_toa = Radio.TimeOnAir(lora_radio_test_paras.modem,lora_radio_test_paras.bw,lora_radio_test_paras.sf,lora_radio_test_paras.cr,LORA_PREAMBLE_LENGTH, LORA_FIX_LENGTH_PAYLOAD_ON_DISABLE,payload_len,true);
    tx_timeout = rx_timeout = packet_toa + 1000;  
}

void send_set_param(uint16_t src_addr, uint16_t dst_addr, uint32_t ts)
{
	uint8_t index = 0;
	Buffer[index++] = CMD_SET_PARAM|0x80;
	Buffer[index++] = src_addr & 0xFF;
	Buffer[index++] = src_addr >> 8;
	Buffer[index++] = dst_addr & 0xFF;
	Buffer[index++] = dst_addr >> 8;
	Buffer[index++] = ts & 0xFF;
	Buffer[index++] = ts >> 8;
	Buffer[index++] = ts >> 16;
	Buffer[index++] = ts >> 24;
	//rt_pin_write(LED0_PIN, PIN_LOW);
	Radio.SetChannel( lora_radio_test_paras.tx_frequency );
	rt_thread_mdelay(1);
	Radio.Send( Buffer, 64 );
}

int lora_radio_tester_init(void)
{
    if( lora_chip_initialized == false )
    {
        // Target board initialization
				rt_pin_write(RF_TXEN_PIN, PIN_LOW);
				rt_pin_write(RF_RXEN_PIN, PIN_LOW);
				rt_pin_mode(RF_TXEN_PIN, PIN_MODE_OUTPUT);
				rt_pin_mode(RF_RXEN_PIN, PIN_MODE_OUTPUT);

        if( lora_radio_test_thread == RT_NULL )
        {
            rt_event_init(&radio_event, "ev_lora_test", RT_IPC_FLAG_FIFO);

            lora_radio_test_thread = rt_thread_create("lora-radio-test",
                                                        lora_radio_test_thread_entry, 
                                                        RT_NULL,
                                                        512, 
                                                        2, 
                                                        10);
            if (lora_radio_test_thread != RT_NULL)
            {
                rt_thread_startup(lora_radio_test_thread);
            }
            else
                LORA_RADIO_DEBUG_LOG(LR_DBG_SHELL, LOG_LVL_INFO, "lora radio test thread create failed!\n");
        }
        
        /* Radio initialization */
        RadioEvents.TxDone = OnTxDone;
        RadioEvents.RxDone = OnRxDone;
        RadioEvents.TxTimeout = OnTxTimeout;
        RadioEvents.RxTimeout = OnRxTimeout;
        RadioEvents.RxError = OnRxError;

        if(Radio.Init(&RadioEvents))
        {
            lora_chip_initialized = true;
        }
        else
        {
            LORA_RADIO_DEBUG_LOG(LR_DBG_SHELL, LOG_LVL_INFO, "lora radio init failed!\n");
            
            return -1;
        }
  
        Radio.Standby();
        Radio.Sleep();
				Radio.Check();
				rt_event_send(&radio_event, EV_RADIO_INIT);
    }
    return 1;
}
//INIT_APP_EXPORT(lora_radio_tester_init);

static void radio_rx(void)
{
	rt_pin_write(RF_TXEN_PIN, PIN_LOW);
	rt_pin_write(RF_RXEN_PIN, PIN_HIGH);
	uint32_t freq = RF_FREQUENCY + ch_tab[rf_channel][0] * 200000;
	Radio.SetChannel( freq );
	Radio.Rx( RX_TIMEOUT_VALUE );
}

static void lora_radio_test_thread_entry(void* parameter)  
{
    rt_uint32_t ev = 0;

    while( 1 )                          
    {
        if (rt_event_recv(&radio_event, EV_RADIO_ALL,
                                        RT_EVENT_FLAG_OR | RT_EVENT_FLAG_CLEAR,
                                        RT_WAITING_FOREVER, &ev) == RT_EOK)
        {
            switch( ev )
            {
                case EV_RADIO_INIT:
								{
									init_tx_rx_timeout();
							
									Radio.SetChannel( lora_radio_test_paras.tx_frequency );
									lora_radio_test_paras.tx_frequency = lora_radio_test_paras.rx_frequency + lora_radio_test_paras.trx_frequency_offset;
							
									if( lora_radio_test_paras.modem == MODEM_LORA )
									{
											/* default private syncword for p2p test */
											Radio.SetPublicNetwork( lora_radio_test_paras.public_network );

											Radio.SetTxConfig( MODEM_LORA, lora_radio_test_paras.txpower, 0, lora_radio_test_paras.bw,
																										 lora_radio_test_paras.sf, lora_radio_test_paras.cr,
																										 LORA_PREAMBLE_LENGTH, LORA_FIX_LENGTH_PAYLOAD_ON_DISABLE,
																										 true, 0, 0, lora_radio_test_paras.iq_inversion, tx_timeout );

											Radio.SetRxConfig( MODEM_LORA, lora_radio_test_paras.bw, lora_radio_test_paras.sf,
																										 lora_radio_test_paras.cr, 0, LORA_PREAMBLE_LENGTH,
																										 LORA_SYMBOL_TIMEOUT, LORA_FIX_LENGTH_PAYLOAD_ON_DISABLE,
																										 0, true, 0, 0, lora_radio_test_paras.iq_inversion, true );                                                                              
									}
									else
									{
											Radio.SetTxConfig( MODEM_FSK, lora_radio_test_paras.txpower, FSK_FDEV, 0,
																										FSK_DATARATE, 0,
																										FSK_PREAMBLE_LENGTH, FSK_FIX_LENGTH_PAYLOAD_ON,
																										true, 0, 0, 0, 3000 );

											Radio.SetRxConfig( MODEM_FSK, FSK_BANDWIDTH, FSK_DATARATE,
																										0, FSK_AFC_BANDWIDTH, FSK_PREAMBLE_LENGTH,
																										0, FSK_FIX_LENGTH_PAYLOAD_ON, 0, true,
																										0, 0,false, true );
									}

									/* initlize the statistics parameters */
									rssi_value = -255;
									rssi_value_min = -255;
									rssi_value_max = -255;
									rssi_value_total = 0;
									snr_value = -128;
									snr_value_min = -128;
									snr_value_max = -128;
									snr_value_total = 0;
							
									tx_seq_cnt = 0;
									rx_timeout_cnt = 0;
									rx_error_cnt = 0;
									rx_correct_cnt = 0;
									//rt_pin_write(LED0_PIN, PIN_LOW);
									Radio.SetMaxPayloadLength(MODEM_LORA, 144);
									radio_rx();
								}
                break;
                  
								case EV_RADIO_RX_DONE:
								{
									timeout_cnt = 0;
									rt_pin_write(RF_RXEN_PIN, PIN_LOW);
									//rt_pin_write(LED0_PIN, PIN_HIGH);
									if(BufferSize == sizeof(cmd_packet_t))
									{
										if(cmd_pkt->target_id == self_id)
										{
											switch(cmd_pkt->cmd)
											{
												case CMD_TIME_BEACON:
													//sleep time by next short and long
													if(cmd_pkt->next_short==cmd_pkt->next_long)
													{
														sleep_time = cmd_pkt->next_long*60 - cmd_pkt->sec;
														wakeup_sign = 0x5a5a;
													}
													else if(cmd_pkt->next_short<cmd_pkt->next_long)
													{
														sleep_time = cmd_pkt->next_short*60 - cmd_pkt->sec;;
														wakeup_sign = 0x5a00;
													}
													else
													{
														sleep_time = cmd_pkt->next_long*60 - cmd_pkt->sec;;
														wakeup_sign = 0x005a;
													}
													rt_kprintf("beacon %d\r\n",sleep_time);
													if(ack_send == 0)
													{
														rt_kprintf("short 1 %d %d\r\n", cmd_pkt->next_short, cmd_pkt->next_long);
//														cmd_pkt->cmd |= 0x80;
//														if(sensor_err == 1)
//															cmd_pkt->cmd |= PKT_FLAG_ERROR;
//														rt_pin_write(RF_RXEN_PIN, PIN_LOW);
//														rt_pin_write(RF_TXEN_PIN, PIN_HIGH);
//														uint32_t freq = RF_FREQUENCY + ch_tab[rf_channel][3] * 200000;
//														Radio.SetChannel( freq );
//														rt_thread_mdelay(1);
//														rt_pin_write(LED0_PIN, PIN_LOW);
//														Radio.Send( Buffer, sizeof(cmd_packet_t) );
														//send short pkt
														short_pkt.target_id = self_id;
														short_pkt.type = PKT_TYPE_SHORT;
														if(sensor_err == 1)
															short_pkt.type |= PKT_FLAG_ERROR;
														memcpy(Buffer, &short_pkt, sizeof(short_pkt));
														uint32_t freq = RF_FREQUENCY + ch_tab[rf_channel][3] * 200000;
														Radio.SetChannel( freq );
														rt_thread_mdelay(1);
														rt_pin_write(LED0_PIN, PIN_LOW);
														rt_pin_write(RF_RXEN_PIN, PIN_LOW);
														rt_pin_write(RF_TXEN_PIN, PIN_HIGH);
														Radio.Send( Buffer, sizeof(short_pkt) );
													}
													else
													{
														if(sleep_time<15)
														{
															rt_thread_mdelay(sleep_time * 1000);
															radio_rx();
														}
														else
														{
															//goto sleep
															sleep_req = 1;
														}
													}
													break;
												case CMD_PKT_GETSHORT:
												{
													//send short pkt
													short_pkt.target_id = self_id;
													short_pkt.type = PKT_TYPE_SHORT;
													if(sensor_err == 1)
														short_pkt.type |= PKT_FLAG_ERROR;
													memcpy(Buffer, &short_pkt, sizeof(short_pkt));
													uint32_t freq = RF_FREQUENCY + ch_tab[rf_channel][3] * 200000;
													Radio.SetChannel( freq );
													rt_thread_mdelay(1);
													rt_pin_write(LED0_PIN, PIN_LOW);
													if(result_evt == 1)
													{
														rt_pin_write(RF_RXEN_PIN, PIN_LOW);
														rt_pin_write(RF_TXEN_PIN, PIN_HIGH);
														Radio.Send( Buffer, sizeof(short_pkt) );
														rt_kprintf("short 2\r\n");
													}
													else
													{
														radio_rx();
													}
												}
												break;
												case CMD_PKT_GETLONG:
												{
													//send long pkt by idx
													long_pkt.target_id = self_id;
													long_pkt.type = PKT_TYPE_LONG;
													if(sensor_err == 1)
														long_pkt.type |= PKT_FLAG_ERROR;
													long_idx = cmd_pkt->data;
													memcpy(long_pkt.wave, &wave[cmd_pkt->data*128], 128);
													memcpy(Buffer, &long_pkt, sizeof(long_pkt));
													uint32_t freq = RF_FREQUENCY + ch_tab[rf_channel][3] * 200000;
													Radio.SetChannel( freq );
													rt_thread_mdelay(1);
													rt_pin_write(LED0_PIN, PIN_LOW);
													if(wave_evt == 1)
													{
														rt_pin_write(RF_RXEN_PIN, PIN_LOW);
														rt_pin_write(RF_TXEN_PIN, PIN_HIGH);
														Radio.Send( Buffer, sizeof(long_pkt) );
														rt_kprintf("long %d\r\n", long_idx);
													}
													else
													{
														radio_rx();
													}
												}
												break;
											}
										}
										else
										{
											//not for us check cmd is beacon or not
											if(cmd_pkt->cmd == CMD_TIME_BEACON)
											{
												radio_rx();
											}
											else
											{
												sleep_time = 60-cmd_pkt->sec;
												rt_kprintf("nfu wait %d sec\r\n",sleep_time);
												if(sleep_time>15)
												{
													//wakeup_sign = 0x5a00;
													sleep_req = 1;
												}
												else
												{
													rt_thread_mdelay(sleep_time*1000);
													radio_rx();
												}
											}
										}
									}
									else
										radio_rx();
								}
								break;
								case EV_RADIO_TX_DONE:
								{
									rt_pin_write(RF_TXEN_PIN, PIN_LOW);
									timeout_cnt = 0;
									ack_send = 1;
									rt_pin_write(LED0_PIN, PIN_HIGH);
									
//									if(long_idx == 47)
//									{
//										rt_thread_mdelay(55000);
//										rt_hw_cpu_reset();
//									}
									radio_rx();
								}
								break;
								case EV_RADIO_RX_TIMEOUT:
								{
									rt_pin_write(RF_RXEN_PIN, PIN_LOW);
									timeout_cnt++;
									if(timeout_cnt == 5)
									{
										sleep_time = 60*15;
										wakeup_sign = 0x5a00;
										sleep_req = 1;
									}
									else
									{
										radio_rx();
									}
								}
								break;
								case EV_RADIO_RX_ERROR:
								{
									rt_pin_write(RF_RXEN_PIN, PIN_LOW);
//									rx_retry++;
//									if(rx_retry>20)
//									{
//										sleep_req = 1;
//									}
//									else
									{
										radio_rx();
									}
								}
								break;
								case EV_RADIO_TX_START:
								{
								}
								break;
                case EV_RADIO_TX_TIMEOUT:
								{
									rt_pin_write(RF_TXEN_PIN, PIN_LOW);
									radio_rx();
								}
								break;  
            }
        }
    } 
}
