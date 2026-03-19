#include <rtthread.h>
#include <rtdevice.h>
#include <board.h>
#include <drv_ext_io.h>
#include <dfs.h>
#include <dfs_fs.h>
//#include <drivers/rt_drv_pwm.h>
#include <drv_spi.h>
#include "ui.h"
#include "main.h"

#define M2M_CS_PIN	GET_PIN(E, 4)
#define M2M_INT_PIN	GET_PIN(I, 11)

#define M2M_THREAD_STACK_SIZE 8192
#define M2M_THREAD_PRIO 19
static rt_uint8_t m2m_thread_stack[M2M_THREAD_STACK_SIZE];
static struct rt_thread m2m_thread;

SPI_HandleTypeDef hspi4;
DMA_HandleTypeDef hdma_spi4_rx;
DMA_HandleTypeDef hdma_spi4_tx;

volatile uint8_t m2m_tx_evt = 0;
volatile uint8_t m2m_rx_evt = 0;
volatile uint8_t m2m_stage = 0;
uint8_t m2m_cmd_buffer[16];
volatile uint32_t rx_cnt = 0;

uint8_t m2m_rw_buf[8192];

uint8_t m2m_cmd_buf[8] = {0x00};

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

/**
  * @brief SPI4 Initialization Function
  * @param None
  * @retval None
  */
static void MX_SPI4_Init(void)
{

  /* USER CODE BEGIN SPI4_Init 0 */
	__HAL_RCC_DMA2_CLK_ENABLE();
  /* USER CODE END SPI4_Init 0 */

  /* USER CODE BEGIN SPI4_Init 1 */

  /* USER CODE END SPI4_Init 1 */
  /* SPI4 parameter configuration*/
  hspi4.Instance = SPI4;
  hspi4.Init.Mode = SPI_MODE_SLAVE;
  hspi4.Init.Direction = SPI_DIRECTION_2LINES;
  hspi4.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi4.Init.CLKPolarity = SPI_POLARITY_LOW;
  hspi4.Init.CLKPhase = SPI_PHASE_1EDGE;
  hspi4.Init.NSS = SPI_NSS_SOFT;
  hspi4.Init.FirstBit = SPI_FIRSTBIT_MSB;
  hspi4.Init.TIMode = SPI_TIMODE_DISABLE;
  hspi4.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
  hspi4.Init.CRCPolynomial = 10;
  if (HAL_SPI_Init(&hspi4) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN SPI4_Init 2 */
	
	/* DMA2_Stream1_IRQn interrupt configuration */
  HAL_NVIC_SetPriority(DMA2_Stream1_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA2_Stream1_IRQn);
  /* DMA2_Stream3_IRQn interrupt configuration */
  HAL_NVIC_SetPriority(DMA2_Stream3_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA2_Stream3_IRQn);

  /* USER CODE END SPI4_Init 2 */

}

void m2m_cs_handler(void * param)
{
	if(rt_pin_read(M2M_CS_PIN) == PIN_LOW)
	{
		m2m_rx_evt = 0;
		m2m_tx_evt = 0;
		m2m_stage = 0;
		hspi4.Instance->CR1 &=~ SPI_CR1_SSI;
		HAL_SPI_Receive_DMA(&hspi4, m2m_cmd_buf, 8);
		
		rt_kprintf("m2m cs low\r\n");
	}
	else
	{
		hspi4.Instance->CR1 |= SPI_CR1_SSI;
		rt_kprintf("m2m cs high\r\n");
	}
}

static void m2m_thread_entry(void *parameter)
{
	MX_SPI4_Init();
	rt_pin_write(M2M_INT_PIN, PIN_LOW);
	rt_pin_mode(M2M_INT_PIN, PIN_MODE_OUTPUT);
	rt_pin_mode(M2M_CS_PIN, PIN_MODE_INPUT_PULLUP);
	rt_pin_attach_irq(M2M_CS_PIN, PIN_IRQ_MODE_RISING_FALLING, m2m_cs_handler, RT_NULL);
	rt_pin_irq_enable(M2M_CS_PIN, ENABLE);
	while(1)
	{
		rt_thread_mdelay(5000);
		rt_pin_write(M2M_INT_PIN, PIN_HIGH);
		rt_thread_mdelay(10);
		rt_pin_write(M2M_INT_PIN, PIN_LOW);
		rt_thread_mdelay(10);
	}
}
void M2M_HAL_SPI_RxCpltCallback(void)
{
	if(m2m_stage == 0)
	{
		m2m_stage = 1;
		uint8_t crc = calc_m2m_cmd_crc(m2m_cmd_buf);
		if((m2m_cmd_buf[0] == 0xFF)&&(m2m_cmd_buf[1] == 0x55)&&(crc == m2m_cmd_buf[7]))
		{
			uint16_t reg = (m2m_cmd_buf[4]<<8)|m2m_cmd_buf[3];
			uint16_t len = (m2m_cmd_buf[6]<<8)|m2m_cmd_buf[5];
			if(m2m_cmd_buf[2] == 0x01)
			{
				HAL_SPI_Transmit_DMA(&hspi4, &m2m_rw_buf[reg], len);
			}
			else
			{
				HAL_SPI_Receive_DMA(&hspi4, &m2m_rw_buf[reg], len);
			}
		}
	}
	else
	{
		m2m_rx_evt = 1;
	}
}
void M2M_HAL_SPI_TxCpltCallback(void)
{
	m2m_tx_evt = 1;
}

void DMA2_Stream1_IRQHandler(void)
{
  /* USER CODE BEGIN DMA2_Stream1_IRQn 0 */
	rt_interrupt_enter();
  /* USER CODE END DMA2_Stream1_IRQn 0 */
  HAL_DMA_IRQHandler(&hdma_spi4_tx);
  /* USER CODE BEGIN DMA2_Stream1_IRQn 1 */
	rt_interrupt_leave();
  /* USER CODE END DMA2_Stream1_IRQn 1 */
}

void DMA2_Stream3_IRQHandler(void)
{
  /* USER CODE BEGIN DMA2_Stream3_IRQn 0 */
	rt_interrupt_enter();
  /* USER CODE END DMA2_Stream3_IRQn 0 */
  HAL_DMA_IRQHandler(&hdma_spi4_rx);
  /* USER CODE BEGIN DMA2_Stream3_IRQn 1 */
	rt_interrupt_leave();
  /* USER CODE END DMA2_Stream3_IRQn 1 */
}

void SPI4_IRQHandler(void)
{
  /* USER CODE BEGIN SPI4_IRQn 0 */
	rt_interrupt_enter();
  /* USER CODE END SPI4_IRQn 0 */
  HAL_SPI_IRQHandler(&hspi4);
  /* USER CODE BEGIN SPI4_IRQn 1 */
	rt_interrupt_leave();
  /* USER CODE END SPI4_IRQn 1 */
}

static int m2m_thread_init(void)
{
	rt_err_t err;

	err = rt_thread_init(&m2m_thread, "m2m", m2m_thread_entry, RT_NULL,
			 &m2m_thread_stack[0], sizeof(m2m_thread_stack), M2M_THREAD_PRIO, 10);
	if(err != RT_EOK)
	{
		rt_kprintf("Failed to create MISC thread");
		return -1;
	}
	rt_thread_startup(&m2m_thread);

	return 0;
}
INIT_ENV_EXPORT(m2m_thread_init);
