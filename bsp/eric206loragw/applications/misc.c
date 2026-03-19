#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>
#include <dfs.h>
#include <dfs_fs.h>
#include <dfs_posix.h>

#include "main.h"
#include "sfdb.h"
#include <stdlib.h>

#include <netdb.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <webclient.h>
#include <mbedtls/md5.h>

#define UPDATE_CMD		0x982055AA
extern RTC_HandleTypeDef RTC_Handler;
extern char fmd51[];
#define LAZY_THREAD_STACK_SIZE 8192
#define LAZY_THREAD_PRIO 28
static struct rt_thread lazy_thread;
static rt_uint8_t * lazy_thread_stack;

volatile uint8_t update_req = 0;
volatile uint8_t checksum_req = 0;
volatile uint8_t update_start = 0;
char update_url[256];

extern struct rt_memheap ccm_heap;

#define MD5_BUF_SIZE 1024
int md5_file(const char *filename, unsigned char *md5sum)
{
    int ret = -1;
    mbedtls_md5_context ctx;
    unsigned char buf[MD5_BUF_SIZE];
    int n;

    mbedtls_md5_init(&ctx);

    FILE *fp = fopen(filename, "rb");
    if (fp == NULL)
    {
        rt_kprintf("Failed to open file %s\n", filename);
        goto exit;
    }

    mbedtls_md5_starts(&ctx);

    while ((n = fread(buf, 1, MD5_BUF_SIZE, fp)) > 0)
    {
        mbedtls_md5_update(&ctx, buf, n);
    }

    mbedtls_md5_finish(&ctx, md5sum);

    ret = 0;

exit:
    if (fp != NULL)
    {
        fclose(fp);
    }
    mbedtls_md5_free(&ctx);

    return ret;
}

static void lazy_thread_entry(void *parameter)
{
	while(1)
	{
		rt_thread_mdelay(1000);
		if(update_req == 1)
		{
			update_req = 0;
			rt_kprintf("url: %s\r\n", update_url);
			if(WEBCLIENT_OK == webclient_get_file((const char *)update_url, "rtthread.bin"))
			{
				checksum_req = 1;
			}
		}
		if(checksum_req == 1)
		{
			checksum_req = 0;
			unsigned char md5sum1[16];
			md5_file("/rtthread.bin", md5sum1);
			char f1[33] = {0};
			sprintf(f1, "%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x%02x", md5sum1[0], md5sum1[1], md5sum1[2], md5sum1[3], md5sum1[4], md5sum1[5], md5sum1[6], md5sum1[7], md5sum1[8]
			, md5sum1[9], md5sum1[10], md5sum1[11], md5sum1[12], md5sum1[13], md5sum1[14], md5sum1[15]);
			if(0 == strcasecmp(f1, fmd51))
			{
				update_start = 1;
			}
		}
		if(update_start == 1)
		{
			update_start = 0;
			HAL_RTCEx_BKUPWrite(&RTC_Handler, RTC_BKP_DR2, UPDATE_CMD);
			rt_thread_mdelay(1000);
			rt_hw_cpu_reset();
		}
	}
}

static int misc_thread_init(void)
{
		rt_err_t err;
		lazy_thread_stack = rt_memheap_alloc(&ccm_heap, LAZY_THREAD_STACK_SIZE);

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
