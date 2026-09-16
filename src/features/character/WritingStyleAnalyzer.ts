/**
 * 文风分析器
 * 分析样本文本的文风特征，生成可用于 prompt 的文风描述
 */

import { WritingStyle, WritingStylePreset } from './types';

/**
 * 文风分析结果
 */
export interface StyleAnalysisResult {
  success: boolean;
  styleDescription?: string;
  dimensions?: WritingStyle['dimensions'];
  error?: string;
}

/**
 * 预设文风模板
 */
export const WRITING_STYLE_PRESETS: WritingStylePreset[] = [
  {
    id: 'high-density',
    name: '高信息密度',
    description: '言简意赅，每句话都携带有效信息，无废话',
    style: {
      styleDescription: '请采用高信息密度的写作风格：每一句话都应携带有效信息，避免冗余表达和客套话。用最少的字数传达最多的内容，但保持可读性。宁可言简意赅，也不要空洞铺陈。',
      dimensions: {
        informationDensity: 9,
        emotionalIntensity: 4,
        narrativePace: 7,
        rhetoricalLevel: 3,
        colloquialLevel: 5,
        detailLevel: 5,
      }
    }
  },
  {
    id: 'immersive-narrative',
    name: '沉浸叙事',
    description: '文学性强，情感细腻，善用细节和意象',
    style: {
      styleDescription: '请采用沉浸式叙事风格：善用感官细节和意象描写，让读者身临其境。情感表达细腻但不过度，通过动作和细节暗示情绪而非直接陈述。注重文字的韵律和节奏感。',
      dimensions: {
        informationDensity: 5,
        emotionalIntensity: 8,
        narrativePace: 5,
        rhetoricalLevel: 8,
        colloquialLevel: 3,
        detailLevel: 9,
      }
    }
  },
  {
    id: 'witty-sharp',
    name: '机智犀利',
    description: '语言锐利，善用讽刺和幽默，观点鲜明',
    style: {
      styleDescription: '请采用机智犀利的表达风格：语言锋利但不刻薄，善用讽刺和暗讽，幽默中带着洞见。观点鲜明，不怕表态，但论据要站得住脚。可以适度挑衅读者的思维定式。',
      dimensions: {
        informationDensity: 7,
        emotionalIntensity: 6,
        narrativePace: 8,
        rhetoricalLevel: 7,
        colloquialLevel: 6,
        detailLevel: 4,
      }
    }
  },
  {
    id: 'casual-chat',
    name: '轻松闲聊',
    description: '口语化，像朋友聊天一样自然随意',
    style: {
      styleDescription: '请用轻松口语化的风格回复：就像跟老朋友聊天一样，自然随意，可以用语气词和网络流行语。不需要太正式，但要有自己的态度和个性。',
      dimensions: {
        informationDensity: 4,
        emotionalIntensity: 6,
        narrativePace: 6,
        rhetoricalLevel: 3,
        colloquialLevel: 9,
        detailLevel: 4,
      }
    }
  },
  {
    id: 'academic-precise',
    name: '学术精确',
    description: '用词准确，逻辑严密，结构清晰',
    style: {
      styleDescription: '请采用学术精确的表达风格：用词准确专业，逻辑链条完整，论证有理有据。结构清晰，适当使用标题和列表组织内容。避免模糊表述和绝对化判断。',
      dimensions: {
        informationDensity: 8,
        emotionalIntensity: 2,
        narrativePace: 5,
        rhetoricalLevel: 4,
        colloquialLevel: 1,
        detailLevel: 7,
      }
    }
  },
];

/**
 * 生成文风分析 prompt
 */
export function buildStyleAnalysisPrompt(sampleText: string): string {
  return `你是一个专业的文学风格分析师。请分析以下文本的写作风格，并生成一段简洁的风格描述，这段描述将被用于指导 AI 模仿该风格进行写作。

【样本文本】
${sampleText}

【分析要求】
1. 识别文本的核心风格特征（如信息密度、叙事节奏、修辞手法、情感表达等）
2. 注意捕捉作者独特的表达习惯和语言特色
3. 不要简单复制样本内容，而是提炼其风格精髓

【输出格式】
请严格按以下 JSON 格式输出（不要有其他内容）：

{
  "styleDescription": "一段 100-200 字的风格描述，用于指导 AI 模仿该风格写作。描述应当具体、可操作，避免空泛的形容词堆砌。",
  "dimensions": {
    "informationDensity": 1-10 的数字（信息密度，越高信息越密集），
    "emotionalIntensity": 1-10 的数字（情感强度），
    "narrativePace": 1-10 的数字（叙事节奏，越高越快），
    "rhetoricalLevel": 1-10 的数字（修辞程度），
    "colloquialLevel": 1-10 的数字（口语化程度），
    "detailLevel": 1-10 的数字（细节描写程度）
  },
  "keyFeatures": ["特征1", "特征2", "特征3"]
}`;
}

/**
 * 解析文风分析结果
 */
export function parseStyleAnalysisResponse(response: string): StyleAnalysisResult {
  try {
    // 尝试提取 JSON 部分
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: '无法解析响应格式' };
    }
    
    const data = JSON.parse(jsonMatch[0]);
    
    if (!data.styleDescription) {
      return { success: false, error: '响应缺少 styleDescription' };
    }
    
    return {
      success: true,
      styleDescription: data.styleDescription,
      dimensions: data.dimensions ? {
        informationDensity: clampDimension(data.dimensions.informationDensity),
        emotionalIntensity: clampDimension(data.dimensions.emotionalIntensity),
        narrativePace: clampDimension(data.dimensions.narrativePace),
        rhetoricalLevel: clampDimension(data.dimensions.rhetoricalLevel),
        colloquialLevel: clampDimension(data.dimensions.colloquialLevel),
        detailLevel: clampDimension(data.dimensions.detailLevel),
      } : undefined,
    };
  } catch (e) {
    return { success: false, error: `解析失败: ${e}` };
  }
}

/**
 * 限制维度值在 1-10 范围内
 */
function clampDimension(value: any): number | undefined {
  if (typeof value !== 'number') return undefined;
  return Math.max(1, Math.min(10, Math.round(value)));
}

/**
 * 根据文风设置生成用于 prompt 的文风指令
 */
export function buildStyleInstruction(style: WritingStyle): string {
  if (!style.enabled) return '';
  
  const parts: string[] = [];
  
  // 主要文风描述
  if (style.styleDescription) {
    parts.push(`【写作风格】\n${style.styleDescription}`);
  }
  
  // 维度微调（如果用户有调整）
  if (style.dimensions) {
    const adjustments: string[] = [];
    const d = style.dimensions;
    
    if (d.informationDensity !== undefined) {
      if (d.informationDensity >= 8) {
        adjustments.push('保持高信息密度，避免冗余');
      } else if (d.informationDensity <= 3) {
        adjustments.push('可以适当展开，不必过于精简');
      }
    }
    
    if (d.emotionalIntensity !== undefined) {
      if (d.emotionalIntensity >= 8) {
        adjustments.push('情感表达可以更丰富浓烈');
      } else if (d.emotionalIntensity <= 3) {
        adjustments.push('情感表达克制内敛');
      }
    }
    
    if (d.narrativePace !== undefined) {
      if (d.narrativePace >= 8) {
        adjustments.push('叙事节奏要快');
      } else if (d.narrativePace <= 3) {
        adjustments.push('叙事可以从容舒缓');
      }
    }
    
    if (d.colloquialLevel !== undefined) {
      if (d.colloquialLevel >= 8) {
        adjustments.push('用口语化的方式表达');
      } else if (d.colloquialLevel <= 3) {
        adjustments.push('保持书面语风格');
      }
    }
    
    if (adjustments.length > 0) {
      parts.push(`【风格微调】\n${adjustments.join('；')}`);
    }
  }
  
  // 自定义指令
  if (style.customInstructions) {
    parts.push(`【额外要求】\n${style.customInstructions}`);
  }
  
  return parts.join('\n\n');
}

/**
 * 将文风设置合并到系统提示词
 */
export function applyStyleToSystemPrompt(systemPrompt: string, style: WritingStyle | undefined): string {
  if (!style || !style.enabled) return systemPrompt;
  
  const styleInstruction = buildStyleInstruction(style);
  if (!styleInstruction) return systemPrompt;
  
  // 在系统提示词末尾添加文风指令
  return `${systemPrompt}\n\n${styleInstruction}`;
}

/**
 * 维度标签
 */
export const DIMENSION_LABELS: Record<string, { name: string; lowLabel: string; highLabel: string }> = {
  informationDensity: { name: '信息密度', lowLabel: '舒展', highLabel: '精炼' },
  emotionalIntensity: { name: '情感强度', lowLabel: '克制', highLabel: '浓烈' },
  narrativePace: { name: '叙事节奏', lowLabel: '舒缓', highLabel: '紧凑' },
  rhetoricalLevel: { name: '修辞程度', lowLabel: '朴素', highLabel: '华丽' },
  colloquialLevel: { name: '口语化', lowLabel: '书面', highLabel: '口语' },
  detailLevel: { name: '细节程度', lowLabel: '简略', highLabel: '详尽' },
};
