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
import { ArrowDownUp, Bot, Check, ChevronsLeft, ChevronsRight, MessageSquare, Search, X } from "lucide-react";
import type { ProxyNode } from "@mihomo-hive/schemas";
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
  onFiltersChange: (filters: NodeFilters) => void;
  onToggleNode: (hash: string, selected: boolean) => void;
  onSelectFiltered: (exportableOnly: boolean) => void;
  onSelectSuccessful: () => void;
  onInvertFiltered: () => void;
  onClearSelection: () => void;
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
        accessorKey: "lastTestStatus",
        header: "测试结果",
        cell: ({ row }) => <TestResult value={row.original.lastTestStatus} />,
        size: 170
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

  const selectedFiltered = props.filteredNodes.filter((node) => props.selectedHashes.has(node.hash)).length;
  const exportableFiltered = props.filteredNodes.filter(canExportNode).length;

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

      <div className="selection-bar">
        <div>
          当前筛选 <strong>{props.filteredNodes.length}</strong> 个，已选 <strong>{selectedFiltered}</strong> 个，可导出{" "}
          <strong>{exportableFiltered}</strong> 个
        </div>
        <div className="selection-actions">
          <Button size="sm" variant="secondary" onClick={() => props.onSelectFiltered(false)}>
            选择当前结果
          </Button>
          <Button size="sm" variant="secondary" icon={<Check size={15} />} onClick={props.onSelectSuccessful}>
            选择成功结果
          </Button>
          <Button size="sm" variant="secondary" onClick={props.onInvertFiltered}>
            反选当前结果
          </Button>
          <Button size="sm" variant="ghost" icon={<X size={15} />} onClick={props.onClearSelection}>
            清空选择
          </Button>
        </div>
      </div>

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
