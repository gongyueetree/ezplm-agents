/**
 * 所有解析的第一道工序。
 *
 * 这里处理的每一类脏数据都是在真实系统里真实碰到的，不是预防性编程：
 *  - 某串又又描述里含零宽空格 U+200B，让字符串相等比较静默失败
 *  - 某传感器描述里中英文内容重复两遍，并掘掘带着“3.000.465”这类脏串
 *  - 全角逗号 / 全角冒号 / 全角空格与半角混用
 *  - 微符号有 U+00B5 和 U+03BC 两种写法
 */

/** 零宽/不可见字符。这些东西能让两个看起来一模一样的型号永远匹配不上。 */
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\uFEFF\u00AD]/g;

const FULLWIDTH: Record<string, string> = {
  '，': ',',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '　': ' ',
  '～': '~',
  '／': '/',
};

export function preclean(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  s = s.replace(INVISIBLE, '');
  s = s.replace(/[，；：（）【】　～／]/g, (ch) => FULLWIDTH[ch] ?? ch);
  // 微符号统一到 U+03BC（希腊字母 mu），不要用 U+00B5
  s = s.replace(/\u00B5/g, '\u03BC');
  s = s.replace(/\s+/g, ' ').trim();
  // 首尾的孤立分隔符，多数是从 Excel 粘过来时带的
  s = s.replace(/^[,;/|\-、]+/, '').replace(/[,;/|、]+$/, '').trim();
  return s;
}

/** 把字符串降成可比较的形式：去空白、去分隔符、转大写。仅用于匹配，不用于展示。 */
export function foldKey(raw: string | null | undefined): string {
  return preclean(raw).replace(/[\s_\-.]/g, '').toUpperCase();
}

export interface BilingualSplit {
  text: string;
  /** 被丢掉的那一半。必须向用户展示，因为丢掉的可能正好是他要的。 */
  dropped?: string;
}

/**
 * 处理“中英文同义重复”的描述串。
 * 注意：只做拆分与报告，不做“自作主张的改写”。丢掉的部分必须回传。
 */
export function dedupeBilingual(input: string): BilingualSplit {
  const s = preclean(input);
  const parts = s.split(/\s{2,}|\|/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length < 2) return { text: s };
  const hasCJK = (x: string) => /[\u4e00-\u9fa5]/.test(x);
  const cjk = parts.filter(hasCJK).join(' ');
  const latin = parts.filter((p) => !hasCJK(p)).join(' ');
  if (cjk.length > 0 && latin.length > 0) {
    return cjk.length >= latin.length ? { text: cjk, dropped: latin } : { text: latin, dropped: cjk };
  }
  return { text: s };
}

/**
 * 剥除已知的脏串。
 * 目前只收了一类：形如 3.000.465 的版本尾巴，它不是参数，但会把参数提取带偏。
 * 新增脏串模式只往这个数组里加，不要改调用方。
 */
const NOISE_PATTERNS: RegExp[] = [
  /\b\d\.\d{3}\.\d{3}\b/g,
];

export function stripNoise(input: string): { text: string; removed: string[] } {
  let s = preclean(input);
  const removed: string[] = [];
  for (const re of NOISE_PATTERNS) {
    s = s.replace(re, (m) => {
      removed.push(m);
      return ' ';
    });
  }
  return { text: preclean(s), removed };
}
