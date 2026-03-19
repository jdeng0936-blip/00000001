#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>

#define M2M_CS_PIN	GET_PIN(E, 4)
#define M2M_INT_PIN	GET_PIN(I, 11)
#define M2M_RST_PIN	GET_PIN(F, 6)

#define M2M_THREAD_STACK_SIZE 512
#define M2M_THREAD_PRIO (RT_THREAD_PRIORITY_MAX*2/3)
static rt_uint8_t m2m_thread_stack[M2M_THREAD_STACK_SIZE];
static struct rt_thread m2m_thread;
extern SPI_HandleTypeDef hspi4;

volatile uint8_t m2m_irq = 0;
volatile uint8_t m2m_tx_evt = 0;
volatile uint8_t m2m_rx_evt = 0;
uint8_t m2m_stage = 0;

uint8_t m2m_cmd_buf[8] = {0xFF, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};

uint8_t calc_m2m_cmd_crc(uint8_t * data)
{
	uint8_t calc_crc = 0;
	for(int i=0;i<7;i++)
	{
		calc_crc += data[i];
	}
	calc_crc = ~calc_crc - 1;
	return calc_crc;
}

//FF 55 RW RL RH LL LH CRC
void m2m_write(uint16_t reg, uint8_t * pdata, uint16_t len)
{
	m2m_cmd_buf[2] = 0x00;
	m2m_cmd_buf[3] = reg;
	m2m_cmd_buf[4] = reg>>8;
	m2m_cmd_buf[5] = len;
	m2m_cmd_buf[6] = len>>8;
	m2m_cmd_buf[7] = calc_m2m_cmd_crc(m2m_cmd_buf);
	
	//cs_low
	rt_pin_write(M2M_CS_PIN, PIN_LOW);
	rt_thread_mdelay(10);
	m2m_tx_evt = 0;
	HAL_SPI_Transmit_DMA(&hspi4, m2m_cmd_buf, 8);
	while(m2m_tx_evt == 0)
		rt_thread_mdelay(1);
	rt_thread_mdelay(10);
//	while(m2m_irq == 0)
//		rt_thread_mdelay(1);
	m2m_tx_evt = 0;
	HAL_SPI_Transmit_DMA(&hspi4, pdata, len);
	while(m2m_tx_evt == 0)
		rt_thread_mdelay(1);
	//cs_high
	rt_pin_write(M2M_CS_PIN, PIN_HIGH);
	rt_thread_mdelay(10);
}
//FF 55 RW RL RH LL LH CRC
void m2m_read(uint8_t reg, uint8_t * pdata, uint32_t len)
{
	m2m_cmd_buf[2] = 0x01;
	m2m_cmd_buf[3] = reg;
	m2m_cmd_buf[4] = reg>>8;
	m2m_cmd_buf[5] = len;
	m2m_cmd_buf[6] = len>>8;
	m2m_cmd_buf[7] = calc_m2m_cmd_crc(m2m_cmd_buf);
	
	//cs_low
	rt_pin_write(M2M_CS_PIN, PIN_LOW);
	rt_thread_mdelay(10);
	m2m_tx_evt = 0;
	HAL_SPI_Transmit_DMA(&hspi4, m2m_cmd_buf, 8);
	while(m2m_tx_evt == 0)
		rt_thread_mdelay(1);
	rt_thread_mdelay(10);
	//wait int
//	while(m2m_irq == 0)
//		rt_thread_mdelay(1);
	m2m_rx_evt = 0;
	HAL_SPI_Receive_DMA(&hspi4, pdata, len);
	while(m2m_rx_evt == 0)
		rt_thread_mdelay(1);
	//cs_high
	rt_pin_write(M2M_CS_PIN, PIN_HIGH);
	rt_thread_mdelay(10);
}

void m2m_irq_handler(void * param)
{
	m2m_irq = 1;
}

uint8_t m2m_data_buf[16];
uint8_t m2m_data_buf1[16];

static void m2m_thread_entry(void *parameter)
{
	rt_pin_write(M2M_CS_PIN, PIN_HIGH);
	rt_pin_mode(M2M_CS_PIN, PIN_MODE_OUTPUT);
	
	rt_pin_write(M2M_RST_PIN, PIN_HIGH);
	rt_pin_mode(M2M_RST_PIN, PIN_MODE_OUTPUT);
	
	rt_pin_mode(M2M_INT_PIN, PIN_MODE_INPUT_PULLDOWN);
	rt_pin_attach_irq(M2M_INT_PIN, PIN_IRQ_MODE_RISING, m2m_irq_handler, RT_NULL);
	rt_pin_irq_enable(M2M_INT_PIN, ENABLE);
	rt_thread_mdelay(3000);
	for(int i=0;i<16;i++)
	{
		m2m_data_buf[i] = i;
	}
	while(1)
	{
		rt_thread_mdelay(10);
		if(m2m_irq == 1)
		{
			m2m_irq = 0;
			if(m2m_stage == 0)
			{
				m2m_stage = 1;
				m2m_read(0x0001, m2m_data_buf1, 16);
			}
			else
			{
				m2m_stage = 0;
				m2m_write(0x0001, m2m_data_buf, 16);
			}
		}
		for(int i=0;i<16;i++)
		{
			m2m_data_buf[i]++;
		}
	}
}

void M2M_HAL_SPI_RxCpltCallback(SPI_HandleTypeDef *hspi)
{
	m2m_rx_evt = 1;
}
void M2M_HAL_SPI_TxCpltCallback(SPI_HandleTypeDef *hspi)
{
	m2m_tx_evt = 1;
}
void HAL_SPI_ErrorCallback(SPI_HandleTypeDef *hspi)
{
	m2m_rx_evt = 1;
	m2m_tx_evt = 1;
}
static int m2m_thread_init(void)
{
	rt_err_t err;
	
	err = rt_thread_init(&m2m_thread, "m2m", m2m_thread_entry, RT_NULL,
			 &m2m_thread_stack[0], sizeof(m2m_thread_stack), M2M_THREAD_PRIO, 10);
	if(err != RT_EOK)
	{
		rt_kprintf("Failed to create M2M thread");
		return -1;
	}
	rt_thread_startup(&m2m_thread);

	return 0;
}
INIT_ENV_EXPORT(m2m_thread_init);
