import type { ViewerTab } from "../types/viewer";

export function createQueryTab(existingTabs: ViewerTab[]): ViewerTab {
  const nextIndex = existingTabs.filter((tab) => tab.type === "query").length + 1;

  return {
    id: `query-${Date.now()}-${nextIndex}`,
    type: "query",
    title: `Query ${nextIndex}`,
    query: "SELECT * FROM system.tables LIMIT 50",
    preview: { columns: [], rows: [] },
    isLoading: false,
    error: null,
  };
}

export function createTableTab(schema: string, table: string): ViewerTab {
  return {
    id: `table-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    type: "table",
    title: `${schema}.${table}`,
    schema,
    table,
    query: "",
    preview: { columns: [], rows: [] },
    isLoading: true,
    error: null,
  };
}

export function closeTabWithActive(
  tabs: ViewerTab[],
  activeTabId: string | null,
  tabId: string,
): { tabs: ViewerTab[]; activeTabId: string | null } {
  const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex === -1) {
    return { tabs, activeTabId };
  }

  const nextTabs = tabs.filter((tab) => tab.id !== tabId);
  if (activeTabId !== tabId) {
    return { tabs: nextTabs, activeTabId };
  }

  if (nextTabs.length === 0) {
    return { tabs: nextTabs, activeTabId: null };
  }

  const fallbackIndex = closingIndex > 0 ? closingIndex - 1 : 0;
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[Math.min(fallbackIndex, nextTabs.length - 1)]?.id ?? null,
  };
}

export function duplicateTab(tabs: ViewerTab[], activeTab: ViewerTab): { tabs: ViewerTab[]; activeTabId: string } {
  const copyId = `${activeTab.type}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const copy: ViewerTab = {
    ...activeTab,
    id: copyId,
    title: `${activeTab.title} (copy)`,
    isLoading: false,
    error: null,
  };

  return { tabs: [...tabs, copy], activeTabId: copyId };
}
