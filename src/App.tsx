import { FormEvent, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CaretDown,
  CaretRight,
  Database,
  FloppyDisk,
  Plus,
  Table as TableIcon,
  TerminalWindow,
  Trash,
  X,
} from "@phosphor-icons/react";
import { Button, Input, Surface, Switch, Tabs } from "@cloudflare/kumo";
import { AppToast } from "./components/AppToast";
import { QueryEditor } from "./components/QueryEditor";
import { ResultTable } from "./components/ResultTable";
import { TabActions } from "./components/TabActions";
import { closeTabWithActive, createQueryTab as makeQueryTab, createTableTab, duplicateTab } from "./state/viewerTabs";
import type { SchemaTableItem, SchemaTables, TablePreview, ViewerTab } from "./types/viewer";
import "./App.css";

type ConnectionForm = {
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  secure: boolean;
};

type ConnectionStatus = {
  connected: boolean;
  latencyMs: number;
  version: string;
  currentDatabase: string;
};

type Screen = "connection" | "viewer";

type SavedConnection = {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  secure: boolean;
};

type ConnectionPayload = {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string | null;
  secure: boolean;
};

const SAVED_CONNECTIONS_KEY = "housecat.savedConnections";
const QUERY_HISTORY_KEY = "housecat.queryHistory";

function loadSavedConnections(): SavedConnection[] {
  try {
    const raw = localStorage.getItem(SAVED_CONNECTIONS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is SavedConnection => {
        return (
          Boolean(entry) &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          typeof entry.name === "string" &&
          typeof entry.host === "string" &&
          typeof entry.port === "string" &&
          typeof entry.username === "string" &&
          typeof entry.password === "string" &&
          typeof entry.database === "string" &&
          typeof entry.secure === "boolean"
        );
      })
      .slice(0, 50);
  } catch {
    return [];
  }
}

function persistSavedConnections(connections: SavedConnection[]) {
  localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(connections));
}

function loadQueryHistory(): string[] {
  try {
    const raw = localStorage.getItem(QUERY_HISTORY_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 100);
  } catch {
    return [];
  }
}

function persistQueryHistory(history: string[]) {
  localStorage.setItem(QUERY_HISTORY_KEY, JSON.stringify(history.slice(0, 100)));
}

function toConnectionPayload(connection: ConnectionForm): ConnectionPayload {
  return {
    host: connection.host.trim(),
    port: Math.max(1, Math.min(65535, Number(connection.port) || 8123)),
    username: connection.username.trim(),
    password: connection.password,
    database: connection.database.trim() || null,
    secure: connection.secure,
  };
}

function normalizeSchemaTables(value: unknown): SchemaTables[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as { schema?: unknown; tables?: unknown };
      const schema = typeof record.schema === "string" ? record.schema : "";
      const tables = Array.isArray(record.tables)
        ? record.tables
            .map((table) => {
              if (typeof table === "string") {
                return { name: table, rowCount: null };
              }

              if (!table || typeof table !== "object") {
                return null;
              }

              const tableRecord = table as { name?: unknown; rowCount?: unknown; row_count?: unknown };
              const name = typeof tableRecord.name === "string" ? tableRecord.name : "";
              const rowCountValue =
                typeof tableRecord.rowCount === "number"
                  ? tableRecord.rowCount
                  : typeof tableRecord.row_count === "number"
                    ? tableRecord.row_count
                    : null;

              if (!name) {
                return null;
              }

              return {
                name,
                rowCount:
                  typeof rowCountValue === "number" && Number.isFinite(rowCountValue)
                    ? Math.max(0, Math.trunc(rowCountValue))
                    : null,
              };
            })
            .filter((table): table is SchemaTableItem => table !== null)
        : [];

      if (!schema) {
        return null;
      }

      return { schema, tables };
    })
    .filter((entry): entry is SchemaTables => entry !== null);
}

function normalizeTablePreview(value: unknown): TablePreview {
  if (!value || typeof value !== "object") {
    return { columns: [], rows: [] };
  }

  const record = value as { columns?: unknown; rows?: unknown };
  const columns = Array.isArray(record.columns)
    ? record.columns.filter((column): column is string => typeof column === "string")
    : [];

  const rows = Array.isArray(record.rows)
    ? record.rows.filter((row): row is Record<string, unknown> => {
        return Boolean(row) && typeof row === "object" && !Array.isArray(row);
      })
    : [];

  return { columns, rows };
}

function getFirstTable(schemas: SchemaTables[]): { schema: string; table: string } | null {
  for (const schema of schemas) {
    if (schema.tables.length > 0) {
      return { schema: schema.schema, table: schema.tables[0].name };
    }
  }

  return null;
}

function App() {
  const [screen, setScreen] = useState<Screen>("connection");
  const [form, setForm] = useState<ConnectionForm>({
    host: "localhost",
    port: "8123",
    username: "default",
    password: "",
    database: "",
    secure: false,
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus | null>(null);
  const [schemaTables, setSchemaTables] = useState<SchemaTables[]>([]);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tableFilter, setTableFilter] = useState("");
  const [viewerTabs, setViewerTabs] = useState<ViewerTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>(() =>
    typeof window === "undefined" ? [] : loadSavedConnections(),
  );
  const [queryHistory, setQueryHistory] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : loadQueryHistory(),
  );
  const [connectionName, setConnectionName] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  function showToast(message: string) {
    setToastMessage(message);
    window.setTimeout(() => {
      setToastMessage((current) => (current === message ? null : current));
    }, 1600);
  }

  function getConnectionPayload() {
    return toConnectionPayload(form);
  }

  const totalTables = useMemo(
    () => schemaTables.reduce((count, schema) => count + schema.tables.length, 0),
    [schemaTables],
  );

  const activeTab = useMemo(
    () => viewerTabs.find((tab) => tab.id === activeTabId) ?? null,
    [viewerTabs, activeTabId],
  );

  const activeTableMeta = useMemo(() => {
    if (!activeTab || activeTab.type !== "table" || !activeTab.schema || !activeTab.table) {
      return null;
    }

    const schemaEntry = schemaTables.find((schema) => schema.schema === activeTab.schema);
    if (!schemaEntry) {
      return null;
    }

    return schemaEntry.tables.find((table) => table.name === activeTab.table) ?? null;
  }, [activeTab, schemaTables]);

  const filteredSchemas = useMemo(() => {
    const query = tableFilter.trim().toLowerCase();
    if (!query) {
      return schemaTables;
    }

    return schemaTables
      .map((schema) => ({
        schema: schema.schema,
        tables: schema.tables.filter((table) => table.name.toLowerCase().includes(query)),
      }))
      .filter((schema) => schema.tables.length > 0 || schema.schema.toLowerCase().includes(query));
  }, [schemaTables, tableFilter]);

  const autocompleteTokens = useMemo(() => {
    const tokenSet = new Set<string>([
      "SELECT",
      "FROM",
      "WHERE",
      "GROUP BY",
      "ORDER BY",
      "LIMIT",
      "HAVING",
      "JOIN",
      "INNER JOIN",
      "LEFT JOIN",
      "RIGHT JOIN",
      "FULL JOIN",
      "ON",
      "WITH",
      "AS",
      "UNION",
      "UNION ALL",
      "DISTINCT",
      "INSERT INTO",
      "VALUES",
      "UPDATE",
      "DELETE",
      "CREATE TABLE",
      "DROP TABLE",
      "ALTER TABLE",
      "FORMAT JSON",
      "COUNT",
      "SUM",
      "AVG",
      "MIN",
      "MAX",
      "system.tables",
      "system.columns",
      "toDate",
      "toDateTime",
      "now()",
    ]);

    for (const schema of schemaTables) {
      tokenSet.add(schema.schema);
      tokenSet.add(`${schema.schema}.`);
      for (const table of schema.tables) {
        tokenSet.add(table.name);
        tokenSet.add(`${schema.schema}.${table.name}`);
      }
    }

    return Array.from(tokenSet);
  }, [schemaTables]);

  function updateTab(tabId: string, updater: (tab: ViewerTab) => ViewerTab) {
    setViewerTabs((prev) => prev.map((tab) => (tab.id === tabId ? updater(tab) : tab)));
  }

  function createQueryTab() {
    const tab = makeQueryTab(viewerTabs);
    setViewerTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }

  function closeTab(tabId: string) {
    const result = closeTabWithActive(viewerTabs, activeTabId, tabId);
    setViewerTabs(result.tabs);
    setActiveTabId(result.activeTabId);
  }

  function renameActiveTab() {
    if (!activeTab) {
      return;
    }

    const nextTitle = window.prompt("Rename tab", activeTab.title);
    if (!nextTitle || !nextTitle.trim()) {
      return;
    }

    updateTab(activeTab.id, (tab) => ({ ...tab, title: nextTitle.trim() }));
  }

  function duplicateActiveTab() {
    if (!activeTab) {
      return;
    }

    const result = duplicateTab(viewerTabs, activeTab);
    setViewerTabs(result.tabs);
    setActiveTabId(result.activeTabId);
  }

  function closeOtherTabs() {
    if (!activeTabId) {
      return;
    }

    setViewerTabs((prev) => prev.filter((tab) => tab.id === activeTabId));
  }

  function closeAllTabs() {
    setViewerTabs([]);
    setActiveTabId(null);
  }

  async function loadTablePreviewIntoTab(
    tabId: string,
    schema: string,
    table: string,
    sort?: { column: string; direction: "asc" | "desc" },
  ) {
    updateTab(tabId, (tab) => ({ ...tab, isLoading: true, error: null }));
    const started = performance.now();

    try {
      const result = await invoke<unknown>("fetch_table_preview", {
        input: {
          connection: getConnectionPayload(),
          schema,
          table,
          limit: 200,
          sortColumn: sort?.column,
          sortDirection: sort?.direction,
        },
      });

      const normalized = normalizeTablePreview(result);

      updateTab(tabId, (tab) => ({
        ...tab,
        preview: normalized,
        isLoading: false,
        error: null,
        lastRunMs: Math.max(0, Math.round(performance.now() - started)),
        lastRowCount: normalized.rows.length,
        sort,
      }));
    } catch (error) {
      updateTab(tabId, (tab) => ({
        ...tab,
        preview: { columns: [], rows: [] },
        isLoading: false,
        error: typeof error === "string" ? error : "Failed to fetch table preview.",
      }));
    }
  }

  function openTableInNewTab(schema: string, table: string) {
    const tab = createTableTab(schema, table);
    setViewerTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    void loadTablePreviewIntoTab(tab.id, schema, table);
  }

  function pushQueryHistoryEntry(query: string) {
    const normalized = query.trim();
    if (!normalized) {
      return;
    }

    setQueryHistory((prev) => {
      const next = [normalized, ...prev.filter((entry) => entry !== normalized)].slice(0, 100);
      persistQueryHistory(next);
      return next;
    });
  }

  async function runActiveQuery() {
    if (!activeTab || activeTab.type !== "query") {
      return;
    }

    updateTab(activeTab.id, (tab) => ({ ...tab, isLoading: true, error: null }));
    const started = performance.now();

    try {
      const result = await invoke<unknown>("run_query", {
        input: {
          connection: getConnectionPayload(),
          query: activeTab.query,
          limit: 500,
        },
      });

      const normalized = normalizeTablePreview(result);

      updateTab(activeTab.id, (tab) => ({
        ...tab,
        preview: normalized,
        isLoading: false,
        error: null,
        lastRunMs: Math.max(0, Math.round(performance.now() - started)),
        lastRowCount: normalized.rows.length,
      }));
      pushQueryHistoryEntry(activeTab.query);
    } catch (error) {
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        isLoading: false,
        error: typeof error === "string" ? error : "Query failed.",
      }));
    } finally {
      void refreshConnectionStatus();
    }
  }

  async function sortActiveTabByColumn(column: string) {
    if (!activeTab) {
      return;
    }

    const nextDirection: "asc" | "desc" =
      activeTab.sort?.column === column && activeTab.sort.direction === "asc" ? "desc" : "asc";

    if (activeTab.preview.rows.length <= 300) {
      const sortedRows = [...activeTab.preview.rows].sort((left, right) => {
        const l = left[column];
        const r = right[column];

        if (l === r) {
          return 0;
        }

        if (l === null || l === undefined) {
          return nextDirection === "asc" ? 1 : -1;
        }

        if (r === null || r === undefined) {
          return nextDirection === "asc" ? -1 : 1;
        }

        if (typeof l === "number" && typeof r === "number") {
          return nextDirection === "asc" ? l - r : r - l;
        }

        const lv = String(l).toLowerCase();
        const rv = String(r).toLowerCase();

        if (lv < rv) {
          return nextDirection === "asc" ? -1 : 1;
        }

        if (lv > rv) {
          return nextDirection === "asc" ? 1 : -1;
        }

        return 0;
      });

      updateTab(activeTab.id, (tab) => ({
        ...tab,
        preview: { ...tab.preview, rows: sortedRows },
        sort: { column, direction: nextDirection },
      }));
      return;
    }

    if (activeTab.type === "table" && activeTab.schema && activeTab.table) {
      await loadTablePreviewIntoTab(activeTab.id, activeTab.schema, activeTab.table, {
        column,
        direction: nextDirection,
      });
      return;
    }

    if (activeTab.type === "query") {
      const raw = activeTab.query.trim().replace(/;\s*$/, "");
      if (!/^select\s+/i.test(raw)) {
        showToast("Large-result sorting requires a SELECT query.");
        return;
      }

      const wrapped = raw.replace(/\s+format\s+json\s*$/i, "");
      const sortedQuery = `SELECT * FROM (${wrapped}) AS t ORDER BY \`${column.replace(/`/g, "``")}\` ${nextDirection.toUpperCase()} LIMIT 500`;

      updateTab(activeTab.id, (tab) => ({ ...tab, isLoading: true, error: null }));
      const started = performance.now();

      try {
        const result = await invoke<unknown>("run_query", {
          input: {
            connection: getConnectionPayload(),
            query: sortedQuery,
            limit: 500,
          },
        });

        const normalized = normalizeTablePreview(result);
        updateTab(activeTab.id, (tab) => ({
          ...tab,
          preview: normalized,
          isLoading: false,
          error: null,
          sort: { column, direction: nextDirection },
          lastRunMs: Math.max(0, Math.round(performance.now() - started)),
          lastRowCount: normalized.rows.length,
        }));
      } catch (error) {
        updateTab(activeTab.id, (tab) => ({
          ...tab,
          isLoading: false,
          error: typeof error === "string" ? error : "Sort query failed.",
        }));
      }
    }
  }

  async function refreshConnectionStatus(payload?: ConnectionPayload) {
    try {
      const result = await invoke<unknown>("fetch_connection_status", {
        input: payload ?? getConnectionPayload(),
      });

      if (result && typeof result === "object") {
        const record = result as {
          connected?: unknown;
          latencyMs?: unknown;
          latency_ms?: unknown;
          version?: unknown;
          currentDatabase?: unknown;
          current_database?: unknown;
        };

        const latencyValue =
          typeof record.latencyMs === "number"
            ? record.latencyMs
            : typeof record.latency_ms === "number"
              ? record.latency_ms
              : 0;

        setConnectionStatus({
          connected: Boolean(record.connected ?? true),
          latencyMs: Number.isFinite(latencyValue) ? Math.max(0, Math.round(latencyValue)) : 0,
          version: typeof record.version === "string" ? record.version : "unknown",
          currentDatabase:
            typeof record.currentDatabase === "string"
              ? record.currentDatabase
              : typeof record.current_database === "string"
                ? record.current_database
                : "unknown",
        });
      }
    } catch {
      setConnectionStatus(null);
    }
  }

  function toggleSchema(schemaName: string) {
    setExpandedSchemas((prev) => {
      const next = new Set(prev);
      if (next.has(schemaName)) {
        next.delete(schemaName);
      } else {
        next.add(schemaName);
      }
      return next;
    });
  }

  async function fetchSchemasAndOpenViewer(payload: ConnectionPayload): Promise<SchemaTables[] | null> {
    const result = await invoke<unknown>("fetch_schema_tables", {
      input: payload,
    });

    const normalized = normalizeSchemaTables(result);
    setSchemaTables(normalized);

    const firstTable = getFirstTable(normalized);
    if (!firstTable) {
      createQueryTab();
      return normalized;
    }

    setExpandedSchemas(new Set(normalized.map((schema) => schema.schema)));
    openTableInNewTab(firstTable.schema, firstTable.table);
    return normalized;
  }

  async function connectToClickHouse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    await connectWithPayload(getConnectionPayload());
  }

  async function connectWithPayload(payload: ConnectionPayload) {
    setConnectionError(null);
    setIsConnecting(true);

    try {
      await fetchSchemasAndOpenViewer(payload);
      await refreshConnectionStatus(payload);
      setScreen("viewer");
    } catch (error) {
      setSchemaTables([]);
      setConnectionError(typeof error === "string" ? error : "Failed to connect to ClickHouse.");
    } finally {
      setIsConnecting(false);
    }
  }

  async function refreshViewer() {
    setConnectionError(null);
    setIsConnecting(true);

    try {
      const refreshed = await invoke<unknown>("fetch_schema_tables", {
        input: getConnectionPayload(),
      });

      const normalized = normalizeSchemaTables(refreshed);
      setSchemaTables(normalized);
      setExpandedSchemas((prev) => {
        const next = new Set(prev);
        for (const schema of normalized) {
          if (!next.has(schema.schema)) {
            next.add(schema.schema);
          }
        }
        return next;
      });
      await refreshConnectionStatus();
    } catch (error) {
      setConnectionError(typeof error === "string" ? error : "Refresh failed.");
    } finally {
      setIsConnecting(false);
    }
  }

  function disconnect() {
    setScreen("connection");
    setSchemaTables([]);
    setExpandedSchemas(new Set());
    setViewerTabs([]);
    setActiveTabId(null);
    setConnectionError(null);
    setConnectionStatus(null);
    setTableFilter("");
  }

  function saveCurrentConnection() {
    const name = connectionName.trim();
    if (!name) {
      setConnectionError("Give this connection a name before saving.");
      return;
    }

    const nextEntry: SavedConnection = {
      id: `conn-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
      name,
      host: form.host,
      port: form.port,
      username: form.username,
      password: form.password,
      database: form.database,
      secure: form.secure,
    };

    setSavedConnections((prev) => {
      const withoutSameName = prev.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
      const next = [nextEntry, ...withoutSameName].slice(0, 20);
      persistSavedConnections(next);
      return next;
    });

    setConnectionError(null);
  }

  function loadConnection(entry: SavedConnection) {
    setForm({
      host: entry.host,
      port: entry.port,
      username: entry.username,
      password: entry.password,
      database: entry.database,
      secure: entry.secure,
    });
    setConnectionName(entry.name);
    setConnectionError(null);
  }

  async function connectSavedConnection(entry: SavedConnection) {
    const nextForm: ConnectionForm = {
      host: entry.host,
      port: entry.port,
      username: entry.username,
      password: entry.password,
      database: entry.database,
      secure: entry.secure,
    };

    setForm(nextForm);
    setConnectionName(entry.name);
    await connectWithPayload(toConnectionPayload(nextForm));
  }

  function deleteConnection(id: string) {
    setSavedConnections((prev) => {
      const next = prev.filter((entry) => entry.id !== id);
      persistSavedConnections(next);
      return next;
    });
  }

  if (screen === "connection") {
    return (
      <main className="app-shell bg-kumo-base text-kumo-default">
        <header className="hero">
          <p className="eyebrow text-kumo-brand">Housecat</p>
          <h1>Connect to ClickHouse</h1>
          <p className="hero-copy text-kumo-strong">
            Enter local or remote credentials, then jump into a dedicated viewer workspace.
          </p>
        </header>

        <Surface as="section" className="panel connection-panel bg-kumo-elevated border-kumo-line">
          <h2>Connection Settings</h2>
          <form className="connection-form" onSubmit={connectToClickHouse}>
            <Input
              label="Host"
              value={form.host}
              onChange={(event) => {
                const host = event.currentTarget.value;
                setForm((prev) => ({ ...prev, host }));
              }}
              placeholder="localhost"
              required
            />
            <Input
              label="Port"
              value={form.port}
              onChange={(event) => {
                const port = event.currentTarget.value;
                setForm((prev) => ({ ...prev, port }));
              }}
              type="number"
              min={1}
              max={65535}
              required
            />
            <Input
              label="Username"
              value={form.username}
              onChange={(event) => {
                const username = event.currentTarget.value;
                setForm((prev) => ({ ...prev, username }));
              }}
              placeholder="default"
              required
            />
            <Input
              label="Password"
              value={form.password}
              onChange={(event) => {
                const password = event.currentTarget.value;
                setForm((prev) => ({ ...prev, password }));
              }}
              type="password"
              placeholder="ClickHouse password"
            />
            <Input
              label="Database filter"
              value={form.database}
              onChange={(event) => {
                const database = event.currentTarget.value;
                setForm((prev) => ({ ...prev, database }));
              }}
              placeholder="Optional: analytics"
              description="Leave empty to browse all non-system schemas."
            />
            <Input
              label="Connection name"
              value={connectionName}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setConnectionName(value);
              }}
              placeholder="My local ClickHouse"
              description="Used for saved connection profiles"
            />
            <div className="field checkbox-field">
              <Switch
                label="Use HTTPS"
                checked={form.secure}
                onCheckedChange={(secure) => {
                  setForm((prev) => ({ ...prev, secure }));
                }}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              loading={isConnecting}
              className="connect-button no-ring !border-kumo-brand !ring-0 focus-visible:!ring-0 focus:!ring-0"
            >
              {isConnecting ? "Connecting..." : "Open Viewer"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              icon={FloppyDisk}
              onClick={saveCurrentConnection}
              className="save-connection-button no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
            >
              Save Connection
            </Button>
          </form>
          {savedConnections.length > 0 ? (
            <div className="saved-connections">
              <p className="saved-connections-label text-kumo-strong">Saved connections</p>
              <div className="saved-connections-list">
                {savedConnections.map((entry) => (
                  <div key={entry.id} className="saved-connection-row bg-kumo-control border-kumo-line">
                    <button
                      className="saved-connection-main"
                      disabled={isConnecting}
                      onClick={() => {
                        void connectSavedConnection(entry);
                      }}
                    >
                      <span className="saved-connection-name">{entry.name}</span>
                      <span className="saved-connection-meta text-kumo-subtle">
                        {entry.username}@{entry.host}:{entry.port}
                        {entry.database ? ` / ${entry.database}` : ""}
                      </span>
                    </button>
                    <button
                      className="saved-connection-load"
                      disabled={isConnecting}
                      onClick={() => {
                        loadConnection(entry);
                      }}
                    >
                      Load
                    </button>
                    <button
                      className="saved-connection-delete"
                      aria-label={`Delete ${entry.name}`}
                      disabled={isConnecting}
                      onClick={() => {
                        deleteConnection(entry.id);
                      }}
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {connectionError ? <p className="error-text text-kumo-danger">{connectionError}</p> : null}
        </Surface>
        <AppToast message={toastMessage} />
      </main>
    );
  }

  return (
    <main className="viewer-shell bg-kumo-base text-kumo-default">
      <header className="viewer-topbar">
        <div className="viewer-title-block">
          <p className="eyebrow text-kumo-brand">Housecat</p>
          <h1>Viewer</h1>
          <div className="viewer-meta text-kumo-strong">
            <span className="meta-pill bg-kumo-tint border-kumo-line">Host: {form.host}</span>
            <span className="meta-pill bg-kumo-tint border-kumo-line">Port: {form.port}</span>
            <span className="meta-pill bg-kumo-tint border-kumo-line">
              Protocol: {form.secure ? "HTTPS" : "HTTP"}
            </span>
            <span className="meta-pill bg-kumo-tint border-kumo-line">
              DB: {form.database.trim() || "all non-system"}
            </span>
            <span className="meta-pill bg-kumo-tint border-kumo-line">User: {form.username}</span>
            {connectionStatus ? (
              <span className="meta-pill status-chip bg-kumo-tint border-kumo-line">
                {connectionStatus.connected ? "Connected" : "Disconnected"} · {connectionStatus.latencyMs}ms ·
                v{connectionStatus.version}
              </span>
            ) : null}
          </div>
        </div>
        <div className="topbar-actions">
          <Button
            className="ghost-button no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
            variant="secondary"
            onClick={refreshViewer}
            loading={isConnecting}
          >
            {isConnecting ? "Refreshing..." : "Refresh"}
          </Button>
          <Button
            className="danger-button no-ring !border-kumo-danger !ring-0 focus-visible:!ring-0 focus:!ring-0"
            variant="destructive"
            onClick={disconnect}
          >
            Disconnect
          </Button>
        </div>
      </header>

      {connectionError ? <p className="error-text text-kumo-danger">{connectionError}</p> : null}

      <div className="status-bar bg-kumo-elevated border-kumo-line text-kumo-strong">
        <span>Active DB: {activeTab?.schema ?? connectionStatus?.currentDatabase ?? "-"}</span>
        <span>
          Rows: {activeTab ? activeTab.preview.rows.length.toLocaleString() : 0}
          {activeTab?.type === "table" && activeTableMeta?.rowCount !== null
            ? ` / ${activeTableMeta?.rowCount.toLocaleString()} est.`
            : ""}
        </span>
      </div>

      <section className="viewer-layout">
        <Surface as="aside" className="panel explorer-panel bg-kumo-elevated border-kumo-line">
          <div className="explorer-header">
            <h2>Explorer</h2>
            <p className="stats-line text-kumo-strong">
              {schemaTables.length} schemas · {totalTables} tables
            </p>
          </div>

          <div className="schema-tree">
            {filteredSchemas.map((schema) => {
              const isExpanded = expandedSchemas.has(schema.schema);

              return (
                <div key={schema.schema} className="schema-group">
                  <button
                    className="tree-item schema-item"
                    onClick={() => {
                      toggleSchema(schema.schema);
                    }}
                  >
                    <span className="tree-item-main">
                      {isExpanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                      <Database size={14} weight="duotone" />
                      <span>{schema.schema}</span>
                    </span>
                    <span className="tree-item-count">{schema.tables.length}</span>
                  </button>

                  {isExpanded ? (
                    <div className="table-list">
                      {schema.tables.map((table) => {
                        const isActive =
                          activeTab?.type === "table" &&
                          activeTab.schema === schema.schema &&
                          activeTab.table === table.name;

                        return (
                          <button
                            key={`${schema.schema}.${table.name}`}
                            className={isActive ? "tree-item table-item active" : "tree-item table-item"}
                            onClick={() => {
                              openTableInNewTab(schema.schema, table.name);
                            }}
                          >
                            <span className="tree-item-main">
                              <TableIcon size={14} weight="duotone" />
                              <span>{table.name}</span>
                            </span>
                            <span className="table-badge bg-kumo-tint text-kumo-strong">
                              {table.rowCount === null ? "-" : table.rowCount.toLocaleString()}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <Input
            label="Filter tables"
            value={tableFilter}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setTableFilter(value);
            }}
            placeholder="Search table name"
            className="table-filter-field"
          />
        </Surface>

        <Surface as="section" className="panel workspace-panel bg-kumo-elevated border-kumo-line">
          <div className="workspace-header">
            <Tabs
              variant="underline"
              tabs={viewerTabs.map((tab) => ({
                value: tab.id,
                label: (
                  <span className="tab-label">
                    {tab.type === "query" ? <TerminalWindow size={14} /> : <TableIcon size={14} />}
                    <span className="tab-title">{tab.title}</span>
                    <button
                      className="tab-close"
                      aria-label={`Close ${tab.title}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTab(tab.id);
                      }}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ),
              }))}
              value={activeTabId ?? undefined}
              onValueChange={(value) => setActiveTabId(value)}
              className="workspace-tabs"
            />
            <Button
              shape="square"
              variant="secondary"
              icon={Plus}
              aria-label="New query tab"
              className="no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
              onClick={createQueryTab}
            />
            <TabActions
              disabled={!activeTab}
              onRename={renameActiveTab}
              onDuplicate={duplicateActiveTab}
              onCloseOthers={closeOtherTabs}
              onCloseAll={closeAllTabs}
            />
          </div>

          {activeTab ? (
            <div className="workspace-content">
              {activeTab.type === "query" ? (
                <QueryEditor
                  query={activeTab.query}
                  isLoading={activeTab.isLoading}
                  lastRunMs={activeTab.lastRunMs}
                  lastRowCount={activeTab.lastRowCount}
                  autocompleteTokens={autocompleteTokens}
                  queryHistory={queryHistory}
                  onChangeQuery={(query) => {
                    updateTab(activeTab.id, (tab) => ({ ...tab, query }));
                  }}
                  onRun={() => {
                    void runActiveQuery();
                  }}
                />
              ) : null}

              <ResultTable
                activeTab={activeTab}
                onRetry={() => {
                  if (activeTab.type === "query") {
                    void runActiveQuery();
                  } else if (activeTab.schema && activeTab.table) {
                    void loadTablePreviewIntoTab(activeTab.id, activeTab.schema, activeTab.table);
                  }
                }}
                onCreateQueryTab={createQueryTab}
                onRefreshSchemas={refreshViewer}
                onSortColumn={(column) => {
                  void sortActiveTabByColumn(column);
                }}
                onCopyCell={(value, column) => {
                  void navigator.clipboard.writeText(value);
                  showToast(`Copied ${column}`);
                }}
              />
            </div>
          ) : (
            <div className="empty-state-panel bg-kumo-tint border-kumo-line">
              <p className="empty-state text-kumo-subtle">Open a table or create a query tab to begin.</p>
              <div className="empty-state-actions">
                <Button
                  variant="secondary"
                  className="no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
                  onClick={createQueryTab}
                >
                  Create Query Tab
                </Button>
                <Button
                  variant="secondary"
                  className="no-ring !border-kumo-line !ring-0 focus-visible:!ring-0 focus:!ring-0"
                  onClick={refreshViewer}
                >
                  Refresh Schemas
                </Button>
              </div>
            </div>
          )}
        </Surface>
      </section>
      <AppToast message={toastMessage} />
    </main>
  );
}

export default App;
