# 五个智能体的挂载点

这是给 eZ-PLM 工程师看的主文档。核心思想只有一句:**每个 Agent 都寄生在一个已经存在的控件上,不新增第 9 个侧边栏菜单。**

判断一个挂载点是否合理,只用一个标准:用户本来就要点这个按钮/填这个字段吗?如果不是,那这个 Agent 就是个摆设。反过来,如果某个业务动作在系统里找不到宿主控件,说明这个动作本身还不存在——应该先补流程,而不是先加 AI。

一个附带结论:A1 和 A5 上线之后,现有「AI 工具」菜单里至少有三张卡片应该消失,因为它们的能力已经长到了真正会被用到的地方。菜单里的入口越少,说明 AI 越到位。

---

## A1 BOM 体检

**宿主控件:** BOM 物料清单页顶部(现有的「全部 N / 已确认 M」计数区域旁),以及「新建版本」的前置校验。

**触发时机:** 三处,不要多加。

一是进入 BOM 物料清单页时后台静默跑一次,把结果做成计数徽标,不弹窗、不打断。二是用户点计数徽标时展开问题清单。三是点「新建版本」或提交发布时做前置校验,这一处是唯一允许拦人的地方,而且要排到最后一期才上。

**调用方式:**

```ts
import { runBomHealthCheck, PHASE1_CODES, evaluateReleaseGate } from 'ezplm-agents';

const report = runBomHealthCheck(bom, ctx, {
  only: PHASE1_CODES,      // 灰度期只跑七条零歧义规则
  parts: partSnapshots,    // 用于 R09/R16 的零件主数据
});

// 徽标只显示 blocking 数,warn 和 info 收在展开面板里。
// 一个永远不归零的计数器等于没有计数器,所以 blocking 必须是可清零的。
badge.text = report.blocking > 0 ? String(report.blocking) : '';
```

**UI 规范:**

问题清单按 block / warn / info 三段折叠,默认只展开 block。每条都必须能点击跳到对应行并高亮该字段——做不到跳转就不要上这条规则,用户找不到位置等于没告诉他。

`report.skippedRules` 必须显示出来,措辞类似"另有 2 项检查因缺少采购属性字段未执行"。不显示的后果是用户以为体检是完整的。

`report.dropped` 不要给用户看,上报到内部监控。它代表 Agent 自己有 bug。

---

## A2 封装与焊盘核对

**宿主控件:** 物料详情页的封装字段旁,以及替代料对比抽屉。

**触发时机:** 用户主动发起对比时。不要自动跑——自动推替代料会被当成噪音。

**调用方式:**

```ts
import { compareForReplacement, compareMany } from 'ezplm-agents';

const result = compareForReplacement(basePart, candidatePart, ctx);
// result.geometry: 'same' | 'different' | 'unknown'
// result.unverified: 永远不为空
```

**UI 规范(这一条最关键):**

界面上**不允许出现"可互换""兼容""可替代"这三个词**。允许的措辞只有"焊盘几何一致""参数已覆盖""以下项未核对"。

`unverified` 清单必须和结论同屏显示,不能折叠起来。把它折叠等于把责任藏起来。

`compareMany` 的排序结果标题写"按匹配度排序",不要写"推荐"。排序和推荐是两回事。

---

## A3 缺料与采购建议

**宿主控件:** 生产订单详情页、采购申请新建页。

**触发时机:** 用户在生产订单里填了计划数量之后。

**调用方式:**

```ts
import { computeShortage } from 'ezplm-agents';

const result = computeShortage({
  bomId, bomVersion, lines,
  plannedQty: 500,
  scrapRate: 0.02,
  needDate: '2026-09-30',
  inventory, inTransit, terms,
}, ctx);
```

**UI 规范:**

三列表必须分开显示:`required` / `availableNow` / `gap`,再加一列 `notes`。用户不看中间过程是不会信最后那个数的。

`status === 'uncomputable'` 的行要单独一个分组,标题写"以下 N 行无法计算",绝对不能混进"不缺料"里。这两个状态在报表上混在一起,是采购踩坑的经典来源。

`requisitionDraft` 落到界面上是一张可编辑的草稿表,提交按钮的文案是「提交采购申请」而不是「确认」。下单永远是人的动作。

---

## A4 工程文件导入映射

**宿主控件:** 工程文件导入/解析的两张映射字典页,以及导入向导的预览步骤。

**触发时机:** 两个,价值完全不同。

导入时的映射建议属于日常价值。字典审计属于一次性的高价值动作——建议做成映射字典页上的一个「审计」按钮,第一次点下去大概率会发现存量错误。

**调用方式:**

```ts
import { auditDictionary, suggestMapping } from 'ezplm-agents';

const issues = auditDictionary(await client.getDictionary('value'), ctx);
const perRow = suggestMapping(importRow, candidates, ctx);
```

**UI 规范:**

审计结果按 `hitCount` 降序排——命中越多的错条目,污染范围越大。

每条审计结论必须左右并列展示"字典键的原文"和"目标物料的原文",让人一眼能判。只给结论不给原文,用户没法验证,也就不会动手改。

导入预览沿用现有的黄色未匹配标记。A4 的目标是让黄色行变少,不是把黄色行强行变绿。`A4.MAP_PICK` 是 medium 置信,必须展开候选让人点。

---

## A5 物料建档与选型

**宿主控件:** 三个,全部是现有的。

新建物料对话框、物料列表页的「搜索系统库」、全局搜索框。

**触发时机:**

新建物料对话框打开时立即跑一次(用户已经贴了型号或描述的情况下),用幽灵预填。搜索系统库和全局搜索则在用户输入时跑。

**调用方式:**

```ts
import { buildCreateSuggestions, scoreCandidates, buildSelectSuggestion, decidePrice } from 'ezplm-agents';

// 建档
const suggestions = buildCreateSuggestions({
  mpn, manufacturer, description, footprint, category, designator,
  fromLibrary,
}, ctx);

// 选型
const scored = scoreCandidates({ text: '0603 100nF 50V X7R', designator: 'C12' }, candidates, ctx);
const pick = buildSelectSuggestion(query, scored, ctx);

// 价格
const decision = decidePrice(offers);   // 永不让 L4 盖掉 L1
```

**UI 规范:**

high 置信的属性用幽灵预填:灰字、默认填好、字段旁有一个"来自建议"的小标记和一键撤销。medium 置信的展开候选,不预填。low 置信的只标记。

`A5.CREATE.RESIDUAL` 建议不要藏。残余片段是发现"模板缺属性"的唯一途径,把它显示在对话框底部的折叠区里,让愿意较真的人能看到。

`A5.SYNC_RISK` 是 block 级。在字段级 origin 上线之前,这条会一直出现,这是故意的——它提醒的是"你现在写进去的东西会被一次同步抹掉"。

---

## 接受一条建议的标准流程

五个 Agent 共用同一条链路,前端只需要实现一次。

1. 用户点「采纳」,前端把 `suggestion` 和 `finalValue`(允许用户改过)交给 `client.applyAccepted`。
2. `applyAccepted` 必须带 `expectedVersion` 做乐观锁。用户可能在建议生成之后又手改了数据,这时要提示冲突而不是覆盖。
3. 写入时字段级 `origin` 设为 `ai_suggested_accepted`。
4. 用 `buildAudit()` 造审计记录并 `appendAudit`。审计只能追加,不提供删除。
5. 界面上保留撤销入口至少到本次会话结束。

拒绝也要记审计。拒绝率高的规则应该被下线,而这件事只有审计数据能告诉你。

---

## 一条给排期的提醒

不要五个一起上。按 `docs/04-rollout.md` 的顺序做:先让用户觉得"它说的都对",再给它拦人的权力。顺序搞反了,技术做得再好也会被用户投诉到关掉。
