#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>
#include <drv_ext_io.h>
#include <dfs.h>
#include <dfs_fs.h>
#include <lvgl.h>
#include <lcd_port.h>
#include <dfs_posix.h>
#include <mbedtls/md5.h>

#include <netdb.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <webclient.h>

#include "main.h"
#include "at24cxx.h"
#include "sfdb.h"
#include <stdlib.h>

#define OKY_PIN		GET_PIN(G, 13)
#define IO1_PIN		GET_PIN(G, 14)
#define BUSY_PIN	GET_PIN(C, 7)

#define MISC_THREAD_STACK_SIZE 512
#define MISC_THREAD_PRIO 29
static rt_uint8_t * misc_thread_stack;
static struct rt_thread misc_thread;

#define LAZY_THREAD_STACK_SIZE 8192
#define LAZY_THREAD_PRIO 28
static rt_uint8_t * lazy_thread_stack;
static struct rt_thread lazy_thread;

extern volatile uint8_t touch_pressed;

volatile uint32_t dwt_fac_us;
volatile uint32_t dwt_fac_ms;
/**
  * @brief  initialize dwt delay function   
  * @param  none
  * @retval none
  */
void dwt_delay_init()
{
	/* configure dwt */	
  dwt_fac_us = SystemCoreClock / (1000000U);
  dwt_fac_ms = dwt_fac_us * (1000U);	
}

/**
  * @brief  inserts a dwt delay time.
  * @param  nus: specifies the dwt delay time length, in microsecond.
  * @retval none
  */
void dwt_delay_us(uint32_t nus)
{
	/* Enable CoreDebug DEMCR bit24: TRCENA */
	CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
 	/* Clear CYCCNT */
	DWT->CYCCNT = 0x00;
 	/* Enable DWT CTRL bit0: CYCCNTENA */	
	DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
	
	uint32_t temp = DWT->CYCCNT;
  while((DWT->CYCCNT - temp) < (nus * dwt_fac_us - 40));

 	/* Disable DWT CTRL bit0: CYCCNTENA */	
	DWT->CTRL &= ~DWT_CTRL_CYCCNTENA_Msk;
 	/* Clear CYCCNT */
	DWT->CYCCNT = 0x00;
	/* Disable CoreDebug DEMCR bit24: TRCENA */
	CoreDebug->DEMCR &= ~CoreDebug_DEMCR_TRCENA_Msk;
}

void voice_send(uint8_t idx)
{
	rt_base_t level = rt_hw_interrupt_disable();
	rt_pin_write(OKY_PIN, PIN_HIGH);
	dwt_delay_us(100);
	rt_pin_write(IO1_PIN, PIN_HIGH);
	dwt_delay_us(100);
	rt_pin_write(IO1_PIN, PIN_LOW);
	dwt_delay_us(100);
	rt_pin_write(IO1_PIN, PIN_HIGH);
	dwt_delay_us(100);
	for(int i =0;i<idx;i++)
	{
		rt_pin_write(OKY_PIN, PIN_LOW);
		dwt_delay_us(100);
		rt_pin_write(OKY_PIN, PIN_HIGH);
		dwt_delay_us(100);
	}
	rt_hw_interrupt_enable(level);
	while(rt_pin_read(BUSY_PIN) == PIN_HIGH)
		rt_thread_mdelay(1);
	rt_pin_write(IO1_PIN, PIN_LOW);
	dwt_delay_us(100);
	rt_pin_write(OKY_PIN, PIN_LOW);
	dwt_delay_us(100);
}

static void misc_thread_entry(void *parameter)
{
	dwt_delay_init();

	rt_pin_write(OKY_PIN, PIN_LOW);
	rt_pin_mode(OKY_PIN, PIN_MODE_OUTPUT);
	
	rt_pin_write(IO1_PIN, PIN_LOW);
	rt_pin_mode(IO1_PIN, PIN_MODE_OUTPUT);
	
	rt_pin_mode(BUSY_PIN, PIN_MODE_INPUT);
	
	while(1)
	{
		rt_thread_mdelay(10);
		if(touch_pressed == 1)
		{
			touch_pressed = 0;
			if(rt_pin_read(BUSY_PIN) == PIN_LOW)
				voice_send(42);
		}
	}
}

static void lazy_thread_entry(void *parameter)
{
	while(1)
	{
		rt_thread_mdelay(10);
	}
}

static int misc_thread_init(void)
{
    rt_err_t err;
	
		misc_thread_stack = rt_memheap_alloc(&system_heap, MISC_THREAD_STACK_SIZE);

    err = rt_thread_init(&misc_thread, "MISC", misc_thread_entry, RT_NULL,
           misc_thread_stack, MISC_THREAD_STACK_SIZE, MISC_THREAD_PRIO, 10);
    if(err != RT_EOK)
    {
        rt_kprintf("Failed to create MISC thread");
        return -1;
    }
    rt_thread_startup(&misc_thread);
		
		lazy_thread_stack = rt_memheap_alloc(&system_heap, LAZY_THREAD_STACK_SIZE);

    err = rt_thread_init(&lazy_thread, "LAZY", lazy_thread_entry, RT_NULL,
           lazy_thread_stack, LAZY_THREAD_STACK_SIZE, LAZY_THREAD_PRIO, 10);
    if(err != RT_EOK)
    {
        rt_kprintf("Failed to create LAZY thread");
        return -1;
    }
    rt_thread_startup(&lazy_thread);

    return 0;
}
INIT_ENV_EXPORT(misc_thread_init);
