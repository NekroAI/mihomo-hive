import type React from "react";
import { Database, DownloadCloud, FileJson, Play, RefreshCw, RotateCw, ShieldCheck, SlidersHorizontal, StopCircle, UploadCloud } from "lucide-react";
import type { SubscriptionSource } from "@mihomo-hive/schemas";
import { Badge, Button, Panel, TextInput } from "../../components/ui.js";

export type TaskState = "idle" | "pending" | "success" | "error";

export interface TaskFeedback {
  state: TaskState;
  title: string;
  detail: string;
  startedAt?: number;
  technical?: string;
}

export function PipelinePanel(props: {
  subscriptions: Array<Omit<SubscriptionSource, "lastContent"> & { fetched: boolean; lastContentBytes?: number }>;
  subscriptionName: string;
  subscriptionUrl: string;
  portRange: string;
  filteredCount: number;
  selectedCount: number;
  assignedCount: number;
  canTest: boolean;
  canRender: boolean;
  task: TaskFeedback;
  busy: boolean;
  onSubscriptionNameChange: (value: string) => void;
  onSubscriptionUrlChange: (value: string) => void;
  onPortRangeChange: (value: string) => void;
  onAddSubscription: () => void;
  onFetch: () => void;
  onImport: () => void;
  onAssignPorts: () => void;
  onTest: () => void;
  onRender: () => void;
  onStart: () => void;
  onReload: () => void;
  onStop: () => void;
}) {
  return (
    <aside className="pipeline-panel">
      <Panel title="任务流" actions={<Badge tone={props.busy ? "info" : "success"}>{props.busy ? "执行中" : "就绪"}</Badge>}>
        <div className="step-list">
          <Step index={1} title="订阅源" description="添加机场订阅，系统会使用 Clash 客户端请求头拉取。">
            <div className="stack">
              <TextInput label="名称" value={props.subscriptionName} onChange={props.onSubscriptionNameChange} placeholder="primary" />
              <TextInput label="订阅 URL" value={props.subscriptionUrl} onChange={props.onSubscriptionUrlChange} placeholder="https://example.com/sub" mono />
              <Button
                icon={<DownloadCloud size={16} />}
                disabled={props.busy || !props.subscriptionName || !props.subscriptionUrl}
                onClick={props.onAddSubscription}
              >
                添加订阅
              </Button>
            </div>
          </Step>

          <Step index={2} title="拉取与导入" description={`当前有 ${props.subscriptions.length} 个订阅源。`}>
            <div className="button-row">
              <Button variant="secondary" icon={<RefreshCw size={16} />} disabled={props.busy} onClick={props.onFetch}>
                拉取订阅
              </Button>
              <Button variant="secondary" icon={<UploadCloud size={16} />} disabled={props.busy} onClick={props.onImport}>
                导入节点
              </Button>
            </div>
            <div className="subscription-list">
              {props.subscriptions.map((item) => (
                <div key={item.id} className="subscription-item">
                  <strong>{item.name}</strong>
                  <span>{item.fetched ? `${item.lastContentBytes ?? 0} bytes` : "未拉取"}</span>
                </div>
              ))}
            </div>
          </Step>

          <Step index={3} title="端口与测试" description={`当前筛选 ${props.filteredCount} 个节点，已选择 ${props.selectedCount} 个节点。`}>
            <div className="port-row">
              <TextInput value={props.portRange} onChange={props.onPortRangeChange} placeholder="10001-10300" mono />
              <Button icon={<SlidersHorizontal size={16} />} disabled={props.busy} onClick={props.onAssignPorts}>
                预览分配
              </Button>
            </div>
            <Button
              variant="secondary"
              icon={<ShieldCheck size={16} />}
              disabled={props.busy || !props.canTest}
              onClick={props.onTest}
            >
              测试当前已分配节点
            </Button>
          </Step>

          <Step index={4} title="Mihomo 运行" description="生成配置后再启动或热重载 Mihomo。">
            <Button icon={<FileJson size={16} />} disabled={props.busy || !props.canRender} onClick={props.onRender}>
              预览生成配置
            </Button>
            <div className="button-row three">
              <Button variant="secondary" icon={<Play size={16} />} disabled={props.busy} onClick={props.onStart}>
                启动
              </Button>
              <Button variant="secondary" icon={<RotateCw size={16} />} disabled={props.busy} onClick={props.onReload}>
                重载
              </Button>
              <Button variant="secondary" icon={<StopCircle size={16} />} disabled={props.busy} onClick={props.onStop}>
                停止
              </Button>
            </div>
          </Step>
        </div>
      </Panel>

      <Panel title="操作反馈">
        <div className={`task-feedback task-${props.task.state}`}>
          <div className="task-icon">
            {props.task.state === "pending" ? <RefreshCw className="animate-spin" size={18} /> : <Database size={18} />}
          </div>
          <div>
            <strong>{props.task.title}</strong>
            <p>{props.task.detail}</p>
            {props.task.technical ? <details><summary>技术详情</summary><pre>{props.task.technical}</pre></details> : null}
          </div>
        </div>
      </Panel>
    </aside>
  );
}

function Step(props: { index: number; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="pipeline-step">
      <div className="step-index">{props.index}</div>
      <div className="step-content">
        <h3>{props.title}</h3>
        <p>{props.description}</p>
        {props.children}
      </div>
    </section>
  );
}
