import { App, TFile } from "obsidian";
import { logger } from "../../core/logger";

export interface CodeSymbolRecord {
  name: string;
  kind: "class" | "function" | "interface" | "type" | "const" | "enum" | "method";
  path: string;
  line: number;
  preview: string;
}

export interface CodeReferenceRecord {
  path: string;
  line: number;
  preview: string;
}

export interface CodeDependencyRecord {
  path: string;
  imports: string[];
  importedBy: string[];
}

interface IndexedFileEntry {
  mtime: number;
  symbols: CodeSymbolRecord[];
  imports: string[];
  content: string;
}

const SUPPORTED_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "py"]);

export class SymbolIndex {
  private fileIndex = new Map<string, IndexedFileEntry>();
  private importedBy = new Map<string, Set<string>>();
  private lastBuildAt = 0;

  constructor(private app: App) {}

  public async ensureIndexed(force = false): Promise<void> {
    const files = this.app.vault.getFiles().filter(file => SUPPORTED_EXTENSIONS.has(file.extension.toLowerCase()));
    if (!force && this.fileIndex.size > 0 && this.isFresh(files)) {
      return;
    }

    logger.info("Database", "Building code symbol index", { files: files.length });
    const nextIndex = new Map<string, IndexedFileEntry>();
    const nextImportedBy = new Map<string, Set<string>>();

    for (const file of files) {
      try {
        const content = await this.app.vault.cachedRead(file);
        const symbols = this.extractSymbols(file.path, content);
        const imports = this.extractImports(content);
        nextIndex.set(file.path, {
          mtime: file.stat.mtime,
          symbols,
          imports,
          content,
        });

        for (const imported of imports) {
          if (!nextImportedBy.has(imported)) nextImportedBy.set(imported, new Set());
          nextImportedBy.get(imported)!.add(file.path);
        }
      } catch (e) {
        logger.warn("Database", "Failed to index code file", { path: file.path, error: e });
      }
    }

    this.fileIndex = nextIndex;
    this.importedBy = nextImportedBy;
    this.lastBuildAt = Date.now();
  }

  public async findSymbols(query: string, exact = false, limit = 10): Promise<CodeSymbolRecord[]> {
    await this.ensureIndexed();
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];

    const all: CodeSymbolRecord[] = [];
    for (const entry of this.fileIndex.values()) {
      all.push(...entry.symbols);
    }

    const filtered = all.filter(symbol => {
      const name = symbol.name.toLowerCase();
      return exact ? name === q : name.includes(q);
    });

    return filtered
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path) || a.line - b.line)
      .slice(0, limit);
  }

  public async findReferences(symbolName: string, limit = 20): Promise<CodeReferenceRecord[]> {
    await this.ensureIndexed();
    const name = String(symbolName || "").trim();
    if (!name) return [];

    const pattern = new RegExp(`\\b${this.escapeRegExp(name)}\\b`);
    const out: CodeReferenceRecord[] = [];

    for (const [path, entry] of this.fileIndex.entries()) {
      const lines = entry.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!pattern.test(line)) continue;
        out.push({
          path,
          line: i + 1,
          preview: line.trim().slice(0, 200),
        });
        if (out.length >= limit) return out;
      }
    }

    return out;
  }

  public async listDependencies(pathLike: string): Promise<CodeDependencyRecord | null> {
    await this.ensureIndexed();
    const path = this.resolvePath(pathLike);
    if (!path) return null;
    const entry = this.fileIndex.get(path);
    if (!entry) return null;

    const importedBy = Array.from(this.importedBy.get(path) || []).sort();
    return {
      path,
      imports: [...entry.imports].sort(),
      importedBy,
    };
  }

  public async readCodeRegion(pathLike: string, opts: { symbol?: string; startLine?: number; endLine?: number }): Promise<string | null> {
    await this.ensureIndexed();
    const path = this.resolvePath(pathLike);
    if (!path) return null;
    const entry = this.fileIndex.get(path);
    if (!entry) return null;

    const lines = entry.content.split(/\r?\n/);

    if (opts.symbol) {
      const target = entry.symbols.find(symbol => symbol.name === opts.symbol);
      if (!target) return null;
      const start = Math.max(1, target.line - 2);
      const end = Math.min(lines.length, target.line + 20);
      return lines.slice(start - 1, end).map((line, idx) => `${start + idx}: ${line}`).join("\n");
    }

    const start = Math.max(1, Number(opts.startLine || 1));
    const end = Math.min(lines.length, Number(opts.endLine || start + 30));
    return lines.slice(start - 1, end).map((line, idx) => `${start + idx}: ${line}`).join("\n");
  }

  public async getStats(): Promise<{ files: number; symbols: number; lastBuildAt: number }> {
    await this.ensureIndexed();
    let symbols = 0;
    for (const entry of this.fileIndex.values()) symbols += entry.symbols.length;
    return { files: this.fileIndex.size, symbols, lastBuildAt: this.lastBuildAt };
  }

  private isFresh(files: TFile[]): boolean {
    if (files.length !== this.fileIndex.size) return false;
    for (const file of files) {
      const cached = this.fileIndex.get(file.path);
      if (!cached || cached.mtime !== file.stat.mtime) return false;
    }
    return true;
  }

  private extractSymbols(path: string, content: string): CodeSymbolRecord[] {
    const lines = content.split(/\r?\n/);
    const out: CodeSymbolRecord[] = [];
    const patterns: Array<{ kind: CodeSymbolRecord["kind"]; regex: RegExp }> = [
      { kind: "class", regex: /^(?:export\s+)?class\s+(\w+)/ },
      { kind: "function", regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/ },
      { kind: "interface", regex: /^(?:export\s+)?interface\s+(\w+)/ },
      { kind: "type", regex: /^(?:export\s+)?type\s+(\w+)\s*=/ },
      { kind: "enum", regex: /^(?:export\s+)?enum\s+(\w+)/ },
      { kind: "const", regex: /^(?:export\s+)?const\s+(\w+)\s*[:=]/ },
      { kind: "method", regex: /^\s{0,6}(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*\(/ },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of patterns) {
        const match = line.match(pattern.regex);
        if (!match) continue;
        const name = match[1];
        if (["if", "for", "while", "switch", "catch", "constructor"].includes(name)) continue;
        out.push({
          name,
          kind: pattern.kind,
          path,
          line: i + 1,
          preview: line.trim().slice(0, 200),
        });
        break;
      }
    }

    return out;
  }

  private extractImports(content: string): string[] {
    const imports: string[] = [];
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/from\s+["'](.+?)["']/) || line.match(/require\(["'](.+?)["']\)/);
      if (!match) continue;
      imports.push(match[1]);
    }
    return Array.from(new Set(imports));
  }

  private resolvePath(pathLike: string): string {
    const path = String(pathLike || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path) return "";
    if (this.fileIndex.has(path)) return path;
    const exact = Array.from(this.fileIndex.keys()).find(key => key.endsWith(path));
    return exact || path;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
