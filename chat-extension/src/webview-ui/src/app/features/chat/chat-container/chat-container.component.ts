import { Component, OnInit, OnDestroy, signal, ViewChild } from "@angular/core";
import { CommonModule } from "@angular/common";
import { Subscription } from "rxjs";
import { ToolbarComponent } from "../toolbar/toolbar.component";
import { MessageListComponent } from "../message-list/message-list.component";
import { InputAreaComponent, type SendPayload } from "../input-area/input-area.component";
import { ToolApprovalModalComponent, type ApprovalDecision } from "../tool-approval-modal/tool-approval-modal.component";
import { PlanExitModalComponent, type PlanExitDecision } from "../plan-exit-modal/plan-exit-modal.component";
import { NotificationBannerComponent } from "../../../shared/components/notification-banner/notification-banner.component";
import { MessageStoreService } from "../../../core/services/message-store.service";
import { WebviewBridgeService } from "../../../core/services/webview-bridge.service";
import { StreamingService } from "../../../core/services/streaming.service";
import { MessageRole } from "../../../core/enums/message-role.enum";
import { ContentBlockType } from "../../../core/enums/content-block-type.enum";
import type { TextBlock } from "../../../core/models/content-block.model";
import {
  ToExtensionType,
  ConnectionStatus,
  type SlashCommand,
  type SlashCommandPayload,
  type ExecuteCodePayload,
  type CodeResultPayload,
  type CodeProgressPayload,
  type CodeProgressPhase,
  type Attachment,
  type ReadFilesPayload,
  type ToolApprovalRequestPayload,
  type ToolApprovalResponsePayload,
  type SetAgentModePayload,
  type AgentMode,
  type PlanExitRequestPayload,
  type PlanExitResponsePayload,
  type NotificationPayload,
  type NotificationDismissedPayload,
} from "@shared/message-protocol";

@Component({
  selector: "app-chat-container",
  standalone: true,
  imports: [
    CommonModule,
    ToolbarComponent,
    MessageListComponent,
    InputAreaComponent,
    ToolApprovalModalComponent,
    PlanExitModalComponent,
    NotificationBannerComponent,
  ],
  template: `
    <div class="chat-layout">
      <app-toolbar
        [connectionStatus]="connectionStatus"
        (clearHistory)="onClearHistory()" />
      <app-notification-banner
        [notifications]="notifications()"
        (dismiss)="onNotificationDismiss($event)" />
      <app-message-list [messages]="store.messages()" [isPending]="store.isPending()" (runCode)="onRunCode($event)" />
      @if (store.codeStatus()) {
        <div class="code-execution-status">
          <div class="exec-dots">
            <span></span><span></span><span></span>
          </div>
          <span class="exec-text">{{ store.codeStatus() }}</span>
        </div>
      }
      <app-input-area
        #inputArea
        [isStreaming]="store.isStreaming() || store.isPending()"
        [slashCommands]="availableCommands()"
        [supportsVision]="supportsVision()"
        [agentMode]="agentMode()"
        (sendMsg)="onSendMessage($event)"
        (cancel)="onCancel()"
        (requestFileRead)="onRequestFileRead($event)"
        (agentModeChange)="onSetAgentMode($event)" />
    </div>
    <app-tool-approval-modal
      [request]="pendingApproval()"
      (decision)="onApprovalDecision($event)" />
    <app-plan-exit-modal
      [request]="pendingPlanExit()"
      (decision)="onPlanExitDecision($event)" />
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .chat-layout {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      background: var(--c-bg);
    }
    .code-execution-status {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 16px;
      font-size: 12px;
      color: var(--c-text-muted);
      background: var(--c-bg);
      border-top: 1px solid var(--c-border);
      flex-shrink: 0;
    }
    .exec-dots {
      display: flex;
      gap: 4px;
    }
    .exec-dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--c-text-muted);
      animation: exec-bounce 1.2s ease-in-out infinite;
    }
    .exec-dots span:nth-child(2) { animation-delay: 0.2s; }
    .exec-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes exec-bounce {
      0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
      30%            { transform: translateY(-4px); opacity: 1; }
    }
  `],
})
export class ChatContainerComponent implements OnInit, OnDestroy {
  @ViewChild("inputArea") inputAreaRef!: InputAreaComponent;

  connectionStatus = ConnectionStatus.Checking;
  availableCommands  = signal<SlashCommand[]>([]);
  supportsVision     = signal(false);
  pendingApproval    = signal<ToolApprovalRequestPayload | null>(null);
  pendingPlanExit    = signal<PlanExitRequestPayload | null>(null);
  notifications      = signal<NotificationPayload[]>([]);
  agentMode          = signal<AgentMode>("ask");

  private readonly subscriptions = new Subscription();

  constructor(
    readonly store: MessageStoreService,
    private readonly bridge: WebviewBridgeService,
    private readonly streaming: StreamingService,
  ) {}

  ngOnInit(): void {
    this.subscriptions.add(
      this.bridge.onConnectionStatus().subscribe((status) => {
        this.connectionStatus = status;
      }),
    );

    // Update slash command menu when the proxy sends the registry
    this.subscriptions.add(
      this.bridge.onSlashCommands().subscribe((cmds) => {
        this.availableCommands.set(cmds);
      }),
    );

    // Handle results from client-side slash commands (extension host response)
    this.subscriptions.add(
      this.bridge.onSlashCommandResult().subscribe((result) => {
        this.store.addSystemMessage(result.content);
      }),
    );

    // Restore conversation history when switching views (HistoryRestore from extension)
    this.subscriptions.add(
      this.bridge.onHistoryRestore().subscribe((payload) => {
        if (payload.messages.length > 0) {
          this.store.restoreHistory(payload.messages);
        }
      }),
    );

    // Handle Python code execution progress phases
    const progressLabels: Record<CodeProgressPhase, string> = {
      creating_env: "Creazione ambiente virtuale Python…",
      installing_packages: "Installazione pacchetti (matplotlib, numpy, pandas…)",
      executing: "Esecuzione codice Python…",
    };
    this.subscriptions.add(
      this.bridge.onCodeProgress().subscribe((p: CodeProgressPayload) => {
        this.store.setCodeStatus(progressLabels[p.phase] ?? "Esecuzione in corso…");
      }),
    );

    // Handle Python code execution results
    this.subscriptions.add(
      this.bridge.onCodeResult().subscribe((result: CodeResultPayload) => {
        this.store.setCodeStatus(null);
        if (result.type === "image") {
          this.store.addSystemMessage(
            `<img src="data:image/png;base64,${result.data}" style="max-width:100%;border-radius:var(--radius-md);margin-top:8px;" alt="Plot">`,
          );
        } else if (result.type === "text") {
          this.store.addSystemMessage("```\n" + result.data + "\n```");
        } else {
          this.store.addSystemMessage(`> ⚠ **Errore:** \`${result.data}\``);
        }
      }),
    );

    // Track vision support from model capabilities
    this.subscriptions.add(
      this.bridge.onSupportsVision().subscribe((v) => this.supportsVision.set(v)),
    );

    // Handle files read by extension host (VS Code Explorer drag)
    this.subscriptions.add(
      this.bridge.onFilesRead().subscribe((payload) => {
        this.inputAreaRef?.addAttachments(payload.attachments);
      }),
    );

    // Show approval modal when the proxy needs user confirmation for a destructive action
    this.subscriptions.add(
      this.bridge.onToolApprovalRequest().subscribe((req) => {
        this.pendingApproval.set(req);
      }),
    );

    // Show plan-exit modal when the model calls `workspace(action="exit_plan_mode")`
    this.subscriptions.add(
      this.bridge.onPlanExitRequest().subscribe((req) => {
        this.pendingPlanExit.set(req);
      }),
    );

    // Embedded notification banners (replace vscode.window.showErrorMessage)
    this.subscriptions.add(
      this.bridge.onNotificationShow().subscribe((n) => {
        this.notifications.update((list) => [...list, n]);
        // Auto-dismiss info/warn after 6 seconds; errors stay until manual ×.
        if (n.level !== "error") {
          setTimeout(() => {
            this.notifications.update((list) => list.filter((x) => x.id !== n.id));
          }, 6000);
        }
      }),
    );
    this.subscriptions.add(
      this.bridge.onNotificationDismiss().subscribe((id) => {
        this.notifications.update((list) => list.filter((n) => n.id !== id));
      }),
    );

    // Sync plan mode state from proxy (via ConfigUpdate)
    this.subscriptions.add(
      this.bridge.onAgentMode().subscribe((mode) => this.agentMode.set(mode)),
    );

    // Request initial health check
    this.bridge.send({ type: ToExtensionType.CheckHealth });
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  onSetAgentMode(mode: AgentMode): void {
    this.agentMode.set(mode); // optimistic: update UI immediately before round-trip
    this.bridge.send({
      type: ToExtensionType.SetAgentMode,
      payload: { mode } satisfies SetAgentModePayload,
    });
  }

  onApprovalDecision(decision: ApprovalDecision): void {
    this.pendingApproval.set(null);
    this.bridge.send({
      type: ToExtensionType.ToolApprovalResponse,
      payload: {
        requestId: decision.requestId,
        approved: decision.approved,
        scope: decision.scope,
      } satisfies ToolApprovalResponsePayload,
    });
  }

  onPlanExitDecision(decision: PlanExitDecision): void {
    this.pendingPlanExit.set(null);
    this.bridge.send({
      type: ToExtensionType.PlanExitResponse,
      payload: { mode: decision.mode } satisfies PlanExitResponsePayload,
    });
  }

  onNotificationDismiss(id: string): void {
    this.notifications.update((list) => list.filter((n) => n.id !== id));
    this.bridge.send({
      type: ToExtensionType.NotificationDismissed,
      payload: { id } satisfies NotificationDismissedPayload,
    });
  }

  onSendMessage(payload: SendPayload): void {
    const { text, attachments } = payload;
    const trimmed = text.trim();

    // /clear — handled entirely in webview (no attachments meaningful here)
    if (trimmed === "/clear") {
      this.onClearHistory();
      return;
    }

    // /copy — clipboard access in webview
    if (trimmed === "/copy") {
      const last = this.store.messages()
        .filter(m => m.role === MessageRole.Assistant)
        .at(-1);
      if (last) {
        const lastText = last.contentBlocks
          .filter(b => b.type === ContentBlockType.Text)
          .map(b => (b as TextBlock).text)
          .join("\n");
        void navigator.clipboard.writeText(lastText);
        this.store.addSystemMessage("_Last response copied to clipboard._");
      }
      return;
    }

    // Other client-side commands (handler: 'client') → extension host
    if (trimmed.startsWith("/")) {
      const cmd = trimmed.split(" ")[0];
      const known = this.availableCommands().find(c => c.name === cmd);

      if (known?.handler === "client") {
        this.store.addUserMessage(trimmed);
        this.bridge.send({
          type: ToExtensionType.ExecuteSlashCommand,
          payload: { command: trimmed } satisfies SlashCommandPayload,
        });
        return;
      }

      // Proxy-handled commands: send as-is
      this.store.addUserMessage(trimmed);
      this.store.setWaiting(true);
      this.bridge.send({
        type: ToExtensionType.SendMessage,
        payload: { content: trimmed },
      });
      return;
    }

    // Normal message (with optional attachments)
    this.store.addUserMessage(trimmed, attachments);
    this.store.setWaiting(true);
    this.bridge.send({
      type: ToExtensionType.SendMessage,
      payload: { content: trimmed, attachments },
    });
  }

  onRequestFileRead(uris: string[]): void {
    this.bridge.send({
      type: ToExtensionType.ReadFiles,
      payload: { uris } satisfies ReadFilesPayload,
    });
  }

  onRunCode(code: string): void {
    this.bridge.send({
      type: ToExtensionType.ExecuteCode,
      payload: { code } satisfies ExecuteCodePayload,
    });
  }

  onCancel(): void {
    this.bridge.send({ type: ToExtensionType.CancelStream });
  }

  onClearHistory(): void {
    this.store.clearHistory();
    this.bridge.send({ type: ToExtensionType.ClearHistory });
  }
}
