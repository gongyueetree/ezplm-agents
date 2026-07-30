import { preclean, foldKey } from '../../core/normalize/preclean';
import type { ValueHint } from '../../core/normalize/parseValue';

/**
 * 属性模板。
 *
 * 背景：存量属性库里有一百多个扁平的属性名，**没有绑分类**，命名也不统一：
 *   正向电压VF[最大值](V) / OpVoltage / 功耗 - 静态功耗 (μW/mW) / GPIOs / ROM接口 / Bus Modes
 * 中英文、带不带单位、带不带方括号、带不带破折号，全都有。
 *
 * 这带来两个后果：
 *   1. 同一个物理量被当成多个属性，参数对比永远对不上
 *   2. 新建物料时人不知道该填哪些，于是都不填
 *
 * 模板的作用不是“多出一堆字段让人填”，而是**把必填项压到最少**，
 * 并把它们从描述串里自动抽出来预填。必填项多一个，建档率就低一截。
 *
 * 注意：现有系统“仅专业版支持自定义属性名称”。所以 canonical 名优先复用存量属性名，
 * aliases 只用于归一读取，不要倒过来把存量属性改名——那是一次不可逆的全库改造。
 */

export type AttrKind = ValueHint | 'text' | 'enum';

export interface AttrSpec {
  /** 受控属性名（全库唯一） */
  name: string;
  unit?: string;
  /** 必填项。开少一点，能建档就行。 */
  required: boolean;
  kind: AttrKind;
  enumValues?: string[];
  /** 存量库里见过的写法，用于归一读取 */
  aliases: string[];
  note?: string;
}

export interface CategoryTemplate {
  key: string;
  label: string;
  match: RegExp;
  /** 位号前缀，用于从 BOM 行反推品类 */
  designators: string[];
  attrs: AttrSpec[];
}

const TOL_ENUM = ['±0.1%', '±0.25%', '±0.5%', '±1%', '±2%', '±5%', '±10%', '±20%'];

export const TEMPLATES: CategoryTemplate[] = [
  {
    key: 'resistor', label: '电阻', match: /电阻|resistor/i, designators: ['R', 'RN', 'RV'],
    attrs: [
      { name: '阻值', unit: 'Ω', required: true, kind: 'R', aliases: ['阻值(Ω)', 'Resistance', '阻值值', 'R值'] },
      { name: '封装', required: true, kind: 'text', aliases: ['封装规格', 'Package', 'Case'] },
      { name: '精度', required: true, kind: 'enum', enumValues: TOL_ENUM, aliases: ['容差', 'Tolerance', '精度(%)'] },
      { name: '额定功率', unit: 'W', required: true, kind: 'W', aliases: ['功率', 'Power', '额定功率(W)', '功耗'] },
      { name: '额定电压', unit: 'V', required: false, kind: 'V', aliases: ['耐压', '工作电压', 'OpVoltage', 'Voltage Rating'] },
      { name: '温度系数', unit: 'ppm/℃', required: false, kind: 'text', aliases: ['温漂', 'TCR', '温度系数(ppm)'] },
      { name: '电阻类型', required: false, kind: 'enum', enumValues: ['原位电阻', '厚膜', '薄膜', '绕绕线', '合金箱', '排阻'], aliases: ['类型', 'Type'] },
    ],
  },
  {
    key: 'capacitor', label: '电容', match: /电容|capacitor/i, designators: ['C', 'CN'],
    attrs: [
      { name: '容值', unit: 'F', required: true, kind: 'C', aliases: ['容量', 'Capacitance', '容值(F)'] },
      { name: '封装', required: true, kind: 'text', aliases: ['封装规格', 'Package', 'Case'] },
      { name: '额定电压', unit: 'V', required: true, kind: 'V', aliases: ['耐压', '工作电压', 'OpVoltage', 'Voltage Rating', '额定电压(V)'] },
      { name: '介质', required: true, kind: 'enum', enumValues: ['X7R', 'X5R', 'X6S', 'X7S', 'C0G', 'NP0', 'Y5V', '铝电解', '铝聚合物', '钽', '薄膜'], aliases: ['材质', 'Dielectric', '介质材料'] },
      { name: '精度', required: false, kind: 'enum', enumValues: TOL_ENUM, aliases: ['容差', 'Tolerance'] },
      { name: 'ESR', unit: 'Ω', required: false, kind: 'R', aliases: ['等效串联电阻', 'ESR(mΩ)'] },
      { name: '额定纹波电流', unit: 'A', required: false, kind: 'A', aliases: ['纹波电流', 'Ripple Current'] },
    ],
  },
  {
    key: 'inductor', label: '电感/磁珠', match: /电感|磁珠|inductor|bead/i, designators: ['L', 'FB', 'FL'],
    attrs: [
      { name: '感值', unit: 'H', required: true, kind: 'L', aliases: ['电感量', 'Inductance', '感值(H)'] },
      { name: '封装', required: true, kind: 'text', aliases: ['封装规格', 'Package'] },
      { name: '额定电流', unit: 'A', required: true, kind: 'A', aliases: ['额定电流(A)', 'Rated Current', 'Idc'] },
      { name: '直流电阻', unit: 'Ω', required: true, kind: 'R', aliases: ['DCR', '直流电阻(mΩ)', 'DC Resistance'] },
      { name: '饱和电流', unit: 'A', required: false, kind: 'A', aliases: ['Isat', '饱和电流(A)'] },
      { name: '自谐频率', unit: 'Hz', required: false, kind: 'Y', aliases: ['SRF', '自谐频率(MHz)'] },
      { name: '阻抗@100MHz', unit: 'Ω', required: false, kind: 'R', aliases: ['阻抗', 'Impedance', 'Z@100MHz'], note: '磁珠用这个，不用感值' },
    ],
  },
  {
    key: 'diode', label: '二极管/LED/TVS', match: /二极管|LED|发光|TVS|稳压管|diode/i, designators: ['D', 'DZ', 'LED'],
    attrs: [
      { name: '封装', required: true, kind: 'text', aliases: ['封装规格', 'Package'] },
      { name: '器件类型', required: true, kind: 'enum', enumValues: ['开关二极管', '肖特基', '稳压二极管', 'TVS', 'LED', '整流桥', '快恢复'], aliases: ['类型', 'Type'] },
      { name: '反向耐压', unit: 'V', required: true, kind: 'V', aliases: ['VR', '反向耐压(V)', 'VRRM', '耐压'] },
      { name: '正向电流', unit: 'A', required: true, kind: 'A', aliases: ['IF', '正向电流(A)', 'Forward Current'] },
      { name: '正向压降', unit: 'V', required: false, kind: 'V', aliases: ['VF', '正向电压VF[最大值](V)', '正向压降(V)'] },
      { name: '发光颜色', required: false, kind: 'enum', enumValues: ['红', '绿', '蓝', '黄', '白', '橙', '粉', '紫', '红外', '紫外'], aliases: ['颜色', 'Color'], note: 'LED 必填。颜色错会连带限流电阻算错。' },
      { name: '钳位电压', unit: 'V', required: false, kind: 'V', aliases: ['VC', 'Clamping Voltage'], note: 'TVS 必填' },
    ],
  },
  {
    key: 'ic', label: 'IC/芯片', match: /IC|芯片|集成|MCU|传感器|稳压器|驱动|放大器/i, designators: ['U', 'IC'],
    attrs: [
      { name: '封装', required: true, kind: 'text', aliases: ['封装规格', 'Package'] },
      { name: '器件类型', required: true, kind: 'text', aliases: ['类型', 'Type', '功能'], note: '如 MCU / LDO / DCDC / ADC / 接口芯片 / 传感器' },
      { name: '工作电压范围', unit: 'V', required: true, kind: 'text', aliases: ['工作电压', 'OpVoltage', 'Supply Voltage', '电压范围'] },
      { name: '工作温度范围', unit: '℃', required: true, kind: 'text', aliases: ['温度范围', 'Operating Temperature', '温度等级'] },
      { name: '引脚数', required: true, kind: 'text', aliases: ['Pin Count', '引脚数量', 'Pins'] },
      { name: '接口类型', required: false, kind: 'text', aliases: ['接口', 'Interface', 'Bus Modes', 'ROM接口'] },
      { name: '静态功耗', required: false, kind: 'text', aliases: ['功耗 - 静态功耗 (μW/mW)', 'Iq', '静态电流'] },
      { name: 'IO数量', required: false, kind: 'text', aliases: ['GPIOs', 'GPIO数量'] },
    ],
  },
];

export function templateFor(category?: string | null, description?: string | null): CategoryTemplate | null {
  const hay = preclean(category) + ' ' + preclean(description);
  for (const t of TEMPLATES) {
    if (t.match.test(hay)) return t;
  }
  return null;
}

export function templateByDesignator(prefix: string): CategoryTemplate | null {
  const p = prefix.toUpperCase();
  for (const t of TEMPLATES) {
    if (t.designators.includes(p)) return t;
  }
  return null;
}

/**
 * 属性名归一：把存量的乱写法映射到受控名。
 * 没映射上就返回 null，由调用方归入“残余集”人工处理。
 * **不要模糊匹配。** 属性名模糊匹配错一个，全库参数就污了。
 */
export function canonAttrName(raw: string): { name: string; template: string } | null {
  const key = foldKey(raw);
  if (key.length === 0) return null;
  for (const t of TEMPLATES) {
    for (const a of t.attrs) {
      if (foldKey(a.name) === key) return { name: a.name, template: t.key };
      for (const alias of a.aliases) {
        if (foldKey(alias) === key) return { name: a.name, template: t.key };
      }
    }
  }
  return null;
}

/** 属性名命名规范。新增属性必须过这个校验，否则两年后又是一堆乱写法。 */
export function validateAttrName(raw: string): { ok: boolean; problems: string[] } {
  const s = preclean(raw);
  const problems: string[] = [];
  if (s.length === 0) problems.push('为空');
  if (s !== raw) problems.push('首尾有空白或含全角/不可见字符');
  if (/[\[\]【】]/.test(s)) problems.push('含方括号，请把限定条件写到备注里');
  if (/\//.test(s) && /\(.*\/.*\)/.test(s)) problems.push('单位里出现多个选项（如 μW/mW），单位必须唯一');
  if (/\s{2,}/.test(s)) problems.push('含连续空格');
  if (/^[a-z]/.test(s) && /[A-Z]/.test(s.slice(1))) problems.push('英文属性名请统一为首字母大写或全大写缩写');
  return { ok: problems.length === 0, problems };
}
