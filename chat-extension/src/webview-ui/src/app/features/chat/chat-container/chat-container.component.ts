import { Component, OnInit, OnDestroy, signal, ViewChild, inject } from "@angular/core";
import { Subscription } from "rxjs";
import { TranslateService } from "@ngx-translate/core";
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
import { AgentMode } from "../../../core/enums/agent-mode.enum";
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
  type ReadFilesPayload,
  type ToolApprovalRequestPayload,
  type ToolApprovalResponsePayload,
  type SetAgentModePayload,
  type SetEnableThinkingPayload,
  type PlanExitRequestPayload,
  type PlanExitResponsePayload,
  type NotificationPayload,
  type NotificationDismissedPayload,
} from "@shared/message-protocol";

/** i18n key per ogni fase di esecuzione del codice Python. */
const CODE_PROGRESS_KEYS: Record<CodeProgressPhase, string> = {
  creating_env:       "code.progress.creatingEnv",
  installing_packages: "code.progress.installingPackages",
  executing:          "code.progress.executing",
};

@Component({
  selector: "app-chat-container",
  standalone: true,
  imports: [
    ToolbarComponent,
    MessageListComponent,
    InputAreaComponent,
    ToolApprovalModalComponent,
    PlanExitModalComponent,
    NotificationBannerComponent,
  ],
  templateUrl: "./chat-container.component.html",
  styleUrl: "./chat-container.component.scss",
})
export class ChatContainerComponent implements OnInit, OnDestroy {
  @ViewChild("inputArea") inputAreaRef!: InputAreaComponent;

  connectionStatus     = ConnectionStatus.Checking;
  availableCommands    = signal<SlashCommand[]>([]);
  supportsVision       = signal(false);
  thinkingSupported    = signal(false);
  thinkingCanBeToggled = signal(false);
  enableThinking       = signal(true);
  pendingApproval      = signal<ToolApprovalRequestPayload | null>(null);
  pendingPlanExit      = signal<PlanExitRequestPayload | null>(null);
  notifications        = signal<NotificationPayload[]>([]);
  agentMode            = signal<AgentMode>(AgentMode.Ask);

  private readonly subscriptions = new Subscription();

  constructor(
    readonly store: MessageStoreService,
    private readonly bridge: WebviewBridgeService,
    private readonly translate: TranslateService,
  ) {
    inject(StreamingService); // activate streaming subscriptions (side-effect only)
  }

  ngOnInit(): void {
    this.subscriptions.add(
      this.bridge.onConnectionStatus().subscribe((status) => {
        this.connectionStatus = status;
      }),
    );

    this.subscriptions.add(
      this.bridge.onSlashCommands().subscribe((cmds) => {
        this.availableCommands.set(cmds);
      }),
    );

    this.subscriptions.add(
      this.bridge.onSlashCommandResult().subscribe((result) => {
        this.store.addSystemMessage(result.content);
      }),
    );

    this.subscriptions.add(
      this.bridge.onHistoryRestore().subscribe((payload) => {
        if (payload.messages.length > 0) this.store.restoreHistory(payload.messages);
      }),
    );

    // Code execution progress: translate the phase key via TranslateService.
    this.subscriptions.add(
      this.bridge.onCodeProgress().subscribe((p: CodeProgressPayload) => {
        const key = CODE_PROGRESS_KEYS[p.phase] ?? "code.progress.running";
        this.store.setCodeStatus(this.translate.instant(key));
      }),
    );

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
          this.store.addSystemMessage(`> ⚠ **Error:** \`${result.data}\``);
        }
      }),
    );

    this.subscriptions.add(
      this.bridge.onSupportsVision().subscribe((v) => this.supportsVision.set(v)),
    );

    // Toggle visibility: shown when model supports thinking (even if not toggleable).
    this.subscriptions.add(
      this.bridge.onSupportsThinking().subscribe((v) => {
        this.thinkingSupported.set(v);
        this.enableThinking.set(v);
      }),
    );

    // Toggle clickability: only interactive when the model honors enable_thinking:false.
    this.subscriptions.add(
      this.bridge.onThinkingToggleAvailable().subscribe((v) => {
        this.thinkingCanBeToggled.set(v);
      }),
    );

    this.subscriptions.add(
      this.bridge.onFilesRead().subscribe((payload) => {
        this.inputAreaRef?.addAttachments(payload.attachments);
      }),
    );

    this.subscriptions.add(
      this.bridge.onToolApprovalRequest().subscribe((req) => {
        this.pendingApproval.set(req);
      }),
    );

    this.subscriptions.add(
      this.bridge.onPlanExitRequest().subscribe((req) => {
        this.pendingPlanExit.set(req);
      }),
    );

    this.subscriptions.add(
      this.bridge.onNotificationShow().subscribe((n) => {
        this.notifications.update((list) => [...list, n]);
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

    this.subscriptions.add(
      this.bridge.onAgentMode().subscribe((mode) => this.agentMode.set(mode as AgentMode)),
    );

    this.bridge.send({ type: ToExtensionType.CheckHealth });
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  onReconnect(): void {
    this.bridge.send({ type: ToExtensionType.CheckHealth });
  }

  onSetAgentMode(mode: AgentMode): void {
    this.agentMode.set(mode);
    this.bridge.send({
      type: ToExtensionType.SetAgentMode,
      payload: { mode } satisfies SetAgentModePayload,
    });
  }

  onSetEnableThinking(enabled: boolean): void {
    this.enableThinking.set(enabled);
    this.bridge.send({
      type: ToExtensionType.SetEnableThinking,
      payload: { enabled } satisfies SetEnableThinkingPayload,
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

    if (trimmed === "/clear") {
      this.onClearHistory();
      return;
    }

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
      this.store.addUserMessage(trimmed);
      this.store.setWaiting(true);
      this.bridge.send({ type: ToExtensionType.SendMessage, payload: { content: trimmed } });
      return;
    }

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
