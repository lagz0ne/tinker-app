import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
/**
 * @param inputs - From view class values; why: merge only these styles.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
