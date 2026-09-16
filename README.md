# ezplm-agents

面向 eZ-PLM 的六个 AI Agent（A1–A6），覆盖「研发工程师 → 现场调试 → 采购」的核心流程。

核心设计原则只有一条：**建议 → 人确认 → 写库**。这个仓库里的 Agent 不允许绕过宿主流程自动改动 PLM 数据。

## 六个 Agent 与它们的宿主控件

A1–A5 继续寄生在 eZ-PLM 已有按钮、字段或状态流转上。A6 LabSight 属于项目级持续工作区，挂在项目详情的「LabSight 调试」Tab；它读项目上下文和现场证据，但任何 Issue / ECO / 字段写入仍必须回到 ezPLM 宿主确认。

| ID | 名称 | 宿主控件 | 输出 |
| --- | --- | --- | --- |
| A1 | BOM 体检 | BOM 物料清单页顶部 + 新建版本前置校验 | 18 条规则的问题清单，逐条可采纳/忽略 |
| A2 | 封装与焊盘核对 | 物料详情封装字段 + 替代料对比抽屉 | 焊盘几何一致性 + 未核对项清单（永不结论“可互换”） |
| A3 | 缺料与采购建议 | 生产订单 / 采购申请页 | 需求-可用-缺口三列表 + 采购申请草稿行 |
| A4 | 工程文件导入映射 | 工程文件导入 / 解析的两张映射字典 | 映射候选 + 存量字典错误审计 |
| A5 | 物料建档与选型 | 新建物料对话框 + 搜索系统库 + 全局搜索 | 属性模板预填 + 候选排序打分 |
| A6 | LabSight 调试 Agent | 项目详情 → LabSight 调试 | 摄像头/PCB/KiCad/测量/诊断闭环；Issue/ECO 只生成草稿建议 |

### A6 调用方式

`src/agents/a6-labsight-debug` 定义了稳定的 server-to-server 调用契约。当前参考 runtime 在 `board-debug-copilot` 提供：

- `GET /api/v1/ai/labsight-agent/manifest`
- `POST /api/v1/ai/labsight-agent/invoke`

当前 action：`chat / measure_guide / design_review / analyze_photo / assembly_align / assembly_inspect / analyze_capture`。

A6 的只读诊断结果可以直接渲染；凡是准备进入 ezPLM 的 Issue / ECO / 项目字段，必须通过 `buildIssueDraftSuggestion()` / `buildEcoDraftSuggestion()` 生成 `Suggestion`，并满足至少两类独立证据。

## 三条不可协商的红线

1. **永不自动落库。** `Suggestion` 类型上写死了 `autoApplyForbidden: true`，所有写入必须经过 diff 预览 + 人工确认 + 可撤销 + 审计留痕。
2. **没有证据不许渲染。** `assertRenderable()` 会拒绝 `evidence` 为空的建议。用户被坑一次就再也不看这个面板了。
3. **不许替人做决定。** 发邮件、下单、改权限，以及 LabSight 形成 Issue/ECO 后的正式提交，都只能由人来做；Agent 最多起草。

## 置信度决定交互形态

| 置信度 | 交互 | 含义 |
| --- | --- | --- |
| high | 幽灵预填（灰字默认填好，一键撤销） | 两条独立证据链一致 |
| medium | 展开候选，人必须点一个 | 有 ≥2 个候选或证据冲突 |
| low | 只标记，不给答案 | 只能提示存在风险 |

## 目录结构

    src/core/                 通用契约与纯函数底座
    src/agents/a1..a5/        BOM / 物料 / 采购类确定性 Agent
    src/agents/a6-labsight-debug/  LabSight 项目级调用契约 + 写入草稿守卫
    src/adapters/ezplm/       ezPLM 宿主 adapter
    test/                     真实 fixture 与 Agent 契约测试
    docs/                     接入说明

## 工程师从哪里开始

1. 读 `docs/03-mount-points.md`，确认 A1–A5 挂载点；A6 固定挂在项目级 `project/labsight` 工作区。
2. 实现 `src/adapters/ezplm/client.ts` 里的 `EzplmClient` 接口；A6 runtime 另外实现 `LabSightTransport.invoke()` 即可。
3. 读 `docs/02-backend-prereqs.md`。缺后端字段时对应规则自动降级为不启用，不拿空值硬算。
4. A6 先接只读 Project Context / Evidence，再逐步开放 Issue/ECO 草稿；正式写库永远留在 ezPLM 宿主层。

## 关于这个公开仓库的脱敏

仓库是公开的，所以代码里不含具体的 workspace 标识、项目/BOM 的 UUID 和内部接口路径，这些位置统一用占位符（形如 `<WORKSPACE>`、`<BOM_ID>`、`<API_BASE>`），在 adapter 层集中配置。

测试 fixture 里保留真实的物料型号与规格描述串（如 0603WAF1004T5E、SLH0704S220MTT），这些是公开的元器件型号，不属于内部信息，但它们是这套解析器唯一可靠的验证依据，去掉就没法证明代码是对的。

## License

暂未指定。内部使用。
