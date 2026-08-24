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
        <strong id="replace-query-title">Заменить содержимое SQL-редактора?</strong>
        <p>В SQL-редакторе уже есть запрос. Заменить его выбранным {sourceLabel}?</p>
        <div>
          <button type="button" className="secondary" onClick={onCancel}>Отмена</button>
          <button type="button" onClick={onReplace}>Заменить</button>
        </div>
      </div>
    </div>
  );
}
