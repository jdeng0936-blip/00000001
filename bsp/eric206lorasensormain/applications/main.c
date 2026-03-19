/*
 * Copyright (c) 2006-2018, RT-Thread Development Team
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Change Logs:
 * Date           Author       Notes
 * 2018-11-27     balanceTWK   first version
 */

#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>

#include "lora-radio-rtos-config.h"
#include "lora-radio.h"
#include "lora-radio-timer.h"
#include "lora_work.h"

#include "settings.h"
/* defined the LED0 pin: PC0 */
#define LED0_PIN    GET_PIN(B, 7)

#define RF_TXEN_PIN    GET_PIN(B, 3)
#define RF_RXEN_PIN    GET_PIN(B, 4)

#define DIO_PIN    GET_PIN(A, 0)
#define DC_CTL_PIN    GET_PIN(A, 1)
#define UTX_PIN    GET_PIN(A, 2)
#define URX_PIN    GET_PIN(A, 3)

#define SPI_NSS_PIN    GET_PIN(A, 4)
#define SPI_CLK_PIN    GET_PIN(A, 5)
#define SPI_MISO_PIN    GET_PIN(A, 6)
#define SPI_MOSI_PIN    GET_PIN(A, 7)

#define RF_RESET_PIN    GET_PIN(B, 0)
#define BAT_ADC_PIN    GET_PIN(B, 1)
#define SENSOR_CTL_PIN    GET_PIN(B, 2)

extern RTC_HandleTypeDef RTC_Handler;
extern ADC_HandleTypeDef hadc;
extern UART_HandleTypeDef huart;
extern SPI_HandleTypeDef hspi;

rt_timer_t second_timer;
rt_adc_device_t adc_device = RT_NULL;
float fv = 0.0f;

uint8_t cnt = 0;
volatile uint8_t sleep_req = 0;

uint16_t sleep_cnt = 0;

volatile uint8_t work_cons = 0;

uint8_t wakeup_slot = 0;

volatile uint8_t result_ava = 0;
volatile uint8_t radio_inited = 0;
extern short_packet_t short_pkt;

extern volatile uint8_t calc_data_evt;
extern volatile uint8_t calc_evt;
extern volatile uint8_t result_evt;
extern volatile uint8_t wave_evt;
volatile uint8_t wave_req = 0;
uint8_t wave_idx = 0;
extern void send_get_crc_data(void);
extern void send_calc(void);
extern void send_get_result(void);
extern void send_get_wave(void);
extern int lora_radio_tester_init(void);

extern uint16_t wakeup_sign;
uint16_t wakeup_sign_bk;
extern uint16_t sleep_time;
volatile uint8_t settings_save_req = 0;
uint16_t ack_send = 0;
extern void save_settings(void);
extern void get_settings(void);
uint8_t second_cnt = 0;
volatile uint8_t sensor_err = 0;
void enter_sleep(void)
{
	GPIO_InitTypeDef GPIO_InitStruct = {0};
	HAL_RTCEx_BKUPWrite(&RTC_Handler, RTC_BKP_DR2, wakeup_sign);
	HAL_RTCEx_BKUPWrite(&RTC_Handler, RTC_BKP_DR3, ack_send);
//	HAL_RTCEx_BKUPWrite(&RTC_Handler, RTC_BKP_DR4, ~short_set);
	HAL_RTCEx_DeactivateWakeUpTimer(&RTC_Handler);
	
	if((wakeup_sign&0xFF) == 0x5a)
	{
		sleep_time -= 9;
	}
	else
	{
		sleep_time -= 4;
	}

//	rt_pin_mode(DIO_PIN, PIN_MODE_INPUT);

//	rt_pin_mode(DC_CTL_PIN, PIN_MODE_INPUT);

//	rt_pin_write(UTX_PIN, PIN_LOW);
//	rt_pin_write(URX_PIN, PIN_LOW);
//	rt_pin_mode(UTX_PIN, PIN_MODE_OUTPUT);
//	rt_pin_mode(URX_PIN, PIN_MODE_OUTPUT);
//	
//	rt_pin_write(RF_TXEN_PIN, PIN_LOW);
//	rt_pin_write(RF_RXEN_PIN, PIN_LOW);
//	rt_pin_mode(RF_TXEN_PIN, PIN_MODE_OUTPUT);
//	rt_pin_mode(RF_RXEN_PIN, PIN_MODE_OUTPUT);

//	rt_pin_write(SPI_NSS_PIN, PIN_HIGH);
//	rt_pin_mode(SPI_NSS_PIN, PIN_MODE_OUTPUT);
//	
//	//rt_pin_write(SPI_CLK_PIN, PIN_LOW);
//	rt_pin_mode(SPI_CLK_PIN, PIN_MODE_INPUT);
//	
//	rt_pin_mode(SPI_MISO_PIN, PIN_MODE_INPUT);
//	
//	//rt_pin_write(SPI_MOSI_PIN, PIN_HIGH);
//	rt_pin_mode(SPI_MOSI_PIN, PIN_MODE_INPUT);

//	//rt_pin_write(RF_RESET_PIN, PIN_LOW);
//	rt_pin_mode(RF_RESET_PIN, PIN_MODE_INPUT);
//	
//	rt_pin_write(BAT_ADC_PIN, PIN_HIGH);
//	rt_pin_mode(BAT_ADC_PIN, PIN_MODE_OUTPUT);

//	rt_pin_write(SENSOR_CTL_PIN, PIN_LOW);
//	rt_pin_mode(SENSOR_CTL_PIN, PIN_MODE_OUTPUT);

	HAL_ADC_DeInit(&hadc);
	HAL_SPI_DeInit(&hspi);
	HAL_UART_DeInit(&huart);

	/*Configure GPIO pin Output Level */
	HAL_GPIO_WritePin(GPIOA, GPIO_PIN_4, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_1|GPIO_PIN_2|GPIO_PIN_3, GPIO_PIN_RESET);
	HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5|GPIO_PIN_7, GPIO_PIN_RESET);
	HAL_GPIO_WritePin(GPIOB, GPIO_PIN_2|GPIO_PIN_3|GPIO_PIN_4, GPIO_PIN_RESET);
	HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0|GPIO_PIN_7, GPIO_PIN_SET);

  /*Configure GPIO pin Output Level */
  //HAL_GPIO_WritePin(GPIOB, GPIO_PIN_3|GPIO_PIN_4, GPIO_PIN_RESET);

  /*Configure GPIO pin : PC13 */
  GPIO_InitStruct.Pin = GPIO_PIN_13;
  GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);

  /*Configure GPIO pins : PH0 PH1 */
  GPIO_InitStruct.Pin = GPIO_PIN_0|GPIO_PIN_1;
  GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOH, &GPIO_InitStruct);

  /*Configure GPIO pins : DIO_Pin DC_CTL_Pin UTX_Pin URX_Pin
                           PA5 PA6 PA7 PA8
                           PA9 PA10 PA11 PA12
                           PA15 */
  GPIO_InitStruct.Pin = GPIO_PIN_0
                          |GPIO_PIN_6|GPIO_PIN_8
                          |GPIO_PIN_9|GPIO_PIN_10|GPIO_PIN_11|GPIO_PIN_12
                          |GPIO_PIN_15;
  GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

//  /*Configure GPIO pin : RF_NSS_Pin */
  GPIO_InitStruct.Pin = GPIO_PIN_1|GPIO_PIN_2|GPIO_PIN_3|GPIO_PIN_4|GPIO_PIN_5|GPIO_PIN_7;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
	
	GPIO_InitStruct.Pin = GPIO_PIN_0|GPIO_PIN_2|GPIO_PIN_3|GPIO_PIN_4|GPIO_PIN_7;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

  /*Configure GPIO pins : RF_RESET_Pin RF_TXEN_Pin RF_RXEN_Pin LED_Pin */
//  GPIO_InitStruct.Pin = GPIO_PIN_3|GPIO_PIN_4;
//  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
//  GPIO_InitStruct.Pull = GPIO_NOPULL;
//  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
//  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

  /*Configure GPIO pins : BAT_ADC_Pin SENSOR_CTL_Pin PB10 PB11
                           PB12 PB13 PB14 PB15
                           PB5 PB6 PB8 PB9 */
  GPIO_InitStruct.Pin = GPIO_PIN_1|GPIO_PIN_10|GPIO_PIN_11
                          |GPIO_PIN_12|GPIO_PIN_13|GPIO_PIN_14|GPIO_PIN_15
                          |GPIO_PIN_5|GPIO_PIN_6|GPIO_PIN_8|GPIO_PIN_9;
  GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
	
	
	__HAL_RCC_GPIOC_CLK_DISABLE();
	__HAL_RCC_GPIOD_CLK_DISABLE();
	__HAL_RCC_GPIOE_CLK_DISABLE();
	__HAL_RCC_GPIOH_CLK_DISABLE();
	__HAL_RCC_GPIOA_CLK_DISABLE();
	__HAL_RCC_GPIOB_CLK_DISABLE();
	
	__HAL_PWR_CLEAR_FLAG(PWR_FLAG_WU);
	//HAL_PWR_EnterSTANDBYMode();
	SysTick->CTRL &=~1;
	SCB->ICSR |= SCB_ICSR_PENDSTCLR_Msk;
	HAL_RTCEx_SetWakeUpTimer_IT(&RTC_Handler, sleep_time, RTC_WAKEUPCLOCK_CK_SPRE_16BITS);
	HAL_PWR_EnterSTOPMode(PWR_LOWPOWERREGULATOR_ON, PWR_STOPENTRY_WFI);
	rt_hw_cpu_reset();
}

int main(void)
{
	/* set LED0 pin mode to output */
	rt_pin_write(RF_TXEN_PIN, PIN_LOW);
	rt_pin_write(RF_RXEN_PIN, PIN_LOW);
	rt_pin_mode(RF_TXEN_PIN, PIN_MODE_OUTPUT);
	rt_pin_mode(RF_RXEN_PIN, PIN_MODE_OUTPUT);
	
//	rt_pin_write(RF_RESET_PIN, PIN_LOW);
//	rt_pin_mode(RF_RESET_PIN, PIN_MODE_OUTPUT);
//	
	rt_pin_mode(LED0_PIN, PIN_MODE_OUTPUT);
	rt_pin_write(LED0_PIN, PIN_HIGH);
	rt_pin_write(SENSOR_CTL_PIN, PIN_HIGH);
	rt_pin_mode(SENSOR_CTL_PIN, PIN_MODE_OUTPUT);
	rt_pin_write(DC_CTL_PIN, PIN_HIGH);
	rt_pin_mode(DC_CTL_PIN, PIN_MODE_OUTPUT);
	struct timeval tv = { 0 };
	gettimeofday(&tv, RT_NULL);
	
//	if(__HAL_PWR_GET_FLAG(PWR_FLAG_SB) != RESET)
//	{
//		/* Clear Standby flag */
//		__HAL_PWR_CLEAR_FLAG(PWR_FLAG_SB); 
//	}
	
	if(__HAL_PWR_GET_FLAG(PWR_FLAG_WU) != RESET)
	{
		/* Clear Standby flag */
		__HAL_PWR_CLEAR_FLAG(PWR_FLAG_WU); 
	}
	
	__HAL_RCC_CLEAR_RESET_FLAGS();
	//read config store for settings
	
//	//read next long pkt ts
	wakeup_sign = wakeup_sign_bk = HAL_RTCEx_BKUPRead(&RTC_Handler, RTC_BKP_DR2);
	ack_send = HAL_RTCEx_BKUPRead(&RTC_Handler, RTC_BKP_DR3);
//	short_set_checksum = HAL_RTCEx_BKUPRead(&RTC_Handler, RTC_BKP_DR4);
//	//check if long pkt ts is ok
//	if(short_set != (~short_set_checksum))
//	{
//		short_set = 0;
//		long_set = 0;
//	}
	
	adc_device = (rt_adc_device_t)rt_device_find("adc1");
	rt_int16_t voltage = rt_adc_voltage(adc_device, 9);
	fv = (float)voltage * 17.5f/7.5f;
	fv /=1000.0f;
	
	rt_pin_write(DC_CTL_PIN, PIN_LOW);
	
	short_pkt.bat = fv;
	
	get_settings();
	
	while (1)
	{
		//rt_pin_write(LED0_PIN, PIN_HIGH);
		//rt_thread_mdelay(100);
		//rt_pin_write(LED0_PIN, PIN_LOW);
		rt_thread_mdelay(1000);
		second_cnt++;
		if((wakeup_sign_bk&0xFF) == 0x5a)
		{
			if(result_evt == 0)
			{
				send_get_result();
			}
			else if(wave_req == 0)
			{
				send_get_wave();
				wave_req = 1;
			}
			if(wave_evt == 1)
			{
				rt_pin_write(SENSOR_CTL_PIN, PIN_LOW);
				if(radio_inited == 0)
				{
					radio_inited = 1;
					lora_radio_tester_init();
				}
			}
			//long pkt
			if((second_cnt > 10)&&(wave_evt == 0))
			{
				sensor_err = 1;
				result_evt = 1;
				wave_evt = 1;
				rt_pin_write(SENSOR_CTL_PIN, PIN_LOW);
			}
		}
		else
		{
			if(result_evt == 0)
			{
				send_get_result();
			}
			if(result_evt == 1)
			{
				rt_pin_write(SENSOR_CTL_PIN, PIN_LOW);
				if(radio_inited == 0)
				{
					radio_inited = 1;
					lora_radio_tester_init();
				}
			}
			if((second_cnt > 5)&&(result_evt == 0))
			{
				sensor_err = 1;
				result_evt = 1;
				rt_pin_write(SENSOR_CTL_PIN, PIN_LOW);
			}
		}
		
		if(settings_save_req == 1)
		{
			settings_save_req = 0;
			save_settings();
			rt_thread_mdelay(1000);
			rt_hw_cpu_reset();
		}
		
		if(sleep_req == 1)
		{
			sleep_req = 0;
			//__disable_irq();
			enter_sleep();
		}
	}

	return RT_EOK;
}
void ADC_GPIO_EXTI_Callback(void)
{
}
void RST_GPIO_EXTI_Callback(void)
{
}
/**
  * @brief This function handles RTC wake-up interrupt through EXTI line 20.
  */
void RTC_WKUP_IRQHandler(void)
{
  /* USER CODE BEGIN RTC_WKUP_IRQn 0 */

  /* USER CODE END RTC_WKUP_IRQn 0 */
  HAL_RTCEx_WakeUpTimerIRQHandler(&RTC_Handler);
  /* USER CODE BEGIN RTC_WKUP_IRQn 1 */

  /* USER CODE END RTC_WKUP_IRQn 1 */
}
