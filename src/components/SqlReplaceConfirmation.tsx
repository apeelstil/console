interface SqlReplaceConfirmationProps {
  sourceLabel: string;
  onCancel: () => void;
  onReplace: () => void;
}

export function SqlReplaceConfirmation({
  sourceLabel,
  onCancel,
  onReplace,
}: SqlReplaceConfirmationProps) {
  return (
    <div className="builder-confirmation-backdrop editor-replace-backdrop" role="presentation">
      <div className="builder-confirmation" role="dialog" aria-modal="true" aria-labelledby="replace-query-title">
        <strong id="replace-query-title">Replace SQL editor contents?</strong>
        <p>The SQL editor already contains a query. Replace it with the selected {sourceLabel}?</p>
        <div>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={onReplace}>Replace</button>
        </div>
      </div>
    </div>
  );
}
