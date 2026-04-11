import { Injectable, NgZone, OnDestroy } from "@angular/core";
import { Subject, Observable } from "rxjs";
import { distinctUntilChanged, filter, map } from "rxjs/operators";
import { VscodeApiService } from "./vscode-api.service";
import {
  ToWebviewType,
  ToExtensionType,
  ConnectionStatus,
  type ToWebviewMessage,
  type ToExtensionMessage,
  type StreamDeltaPayload,
  type StreamErrorPayload,
  type SlashCommand,
  type SlashCommandResultPayload,
  type CodeResultPayload,
  type CodeProgressPayload,
  type HistoryRestorePayload,
  type FilesReadPayload,
  type ToolApprovalRequestPayload,
  type AgentMode,
  type PlanExitRequestPayload,
  type NotificationPayload,
} from "@shared/message-protocol";

@Injectable({ providedIn: "root" })
export class WebviewBridgeService implements OnDestroy {
  private readonly messages$ = new Subject<ToWebviewMessage>();
  private readonly listener: (event: MessageEvent) => void;

  constructor(
    private readonly vscodeApi: VscodeApiService,
    private readonly zone: NgZone,
  ) {
    this.listener = (event: MessageEvent) => {
      const msg = event.data as ToWebviewMessage;
      if (msg?.type) {
        this.zone.run(() => this.messages$.next(msg));
      }
    };
    window.addEventListener("message", this.listener);
  }

  ngOnDestroy(): void {
    window.removeEventListener("message", this.listener);
    this.messages$.complete();
  }

  send(message: ToExtensionMessage): void {
    this.vscodeApi.postMessage(message);
  }

  onStreamDelta(): Observable<StreamDeltaPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.StreamDelta),
      map((msg) => msg.payload as StreamDeltaPayload),
    );
  }

  onStreamEnd(): Observable<void> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.StreamEnd),
      map(() => undefined),
    );
  }

  onStreamError(): Observable<StreamErrorPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.StreamError),
      map((msg) => msg.payload as StreamErrorPayload),
    );
  }

  onConnectionStatus(): Observable<ConnectionStatus> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.ConnectionStatus),
      map((msg) => msg.payload as ConnectionStatus),
    );
  }

  /** Emits whenever the extension sends an updated slash command list via ConfigUpdate. */
  onSlashCommands(): Observable<SlashCommand[]> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.ConfigUpdate),
      map((msg) => (msg.payload as Record<string, any>)["slashCommands"] as SlashCommand[] | undefined),
      filter((cmds): cmds is SlashCommand[] => Array.isArray(cmds)),
    );
  }

  /** Emits results from client-side slash commands (e.g. /branch, /simplify). */
  onSlashCommandResult(): Observable<SlashCommandResultPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.SlashCommandResult),
      map((msg) => msg.payload as SlashCommandResultPayload),
    );
  }

  /** Emits the result of a Python code execution (image, stdout, or error). */
  onCodeResult(): Observable<CodeResultPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.CodeResult),
      map((msg) => msg.payload as CodeResultPayload),
    );
  }

  /** Emits phase updates during Python code execution (venv setup, pip install, execution). */
  onCodeProgress(): Observable<CodeProgressPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.CodeProgress),
      map((msg) => msg.payload as CodeProgressPayload),
    );
  }

  /** Emits when the extension sends a HistoryRestore message (view switched). */
  onHistoryRestore(): Observable<HistoryRestorePayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.HistoryRestore),
      map((msg) => msg.payload as HistoryRestorePayload),
    );
  }

  /** Emits true when the current model supports vision (LM Studio type "vlm"), false otherwise. */
  onSupportsVision(): Observable<boolean> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.ConfigUpdate),
      map((msg) => (msg.payload as any)?.modelInfo?.type === "vlm"),
      distinctUntilChanged(),
    );
  }

  /** Emits true when the current model produces reasoning_content at all.
   *  Used to decide whether thinking should be active (sent to proxy).
   *  Distinct from onThinkingToggleAvailable: a model can support thinking
   *  but not honor the disable flag — in that case thinking is always on. */
  onSupportsThinking(): Observable<boolean> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.ConfigUpdate),
      map((msg) => Boolean((msg.payload as any)?.modelInfo?.supportsThinking)),
      distinctUntilChanged(),
    );
  }

  /** Emits true when the current model has thinking AND honors the disable
   *  flag — i.e. the UI toggle should be shown and actually has an effect
   *  when clicked. Models that always think (e.g. QwQ) return false here. */
  onThinkingToggleAvailable(): Observable<boolean> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.ConfigUpdate),
      map((msg) => {
        const m = (msg.payload as any)?.modelInfo;
        return Boolean(m?.supportsThinking && m?.thinkingCanBeDisabled);
      }),
      distinctUntilChanged(),
    );
  }

  /** Emits whenever the proxy's agent mode changes (ask | auto | plan). */
  onAgentMode(): Observable<AgentMode> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.ConfigUpdate),
      map((msg) => (msg.payload as any)?.agentMode as AgentMode | undefined),
      filter((v): v is AgentMode => v === "ask" || v === "auto" || v === "plan"),
      distinctUntilChanged(),
    );
  }

  /** Emits when the extension host has read files requested via ReadFiles. */
  onFilesRead(): Observable<FilesReadPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.FilesRead),
      map((msg) => msg.payload as FilesReadPayload),
    );
  }

  /** Emits when the proxy requests human approval for a destructive workspace action. */
  onToolApprovalRequest(): Observable<ToolApprovalRequestPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.ToolApprovalRequest),
      map((msg) => msg.payload as ToolApprovalRequestPayload),
    );
  }

  /** Emits when the model signals it wants to exit Plan mode (via `exit_plan_mode`). */
  onPlanExitRequest(): Observable<PlanExitRequestPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.PlanExitRequest),
      map((msg) => msg.payload as PlanExitRequestPayload),
    );
  }

  /** Emits when the extension host pushes a new notification banner. */
  onNotificationShow(): Observable<NotificationPayload> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.NotificationShow),
      map((msg) => msg.payload as NotificationPayload),
    );
  }

  /** Emits the id of a notification that should be removed (extension-initiated). */
  onNotificationDismiss(): Observable<string> {
    return this.messages$.pipe(
      filter((msg) => msg.type === ToWebviewType.NotificationDismiss),
      map((msg) => (msg.payload as { id: string }).id),
    );
  }
}
