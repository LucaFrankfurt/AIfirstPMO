import type { ComponentProps, KeyboardEvent } from 'react';
import { cn } from '../cn';

/** A tablist with roving focus: the selected tab is the one Tab stop, arrows/Home/End move and select. */
export function TabList({ onKeyDown, ...props }: ComponentProps<'div'>) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const at = tabs.indexOf(event.target as HTMLElement);
    if (at < 0 || event.defaultPrevented) return;
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const step = event.key === 'ArrowRight' ? (rtl ? -1 : 1) : event.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0;
    const next = step ? at + step : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[(next + tabs.length) % tabs.length];
    tab.focus();
    tab.click();
  };
  return <div role="tablist" onKeyDown={move} {...props} />;
}

export function TabButton({ active, className, ...props }: ComponentProps<'button'> & { active: boolean }) {
  return (
    <button
      type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1}
      className={cn(active && 'active', className)}
      {...props}
    />
  );
}
