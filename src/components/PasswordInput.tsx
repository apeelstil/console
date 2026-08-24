import { useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import {
  getPasswordInputType,
  nextPasswordRevealState,
  type PasswordRevealAction,
} from '../passwordReveal';

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

const REVEAL_LABEL = 'Показать пароль, пока кнопка удерживается';

export function PasswordInput(props: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);

  const apply = (action: PasswordRevealAction) => {
    setRevealed((current) => nextPasswordRevealState(current, action));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    apply({ type: 'keydown', key: event.key });
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    apply({ type: 'keyup', key: event.key });
  };

  return (
    <span className="password-input-wrap">
      <input {...props} type={getPasswordInputType(revealed)} />
      <button
        type="button"
        className="password-reveal-button"
        aria-label={REVEAL_LABEL}
        aria-pressed={revealed}
        onPointerDown={() => apply({ type: 'pointerdown' })}
        onPointerUp={() => apply({ type: 'pointerup' })}
        onPointerLeave={() => apply({ type: 'pointerleave' })}
        onPointerCancel={() => apply({ type: 'pointercancel' })}
        onBlur={() => apply({ type: 'blur' })}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onClick={(event) => { event.preventDefault(); apply({ type: 'click' }); }}
      >
        <span aria-hidden="true">◉</span>
      </button>
    </span>
  );
}
