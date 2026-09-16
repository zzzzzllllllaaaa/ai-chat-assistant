/**
 * 可搜索的模型选择器组件
 * 支持搜索过滤、键盘导航、点击选择
 */

export interface ModelOption {
  value: string;       // 唯一标识（可能是 model 或 model@connectionId）
  displayText: string; // 显示文本
  model: string;       // 纯模型名
  connectionName?: string; // 连接名
}

export interface SearchableModelSelectOptions {
  placeholder?: string;
  onSelect: (value: string) => void;
  initialValue?: string;
}

export class SearchableModelSelect {
  private containerEl: HTMLElement;
  private inputEl!: HTMLInputElement;
  private dropdownEl!: HTMLElement;
  private options: ModelOption[] = [];
  private filteredOptions: ModelOption[] = [];
  private selectedIndex = -1;
  private isOpen = false;
  private currentValue = '';
  private onSelect: (value: string) => void;
  private placeholder: string;

  constructor(parent: HTMLElement, opts: SearchableModelSelectOptions) {
    this.onSelect = opts.onSelect;
    this.placeholder = opts.placeholder || '搜索模型...';
    this.currentValue = opts.initialValue || '';
    
    this.containerEl = parent.createDiv({ cls: 'searchable-model-select' });
    this.createInput();
    this.createDropdown();
    this.setupEventListeners();
  }

  private createInput() {
    const inputWrap = this.containerEl.createDiv({ cls: 'searchable-model-input-wrap' });
    this.inputEl = inputWrap.createEl('input', {
      type: 'text',
      cls: 'searchable-model-input',
      placeholder: this.placeholder,
    });
    
    // 下拉箭头
    const chevron = inputWrap.createDiv({ cls: 'searchable-model-chevron' });
    const svg = chevron.createSvg('svg', { attr: { xmlns: 'http://www.w3.org/2000/svg', width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } });
    svg.createSvg('polyline', { attr: { points: '6 9 12 15 18 9' } });
  }

  private createDropdown() {
    this.dropdownEl = this.containerEl.createDiv({ cls: 'searchable-model-dropdown' });
    this.dropdownEl.setCssStyles({ display: 'none' });
  }

  private setupEventListeners() {
    // 输入框事件
    this.inputEl.addEventListener('focus', () => this.showDropdown());
    this.inputEl.addEventListener('input', () => this.onInputChange());
    this.inputEl.addEventListener('keydown', (e) => this.onKeyDown(e));
    
    // 点击容器显示下拉
    this.containerEl.addEventListener('click', (e) => {
      if (e.target !== this.inputEl) {
        this.inputEl.focus();
      }
    });
    
    // 点击外部关闭
    document.addEventListener('click', (e) => {
      if (!this.containerEl.contains(e.target as Node)) {
        this.hideDropdown(true); // 恢复显示
      }
    });
  }

  private onInputChange() {
    const query = this.inputEl.value.toLowerCase().trim();
    this.filterOptions(query);
    
    // 确保下拉列表打开
    if (!this.isOpen) {
      this.isOpen = true;
      this.dropdownEl.setCssStyles({ display: 'block' });
    }
    
    this.renderDropdown();
    this.selectedIndex = this.filteredOptions.length > 0 ? 0 : -1;
    this.highlightSelected();
  }

  private filterOptions(query: string) {
    if (!query) {
      this.filteredOptions = [...this.options];
      return;
    }
    
    this.filteredOptions = this.options.filter(opt => {
      const searchText = `${opt.model} ${opt.connectionName || ''} ${opt.displayText}`.toLowerCase();
      return searchText.includes(query);
    });
  }

  private onKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!this.isOpen) {
          this.showDropdown();
        } else {
          this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredOptions.length - 1);
          this.highlightSelected();
          this.scrollToSelected();
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.highlightSelected();
        this.scrollToSelected();
        break;
      case 'Enter':
        e.preventDefault();
        if (this.selectedIndex >= 0 && this.selectedIndex < this.filteredOptions.length) {
          this.selectOption(this.filteredOptions[this.selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        this.hideDropdown(true); // 恢复显示
        this.inputEl.blur();
        break;
    }
  }

  private showDropdown() {
    this.isOpen = true;
    this.dropdownEl.setCssStyles({ display: 'block' });
    
    // 检测是否需要向上展开（底部空间不足）
    this.adjustDropdownPosition();
    
    // 如果输入框显示的是当前选中项的完整文本，则先清空以显示所有选项
    // 用户可以直接输入搜索，或者看到完整列表后再选择
    const currentDisplayText = this.inputEl.value;
    const isShowingSelectedValue = this.currentValue && 
      this.options.some(o => o.value === this.currentValue && o.displayText === currentDisplayText);
    
    if (isShowingSelectedValue) {
      // 显示所有选项
      this.filteredOptions = [...this.options];
    } else {
      // 用户已经在输入搜索词，按搜索词过滤
      this.filterOptions(currentDisplayText.toLowerCase().trim());
    }
    
    this.renderDropdown();
    
    // 如果显示的是选中值，高亮当前选中项
    if (isShowingSelectedValue && this.currentValue) {
      this.selectedIndex = this.filteredOptions.findIndex(o => o.value === this.currentValue);
      if (this.selectedIndex === -1) this.selectedIndex = 0;
    } else {
      this.selectedIndex = this.filteredOptions.length > 0 ? 0 : -1;
    }
    this.highlightSelected();
    this.scrollToSelected();
  }

  /**
   * 检测并调整下拉框位置（向上或向下展开）
   */
  private adjustDropdownPosition() {
    const inputRect = this.inputEl.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const dropdownHeight = 280; // max-height from CSS
    
    // 计算底部剩余空间
    const spaceBelow = viewportHeight - inputRect.bottom;
    const spaceAbove = inputRect.top;
    
    // 如果底部空间不足且上方空间更大，则向上展开
    if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
      this.dropdownEl.classList.add('dropdown-upward');
      this.dropdownEl.classList.remove('dropdown-downward');
    } else {
      this.dropdownEl.classList.add('dropdown-downward');
      this.dropdownEl.classList.remove('dropdown-upward');
    }
  }

  private hideDropdown(restoreValue = false) {
    this.isOpen = false;
    this.dropdownEl.setCssStyles({ display: 'none' });
    // 只有在指定 restoreValue 时才恢复显示当前选中的值
    // 这样用户在输入时可以自由编辑，只有点击外部关闭时才恢复
    if (restoreValue && this.currentValue) {
      const opt = this.options.find(o => o.value === this.currentValue);
      if (opt) {
        this.inputEl.value = opt.displayText;
      }
    }
  }

  private renderDropdown() {
    this.dropdownEl.empty();
    
    if (this.filteredOptions.length === 0) {
      const emptyEl = this.dropdownEl.createDiv({ cls: 'searchable-model-empty' });
      emptyEl.textContent = '无匹配模型';
      return;
    }

    this.filteredOptions.forEach((opt, index) => {
      const itemEl = this.dropdownEl.createDiv({ 
        cls: 'searchable-model-item',
        attr: { 'data-index': String(index) }
      });
      
      // 模型名
      const modelNameEl = itemEl.createSpan({ cls: 'searchable-model-name' });
      modelNameEl.textContent = opt.model;
      
      // 连接名（如果有）
      if (opt.connectionName) {
        const connNameEl = itemEl.createSpan({ cls: 'searchable-model-conn' });
        connNameEl.textContent = `(${opt.connectionName})`;
      }
      
      // 点击选择
      itemEl.addEventListener('click', () => this.selectOption(opt));
      
      // 鼠标悬停高亮
      itemEl.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.highlightSelected();
      });
    });
  }

  private highlightSelected() {
    const items = this.dropdownEl.querySelectorAll('.searchable-model-item');
    items.forEach((item, index) => {
      item.classList.toggle('is-selected', index === this.selectedIndex);
    });
  }

  private scrollToSelected() {
    const selected = this.dropdownEl.querySelector('.searchable-model-item.is-selected');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }

  private selectOption(opt: ModelOption) {
    this.currentValue = opt.value;
    this.inputEl.value = opt.displayText;
    this.hideDropdown();
    this.onSelect(opt.value);
  }

  /**
   * 设置可选模型列表
   */
  public setOptions(options: ModelOption[]) {
    this.options = options;
    this.filteredOptions = [...options];
    
    // 如果有当前值，更新显示
    if (this.currentValue) {
      const opt = options.find(o => o.value === this.currentValue);
      if (opt) {
        this.inputEl.value = opt.displayText;
      }
    }
  }

  /**
   * 设置当前值
   */
  public setValue(value: string) {
    this.currentValue = value;
    const opt = this.options.find(o => o.value === value);
    if (opt) {
      this.inputEl.value = opt.displayText;
    } else {
      this.inputEl.value = value;
    }
  }

  /**
   * 获取当前值
   */
  public getValue(): string {
    return this.currentValue;
  }

  /**
   * 设置禁用状态
   */
  public setDisabled(disabled: boolean) {
    this.inputEl.disabled = disabled;
    if (disabled) {
      this.containerEl.classList.add('is-disabled');
      this.hideDropdown();
    } else {
      this.containerEl.classList.remove('is-disabled');
    }
  }

  /**
   * 设置占位符文本
   */
  public setPlaceholder(text: string) {
    this.placeholder = text;
    this.inputEl.placeholder = text;
  }

  /**
   * 销毁组件
   */
  public destroy() {
    this.containerEl.remove();
  }
}
