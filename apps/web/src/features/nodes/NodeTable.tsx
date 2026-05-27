import React from "react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from "@tanstack/react-table";
import {
  AlertTriangle,
  ArrowDownUp,
  Bot,
  Check,
  CheckCircle2,
  CircleDot,
  ChevronsLeft,
  ChevronsRight,
  MessageSquare,
  MinusCircle,
  Search,
  Users,
  XCircle
} from "lucide-react";
import type { ProxyNode, Sub2ApiProxyRecord } from "@mihomo-hive/schemas";
import { Badge, Button, Checkbox, EmptyState, SelectInput, TextInput } from "../../components/ui.js";
import {
  canExportNode,
  exportBlockReason,
  formatLifecycleStatus,
  formatRegion,
  formatNodeStatus,
  lifecycleTone,
  parseTestResults,
  type NodeFilters,
  statusTone,
  uniqueOptions
} from "./node-utils.js";

export function NodeTable(props: {
  nodes: ProxyNode[];
  filteredNodes: ProxyNode[];
  filters: NodeFilters;
  sourceNames: Map<string, string>;
  selectedHashes: Set<string>;
  /** key = proxy_id；用于显示 Sub2API 端的状态和账号数；未连接 / 未推送时传 undefined */
  sub2apiProxies?: Map<number, Sub2ApiProxyRecord>;
  /** Sub2API 连接是否已配置；用于"未推送"列文案 */
  sub2apiConnected: boolean;
  onFiltersChange: (filters: NodeFilters) => void;
  onToggleNode: (hash: string, selected: boolean) => void;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([{ id: "assignedPort", desc: false }]);
  const columns = React.useMemo<ColumnDef<ProxyNode>[]>(
    () => [
      {
        id: "select",
        header: "",
        cell: ({ row }) => {
          const node = row.original;
          return (
            <Checkbox
              checked={props.selectedHashes.has(node.hash)}
              onChange={(checked) => props.onToggleNode(node.hash, checked)}
            />
          );
        },
        enableSorting: false,
        size: 42
      },
      {
        accessorKey: "assignedPort",
        header: "端口",
        cell: ({ row }) => <span className="mono-strong">{row.original.assignedPort ?? "-"}</span>,
        sortingFn: "alphanumeric",
        size: 76
      },
      {
        accessorKey: "name",
        header: "节点名称",
        cell: ({ row }) => <span className="node-name" title={row.original.name}>{row.original.name}</span>,
        size: 300
      },
      {
        accessorKey: "lifecycleStatus",
        header: "调度",
        cell: ({ row }) => <Badge tone={lifecycleTone(row.original.lifecycleStatus)}>{formatLifecycleStatus(row.original.lifecycleStatus)}</Badge>,
        size: 92
      },
      {
        accessorKey: "status",
        header: "状态",
        cell: ({ row }) => <Badge tone={statusTone(row.original.status)}>{formatNodeStatus(row.original.status)}</Badge>,
        size: 86
      },
      {
        id: "exportable",
        header: "导出",
        cell: ({ row }) =>
          canExportNode(row.original) ? (
            <Badge tone="success">可导出</Badge>
          ) : (
            <span className="muted small">{exportBlockReason(row.original)}</span>
          ),
        enableSorting: false,
        size: 116
      },
      {
        accessorKey: "region",
        header: "地区",
        cell: ({ row }) => formatRegion(row.original.region),
        size: 82
      },
      {
        accessorKey: "type",
        header: "协议",
        cell: ({ row }) => <span className="mono">{row.original.type}</span>,
        size: 78
      },
      {
        accessorKey: "lastTestLatencyMs",
        header: "延迟",
        cell: ({ row }) => (row.original.lastTestLatencyMs ? `${row.original.lastTestLatencyMs}ms` : "-"),
        size: 90
      },
      {
        accessorKey: "qualityScore",
        header: "质量",
        cell: ({ row }) => <QualityCell score={row.original.qualityScore ?? null} />,
        size: 88
      },
      {
        accessorKey: "lastTestStatus",
        header: "测试结果",
        cell: ({ row }) => <TestResult value={row.original.lastTestStatus} />,
        size: 170
      },
      {
        id: "sub2api",
        header: "Sub2API",
        cell: ({ row }) => (
          <Sub2ApiCell
            node={row.original}
            proxy={row.original.sub2apiProxyId ? props.sub2apiProxies?.get(row.original.sub2apiProxyId) : undefined}
            connected={props.sub2apiConnected}
          />
        ),
        enableSorting: false,
        size: 156
      },
      {
        id: "accountCount",
        header: "账号",
        accessorFn: (node) =>
          node.sub2apiProxyId ? props.sub2apiProxies?.get(node.sub2apiProxyId)?.account_count ?? 0 : -1,
        cell: ({ row }) => (
          <AccountCountCell
            proxy={row.original.sub2apiProxyId ? props.sub2apiProxies?.get(row.original.sub2apiProxyId) : undefined}
            hasProxyId={Boolean(row.original.sub2apiProxyId)}
          />
        ),
        sortingFn: "alphanumeric",
        size: 76
      },
      {
        accessorKey: "sourceId",
        header: "来源",
        cell: ({ row }) => <span className="truncate-cell">{props.sourceNames.get(row.original.sourceId) ?? row.original.sourceId}</span>,
        size: 140
      }
    ],
    [props]
  );
  const table = useReactTable({
    data: props.filteredNodes,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 50 }
    }
  });

  return (
    <section className="nodes-workspace">
      <header className="nodes-toolbar">
        <div className="search-box">
          <Search size={16} />
          <TextInput
            value={props.filters.search}
            onChange={(search) => props.onFiltersChange({ ...props.filters, search })}
            placeholder="搜索节点、地区、协议"
          />
        </div>
        <SelectInput
          value={props.filters.status}
          onChange={(status) => props.onFiltersChange({ ...props.filters, status })}
          options={[
            { label: "全部状态", value: "all" },
            { label: "可用", value: "active" },
            { label: "失败", value: "failed" },
            { label: "未测试", value: "untested" },
            { label: "停用", value: "inactive" }
          ]}
        />
        <SelectInput
          value={props.filters.region}
          onChange={(region) => props.onFiltersChange({ ...props.filters, region })}
          options={[{ label: "全部地区", value: "all" }, ...uniqueOptions(props.nodes, "region")]}
        />
        <SelectInput
          value={props.filters.type}
          onChange={(type) => props.onFiltersChange({ ...props.filters, type })}
          options={[{ label: "全部协议", value: "all" }, ...uniqueOptions(props.nodes, "type")]}
        />
        <TextInput
          value={props.filters.portFrom}
          onChange={(portFrom) => props.onFiltersChange({ ...props.filters, portFrom })}
          placeholder="端口从"
          mono
        />
        <TextInput
          value={props.filters.portTo}
          onChange={(portTo) => props.onFiltersChange({ ...props.filters, portTo })}
          placeholder="端口到"
          mono
        />
      </header>

      <div className="table-frame">
        {props.filteredNodes.length === 0 ? (
          <EmptyState title="没有匹配的节点" description="调整筛选条件，或先完成订阅拉取和节点导入。" />
        ) : (
          <table className="node-table">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th key={header.id} style={{ width: header.getSize() }}>
                      {header.isPlaceholder ? null : (
                        <button
                          className={header.column.getCanSort() ? "sortable-header" : "plain-header"}
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getCanSort() ? <ArrowDownUp size={13} /> : null}
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.original.hash} className={props.selectedHashes.has(row.original.hash) ? "is-selected" : ""}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="table-footer">
        <div>
          第 {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())} 页
        </div>
        <div className="pager">
          <Button
            size="sm"
            variant="secondary"
            icon={<ChevronsLeft size={15} />}
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<ChevronsRight size={15} />}
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            下一页
          </Button>
        </div>
      </footer>
    </section>
  );
}

function QualityCell(props: { score: number | null | undefined }) {
  if (props.score === null || props.score === undefined) {
    return <span className="muted small">-</span>;
  }
  const tone: "success" | "warning" | "danger" = props.score >= 80 ? "success" : props.score >= 50 ? "warning" : "danger";
  return <Badge tone={tone}>{props.score}</Badge>;
}

function TestResult(props: { value: string | undefined }) {
  const results = parseTestResults(props.value);
  if (results.length === 0) {
    return <span className="muted small">-</span>;
  }
  return (
    <div className="test-result-list" title={props.value}>
      {results.map((result) => (
        <span key={result.target} className={`test-chip ${result.ok ? "is-ok" : "is-fail"}`}>
          {result.target === "openai" ? <Bot size={13} /> : result.target === "claude" ? <MessageSquare size={13} /> : null}
          <span>{result.target === "openai" ? "OpenAI" : result.target === "claude" ? "Claude" : result.target}</span>
          <strong>{result.ok ? "OK" : "Fail"}</strong>
        </span>
      ))}
    </div>
  );
}

function Sub2ApiCell(props: { node: ProxyNode; proxy: Sub2ApiProxyRecord | undefined; connected: boolean }) {
  if (!props.connected) {
    return (
      <span className="sub2api-cell muted" title="Sub2API 连接未配置；在账号编排页配置后此处会显示远端状态。">
        <MinusCircle size={14} aria-hidden="true" />
        <span className="small">未连接</span>
      </span>
    );
  }
  if (!props.node.sub2apiProxyId) {
    return (
      <span
        className="sub2api-cell muted"
        title="尚未推送到 Sub2API。在节点池工具栏选中后点'启用调度'会自动推送。"
      >
        <CircleDot size={14} aria-hidden="true" />
        <span className="small">未推送</span>
      </span>
    );
  }
  if (!props.proxy) {
    return (
      <span
        className="sub2api-cell sub2api-cell-warning"
        title="本地记录了 proxy_id，但 Sub2API 当前列表里找不到对应代理。可能被外部删除，需要重新启用调度。"
      >
        <AlertTriangle size={14} aria-hidden="true" />
        <span className="mono small">#{props.node.sub2apiProxyId}</span>
        <span className="small">失联</span>
      </span>
    );
  }
  const status = props.proxy.status;
  const StatusIcon = status === "active" ? CheckCircle2 : status === "failed" ? XCircle : MinusCircle;
  const tone = status === "active" ? "sub2api-cell-ok" : status === "failed" ? "sub2api-cell-bad" : "sub2api-cell-idle";
  return (
    <span
      className={`sub2api-cell ${tone}`}
      title={`Sub2API #${props.proxy.id} ${props.proxy.protocol}://${props.proxy.host}:${props.proxy.port}\n状态: ${status}`}
    >
      <StatusIcon size={14} aria-hidden="true" />
      <span className="mono small">#{props.proxy.id}</span>
    </span>
  );
}

function AccountCountCell(props: { proxy: Sub2ApiProxyRecord | undefined; hasProxyId: boolean }) {
  if (!props.hasProxyId) {
    return <span className="muted small">-</span>;
  }
  if (!props.proxy) {
    return <span className="muted small">?</span>;
  }
  const count = props.proxy.account_count ?? 0;
  const tone = count > 0 ? "info" : "neutral";
  return (
    <span className="account-count-cell" title={`当前 Sub2API 端绑定到此代理的账号数：${count}`}>
      <Users size={12} className="muted" aria-hidden="true" />
      <Badge tone={tone}>{count}</Badge>
    </span>
  );
}
