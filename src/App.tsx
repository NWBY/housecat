import { FormEvent, KeyboardEvent, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CaretDown,
  CaretRight,
  Database,
  FloppyDisk,
  Plus,
  Play,
  Table as TableIcon,
  TerminalWindow,
  Trash,
  X,
} from "@phosphor-icons/react";
import { Button, Input, Surface, Switch, Table as KumoTable, Tabs } from "@cloudflare/kumo";
import "./App.css";

type ConnectionForm = {
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  secure: boolean;
};

type SchemaTables = {
  schema: string;
  tables: string[];
};

type TablePreview = {
  columns: string[];
  rows: Record<string, unknown>[];
};

type ViewerTab = {
  id: string;
  type: "table" | "query";
  title: string;
  schema?: string;
  table?: string;
  query: string;
  preview: TablePreview;
  isLoading: boolean;
  error: string | null;
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

type QueryAutocomplete = {
  open: boolean;
  items: string[];
  selectedIndex: number;
  start: number;
  end: number;
};

const SAVED_CONNECTIONS_KEY = "housecat.savedConnections";

const SQL_KEYWORDS = [
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
];

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightSql(query: string): string {
  const pattern = /(\/\*[\s\S]*?\*\/|--.*$|'(?:''|[^'])*'|\b\d+(?:\.\d+)?\b|\b(?:SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|JOIN|INNER\s+JOIN|LEFT\s+JOIN|RIGHT\s+JOIN|FULL\s+JOIN|ON|WITH|AS|UNION|ALL|DISTINCT|INSERT|INTO|VALUES|UPDATE|DELETE|CREATE|DROP|ALTER|FORMAT|JSON)\b)/gim;

  let result = "";
  let lastIndex = 0;

  for (const match of query.matchAll(pattern)) {
    const value = match[0] ?? "";
    const index = match.index ?? 0;

    result += escapeHtml(query.slice(lastIndex, index));

    if (value.startsWith("--") || value.startsWith("/*")) {
      result += `<span class="sql-token sql-comment">${escapeHtml(value)}</span>`;
    } else if (value.startsWith("'")) {
      result += `<span class="sql-token sql-string">${escapeHtml(value)}</span>`;
    } else if (/^\d/.test(value)) {
      result += `<span class="sql-token sql-number">${escapeHtml(value)}</span>`;
    } else {
      result += `<span class="sql-token sql-keyword">${escapeHtml(value)}</span>`;
    }

    lastIndex = index + value.length;
  }

  result += escapeHtml(query.slice(lastIndex));
  return result;
}

function getWordAtCursor(query: string, cursor: number): { start: number; end: number; word: string } {
  let start = cursor;
  let end = cursor;

  while (start > 0 && /[a-zA-Z0-9_.]/.test(query[start - 1])) {
    start -= 1;
  }

  while (end < query.length && /[a-zA-Z0-9_.]/.test(query[end])) {
    end += 1;
  }

  return {
    start,
    end,
    word: query.slice(start, end),
  };
}

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
        ? record.tables.filter((table): table is string => typeof table === "string")
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

function getFirstTable(schemas: SchemaTables[]): { schema: string; table: string } | null {
  for (const schema of schemas) {
    if (schema.tables.length > 0) {
      return { schema: schema.schema, table: schema.tables[0] };
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
  const [schemaTables, setSchemaTables] = useState<SchemaTables[]>([]);
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [tableFilter, setTableFilter] = useState("");
  const [viewerTabs, setViewerTabs] = useState<ViewerTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>(() =>
    typeof window === "undefined" ? [] : loadSavedConnections(),
  );
  const [connectionName, setConnectionName] = useState("");
  const [autocomplete, setAutocomplete] = useState<QueryAutocomplete>({
    open: false,
    items: [],
    selectedIndex: 0,
    start: 0,
    end: 0,
  });
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const [autocompletePosition, setAutocompletePosition] = useState({ left: 12, top: 28 });

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

  const filteredSchemas = useMemo(() => {
    const query = tableFilter.trim().toLowerCase();
    if (!query) {
      return schemaTables;
    }

    return schemaTables
      .map((schema) => ({
        schema: schema.schema,
        tables: schema.tables.filter((table) => table.toLowerCase().includes(query)),
      }))
      .filter((schema) => schema.tables.length > 0 || schema.schema.toLowerCase().includes(query));
  }, [schemaTables, tableFilter]);

  const autocompleteTokens = useMemo(() => {
    const tokenSet = new Set<string>(SQL_KEYWORDS);

    for (const schema of schemaTables) {
      tokenSet.add(schema.schema);
      tokenSet.add(`${schema.schema}.`);
      for (const table of schema.tables) {
        tokenSet.add(table);
        tokenSet.add(`${schema.schema}.${table}`);
      }
    }

    return Array.from(tokenSet);
  }, [schemaTables]);

  const highlightedSql = useMemo(() => {
    if (!activeTab || activeTab.type !== "query") {
      return "";
    }

    return highlightSql(activeTab.query);
  }, [activeTab]);

  function updateTab(tabId: string, updater: (tab: ViewerTab) => ViewerTab) {
    setViewerTabs((prev) => prev.map((tab) => (tab.id === tabId ? updater(tab) : tab)));
  }

  function createQueryTab() {
    const nextIndex = viewerTabs.filter((tab) => tab.type === "query").length + 1;
    const tabId = `query-${Date.now()}-${nextIndex}`;

    const tab: ViewerTab = {
      id: tabId,
      type: "query",
      title: `Query ${nextIndex}`,
      query: "SELECT * FROM system.tables LIMIT 50",
      preview: { columns: [], rows: [] },
      isLoading: false,
      error: null,
    };

    setViewerTabs((prev) => [...prev, tab]);
    setActiveTabId(tabId);
  }

  function closeTab(tabId: string) {
    closeAutocomplete();
    setViewerTabs((prev) => {
      const closingIndex = prev.findIndex((tab) => tab.id === tabId);
      if (closingIndex === -1) {
        return prev;
      }

      const next = prev.filter((tab) => tab.id !== tabId);

      setActiveTabId((currentActiveId) => {
        if (currentActiveId !== tabId) {
          return currentActiveId;
        }

        if (next.length === 0) {
          return null;
        }

        const fallbackIndex = closingIndex > 0 ? closingIndex - 1 : 0;
        return next[Math.min(fallbackIndex, next.length - 1)]?.id ?? null;
      });

      return next;
    });
  }

  function closeAutocomplete() {
    setAutocomplete((prev) => ({ ...prev, open: false, items: [], selectedIndex: 0 }));
  }

  function updateAutocompletePosition(textarea: HTMLTextAreaElement, cursor: number) {
    const text = textarea.value;
    const beforeCursor = text.slice(0, cursor);
    const lineStart = beforeCursor.lastIndexOf("\n") + 1;
    const lineText = beforeCursor.slice(lineStart);
    const lineNumber = beforeCursor.split("\n").length - 1;

    const computed = window.getComputedStyle(textarea);
    const fontSize = Number.parseFloat(computed.fontSize || "14") || 14;
    const lineHeight = Number.parseFloat(computed.lineHeight || "0") || fontSize * 1.5;
    const paddingLeft = Number.parseFloat(computed.paddingLeft || "0") || 0;
    const paddingTop = Number.parseFloat(computed.paddingTop || "0") || 0;

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    context.font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
    const textWidth = context.measureText(lineText).width;

    const left = paddingLeft + textWidth - textarea.scrollLeft;
    const top = paddingTop + lineNumber * lineHeight - textarea.scrollTop + lineHeight + 4;

    setAutocompletePosition({
      left: Math.max(8, Math.min(left, textarea.clientWidth - 40)),
      top: Math.max(8, Math.min(top, textarea.clientHeight - 12)),
    });
  }

  function refreshAutocomplete(
    query: string,
    cursor: number,
    force = false,
    textarea?: HTMLTextAreaElement | null,
  ) {
    if (textarea) {
      updateAutocompletePosition(textarea, cursor);
    }

    const { start, end, word } = getWordAtCursor(query, cursor);
    const normalized = word.toLowerCase();

    if (!force && normalized.length < 1) {
      closeAutocomplete();
      return;
    }

    const items = autocompleteTokens
      .filter((token) => {
        const lower = token.toLowerCase();
        if (!normalized) {
          return true;
        }
        return lower.startsWith(normalized) && lower !== normalized;
      })
      .slice(0, 8);

    if (items.length === 0) {
      closeAutocomplete();
      return;
    }

    setAutocomplete({
      open: true,
      items,
      selectedIndex: 0,
      start,
      end,
    });
  }

  function applyAutocompleteSuggestion(suggestion: string) {
    if (!activeTab || activeTab.type !== "query") {
      return;
    }

    const suffix = /[a-zA-Z0-9_)]$/.test(suggestion) ? " " : "";
    const nextQuery =
      activeTab.query.slice(0, autocomplete.start) +
      suggestion +
      suffix +
      activeTab.query.slice(autocomplete.end);

    updateTab(activeTab.id, (tab) => ({ ...tab, query: nextQuery }));
    closeAutocomplete();

    const nextCursor = autocomplete.start + suggestion.length + suffix.length;

    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(nextCursor, nextCursor);
      if (editorRef.current) {
        updateAutocompletePosition(editorRef.current, nextCursor);
      }
    });
  }

  function onQueryEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!activeTab || activeTab.type !== "query") {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? activeTab.query.length;
      refreshAutocomplete(activeTab.query, cursor, true, event.currentTarget);
      return;
    }

    if (!autocomplete.open) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAutocomplete((prev) => ({
        ...prev,
        selectedIndex: Math.min(prev.selectedIndex + 1, prev.items.length - 1),
      }));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setAutocomplete((prev) => ({
        ...prev,
        selectedIndex: Math.max(prev.selectedIndex - 1, 0),
      }));
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      const chosen = autocomplete.items[autocomplete.selectedIndex];
      if (chosen) {
        applyAutocompleteSuggestion(chosen);
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeAutocomplete();
    }
  }

  function syncQueryScroll() {
    if (!editorRef.current || !highlightRef.current) {
      return;
    }

    highlightRef.current.scrollTop = editorRef.current.scrollTop;
    highlightRef.current.scrollLeft = editorRef.current.scrollLeft;

    if (autocomplete.open) {
      const cursor = editorRef.current.selectionStart ?? 0;
      updateAutocompletePosition(editorRef.current, cursor);
    }
  }

  async function loadTablePreviewIntoTab(tabId: string, schema: string, table: string) {
    updateTab(tabId, (tab) => ({ ...tab, isLoading: true, error: null }));

    try {
      const result = await invoke<unknown>("fetch_table_preview", {
        input: {
          connection: getConnectionPayload(),
          schema,
          table,
          limit: 200,
        },
      });

      updateTab(tabId, (tab) => ({
        ...tab,
        preview: normalizeTablePreview(result),
        isLoading: false,
        error: null,
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
    const tabId = `table-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const tab: ViewerTab = {
      id: tabId,
      type: "table",
      title: `${schema}.${table}`,
      schema,
      table,
      query: "",
      preview: { columns: [], rows: [] },
      isLoading: true,
      error: null,
    };

    setViewerTabs((prev) => [...prev, tab]);
    setActiveTabId(tabId);
    void loadTablePreviewIntoTab(tabId, schema, table);
  }

  async function runActiveQuery() {
    if (!activeTab || activeTab.type !== "query") {
      return;
    }

    updateTab(activeTab.id, (tab) => ({ ...tab, isLoading: true, error: null }));

    try {
      const result = await invoke<unknown>("run_query", {
        input: {
          connection: getConnectionPayload(),
          query: activeTab.query,
          limit: 500,
        },
      });

      updateTab(activeTab.id, (tab) => ({
        ...tab,
        preview: normalizeTablePreview(result),
        isLoading: false,
        error: null,
      }));
    } catch (error) {
      updateTab(activeTab.id, (tab) => ({
        ...tab,
        isLoading: false,
        error: typeof error === "string" ? error : "Query failed.",
      }));
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
    setTableFilter("");
    closeAutocomplete();
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
                          activeTab.table === table;

                        return (
                          <button
                            key={`${schema.schema}.${table}`}
                            className={isActive ? "tree-item table-item active" : "tree-item table-item"}
                            onClick={() => {
                              openTableInNewTab(schema.schema, table);
                            }}
                          >
                            <span className="tree-item-main">
                              <TableIcon size={14} weight="duotone" />
                              <span>{table}</span>
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
              onValueChange={(value) => {
                setActiveTabId(value);
                closeAutocomplete();
              }}
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
          </div>

          {activeTab ? (
            <>
              {activeTab.type === "query" ? (
                <div className="query-editor-wrap">
                  <div className="query-editor-shell bg-kumo-control border-kumo-line">
                    <pre
                      ref={highlightRef}
                      className="query-highlight"
                      aria-hidden="true"
                      dangerouslySetInnerHTML={{ __html: `${highlightedSql}\n` }}
                    />
                    <textarea
                      ref={editorRef}
                      value={activeTab.query}
                      onChange={(event) => {
                        const query = event.currentTarget.value;
                        const cursor = event.currentTarget.selectionStart ?? query.length;
                        updateTab(activeTab.id, (tab) => ({ ...tab, query }));
                        refreshAutocomplete(query, cursor, false, event.currentTarget);
                      }}
                      onKeyDown={onQueryEditorKeyDown}
                      onClick={(event) => {
                        const cursor = event.currentTarget.selectionStart ?? activeTab.query.length;
                        refreshAutocomplete(activeTab.query, cursor, false, event.currentTarget);
                      }}
                      onScroll={syncQueryScroll}
                      wrap="off"
                      spellCheck={false}
                      aria-label="SQL query"
                      className="query-editor"
                    />
                    {autocomplete.open ? (
                      <div
                        className="query-autocomplete bg-kumo-elevated border-kumo-line"
                        style={{ left: `${autocompletePosition.left}px`, top: `${autocompletePosition.top}px` }}
                      >
                        {autocomplete.items.map((item, index) => (
                          <button
                            key={`${item}-${index}`}
                            className={
                              index === autocomplete.selectedIndex
                                ? "autocomplete-item active"
                                : "autocomplete-item"
                            }
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              applyAutocompleteSuggestion(item);
                            }}
                          >
                            {item}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <Button
                    variant="primary"
                    icon={Play}
                    loading={activeTab.isLoading}
                    onClick={() => {
                      void runActiveQuery();
                    }}
                    className="no-ring !ring-0 focus-visible:!ring-0 focus:!ring-0"
                  >
                    Run Query
                  </Button>
                </div>
              ) : null}

              {activeTab.error ? <p className="error-text text-kumo-danger">{activeTab.error}</p> : null}
              {activeTab.isLoading ? (
                <p className="empty-state text-kumo-subtle">Loading results...</p>
              ) : null}

              {!activeTab.isLoading && activeTab.preview.columns.length > 0 ? (
                <div className="table-wrap">
                  <KumoTable className="data-table" layout="auto">
                    <KumoTable.Header>
                      <KumoTable.Row>
                        {activeTab.preview.columns.map((column) => (
                          <KumoTable.Head key={column}>{column}</KumoTable.Head>
                        ))}
                      </KumoTable.Row>
                    </KumoTable.Header>
                    <KumoTable.Body>
                      {activeTab.preview.rows.map((row, index) => (
                        <KumoTable.Row key={`row-${index}`}>
                          {activeTab.preview.columns.map((column) => (
                            <KumoTable.Cell key={`${index}-${column}`}>
                              {formatCellValue(row[column])}
                            </KumoTable.Cell>
                          ))}
                        </KumoTable.Row>
                      ))}
                    </KumoTable.Body>
                  </KumoTable>
                </div>
              ) : null}

              {!activeTab.isLoading && activeTab.preview.columns.length === 0 && !activeTab.error ? (
                <p className="empty-state text-kumo-subtle">No rows to show for this tab.</p>
              ) : null}
            </>
          ) : (
            <p className="empty-state text-kumo-subtle">Open a table or create a query tab to begin.</p>
          )}
        </Surface>
      </section>
    </main>
  );
}

export default App;
