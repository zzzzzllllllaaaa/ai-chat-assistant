import { App, TFile, Plugin, Modal, Setting } from 'obsidian';
import { safeNotice } from '../../utils/notice';

export interface HistorySnapshot {
  id: string;
  filePath: string;
  timestamp: number;
  content: string; // Full content backup for safety
  description: string; // e.g. "Applied AI suggestion"
  model?: string;
}

export class HistoryManager {
  private app: App;
  private plugin: Plugin;
  private snapshots: Record<string, HistorySnapshot[]> = {}; // Keyed by filePath

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  async load() {
    const data = await this.plugin.loadData();
    if (data && data.history) {
      this.snapshots = data.history;
    }
  }

  async save() {
    const data = await this.plugin.loadData() || {};
    data.history = this.snapshots;
    await this.plugin.saveData(data);
  }

  async createSnapshot(file: TFile, content: string, description: string, model?: string) {
    if (!this.snapshots[file.path]) {
      this.snapshots[file.path] = [];
    }

    // Limit snapshots per file to save space (e.g., last 10)
    if (this.snapshots[file.path].length >= 10) {
      this.snapshots[file.path].shift(); // Remove oldest
    }

    const snapshot: HistorySnapshot = {
      id: Date.now().toString(),
      filePath: file.path,
      timestamp: Date.now(),
      content: content,
      description,
      model
    };

    this.snapshots[file.path].push(snapshot);
    await this.save();
  }

  getSnapshots(file: TFile): HistorySnapshot[] {
    return this.snapshots[file.path] || [];
  }

  async restoreSnapshot(file: TFile, snapshotId: string) {
    const snapshots = this.snapshots[file.path];
    if (!snapshots) return;

    const snapshot = snapshots.find(s => s.id === snapshotId);
    if (!snapshot) return;

    await this.app.vault.modify(file, snapshot.content);
  }
  
  clearHistory(file: TFile) {
    if (this.snapshots[file.path]) {
      delete this.snapshots[file.path];
      this.save();
    }
  }
}

export class HistoryModal extends Modal {
  private file: TFile;
  private manager: HistoryManager;

  constructor(app: App, manager: HistoryManager, file: TFile) {
    super(app);
    this.manager = manager;
    this.file = file;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Modification History: ${this.file.basename}` });

    const snapshots = this.manager.getSnapshots(this.file);

    if (snapshots.length === 0) {
      contentEl.createEl('p', { text: 'No history found for this file.' });
      return;
    }

    // Sort by timestamp descending
    snapshots.sort((a, b) => b.timestamp - a.timestamp);

    const list = contentEl.createEl('div', { cls: 'history-list' });

    snapshots.forEach(snapshot => {
      const item = list.createEl('div', { cls: 'history-item' });
      item.style.borderBottom = '1px solid var(--background-modifier-border)';
      item.style.padding = '10px 0';

      const header = item.createEl('div', { cls: 'history-item-header' });
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.marginBottom = '5px';

      const date = new Date(snapshot.timestamp).toLocaleString();
      const dateSpan = header.createEl('span', { text: date });
      dateSpan.style.fontWeight = 'bold';
      
      if (snapshot.model) {
         const modelSpan = header.createEl('span', { text: snapshot.model, cls: 'history-model-tag' });
         modelSpan.style.fontSize = '0.8em';
         modelSpan.style.background = 'var(--background-secondary)';
         modelSpan.style.padding = '2px 5px';
         modelSpan.style.borderRadius = '4px';
      }

      const descDiv = item.createEl('div', { text: snapshot.description });
      descDiv.style.marginBottom = '8px';

      const actions = item.createEl('div', { cls: 'history-actions' });
      
      new Setting(actions)
        .addButton(btn => btn
          .setButtonText('View Content')
          .onClick(() => {
             new SnapshotContentModal(this.app, snapshot).open();
          }))
        .addButton(btn => btn
          .setButtonText('Restore')
          .onClick(async () => {
            if (confirm(`Are you sure you want to restore this version? Current content will be overwritten.`)) {
                // Save current state before restoring? Maybe not needed if we assume restore is a new action that could be snapshotted too?
                // For now, let's just restore.
                await this.manager.restoreSnapshot(this.file, snapshot.id);
                safeNotice(`Restored to version from ${date}`);
                this.close();
            }
          }));
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class SnapshotContentModal extends Modal {
  private snapshot: HistorySnapshot;

  constructor(app: App, snapshot: HistorySnapshot) {
    super(app);
    this.snapshot = snapshot;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: `Snapshot Content: ${new Date(this.snapshot.timestamp).toLocaleString()}` });
    
    const textArea = contentEl.createEl('textarea');
    textArea.value = this.snapshot.content;
    textArea.style.width = '100%';
    textArea.style.height = '400px';
    textArea.readOnly = true;
  }

  onClose() {
    this.contentEl.empty();
  }
}

export {};
