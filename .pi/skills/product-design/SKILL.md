---
name: product-design
description: "在 Pi Main Session 中完成设计上下文、三方案探索、选定视觉实现、本地截图和 design QA 闭环。"
---

# Product Design for Pi

这是 Pi runtime 的 Product Design 工作流适配。工作流语义保持为：

```text
get-context → ideate → 三个视觉方向 → 用户选择
→ image-to-code → localhost screenshot → design-qa
→ P0/P1/P2 修复并重新验证 → final result: passed
```

## Runtime 边界

- 只在当前 Main Session 的 Product Design capability gate 通过时使用。
- 不假设存在 ChatGPT Work Mode、Cloud Browser、Sites、sites-preview 或 ChatGPT artifact。
- 生成图片使用当前运行时提供的 `product_design_imagegen` 工具。
- 页面验证使用 `product_design_screenshot`，它只允许 `localhost`、`127.0.0.1` 和 `::1`。
- Internal Subagent 不获得本 Skill 的 Product Design 能力；Main Session 的 capability 不受子智能体模型影响。

## get-context

开始前读取当前项目相关上下文：

1. `AGENTS.md` 和项目规则。
2. 项目现有的设计语言、token、组件和风格约束（如果存在）。
3. 当前页面、相关组件、样式 token 和现有交互。
4. 用户目标、目标用户、页面范围和验收状态。

不要创建额外的 Product Design workflow 状态文件或新的设计规范文件。

## Visual source classification

先根据用户意图区分视觉输入。`visual reference != source visual truth`：提供的截图或 mockup 默认只是上下文，只有满足下列条件时才成为 source visual truth。

- **Faithful implementation / clone**：如果用户说“照这张图实现”“1:1 还原”或明确要求 faithful implementation，provided screenshot/mockup 就是 source visual truth。直接进入 `image-to-code`，不调用 `ideate`。
- **Redesign / improve / explore**：如果用户说“重新设计”“改进当前页面”或“基于这个页面探索方向”，provided screenshot/mockup 只是 visual reference。它不会自动成为 source visual truth，必须进入 `ideate`。
- **已选择的生成设计**：用户明确选中某张 `product_design_imagegen` 生成图后，该 selected generated design 才成为 source visual truth，随后进入 `image-to-code`。

在未完成上述分类前，不要把 visual reference 当作已选定的实现目标。

## ideate

当用户要求 redesign / improve / explore，或没有明确选定的视觉目标时，先生成恰好三个彼此有明显差异的视觉方向：

- 每个方向单独调用一次 `product_design_imagegen`。
- 如果用户提供了 screenshot/mockup/reference image，必须在每次调用的 `referenceImages` 参数中真实传入该 visual reference；不要只让 Main 用文字描述图片内容来替代 reference image。
- 每个结果保留图片内容、返回的 `savedPath` 和简短方向名称。
- 明确向用户展示三个方向并等待选择。
- 在用户选择前不要开始页面实现。

用户选择前，provided visual reference 和三个生成方向都不是 source visual truth。只有用户明确选择某个生成方向后，才将该图作为 source visual truth 交给 `image-to-code`。

## image-to-code

只有在 source visual truth 已明确后才开始实现：

1. 读取并检查选定的视觉源。
2. 结合当前项目组件体系和既有设计约束实现页面。
3. 保留真实图片资源，不用占位图、emoji、CSS 绘图或伪造图片链接代替视觉资产。
4. 实现核心交互、响应式布局和必要的 loading、empty、error、success 状态。
5. 记录选定视觉源路径和实现路径，方便后续 QA。

## browser screenshot

启动或使用项目本地开发服务后：

- 只能传入 `http(s)://localhost:*`、`http(s)://127.0.0.1:*` 或 `http(s)://[::1]:*`。
- 使用 `product_design_screenshot` 捕获与 source visual truth 相同 viewport 和交互状态。
- 保存返回的截图路径、URL、viewport、CSS 尺寸和 deviceScaleFactor。
- 外部 URL、局域网地址、metadata endpoint 或页面内非本地请求都视为 blocked。

## design-qa

截图后必须创建或更新项目根目录的 `design-qa.md`。报告必须同时打开并比较 source visual truth 和最新实现截图，不得仅凭代码或记忆判断。

报告至少包含：

- source visual truth 路径；
- implementation screenshot 路径；
- viewport、源图和实现图像素尺寸、CSS 尺寸、density normalization；
- 当前交互状态；
- full-view comparison；
- focused-region comparison，或说明为何不需要；
- 字体/排版、布局/间距、颜色/token、图片/资产、文案/内容五类检查；
- P0/P1/P2 findings、修复和每轮重新截图证据；
- 最后一行严格写入 `final result: passed` 或 `final result: blocked`。

发现 P0、P1 或 P2 时：

1. 记录问题并保持 `final result: blocked`。
2. 修复实现。
3. 使用相同 viewport 和状态重新截图。
4. 重新比较并记录修复证据。

只有没有遗留可执行的 P0/P1/P2 问题时才能写 `final result: passed`。截图、图片和 `design-qa.md` 都是 conversation/tool/artifact evidence，不要引入第二套持久化 workflow engine。
