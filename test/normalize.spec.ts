import { describe, it, expect } from 'vitest';
import { preclean, dedupeBilingual, stripNoise } from '../src/core/normalize/preclean';
import { parseValue } from '../src/core/normalize/parseValue';
import { parseRefs, findGaps } from '../src/core/normalize/parseRefs';
import { canonFootprint, sameGeometry } from '../src/core/normalize/canonFootprint';
import { decodeResistorMPN } from '../src/core/normalize/decodeMPN';
import {
  RESISTOR_MPN_FIXTURES, FOOTPRINT_FIXTURES, UNIQUE_FOOTPRINT_FIXTURES,
  REFS_FIXTURES, DIRTY_DESCRIPTIONS, HINT_SENSITIVE_FIXTURES, MUST_NOT_GUESS,
} from './fixtures.real';

describe('preclean', () => {
  it('剔除零宽字符，否则两个看起来一模一样的型号永远匹配不上', () => {
    const dirty = DIRTY_DESCRIPTIONS[0]!.raw;
    expect(/[\u200B]/.test(dirty)).toBe(true);
    expect(/[\u200B]/.test(preclean(dirty))).toBe(false);
  });

  it('中英文重复时只保留一半，但必须把丢掉的那半回传', () => {
    const r = dedupeBilingual('温湿度传感器  Temperature Humidity Sensor');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.dropped).toBeDefined();
  });

  it('剔除版本尾巴这类脏串并报告剔除了什么', () => {
    const r = stripNoise(DIRTY_DESCRIPTIONS[1]!.raw);
    expect(r.removed.length).toBeGreaterThan(0);
    expect(r.text).not.toContain('3.000.465');
  });
});

describe('parseValue', () => {
  it('hint 是必需参数：同一个裸数字在不同品类下必须得到不同结果', () => {
    for (const f of HINT_SENSITIVE_FIXTURES) {
      const p = parseValue(f.raw, f.hint);
      expect(p.si).toBeCloseTo(f.si, 15);
      // 靠 hint 推出来的必须留下假设记录，UI 要展示给用户
      expect(p.assumed.length).toBeGreaterThan(0);
    }
  });

  it('显式单位不需要假设', () => {
    const p = parseValue('100nF', 'C');
    expect(p.si).toBeCloseTo(100e-9, 15);
    expect(p.assumed.length).toBe(0);
  });

  it('RKM 编码', () => {
    expect(parseValue('4k7', 'R').si).toBeCloseTo(4700, 6);
    expect(parseValue('1R0', 'R').si).toBeCloseTo(1, 6);
    expect(parseValue('10R', 'R').si).toBeCloseTo(10, 6);
  });

  it('电容的 M 是容差不是兆，这种歧义必须拒绝解析而不是猜', () => {
    const p = parseValue('10M', 'C');
    expect(p.kind).toBe('unparsed');
    expect(p.reason).toBe('ambiguous_M_on_capacitor');
  });

  it('NC / DNP / 待定 是非数值，不是解析失败', () => {
    for (const t of ['NC', 'DNP', '待定', '-']) {
      expect(parseValue(t, 'R').kind).toBe('non_value');
    }
  });

  it('型号与符号名必须在数字解析之前被拦掉，宁可认输不可猜', () => {
    for (const raw of MUST_NOT_GUESS) {
      const p = parseValue(raw, 'R');
      expect(p.kind).toBe('unparsed');
      expect(p.reason).toBeDefined();
      expect(p.si).toBeNull();
    }
  });
});

describe('parseRefs', () => {
  it('真实位号串的个数', () => {
    for (const f of REFS_FIXTURES) {
      expect(parseRefs(f.raw).count, f.raw).toBe(f.count);
    }
  });

  it('区间展开必须被记录，因为它直接影响用量', () => {
    expect(parseRefs('R1-R5').expandedFrom).toEqual(['R1-R5']);
  });

  it('断号检测必须基于全 BOM 并集：FB6/FB7 在另一行时不得误报', () => {
    const rowA = parseRefs('FB1,FB2,FB3,FB4,FB5,FB8').refs;
    const rowB = parseRefs('FB6,FB7').refs;
    expect(findGaps(rowA).length).toBeGreaterThan(0);       // 逐行看会报
    expect(findGaps(rowA.concat(rowB)).length).toBe(0);      // 并集看不报
  });
});

describe('canonFootprint', () => {
  it('真实封装串归一化', () => {
    for (const f of FOOTPRINT_FIXTURES) {
      expect(canonFootprint(f.raw).canon, f.raw).toBe(f.canon);
    }
  });

  it('厂商专属封装一律降为 UNIQUE，宁可说不知道不可说一样', () => {
    for (const raw of UNIQUE_FOOTPRINT_FIXTURES) {
      expect(canonFootprint(raw).canon.startsWith('UNIQUE:'), raw).toBe(true);
    }
  });

  it('SOIC-8 与 SOIC-8-1EP 永不得被判为相同', () => {
    const a = canonFootprint('SOIC-8_3.9x4.9mm_P1.27mm');
    const b = canonFootprint('SOIC-8-1EP_3.9x4.9mm_P1.27mm_EP2.29x3.35mm');
    expect(a.canon).not.toBe(b.canon);
    expect(sameGeometry(a, b)).toBe('different');
  });

  it('碎片信息不足时返回 unknown，而不是猜一个', () => {
    const smd = canonFootprint('SMD');
    expect(smd.confidence).toBe('low');
    expect(sameGeometry(smd, canonFootprint('R_0603_1608Metric'))).toBe('unknown');
  });

  it('canon 不得编码元件类型：磁珠用 R_ 前缀也得得到同一个键', () => {
    expect(canonFootprint('R_0603_1608Metric').canon).toBe(canonFootprint('L_0603_1608Metric').canon);
  });
});

describe('decodeResistorMPN', () => {
  it('真实型号解码', () => {
    for (const f of RESISTOR_MPN_FIXTURES) {
      const d = decodeResistorMPN(f.mpn);
      expect(d.ok, f.mpn).toBe(true);
      expect(d.valueSi, f.mpn).toBeCloseTo(f.ohm, 6);
    }
  });

  it('未注册的系列返回 ok:false，不强行解', () => {
    expect(decodeResistorMPN('SHT40-AD1B-R2').ok).toBe(false);
  });
});
