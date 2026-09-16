import { App } from "obsidian";
import type { IPluginContext } from "../../core/plugin-context";;
import { safeNotice } from "../../utils/notice";
import { ToolPermissionModal } from "../../ui/modals/ToolPermissionModal";
import type { AgentPermissionDefaults, AgentPermissionScope, AgentPermissionRule } from "../../core/settings";
import type { ToolProfile } from "./ToolRouter";

const FALLBACK_PERMISSION_DEFAULTS: AgentPermissionDefaults = {
  read: "allow",
  write: "ask",
  exec: "ask",
  network: "ask",
  mcp: "ask",
};

export interface PermissionRequest {
  toolName: string;
  toolLabel: string;
  toolDescription?: string;
  args: any;
  profile: ToolProfile;
  targetKey?: string;
  targetLabel?: string;
  targetType?: 'path' | 'domain' | 'mcp-server' | 'mcp-tool';
}

export interface PermissionDecision {
  allowed: boolean;
  scope: AgentPermissionScope;
  mode: "disabled" | "scope-default" | "target-session" | "session" | "once" | "always-target" | "always-scope" | "denied";
  summary: string;
  targetKey?: string;
}

export class PermissionManager {
  private sessionAllowedScopes = new Set<AgentPermissionScope>();
  private sessionAllowedTargets = new Set<string>();

  constructor(private app: App, private plugin: IPluginContext) {}

  public async ensureAuthorized(request: PermissionRequest): Promise<PermissionDecision> {
    const scope = this.resolveScope(request.toolName, request.profile);
    const target = this.resolveTarget(request);
    const defaults = this.plugin.settings.agentPermissionDefaults || FALLBACK_PERMISSION_DEFAULTS;
    const scopeMode = defaults[scope] || "ask";
    const mustAsk = this.plugin.settings.enableAgentPermissions !== false && (scopeMode === "ask");

    if (this.plugin.settings.enableAgentPermissions === false) {
      return { allowed: true, scope, mode: "disabled", summary: "已关闭结构化权限系统", targetKey: target.key };
    }

    const matchedRule = this.findMatchingRule(target.key);
    if (matchedRule) {
      return { allowed: true, scope, mode: "always-target", summary: `已放行 ${target.label}`, targetKey: target.key };
    }

    if (this.sessionAllowedTargets.has(target.key)) {
      return { allowed: true, scope, mode: "target-session", summary: `本次会话已放行 ${target.label}`, targetKey: target.key };
    }

    if (this.sessionAllowedScopes.has(scope)) {
      return { allowed: true, scope, mode: "session", summary: `本次会话已放行 ${this.scopeLabel(scope)}`, targetKey: target.key };
    }

    if (!mustAsk) {
      return { allowed: true, scope, mode: "scope-default", summary: `${this.scopeLabel(scope)} 默认已放行`, targetKey: target.key };
    }

    const reason = this.buildReason(request.toolName, request.profile);
    const argsPreview = this.buildArgsPreview(request.args);
    const decision = await ToolPermissionModal.openAndWait(this.app, {
      toolName: request.toolName,
      toolLabel: request.toolLabel,
      scope,
      risk: request.profile.riskLevel,
      reason,
      argsPreview,
      targetKey: target.key,
      targetLabel: target.label,
      targetType: target.type,
    });

    switch (decision) {
      case "once":
        return { allowed: true, scope, mode: "once", summary: `已批准本次执行：${request.toolLabel}`, targetKey: target.key };
      case "session-target":
        this.sessionAllowedTargets.add(target.key);
        return { allowed: true, scope, mode: "target-session", summary: `本次会话已放行 ${target.label}`, targetKey: target.key };
      case "session":
        this.sessionAllowedScopes.add(scope);
        return { allowed: true, scope, mode: "session", summary: `本次会话已放行 ${this.scopeLabel(scope)}`, targetKey: target.key };
      case "always-target": {
        const existing = Array.isArray(this.plugin.settings.agentPermissionRules) ? this.plugin.settings.agentPermissionRules : [];
        if (!existing.some(rule => rule.key === target.key)) {
          this.plugin.settings.agentPermissionRules = [...existing, {
            key: target.key,
            scope,
            targetType: target.type,
            targetValue: target.value,
            mode: "allow",
          }];
          await this.plugin.saveSettings();
        }
        safeNotice(`已始终允许智能体执行：${target.label}`);
        return { allowed: true, scope, mode: "always-target", summary: `已永久放行 ${target.label}`, targetKey: target.key };
      }
      case "always-scope": {
        this.plugin.settings.agentPermissionDefaults = {
          ...FALLBACK_PERMISSION_DEFAULTS,
          ...(this.plugin.settings.agentPermissionDefaults || {}),
          [scope]: "allow",
        };
        await this.plugin.saveSettings();
        safeNotice(`已始终允许智能体执行：${this.scopeLabel(scope)}`);
        return { allowed: true, scope, mode: "always-scope", summary: `已永久放行 ${this.scopeLabel(scope)}`, targetKey: target.key };
      }
      case "deny":
      default:
        return { allowed: false, scope, mode: "denied", summary: `用户拒绝执行 ${request.toolLabel} → ${target.label}`, targetKey: target.key };
    }
  }

  private resolveTarget(request: PermissionRequest): { key: string; label: string; type: 'path' | 'domain' | 'mcp-server' | 'mcp-tool'; value: string } {
    const explicitType = request.targetType;
    const explicitValue = String(request.targetLabel || request.targetKey || '').trim();
    if (explicitType && explicitValue) {
      const key = String(request.targetKey || `${explicitType}:${explicitValue}`).trim();
      return { key, label: explicitValue, type: explicitType, value: explicitValue };
    }

    const args = request.args && typeof request.args === 'object' ? request.args : {};
    const pathCandidate = [args.path, args.sourcePath, args.destinationPath, args.folderPath].find((v: any) => typeof v === 'string' && v.trim());
    if (typeof pathCandidate === 'string' && pathCandidate.trim()) {
      const value = pathCandidate.trim().replace(/\\/g, '/');
      return { key: `path:${value}`, label: `路径 ${value}`, type: 'path', value };
    }

    const domainCandidate = this.extractDomainCandidate(args);
    if (domainCandidate) {
      return { key: `domain:${domainCandidate}`, label: `域名 ${domainCandidate}`, type: 'domain', value: domainCandidate };
    }

    const mcpServer = String(args.serverName || args.serverId || '').trim();
    const mcpTool = String(args.toolName || '').trim();
    if (mcpServer && mcpTool) {
      return { key: `mcp-tool:${mcpServer}/${mcpTool}`, label: `MCP 工具 ${mcpServer}/${mcpTool}`, type: 'mcp-tool', value: `${mcpServer}/${mcpTool}` };
    }
    if (mcpServer) {
      return { key: `mcp-server:${mcpServer}`, label: `MCP 服务 ${mcpServer}`, type: 'mcp-server', value: mcpServer };
    }
    if (mcpTool) {
      return { key: `mcp-tool:${mcpTool}`, label: `MCP 工具 ${mcpTool}`, type: 'mcp-tool', value: mcpTool };
    }

    const fallback = `${request.toolName}`;
    return { key: `path:${fallback}`, label: request.toolLabel, type: 'path', value: fallback };
  }

  private extractDomainCandidate(args: any): string | null {
    const values = [args.url, args.endpoint, args.baseUrl, args.host, args.domain];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (!trimmed) continue;
      try {
        const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
        return url.hostname;
      } catch {
        continue;
      }
    }
    return null;
  }

  private findMatchingRule(key: string): AgentPermissionRule | null {
    const rules = Array.isArray(this.plugin.settings.agentPermissionRules) ? this.plugin.settings.agentPermissionRules : [];
    return rules.find(rule => rule?.mode === 'allow' && rule.key === key) || null;
  }

  private resolveScope(toolName: string, profile: ToolProfile): AgentPermissionScope {
    if (toolName.startsWith("mcp_") || profile.capabilityTags.includes("network") && toolName === "mcp_call_tool") {
      return "mcp";
    }
    if (profile.capabilityTags.includes("exec")) return "exec";
    if (profile.capabilityTags.includes("network")) return "network";
    if (profile.capabilityTags.includes("write") || profile.capabilityTags.includes("canvas")) return "write";
    return "read";
  }

  private buildReason(toolName: string, profile: ToolProfile): string {
    if (profile.requiresConfirmation) {
      return `该工具被标记为高风险/需确认：${toolName}`;
    }
    switch (this.resolveScope(toolName, profile)) {
      case "write": return "该工具会修改笔记、白板或属性。";
      case "exec": return "该工具会触发命令执行。";
      case "network": return "该工具会访问外部网络资源。";
      case "mcp": return "该工具会调用外部 MCP 服务。";
      default: return "该工具会读取笔记或工作区信息。";
    }
  }

  private buildArgsPreview(args: any): string {
    try {
      const raw = JSON.stringify(args ?? {}, null, 2);
      if (raw.length <= 1200) return raw;
      return `${raw.slice(0, 1200)}\n...`;
    } catch {
      return String(args ?? "");
    }
  }

  private scopeLabel(scope: AgentPermissionScope): string {
    switch (scope) {
      case "read": return "读文件";
      case "write": return "写文件";
      case "exec": return "命令执行";
      case "network": return "联网访问";
      case "mcp": return "MCP 工具";
      default: return scope;
    }
  }
}