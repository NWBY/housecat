export type SchemaTableItem = {
  name: string;
  rowCount: number | null;
};

export type SchemaTables = {
  schema: string;
  tables: SchemaTableItem[];
};

export type TablePreview = {
  columns: string[];
  rows: Record<string, unknown>[];
};

export type ViewerTabSort = {
  column: string;
  direction: "asc" | "desc";
};

export type ViewerTab = {
  id: string;
  type: "table" | "query";
  title: string;
  schema?: string;
  table?: string;
  query: string;
  preview: TablePreview;
  isLoading: boolean;
  error: string | null;
  lastRunMs?: number;
  lastRowCount?: number;
  sort?: ViewerTabSort;
};
