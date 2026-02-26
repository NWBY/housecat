import { KeyboardEvent, useMemo, useRef, useState } from "react";
import { Play } from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";

type QueryEditorProps = {
  query: string;
  isLoading: boolean;
  lastRunMs?: number;
  lastRowCount?: number;
  autocompleteTokens: string[];
  queryHistory: string[];
  onChangeQuery: (query: string) => void;
  onRun: () => void;
};

type QueryAutocomplete = {
  open: boolean;
  items: string[];
  selectedIndex: number;
  start: number;
  end: number;
};

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

export function QueryEditor({
  query,
  isLoading,
  lastRunMs,
  lastRowCount,
  autocompleteTokens,
  queryHistory,
  onChangeQuery,
  onRun,
}: QueryEditorProps) {
  const [autocomplete, setAutocomplete] = useState<QueryAutocomplete>({
    open: false,
    items: [],
    selectedIndex: 0,
    start: 0,
    end: 0,
  });
  const [autocompletePosition, setAutocompletePosition] = useState({ left: 12, top: 28 });
  const [editorLineCount, setEditorLineCount] = useState(1);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);

  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = useRef<HTMLPreElement | null>(null);

  const highlightedSql = useMemo(() => highlightSql(query), [query]);

  function closeAutocomplete() {
    setAutocomplete((prev) => ({ ...prev, open: false, items: [], selectedIndex: 0 }));
  }

  function updateEditorLineMetrics(textarea: HTMLTextAreaElement, cursor: number) {
    const lines = textarea.value.split("\n");
    const lineIndex = textarea.value.slice(0, cursor).split("\n").length - 1;
    setEditorLineCount(Math.max(1, lines.length));
    setCurrentLineIndex(Math.max(0, lineIndex));
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

  function refreshAutocomplete(cursor: number, force = false, textarea?: HTMLTextAreaElement | null) {
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
    const suffix = /[a-zA-Z0-9_)]$/.test(suggestion) ? " " : "";
    const nextQuery = query.slice(0, autocomplete.start) + suggestion + suffix + query.slice(autocomplete.end);
    onChangeQuery(nextQuery);
    closeAutocomplete();

    const nextCursor = autocomplete.start + suggestion.length + suffix.length;
    requestAnimationFrame(() => {
      editorRef.current?.focus();
      editorRef.current?.setSelectionRange(nextCursor, nextCursor);
      if (editorRef.current) {
        updateAutocompletePosition(editorRef.current, nextCursor);
        updateEditorLineMetrics(editorRef.current, nextCursor);
      }
    });
  }

  function onQueryEditorKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? query.length;
      refreshAutocomplete(cursor, true, event.currentTarget);
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

  return (
    <div className="query-editor-wrap">
      <div className="query-top-tools">
        <select
          className="query-history-select bg-kumo-control border-kumo-line text-kumo-default"
          value=""
          onChange={(event) => {
            const selected = event.currentTarget.value;
            if (!selected) {
              return;
            }

            onChangeQuery(selected);
            setEditorLineCount(Math.max(1, selected.split("\n").length));
            setCurrentLineIndex(0);
            event.currentTarget.value = "";
          }}
        >
          <option value="">Query History (global)</option>
          {queryHistory.map((entry, index) => (
            <option key={`history-${index}`} value={entry}>
              {entry.replace(/\s+/g, " ").slice(0, 96)}
            </option>
          ))}
        </select>
        {lastRunMs !== undefined ? (
          <span className="query-run-meta text-kumo-strong">
            {lastRunMs}ms · {lastRowCount ?? 0} rows
          </span>
        ) : null}
      </div>

      <div className="query-editor-shell bg-kumo-control border-kumo-line">
        <div className="current-line-highlight bg-kumo-tint" style={{ top: `${currentLineIndex * 21 + 10}px` }} />
        <pre className="query-line-numbers text-kumo-subtle" aria-hidden="true">
          {Array.from({ length: editorLineCount }, (_, index) => `${index + 1}`).join("\n")}
        </pre>
        <pre
          ref={highlightRef}
          className="query-highlight"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: `${highlightedSql}\n` }}
        />
        <textarea
          ref={editorRef}
          value={query}
          onChange={(event) => {
            const nextQuery = event.currentTarget.value;
            const cursor = event.currentTarget.selectionStart ?? nextQuery.length;
            onChangeQuery(nextQuery);
            refreshAutocomplete(cursor, false, event.currentTarget);
            updateEditorLineMetrics(event.currentTarget, cursor);
          }}
          onKeyDown={onQueryEditorKeyDown}
          onKeyUp={(event) => {
            const cursor = event.currentTarget.selectionStart ?? query.length;
            updateEditorLineMetrics(event.currentTarget, cursor);
          }}
          onClick={(event) => {
            const cursor = event.currentTarget.selectionStart ?? query.length;
            refreshAutocomplete(cursor, false, event.currentTarget);
            updateEditorLineMetrics(event.currentTarget, cursor);
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
                className={index === autocomplete.selectedIndex ? "autocomplete-item active" : "autocomplete-item"}
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
        loading={isLoading}
        onClick={onRun}
        className="no-ring !ring-0 focus-visible:!ring-0 focus:!ring-0"
      >
        Run Query
      </Button>
    </div>
  );
}
