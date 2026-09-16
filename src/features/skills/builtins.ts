/**
 * 内置技能定义
 * 
 * 这些技能展示了 Skills 系统的能力，同时提供实用功能
 */

import { Skill } from "./types";

/**
 * 文章总结技能
 */
export const summarizeSkill: Skill = {
  id: "builtin-summarize",
  name: "智能总结",
  description: "总结文章、笔记或任意文本内容，提取核心观点",
  version: "1.0.0",
  author: "AI Chat Assistant",
  source: "builtin",
  icon: "📝",
  tags: ["总结", "阅读", "笔记"],
  
  triggers: [
    { type: "keyword", value: ["总结", "概括", "摘要", "summarize", "summary"] },
    { type: "command", value: ["summarize", "sum"] },
    { type: "regex", value: "^(帮我|请)?总结(一下)?.*" }
  ],
  
  parameters: [
    { name: "content", type: "string", description: "要总结的内容", required: true },
    { name: "style", type: "string", description: "总结风格", enum: ["bullet", "paragraph", "outline"] }
  ],
  
  requiredTools: ["read_note", "knowledge_base_query"],
  
  steps: [
    {
      id: "analyze",
      name: "分析内容",
      type: "llm",
      prompt: `请分析以下内容，识别其主题和关键信息：

{{input}}

请输出：
1. 主题
2. 关键词（3-5个）
3. 内容类型（文章/笔记/对话/代码等）`,
      outputKey: "analysis"
    },
    {
      id: "summarize",
      name: "生成总结",
      type: "llm",
      prompt: `基于以下分析结果，生成一份简洁有力的总结：

分析结果：
{{outputs.analysis}}

原始内容：
{{input}}

要求：
- 突出核心观点
- 保留关键数据和事实
- 使用清晰的结构
- 控制在 200 字以内`,
      outputKey: "summary",
      dependsOn: ["analyze"]
    }
  ]
};

/**
 * 周报生成技能
 */
export const weeklyReportSkill: Skill = {
  id: "builtin-weekly-report",
  name: "周报助手",
  description: "基于本周的笔记和活动，自动生成周报",
  version: "1.0.0",
  author: "AI Chat Assistant",
  source: "builtin",
  icon: "📊",
  tags: ["周报", "工作", "汇报"],
  
  triggers: [
    { type: "keyword", value: ["周报", "weekly report", "本周总结"] },
    { type: "command", value: ["weekly", "wr"] },
    { type: "regex", value: "^(写|生成|帮我写)(一份)?周报.*" }
  ],
  
  requiredTools: ["search_notes", "get_recent_notes", "knowledge_base_query"],
  
  steps: [
    {
      id: "gather",
      name: "收集本周内容",
      type: "tool",
      toolName: "get_recent_notes",
      toolArgs: { days: 7, limit: 20 },
      outputKey: "recentNotes"
    },
    {
      id: "extract",
      name: "提取工作事项",
      type: "llm",
      prompt: `请从以下本周笔记中提取工作相关的事项：

{{outputs.recentNotes}}

请分类整理：
1. 已完成的工作
2. 进行中的工作
3. 遇到的问题
4. 学习/成长`,
      outputKey: "workItems",
      dependsOn: ["gather"]
    },
    {
      id: "generate",
      name: "生成周报",
      type: "llm",
      prompt: `请基于以下信息生成一份正式的周报：

{{outputs.workItems}}

用户补充说明：{{input}}

周报格式要求：
## 本周工作总结

### 一、已完成工作
（列出已完成的主要工作）

### 二、进行中工作
（列出正在进行的工作及进度）

### 三、遇到的问题
（如有问题，说明问题和解决方案）

### 四、下周计划
（根据本周情况推断下周重点）

### 五、其他
（可选：学习心得、建议等）`,
      outputKey: "report",
      dependsOn: ["extract"]
    }
  ]
};

/**
 * 笔记整理技能
 */
export const organizeNotesSkill: Skill = {
  id: "builtin-organize-notes",
  name: "笔记整理",
  description: "整理和优化笔记结构，添加链接和标签",
  version: "1.0.0",
  author: "AI Chat Assistant",
  source: "builtin",
  icon: "🗂️",
  tags: ["整理", "笔记", "结构"],
  
  triggers: [
    { type: "keyword", value: ["整理笔记", "优化笔记", "organize notes"] },
    { type: "command", value: ["organize", "tidy"] }
  ],
  
  requiredTools: ["read_note", "get_note_structure", "search_notes", "modify_note"],
  
  steps: [
    {
      id: "read",
      name: "读取笔记",
      type: "tool",
      toolName: "read_note",
      toolArgs: { path: "{{input}}" },
      outputKey: "noteContent"
    },
    {
      id: "analyze-structure",
      name: "分析结构",
      type: "llm",
      prompt: `请分析这篇笔记的结构和内容：

{{outputs.noteContent}}

请识别：
1. 当前结构问题（如标题层级混乱、缺少分段等）
2. 内容主题和关键词
3. 可能的关联笔记（基于内容推测）
4. 建议的标签`,
      outputKey: "analysis",
      dependsOn: ["read"]
    },
    {
      id: "suggest",
      name: "生成优化建议",
      type: "llm",
      prompt: `基于分析结果，生成笔记优化建议：

分析结果：
{{outputs.analysis}}

请提供：
1. 推荐的结构调整
2. 建议添加的内部链接 [[笔记名]]
3. 建议的标签 #tag
4. 其他优化建议`,
      outputKey: "suggestions",
      dependsOn: ["analyze-structure"]
    }
  ]
};

/**
 * 问答研究技能
 */
export const researchSkill: Skill = {
  id: "builtin-research",
  name: "深度研究",
  description: "基于知识库进行深度问答研究，整合多个来源的信息",
  version: "1.0.0",
  author: "AI Chat Assistant",
  source: "builtin",
  icon: "🔍",
  tags: ["研究", "问答", "知识库"],
  
  triggers: [
    { type: "keyword", value: ["研究", "深入了解", "详细解释", "research"] },
    { type: "regex", value: "^(帮我|请)?研究(一下)?.*" }
  ],
  
  requiredTools: ["knowledge_base_query", "search_notes", "read_note"],
  
  steps: [
    {
      id: "search-kb",
      name: "搜索知识库",
      type: "tool",
      toolName: "knowledge_base_query",
      toolArgs: { query: "{{input}}", limit: 10 },
      outputKey: "kbResults"
    },
    {
      id: "search-notes",
      name: "搜索笔记",
      type: "tool",
      toolName: "search_notes",
      toolArgs: { query: "{{input}}", limit: 5 },
      outputKey: "noteResults"
    },
    {
      id: "synthesize",
      name: "综合分析",
      type: "llm",
      prompt: `请基于以下搜索结果，对用户的问题进行深度研究和回答：

用户问题：{{input}}

知识库搜索结果：
{{outputs.kbResults}}

笔记搜索结果：
{{outputs.noteResults}}

请提供：
1. 直接回答（简洁版）
2. 详细解释（包含背景、原理、示例）
3. 相关知识点
4. 进一步学习建议
5. 参考来源`,
      outputKey: "research",
      dependsOn: ["search-kb", "search-notes"]
    }
  ]
};

/**
 * 代码审查技能
 */
export const codeReviewSkill: Skill = {
  id: "builtin-code-review",
  name: "代码审查",
  description: "审查代码质量，提供改进建议",
  version: "1.0.0",
  author: "AI Chat Assistant",
  source: "builtin",
  icon: "👨‍💻",
  tags: ["代码", "审查", "编程"],
  
  triggers: [
    { type: "keyword", value: ["代码审查", "review代码", "code review", "检查代码"] },
    { type: "command", value: ["review", "cr"] },
    { type: "regex", value: "^(帮我|请)?(审查|检查|review)(一下)?.*代码.*" }
  ],
  
  requiredCapabilities: ["code"],
  
  steps: [
    {
      id: "analyze-code",
      name: "分析代码",
      type: "llm",
      prompt: `请对以下代码进行全面分析：

{{input}}

请从以下维度分析：
1. 代码质量（可读性、命名规范、注释）
2. 潜在问题（bug、安全漏洞、性能问题）
3. 最佳实践（设计模式、DRY原则等）
4. 类型/语法检查`,
      outputKey: "analysis"
    },
    {
      id: "suggestions",
      name: "生成建议",
      type: "llm",
      prompt: `基于代码分析结果，生成具体的改进建议：

分析结果：
{{outputs.analysis}}

请提供：
## 代码审查报告

### 总体评价
（一句话总结代码质量）

### 发现的问题
（按严重程度排序）

### 改进建议
（具体的代码修改建议）

### 优化后的代码
（如果需要大改，提供重构版本）`,
      outputKey: "review",
      dependsOn: ["analyze-code"]
    }
  ]
};

/**
 * 翻译技能
 */
export const translateSkill: Skill = {
  id: "builtin-translate",
  name: "智能翻译",
  description: "高质量翻译，支持多语言和专业领域",
  version: "1.0.0",
  author: "AI Chat Assistant",
  source: "builtin",
  icon: "🌐",
  tags: ["翻译", "语言", "多语言"],

  triggers: [
    { type: "keyword", value: ["翻译", "translate", "译成"] },
    { type: "command", value: ["translate", "tr"] },
    { type: "regex", value: "^(帮我|请)?翻译.*" }
  ],

  steps: [
    {
      id: "detect",
      name: "检测语言",
      type: "llm",
      prompt: `请检测以下文本的语言，并确定目标翻译语言：

{{input}}

请输出 JSON 格式：
{
  "sourceLanguage": "检测到的源语言",
  "targetLanguage": "推断的目标语言（如果用户没指定，中文内容翻译成英文，其他语言翻译成中文）",
  "domain": "专业领域（如：技术、法律、医学、通用等）",
  "textToTranslate": "需要翻译的文本部分"
}`,
      outputKey: "detection"
    },
    {
      id: "translate",
      name: "执行翻译",
      type: "llm",
      prompt: `请执行高质量翻译：

语言信息：
{{outputs.detection}}

翻译要求：
1. 准确传达原文含义
2. 符合目标语言的表达习惯
3. 保持专业术语的准确性
4. 如有歧义，提供多个版本

请输出：
## 翻译结果
（主要翻译）

## 替代版本
（如果有其他翻译方式）

## 注释
（重要术语或文化背景说明）`,
      outputKey: "translation",
      dependsOn: ["detect"]
    }
  ]
};

/**
 * 执行文档自测技能
 */
export const selfTestSkill: Skill = {
  id: "builtin-self-test",
  name: "执行文档自测",
  description: "根据执行文档或默认校验流程运行自测，并输出 STATUS 风格验证摘要",
  version: "1.0.0",
  author: "AI Chat Assistant",
  source: "builtin",
  icon: "🧪",
  tags: ["自测", "验证", "构建"],

  triggers: [
    { type: "keyword", value: ["自测", "self-test", "self test", "验证构建"] },
    { type: "command", value: ["self-test", "selftest"] },
    { type: "regex", value: "^(帮我|请)?(做一次)?自测.*" }
  ],

  parameters: [
    { name: "executionDoc", type: "string", description: "执行文档路径或执行文档内容", required: false }
  ],

  steps: [
    {
      id: "self-test-runtime",
      name: "执行自测",
      type: "transform",
      transform: "input",
      outputKey: "selfTestInput"
    }
  ]
};

/**
 * 获取所有内置技能
 */
export function getBuiltinSkills(): Skill[] {
  return [
    summarizeSkill,
    weeklyReportSkill,
    organizeNotesSkill,
    researchSkill,
    codeReviewSkill,
    translateSkill,
    selfTestSkill
  ];
}
