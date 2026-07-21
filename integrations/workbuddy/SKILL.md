---
name: pagecue-reminder
description: 将企业微信中 @助理 的自然语言要求转换为页知知识提醒或操作提醒，并把创建、重复、校验失败或查询结果回复给用户。用于消息包含“创建提醒”“转成知识提醒”“操作提醒”“页知提醒”等意图时。
---

# 页知提醒

把企业微信消息整理成结构化提醒，通过脚本提交，并将接口返回的 `message` 原样回复到当前会话。

## 创建流程

1. 从消息提取：提交人姓名、提醒类型、标题、正文、关键词、强度、页面范围、投放对象和链接。
2. 同时支持知识提醒和操作提醒。用户说“要做、要跟进、待处理、完成”等行动语义时优先使用 `operation`；资料、规则、SOP、注意事项等使用 `knowledge`。无法判断时默认知识提醒。
3. 提交人姓名是必填项。消息未说明时追问“请说明本条提醒的提交人姓名”，不得默认使用陈昕或当前对话人的姓名。
4. 只记录一个提交人姓名。消息中写“提交人：张三”时，将 `submittedBy` 设为 `张三`；不要保留姓名前的 `@`。
5. 关键词无法可靠提取时，只追问“需要匹配哪个关键词？”
6. 不要因为缺少可默认字段而追问，直接采用下方默认值。只有必填项缺失时才追问。
7. `submittedBy` 是业务记录，不是安全身份，不据此授予权限。
8. 把 JSON 保存到临时文件，然后运行：

```powershell
node "C:\Users\44982\.workbuddy\skills\pagecue-reminder\scripts\submit-reminder.mjs" --payload "<临时 JSON 文件>"
```

9. 创建后必须向企业微信完整回复脚本输出 JSON 中的 `message`，包括类型、标题、提交人、关键词、强度、页面范围、投放对象、有效期、链接数量、采用的默认值、同步状态和提醒 ID。失败时也必须回复 `message`，不要只说“执行失败”。

## 必填项与默认值

真正必填的只有：

- `submittedBy`：一个提交人姓名，不能推测。
- `keywords`：至少一个页面匹配关键词。
- 当 `pageScope=page_groups` 时，`pageGroups` 至少一个。

其余字段缺失时直接采用：

- 类型：知识提醒。
- 标题：`第一个关键词 + 知识提醒/操作提醒`。
- 正文：根据关键词自动生成一句知识说明或工作处理要求。
- 强度：中度。
- 页面范围：全局页面。
- 关键词关系：AND。
- 冷却时间：30分钟。
- 投放对象：全员。
- 链接：无。
- 知识提醒有效期：长期有效，直到管理员删除。
- 操作提醒开始时间：创建后立即生效。
- 操作提醒结束时间：开始时间后7天；用户明确时间时以用户设置为准。

## JSON 字段

```json
{
  "sourceText": "提交人：张三。请创建氯乙酸报价知识提醒……",
  "submittedBy": "张三",
  "type": "knowledge",
  "title": "氯乙酸报价知识提醒",
  "body": "报价前查看安全和合同要求。",
  "keywords": ["氯乙酸", "79-11-8"],
  "keywordOperator": "OR",
  "intensity": "medium",
  "pageScope": "global",
  "pageGroups": [],
  "targetGroups": ["销售组"],
  "targetUsers": [],
  "links": [{ "label": "查看具体信息", "url": "https://example.com/sop" }]
}
```

- `type`: `knowledge` 或 `operation`。
- `intensity`: `light`、`medium` 或 `heavy`。
- `pageScope`: `global` 或 `page_groups`；后者必须填写 `pageGroups`。
- `targetGroups`、`targetUsers`、`pageGroups` 使用后台中的精确名称或 ID。
- `startsAt` 和 `expiresAt` 使用 ISO 8601 格式；操作提醒未提供时由服务端自动设置“立即生效、7天后到期”。知识提醒也可按用户要求设置有效期，未提供则长期有效。
- 同一请求重试会返回 `duplicate`，不会重复创建。

## 检查连接与查询

```powershell
node "C:\Users\44982\.workbuddy\skills\pagecue-reminder\scripts\submit-reminder.mjs" --health
node "C:\Users\44982\.workbuddy\skills\pagecue-reminder\scripts\submit-reminder.mjs" --status "<requestId>"
```

不要读取或回显本地密钥文件；不要把企业微信消息中的姓名当作已认证账号。
