import type React from "react";
import { Activity, LogOut, Network, Server, ShieldCheck } from "lucide-react";
import { Badge, Button } from "../../components/ui.js";

export function RuntimeHeader(props: {
  running: boolean;
  nodes: number;
  active: number;
  assigned: number;
  listeners?: number;
  onLogout: () => void;
}) {
  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand-mark">MH</div>
        <div>
          <h1>Mihomo Hive</h1>
          <p>固定出口代理池工作台</p>
        </div>
      </div>
      <div className="header-metrics">
        <HeaderMetric icon={<Server size={16} />} label="Mihomo" value={props.running ? "运行中" : "未运行"} ok={props.running} />
        <HeaderMetric icon={<Network size={16} />} label="节点" value={String(props.nodes)} />
        <HeaderMetric icon={<Activity size={16} />} label="可用" value={String(props.active)} ok={props.active > 0} />
        <HeaderMetric icon={<ShieldCheck size={16} />} label="端口" value={String(props.assigned)} />
        {props.listeners !== undefined ? <HeaderMetric icon={<Server size={16} />} label="Listener" value={String(props.listeners)} /> : null}
      </div>
      <Button variant="secondary" icon={<LogOut size={16} />} onClick={props.onLogout}>
        退出
      </Button>
    </header>
  );
}

function HeaderMetric(props: { icon: React.ReactNode; label: string; value: string; ok?: boolean }) {
  return (
    <div className="header-metric">
      {props.icon}
      <span>{props.label}</span>
      <Badge tone={props.ok === undefined ? "neutral" : props.ok ? "success" : "warning"}>{props.value}</Badge>
    </div>
  );
}
