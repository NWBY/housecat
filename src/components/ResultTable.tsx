import { Button, Table as KumoTable } from "@cloudflare/kumo";
import type { ViewerTab } from "../types/viewer";

type ResultTableProps = {
  activeTab: ViewerTab;
  onRetry: () => void;
  onCreateQueryTab: () => void;
  onRefreshSchemas: () => void;
  onSortColumn: (column: string) => void;
  onCopyCell: (value: string, column: string) => void;
};

function formatCellValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function getCellValueType(value: unknown): "null" | "number" | "default" {
  if (value === null) {
    return "null";
  }

  if (typeof value === "number") {
    return "number";
  }

  return "default";
}

export function ResultTable({
  activeTab,
  onRetry,
  onCreateQueryTab,
  onRefreshSchemas,
  onSortColumn,
  onCopyCell,
}: ResultTableProps) {
  return (
    <div className="result-pane">
      {activeTab.error ? (
        <div className="inline-error bg-kumo-tint border-kumo-line">
          <p className="error-text text-kumo-danger">{activeTab.error}</p>
          <Button
            variant="secondary"
            className="no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      ) : null}

      {activeTab.isLoading ? (
        <div className="skeleton-grid">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={`skeleton-${index}`} className="skeleton-row bg-kumo-tint" />
          ))}
        </div>
      ) : null}

      {!activeTab.isLoading && activeTab.preview.columns.length > 0 ? (
        <div className="table-wrap">
          <KumoTable className="data-table" layout="auto">
            <KumoTable.Header>
              <KumoTable.Row>
                {activeTab.preview.columns.map((column) => (
                  <KumoTable.Head
                    key={column}
                    className="sortable-head"
                    onClick={() => {
                      onSortColumn(column);
                    }}
                  >
                    {column}
                    {activeTab.sort?.column === column
                      ? activeTab.sort.direction === "asc"
                        ? " ▲"
                        : " ▼"
                      : ""}
                  </KumoTable.Head>
                ))}
              </KumoTable.Row>
            </KumoTable.Header>
            <KumoTable.Body>
              {activeTab.preview.rows.map((row, index) => (
                <KumoTable.Row key={`row-${index}`}>
                  {activeTab.preview.columns.map((column) => {
                    const raw = formatCellValue(row[column]);

                    return (
                      <KumoTable.Cell
                        key={`${index}-${column}`}
                        onClick={() => {
                          onCopyCell(raw, column);
                        }}
                        className="copyable-cell"
                      >
                        <span className={`cell-value cell-${getCellValueType(row[column])}`}>{raw}</span>
                      </KumoTable.Cell>
                    );
                  })}
                </KumoTable.Row>
              ))}
            </KumoTable.Body>
          </KumoTable>
        </div>
      ) : null}

      {!activeTab.isLoading && activeTab.preview.columns.length === 0 && !activeTab.error ? (
        <div className="empty-state-panel bg-kumo-tint border-kumo-line">
          <p className="empty-state text-kumo-subtle">No rows to show for this tab.</p>
          <div className="empty-state-actions">
            <Button
              variant="secondary"
              className="no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
              onClick={onCreateQueryTab}
            >
              Create Query Tab
            </Button>
            <Button
              variant="secondary"
              className="no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
              onClick={onRefreshSchemas}
            >
              Refresh Schemas
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
