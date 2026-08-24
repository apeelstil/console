export type PasswordRevealAction =
  | { type: 'pointerdown' | 'pointerup' | 'pointerleave' | 'pointercancel' | 'blur' | 'click' }
  | { type: 'keydown' | 'keyup'; key: string };

export function getPasswordInputType(revealed: boolean): 'text' | 'password' {
  return revealed ? 'text' : 'password';
}

export function nextPasswordRevealState(
  current: boolean,
  action: PasswordRevealAction,
): boolean {
  if (action.type === 'pointerdown') return true;
  if (action.type === 'keydown') {
    return action.key === ' ' || action.key === 'Enter' ? true : current;
  }
  return false;
}
