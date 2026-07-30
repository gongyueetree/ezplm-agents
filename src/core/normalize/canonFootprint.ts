import { preclean } from './preclean';

/**
 * 封装归一化。
 *
 * 三条不可违反的设计约束：
 *
 * 1. **只编码焊盘几何，绝不编码元件类型。**
 *    磁珠合法地使用 R_0603_1608Metric 这个封装。把类型写进 canon 会让
 *    “位号前缀与分类不符”这条规则大面积误报。类型判断归位号前缀 + 物料分类。
 *
 * 2. **SOIC-8 与 SOIC-8-1EP 永不合并。**
 *    合并的后果是给一颗需要散热焊盘的芯片推一颗没有散热焊盘的替代料。
 *    hasExposedPad 是独立字段，同时也体现在 canon 字串里。
 *
 * 3. **厂商专属焊盘一律降为 UNIQUE。**
 *    l_bourns_srn6045ta 这类私有库封装，跳厂商无法推断一致，
 *    宁可说“不知道”，不可说“一样”。
 */

export type CanonKind =
  | 'CHIP' | 'SO' | 'QFN' | 'LGA' | 'TO' | 'SOD' | 'SMx'
  | 'CONN' | 'HDR' | 'SW' | 'XTAL' | 'MODULE' | 'UNIQUE' | 'UNKNOWN';

export interface CanonFootprint {
  /** 归一化键。跳库比较只看这个。 */
  canon: string;
  kind: CanonKind;
  pins: number | null;
  hasExposedPad: boolean;
  pitchMm: number | null;
  bodyMm: [number, number] | null;
  raw: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

const CHIP_IMPERIAL = new Set([
  '0201', '0402', '0603', '0805', '1206', '1210',
  '1812', '2010', '2512', '1008', '1005', '0102',
]);

const METRIC_TO_IMPERIAL: Record<string, string> = {
  '0603Metric': '0201',
  '1005Metric': '0402',
  '1608Metric': '0603',
  '2012Metric': '0805',
  '3216Metric': '1206',
  '3225Metric': '1210',
  '4532Metric': '1812',
  '5025Metric': '2010',
  '6332Metric': '2512',
};

/** 工艺修饰词不影响焊盘几何的“同不同”判断，先剥掉。 */
function stripDecorations(s: string): string {
  return s
    .replace(/_LayoutBorder[\dxXyY.]*/g, '')
    .replace(/_HandSolder|_Wave|_Reflow|_Nominal/gi, '')
    .replace(/_Pad[\d.]+x[\d.]+mm/gi, '')
    .replace(/_+$/g, '');
}

function base(raw: string, canon: string, kind: CanonKind): CanonFootprint {
  return {
    canon, kind, pins: null, hasExposedPad: false,
    pitchMm: null, bodyMm: null, raw, confidence: 'high', notes: [],
  };
}

export function canonFootprint(rawIn: string | null | undefined): CanonFootprint {
  const raw0 = preclean(rawIn);
  if (raw0.length === 0) {
    const r = base('', 'UNKNOWN', 'UNKNOWN');
    r.confidence = 'low';
    r.notes.push('封装为空');
    return r;
  }

  const notes: string[] = [];
  let s = raw0;

  // 0) 剥厂商私有库前缀 l_<vendor>_，但记下来
  let vendorLib: string | null = null;
  const lib = s.match(/^l_([A-Za-z0-9]+)_(.+)$/i);
  if (lib) {
    vendorLib = lib[1]!;
    s = lib[2]!;
    notes.push('来自厂商私有库 ' + vendorLib + '，仅同库内可比');
  }
  s = stripDecorations(s);

  // 1) 散热焊盘：先剥离并单独记录
  let hasEP = false;
  const ep = s.match(/-?1?EP(?:[\d.]+x[\d.]+mm)?/i);
  if (ep) {
    hasEP = true;
    s = s.replace(ep[0], '');
  }

  const pitchM = s.match(/P([\d.]+)mm/i);
  const pitch = pitchM ? parseFloat(pitchM[1]!) : null;
  const bodyM = s.match(/(?:^|_)([\d.]+)x([\d.]+)mm/i);
  const body: [number, number] | null = bodyM ? [parseFloat(bodyM[1]!), parseFloat(bodyM[2]!)] : null;

  const finish = (canon: string, kind: CanonKind, pins: number | null, conf: 'high' | 'medium' | 'low', extra: string[] = []): CanonFootprint => ({
    canon, kind, pins, hasExposedPad: hasEP, pitchMm: pitch, bodyMm: body,
    raw: raw0, confidence: conf, notes: notes.concat(extra),
  });

  // 2) 片式元件：R_0603_1608Metric / C_0402_1005Metric / D_0603
  const chip = s.match(/^(?:[A-Za-z]{1,3}_)?(\d{4})(?:_(\d{4}Metric))?$/);
  if (chip) {
    const direct = CHIP_IMPERIAL.has(chip[1]!) ? chip[1]! : null;
    const viaMetric = chip[2] ? METRIC_TO_IMPERIAL[chip[2]] ?? null : null;
    const imperial = direct ?? viaMetric;
    if (imperial) return finish('CHIP-' + imperial, 'CHIP', 2, 'high', ['仅焊盘几何，不含元件类型']);
  }
  const metricOnly = s.match(/(\d{4}Metric)/);
  if (metricOnly && METRIC_TO_IMPERIAL[metricOnly[1]!]) {
    return finish('CHIP-' + METRIC_TO_IMPERIAL[metricOnly[1]!], 'CHIP', 2, 'high');
  }

  // 3) SOIC / SOP / SSOP / TSSOP / MSOP
  const so = s.match(/\b(SOIC|SOP|SSOP|TSSOP|MSOP|VSSOP|HTSSOP|SO)-?(\d{1,3})\b/i);
  if (so) {
    const famRaw = so[1]!.toUpperCase();
    const fam = famRaw === 'SO' ? 'SOIC' : famRaw;
    const pins = parseInt(so[2]!, 10);
    let canon = fam + '-' + pins;
    if (hasEP) canon += '-1EP';
    if (pitch !== null) canon += '_P' + pitch;
    return finish(canon, 'SO', pins, 'high', hasEP ? ['含散热焊盘，禁止与无 EP 版本互换'] : []);
  }

  // 4) QFN / DFN / LGA / BGA
  const qfn = s.match(/\b(WQFN|UQFN|VQFN|QFN|DFN|LGA|BGA)-?(\d{1,3})\b/i);
  if (qfn) {
    const fam = qfn[1]!.toUpperCase();
    const pins = parseInt(qfn[2]!, 10);
    let canon = fam + '-' + pins;
    if (hasEP) canon += '-1EP';
    if (body) canon += '_' + body[0] + 'x' + body[1];
    if (pitch !== null) canon += '_P' + pitch;
    const kind: CanonKind = fam === 'LGA' ? 'LGA' : 'QFN';
    return finish(canon, kind, pins, 'high');
  }

  // 5) SOT / SOD / DO / SMA-SMC
  const sot = s.match(/\b(SOT-?\d{2,3}[A-Z]?(?:-\d)?|SOD-?\d{2,3}|DO-?\d{3}[A-Z]*|SMAJ|SMA|SMB|SMC|SMF)\b/i);
  if (sot) {
    const t = sot[1]!.toUpperCase().replace(/^SOT(\d)/, 'SOT-$1').replace(/^SOD(\d)/, 'SOD-$1').replace(/^DO(\d)/, 'DO-$1');
    const kind: CanonKind = /^SOD|^DO-/.test(t) ? 'SOD' : /^SM/.test(t) ? 'SMx' : 'SO';
    return finish(t, kind, null, 'high');
  }

  // 6) TO 系列
  const to = s.match(/\bTO-?(\d{2,3})(?:-(\d))?\b/i);
  if (to) {
    const pins = to[2] ? parseInt(to[2], 10) : null;
    return finish('TO-' + to[1] + (to[2] ? '-' + to[2] : ''), 'TO', pins, 'high');
  }

  // 7) 晶振：Crystal_SMD_3225-4Pin_3.2x2.5mm
  const xtal = s.match(/Crystal\D*(\d{4})-?(\d)?Pin/i);
  if (xtal) {
    const pins = xtal[2] ? parseInt(xtal[2], 10) : null;
    return finish('XTAL-' + xtal[1] + (pins ? '-' + pins : ''), 'XTAL', pins, 'high');
  }

  // 8) 排针排母：PinHeader_1x03_P2.54mm_Vertical
  const hdr = s.match(/(PinHeader|PinSocket|Socket|Header)_(\d+)x(\d+)/i);
  if (hdr) {
    const cols = parseInt(hdr[2]!, 10);
    const rows = parseInt(hdr[3]!, 10);
    let canon = 'HDR-' + cols + 'x' + rows;
    if (pitch !== null) canon += '_P' + pitch;
    return finish(canon, 'HDR', cols * rows, 'high');
  }

  // 9) 型号即封装（连接器/开关/模块）：只能同型号互换
  const usbc = s.match(/USB_C_\w*?(TYPE-C-[\w-]+)/i);
  if (usbc) return finish('UNIQUE:CONN:' + usbc[1]!.toUpperCase(), 'CONN', null, 'high', ['型号专属封装，仅同型号可互换']);
  const sw = s.match(/^SW_[A-Za-z]+_([A-Za-z0-9]+)$/i);
  if (sw) return finish('UNIQUE:SW:' + sw[1]!.toUpperCase(), 'SW', null, 'high', ['型号专属封装，仅同型号可互换']);
  if (/^(ESP32|ESP8266|SIM[0-9]|EC2[0-9]|Air[0-9]|BL[0-9]{3})/i.test(s)) {
    return finish('UNIQUE:MODULE:' + s.toUpperCase(), 'MODULE', null, 'high', ['模块型号即封装']);
  }

  // 10) 厂商专属焊盘（电感/共模电感居多）
  if (vendorLib !== null || /Coilcraft|Bourns|Chilisin|TDK|Murata|Sunlord|Taiyo/i.test(s)) {
    const keyM = s.match(/([A-Za-z]{2,}\d{3,}[A-Za-z0-9]*)/);
    const key = (keyM ? keyM[1]! : s).toUpperCase();
    return finish('UNIQUE:MPN:' + key, 'UNIQUE', null, 'medium', ['厂商专属焊盘，跳厂商不可推断一致']);
  }

  // 11) 裸 SMD / 贴片：等于没填
  if (/^(SMD|SMT|贴片|SMD封装)$/i.test(s)) {
    return finish('UNKNOWN:SMD', 'UNKNOWN', null, 'low', ['封装信息不足，等同于空，需补全']);
  }

  return finish('UNKNOWN:' + s.toUpperCase(), 'UNKNOWN', null, 'low', ['未命中任何封装规则']);
}

export type GeometryVerdict = 'same' | 'different' | 'unknown';

/**
 * A2 的核心。只回答“焊盘几何是不是同一个”，
 * **不回答“能不能替换”**。后者需要电参数、片子、认证、寿命周期，不在本函数职责内。
 */
export function sameGeometry(a: CanonFootprint, b: CanonFootprint): GeometryVerdict {
  if (a.confidence === 'low' || b.confidence === 'low') return 'unknown';
  if (a.hasExposedPad !== b.hasExposedPad) return 'different';
  if (a.kind === 'UNIQUE' || b.kind === 'UNIQUE') {
    return a.canon === b.canon ? 'same' : 'unknown';
  }
  return a.canon === b.canon ? 'same' : 'different';
}
