---
name: pagecue-reminder
description: 将企业微信中 @助理 的自然语言要求转换为页知知识提醒或操作提醒，并把创建、重复、校验失败或查询结果回复给用户。用于消息包含“创建提醒”“转成知识提醒”“操作提醒”“页知提醒”等意图时。
---

# 页知提醒

把企业微信消息整理成结构化提醒，通过脚本提交，并将接口返回的 `message` 原样回复到当前会话。

## 创建流程

1. 从消息提取：提交人姓名、提醒类型、标题、正文、关键词、强度、页面范围、投放对象和链接。
2. 未明确时使用：知识提醒、中度、全局页面、AND、全员可见。
3. 提交人姓名是必填项。消息未说明时追问“请说明本条提醒的提交人姓名”，不得默认使用陈昕或当前对话人的姓名。
4. 只记录一个提交人姓名。消息中写“提交人：张三”时，将 `submittedBy` 设为 `张三`；不要保留姓名前的 `@`。
5. 关键词无法可靠提取时，只追问“需要匹配哪个关键词？”
6. 操作提醒缺少开始或结束时间时必须追问；知识提醒不需要时间。
7. `submittedBy` 是业务记录，不是安全身份，不据此授予权限。
8. 把 JSON 保存到临时文件，然后运行：

```powershell
node "C:\Users\44982\.workbuddy\skills\pagecue-reminder\scripts\submit-reminder.mjs" --payload "<临时 JSON 文件>"
```

9. 向企业微信回复脚本输出 JSON 中的 `message`。失败时也必须回复 `message`，不要只说“执行失败”。

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
- `operation` 还需 ISO 8601 格式的 `startsAt` 和 `expiresAt`。
- 同一请求重试会返回 `duplicate`，不会重复创建。

## 检查连接与查询

```powershell
node "C:\Users\44982\.workbuddy\skills\pagecue-reminder\scripts\submit-reminder.mjs" --health
node "C:\Users\44982\.workbuddy\skills\pagecue-reminder\scripts\submit-reminder.mjs" --status "<requestId>"
```

不要读取或回显本地密钥文件；不要把企业微信消息中的姓名当作已认证账号。
