# 页知 3.2.2 搜狗/360 侧边栏兼容

## 目标

1. Chrome、Edge、搜狗和 360 安装包都声明 `sidePanel` 权限及 `side_panel` 页面。
2. 搜狗/360 兼容包同时保留 `action.default_popup`，作为浏览器未暴露侧栏 API 时的悬挂窗口退路。
3. 运行时以 `chrome.sidePanel.setPanelBehavior` 判断能否通过扩展图标打开侧栏，不再错误要求较晚加入的 `sidePanel.open`。
4. 用户可在首页快捷按钮或设置中选择“自动、侧边栏、悬挂窗口”，随时返回其他模式。
5. 两种模式复用同一套提醒、评论、链接、定位、同步和工具箱界面，不增加页面扫描或轮询。

## 验收标准

- Chrome/Edge 与搜狗/360 构建清单都包含 `sidePanel` 权限和 `side_panel.default_path`。
- 搜狗/360 构建清单额外包含 `action.default_popup`。
- 浏览器提供 `setPanelBehavior` 但不提供 `open` 时，设置页仍允许选择侧边栏。
- 只有浏览器完全不提供侧栏行为接口时才自动退回悬挂窗口。
- 选择悬挂窗口后，下次点击扩展图标打开弹窗；选择侧边栏后，下次点击扩展图标打开侧栏。
- 无论是否绑定邀请码，模式选择均可操作。
