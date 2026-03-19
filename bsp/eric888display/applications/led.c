#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>
#include <drv_ext_io.h>
#include <dfs.h>
#include <dfs_fs.h>
#include <lvgl.h>
#include <lcd_port.h>
#include "main.h"

#define LED_PWR_PIN			GET_PIN(H, 9)
#define LED_ERROR_PIN		GET_PIN(H, 10)
#define LED_MAIN_PIN		GET_PIN(H, 11)
#define LED_BACKUP_PIN	GET_PIN(H, 12)

#define LED_THREAD_STACK_SIZE 512
#define LED_THREAD_PRIO (RT_THREAD_PRIORITY_MAX - 2)
static rt_uint8_t * led_thread_stack;
static struct rt_thread led_thread;

extern struct rt_memheap system_heap;

static void led_thread_entry(void *parameter)
{
	rt_pin_write(LED_PWR_PIN, PIN_LOW);
	rt_pin_mode(LED_PWR_PIN, PIN_MODE_OUTPUT);
	rt_pin_write(LED_ERROR_PIN, PIN_LOW);
	rt_pin_mode(LED_ERROR_PIN, PIN_MODE_OUTPUT);
	rt_pin_write(LED_MAIN_PIN, PIN_LOW);
	rt_pin_mode(LED_MAIN_PIN, PIN_MODE_OUTPUT);
	rt_pin_write(LED_BACKUP_PIN, PIN_LOW);
	rt_pin_mode(LED_BACKUP_PIN, PIN_MODE_OUTPUT);
	while(1)
	{
		rt_thread_mdelay(500);
		rt_pin_write(LED_PWR_PIN, PIN_HIGH);
		rt_thread_mdelay(500);
		rt_pin_write(LED_PWR_PIN, PIN_LOW);
	}
}

static int led_thread_init(void)
{
	rt_err_t err;
	
	led_thread_stack = rt_memheap_alloc(&system_heap, LED_THREAD_STACK_SIZE);

	err = rt_thread_init(&led_thread, "LED", led_thread_entry, RT_NULL,
			 led_thread_stack, LED_THREAD_STACK_SIZE, LED_THREAD_PRIO, 10);
	if(err != RT_EOK)
	{
		rt_kprintf("Failed to create LED thread");
		return -1;
	}
	rt_thread_startup(&led_thread);

	return 0;
}
INIT_ENV_EXPORT(led_thread_init);
