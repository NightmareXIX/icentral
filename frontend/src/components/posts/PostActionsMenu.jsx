import { useEffect, useId, useMemo, useRef, useState } from 'react';

function stopEvent(event) {
  event.stopPropagation();
}

export default function PostActionsMenu({
  actions = [],
  buttonLabel = 'Post actions',
  menuLabel = 'Post actions',
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const rootRef = useRef(null);

  const visibleActions = useMemo(
    () => actions.filter((action) => action && action.hidden !== true),
    [actions],
  );

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }

    function handleKeyDown(event) {
      if (event.key !== 'Escape') return;
      setOpen(false);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (visibleActions.length === 0) return null;

  return (
    <div
      ref={rootRef}
      className={`post-actions-menu${open ? ' is-open' : ''}`}
      data-prevent-card-nav="true"
      onClick={stopEvent}
      onKeyDown={stopEvent}
    >
      <button
        type="button"
        className="post-actions-trigger"
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((prev) => !prev);
        }}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="4.5" cy="10" r="1.55" />
          <circle cx="10" cy="10" r="1.55" />
          <circle cx="15.5" cy="10" r="1.55" />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          className="post-actions-popover"
          role="menu"
          aria-label={menuLabel}
        >
          {visibleActions.map((action, index) => (
            <button
              key={action.key || action.label || index}
              type="button"
              role="menuitem"
              className={`post-actions-item${action.tone === 'danger' ? ' is-danger' : ''}`}
              disabled={action.disabled}
              onClick={async (event) => {
                event.stopPropagation();
                setOpen(false);
                await action.onSelect?.();
              }}
            >
              <span>{action.label}</span>
              {action.hint ? <small>{action.hint}</small> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
