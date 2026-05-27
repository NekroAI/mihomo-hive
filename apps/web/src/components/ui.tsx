import React from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Info, Loader2, X } from "lucide-react";

export type Tone = "neutral" | "success" | "danger" | "warning" | "info";

export function Button(props: {
  children: React.ReactNode;
  icon?: React.ReactNode | undefined;
  variant?: "primary" | "secondary" | "ghost" | "danger" | undefined;
  size?: "sm" | "md" | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  title?: string | undefined;
  onClick?: (() => void) | undefined;
  type?: "button" | "submit" | undefined;
}) {
  const variant = props.variant ?? "primary";
  const size = props.size ?? "md";
  return (
    <button
      className={`ui-button ui-button-${variant} ui-button-${size}`}
      disabled={props.disabled || props.loading}
      title={props.title}
      type={props.type ?? "button"}
      onClick={props.onClick}
    >
      {props.loading ? <Loader2 className="animate-spin" size={16} /> : props.icon}
      <span>{props.children}</span>
    </button>
  );
}

export function IconButton(props: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean | undefined;
  onClick?: (() => void) | undefined;
}) {
  return (
    <button className="icon-button" disabled={props.disabled} title={props.label} type="button" onClick={props.onClick}>
      {props.icon}
      <span className="sr-only">{props.label}</span>
    </button>
  );
}

export function TextInput(props: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  type?: string | undefined;
  mono?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const input = (
    <input
      className={`text-input ${props.mono ? "font-mono" : ""}`}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
      placeholder={props.placeholder}
      type={props.type ?? "text"}
    />
  );
  if (!props.label) {
    return input;
  }
  return (
    <label className="field">
      <span>{props.label}</span>
      {input}
    </label>
  );
}

export function SelectInput(props: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean | undefined;
}) {
  const select = (
    <span className="select-wrap">
      <select className="select-input" value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)}>
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={15} />
    </span>
  );
  if (!props.label) {
    return select;
  }
  return (
    <label className="field">
      <span>{props.label}</span>
      {select}
    </label>
  );
}

export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`checkbox ${props.disabled ? "is-disabled" : ""}`}>
      <input
        checked={props.checked}
        disabled={props.disabled}
        type="checkbox"
        onChange={(event) => props.onChange(event.target.checked)}
      />
      {props.label ? <span>{props.label}</span> : null}
    </label>
  );
}

export function Badge(props: { children: React.ReactNode; tone?: Tone }) {
  return <span className={`badge badge-${props.tone ?? "neutral"}`}>{props.children}</span>;
}

export function Panel(props: { title?: string; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`panel ${props.className ?? ""}`}>
      {props.title || props.actions ? (
        <header className="panel-header">
          {props.title ? <h2>{props.title}</h2> : <span />}
          {props.actions}
        </header>
      ) : null}
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

/**
 * Panel 的可折叠版本：标题旁有展开/收起箭头，body 在收起时不渲染。
 * 默认状态由 props.defaultOpen 决定；状态持久化到 localStorage 的 storageKey。
 */
export function CollapsiblePanel(props: {
  title: string;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(() => {
    if (!props.storageKey) return props.defaultOpen ?? false;
    try {
      const stored = window.localStorage.getItem(`mihomo-hive.panel.${props.storageKey}`);
      if (stored === null) return props.defaultOpen ?? false;
      return stored === "1";
    } catch {
      return props.defaultOpen ?? false;
    }
  });
  React.useEffect(() => {
    if (!props.storageKey) return;
    try {
      window.localStorage.setItem(`mihomo-hive.panel.${props.storageKey}`, open ? "1" : "0");
    } catch {
      // ignore
    }
  }, [open, props.storageKey]);
  return (
    <section className="panel collapsible-panel">
      <header
        className="panel-header collapsible-header"
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="collapsible-trigger">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <h2>{props.title}</h2>
        {props.hint ? <InfoTip text={props.hint} /> : null}
        {props.actions ? (
          <span className="collapsible-actions" onClick={(e) => e.stopPropagation()}>
            {props.actions}
          </span>
        ) : null}
      </header>
      {open ? <div className="panel-body">{props.children}</div> : null}
    </section>
  );
}

/**
 * Info icon with hover tooltip via native `title` attribute (cheap and a11y-friendly).
 * Use to hide longish explanations from the常驻 page surface.
 */
export function InfoTip(props: { text: string }) {
  return (
    <button
      type="button"
      className="info-tip"
      title={props.text}
      aria-label={props.text}
      onClick={(e) => e.stopPropagation()}
    >
      <Info size={13} />
    </button>
  );
}

export function EmptyState(props: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      {props.icon ? <div className="empty-icon">{props.icon}</div> : null}
      <h3>{props.title}</h3>
      <p>{props.description}</p>
      {props.action ? <div>{props.action}</div> : null}
    </div>
  );
}

export interface ToastMessage {
  id: string;
  tone: Exclude<Tone, "neutral">;
  title: string;
  detail?: string | undefined;
}

export function ToastStack(props: { messages: ToastMessage[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toast-stack">
      {props.messages.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`}>
          <div className="toast-icon">
            {toast.tone === "success" ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          </div>
          <div>
            <div className="toast-title">{toast.title}</div>
            {toast.detail ? <div className="toast-detail">{toast.detail}</div> : null}
          </div>
          <button type="button" onClick={() => props.onDismiss(toast.id)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description: string;
  detail?: React.ReactNode | undefined;
  confirmLabel: string;
  dangerous?: boolean | undefined;
  loading?: boolean | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!props.open) {
    return null;
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{props.title}</h2>
        <p>{props.description}</p>
        {props.detail ? <div className="dialog-detail">{props.detail}</div> : null}
        <footer>
          <Button variant="secondary" disabled={props.loading} onClick={props.onCancel}>
            取消
          </Button>
          <Button
            variant={props.dangerous ? "danger" : "primary"}
            loading={props.loading}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  );
}
