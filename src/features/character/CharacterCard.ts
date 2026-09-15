/**
 * SillyTavern 角色卡解析器
 * 支持 PNG（tEXt 块）和 JSON 格式
 */

import { 
  Character, 
  TavernCard, 
  TavernCardV1, 
  TavernCardV2, 
  LegacyPersona, 
  LegacyAgent,
  ConversionResult 
} from './types';

/**
 * PNG tEXt 块解析器
 * SillyTavern 角色卡将 JSON 数据存储在 PNG 的 tEXt 块中，关键字为 "chara"
 */
export class CharacterCardParser {
  
  /**
   * 从 PNG ArrayBuffer 中提取角色数据
   */
  static async parseFromPNG(buffer: ArrayBuffer): Promise<ConversionResult<Character>> {
    try {
      const data = new Uint8Array(buffer);
      
      // 验证 PNG 签名
      const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
      for (let i = 0; i < 8; i++) {
        if (data[i] !== pngSignature[i]) {
          return { success: false, error: '无效的 PNG 文件' };
        }
      }
      
      // 查找 tEXt 块
      let offset = 8;
      while (offset < data.length) {
        const length = (data[offset] << 24) | (data[offset + 1] << 16) | 
                       (data[offset + 2] << 8) | data[offset + 3];
        const type = String.fromCharCode(data[offset + 4], data[offset + 5], 
                                         data[offset + 6], data[offset + 7]);
        
        if (type === 'tEXt') {
          const chunkData = data.slice(offset + 8, offset + 8 + length);
          const nullIndex = chunkData.indexOf(0);
          
          if (nullIndex !== -1) {
            const keyword = new TextDecoder('latin1').decode(chunkData.slice(0, nullIndex));
            
            if (keyword === 'chara') {
              const textData = new TextDecoder('latin1').decode(chunkData.slice(nullIndex + 1));
              
              // Base64 解码
              try {
                // atob() 返回 Latin-1 字符串，但实际是 UTF-8 字节
                // 需要转换为 Uint8Array 后用 UTF-8 解码
                const binaryStr = atob(textData);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                  bytes[i] = binaryStr.charCodeAt(i);
                }
                const jsonStr = new TextDecoder('utf-8').decode(bytes);
                const tavernCard = JSON.parse(jsonStr) as TavernCard;
                
                // 调试：输出原始数据结构
                console.log('[CharacterCard] 原始数据结构:', {
                  hasSpec: 'spec' in tavernCard,
                  spec: (tavernCard as any).spec,
                  hasData: 'data' in tavernCard,
                  topLevelKeys: Object.keys(tavernCard),
                  dataKeys: (tavernCard as any).data ? Object.keys((tavernCard as any).data) : [],
                  hasCharacterBook: (tavernCard as any).data?.character_book ? true : false,
                  characterBookEntries: (tavernCard as any).data?.character_book?.entries?.length || 0
                });
                
                return this.convertTavernCard(tavernCard);
              } catch (e) {
                return { success: false, error: `JSON 解析失败: ${e}` };
              }
            }
          }
        }
        
        // 移动到下一个块
        offset += 12 + length; // 4(length) + 4(type) + length + 4(crc)
        
        if (type === 'IEND') break;
      }
      
      return { success: false, error: '未找到角色数据（chara tEXt 块）' };
    } catch (e) {
      return { success: false, error: `PNG 解析错误: ${e}` };
    }
  }
  
  /**
   * 从 JSON 字符串解析角色数据
   */
  static parseFromJSON(jsonStr: string): ConversionResult<Character> {
    try {
      const data = JSON.parse(jsonStr);
      
      // 检查是否为本插件原生格式
      if (data.spec === 'obsidian_ai_v1') {
        return { success: true, data: data as Character };
      }
      
      // 尝试作为 SillyTavern 格式解析
      return this.convertTavernCard(data as TavernCard);
    } catch (e) {
      return { success: false, error: `JSON 解析错误: ${e}` };
    }
  }
  
  /**
   * 将 SillyTavern 卡片转换为本插件格式
   */
  static convertTavernCard(card: TavernCard): ConversionResult<Character> {
    const warnings: string[] = [];
    
    try {
      // 检测版本 - 更宽松的检测：只要有 data 对象就认为是 V2
      const hasV2Data = 'data' in card && typeof (card as any).data === 'object' && (card as any).data !== null;
      const isV2 = hasV2Data || ('spec' in card && card.spec === 'chara_card_v2');
      
      console.log('[CharacterCard] 格式检测:', { hasV2Data, isV2, spec: (card as any).spec });
      
      let character: Character;
      
      if (isV2) {
        const v2 = card as TavernCardV2;
        
        // 调试：检查原始数据中的 character_book
        const charBook = v2.data?.character_book;
        console.log(`[CharacterCard] V2 character_book 检查:`, {
          hasData: !!v2.data,
          hasCharacterBook: !!charBook,
          entriesCount: charBook?.entries?.length || 0,
          rawCharacterBook: charBook ? 'exists' : 'undefined'
        });
        
        character = {
          id: `imported-${Date.now()}`,
          spec: 'obsidian_ai_v1',
          name: v2.data.name || '未命名角色',
          description: v2.data.description || '',
          tags: v2.data.tags || [],
          creator: v2.data.creator || '',
          version: v2.data.character_version || '1.0',
          type: 'character',
          systemPrompt: v2.data.system_prompt || '',
          personality: v2.data.personality || '',
          scenario: v2.data.scenario || '',
          postHistoryInstructions: v2.data.post_history_instructions || '',
          creatorNotes: v2.data.creator_notes || '',
          greeting: v2.data.first_mes || '',
          alternateGreetings: v2.data.alternate_greetings || [],
          exampleMessages: v2.data.mes_example || '',
          characterBook: v2.data.character_book,
          extensions: v2.data.extensions || {},
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        
        // 兜底补全：将 description/personality/scenario 合并进系统提示词
        if (!character.systemPrompt && (v2.data.description || v2.data.personality || v2.data.scenario)) {
          character.systemPrompt = this.buildSystemPromptFromV1Fields(
            v2.data.description,
            v2.data.personality,
            v2.data.scenario
          );
          warnings.push('system_prompt 为空，已从 description/personality/scenario 自动生成');
        } else {
          character.systemPrompt = this.enrichSystemPromptWithV2Fields(
            character.systemPrompt,
            v2.data.description,
            v2.data.personality,
            v2.data.scenario
          );
        }
      } else {
        const v1 = card as TavernCardV1;
        character = {
          id: `imported-${Date.now()}`,
          spec: 'obsidian_ai_v1',
          name: v1.name || '未命名角色',
          description: v1.description || '',
          tags: [],
          type: 'character',
          systemPrompt: this.buildSystemPromptFromV1Fields(
            v1.description,
            v1.personality,
            v1.scenario
          ),
          personality: v1.personality || '',
          scenario: v1.scenario || '',
          greeting: v1.first_mes || '',
          exampleMessages: v1.mes_example || '',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        warnings.push('V1 格式角色卡，部分功能可能受限');
      }
      
      return { success: true, data: character, warnings };
    } catch (e) {
      return { success: false, error: `转换失败: ${e}` };
    }
  }
  
  /**
   * 从 V1 字段构建系统提示词
   */
  private static buildSystemPromptFromV1Fields(
    description?: string,
    personality?: string,
    scenario?: string
  ): string {
    const parts: string[] = [];
    
    if (description) {
      parts.push(`[角色描述]\n${description}`);
    }
    if (personality) {
      parts.push(`[性格特征]\n${personality}`);
    }
    if (scenario) {
      parts.push(`[场景设定]\n${scenario}`);
    }
    
    return parts.join('\n\n');
  }

  /**
   * 将 V2 的描述字段附加到已有系统提示词，避免导入后缺失角色信息。
   */
  private static enrichSystemPromptWithV2Fields(
    basePrompt?: string,
    description?: string,
    personality?: string,
    scenario?: string
  ): string {
    const base = String(basePrompt || '').trim();
    const extras = this.buildSystemPromptFromV1Fields(description, personality, scenario);
    if (!extras) return base;
    if (!base) return extras;
    return `${base}\n\n${extras}`.trim();
  }
  
  /**
   * 从旧版 Persona 转换
   */
  static convertFromPersona(persona: LegacyPersona): Character {
    return {
      id: persona.id,
      spec: 'obsidian_ai_v1',
      name: persona.name,
      description: persona.description,
      avatar: persona.avatar,
      tags: [],
      type: 'assistant',
      systemPrompt: persona.systemPrompt,
      mbti: persona.mbti,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  
  /**
   * 从旧版 Agent 转换
   */
  static convertFromAgent(agent: LegacyAgent): Character {
    return {
      id: agent.id,
      spec: 'obsidian_ai_v1',
      name: agent.name,
      description: agent.description,
      tags: [],
      type: 'tool-agent',
      systemPrompt: agent.systemPrompt,
      tools: agent.tools,
      model: agent.model,
      mbti: agent.mbti,
      isPreset: agent.isPreset,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }
  
  /**
   * 转换为 SillyTavern V2 格式
   */
  static toTavernCardV2(character: Character): TavernCardV2 {
    return {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: character.name,
        description: character.description,
        personality: character.personality || '',
        scenario: character.scenario || '',
        first_mes: character.greeting || '',
        mes_example: character.exampleMessages || '',
        creator_notes: character.creatorNotes || '',
        system_prompt: character.systemPrompt,
        post_history_instructions: character.postHistoryInstructions || '',
        alternate_greetings: character.alternateGreetings || [],
        character_book: character.characterBook,
        tags: character.tags || [],
        creator: character.creator || '',
        character_version: character.version || '1.0',
        extensions: {
          ...character.extensions,
          // 本插件特有字段放入 extensions
          obsidian_ai: {
            type: character.type,
            mbti: character.mbti,
            tools: character.tools,
            model: character.model,
            independentMemory: character.independentMemory,
          }
        },
      },
    };
  }
  
  /**
   * 导出为 JSON 字符串
   */
  static exportToJSON(character: Character, format: 'native' | 'tavern' = 'tavern'): string {
    if (format === 'native') {
      return JSON.stringify(character, null, 2);
    }
    return JSON.stringify(this.toTavernCardV2(character), null, 2);
  }

  /**
   * 导出为 PNG（带 tEXt 块嵌入角色数据）
   * @param character 角色数据
   * @param avatarDataUrl 头像图片 data URL（可选）
   * @returns PNG Blob
   */
  static async exportToPNG(character: Character, avatarDataUrl?: string): Promise<Blob> {
    // 生成 SillyTavern V2 JSON
    const tavernCard = this.toTavernCardV2(character);
    const jsonStr = JSON.stringify(tavernCard);
    const base64Data = btoa(unescape(encodeURIComponent(jsonStr)));
    
    // 获取或生成基础 PNG
    let pngBuffer: ArrayBuffer;
    if (avatarDataUrl && avatarDataUrl.startsWith('data:image/png')) {
      // 使用现有头像
      const base64 = avatarDataUrl.split(',')[1];
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      pngBuffer = bytes.buffer;
    } else {
      // 生成默认卡片图片
      pngBuffer = await this.generateDefaultCardImage(character);
    }
    
    // 嵌入 tEXt 块
    const resultBuffer = this.embedTextChunk(pngBuffer, 'chara', base64Data);
    return new Blob([resultBuffer], { type: 'image/png' });
  }

  /**
   * 生成默认的角色卡片图片
   */
  private static async generateDefaultCardImage(character: Character): Promise<ArrayBuffer> {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 600;
    const ctx = canvas.getContext('2d')!;
    
    // 渐变背景
    const gradient = ctx.createLinearGradient(0, 0, 400, 600);
    gradient.addColorStop(0, '#667eea');
    gradient.addColorStop(1, '#764ba2');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 400, 600);
    
    // 头像占位符（圆形）
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.arc(200, 180, 80, 0, Math.PI * 2);
    ctx.fill();
    
    // 首字母
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 72px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(character.name.charAt(0).toUpperCase(), 200, 180);
    
    // 角色名称
    ctx.font = 'bold 32px sans-serif';
    ctx.fillText(character.name, 200, 320);
    
    // 描述（截断）
    ctx.font = '16px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    const desc = character.description || '无描述';
    const maxWidth = 360;
    const words = desc.split('');
    let line = '';
    let y = 370;
    for (const char of words) {
      const testLine = line + char;
      if (ctx.measureText(testLine).width > maxWidth) {
        ctx.fillText(line, 200, y);
        line = char;
        y += 24;
        if (y > 520) {
          ctx.fillText('...', 200, y);
          break;
        }
      } else {
        line = testLine;
      }
    }
    if (line && y <= 520) {
      ctx.fillText(line, 200, y);
    }
    
    // 底部标签
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '12px sans-serif';
    ctx.fillText('Obsidian AI Chat Assistant', 200, 570);
    
    // 转换为 PNG
    return new Promise((resolve) => {
      canvas.toBlob((blob) => {
        blob!.arrayBuffer().then(resolve);
      }, 'image/png');
    });
  }

  /**
   * 将 tEXt 块嵌入 PNG
   */
  private static embedTextChunk(pngBuffer: ArrayBuffer, keyword: string, text: string): ArrayBuffer {
    const data = new Uint8Array(pngBuffer);
    
    // 创建 tEXt 块内容
    const keywordBytes = new TextEncoder().encode(keyword);
    const textBytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      textBytes[i] = text.charCodeAt(i) & 0xff;
    }
    
    // tEXt 块格式: keyword + null + text
    const chunkData = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
    chunkData.set(keywordBytes, 0);
    chunkData[keywordBytes.length] = 0; // null separator
    chunkData.set(textBytes, keywordBytes.length + 1);
    
    // 计算 CRC32
    const typeBytes = new Uint8Array([0x74, 0x45, 0x58, 0x74]); // "tEXt"
    const crcData = new Uint8Array(4 + chunkData.length);
    crcData.set(typeBytes, 0);
    crcData.set(chunkData, 4);
    const crc = this.crc32(crcData);
    
    // 构建完整的 tEXt 块
    const chunkLength = chunkData.length;
    const chunk = new Uint8Array(12 + chunkLength);
    // Length (4 bytes, big endian)
    chunk[0] = (chunkLength >> 24) & 0xff;
    chunk[1] = (chunkLength >> 16) & 0xff;
    chunk[2] = (chunkLength >> 8) & 0xff;
    chunk[3] = chunkLength & 0xff;
    // Type
    chunk.set(typeBytes, 4);
    // Data
    chunk.set(chunkData, 8);
    // CRC
    chunk[8 + chunkLength] = (crc >> 24) & 0xff;
    chunk[9 + chunkLength] = (crc >> 16) & 0xff;
    chunk[10 + chunkLength] = (crc >> 8) & 0xff;
    chunk[11 + chunkLength] = crc & 0xff;
    
    // 找到 IDAT 块位置，在其前插入 tEXt 块
    let insertPos = 8; // 跳过 PNG 签名
    while (insertPos < data.length) {
      const len = (data[insertPos] << 24) | (data[insertPos + 1] << 16) | 
                  (data[insertPos + 2] << 8) | data[insertPos + 3];
      const type = String.fromCharCode(data[insertPos + 4], data[insertPos + 5], 
                                       data[insertPos + 6], data[insertPos + 7]);
      
      if (type === 'IDAT') {
        break; // 在 IDAT 前插入
      }
      insertPos += 12 + len;
    }
    
    // 组合结果
    const result = new Uint8Array(data.length + chunk.length);
    result.set(data.slice(0, insertPos), 0);
    result.set(chunk, insertPos);
    result.set(data.slice(insertPos), insertPos + chunk.length);
    
    return result.buffer;
  }

  /**
   * 计算 CRC32
   */
  private static crc32(data: Uint8Array): number {
    let crc = 0xffffffff;
    const table = this.getCRC32Table();
    for (let i = 0; i < data.length; i++) {
      crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  private static crc32Table: number[] | null = null;
  private static getCRC32Table(): number[] {
    if (this.crc32Table) return this.crc32Table;
    
    this.crc32Table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      this.crc32Table[n] = c >>> 0;
    }
    return this.crc32Table;
  }
  
  /**
   * 从 Base64 图片数据中提取角色信息
   * 用于处理已经加载的图片
   */
  static async parseFromBase64PNG(base64: string): Promise<ConversionResult<Character>> {
    try {
      // 移除 data URL 前缀
      const base64Data = base64.replace(/^data:image\/png;base64,/, '');
      
      // 转换为 ArrayBuffer
      const binaryStr = atob(base64Data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      
      return this.parseFromPNG(bytes.buffer);
    } catch (e) {
      return { success: false, error: `Base64 解析错误: ${e}` };
    }
  }
}

/**
 * 辅助函数：读取文件为 ArrayBuffer
 */
export async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * 辅助函数：读取文件为文本
 */
export async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
