use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;
use std::time::Instant;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClickHouseConnectionInput {
    host: String,
    port: u16,
    username: String,
    password: String,
    database: Option<String>,
    secure: bool,
}

#[derive(Debug, Deserialize)]
struct ClickHouseTableRow {
    database: String,
    name: String,
    total_rows: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ClickHouseQueryResult {
    data: Vec<ClickHouseTableRow>,
}

#[derive(Debug, Deserialize)]
struct ClickHouseMetaColumn {
    name: String,
}

#[derive(Debug, Deserialize)]
struct ClickHousePreviewResult {
    meta: Vec<ClickHouseMetaColumn>,
    data: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TablePreviewInput {
    connection: ClickHouseConnectionInput,
    schema: String,
    table: String,
    limit: Option<u32>,
    sort_column: Option<String>,
    sort_direction: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryInput {
    connection: ClickHouseConnectionInput,
    query: String,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ClickHouseStatusRow {
    version: String,
    current_database: String,
}

#[derive(Debug, Deserialize)]
struct ClickHouseStatusResult {
    data: Vec<ClickHouseStatusRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaTables {
    schema: String,
    tables: Vec<SchemaTableEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaTableEntry {
    name: String,
    row_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TablePreview {
    columns: Vec<String>,
    rows: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    connected: bool,
    latency_ms: u128,
    version: String,
    current_database: String,
}

fn escape_identifier(identifier: &str) -> String {
    identifier.replace('`', "``")
}

async fn run_clickhouse_query(
    input: &ClickHouseConnectionInput,
    query: String,
) -> Result<reqwest::Response, String> {
    let host = input.host.trim();
    if host.is_empty() {
        return Err("Host is required".to_string());
    }

    if input.username.trim().is_empty() {
        return Err("Username is required".to_string());
    }

    let scheme = if input.secure { "https" } else { "http" };
    let endpoint = format!("{scheme}://{host}:{}/", input.port);

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| format!("Could not initialize ClickHouse client: {err}"))?;

    let response = client
        .post(endpoint)
        .basic_auth(input.username.trim(), Some(&input.password))
        .body(query)
        .send()
        .await
        .map_err(|err| format!("Could not connect to ClickHouse: {err}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read error body".to_string());

        return Err(format!("ClickHouse returned {status}: {body}"));
    }

    Ok(response)
}

#[tauri::command]
async fn fetch_schema_tables(
    input: ClickHouseConnectionInput,
) -> Result<Vec<SchemaTables>, String> {
    let query = match input.database.as_deref() {
        Some(database) if !database.trim().is_empty() => {
            let escaped_database = database.trim().replace('\'', "''");
            format!(
                "SELECT database, name, total_rows FROM system.tables WHERE database = '{escaped_database}' ORDER BY name FORMAT JSON"
            )
        }
        _ => "SELECT database, name, total_rows FROM system.tables WHERE database NOT IN ('INFORMATION_SCHEMA', 'information_schema', 'system') ORDER BY database, name FORMAT JSON".to_string(),
    };

    let response = run_clickhouse_query(&input, query).await?;

    let result: ClickHouseQueryResult = response
        .json()
        .await
        .map_err(|err| format!("Could not parse ClickHouse response: {err}"))?;

    let mut grouped: BTreeMap<String, Vec<SchemaTableEntry>> = BTreeMap::new();

    for row in result.data {
        grouped
            .entry(row.database)
            .or_default()
            .push(SchemaTableEntry {
                name: row.name,
                row_count: row.total_rows,
            });
    }

    let schemas = grouped
        .into_iter()
        .map(|(schema, tables)| SchemaTables { schema, tables })
        .collect();

    Ok(schemas)
}

#[tauri::command]
async fn fetch_table_preview(input: TablePreviewInput) -> Result<TablePreview, String> {
    let schema = input.schema.trim();
    if schema.is_empty() {
        return Err("Schema is required".to_string());
    }

    let table = input.table.trim();
    if table.is_empty() {
        return Err("Table is required".to_string());
    }

    let limit = input.limit.unwrap_or(200).clamp(1, 1000);
    let order_clause = match input.sort_column {
        Some(column) if !column.trim().is_empty() => {
            let direction = match input.sort_direction.as_deref() {
                Some("desc") | Some("DESC") => "DESC",
                _ => "ASC",
            };

            format!(
                " ORDER BY `{}` {}",
                escape_identifier(column.trim()),
                direction
            )
        }
        _ => String::new(),
    };

    let query = format!(
        "SELECT * FROM `{}`.`{}`{} LIMIT {} FORMAT JSON",
        escape_identifier(schema),
        escape_identifier(table),
        order_clause,
        limit
    );

    let response = run_clickhouse_query(&input.connection, query).await?;

    let preview_result: ClickHousePreviewResult = response
        .json()
        .await
        .map_err(|err| format!("Could not parse ClickHouse response: {err}"))?;

    let columns = preview_result
        .meta
        .into_iter()
        .map(|col| col.name)
        .collect();

    Ok(TablePreview {
        columns,
        rows: preview_result.data,
    })
}

#[tauri::command]
async fn run_query(input: QueryInput) -> Result<TablePreview, String> {
    let raw_query = input.query.trim().trim_end_matches(';').trim();
    if raw_query.is_empty() {
        return Err("Query is required".to_string());
    }

    let mut query = raw_query.to_string();
    let uppercase_query = query.to_uppercase();
    let limit = input.limit.unwrap_or(500).clamp(1, 10_000);

    if uppercase_query.starts_with("SELECT ") && !uppercase_query.contains(" LIMIT ") {
        query.push_str(&format!(" LIMIT {limit}"));
    }

    if !uppercase_query.contains("FORMAT ") {
        query.push_str(" FORMAT JSON");
    }

    let response = run_clickhouse_query(&input.connection, query).await?;

    let body = response
        .text()
        .await
        .map_err(|err| format!("Could not read ClickHouse response: {err}"))?;

    if let Ok(preview_result) = serde_json::from_str::<ClickHousePreviewResult>(&body) {
        let columns = preview_result
            .meta
            .into_iter()
            .map(|col| col.name)
            .collect();
        return Ok(TablePreview {
            columns,
            rows: preview_result.data,
        });
    }

    Ok(TablePreview {
        columns: vec!["result".to_string()],
        rows: vec![json!({
            "result": if body.trim().is_empty() {
                "Query executed successfully"
            } else {
                body.trim()
            }
        })],
    })
}

#[tauri::command]
async fn fetch_connection_status(
    input: ClickHouseConnectionInput,
) -> Result<ConnectionStatus, String> {
    let started = Instant::now();
    let response = run_clickhouse_query(
        &input,
        "SELECT version() AS version, currentDatabase() AS current_database FORMAT JSON"
            .to_string(),
    )
    .await?;

    let result: ClickHouseStatusResult = response
        .json()
        .await
        .map_err(|err| format!("Could not parse ClickHouse response: {err}"))?;

    let row = result
        .data
        .into_iter()
        .next()
        .ok_or_else(|| "Could not read ClickHouse status".to_string())?;

    Ok(ConnectionStatus {
        connected: true,
        latency_ms: started.elapsed().as_millis(),
        version: row.version,
        current_database: row.current_database,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fetch_schema_tables,
            fetch_table_preview,
            run_query,
            fetch_connection_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
