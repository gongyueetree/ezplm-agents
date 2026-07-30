/**
 * 测试 fixture。
 *
 * 硬规定：**这个文件里的每一个字符串都必须是从真实系统里拿出来的。**
 * 不允许自己编例子。自编的例子只能证明代码符合自己的想象，
 * 真实字符串才能证明代码能处理真实的脏数据。
 *
 * 来源都是公开的元器件型号与封装名，不含内部标识。
 */

/** 电阻型号 -> 预期阻值（Ω）。全部取自真实 BOM 行与映射字典。 */
export const RESISTOR_MPN_FIXTURES: Array<{ mpn: string; ohm: number; note?: string }> = [
  { mpn: '0603WAF1004T5E', ohm: 1e6 },
  { mpn: '0603WAF5103T5E', ohm: 510e3 },
  { mpn: '0603WAF3002T5E', ohm: 30e3 },
  { mpn: '0603WAF1054T5E', ohm: 1.05e6, note: '与其描述一致，用作正向样本' },
  { mpn: '0402WGF1502TCE', ohm: 15e3 },
  { mpn: '0402WGJ0334TCE', ohm: 330e3 },
  { mpn: 'FRC0603J472_TS', ohm: 4.7e3, note: '映射字典里有一条 910k 错误地指向了它' },
  { mpn: 'FRC0402F2212TS', ohm: 22.1e3 },
  { mpn: 'RT0603BRE074K02L', ohm: 4.02e3 },
];

/** 封装串 -> 预期归一化键。这组覆盖了 KiCad 与厂商私有库的两种风格。 */
export const FOOTPRINT_FIXTURES: Array<{ raw: string; canon: string; note?: string }> = [
  { raw: 'R_0603_1608Metric', canon: 'CHIP-0603' },
  { raw: 'C_0402_1005Metric', canon: 'CHIP-0402' },
  { raw: 'L_0805_2012Metric', canon: 'CHIP-0805', note: '磁珠也可能用 R_ 前缀，所以 canon 不能编码类型' },
  { raw: 'R_0603_1608Metric_Pad0.98x0.95mm_HandSolder', canon: 'CHIP-0603' },
  { raw: 'SOIC-8_3.9x4.9mm_P1.27mm', canon: 'SOIC-8_P1.27' },
  { raw: 'STC_SOP-16_3.9x9.9mm_P1.27mm', canon: 'SOP-16_P1.27' },
  { raw: 'MSOP-10_3x3mm_P0.5mm', canon: 'MSOP-10_P0.5' },
  { raw: 'QFN-16-1EP_3x3mm_P0.5mm_EP1.65x1.65mm', canon: 'QFN-16-1EP_3x3_P0.5', note: '带 EP，永不得与无 EP 版合并' },
  { raw: 'LGA-14_3x2.5mm_P0.5mm_LayoutBorder3x4y', canon: 'LGA-14_3x2.5_P0.5' },
  { raw: 'Crystal_SMD_3225-4Pin_3.2x2.5mm', canon: 'XTAL-3225-4' },
  { raw: 'PinHeader_1x03_P2.54mm_Vertical', canon: 'HDR-1x03_P2.54' },
  { raw: 'TO-92-3', canon: 'TO-92-3' },
  { raw: 'SMD', canon: 'UNKNOWN:SMD', note: '等于没填' },
];

/** 型号专属封装：只要求降为 UNIQUE，不要求具体键值。 */
export const UNIQUE_FOOTPRINT_FIXTURES: string[] = [
  'l_chilisin_bwvs00404',
  'l_bourns_srn6045ta',
  'L_CommonModeChoke_Coilcraft_0603USB',
  'USB_C_Receptacle_HRO_TYPE-C-31-M-12',
  'SW_SPST_PTS645',
  'ESP32-P4',
];

/** 位号串 -> 预期个数。含真实碰到的断号与区间写法。 */
export const REFS_FIXTURES: Array<{ raw: string; count: number; note?: string }> = [
  { raw: 'R1,R2,R3', count: 3 },
  { raw: 'FB1,FB2,FB3,FB4,FB5,FB8', count: 6, note: '断号但合法，FB6/FB7 在另一行' },
  { raw: 'C12 C13 C14', count: 3 },
  { raw: 'R1-R5', count: 5 },
  { raw: 'U1A,U1B', count: 2 },
];

/**
 * 含脏数据的描述串。
 * 第一条里的 \u200B 是真实存在的零宽空格，它让字符串相等比较静默失败。
 */
export const DIRTY_DESCRIPTIONS: Array<{ raw: string; problem: string }> = [
  { raw: 'SLH0704S220MTT\u200B 22uH 功率电感', problem: '含零宽空格 U+200B' },
  { raw: 'SHT40-AD1B-R2 温湿度传感器 3.000.465 Temperature Humidity Sensor 3.000.465', problem: '中英文重复 + 版本尾巴重复' },
];

/** 映射字典里已验证的三类错误。这三条是 A4 存在的理由。 */
export const DICT_ERROR_FIXTURES = [
  { rawKey: '910k', targetMpn: 'FRC0603J472_TS', targetDescription: '贴片电阻 4.7k 5% 0603', kind: 'value' },
  { rawKey: 'pink', targetMpn: 'LED_GREEN_0603_SMD', targetDescription: '贴片发光二极管 绿色 0603', kind: 'color' },
  { rawKey: 'tpd3e001 sot-553', targetMpn: 'SS14', targetDescription: '肖特基二极管 40V 1A SMA', kind: 'footprint' },
];

/** parseValue 的特征测试：同一输入 + 不同 hint => 不同结果。 */
export const HINT_SENSITIVE_FIXTURES = [
  { raw: '47', hint: 'R' as const, si: 47 },
  { raw: '47', hint: 'C' as const, si: 47e-12 },
  { raw: '47', hint: 'L' as const, si: 47e-9 },
];

/** 必须返回 unparsed 的输入。能认输比能猜重要。 */
export const MUST_NOT_GUESS: string[] = [
  'PMOD接口',
  '0603WAF1004T5E',
  'R_0603_1608Metric',
  'l_bourns_srn6045ta',
];
