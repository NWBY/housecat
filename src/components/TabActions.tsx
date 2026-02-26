import { Button } from "@cloudflare/kumo";

type TabActionsProps = {
  disabled: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
};

export function TabActions({
  disabled,
  onRename,
  onDuplicate,
  onCloseOthers,
  onCloseAll,
}: TabActionsProps) {
  return (
    <div className="tab-actions">
      <Button variant="secondary" disabled={disabled} onClick={onRename} className="no-ring tab-action-btn">
        Rename
      </Button>
      <Button
        variant="secondary"
        disabled={disabled}
        onClick={onDuplicate}
        className="no-ring tab-action-btn"
      >
        Duplicate
      </Button>
      <Button
        variant="secondary"
        disabled={disabled}
        onClick={onCloseOthers}
        className="no-ring tab-action-btn"
      >
        Close Others
      </Button>
      <Button variant="secondary" disabled={disabled} onClick={onCloseAll} className="no-ring tab-action-btn">
        Close All
      </Button>
    </div>
  );
}
