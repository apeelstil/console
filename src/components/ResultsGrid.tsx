import type { QueryCellValue, SelectQueryResult } from '../../shared/queryExecution';

interface ResultsGridProps {
  result: SelectQueryResult;
}

export function ResultsGrid({ result }: ResultsGridProps) {
  return (
    <div className="results-grid">
      {result.storageWarnings?.map((warning) => (
        <div className="storage-warning" role="alert" key={warning}>{warning} Результат SELECT остаётся корректным.</div>
      ))}
      <div className="results-summary">
        <span>Строк: {result.returnedRows}</span>
        <span>{result.durationMs} мс</span>
        {result.truncated && <strong>Показаны первые 1000 строк</strong>}
      </div>
      <div className="results-grid-scroll">
        <table>
          <thead>
            <tr>
              <th className="row-index">#</th>
              {result.columns.map((column, index) => (
                <th key={`${column.name}-${index}`} title={column.dataTypeId ? `OID типа PostgreSQL ${column.dataTypeId}` : undefined}>
                  <span>{column.name}</span>
                  {column.dataTypeId !== undefined && <small>{column.dataTypeId}</small>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td className="row-index">{rowIndex + 1}</td>
                {result.columns.map((column, columnIndex) => (
                  <ResultCell
                    key={`${column.name}-${columnIndex}`}
                    value={row[columnIndex] ?? null}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {result.rows.length === 0 && <div className="results-zero">Запрос не вернул строк.</div>}
      </div>
    </div>
  );
}

function ResultCell({ value }: { value: QueryCellValue }) {
  if (value === null) return <td className="null-value">NULL</td>;
  return <td title={String(value)}>{typeof value === 'boolean' ? String(value).toUpperCase() : String(value)}</td>;
}
