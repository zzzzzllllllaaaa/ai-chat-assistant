/**
 * PDF 文本提取器
 * 使用 Obsidian 内置的 pdfjs 库提取 PDF 文件中的文本内容
 */
import { loadPdfJs } from 'obsidian';

let pdfjsLib: any = null;

/**
 * 确保 pdfjs 库已加载（延迟加载，首次调用时初始化）
 */
async function ensurePdfJs(): Promise<any> {
    if (!pdfjsLib) {
        pdfjsLib = await loadPdfJs();
    }
    return pdfjsLib;
}

export interface PdfExtractionResult {
    text: string;
    pageCount: number;
    extractedPages: number;
    truncated: boolean;
}

/**
 * 从 PDF ArrayBuffer 中提取文本内容
 * @param buffer PDF 文件的 ArrayBuffer
 * @param maxPages 最大提取页数（默认 100，防止巨大 PDF 卡死）
 * @param maxChars 最大字符数（默认 200000，约 20 万字）
 * @returns 提取的文本和元信息
 */
export async function extractPdfText(
    buffer: ArrayBuffer,
    maxPages: number = 100,
    maxChars: number = 200000
): Promise<PdfExtractionResult> {
    const pdfjs = await ensurePdfJs();

    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
    }).promise;

    const totalPages = doc.numPages;
    const pagesToExtract = Math.min(totalPages, maxPages);
    const pages: string[] = [];
    let totalChars = 0;
    let truncated = false;

    for (let i = 1; i <= pagesToExtract; i++) {
        if (totalChars >= maxChars) {
            truncated = true;
            break;
        }

        try {
            const page = await doc.getPage(i);
            const textContent = await page.getTextContent();

            // 智能拼接文本：处理行内空格和换行
            let pageText = '';
            let lastY: number | null = null;

            for (const item of textContent.items) {
                if (!item.str && item.str !== '') continue;

                // 检测换行：当 Y 坐标变化时，认为是新行
                const currentY = item.transform ? item.transform[5] : null;
                if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 2) {
                    pageText += '\n';
                } else if (pageText.length > 0 && !pageText.endsWith('\n') && item.str.length > 0) {
                    // 同一行的文本片段之间可能需要空格
                    if (item.hasEOL) {
                        pageText += '\n';
                    }
                }
                pageText += item.str;
                lastY = currentY;
            }

            const trimmed = pageText.trim();
            if (trimmed) {
                pages.push(trimmed);
                totalChars += trimmed.length;
            }
        } catch (pageError: any) {
            // 某一页提取失败不影响其他页
            pages.push(`[第 ${i} 页提取失败: ${pageError?.message || '未知错误'}]`);
        }
    }

    if (pagesToExtract < totalPages) {
        truncated = true;
    }

    let text = pages.join('\n\n');

    // 如果超过最大字符数，截断
    if (text.length > maxChars) {
        text = text.slice(0, maxChars) + '\n\n…（内容已截断）';
        truncated = true;
    }

    return {
        text,
        pageCount: totalPages,
        extractedPages: pages.length,
        truncated,
    };
}

/**
 * 从 PDF 提取文本，返回格式化的字符串（包含元信息头部）
 */
export async function extractPdfTextFormatted(
    buffer: ArrayBuffer,
    filename: string,
    maxPages?: number,
    maxChars?: number
): Promise<string> {
    try {
        const result = await extractPdfText(buffer, maxPages, maxChars);

        if (!result.text.trim()) {
            return `[PDF 文件: ${filename}]\n[共 ${result.pageCount} 页，未能提取到文本内容。该 PDF 可能是扫描件/图片 PDF，需要 OCR 才能识别文字。]`;
        }

        let header = `[PDF 文件: ${filename}，共 ${result.pageCount} 页`;
        if (result.truncated) {
            header += `，已提取前 ${result.extractedPages} 页`;
        }
        header += ']\n\n';

        return header + result.text;
    } catch (error: any) {
        return `[PDF 文件: ${filename}]\n[提取文本失败: ${error?.message || '未知错误'}。该文件可能已加密或损坏。]`;
    }
}

/** 判断文件扩展名是否为 PDF */
export function isPdf(extension: string): boolean {
    return extension.toLowerCase() === 'pdf';
}

/** 支持文本提取的非 Markdown 文件扩展名 */
const EXTRACTABLE_EXTENSIONS = new Set(['pdf']);

/** 判断文件是否支持文本提取 */
export function isExtractableFile(extension: string): boolean {
    return EXTRACTABLE_EXTENSIONS.has(extension.toLowerCase());
}
