import type { AlertRuleRow } from "./alerts";
import type { AlertRuleInput } from "./validation";

export type AlertRuleDTO = Omit<AlertRuleRow, "levels" | "lastTriggeredAt"> & {
  levels: string[];
  lastTriggeredAt: string | null;
  createdAt: string;
};

export type AlertEventDTO = {
  id: string;
  ruleId: string;
  ruleName: string;
  message: string;
  count: number;
  success: boolean;
  error: string | null;
  test: boolean;
  createdAt: string;
};

export function toRuleDTO(r: AlertRuleRow & { createdAt: Date }): AlertRuleDTO {
  return {
    ...r,
    levels: r.levels.split(",").filter(Boolean),
    lastTriggeredAt: r.lastTriggeredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Map validated input to DB columns (levels are stored comma-separated). */
export function toRuleData<T extends Partial<AlertRuleInput>>(input: T) {
  const { levels, ...rest } = input;
  return { ...rest, ...(levels ? { levels: levels.join(",") } : {}) };
}
