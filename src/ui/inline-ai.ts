import { Extension, EditorState, StateField, Transaction, StateEffect } from "@codemirror/state";
import { EditorView, Decoration, DecorationSet, keymap, WidgetType } from "@codemirror/view";
import { App, Notice } from "obsidian";
import type { IPluginContext } from "../core/plugin-context";;
import { logger } from "../core/logger";

// Effect to update the suggestion
const updateSuggestionEffect = StateEffect.define<string | null>();

// State field to hold the current suggestion
const suggestionField = StateField.define<string | null>({
    create() { return null; },
    update(value, tr) {
        for (const effect of tr.effects) {
            if (effect.is(updateSuggestionEffect)) return effect.value;
        }
        // Clear suggestion on document change if not explicitly updated
        if (tr.docChanged) return null;
        return value;
    },
    provide: f => EditorView.decorations.from(f, value => {
        if (!value) return Decoration.none;
        // We need to find the cursor position to place the widget
        // But StateField doesn't have access to view, so we rely on the view plugin to trigger updates
        // Actually, we can't easily place decoration at cursor from here without knowing cursor pos
        // So we'll use a ViewPlugin instead for rendering
        return Decoration.none; 
    })
});

class GhostTextWidget extends WidgetType {
    constructor(readonly text: string) { super(); }

    toDOM() {
        const span = document.createElement("span");
        span.textContent = this.text;
        span.style.color = "var(--text-faint)";
        span.style.opacity = "0.6";
        span.style.pointerEvents = "none";
        return span;
    }
}

export const inlineAIPlugin = (app: App, plugin: IPluginContext) => {
    return ViewPlugin.fromClass(class {
        decorations: DecorationSet;
        currentSuggestion: string | null = null;
        debounceTimer: number | null = null;
        view: EditorView;

        constructor(view: EditorView) {
            this.view = view;
            this.decorations = Decoration.none;
        }

        update(update: ViewUpdate) {
            if (!plugin.settings.enableInlineAI) {
                this.decorations = Decoration.none;
                return;
            }

            if (update.docChanged) {
                // Clear existing suggestion on type
                this.currentSuggestion = null;
                this.decorations = Decoration.none;

                // Debounce API call
                if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
                
                // Only trigger if cursor is at end of line and user stopped typing
                const selection = update.state.selection.main;
                if (selection.empty) {
                    const line = update.state.doc.lineAt(selection.head);
                    if (selection.head === line.to && line.text.trim().length > 5) {
                        this.debounceTimer = window.setTimeout(() => {
                            this.fetchSuggestion(update.state, selection.head);
                        }, 1000); // 1s delay to save tokens
                    }
                }
            }
        }

        async fetchSuggestion(state: EditorState, pos: number) {
            // Get context (previous 500 chars)
            const start = Math.max(0, pos - 500);
            const context = state.doc.sliceString(start, pos);

            try {
                // Simple prompt for completion
                const prompt = [
                    { role: 'system' as const, content: "You are a helpful writing assistant. Complete the user's sentence naturally. Output ONLY the completion text. Do not repeat the input. Keep it short (1 sentence)." },
                    { role: 'user' as const, content: context }
                ];
                
                // Use a cheaper model for inline completion if possible
                const model = plugin.settings.inlineAIModel || plugin.settings.routerModel || plugin.settings.chatModels.split(',')[0]; 
                const response = await plugin.llmService.getCompletion(prompt, model);
                const completion = response.content || "";
                
                if (completion && completion.trim().length > 0) {
                    this.currentSuggestion = completion;
                    
                    // Create decoration
                    const widget = Decoration.widget({
                        widget: new GhostTextWidget(completion),
                        side: 1
                    });
                    this.decorations = Decoration.set([widget.range(pos)]);
                    
                    // Force update view
                    this.view.dispatch({ effects: [] }); 
                }
            } catch (e) {
                logger.error("AI", "Inline AI Error", e);
            }
        }
    }, {
        decorations: v => v.decorations,
        eventHandlers: {
            keydown: (e, view) => {
                if (!plugin.settings.enableInlineAI) return false;
                
                // @ts-ignore
                const pluginState = view.plugin(inlineAIPlugin(app, plugin)); 
                // Note: Accessing plugin instance like this is tricky in CM6. 
                // We might need a different approach for key handling.
                
                if (e.key === "Tab") {
                    // We need to access the current suggestion from the view plugin
                    // This is a simplified implementation. 
                    // In a real plugin, we'd use a StateField to store the suggestion so keymap can access it.
                    return false; 
                }
                return false;
            }
        }
    });
};

// Better approach: Separate StateField for suggestion and ViewPlugin for triggering
export const suggestionState = StateField.define<{text: string, pos: number} | null>({
    create: () => null,
    update(value, tr) {
        // Clear on any document change
        if (tr.docChanged) return null;
        
        // Update from effect
        for (const effect of tr.effects) {
            if (effect.is(setSuggestionEffect)) return effect.value;
        }
        return value;
    },
    provide: f => EditorView.decorations.from(f, value => {
        if (!value) return Decoration.none;
        return Decoration.set([
            Decoration.widget({
                widget: new GhostTextWidget(value.text),
                side: 1
            }).range(value.pos)
        ]);
    })
});

export const setSuggestionEffect = StateEffect.define<{text: string, pos: number} | null>();

import { ViewPlugin, ViewUpdate } from "@codemirror/view";

export const inlineAIViewPlugin = (plugin: IPluginContext) => ViewPlugin.fromClass(class {
    debounceTimer: number | null = null;

    constructor(public view: EditorView) {}

    update(update: ViewUpdate) {
        if (!plugin.settings.enableInlineAI) return;

        if (update.docChanged) {
            if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
            
            const selection = update.state.selection.main;
            if (selection.empty) {
                const line = update.state.doc.lineAt(selection.head);
                // Only trigger at end of line and if line has content
                if (selection.head === line.to && line.text.trim().length > 5) {
                    this.debounceTimer = window.setTimeout(() => {
                        this.fetchSuggestion(update.state, selection.head);
                    }, 800); 
                }
            }
        }
    }

    async fetchSuggestion(state: EditorState, pos: number) {
        const start = Math.max(0, pos - 1000);
        const context = state.doc.sliceString(start, pos);

        try {
            // Use a very fast/cheap model or specific instruction
            const prompt = [
                { role: 'system' as const, content: "Continue the text naturally. Output ONLY the completion. Max 1 sentence." },
                { role: 'user' as const, content: context }
            ];
            
            const response = await plugin.llmService.getCompletion(prompt, plugin.settings.inlineAIModel || plugin.settings.routerModel || plugin.settings.chatModels.split(',')[0]);
            const completion = response.content || "";
            
            if (completion && completion.trim().length > 0) {
                // Dispatch effect to update state field
                this.view.dispatch({
                    effects: setSuggestionEffect.of({ text: completion, pos })
                });
            }
        } catch (e) {
            // Silent fail
        }
    }
});

export const acceptSuggestionKeymap = (plugin: IPluginContext) => keymap.of([
    {
        key: "Tab",
        run: (view: EditorView) => {
            if (!plugin.settings.enableInlineAI) return false;
            const suggestion = view.state.field(suggestionState);
            if (suggestion) {
                const transaction = view.state.update({
                    changes: { from: suggestion.pos, insert: suggestion.text },
                    effects: setSuggestionEffect.of(null) // Clear suggestion
                });
                view.dispatch(transaction);
                return true;
            }
            return false;
        }
    }
]);
