/** A thin bar for done out of total. */
import { cn } from '../cn';

export function Progress({ value, total, className }: { value: number; total: number; className?: string }) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className={cn('h-[5px] overflow-hidden rounded-full bg-active', className)} title={`${percent}%`}>
      <i className="block h-full rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </div>
  );
}

